import { toolRegistry } from '../core/tools.js';
import { mcpManager } from '../core/mcp.js';

toolRegistry.register({
  name: 'mcp_list_resources',
  description: 'List resources exposed by connected MCP servers.',
  category: 'mcp',
  parameters: [
    {
      name: 'server',
      type: 'string',
      description: 'Optional MCP server id to filter by.',
      required: false,
    },
  ],
  usageNotes: [
    'Use this when you need to discover MCP resources before reading one.',
    'Leave "server" empty to aggregate resources across all connected MCP servers.',
  ],
  keywords: ['mcp', 'resource', 'resources', 'server'],
  handler: async (args) => {
    const resources = await mcpManager.listResources(args.server);
    return {
      success: true,
      output: JSON.stringify(resources, null, 2),
    };
  },
});

toolRegistry.register({
  name: 'mcp_read_resource',
  description: 'Read a specific resource from a connected MCP server.',
  category: 'mcp',
  parameters: [
    {
      name: 'server',
      type: 'string',
      description: 'MCP server id.',
      required: true,
    },
    {
      name: 'uri',
      type: 'string',
      description: 'Resource URI to read.',
      required: true,
    },
  ],
  usageNotes: [
    'Call mcp_list_resources first if you do not know the exact URI.',
  ],
  keywords: ['mcp', 'resource', 'read', 'uri'],
  handler: async (args) => {
    const output = await mcpManager.readResource(String(args.server), String(args.uri));
    return { success: true, output };
  },
});

toolRegistry.register({
  name: 'mcp_list_prompts',
  description: 'List prompts exposed by connected MCP servers.',
  category: 'mcp',
  parameters: [
    {
      name: 'server',
      type: 'string',
      description: 'Optional MCP server id to filter by.',
      required: false,
    },
  ],
  usageNotes: [
    'Use this when an MCP server ships reusable prompts you want to inspect before retrieving one.',
  ],
  keywords: ['mcp', 'prompt', 'prompts', 'template'],
  handler: async (args) => {
    const prompts = await mcpManager.listPrompts(args.server);
    return {
      success: true,
      output: JSON.stringify(prompts, null, 2),
    };
  },
});

toolRegistry.register({
  name: 'mcp_get_prompt',
  description: 'Retrieve a prompt from a connected MCP server.',
  category: 'mcp',
  parameters: [
    {
      name: 'server',
      type: 'string',
      description: 'MCP server id.',
      required: true,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Prompt name.',
      required: true,
    },
    {
      name: 'arguments',
      type: 'object',
      description: 'Optional prompt arguments as a JSON object.',
      required: false,
      additionalProperties: true,
    },
  ],
  usageNotes: [
    'Call mcp_list_prompts first if you do not know the exact prompt name or argument shape.',
  ],
  keywords: ['mcp', 'prompt', 'get', 'template'],
  handler: async (args) => {
    const output = await mcpManager.getPrompt(
      String(args.server),
      String(args.name),
      args.arguments && typeof args.arguments === 'object' ? args.arguments : undefined,
    );
    return { success: true, output };
  },
});
