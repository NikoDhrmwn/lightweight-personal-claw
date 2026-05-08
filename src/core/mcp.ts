import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition, ToolResult } from './tools.js';
import { toolRegistry } from './tools.js';
import { getConfig, type LiteClawConfig, type MCPServerConfig } from '../config.js';
import { createLogger } from '../logger.js';

const VERSION = '0.8.3';
const log = createLogger('mcp');

interface MCPServerConnection {
  id: string;
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  instructions?: string;
  tools: Array<Record<string, any>>;
  resources: Array<Record<string, any>>;
  resourceTemplates: Array<Record<string, any>>;
  prompts: Array<Record<string, any>>;
  status: 'connected' | 'failed';
  error?: string;
}

interface MCPToolBinding {
  serverId: string;
  remoteName: string;
}

function sanitizeIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'mcp';
}

function tokenizeKeywords(...values: Array<string | undefined>): string[] {
  const keywords = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/g)) {
      if (token.length >= 3) keywords.add(token);
    }
  }
  return Array.from(keywords).slice(0, 16);
}

function formatContentBlock(block: any): string {
  if (!block || typeof block !== 'object') {
    return typeof block === 'string' ? block : JSON.stringify(block, null, 2);
  }
  if (block.type === 'text') return String(block.text ?? '');
  if (block.type === 'resource' && block.resource?.text) return String(block.resource.text);
  if (block.type === 'resource' && block.resource?.blob) {
    return `[resource blob ${block.resource.mimeType ?? 'application/octet-stream'} at ${block.resource.uri}]`;
  }
  if (block.type === 'resource_link') {
    return `[resource link] ${block.name ?? block.title ?? block.uri} (${block.uri})`;
  }
  if (block.type === 'image') {
    return `[image ${block.mimeType ?? 'application/octet-stream'} ${block.data ? `${String(block.data).length} bytes(base64)` : ''}]`;
  }
  if (block.type === 'audio') {
    return `[audio ${block.mimeType ?? 'application/octet-stream'} ${block.data ? `${String(block.data).length} bytes(base64)` : ''}]`;
  }
  return JSON.stringify(block, null, 2);
}

async function collectPaginated<T>(
  loader: (cursor?: string) => Promise<{ nextCursor?: string } & Record<string, any>>,
  key: string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await loader(cursor);
    const pageItems = Array.isArray((page as any)[key]) ? (page as any)[key] : [];
    items.push(...pageItems);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

class MCPManager {
  private servers = new Map<string, MCPServerConnection>();
  private toolBindings = new Map<string, MCPToolBinding>();
  private registeredToolNames = new Set<string>();

  async reloadFromConfig(config: LiteClawConfig = getConfig()): Promise<void> {
    await this.closeAll();
    this.unregisterDynamicTools();

    if (config.mcp?.enabled === false || config.tools?.mcp?.enabled === false) {
      log.info('MCP support disabled in config');
      return;
    }

    const servers = config.mcp?.servers ?? {};
    for (const [serverId, serverConfig] of Object.entries(servers)) {
      if (serverConfig?.enabled === false) continue;
      try {
        const connection = await this.connectServer(serverId, serverConfig);
        this.servers.set(serverId, connection);
      } catch (err: any) {
        const message = err?.message || 'Unknown MCP connection error';
        log.warn({ serverId, error: message }, 'Failed to connect MCP server');
        this.servers.set(serverId, {
          id: serverId,
          config: serverConfig,
          client: null as unknown as Client,
          transport: null as unknown as StdioClientTransport,
          tools: [],
          resources: [],
          resourceTemplates: [],
          prompts: [],
          status: 'failed',
          error: message,
        });
      }
    }

    this.registerDynamicTools();
  }

  private async connectServer(serverId: string, serverConfig: MCPServerConfig): Promise<MCPServerConnection> {
    const client = new Client(
      { name: 'liteclaw', version: VERSION },
      { capabilities: {} },
    );

    const transport = serverConfig.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(String(serverConfig.url)), {
          requestInit: {
            headers: serverConfig.headers ?? {},
          },
        })
      : new StdioClientTransport({
          command: String(serverConfig.command),
          args: serverConfig.args ?? [],
          cwd: serverConfig.cwd,
          env: serverConfig.env,
          stderr: 'pipe',
        });

    transport.onerror = (error) => {
      log.warn({ serverId, error: error.message }, 'MCP transport error');
    };
    transport.onclose = () => {
      log.info({ serverId }, 'MCP transport closed');
    };

    await client.connect(transport);

    const [tools, resources, resourceTemplates, prompts] = await Promise.all([
      collectPaginated<Record<string, any>>((cursor) => client.listTools(cursor ? { cursor } : undefined), 'tools'),
      collectPaginated<Record<string, any>>((cursor) => client.listResources(cursor ? { cursor } : undefined), 'resources'),
      collectPaginated<Record<string, any>>((cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined), 'resourceTemplates'),
      collectPaginated<Record<string, any>>((cursor) => client.listPrompts(cursor ? { cursor } : undefined), 'prompts'),
    ]);

    log.info({
      serverId,
      transport: serverConfig.transport ?? 'stdio',
      tools: tools.length,
      resources: resources.length,
      prompts: prompts.length,
    }, 'Connected MCP server');

    return {
      id: serverId,
      config: serverConfig,
      client,
      transport,
      instructions: client.getInstructions(),
      tools,
      resources,
      resourceTemplates,
      prompts,
      status: 'connected',
    };
  }

  private registerDynamicTools(): void {
    for (const connection of this.servers.values()) {
      if (connection.status !== 'connected') continue;

      const include = new Set((connection.config.includeTools ?? []).map(name => name.toLowerCase()));
      const exclude = new Set((connection.config.excludeTools ?? []).map(name => name.toLowerCase()));

      for (const tool of connection.tools) {
        const remoteName = String(tool.name ?? '').trim();
        if (!remoteName) continue;
        if (include.size > 0 && !include.has(remoteName.toLowerCase())) continue;
        if (exclude.has(remoteName.toLowerCase())) continue;

        const prefix = connection.config.prefixToolNames !== false;
        const localName = prefix
          ? `${sanitizeIdentifier(connection.id)}_${sanitizeIdentifier(remoteName)}`
          : sanitizeIdentifier(remoteName);

        this.toolBindings.set(localName, {
          serverId: connection.id,
          remoteName,
        });
        this.registeredToolNames.add(localName);

        const descriptionPrefix = `[MCP:${connection.id}]`;
        const usageNotes = [
          connection.instructions ? `Server instructions: ${connection.instructions.slice(0, 240)}` : undefined,
          tool.annotations?.readOnlyHint ? 'Read-only operation.' : undefined,
          tool.annotations?.destructiveHint ? 'Potentially destructive operation; review arguments carefully.' : undefined,
        ].filter(Boolean) as string[];

        const definition: ToolDefinition = {
          name: localName,
          description: `${descriptionPrefix} ${tool.description ?? remoteName}`.trim(),
          category: 'mcp',
          parameters: [],
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {}, additionalProperties: true },
          usageNotes,
          keywords: tokenizeKeywords(connection.id, remoteName, tool.description),
          requiresConfirmation: !!tool.annotations?.destructiveHint,
          handler: async (args) => this.callTool(localName, args),
        };

        toolRegistry.register(definition);
      }
    }
  }

  private unregisterDynamicTools(): void {
    for (const name of this.registeredToolNames) {
      toolRegistry.unregister(name);
    }
    this.registeredToolNames.clear();
    this.toolBindings.clear();
  }

  async closeAll(): Promise<void> {
    const toClose = Array.from(this.servers.values())
      .filter(server => server.status === 'connected');
    this.servers.clear();

    await Promise.allSettled(toClose.map(async (server) => {
      try {
        if (server.transport instanceof StreamableHTTPClientTransport) {
          await server.transport.terminateSession().catch(() => undefined);
        }
      } finally {
        await server.client.close().catch(() => undefined);
      }
    }));
  }

  getPromptAppendix(): string {
    const parts: string[] = [];
    for (const server of this.servers.values()) {
      if (server.status !== 'connected') continue;
      const lines = [
        `## MCP Server: ${server.id}`,
        server.instructions?.trim(),
        `Available MCP tools are exposed with the "${sanitizeIdentifier(server.id)}_" prefix unless configured otherwise.`,
      ].filter(Boolean);
      parts.push(lines.join('\n'));
    }
    return parts.join('\n\n');
  }

  getStatus(): Array<Record<string, any>> {
    return Array.from(this.servers.values()).map(server => ({
      id: server.id,
      enabled: server.config.enabled !== false,
      transport: server.config.transport ?? 'stdio',
      status: server.status,
      error: server.error,
      toolCount: server.tools.length,
      resourceCount: server.resources.length,
      resourceTemplateCount: server.resourceTemplates.length,
      promptCount: server.prompts.length,
      url: server.config.url,
      command: server.config.command,
    }));
  }

  async callTool(localName: string, args: Record<string, any>): Promise<ToolResult> {
    const binding = this.toolBindings.get(localName);
    if (!binding) {
      return { success: false, output: `Unknown MCP tool: ${localName}` };
    }

    const server = this.servers.get(binding.serverId);
    if (!server || server.status !== 'connected') {
      return { success: false, output: `MCP server "${binding.serverId}" is not connected.` };
    }

    const result = await server.client.callTool({
      name: binding.remoteName,
      arguments: args,
    });

    const blocks = Array.isArray((result as any).content) ? (result as any).content : [];
    const body = blocks.map(formatContentBlock).filter(Boolean).join('\n\n').trim();
    const structured = (result as any).structuredContent
      ? `\n\nStructured content:\n${JSON.stringify((result as any).structuredContent, null, 2)}`
      : '';

    return {
      success: !(result as any).isError,
      output: (body || `Tool "${binding.remoteName}" completed with no text output.`) + structured,
    };
  }

  async listResources(serverId?: string): Promise<Record<string, any>[]> {
    return this.withServers(serverId).flatMap(server =>
      server.resources.map(resource => ({ server: server.id, ...resource })),
    );
  }

  async listPrompts(serverId?: string): Promise<Record<string, any>[]> {
    return this.withServers(serverId).flatMap(server =>
      server.prompts.map(prompt => ({ server: server.id, ...prompt })),
    );
  }

  async readResource(serverId: string, uri: string): Promise<string> {
    const server = this.requireConnectedServer(serverId);
    const result = await server.client.readResource({ uri });
    return result.contents.map(formatContentBlock).join('\n\n').trim();
  }

  async getPrompt(serverId: string, name: string, args?: Record<string, any>): Promise<string> {
    const server = this.requireConnectedServer(serverId);
    const result = await server.client.getPrompt({
      name,
      arguments: args,
    });
    const header = result.description ? `${result.description}\n\n` : '';
    const messages = result.messages.map(message => {
      const content = formatContentBlock(message.content);
      return `[${message.role}] ${content}`;
    }).join('\n\n');
    return `${header}${messages}`.trim();
  }

  private withServers(serverId?: string): MCPServerConnection[] {
    if (serverId) return [this.requireConnectedServer(serverId)];
    return Array.from(this.servers.values()).filter(server => server.status === 'connected');
  }

  private requireConnectedServer(serverId: string): MCPServerConnection {
    const server = this.servers.get(serverId);
    if (!server || server.status !== 'connected') {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }
    return server;
  }
}

export const mcpManager = new MCPManager();
