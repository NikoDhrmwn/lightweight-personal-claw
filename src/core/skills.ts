/**
 * LiteClaw - Skill Catalog and Selection
 *
 * Loads markdown skills from local directories and injects only the
 * most relevant ones into the model prompt for the current request.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';
import { createLogger } from '../logger.js';
import { getConfig, getStateDir } from '../config.js';

const log = createLogger('skills');
const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface LoadedSkill {
  name: string;
  description: string;
  license?: string;
  body: string;
  path: string;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'have', 'when',
  'want', 'need', 'use', 'using', 'about', 'them', 'they', 'their', 'then', 'than',
  'will', 'just', 'like', 'make', 'edit', 'file', 'files', 'chat', 'agent', 'skill',
  'tools', 'tool', 'user', 'users', 'help', 'into', 'such', 'some', 'between', 'where',
]);

let cachedKey = '';
let cachedSkills: LoadedSkill[] = [];

export function loadSkillCatalog(): LoadedSkill[] {
  const directories = getSkillDirectories();
  const cacheKey = directories.join('|');
  if (cacheKey === cachedKey && cachedSkills.length > 0) {
    return cachedSkills;
  }

  const byName = new Map<string, LoadedSkill>();

  for (const dir of directories) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const skill = parseSkillFile(skillFile);
      if (!skill) continue;

      if (!byName.has(skill.name)) {
        byName.set(skill.name, skill);
      }
    }
  }

  cachedKey = cacheKey;
  cachedSkills = Array.from(byName.values());
  log.info({ count: cachedSkills.length, directories }, 'Loaded skill catalog');
  return cachedSkills;
}

export function selectRelevantSkills(message: string, maxSkills?: number): LoadedSkill[] {
  const catalog = loadSkillCatalog();
  const limit = maxSkills ?? getConfig().agent?.skills?.maxInjected ?? 2;
  const lowered = message.toLowerCase();
  const messageTokens = tokenize(message);

  const scored = catalog
    .map(skill => ({ skill, score: scoreSkill(skill, lowered, messageTokens) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.skill);

  log.debug({ selected: scored.map(skill => skill.name) }, 'Selected relevant skills');
  return scored;
}

export function buildSkillPrompt(skills: LoadedSkill[]): string {
  if (skills.length === 0) return '';

  const parts = ['# Active Skills'];
  for (const skill of skills) {
    parts.push(
      `## Skill: ${skill.name}`,
      `Source: ${skill.path}`,
      `Description: ${skill.description}`,
      '',
      skill.body.trim()
    );
  }

  return parts.join('\n');
}

function getSkillDirectories(): string[] {
  const config = getConfig();
  const stateDir = getStateDir();
  const configured = config.agent?.skills?.directories ?? [];
  const workspace = config.agent?.workspace;
  const builtInSkillsDir = resolve(moduleDir, '..', '..', 'skills');

  return uniquePaths([
    join(stateDir, 'skills'),
    builtInSkillsDir,
    join(process.cwd(), 'skills'),
    workspace ? join(workspace, 'skills') : '',
    ...configured,
  ].filter(Boolean));
}

function uniquePaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map(p => p.trim()).filter(Boolean)));
}

function parseSkillFile(path: string): LoadedSkill | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);

    let meta: Record<string, any> = {};
    let body = raw;

    if (match) {
      meta = (YAML.parse(match[1]) as Record<string, any>) ?? {};
      body = match[2] ?? '';
    }

    const name = String(meta.name ?? inferSkillNameFromPath(path)).trim();
    const description = String(meta.description ?? '').trim() || `Skill instructions for ${name}`;

    return {
      name,
      description,
      license: meta.license ? String(meta.license) : undefined,
      body: body.trim(),
      path,
    };
  } catch (err: any) {
    log.warn({ path, error: err.message }, 'Failed to parse skill file');
    return null;
  }
}

function inferSkillNameFromPath(path: string): string {
  const parts = path.split(/[/\\]+/);
  return parts[Math.max(0, parts.length - 2)] ?? 'unknown-skill';
}

function scoreSkill(skill: LoadedSkill, loweredMessage: string, messageTokens: Set<string>): number {
  let score = 0;
  const normalizedName = skill.name.toLowerCase();
  const aliasName = normalizedName.replace(/[-_]/g, ' ');
  const corpus = `${skill.name} ${skill.description}`.toLowerCase();

  if (loweredMessage.includes(normalizedName)) score += 8;
  if (loweredMessage.includes(aliasName)) score += 6;

  if (normalizedName === 'pdf' && /\.pdf\b|pdf\b/.test(loweredMessage)) score += 10;
  if (normalizedName === 'docx' && /\.docx\b|word document|word doc|docx\b/.test(loweredMessage)) score += 10;
  if (normalizedName.includes('discord') && /discord|button|buttons|interactive|choose|select menu|selection/.test(loweredMessage)) {
    score += 10;
  }

  for (const token of tokenize(corpus)) {
    if (messageTokens.has(token)) score += 1;
  }

  return score;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9_.-]{3,}/g)?.filter(token => !STOPWORDS.has(token)) ?? []
  );
}
