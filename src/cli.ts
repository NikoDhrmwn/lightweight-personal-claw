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
import { loadConfig, getConfig, getStateDir, saveConfig, getDefaultConfig, type LiteClawConfig } from './config.js';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import {
  tuiSelect, tuiConfirm, tuiInput, tuiNumber,
  printBanner, printSection, printSuccess, printInfo,
  printHint, printDone, printKeyValue, printWarning,
} from './tui.js';
import {
  doctorPrompts,
  ensureNeutralPrompts,
  exportPrompts,
  importPrompts,
  listPromptFiles,
  promptFileDisplayName,
  resolvePromptTarget,
  writeMinimalPromptSet,
} from './prompt_manager.js';

const VERSION = '0.8.0';

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
  .command('logout')
  .description('Log out and clear session for a channel')
  .option('--channel <channel>', 'Channel to logout (whatsapp)')
  .action(async (options) => {
    const channel = options.channel;
    if (channel === 'whatsapp') {
      const { rmSync } = await import('fs');
      const sessionDir = join(getStateDir(), 'whatsapp-session');
      if (existsSync(sessionDir)) {
        try {
          rmSync(sessionDir, { recursive: true, force: true });
          console.log(chalk.green('✓ WhatsApp session cleared. You will need to scan the QR code again on next start.'));
        } catch (err: any) {
          console.log(chalk.red(`✗ Failed to clear WhatsApp session: ${err.message}`));
        }
      } else {
        console.log(chalk.gray('No WhatsApp session found to clear.'));
      }
    } else {
      console.log(chalk.red('Logout currently only supports WhatsApp. For Discord, remove your DISCORD_TOKEN from .env.'));
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

// ─── Prompt Commands ─────────────────────────────────────────────────

const prompts = program
  .command('prompts')
  .description('Manage LiteClaw system prompt and personality files');

prompts
  .command('list')
  .description('List editable prompt files in the LiteClaw state directory')
  .action(() => {
    ensureNeutralPrompts();
    console.log(chalk.bold('\nPrompt Files:\n'));
    for (const info of listPromptFiles()) {
      const status = info.exists ? chalk.green('exists') : chalk.yellow('missing');
      console.log(`  ${chalk.bold(info.name.padEnd(8))} ${status}  ${info.estimatedTokens.toLocaleString()} tokens  ${info.path}`);
    }
    console.log();
  });

prompts
  .command('doctor')
  .description('Check prompt files for reliability and safety recommendations')
  .action(() => {
    ensureNeutralPrompts();
    const issues = doctorPrompts();
    console.log(chalk.bold('\nPrompt Doctor:\n'));
    for (const issue of issues) {
      const marker = issue.severity === 'error'
        ? chalk.red('error')
        : issue.severity === 'warn'
          ? chalk.yellow('warn ')
          : chalk.gray('info ');
      console.log(`  ${marker}  ${chalk.bold(issue.file)}  ${issue.message}`);
    }
    console.log();
    if (issues.some(issue => issue.severity === 'error')) {
      process.exitCode = 1;
    }
  });

prompts
  .command('reset')
  .description('Create or reset prompt files from built-in profiles')
  .option('--profile <profile>', 'Prompt profile (neutral|minimal)', 'neutral')
  .option('--force', 'Overwrite existing prompt files')
  .action((options) => {
    const profile = String(options.profile ?? 'neutral').toLowerCase();
    let changed: string[];
    if (profile === 'minimal') {
      if (!options.force && listPromptFiles().some(info => info.exists)) {
        console.log(chalk.yellow('Prompt files already exist. Re-run with --force to overwrite them.'));
        return;
      }
      changed = writeMinimalPromptSet();
    } else if (profile === 'neutral') {
      changed = ensureNeutralPrompts({ overwrite: !!options.force });
    } else {
      console.log(chalk.red('Unknown profile. Use: neutral or minimal'));
      process.exitCode = 1;
      return;
    }

    if (changed.length === 0) {
      console.log(chalk.gray('Prompt files already exist; nothing changed.'));
      return;
    }
    console.log(chalk.green(`✓ Wrote ${changed.length} prompt file(s):`));
    for (const path of changed) console.log(chalk.gray(`  ${path}`));
  });

prompts
  .command('edit <target>')
  .description('Open a prompt file for editing (system|behavior|identity|user|workspace|tools|style)')
  .action((target: string) => {
    ensureNeutralPrompts();
    try {
      const resolved = resolvePromptTarget(target);
      openEditor(resolved.path);
    } catch (err: any) {
      console.log(chalk.red(err.message));
      process.exitCode = 1;
    }
  });

prompts
  .command('export')
  .description('Export current prompt files to a directory')
  .requiredOption('--dir <path>', 'Target directory')
  .action((options) => {
    ensureNeutralPrompts();
    const copied = exportPrompts(resolve(String(options.dir)));
    console.log(chalk.green(`✓ Exported ${copied.length} prompt file(s):`));
    for (const path of copied) console.log(chalk.gray(`  ${path}`));
  });

prompts
  .command('import')
  .description('Import prompt files from a directory')
  .requiredOption('--dir <path>', 'Source directory')
  .option('--force', 'Overwrite existing prompt files')
  .action((options) => {
    try {
      const imported = importPrompts(resolve(String(options.dir)), { overwrite: !!options.force });
      if (imported.length === 0) {
        console.log(chalk.gray('No prompt files imported. Existing files are preserved unless --force is used.'));
        return;
      }
      console.log(chalk.green(`✓ Imported ${imported.length} prompt file(s):`));
      for (const path of imported) console.log(chalk.gray(`  ${path}`));
    } catch (err: any) {
      console.log(chalk.red(`Import failed: ${err.message}`));
      process.exitCode = 1;
    }
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
  .option('--interactive', 'Run guided onboarding wizard')
  .action(async (options) => {
    if (options.interactive) {
      await runInteractiveSetup();
      return;
    }

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
    const promptsCreated = ensureNeutralPrompts();
    if (promptsCreated.length > 0) {
      console.log(chalk.green(`Created ${promptsCreated.length} neutral prompt file(s)`));
    }

    console.log(chalk.gray('  1. Edit ~/.liteclaw/config.yaml'));
    console.log(chalk.gray('  2. Create ~/.liteclaw/.env with your secrets'));
    console.log(chalk.gray('  3. Run: liteclaw gateway run'));
  });

program
  .command('init')
  .description('Run guided LiteClaw onboarding')
  .action(async () => {
    await runInteractiveSetup();
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

async function runInteractiveSetup(): Promise<void> {
  const STEPS = 6;
  const stateDir = getStateDir();
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

  const configPath = join(stateDir, 'config.yaml');
  const isUpdate = existsSync(configPath);
  const config: LiteClawConfig = isUpdate ? getConfig() : getDefaultConfig();

  printBanner(VERSION);
  printInfo(isUpdate ? `Updating existing config: ${configPath}` : `Creating new config: ${configPath}`);
  printHint('Use arrow keys to navigate, Enter to select. Press Ctrl+C to abort.\n');

  // ── Step 1: LLM Provider ────────────────────────────────────────
  printSection('Model & Provider', 1, STEPS);

  const providerChoice = await tuiSelect({
    message: 'LLM provider',
    choices: [
      { value: 'local' as const, name: 'Local OpenAI-compatible server', description: 'llama.cpp, LM Studio, vLLM, etc.' },
      { value: 'ollama' as const, name: 'Ollama', description: 'Ollama REST API' },
      { value: 'custom' as const, name: 'Custom endpoint', description: 'Any OpenAI-compatible server' },
    ],
    default: 'local',
  });

  const currentLocal = (config.llm?.providers?.local as any) ?? {};
  const currentModel = currentLocal.models?.[0] ?? {};
  const providerId = providerChoice === 'custom' ? 'local' : providerChoice;
  const defaultBase = providerChoice === 'ollama'
    ? 'http://localhost:11434/v1'
    : (currentLocal.baseUrl ?? process.env.LLM_BASE_URL ?? 'http://localhost:8080/v1');

  const baseUrl = await tuiInput({ message: 'Base URL', default: defaultBase });
  const apiKey = await tuiInput({
    message: 'API key',
    default: providerChoice === 'ollama' ? 'ollama' : (currentLocal.apiKey ?? process.env.LLM_API_KEY ?? 'sk-local'),
  });
  const modelId = await tuiInput({
    message: 'Model ID',
    default: process.env.LLM_MODEL ?? currentModel.id ?? config.llm?.defaults?.primary?.split('/').pop() ?? 'gemma-4-e4b-heretic',
  });
  const contextWindow = await tuiNumber({ message: 'Context window (tokens)', default: Number(currentModel.contextWindow ?? 65536), min: 1024 });
  const maxTokens = await tuiNumber({ message: 'Max output tokens', default: Number(config.llm?.defaults?.maxOutputTokens ?? currentModel.maxTokens ?? 4096), min: 256 });
  const supportsVision = await tuiConfirm({ message: 'Vision support?', default: !!(currentModel.vision ?? false) });
  const supportsReasoning = await tuiConfirm({ message: 'Reasoning/thinking hints?', default: !!(currentModel.reasoning ?? true) });

  // ── Step 2: Sampling ────────────────────────────────────────────
  printSection('Sampling Parameters', 2, STEPS);
  printHint('Tip: lower temperature + top-p give more deterministic output for small models.\n');

  const temperature = await tuiNumber({ message: 'Temperature', default: Number(config.llm?.defaults?.temperature ?? 0.7), min: 0, max: 2 });
  const topP = await tuiNumber({ message: 'Top-p', default: Number(config.llm?.defaults?.topP ?? 0.9), min: 0, max: 1 });
  const topK = await tuiNumber({ message: 'Top-k', default: Number(config.llm?.defaults?.topK ?? 40), min: 1 });

  config.llm = {
    providers: {
      [providerId]: {
        baseUrl, apiKey,
        models: [{ id: modelId, contextWindow, maxTokens, vision: supportsVision, reasoning: supportsReasoning, tools: true }],
      },
    },
    defaults: { primary: `${providerId}/${modelId}`, fallbacks: [], temperature, topP, topK, maxOutputTokens: maxTokens },
  };

  // ── Step 3: Agent ───────────────────────────────────────────────
  printSection('Agent Behavior', 3, STEPS);

  config.agent ??= {};
  config.agent.workspace = await tuiInput({ message: 'Workspace path', default: config.agent.workspace ?? process.cwd() });
  config.agent.contextTokens = await tuiNumber({ message: 'Agent context tokens', default: Number(config.agent.contextTokens ?? contextWindow), min: 1024 });
  config.agent.contextBudgetPct = await tuiNumber({ message: 'Context budget %', default: Number(config.agent.contextBudgetPct ?? 80), min: 10, max: 100 });
  config.agent.historyMessageLimit = await tuiNumber({ message: 'History message limit', default: Number(config.agent.historyMessageLimit ?? 20), min: 1 });
  config.agent.maxTurns = await tuiNumber({ message: 'Max tool turns per request', default: Number(config.agent.maxTurns ?? 20), min: 1 });

  config.agent.toolLoading = await tuiSelect({
    message: 'Tool loading mode',
    choices: [
      { value: 'lazy' as const, name: 'Lazy', description: 'Load tools on demand (recommended for small models)' },
      { value: 'all' as const, name: 'All', description: 'Inject all tools into every turn' },
    ],
    default: (config.agent.toolLoading ?? 'lazy') as 'lazy',
  }) as 'lazy' | 'all';

  config.agent.thinkingDefault = await tuiSelect({
    message: 'Thinking budget',
    choices: [
      { value: 'low', name: 'Low', description: 'Fastest — best for small models' },
      { value: 'medium', name: 'Medium', description: 'Balanced' },
      { value: 'off', name: 'Off', description: 'No thinking tokens' },
      { value: 'high', name: 'High', description: 'Thorough — uses more context' },
    ],
    default: String(config.agent.thinkingDefault ?? 'low'),
  });

  const plannerEnabled = await tuiConfirm({ message: 'Enable task planner?', default: config.agent.planner?.enabled ?? true });
  config.agent.planner = {
    enabled: plannerEnabled,
    mode: plannerEnabled ? await tuiSelect({
      message: 'Planner mode',
      choices: [
        { value: 'auto' as const, name: 'Auto', description: 'Plan only for multi-step tasks' },
        { value: 'always' as const, name: 'Always', description: 'Always create a plan' },
        { value: 'off' as const, name: 'Off', description: 'Never plan' },
      ],
      default: (config.agent.planner?.mode ?? 'auto') as 'auto',
    }) as 'auto' | 'always' | 'off' : 'off',
    maxReplans: plannerEnabled ? await tuiNumber({ message: 'Max replans', default: Number(config.agent.planner?.maxReplans ?? 2), min: 0 }) : 0,
  };

  const skillsEnabled = await tuiConfirm({ message: 'Enable skills?', default: config.agent.skills?.enabled ?? true });
  config.agent.skills = {
    enabled: skillsEnabled,
    maxInjected: skillsEnabled ? await tuiNumber({ message: 'Max injected skills', default: Number(config.agent.skills?.maxInjected ?? 2), min: 0 }) : 0,
    directories: config.agent.skills?.directories ?? [],
  };

  // ── Step 4: Gateway & Channels ──────────────────────────────────
  printSection('Gateway & Channels', 4, STEPS);

  config.gateway ??= {};
  config.gateway.port = await tuiNumber({ message: 'Gateway port', default: Number(config.gateway.port ?? 7860), min: 1, max: 65535 });
  config.gateway.bind = await tuiSelect({
    message: 'Gateway bind address',
    choices: [
      { value: 'loopback', name: 'Loopback only', description: '127.0.0.1 — most secure' },
      { value: '0.0.0.0', name: 'All interfaces', description: 'Network visible — requires auth' },
    ],
    default: config.gateway.bind ?? 'loopback',
  });
  config.gateway.auth ??= { mode: 'token' };

  config.channels ??= {};
  config.channels.web = { enabled: true, port: config.gateway.port };

  const discordEnabled = await tuiConfirm({ message: 'Enable Discord channel?', default: !!config.channels.discord?.enabled });
  config.channels.discord = {
    ...(config.channels.discord ?? {}),
    enabled: discordEnabled,
    replyStyle: discordEnabled ? await tuiSelect({
      message: 'Discord reply style',
      choices: [
        { value: 'single' as const, name: 'Single response', description: 'One complete message' },
        { value: 'rapid' as const, name: 'Rapid messages', description: 'Stream short bursts' },
      ],
      default: (config.channels.discord?.replyStyle ?? 'single') as 'single',
    }) as 'single' | 'rapid' : (config.channels.discord?.replyStyle ?? 'single') as 'single' | 'rapid',
    showToolProgress: discordEnabled ? await tuiConfirm({ message: 'Show tool progress in Discord?', default: !!config.channels.discord?.showToolProgress }) : false,
  };

  const whatsappEnabled = await tuiConfirm({ message: 'Enable WhatsApp channel?', default: !!config.channels.whatsapp?.enabled });
  config.channels.whatsapp = {
    ...(config.channels.whatsapp ?? {}),
    enabled: whatsappEnabled,
    replyStyle: whatsappEnabled ? await tuiSelect({
      message: 'WhatsApp reply style',
      choices: [
        { value: 'single' as const, name: 'Single response', description: 'One complete message' },
        { value: 'rapid' as const, name: 'Rapid messages', description: 'Stream short bursts' },
      ],
      default: (config.channels.whatsapp?.replyStyle ?? 'single') as 'single',
    }) as 'single' | 'rapid' : (config.channels.whatsapp?.replyStyle ?? 'single') as 'single' | 'rapid',
    showToolProgress: whatsappEnabled ? await tuiConfirm({ message: 'Show tool progress in WhatsApp?', default: !!config.channels.whatsapp?.showToolProgress }) : false,
  };

  // ── Step 5: Tools & Safety ──────────────────────────────────────
  printSection('Tools & Safety', 5, STEPS);

  const defaults = getDefaultConfig();
  config.tools ??= {};
  config.tools.exec = {
    ...(config.tools.exec ?? {}),
    enabled: await tuiConfirm({ message: 'Enable exec tool?', default: config.tools.exec?.enabled ?? true }),
    confirmDestructive: await tuiConfirm({ message: 'Confirm destructive commands?', default: config.tools.exec?.confirmDestructive ?? true }),
    safeBins: config.tools.exec?.safeBins ?? defaults.tools?.exec?.safeBins,
  };
  config.tools.filesystem = {
    ...(config.tools.filesystem ?? {}),
    enabled: await tuiConfirm({ message: 'Enable filesystem tools?', default: config.tools.filesystem?.enabled ?? true }),
    confirmDelete: await tuiConfirm({ message: 'Confirm file deletion?', default: config.tools.filesystem?.confirmDelete ?? true }),
  };
  config.tools.web = config.tools.web ?? defaults.tools?.web;
  config.tools.vision = config.tools.vision ?? defaults.tools?.vision;

  // ── Step 6: Prompts ─────────────────────────────────────────────
  printSection('Prompt Profile', 6, STEPS);

  const promptProfile = await tuiSelect({
    message: 'Prompt profile',
    choices: [
      { value: 'neutral', name: 'Neutral', description: 'Universal safe defaults — recommended' },
      { value: 'minimal', name: 'Minimal', description: 'Bare-minimum behavior prompt' },
      { value: 'custom', name: 'Custom', description: 'Start from neutral, then open editor' },
    ],
    default: 'neutral',
  });

  const promptFiles = promptProfile === 'minimal'
    ? writeMinimalPromptSet()
    : ensureNeutralPrompts();

  saveConfig(config, configPath);

  if (promptProfile === 'custom') {
    printInfo('Opening behavior prompt for editing...');
    printHint('You can also run: liteclaw prompts edit system');
    openEditor(resolvePromptTarget('soul').path);
  }

  // ── Summary ─────────────────────────────────────────────────────
  printDone([
    `Config   ${configPath}`,
    `Prompts  ${join(getStateDir(), 'personality')}`,
    `Files    ${promptFiles.length} prompt file(s) created/updated`,
    '',
    'Next steps:',
    '  liteclaw prompts doctor   Check prompts for issues',
    '  liteclaw doctor           Verify connectivity',
    '  liteclaw gateway run      Start the agent',
  ]);
}




function openEditor(filePath: string): void {
  const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'vi');
  console.log(chalk.gray(`Opening ${promptFileDisplayName(filePath)} with ${editor}`));
  const result = spawnSync(editor, [filePath], { stdio: 'inherit', shell: true });
  if (result.error) {
    console.log(chalk.yellow(`Could not open editor: ${result.error.message}`));
    console.log(chalk.gray(`Edit this file manually: ${filePath}`));
  }
}

program.parse();
