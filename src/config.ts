/**
 * LiteClaw — Configuration Loader
 * 
 * Loads YAML config with .env variable expansion.
 * Provides a singleton config accessor.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import YAML from 'yaml';
import { config as loadDotenv } from 'dotenv';
import { createLogger } from './logger.js';

const log = createLogger('config');

// ─── Types ───────────────────────────────────────────────────────────

export interface LiteClawConfig {
  meta?: { version?: string };
  llm?: {
    providers?: Record<string, any>;
    defaults?: {
      primary?: string;
      fallbacks?: string[];
      imageModel?: string;
    };
  };
  agent?: {
    name?: string;
    systemPromptFile?: string;
    workspace?: string;
    contextTokens?: number;
    maxTurns?: number;
    historyMessageLimit?: number;
    contextBudgetPct?: number;
    toolLoading?: 'lazy' | 'all';
    thinkingDefault?: string;
    compaction?: {
      mode?: string;
      softThresholdTokens?: number;
    };
    planner?: {
      enabled?: boolean;
      mode?: 'auto' | 'always' | 'off';
      maxReplans?: number;
    };
    skills?: {
      enabled?: boolean;
      maxInjected?: number;
      directories?: string[];
    };
  };
  channels?: {
    web?: { enabled?: boolean; port?: number };
    discord?: {
      enabled?: boolean;
      replyStyle?: 'single' | 'rapid';
      showToolProgress?: boolean;
      [key: string]: any;
    };
    whatsapp?: {
      enabled?: boolean;
      replyStyle?: 'single' | 'rapid';
      showToolProgress?: boolean;
      [key: string]: any;
    };
  };
  tools?: {
    exec?: Record<string, any>;
    web?: Record<string, any>;
    filesystem?: Record<string, any>;
    vision?: Record<string, any>;
  };
  gateway?: {
    port?: number;
    bind?: string;
    auth?: { mode?: string; token?: string };
  };
}

// ─── Config Singleton ────────────────────────────────────────────────

let _config: LiteClawConfig | null = null;
let _configPath: string = '';
let _stateDir: string = '';

export function getStateDir(): string {
  if (_stateDir) return _stateDir;
  _stateDir = process.env.LITECLAW_STATE_DIR ??
    join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.liteclaw');
  return _stateDir;
}

export function getConfigPath(): string {
  if (_configPath) return _configPath;
  _configPath = process.env.LITECLAW_CONFIG_PATH ??
    join(getStateDir(), 'config.yaml');
  return _configPath;
}

export function loadConfig(configPath?: string): LiteClawConfig {
  // Load .env from state dir
  const stateDir = getStateDir();
  const envPath = join(stateDir, '.env');
  if (existsSync(envPath)) {
    loadDotenv({ path: envPath });
  }
  // Also load from project dir
  loadDotenv();

  const finalPath = configPath ?? getConfigPath();

  if (!existsSync(finalPath)) {
    log.warn({ path: finalPath }, 'Config file not found, using defaults');
    _config = getDefaultConfig();
    return _config;
  }

  try {
    let raw = readFileSync(finalPath, 'utf-8');

    // Expand ${VAR} references to environment variables
    raw = raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');

    _config = YAML.parse(raw) as LiteClawConfig;
    log.info({ path: finalPath }, 'Config loaded');
    return _config;
  } catch (err: any) {
    log.error({ error: err.message, path: finalPath }, 'Failed to load config');
    _config = getDefaultConfig();
    return _config;
  }
}

export function getConfig(): LiteClawConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function reloadConfig(configPath?: string): LiteClawConfig {
  _config = null;
  return loadConfig(configPath);
}

export function getDefaultConfig(): LiteClawConfig {
  return {
    meta: { version: '0.1.0' },
    llm: {
      providers: {
        local: {
          baseUrl: process.env.LLM_BASE_URL ?? 'http://localhost:8080/v1',
          apiKey: process.env.LLM_API_KEY ?? 'sk-local',
          models: [{
            id: process.env.LLM_MODEL ?? 'gemma-4-e4b-heretic',
            contextWindow: 65536,
            maxTokens: 8192,
            vision: true,
            reasoning: true,
          }],
        },
      },
      defaults: {
        primary: `local/${process.env.LLM_MODEL ?? 'gemma-4-e4b-heretic'}`,
        fallbacks: [],
      },
    },
    agent: {
      name: 'Molty Bot',
      systemPromptFile: 'system_prompt.md',
      contextTokens: 64000,
      maxTurns: 20,
      historyMessageLimit: 20,
      contextBudgetPct: 80,
      toolLoading: 'lazy',
      thinkingDefault: 'medium',
      compaction: {
        mode: 'safeguard',
        softThresholdTokens: 48000,
      },
      planner: {
        enabled: true,
        mode: 'auto',
        maxReplans: 2,
      },
      skills: {
        enabled: true,
        maxInjected: 2,
        directories: [],
      },
    },
    channels: {
      web: { enabled: true, port: 7860 },
      discord: { enabled: false, replyStyle: 'single', showToolProgress: false },
      whatsapp: { enabled: false, replyStyle: 'single', showToolProgress: false },
    },
    tools: {
      exec: {
        enabled: true,
        confirmDestructive: true,
        safeBins: [
          'node', 'python', 'python3', 'pip', 'npm', 'npx', 'git',
          'curl', 'powershell', 'cmd', 'dir', 'type', 'echo', 'cat',
          'ls', 'mkdir', 'where', 'which', 'find',
        ],
      },
      web: {
        search: { provider: 'free-metasearch', browserFallback: true },
        fetch: { enabled: true },
      },
      filesystem: { enabled: true, confirmDelete: true },
      vision: { enabled: true, maxDimensionPx: 1024 },
    },
    gateway: {
      port: 7860,
      bind: 'loopback',
      auth: { mode: 'token' },
    },
  };
}

/**
 * Write config to file.
 */
export function saveConfig(config: LiteClawConfig, configPath?: string): void {
  const finalPath = configPath ?? getConfigPath();
  const dir = dirname(finalPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(finalPath, YAML.stringify(config, { indent: 2 }), 'utf-8');
  _config = config;
  log.info({ path: finalPath }, 'Config saved');
}

/**
 * Load the full system prompt by composing the base prompt
 * with all personality files (SOUL.md, IDENTITY.md, USER.md, etc.).
 */
export function loadSystemPrompt(): string {
  const config = getConfig();
  const stateDir = getStateDir();
  const projectConfigDir = join(process.cwd(), 'config');
  const personalityDir = join(projectConfigDir, 'personality');

  // ── Load base system prompt ──
  const promptFile = config.agent?.systemPromptFile ?? 'system_prompt.md';
  let basePrompt = '';

  const promptPaths = [
    join(stateDir, promptFile),
    join(projectConfigDir, promptFile),
  ];
  for (const p of promptPaths) {
    if (existsSync(p)) {
      basePrompt = readFileSync(p, 'utf-8');
      break;
    }
  }

  if (!basePrompt) {
    basePrompt = `You are LiteClaw, a helpful AI assistant running locally. Be concise and helpful.`;
  }

  // ── Inject dynamic values ──
  basePrompt = basePrompt.replace(/\{\{DATE\}\}/g, new Date().toLocaleDateString());
  basePrompt = basePrompt.replace(/\{\{STATE_DIR\}\}/g, stateDir.replace(/\\/g, '/'));

  // ── Load personality files ──
  const PERSONALITY_FILES = [
    'SOUL.md',
    'IDENTITY.md',
    'USER.md',
    'AGENTS.md',
    'TOOLS.md',
    'GIFS.md',
  ];

  const personalityParts: string[] = [];

  for (const file of PERSONALITY_FILES) {
    // Search order: state dir → personality dir → workspace dir
    const candidates = [
      join(stateDir, 'personality', file),
      join(personalityDir, file),
    ];

    // Also check any configured workspace directory
    const workspace = (config.agent as any)?.workspace;
    if (workspace) {
      candidates.push(join(workspace, file));
    }

    for (const p of candidates) {
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf-8').trim();
        if (content) {
          personalityParts.push(content);
        }
        break; // Use first found
      }
    }
  }

  // ── Compose final prompt ──
  const parts = [basePrompt];

  if (personalityParts.length > 0) {
    parts.push('\n---\n\n# Personality & Instructions\n');
    parts.push(personalityParts.join('\n\n---\n\n'));
  }

  const fullPrompt = parts.join('\n');

  log.info({
    baseLength: basePrompt.length,
    personalityFiles: personalityParts.length,
    totalLength: fullPrompt.length,
    estimatedTokens: Math.ceil(fullPrompt.length / 4),
  }, 'System prompt composed');

  return fullPrompt;
}
