#!/usr/bin/env node
/**
 * LiteClaw — CLI Entry Point
 * 
 * Provides OpenClaw-identical command structure:
 *   liteclaw gateway run
 *   liteclaw channels login
 *   liteclaw status
 *   liteclaw doctor
 *   liteclaw config get/set
 *   liteclaw migrate
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { loadConfig, getConfig, getStateDir, saveConfig, getDefaultConfig } from './config.js';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const VERSION = '0.3.0';

const program = new Command();

program
  .name('liteclaw')
  .description('🦎 LiteClaw — Lightweight agent runtime for local LLMs')
  .version(VERSION, '-V, --version')
  .option('--no-color', 'Disable ANSI colors')
  .option('--log-level <level>', 'Log level (silent|error|warn|info|debug)', 'info')
  .hook('preAction', () => {
    loadConfig();
  });

// ─── Gateway Commands ────────────────────────────────────────────────

const gateway = program
  .command('gateway')
  .description('Run, inspect, and query the WebSocket Gateway');

gateway
  .command('run')
  .description('Run the WebSocket Gateway (foreground)')
  .option('--port <port>', 'Port for the gateway', '7860')
  .option('--force', 'Kill any existing listener on the target port')
  .option('--verbose', 'Verbose logging')
  .action(async (options) => {
    console.log(chalk.green(`\n🦎 LiteClaw ${VERSION}\n`));
    const spinner = ora('Starting gateway...').start();

    try {
      // Dynamic import to avoid loading everything for simple CLI commands
      const { startGateway } = await import('./index.js');
      spinner.succeed('Gateway components loaded');
      await startGateway(parseInt(options.port));
    } catch (err: any) {
      spinner.fail(`Failed to start: ${err.message}`);
      process.exit(1);
    }
  });

gateway
  .command('health')
  .description('Fetch gateway health')
  .action(async () => {
    const config = getConfig();
    const port = config.gateway?.port ?? 7860;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json();
      console.log(chalk.green('✓ Gateway is healthy'));
      console.log(JSON.stringify(data, null, 2));
    } catch {
      console.log(chalk.red('✗ Gateway is not reachable'));
      process.exit(1);
    }
  });

gateway
  .command('status')
  .description('Show gateway status')
  .action(async () => {
    const config = getConfig();
    const port = config.gateway?.port ?? 7860;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      const data = await res.json() as any;
      console.log(chalk.green(`✓ Gateway running on port ${port}`));
      console.log(`  WebUI clients: ${data.webClients}`);
      console.log(`  Pending confirmations: ${data.pendingConfirmations}`);
    } catch {
      console.log(chalk.red('✗ Gateway is not running'));
    }
  });

// ─── Channel Commands ────────────────────────────────────────────────

const channels = program
  .command('channels')
  .description('Manage connected chat channels');

channels
  .command('list')
  .description('List configured channels')
  .action(() => {
    const config = getConfig();
    console.log(chalk.bold('\nConfigured Channels:\n'));

    const ch = config.channels ?? {};
    for (const [name, conf] of Object.entries(ch)) {
      const c = conf as any;
      const status = c.enabled ? chalk.green('● enabled') : chalk.gray('○ disabled');
      console.log(`  ${status}  ${chalk.bold(name)}`);
    }
    console.log();
  });

channels
  .command('login')
  .description('Link a channel account')
  .option('--channel <channel>', 'Channel to link (whatsapp|discord)')
  .action(async (options) => {
    const channel = options.channel;
    if (channel === 'whatsapp') {
      console.log(chalk.yellow('Starting WhatsApp login... Scan the QR code with your phone.'));
      console.log(chalk.gray('(WhatsApp login will start when the gateway is running)'));
      console.log(chalk.gray('  Run: liteclaw gateway run'));
    } else if (channel === 'discord') {
      console.log(chalk.yellow('Discord uses a bot token. Set it in .env:'));
      console.log(chalk.gray('  DISCORD_TOKEN=your_token_here'));
    } else {
      console.log(chalk.red('Specify a channel: --channel whatsapp or --channel discord'));
    }
  });

channels
  .command('status')
  .description('Show channel status')
  .action(async () => {
    const config = getConfig();
    const port = config.gateway?.port ?? 7860;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json() as any;
      console.log(chalk.bold('\nChannel Status:\n'));
      if (data.channels) {
        for (const [name, info] of Object.entries(data.channels)) {
          const i = info as any;
          console.log(`  ${chalk.bold(name)}: ${JSON.stringify(i)}`);
        }
      }
    } catch {
      console.log(chalk.red('Gateway not running. Start it first: liteclaw gateway run'));
    }
    console.log();
  });

// ─── Config Commands ─────────────────────────────────────────────────

const configCmd = program
  .command('config')
  .description('Non-interactive config helpers');

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key: string) => {
    const config = getConfig();
    const value = getNestedValue(config, key);
    if (value !== undefined) {
      console.log(typeof value === 'object' ? JSON.stringify(value, null, 2) : value);
    } else {
      console.log(chalk.gray('(not set)'));
    }
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config value')
  .action((key: string, value: string) => {
    const config = getConfig();
    setNestedValue(config, key, value);
    saveConfig(config);
    console.log(chalk.green(`✓ Set ${key} = ${value}`));
  });

configCmd
  .command('validate')
  .description('Validate the config file')
  .action(() => {
    try {
      loadConfig();
      console.log(chalk.green('✓ Config is valid'));
    } catch (err: any) {
      console.log(chalk.red(`✗ Config error: ${err.message}`));
    }
  });

// ─── Model Commands ──────────────────────────────────────────────────

const models = program
  .command('models')
  .description('Discover and configure models');

models
  .command('list')
  .description('List configured models')
  .action(() => {
    const config = getConfig();
    console.log(chalk.bold('\nConfigured Models:\n'));

    for (const [provId, prov] of Object.entries(config.llm?.providers ?? {})) {
      const p = prov as any;
      for (const model of p.models ?? []) {
        const isPrimary = config.llm?.defaults?.primary === `${provId}/${model.id}`;
        const badge = isPrimary ? chalk.green(' ★ primary') : '';
        console.log(`  ${chalk.bold(`${provId}/${model.id}`)}${badge}`);
        console.log(chalk.gray(`    Context: ${model.contextWindow ?? '?'} | Vision: ${model.vision ?? false}`));
      }
    }
    console.log();
  });

// ─── Status & Doctor ─────────────────────────────────────────────────

program
  .command('status')
  .description('Show channel health and gateway status')
  .action(async () => {
    const config = getConfig();
    const port = config.gateway?.port ?? 7860;

    console.log(chalk.bold(`\n🦎 LiteClaw ${VERSION}\n`));
    console.log(`  State directory: ${chalk.cyan(getStateDir())}`);

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const data = await res.json();
      console.log(`  Gateway: ${chalk.green('● running')} on port ${port}`);
      console.log(`  Health: ${JSON.stringify(data)}`);
    } catch {
      console.log(`  Gateway: ${chalk.red('● stopped')}`);
    }
    console.log();
  });

program
  .command('doctor')
  .description('Health checks + quick fixes')
  .action(async () => {
    console.log(chalk.bold('\n🦎 LiteClaw Doctor\n'));

    // Check state dir
    const stateDir = getStateDir();
    if (existsSync(stateDir)) {
      console.log(chalk.green(`  ✓ State directory exists: ${stateDir}`));
    } else {
      console.log(chalk.yellow(`  ⚠ State directory missing, creating: ${stateDir}`));
      mkdirSync(stateDir, { recursive: true });
    }

    // Check config
    try {
      loadConfig();
      console.log(chalk.green('  ✓ Config is valid'));
    } catch {
      console.log(chalk.red('  ✗ Config is invalid'));
    }

    // Check LLM backend
    const config = getConfig();
    const baseUrl = (config.llm?.providers as any)?.local?.baseUrl ?? 'http://localhost:8080/v1';
    try {
      const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(chalk.green(`  ✓ LLM backend reachable at ${baseUrl}`));
      } else {
        console.log(chalk.yellow(`  ⚠ LLM backend returned ${res.status}`));
      }
    } catch {
      console.log(chalk.red(`  ✗ LLM backend not reachable at ${baseUrl}`));
    }

    // Check gateway
    const port = config.gateway?.port ?? 7860;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.log(chalk.green(`  ✓ Gateway running on port ${port}`));
      }
    } catch {
      console.log(chalk.gray(`  ○ Gateway not running (start with: liteclaw gateway run)`));
    }

    console.log();
  });

// ─── Message Command ─────────────────────────────────────────────────

program
  .command('message')
  .description('Send a message to the agent')
  .argument('<text>', 'Message text')
  .option('--session <key>', 'Session key', 'cli:default')
  .action(async (text: string, options) => {
    const config = getConfig();
    const port = config.gateway?.port ?? 7860;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionKey: options.session }),
      });
      const data = await res.json() as any;
      console.log(data.response);
    } catch {
      console.log(chalk.red('Gateway not running. Start it first: liteclaw gateway run'));
    }
  });

// ─── Agent Command ───────────────────────────────────────────────────

program
  .command('agent')
  .description('Run one agent turn via the gateway')
  .option('--message <message>', 'Message to send')
  .action(async (options) => {
    if (!options.message) {
      console.log(chalk.red('Provide a message: liteclaw agent --message "hello"'));
      return;
    }
    const config = getConfig();
    const port = config.gateway?.port ?? 7860;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: options.message }),
      });
      const data = await res.json() as any;
      console.log(data.response);
    } catch {
      console.log(chalk.red('Gateway not running.'));
    }
  });

// ─── Migrate Command ─────────────────────────────────────────────────

program
  .command('migrate')
  .description('Import configuration from OpenClaw')
  .option('--openclaw-dir <path>', 'OpenClaw state directory', join(process.env.USERPROFILE ?? '', '.openclaw'))
  .action(async (options) => {
    console.log(chalk.bold('\n🦎 Migrating from OpenClaw...\n'));
    try {
      const { migrateFromOpenClaw } = await import('./migrate.js');
      await migrateFromOpenClaw(options.openclawDir);
      console.log(chalk.green('\n✓ Migration complete!\n'));
    } catch (err: any) {
      console.log(chalk.red(`✗ Migration failed: ${err.message}`));
    }
  });

// ─── Setup Command ───────────────────────────────────────────────────

program
  .command('setup')
  .description('Initialize local config and workspace')
  .action(() => {
    const stateDir = getStateDir();
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    const configPath = join(stateDir, 'config.yaml');
    if (!existsSync(configPath)) {
      saveConfig(getDefaultConfig(), configPath);
      console.log(chalk.green(`✓ Created default config at ${configPath}`));
    } else {
      console.log(chalk.gray(`  Config already exists at ${configPath}`));
    }

    console.log(chalk.green('\n✓ Setup complete! Next steps:'));
    console.log(chalk.gray('  1. Edit ~/.liteclaw/config.yaml'));
    console.log(chalk.gray('  2. Create ~/.liteclaw/.env with your secrets'));
    console.log(chalk.gray('  3. Run: liteclaw gateway run'));
  });

// ─── Helpers ─────────────────────────────────────────────────────────

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => {
    if (!o[k]) o[k] = {};
    return o[k];
  }, obj);
  target[last] = value;
}

// ─── Parse & Execute ─────────────────────────────────────────────────

program.parse();
