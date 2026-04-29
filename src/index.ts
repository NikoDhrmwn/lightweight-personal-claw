/**
 * LiteClaw — Main Entry Point
 * 
 * Starts all enabled services: Gateway, Discord, WhatsApp.
 * Everything runs in a single Node.js process via asyncio.
 */

import { LLMClient } from './core/llm.js';
import { MemoryStore } from './core/memory.js';
import { ConfirmationManager } from './core/confirmation.js';
import { AgentEngine } from './core/engine.js';
import { GatewayServer } from './gateway/server.js';
import { loadConfig, getConfig } from './config.js';
import {
  createLogger,
  printBanner,
  printSection,
  printStepDone,
  printStepWarn,
  printStepSkip,
  printSectionEnd,
  printReady,
} from './logger.js';

// Register tools
import './tools/filesystem.js';
import './tools/exec.js';
import './tools/web.js';
import './tools/vision.js';
import './tools/channel.js';

const VERSION = '0.7.2';
const log = createLogger('main');

export async function startGateway(portOverride?: number): Promise<void> {
  // Load config
  loadConfig();
  const config = getConfig();

  printBanner(VERSION);

  // ── Core Services ──
  printSection('Core Services');

  const llm = new LLMClient();
  // Auto-detect models from running servers (non-blocking — falls back to config if offline)
  await llm.refreshProvidersAsync();
  printStepDone(`LLM client initialized (model: ${llm.getModelId()})`);

  const memory = new MemoryStore();
  printStepDone('Memory store loaded');

  const confirmations = new ConfirmationManager();
  printStepDone('Confirmation manager ready');

  const engine = new AgentEngine(llm, memory, confirmations);
  printStepDone('Agent engine started');

  printSectionEnd();

  // Override port if specified
  if (portOverride) {
    (config.gateway ??= {}).port = portOverride;
  }

  // ── Gateway ──
  printSection('Gateway');

  const gateway = new GatewayServer(engine, confirmations);
  await gateway.start();

  const port = config.gateway?.port ?? 7860;
  const bind = config.gateway?.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';
  printStepDone(`HTTP + WebSocket server on port ${port}`);
  printSectionEnd();

  // ── Channels ──
  printSection('Channels');

  printStepDone('WebUI (built-in)');

  // Start Discord if enabled
  if (config.channels?.discord?.enabled) {
    try {
      const { DiscordChannel } = await import('./channels/discord.js');
      const discord = new DiscordChannel(engine, confirmations);
      await discord.start();
      // Discord logs its own success via the 'ready' event
    } catch (err: any) {
      printStepWarn(`Discord failed: ${err.message}`);
      log.warn({ error: err.message }, 'Discord channel failed to start');
    }
  } else {
    printStepSkip('Discord (disabled)');
  }

  // Start WhatsApp if enabled
  if (config.channels?.whatsapp?.enabled) {
    try {
      const { WhatsAppChannel } = await import('./channels/whatsapp.js');
      const whatsapp = new WhatsAppChannel(engine, confirmations);
      await whatsapp.start();
    } catch (err: any) {
      printStepWarn(`WhatsApp failed: ${err.message}`);
      log.warn({ error: err.message }, 'WhatsApp channel failed to start');
    }
  } else {
    printStepSkip('WhatsApp (disabled)');
  }

  printSectionEnd();

  // ── Ready ──
  printReady({ port, bind });

  // Handle shutdown
  const shutdown = () => {
    console.log('\n  Shutting down LiteClaw...');
    gateway.stop();
    memory.close();
    confirmations.cancelAll();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// If run directly (not imported by CLI)
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  startGateway().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
