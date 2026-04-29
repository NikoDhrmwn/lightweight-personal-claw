/**
 * LiteClaw — Express + WebSocket Gateway
 *
 * Serves the Web UI, handles WebSocket streaming,
 * and provides REST endpoints for channels and CLI.
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { existsSync, readdirSync, readFileSync, statSync, watchFile, unwatchFile } from 'fs';
import { join, dirname, relative, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { AgentEngine, AgentRequest, AgentStreamEvent } from '../core/engine.js';
import { ConfirmationManager, buildWebUIConfirmation } from '../core/confirmation.js';
import { MemoryStore } from '../core/memory.js';
import { getConfig, getConfigPath, getStateDir, loadConfig, reloadConfig, saveConfig, type LiteClawConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { processFile } from '../core/file_processor.js';

const log = createLogger('gateway');
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ───────────────────────────────────────────────────────────

interface WSAttachment {
  name: string;
  dataUrl: string;
}

interface WSMessage {
  type: 'message' | 'confirmation_response' | 'ping' | 'session_init';
  content?: string;
  attachments?: WSAttachment[];
  confirmationId?: string;
  confirmed?: boolean;
  sessionKey?: string;
  workingDir?: string;
}

// ─── Gateway Server ──────────────────────────────────────────────────

export class GatewayServer {
  private app: express.Application;
  private server: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private engine: AgentEngine;
  private confirmations: ConfirmationManager;
  private clients = new Set<WebSocket>();
  private watchedFiles = new Set<string>();

  constructor(engine: AgentEngine, confirmations: ConfirmationManager) {
    this.engine = engine;
    this.confirmations = confirmations;

    this.app = express();
    this.app.use(express.json({ limit: '50mb' }));

    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.setupRoutes();
    this.setupWebSocket();
    this.setupConfirmationHandler();
    this.setupConfigWatcher();
  }

  private setupRoutes(): void {
    // Auth middleware — only protect external API endpoints, not session endpoints
    // used by the built-in WebUI client
    this.app.use('/api', (req, res, next) => {
      const config = getConfig();
      const authToken = config.gateway?.auth?.token ?? process.env.GATEWAY_TOKEN;
      if (!authToken) return next();
      // Skip auth for session/config endpoints and health used by WebUI
      if (
        req.path.startsWith('/sessions') ||
        req.path === '/status' ||
        req.path === '/config' ||
        req.path === '/workspace'
      ) {
        return next();
      }
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (token !== authToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });

    // Serve static WebUI
    // Handle both 'src/' (dev) and 'dist/' (prod) path resolution
    let webuiDir = join(__dirname, '..', 'channels', 'webui');
    if (!existsSync(join(webuiDir, 'index.html'))) {
      // Fallback to project source root (useful when running from dist)
      // __dirname is dist/gateway, so we go up 2 levels pointing to project root
      webuiDir = join(__dirname, '..', '..', 'src', 'channels', 'webui');
    }
    this.app.use(express.static(webuiDir));

    // Health endpoint
    this.app.get('/health', (_req, res) => {
      res.json(this.getWebUIState());
    });

    // ─── Session Management REST API ────────────────────────────────

    // List all sessions
    this.app.get('/api/sessions', (_req, res) => {
      try {
        const memory = new MemoryStore();
        const sessions = memory.listSessions();
        memory.close();
        res.json({ sessions });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Get session history
    this.app.get('/api/sessions/:sessionKey/history', (req, res) => {
      try {
        const memory = new MemoryStore();
        const messages = memory.getHistory(req.params.sessionKey, 50);
        memory.close();
        res.json({ messages });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/sessions/:sessionKey/metrics', (req, res) => {
      try {
        const memory = new MemoryStore();
        const metrics = memory.getSessionMetrics(req.params.sessionKey);
        memory.close();
        res.json(metrics);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/sessions/:sessionKey/task-plan', (req, res) => {
      try {
        const memory = new MemoryStore();
        const taskPlan = memory.getLatestTaskPlan(req.params.sessionKey);
        memory.close();
        res.json({ taskPlan });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Delete session (clear history)
    this.app.delete('/api/sessions/:sessionKey', (req, res) => {
      try {
        const memory = new MemoryStore();
        memory.clearSession(req.params.sessionKey);
        memory.close();
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Rollback session (delete last N messages)
    this.app.post('/api/sessions/:sessionKey/rollback', (req, res) => {
      try {
        const count = Number(req.query.count || 1);
        const memory = new MemoryStore();
        const changes = memory.deleteLastMessages(req.params.sessionKey, count);
        memory.close();
        res.json({ success: true, changes });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // REST API: send message (for CLI usage)
    this.app.post('/api/message', async (req, res) => {
      const { message, sessionKey, images, workingDir } = req.body;
      if (!message) {
        res.status(400).json({ error: 'Message required' });
        return;
      }

      const request: AgentRequest = {
        message,
        images,
        sessionKey: sessionKey ?? `cli:${Date.now()}`,
        channelType: 'cli',
        workingDir: this.resolveWorkspace(workingDir),
      };

      try {
        let fullResponse = '';
        for await (const event of this.engine.processRequest(request)) {
          if (event.type === 'content') {
            fullResponse += event.content ?? '';
          }
        }
        res.json({ response: fullResponse });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // REST API: status
    this.app.get('/api/status', (_req, res) => {
      const state = this.getWebUIState();
      res.json({
        status: state.status,
        webClients: this.clients.size,
        pendingConfirmations: this.confirmations.getPending().length,
        workspace: state.workspace,
        config: state.config,
      });
    });

    this.app.get('/api/config', (_req, res) => {
      res.json(this.getEditableConfig());
    });

    this.app.patch('/api/config', async (req, res) => {
      try {
        const current = getConfig();
        const next = applyConfigPatch(current, req.body ?? {});
        saveConfig(next);
        reloadConfig();
        await this.engine.getLLMClient().refreshProvidersAsync();
        const payload = this.getEditableConfig();
        this.broadcast({ type: 'config_reloaded', config: payload, health: this.getWebUIState() });
        res.json({ success: true, config: payload });
      } catch (err: any) {
        log.error({ error: err.message }, 'Failed to update config');
        res.status(400).json({ error: err.message });
      }
    });

    this.app.get('/api/workspace', (_req, res) => {
      res.json({ workspace: this.resolveWorkspace() });
    });

    this.app.get('/api/workspace/tree', (req, res) => {
      try {
        const requestedPath = typeof req.query.path === 'string' ? req.query.path : '.';
        const absolutePath = this.resolveWorkspacePath(requestedPath);
        const entries = readdirSync(absolutePath, { withFileTypes: true })
          .map((entry) => {
            const fullPath = join(absolutePath, entry.name);
            const stats = statSync(fullPath);
            return {
              name: entry.name,
              path: this.toWorkspaceRelative(fullPath),
              kind: entry.isDirectory() ? 'directory' : 'file',
              size: stats.size,
              modifiedAt: stats.mtimeMs,
            };
          })
          .sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 250);

        res.json({
          workspace: this.resolveWorkspace(),
          currentPath: this.toWorkspaceRelative(absolutePath),
          entries,
        });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    this.app.get('/api/workspace/file', (req, res) => {
      try {
        const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
        if (!requestedPath) {
          throw new Error('path query is required');
        }

        const absolutePath = this.resolveWorkspacePath(requestedPath);
        const stats = statSync(absolutePath);
        if (!stats.isFile()) {
          throw new Error('Requested path is not a file');
        }

        const raw = readFileSync(absolutePath);
        const isBinary = raw.includes(0);
        const text = isBinary ? null : raw.toString('utf-8').slice(0, 32_000);

        res.json({
          path: this.toWorkspaceRelative(absolutePath),
          size: stats.size,
          modifiedAt: stats.mtimeMs,
          isBinary,
          truncated: !isBinary && raw.length > 32_000,
          content: text,
        });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    });

    // Fallback: serve index.html for SPA
    this.app.use((_req, res) => {
      res.sendFile(join(webuiDir, 'index.html'));
    });
  }

  private getWebUIState(): Record<string, any> {
    const config = getConfig();
    const primary = config.llm?.defaults?.primary ?? 'unknown';
    const stateDir = getStateDir();
    const hasDiscordToken = !!(config.channels?.discord?.token ?? process.env.DISCORD_TOKEN);
    const hasWhatsAppCreds = existsSync(join(stateDir, 'whatsapp-session', 'creds.json'));
    const memory = new MemoryStore();
    const sessionCount = memory.listSessions().length;
    memory.close();

    return {
      status: 'ok',
      version: '0.7.0',
      model: primary.split('/').pop() ?? primary,
      primaryModel: primary,
      uptime: process.uptime(),
      stateDir,
      configPath: getConfigPath(),
      workspace: this.resolveWorkspace(),
      sessionCount,
      pendingConfirmations: this.confirmations.getPending().length,
      channels: {
        webui: {
          connected: this.clients.size,
          enabled: true,
          status: 'online',
        },
        discord: {
          enabled: !!config.channels?.discord?.enabled,
          configured: hasDiscordToken,
          status: !config.channels?.discord?.enabled
            ? 'disabled'
            : hasDiscordToken
              ? 'configured'
              : 'missing_credentials',
        },
        whatsapp: {
          enabled: !!config.channels?.whatsapp?.enabled,
          configured: hasWhatsAppCreds,
          status: !config.channels?.whatsapp?.enabled
            ? 'disabled'
            : hasWhatsAppCreds
              ? 'configured'
              : 'awaiting_login',
        },
      },
      config: this.getEditableConfig(),
    };
  }

  private getEditableConfig(): Record<string, any> {
    const config = getConfig();
    const llmClient = this.engine.getLLMClient();
    const allProviders = llmClient.getAllProviders();

    let availableModels: any[] = [];
    if (allProviders.length > 0) {
      availableModels = allProviders.map(p => ({
        id: p.id,
        provider: p.id.split('/')[0],
        label: p.id,
        contextWindow: p.contextWindow,
        maxTokens: p.maxTokens,
        vision: p.supportsVision,
        reasoning: p.supportsReasoning,
      }));
    } else {
      // Fallback to static config if no providers detected yet
      const providers = config.llm?.providers ?? {};
      availableModels = Object.entries(providers).flatMap(([providerId, provider]: [string, any]) =>
        (provider.models ?? []).map((model: any) => ({
          id: `${providerId}/${model.id}`,
          provider: providerId,
          label: `${providerId}/${model.id}`,
          contextWindow: model.contextWindow ?? null,
          maxTokens: model.maxTokens ?? null,
          vision: !!model.vision,
          reasoning: !!model.reasoning,
        }))
      );
    }

    return {
      meta: {
        version: config.meta?.version ?? '0.7.0',
      },
      paths: {
        stateDir: getStateDir(),
        configPath: getConfigPath(),
        workspace: this.resolveWorkspace(),
      },
      llm: {
        primary: config.llm?.defaults?.primary ?? '',
        temperature: config.llm?.defaults?.temperature ?? 1.0,
        topP: config.llm?.defaults?.topP ?? 1.0,
        topK: config.llm?.defaults?.topK ?? 45,
        maxOutputTokens: config.llm?.defaults?.maxOutputTokens ?? 8192,
        defaults: {
          temperature: config.llm?.defaults?.temperature ?? 1.0,
          topP: config.llm?.defaults?.topP ?? 1.0,
          topK: config.llm?.defaults?.topK ?? 45,
          maxOutputTokens: config.llm?.defaults?.maxOutputTokens ?? 8192,
        },
        availableModels,
      },
      agent: {
        workspace: this.resolveWorkspace(),
        maxTurns: config.agent?.maxTurns ?? 20,
        toolLoading: config.agent?.toolLoading ?? 'lazy',
        thinkingDefault: config.agent?.thinkingDefault ?? 'medium',
        contextTokens: config.agent?.contextTokens ?? 64000,
        contextBudgetPct: config.agent?.contextBudgetPct ?? 80,
        planner: {
          enabled: config.agent?.planner?.enabled ?? true,
          mode: config.agent?.planner?.mode ?? 'auto',
          maxReplans: config.agent?.planner?.maxReplans ?? 2,
        },
        skills: {
          enabled: config.agent?.skills?.enabled ?? true,
          maxInjected: config.agent?.skills?.maxInjected ?? 2,
        },
      },
      channels: {
        discord: {
          enabled: !!config.channels?.discord?.enabled,
          replyStyle: config.channels?.discord?.replyStyle ?? 'single',
          showToolProgress: config.channels?.discord?.showToolProgress ?? false,
        },
        whatsapp: {
          enabled: !!config.channels?.whatsapp?.enabled,
          replyStyle: config.channels?.whatsapp?.replyStyle ?? 'single',
          showToolProgress: config.channels?.whatsapp?.showToolProgress ?? false,
        },
      },
      tools: {
        exec: {
          enabled: config.tools?.exec?.enabled ?? true,
          confirmDestructive: config.tools?.exec?.confirmDestructive ?? true,
        },
        web: {
          fetchEnabled: config.tools?.web?.fetch?.enabled ?? true,
          browserFallback: config.tools?.web?.search?.browserFallback ?? true,
          provider: config.tools?.web?.search?.provider ?? 'google-grounding',
        },
        filesystem: {
          enabled: config.tools?.filesystem?.enabled ?? true,
          confirmDelete: config.tools?.filesystem?.confirmDelete ?? true,
        },
        vision: {
          enabled: config.tools?.vision?.enabled ?? true,
          maxDimensionPx: config.tools?.vision?.maxDimensionPx ?? 1024,
        },
      },
      gateway: {
        port: config.gateway?.port ?? 7860,
        bind: config.gateway?.bind ?? 'loopback',
        authEnabled: !!(config.gateway?.auth?.token ?? process.env.GATEWAY_TOKEN),
      },
    };
  }

  private resolveWorkspace(candidate?: string): string {
    const config = getConfig();
    return candidate || config.agent?.workspace || process.cwd();
  }

  private resolveWorkspacePath(candidate: string): string {
    const workspace = resolve(this.resolveWorkspace());
    const target = candidate && candidate !== '.'
      ? resolve(workspace, candidate)
      : workspace;
    const workspacePrefix = workspace.endsWith(sep) ? workspace : `${workspace}${sep}`;
    if (target !== workspace && !target.startsWith(workspacePrefix)) {
      throw new Error('Path escapes the configured workspace');
    }
    if (!existsSync(target)) {
      throw new Error('Path does not exist');
    }
    return target;
  }

  private toWorkspaceRelative(target: string): string {
    const workspace = resolve(this.resolveWorkspace());
    const rel = relative(workspace, target);
    return rel ? rel.split('\\').join('/') : '.';
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      log.info({ clients: this.clients.size }, 'WebUI client connected');

      ws.on('message', async (raw) => {
        try {
          const msg: WSMessage = JSON.parse(raw.toString());

          switch (msg.type) {
            case 'message':
              await this.handleWebUIMessage(ws, msg);
              break;

            case 'session_init':
              // Client telling us which session they're viewing — acknowledge
              log.debug({ sessionKey: msg.sessionKey }, 'WebUI session init');
              if (msg.sessionKey && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(this.buildSessionMetricsPayload(msg.sessionKey)));
              }
              break;

            case 'confirmation_response':
              if (msg.confirmationId) {
                this.confirmations.resolveConfirmation(
                  msg.confirmationId,
                  msg.confirmed ?? false
                );
              }
              break;

            case 'ping':
              ws.send(JSON.stringify({ type: 'pong' }));
              break;
          }
        } catch (err: any) {
          log.error({ error: err.message }, 'WebSocket message error');
          ws.send(JSON.stringify({ type: 'error', content: err.message }));
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        log.info({ clients: this.clients.size }, 'WebUI client disconnected');
      });

      // Send welcome
      ws.send(JSON.stringify({
        type: 'system',
        content: 'Connected to LiteClaw gateway',
        health: this.getWebUIState(),
      }));
    });
  }

  private async handleWebUIMessage(ws: WebSocket, msg: WSMessage): Promise<void> {
    const sessionKey = msg.sessionKey ?? 'webui:default';
    const content = msg.content?.trim() ?? '';

    if (!content && (!msg.attachments || msg.attachments.length === 0)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', content: 'Message cannot be empty.' }));
        ws.send(JSON.stringify({ type: 'done' }));
      }
      return;
    }

    const images: string[] = [];
    const fileContents: string[] = [];

    log.info({
      hasContent: !!msg.content,
      attachmentsCount: msg.attachments?.length || 0
    }, 'Processing WebUI message');

    if (msg.attachments) {
      for (const attachment of msg.attachments) {
        try {
          const processed = await processFile(attachment.name, attachment.dataUrl);
          log.info({ name: attachment.name, type: processed.type }, 'Processed attachment');
          if (processed.type.startsWith('image/')) {
            images.push(attachment.dataUrl);
          } else {
            fileContents.push(`--- FILE: ${processed.name} ---\n${processed.content}\n--- END FILE ---`);
          }
        } catch (err: any) {
          log.error({ name: attachment.name, error: err.message }, 'Failed to process attachment');
          fileContents.push(`--- FILE ERROR: ${attachment.name} ---\n${err.message}\n--- END FILE ---`);
        }
      }
    }

    let finalMessage = content;
    if (fileContents.length > 0) {
      finalMessage += '\n\nAttached files content:\n' + fileContents.join('\n\n');
    }

    const request: AgentRequest = {
      message: finalMessage || '(attachments)',
      images: images.length > 0 ? images : undefined,
      attachments: msg.attachments,
      sessionKey,
      channelType: 'webui',
      workingDir: this.resolveWorkspace(msg.workingDir),
    };

    log.info({ sessionKey, messageLength: request.message.length, imageCount: images.length }, 'WebUI message received');

    try {
      for await (const event of this.engine.processRequest(request)) {
        const payload: any = { type: event.type };

        switch (event.type) {
          case 'thinking':
            payload.content = event.content;
            break;
          case 'content':
            payload.content = event.content;
            break;
          case 'plan':
            payload.plan = event.plan;
            break;
          case 'task_update':
            payload.plan = event.plan;
            payload.taskId = event.taskId;
            payload.taskTitle = event.taskTitle;
            payload.taskStatus = event.taskStatus;
            payload.taskIndex = event.taskIndex;
            payload.taskTotal = event.taskTotal;
            payload.taskSummary = event.taskSummary;
            break;
          case 'tool_start':
            payload.tool = event.toolName;
            payload.args = event.toolArgs;
            break;
          case 'tool_result':
            payload.tool = event.toolName;
            payload.result = event.toolResult;
            break;
          case 'error':
            payload.content = event.error;
            break;
          case 'done':
            payload.metrics = event.metrics;
            break;
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      }

      this.broadcast(this.buildSessionMetricsPayload(sessionKey));
    } catch (err: any) {
      log.error({ error: err.message }, 'Agent process failed');
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', content: `Agent error: ${err.message}` }));
        ws.send(JSON.stringify({ type: 'done' }));
      }
    }
  }

  private setupConfirmationHandler(): void {
    this.confirmations.on('confirmation_request', (conf) => {
      if (conf.channelType === 'webui') {
        const payload = buildWebUIConfirmation(conf);
        // Broadcast to all WebUI clients
        for (const ws of this.clients) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
          }
        }
      }
    });
  }

  private setupConfigWatcher(): void {
    const stateDir = getStateDir();
    const files = [
      getConfigPath(),
      join(stateDir, '.env'),
      join(stateDir, 'system_prompt.md'),
      join(stateDir, 'personality', 'SOUL.md'),
      join(stateDir, 'personality', 'IDENTITY.md'),
      join(stateDir, 'personality', 'USER.md'),
      join(stateDir, 'personality', 'AGENTS.md'),
      join(stateDir, 'personality', 'TOOLS.md'),
      join(stateDir, 'personality', 'GIFS.md'),
    ].filter(path => existsSync(path));

    for (const path of files) {
      if (this.watchedFiles.has(path)) continue;
      this.watchedFiles.add(path);
      watchFile(path, { interval: 1000 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs) return;
        try {
          reloadConfig();
          this.engine.getLLMClient().refreshProvidersAsync().catch(err => {
            log.error({ error: err.message }, 'Failed to refresh LLM providers after file change');
          });
          const payload = this.getEditableConfig();
          log.info({ path }, 'Reloaded config after file change');
          this.broadcast({
            type: 'config_reloaded',
            path,
            config: payload,
            health: this.getWebUIState(),
          });
        } catch (err: any) {
          log.error({ path, error: err.message }, 'Failed to reload config after file change');
          this.broadcast({
            type: 'error',
            content: `Config reload failed for ${path}: ${err.message}`,
          });
        }
      });
    }
  }

  async start(): Promise<void> {
    const config = getConfig();
    const port = config.gateway?.port ?? config.channels?.web?.port ?? 7860;
    const bind = config.gateway?.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';

    return new Promise((resolve) => {
      this.server.listen(port, bind, () => {
        log.info({ port, bind }, 'Gateway server listening');
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
    this.wss.close();
    for (const path of this.watchedFiles) {
      unwatchFile(path);
    }
    this.watchedFiles.clear();
    for (const ws of this.clients) {
      ws.close();
    }
  }

  /** Expose for channel integrations to broadcast events */
  broadcast(payload: any): void {
    const msg = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }

  private buildSessionMetricsPayload(sessionKey: string): Record<string, any> {
    const memory = new MemoryStore();
    const metrics = memory.getSessionMetrics(sessionKey);
    memory.close();
    return {
      type: 'session_metrics',
      sessionKey,
      metrics,
    };
  }
}

function applyConfigPatch(config: LiteClawConfig, patch: Record<string, any>): LiteClawConfig {
  const next: LiteClawConfig = structuredClone(config);

  if (patch.llm) {
    next.llm ??= {};
    next.llm.defaults ??= {};
    if (patch.llm.primary !== undefined) next.llm.defaults.primary = String(patch.llm.primary);
    if (patch.llm.temperature !== undefined) next.llm.defaults.temperature = Number(patch.llm.temperature);
    if (patch.llm.topP !== undefined) next.llm.defaults.topP = Number(patch.llm.topP);
    if (patch.llm.topK !== undefined) next.llm.defaults.topK = Number(patch.llm.topK);
    if (patch.llm.maxOutputTokens !== undefined) next.llm.defaults.maxOutputTokens = Number(patch.llm.maxOutputTokens);
  }

  if (patch.agent) {
    next.agent ??= {};
    if (patch.agent.workspace !== undefined) next.agent.workspace = String(patch.agent.workspace || '').trim();
    if (patch.agent.maxTurns !== undefined) next.agent.maxTurns = Number(patch.agent.maxTurns);
    if (patch.agent.toolLoading !== undefined) next.agent.toolLoading = patch.agent.toolLoading === 'all' ? 'all' : 'lazy';
    if (patch.agent.thinkingDefault !== undefined) next.agent.thinkingDefault = String(patch.agent.thinkingDefault);
    if (patch.agent.contextTokens !== undefined) next.agent.contextTokens = Number(patch.agent.contextTokens);
    if (patch.agent.contextBudgetPct !== undefined) next.agent.contextBudgetPct = Number(patch.agent.contextBudgetPct);
    if (patch.agent.planner) {
      next.agent.planner ??= {};
      if (patch.agent.planner.enabled !== undefined) next.agent.planner.enabled = !!patch.agent.planner.enabled;
      if (patch.agent.planner.mode !== undefined) {
        next.agent.planner.mode = patch.agent.planner.mode === 'always'
          ? 'always'
          : patch.agent.planner.mode === 'off'
            ? 'off'
            : 'auto';
      }
      if (patch.agent.planner.maxReplans !== undefined) next.agent.planner.maxReplans = Number(patch.agent.planner.maxReplans);
    }
    if (patch.agent.skills) {
      next.agent.skills ??= {};
      if (patch.agent.skills.enabled !== undefined) next.agent.skills.enabled = !!patch.agent.skills.enabled;
      if (patch.agent.skills.maxInjected !== undefined) next.agent.skills.maxInjected = Number(patch.agent.skills.maxInjected);
    }
  }

  if (patch.channels?.discord) {
    next.channels ??= {};
    next.channels.discord ??= {};
    next.channels.discord.enabled = !!patch.channels.discord.enabled;
    next.channels.discord.replyStyle = patch.channels.discord.replyStyle === 'rapid' ? 'rapid' : 'single';
    next.channels.discord.showToolProgress = !!patch.channels.discord.showToolProgress;
  }

  if (patch.channels?.whatsapp) {
    next.channels ??= {};
    next.channels.whatsapp ??= {};
    next.channels.whatsapp.enabled = !!patch.channels.whatsapp.enabled;
    next.channels.whatsapp.replyStyle = patch.channels.whatsapp.replyStyle === 'rapid' ? 'rapid' : 'single';
    next.channels.whatsapp.showToolProgress = !!patch.channels.whatsapp.showToolProgress;
  }

  if (patch.tools) {
    next.tools ??= {};
    if (patch.tools.exec) {
      next.tools.exec ??= {};
      if (patch.tools.exec.enabled !== undefined) next.tools.exec.enabled = !!patch.tools.exec.enabled;
      if (patch.tools.exec.confirmDestructive !== undefined) next.tools.exec.confirmDestructive = !!patch.tools.exec.confirmDestructive;
    }
    if (patch.tools.web) {
      next.tools.web ??= {};
      (next.tools.web as any).search ??= {};
      (next.tools.web as any).fetch ??= {};
      if (patch.tools.web.fetchEnabled !== undefined) (next.tools.web as any).fetch.enabled = !!patch.tools.web.fetchEnabled;
      if (patch.tools.web.browserFallback !== undefined) (next.tools.web as any).search.browserFallback = !!patch.tools.web.browserFallback;
    }
    if (patch.tools.filesystem) {
      next.tools.filesystem ??= {};
      if (patch.tools.filesystem.enabled !== undefined) next.tools.filesystem.enabled = !!patch.tools.filesystem.enabled;
      if (patch.tools.filesystem.confirmDelete !== undefined) next.tools.filesystem.confirmDelete = !!patch.tools.filesystem.confirmDelete;
    }
    if (patch.tools.vision) {
      next.tools.vision ??= {};
      if (patch.tools.vision.enabled !== undefined) next.tools.vision.enabled = !!patch.tools.vision.enabled;
      if (patch.tools.vision.maxDimensionPx !== undefined) next.tools.vision.maxDimensionPx = Number(patch.tools.vision.maxDimensionPx);
    }
  }

  if (patch.gateway) {
    next.gateway ??= {};
    if (patch.gateway.port !== undefined) next.gateway.port = Number(patch.gateway.port);
    if (patch.gateway.bind !== undefined) next.gateway.bind = patch.gateway.bind === '0.0.0.0' ? '0.0.0.0' : 'loopback';
  }

  if (next.agent?.maxTurns && next.agent.maxTurns < 1) {
    throw new Error('agent.maxTurns must be at least 1');
  }

  if (next.agent?.contextBudgetPct && (next.agent.contextBudgetPct < 1 || next.agent.contextBudgetPct > 100)) {
    throw new Error('agent.contextBudgetPct must be between 1 and 100');
  }

  return next;
}
