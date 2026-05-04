/**
 * LiteClaw — OpenClaw Migration Script
 * 
 * Imports configuration from ~/.openclaw/openclaw.json
 * into ~/.liteclaw/config.yaml + .env
 * 
 * Migrates: model configs, channel configs, exec approvals,
 * WhatsApp session, Discord token, memories.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { getStateDir, saveConfig, type LiteClawConfig } from './config.js';
import YAML from 'yaml';
import chalk from 'chalk';

export async function migrateFromOpenClaw(openclawDir: string): Promise<void> {
  const stateDir = getStateDir();

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // ─── 1. Load openclaw.json ─────────────────────────────────────
  const openclawJsonPath = join(openclawDir, 'openclaw.json');
  if (!existsSync(openclawJsonPath)) {
    throw new Error(`OpenClaw config not found at ${openclawJsonPath}`);
  }

  const oc = JSON.parse(readFileSync(openclawJsonPath, 'utf-8'));
  console.log(chalk.green('  ✓ Loaded openclaw.json'));

  // ─── 2. Extract secrets → .env ─────────────────────────────────
  const envLines: string[] = ['# LiteClaw Environment (migrated from OpenClaw)', ''];

  // Discord token
  const discordToken = oc.channels?.discord?.token;
  if (discordToken) {
    envLines.push(`DISCORD_TOKEN=${discordToken}`);
    console.log(chalk.green('  ✓ Migrated Discord token'));
  }

  // Google API key
  const googleKey = oc.models?.providers?.google?.apiKey;
  if (googleKey) {
    envLines.push(`GOOGLE_API_KEY=${googleKey}`);
    console.log(chalk.green('  ✓ Migrated Google API key'));
  }

  // Gateway token
  const gatewayToken = oc.gateway?.auth?.token;
  if (gatewayToken) {
    envLines.push(`GATEWAY_TOKEN=${gatewayToken}`);
  }

  // Local LLM config
  const localProvider = oc.models?.providers?.local;
  if (localProvider) {
    envLines.push(`LLM_BASE_URL=${localProvider.baseUrl ?? 'http://localhost:8080/v1'}`);
    envLines.push(`LLM_API_KEY=${localProvider.apiKey ?? 'sk-local'}`);
    const localModel = localProvider.models?.[0];
    if (localModel) {
      envLines.push(`LLM_MODEL=${localModel.id ?? 'gemma-4-e4b-heretic'}`);
    }
  }

  const envPath = join(stateDir, '.env');
  writeFileSync(envPath, envLines.join('\n'), 'utf-8');
  console.log(chalk.green(`  ✓ Created .env at ${envPath}`));

  // ─── 3. Build config.yaml ──────────────────────────────────────
  const config: LiteClawConfig = {
    meta: { version: '0.8.1' },

    llm: {
      providers: {},
      defaults: {},
    },

    agent: {
      contextTokens: oc.agents?.defaults?.contextTokens ?? 64000,
      maxTurns: 20,
      contextBudgetPct: 80,
      toolLoading: 'lazy',
      thinkingDefault: oc.agents?.defaults?.thinkingDefault ?? 'medium',
      compaction: {
        mode: oc.agents?.defaults?.compaction?.mode ?? 'safeguard',
        softThresholdTokens: oc.agents?.defaults?.compaction?.memoryFlush?.softThresholdTokens ?? 48000,
      },
    },

    channels: {
      web: { enabled: true, port: 7860 },
      discord: {},
      whatsapp: {},
    },

    tools: {
      exec: {
        enabled: true,
        confirmDestructive: true,
        safeBins: oc.tools?.exec?.safeBins ?? [],
      },
      web: {
        search: {
          provider: 'google-grounding',
          apiKey: '${GOOGLE_API_KEY}',
          browserFallback: true,
        },
        fetch: { enabled: true },
      },
      filesystem: { enabled: true, confirmDelete: true },
      vision: {
        enabled: true,
        maxDimensionPx: oc.agents?.defaults?.imageMaxDimensionPx ?? 1024,
      },
    },

    gateway: {
      port: 7860,
      bind: oc.gateway?.bind ?? 'loopback',
      auth: {
        mode: 'token',
        token: '${GATEWAY_TOKEN}',
      },
    },
  };

  // ─── Map model providers ──────────────────────────────────────
  if (oc.models?.providers) {
    for (const [provId, prov] of Object.entries(oc.models.providers)) {
      const p = prov as any;
      const models = (p.models ?? []).map((m: any) => ({
        id: m.id ?? m.name,
        contextWindow: m.contextWindow ?? 65536,
        maxTokens: m.maxTokens ?? 8192,
        vision: m.input?.includes('image') ?? false,
        reasoning: m.reasoning ?? false,
      }));

      (config.llm!.providers as any)[provId] = {
        baseUrl: provId === 'google' ? undefined : (p.baseUrl ?? ''),
        apiKey: provId === 'google' ? '${GOOGLE_API_KEY}' : (p.apiKey ?? 'sk-local'),
        models,
      };
    }

    // Set defaults
    const primary = oc.agents?.defaults?.model?.primary;
    if (primary) {
      config.llm!.defaults!.primary = primary;
    }
    config.llm!.defaults!.fallbacks = oc.agents?.defaults?.model?.fallbacks ?? [];
    config.llm!.defaults!.imageModel = oc.agents?.defaults?.imageModel?.primary;
  }

  console.log(chalk.green('  ✓ Migrated model configurations'));

  // ─── Map Discord config ──────────────────────────────────────
  if (oc.channels?.discord) {
    const dc = oc.channels.discord;
    config.channels!.discord = {
      enabled: dc.enabled ?? false,
      token: '${DISCORD_TOKEN}',
      replyStyle: 'single',
      showToolProgress: false,
      streaming: dc.streaming ?? 'off',
      maxLinesPerMessage: dc.maxLinesPerMessage ?? 2,
      markdown: dc.markdown ?? { tables: 'bullets' },
      activity: dc.activity ?? 'Ready to help.',
      allowBots: dc.allowBots ?? false,
      allowFrom: dc.allowFrom ?? ['*'],
      actions: dc.actions ?? {},
    };
    console.log(chalk.green('  ✓ Migrated Discord configuration'));
  }

  // ─── Map WhatsApp config ─────────────────────────────────────
  if (oc.channels?.whatsapp) {
    const wa = oc.channels.whatsapp;
    config.channels!.whatsapp = {
      enabled: wa.enabled ?? false,
      replyStyle: 'single',
      showToolProgress: false,
      sendReadReceipts: wa.sendReadReceipts ?? true,
      dmPolicy: wa.dmPolicy ?? 'open',
      allowFrom: wa.allowFrom ?? ['*'],
      chunkMode: wa.chunkMode ?? 'newline',
      mediaMaxMb: wa.mediaMaxMb ?? 50,
      actions: wa.actions ?? {},
    };
    console.log(chalk.green('  ✓ Migrated WhatsApp configuration'));
  }

  // Save config
  saveConfig(config);
  console.log(chalk.green(`  ✓ Created config.yaml`));

  // ─── 4. Copy exec-approvals.json ──────────────────────────────
  const approvalsPath = join(openclawDir, 'exec-approvals.json');
  if (existsSync(approvalsPath)) {
    copyFileSync(approvalsPath, join(stateDir, 'exec-approvals.json'));
    console.log(chalk.green('  ✓ Copied exec-approvals.json'));
  }

  // ─── 5. Copy WhatsApp session data ────────────────────────────
  // OpenClaw stores Baileys auth in credentials/whatsapp/default/
  const waSessionSource = join(openclawDir, 'credentials', 'whatsapp', 'default');

  if (existsSync(waSessionSource)) {
    const destDir = join(stateDir, 'whatsapp-session');
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });

    try {
      const { readdirSync, statSync } = await import('fs');
      const files = readdirSync(waSessionSource);
      let copiedCount = 0;

      for (const file of files) {
        const srcFile = join(waSessionSource, file);
        try {
          const stat = statSync(srcFile);
          if (stat.isFile()) {
            copyFileSync(srcFile, join(destDir, file));
            copiedCount++;
          }
        } catch { /* skip locked or inaccessible files */ }
      }

      console.log(chalk.green(`  ✓ Copied WhatsApp session (${copiedCount} files)`));
    } catch (err: any) {
      console.log(chalk.yellow(`  ⚠ WhatsApp session migration failed: ${err.message}`));
    }
  } else {
    console.log(chalk.gray('  ○ No WhatsApp session found to migrate'));
  }

  // ─── 6. Copy memory database ──────────────────────────────────
  const memoryPath = join(openclawDir, 'memory', 'main.sqlite');
  if (existsSync(memoryPath)) {
    copyFileSync(memoryPath, join(stateDir, 'memory.sqlite'));
    console.log(chalk.green('  ✓ Copied memory database'));
  }

  // ─── 7. Migrate personality files from workspace ────────────────
  const workspace = oc.agents?.defaults?.workspace;
  if (workspace) {
    // Store workspace in agent config
    (config.agent as any).workspace = workspace;
    saveConfig(config); // Re-save with workspace path

    const personalityFiles = [
      'SOUL.md',
      'IDENTITY.md',
      'USER.md',
      'AGENTS.md',
      'TOOLS.md',
      'GIFS.md',
      'HEARTBEAT.md',
      'MOLTBOOK_RULES.md',
    ];

    const destPersonalityDir = join(stateDir, 'personality');
    if (!existsSync(destPersonalityDir)) {
      mkdirSync(destPersonalityDir, { recursive: true });
    }

    let copiedCount = 0;
    for (const file of personalityFiles) {
      const srcPath = join(workspace, file);
      if (existsSync(srcPath)) {
        const content = readFileSync(srcPath, 'utf-8');

        // Adapt OpenClaw-specific references for LiteClaw
        const adapted = adaptPersonalityFile(file, content);
        writeFileSync(join(destPersonalityDir, file), adapted, 'utf-8');
        copiedCount++;
      }
    }

    if (copiedCount > 0) {
      console.log(chalk.green(`  ✓ Migrated ${copiedCount} personality files from ${workspace}`));
    }
  }

  // ─── 8. Copy system prompt template ───────────────────────────
  const systemPromptPath = join(stateDir, 'system_prompt.md');
  if (!existsSync(systemPromptPath)) {
    // Use the project's template if available
    const templatePath = join(process.cwd(), 'config', 'system_prompt.md');
    if (existsSync(templatePath)) {
      copyFileSync(templatePath, systemPromptPath);
    } else {
      writeFileSync(systemPromptPath, DEFAULT_SYSTEM_PROMPT, 'utf-8');
    }
    console.log(chalk.green('  ✓ Created system prompt'));
  }

  console.log(chalk.bold.green('\n  Migration summary:'));
  console.log(chalk.gray(`    State dir:    ${stateDir}`));
  console.log(chalk.gray(`    Config:       ${join(stateDir, 'config.yaml')}`));
  console.log(chalk.gray(`    Secrets:      ${envPath}`));
  console.log(chalk.gray(`    Personality:  ${join(stateDir, 'personality')}`));
  if (workspace) {
    console.log(chalk.gray(`    Workspace:    ${workspace}`));
  }
}

/**
 * Adapt a personality file from OpenClaw to LiteClaw.
 * Replaces OpenClaw-specific references with LiteClaw equivalents.
 */
function adaptPersonalityFile(fileName: string, content: string): string {
  let adapted = content;

  // Replace OpenClaw-specific tool references
  adapted = adapted.replace(/`canvas`/g, 'native image inspection');
  adapted = adapted.replace(/gemini CLI/g, 'native vision');
  adapted = adapted.replace(/gemini -p/g, 'native image inspection');
  adapted = adapted.replace(/C:\\\\Users\\\\elect\\\\.openclaw\\\\media\\\\inbound\\\\/g, '');
  adapted = adapted.replace(/C:\\Users\\elect\\.openclaw\\media\\inbound\\/g, '');

  // Replace OpenClaw workspace paths
  adapted = adapted.replace(/C:\\\\Users\\\\elect\\\\clawd\\\\/g, '');
  adapted = adapted.replace(/C:\\Users\\elect\\clawd\\/g, '');

  // Replace OpenClaw references with LiteClaw
  adapted = adapted.replace(/OpenClaw/g, 'LiteClaw');
  adapted = adapted.replace(/openclaw/g, 'liteclaw');

  // SOUL.md: update the vision instruction
  if (fileName === 'SOUL.md') {
    adapted = adapted.replace(
      /Vision & Images:.*?(?=\n- |\n###|\n##)/s,
      'Vision & Images: Images are handled natively — the model sees them inline. Just describe what you see.\n'
    );
    // Update Discord presence note
    adapted = adapted.replace(
      /High-Priority: Real-Time Discord Presence:.*?(?=\n\n)/s,
      'Discord Presence: Your Discord status updates automatically based on what you\'re doing (Reading files → Thinking → Idle). This is handled natively by the LiteClaw runtime — no manual effort needed.'
    );
  }

  // TOOLS.md: update tool references
  if (fileName === 'TOOLS.md') {
    adapted = adapted.replace(
      /python C:\\Users\\elect\\clawd\\skills\\google-grounding\\run\.py/g,
      'web_search tool'
    );
    adapted = adapted.replace(
      /gemini CLI.*?$/gm,
      'native vision (images are seen inline, no separate tool call needed)'
    );
  }

  return adapted;
}

const DEFAULT_SYSTEM_PROMPT = `# System Prompt — LiteClaw

You are **Molty**, an AI agent running locally via LiteClaw.

## Runtime

- **Engine:** LiteClaw v0.1 (Node.js, single-process)
- **Model:** Gemma 4 E4B (local, 64K context)
- **Channels:** WebUI, Discord (slash commands + reactions + dynamic status), WhatsApp
- **Tools:** read_file, write_file, delete_file, list_dir, send_file, exec, web_search, web_fetch
- **Vision:** Images are provided natively in the message content. Inspect them directly.

Today's date: ${new Date().toLocaleDateString()}
`;
