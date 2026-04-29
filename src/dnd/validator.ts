import type { DndSceneState, DndSessionRecord } from './types.js';

export type ValidationIssueCode =
  | 'raw_tags'
  | 'missing_actions'
  | 'generic_actions'
  | 'duplicate_actions'
  | 'invalid_roll'
  | 'continuity_jump'
  | 'world_drift';

export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  repairedContent: string;
  repairedChoices: string[];
  repairedRolls: string[];
  shouldRegenerate: boolean;
}

const GENERIC_CHOICES = new Set([
  'explore the area',
  'talk to someone',
  'use an ability',
  'look around',
  'keep moving',
  'stay alert',
]);

export function validateNarrativePacket(input: {
  session: DndSessionRecord;
  sceneState: DndSceneState | null;
  content: string;
  actionChoices: string[] | null;
  rollSuggestions: string[] | null;
}): ValidationResult {
  const issues: ValidationIssue[] = [];
  let repairedContent = stripLeakedTags(input.content);
  let repairedChoices = dedupeChoices(input.actionChoices ?? []);
  let repairedRolls = sanitizeRollSuggestions(input.rollSuggestions ?? []);

  if (repairedContent !== input.content) {
    issues.push({ code: 'raw_tags', message: 'Removed leaked raw/system tags from GM output.' });
  }

  if (repairedChoices.length === 0) {
    issues.push({ code: 'missing_actions', message: 'No usable action choices were provided.' });
    repairedChoices = buildSceneSpecificFallbackChoices(repairedContent);
  }

  if (hasGenericChoices(repairedChoices)) {
    issues.push({ code: 'generic_actions', message: 'Action choices were too generic and were replaced.' });
    repairedChoices = buildSceneSpecificFallbackChoices(repairedContent, repairedChoices);
  }

  if (new Set(repairedChoices.map(choice => choice.toLowerCase())).size !== repairedChoices.length) {
    issues.push({ code: 'duplicate_actions', message: 'Duplicate action choices detected.' });
    repairedChoices = dedupeChoices(repairedChoices);
  }

  if ((input.rollSuggestions ?? []).length > 0 && repairedRolls.length === 0) {
    issues.push({ code: 'invalid_roll', message: 'Roll suggestions were invalid and removed.' });
  }

  if (detectContinuityJump(input.sceneState, repairedContent)) {
    issues.push({ code: 'continuity_jump', message: 'Possible unexplained scene/location jump detected.' });
  }

  if (detectWorldDrift(input.session, repairedContent)) {
    issues.push({ code: 'world_drift', message: 'Narrative appears to drift outside the selected preconfigured world.' });
  }

  const severe = issues.some(issue => issue.code === 'continuity_jump' || issue.code === 'world_drift');
  return {
    ok: issues.length === 0,
    issues,
    repairedContent,
    repairedChoices,
    repairedRolls,
    shouldRegenerate: severe,
  };
}

export function repairNarrativePacket(input: {
  session: DndSessionRecord;
  sceneState: DndSceneState | null;
  content: string;
  actionChoices: string[] | null;
  rollSuggestions: string[] | null;
}): ValidationResult {
  return validateNarrativePacket(input);
}

export function sanitizeRollSuggestions(notations: string[]): string[] {
  const cleaned = notations
    .map(normalizeRollNotation)
    .filter((value): value is string => Boolean(value));
  return Array.from(new Set(cleaned)).slice(0, 5);
}

function normalizeRollNotation(value: string): string | null {
  const cleaned = value
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\/dnd\b/gi, ' ')
    .replace(/\bcheck\b/gi, ' ')
    .replace(/[^\ddkhladvdis+\-\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!cleaned) return null;
  const compact = cleaned.replace(/\s+/g, '');
  if (/^(\d*)d\d+(kh\d+|kl\d+)?([+-]\d+)?$/.test(compact)) return compact;
  if (/^d20(adv|dis)$/.test(compact)) return compact;
  return null;
}

function stripLeakedTags(content: string): string {
  return content
    .replace(/<(dnd_[^>]+|world_[^>]+|system_[^>]+|think|thought|reasoning|internal_monologue)[\s\S]*?(?:<\/[^>]+>|$)/gi, '')
    .replace(/<(?!\/?(?:npc|meta)\b)[^>]+>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function dedupeChoices(choices: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const choice of choices.map(choice => choice.trim()).filter(Boolean)) {
    const key = choice.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(choice);
  }
  return result.slice(0, 3);
}

function hasGenericChoices(choices: string[]): boolean {
  return choices.length < 3 || choices.some(choice => GENERIC_CHOICES.has(choice.trim().toLowerCase()));
}

function detectContinuityJump(sceneState: DndSceneState | null, content: string): boolean {
  if (!sceneState) return false;
  const lower = content.toLowerCase();
  const location = sceneState.location?.toLowerCase().trim();
  if (location && !lower.includes(location)) {
    const relocationCue = /\b(you are now in|you arrive at|you stand in|inside the|at the docks of|in the tavern of|the hall of)\b/i.test(content);
    if (relocationCue) {
      return true;
    }
  }

  if (sceneState.activeNpcs.length > 0) {
    const knownNpcMentioned = sceneState.activeNpcs.some(npc => lower.includes(npc.toLowerCase()));
    const hasFreshSpeaker = /\b[A-Z][a-z]+ says,/.test(content);
    if (!knownNpcMentioned && hasFreshSpeaker && sceneState.source !== 'opening') {
      return true;
    }
  }

  return false;
}

function detectWorldDrift(session: DndSessionRecord, content: string): boolean {
  if (!session.worldKey) return false;
  const lower = content.toLowerCase();
  if (/\b(new world|different continent|another realm|replacement setting)\b/.test(lower)) {
    return true;
  }
  if (session.worldKey === 'elyndor' && /\bfaerun|waterdeep|neverwinter|middle-earth|tamriel\b/i.test(content)) {
    return true;
  }
  return false;
}

function buildSceneSpecificFallbackChoices(content: string, existing: string[] = []): string[] {
  const seed = content.toLowerCase();
  const picks: string[] = [];

  if (/\bguard|captain|innkeeper|merchant|witness|npc|grogna|bram|harlen\b/.test(seed)) {
    picks.push('Question the nearest witness');
  }
  if (/\bdoor|chest|crate|ruin|altar|cellar|hall|barred|lock\b/.test(seed)) {
    picks.push('Inspect the most suspicious object');
  }
  if (/\bstorm|rain|fire|smoke|blood|shadow|growl|hiss|thud|thumping\b/.test(seed)) {
    picks.push('Investigate the immediate danger');
  }
  if (/\bguard|crowd|patron|soldier|watch\b/.test(seed)) {
    picks.push('Try to control the mood of the crowd');
  }

  for (const choice of existing) {
    if (!GENERIC_CHOICES.has(choice.toLowerCase()) && !picks.some(pick => pick.toLowerCase() === choice.toLowerCase())) {
      picks.push(choice);
    }
  }

  const defaults = [
    'Press for more information',
    'Search the scene for leverage',
    'Prepare for the next complication',
  ];

  for (const fallback of defaults) {
    if (picks.length >= 3) break;
    if (!picks.some(pick => pick.toLowerCase() === fallback.toLowerCase())) {
      picks.push(fallback);
    }
  }

  return picks.slice(0, 3);
}
