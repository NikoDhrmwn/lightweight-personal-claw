/**
 * LiteClaw — Express + WebSocket Gateway
 * 
 * Serves the Web UI, handles WebSocket streaming,
 * and provides REST endpoints for channels and CLI.
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { existsSync, watchFile, unwatchFile } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentEngine, AgentRequest, AgentStreamEvent } from '../core/engine.js';
import { ConfirmationManager, buildWebUIConfirmation } from '../core/confirmation.js';
import { MemoryStore } from '../core/memory.js';
import { getConfig, getConfigPath, getStateDir, loadConfig, reloadConfig, saveConfig, type LiteClawConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('gateway');
const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ───────────────────────────────────────────────────────────

interface WSMessage {
  type: 'message' | 'confirmation_response' | 'ping' | 'session_init';
  content?: string;
  images?: string[];
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

    this.app.patch('/api/config', (req, res) => {
      try {
        const current = getConfig();
        const next = applyConfigPatch(current, req.body ?? {});
        saveConfig(next);
        reloadConfig();
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

    // Fallback: serve index.html for SPA
    this.app.use((_req, res) => {
      res.sendFile(join(webuiDir, 'index.html'));
    });
  }

  private getWebUIState(): Record<string, any> {
    const config = getConfig();
    const primary = config.llm?.defaults?.primary ?? 'unknown';
    return {
      status: 'ok',
      version: '0.1.0',
      model: primary.split('/').pop() ?? primary,
      uptime: process.uptime(),
      workspace: this.resolveWorkspace(),
      channels: {
        webui: { connected: this.clients.size, enabled: true },
        discord: { enabled: !!config.channels?.discord?.enabled },
        whatsapp: { enabled: !!config.channels?.whatsapp?.enabled },
      },
      config: this.getEditableConfig(),
    };
  }

  private getEditableConfig(): Record<string, any> {
    const config = getConfig();
    return {
      llm: {
        primary: config.llm?.defaults?.primary ?? '',
      },
      agent: {
        workspace: this.resolveWorkspace(),
        maxTurns: config.agent?.maxTurns ?? 20,
        toolLoading: config.agent?.toolLoading ?? 'lazy',
        thinkingDefault: config.agent?.thinkingDefault ?? 'medium',
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
    };
  }

  private resolveWorkspace(candidate?: string): string {
    const config = getConfig();
    return candidate || config.agent?.workspace || process.cwd();
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

    if (!content && (!msg.images || msg.images.length === 0)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', content: 'Message cannot be empty.' }));
        ws.send(JSON.stringify({ type: 'done' }));
      }
      return;
    }

    const request: AgentRequest = {
      message: content || '(image attached)',
      images: msg.images,
      sessionKey,
      channelType: 'webui',
      workingDir: this.resolveWorkspace(msg.workingDir),
    };

    log.info({ sessionKey, messageLength: request.message.length }, 'WebUI message received');

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
            break;
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        }
      }
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
}

function applyConfigPatch(config: LiteClawConfig, patch: Record<string, any>): LiteClawConfig {
  const next: LiteClawConfig = structuredClone(config);

  if (patch.llm?.primary !== undefined) {
    (next.llm ??= {}).defaults ??= {};
    next.llm.defaults!.primary = String(patch.llm.primary);
  }

  if (patch.agent) {
    next.agent ??= {};
    if (patch.agent.workspace !== undefined) next.agent.workspace = String(patch.agent.workspace || '').trim();
    if (patch.agent.maxTurns !== undefined) next.agent.maxTurns = Number(patch.agent.maxTurns);
    if (patch.agent.toolLoading !== undefined) next.agent.toolLoading = patch.agent.toolLoading === 'all' ? 'all' : 'lazy';
    if (patch.agent.thinkingDefault !== undefined) next.agent.thinkingDefault = String(patch.agent.thinkingDefault);
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

  if (next.agent?.maxTurns && next.agent.maxTurns < 1) {
    throw new Error('agent.maxTurns must be at least 1');
  }

  return next;
}
