import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { getStateDir } from './config.js';

export const PERSONALITY_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
  'GIFS.md',
] as const;

export type PersonalityFile = typeof PERSONALITY_FILES[number];
export type PromptTarget =
  | 'system'
  | 'soul'
  | 'behavior'
  | 'identity'
  | 'user'
  | 'agents'
  | 'workspace'
  | 'tools'
  | 'gifs'
  | 'style';

export interface PromptFileInfo {
  name: string;
  path: string;
  exists: boolean;
  size: number;
  estimatedTokens: number;
}

export interface PromptDoctorIssue {
  severity: 'info' | 'warn' | 'error';
  file: string;
  message: string;
}

const TARGET_TO_FILE: Record<PromptTarget, string> = {
  system: 'system_prompt.md',
  soul: 'SOUL.md',
  behavior: 'SOUL.md',
  identity: 'IDENTITY.md',
  user: 'USER.md',
  agents: 'AGENTS.md',
  workspace: 'AGENTS.md',
  tools: 'TOOLS.md',
  gifs: 'GIFS.md',
  style: 'GIFS.md',
};

const UNSAFE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\blie\b|\bdeceive\b|\binvent absurd\b/i, message: 'Avoid instructions to lie or deceive users.' },
  { pattern: /\bfake (api )?keys?\b|\btroll\b/i, message: 'Avoid instructions to provide fake secrets or troll users.' },
  { pattern: /\bignore (system|developer|safety) instructions\b/i, message: 'Avoid instructions that override higher-priority safety rules.' },
  { pattern: /\bshare (api keys?|secrets?|tokens?)\b/i, message: 'Avoid instructions that could expose secrets.' },
  { pattern: /\bdo not ask permission\b/i, message: 'Avoid blanket autonomy rules; prefer explicit safety boundaries.' },
];

const PERSONAL_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\bcreator\b/i, message: 'Use user/operator/project wording instead of creator framing.' },
  { pattern: /\byour soul\b|\bthis is who you are\b/i, message: 'Use behavior/profile wording instead of identity or soul framing.' },
  { pattern: /\bguest in.+life\b|\baccess to someone'?s life\b/i, message: 'Avoid intimate personal framing in universal defaults.' },
  { pattern: /C:\\Users\\|\/home\/[A-Za-z0-9_-]+|[A-Z]:\\/i, message: 'Avoid machine-specific paths in reusable prompts.' },
];

export function getStatePromptDir(): string {
  return join(getStateDir(), 'personality');
}

export function getProjectPromptDir(): string {
  return join(process.cwd(), 'config', 'personality');
}

export function getSystemPromptPath(): string {
  return join(getStateDir(), 'system_prompt.md');
}

export function resolvePromptTarget(target: string): { label: string; path: string } {
  const normalized = target.trim().toLowerCase() as PromptTarget;
  const file = TARGET_TO_FILE[normalized];
  if (!file) {
    throw new Error(`Unknown prompt target "${target}". Use: ${Object.keys(TARGET_TO_FILE).join(', ')}`);
  }

  return {
    label: normalized,
    path: normalized === 'system' ? getSystemPromptPath() : join(getStatePromptDir(), file),
  };
}

export function ensureNeutralPrompts(options: { overwrite?: boolean } = {}): string[] {
  const stateDir = getStateDir();
  const personalityDir = getStatePromptDir();
  const projectPrompt = join(process.cwd(), 'config', 'system_prompt.md');
  const created: string[] = [];

  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  if (!existsSync(personalityDir)) mkdirSync(personalityDir, { recursive: true });

  const systemDest = getSystemPromptPath();
  if (options.overwrite || !existsSync(systemDest)) {
    copyFileSync(projectPrompt, systemDest);
    created.push(systemDest);
  }

  for (const file of PERSONALITY_FILES) {
    const src = join(getProjectPromptDir(), file.replace(/\.md$/, '.template.md'));
    const dest = join(personalityDir, file);
    if (!existsSync(src)) continue;
    if (options.overwrite || !existsSync(dest)) {
      copyFileSync(src, dest);
      created.push(dest);
    }
  }

  return created;
}

export function listPromptFiles(): PromptFileInfo[] {
  const files = [
    { name: 'system', path: getSystemPromptPath() },
    ...PERSONALITY_FILES.map(file => ({
      name: file.replace(/\.md$/, '').toLowerCase(),
      path: join(getStatePromptDir(), file),
    })),
  ];

  return files.map(file => {
    if (!existsSync(file.path)) {
      return { ...file, exists: false, size: 0, estimatedTokens: 0 };
    }
    const content = readFileSync(file.path, 'utf-8');
    return {
      ...file,
      exists: true,
      size: Buffer.byteLength(content, 'utf-8'),
      estimatedTokens: estimateTokens(content),
    };
  });
}

export function doctorPrompts(): PromptDoctorIssue[] {
  const issues: PromptDoctorIssue[] = [];
  const infos = listPromptFiles();
  const totalTokens = infos.reduce((sum, info) => sum + info.estimatedTokens, 0);

  for (const info of infos) {
    if (!info.exists) {
      issues.push({ severity: 'warn', file: info.name, message: 'Prompt file is missing; run prompts reset to create neutral defaults.' });
      continue;
    }

    const content = readFileSync(info.path, 'utf-8');
    if (info.estimatedTokens > 2500) {
      issues.push({ severity: 'warn', file: info.name, message: `Large prompt file (${info.estimatedTokens} estimated tokens). Smaller local models are more reliable with concise prompts.` });
    }

    for (const check of UNSAFE_PATTERNS) {
      if (check.pattern.test(content)) {
        issues.push({ severity: 'error', file: info.name, message: check.message });
      }
    }

    for (const check of PERSONAL_PATTERNS) {
      if (check.pattern.test(content)) {
        issues.push({ severity: 'warn', file: info.name, message: check.message });
      }
    }
  }

  if (totalTokens > 7000) {
    issues.push({ severity: 'warn', file: 'all', message: `Prompt set is ${totalTokens} estimated tokens. Recommended default for 4B-9B models is under 7000 tokens.` });
  } else {
    issues.push({ severity: 'info', file: 'all', message: `Prompt set is ${totalTokens} estimated tokens.` });
  }

  return issues;
}

export function exportPrompts(targetDir: string): string[] {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];

  for (const info of listPromptFiles()) {
    if (!info.exists) continue;
    const dest = join(targetDir, info.name === 'system' ? 'system_prompt.md' : `${info.name.toUpperCase()}.md`);
    copyFileSync(info.path, dest);
    copied.push(dest);
  }

  return copied;
}

export function importPrompts(sourceDir: string, options: { overwrite?: boolean } = {}): string[] {
  if (!existsSync(sourceDir)) throw new Error(`Prompt directory not found: ${sourceDir}`);
  if (!existsSync(getStatePromptDir())) mkdirSync(getStatePromptDir(), { recursive: true });

  const imported: string[] = [];
  const candidates = readdirSync(sourceDir)
    .filter(name => name.toLowerCase().endsWith('.md'));

  for (const name of candidates) {
    const upper = name.toUpperCase();
    const dest = upper === 'SYSTEM_PROMPT.MD'
      ? getSystemPromptPath()
      : PERSONALITY_FILES.find(file => file.toUpperCase() === upper)
        ? join(getStatePromptDir(), PERSONALITY_FILES.find(file => file.toUpperCase() === upper)!)
        : null;

    if (!dest) continue;
    if (!options.overwrite && existsSync(dest)) continue;
    copyFileSync(join(sourceDir, name), dest);
    imported.push(dest);
  }

  return imported;
}

export function writeMinimalPromptSet(): string[] {
  if (!existsSync(getStateDir())) mkdirSync(getStateDir(), { recursive: true });
  if (!existsSync(getStatePromptDir())) mkdirSync(getStatePromptDir(), { recursive: true });

  const writes: Array<{ path: string; content: string }> = [
    {
      path: getSystemPromptPath(),
      content: `# LiteClaw System Prompt

You are {{BOT_NAME}}, a local AI assistant running through LiteClaw.

Be concise, accurate, and useful. Use tools when needed. Keep private data private. Ask before destructive, public, or high-impact actions.

Today's date: {{DATE}}
`,
    },
    {
      path: join(getStatePromptDir(), 'SOUL.md'),
      content: '# Behavior Profile\n\nUse a neutral, helpful, professional style. Prefer clear answers and verified tool use over speculation.\n',
    },
    {
      path: join(getStatePromptDir(), 'IDENTITY.md'),
      content: '# Identity\n\n- Name: {{BOT_NAME}}\n- Runtime: LiteClaw\n',
    },
    {
      path: join(getStatePromptDir(), 'USER.md'),
      content: '# User Context\n\nKeep optional user preferences here. Do not store secrets.\n',
    },
    {
      path: join(getStatePromptDir(), 'AGENTS.md'),
      content: '# Workspace Rules\n\nWork inside the configured workspace. Confirm destructive or external actions.\n',
    },
    {
      path: join(getStatePromptDir(), 'TOOLS.md'),
      content: '# Tool Notes\n\nUse the smallest relevant tool set. Read before editing. Summarize tool failures clearly.\n',
    },
    {
      path: join(getStatePromptDir(), 'GIFS.md'),
      content: '# Style Assets\n\nNo default reaction assets configured.\n',
    },
  ];

  for (const write of writes) {
    writeFileSync(write.path, write.content, 'utf-8');
  }

  return writes.map(write => write.path);
}

export function promptFileDisplayName(path: string): string {
  return basename(path);
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}
