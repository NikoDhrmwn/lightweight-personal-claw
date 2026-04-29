/**
 * D&D 5e Game Mechanics — Dice, Death Saves, Resting, Inspiration, Conditions
 *
 * Code-enforced rule systems per the v2 architecture plan:
 * "Rule enforcement (dice, HP, XP, leveling, death saves) remains in code."
 */

import { abilityModifier } from './classes.js';
import type { DndCharacterSheet, DndAbilityScores, DndDeathSaveState } from './types.js';

// ─── Dice Rolling ───────────────────────────────────────────────────

export interface DiceRoll {
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
  advantage?: boolean;
  disadvantage?: boolean;
  dropped?: number[];
}

/**
 * Parse and roll dice notation: "2d6+3", "d20", "4d6kh3", "d20adv", "d20dis"
 */
export function rollDice(notation: string): DiceRoll {
  const cleaned = notation.toLowerCase().trim();

  // Handle advantage/disadvantage shorthand
  if (cleaned === 'd20adv' || cleaned === 'd20 adv') {
    return rollWithAdvantage(true);
  }
  if (cleaned === 'd20dis' || cleaned === 'd20 dis') {
    return rollWithAdvantage(false);
  }

  // Parse NdS+M or NdSkh/klK
  const match = cleaned.match(/^(\d*)d(\d+)(kh(\d+)|kl(\d+))?([+-]\d+)?$/);
  if (!match) {
    throw new Error(`Invalid dice notation: "${notation}". Use formats like 2d6+3, d20, 4d6kh3.`);
  }

  const count = match[1] ? parseInt(match[1]) : 1;
  const sides = parseInt(match[2]);
  const keepHighest = match[4] ? parseInt(match[4]) : undefined;
  const keepLowest = match[5] ? parseInt(match[5]) : undefined;
  const modifier = match[6] ? parseInt(match[6]) : 0;

  if (count < 1 || count > 100) throw new Error('Dice count must be 1-100.');
  if (sides < 2 || sides > 100) throw new Error('Dice sides must be 2-100.');

  const allRolls = Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);
  let keptRolls = [...allRolls];
  let dropped: number[] = [];

  if (keepHighest !== undefined) {
    const sorted = [...allRolls].sort((a, b) => b - a);
    keptRolls = sorted.slice(0, keepHighest);
    dropped = sorted.slice(keepHighest);
  } else if (keepLowest !== undefined) {
    const sorted = [...allRolls].sort((a, b) => a - b);
    keptRolls = sorted.slice(0, keepLowest);
    dropped = sorted.slice(keepLowest);
  }

  const total = keptRolls.reduce((sum, r) => sum + r, 0) + modifier;

  return {
    notation,
    rolls: allRolls,
    modifier,
    total,
    dropped: dropped.length > 0 ? dropped : undefined,
  };
}

function rollWithAdvantage(isAdvantage: boolean): DiceRoll {
  const r1 = Math.floor(Math.random() * 20) + 1;
  const r2 = Math.floor(Math.random() * 20) + 1;
  const kept = isAdvantage ? Math.max(r1, r2) : Math.min(r1, r2);
  return {
    notation: isAdvantage ? 'd20adv' : 'd20dis',
    rolls: [r1, r2],
    modifier: 0,
    total: kept,
    advantage: isAdvantage,
    disadvantage: !isAdvantage,
    dropped: [isAdvantage ? Math.min(r1, r2) : Math.max(r1, r2)],
  };
}

/**
 * Format a dice roll result for display.
 */
export function formatDiceRoll(roll: DiceRoll): string {
  const rollsStr = roll.rolls.map(r => `${r}`).join(', ');
  const droppedStr = roll.dropped?.length ? ` ~~${roll.dropped.join(', ')}~~` : '';
  const modStr = roll.modifier > 0 ? ` + ${roll.modifier}` : roll.modifier < 0 ? ` - ${Math.abs(roll.modifier)}` : '';
  return `\`${roll.notation}\` → [${rollsStr}]${droppedStr}${modStr} = **${roll.total}**`;
}

/**
 * Roll an ability check: d20 + ability modifier + proficiency (optional).
 */
export function rollAbilityCheck(
  score: number,
  proficiency = 0,
  exhaustionLevel = 0,
): DiceRoll {
  const mod = abilityModifier(score) + proficiency;
  // Exhaustion level 1+ applies disadvantage on ability checks
  if (exhaustionLevel >= 1) {
    const roll = rollWithAdvantage(false);
    roll.modifier = mod;
    roll.total = (roll.advantage ? Math.max(roll.rolls[0], roll.rolls[1]) : Math.min(roll.rolls[0], roll.rolls[1])) + mod;
    return roll;
  }
  const r = Math.floor(Math.random() * 20) + 1;
  return {
    notation: `d20+${mod}`,
    rolls: [r],
    modifier: mod,
    total: r + mod,
  };
}

// ─── Death Saves ────────────────────────────────────────────────────

/**
 * Roll a death saving throw for a character at 0 HP.
 */
export function rollDeathSave(current: DndDeathSaveState): { roll: number; result: DndDeathSaveState; event: string } {
  const roll = Math.floor(Math.random() * 20) + 1;
  const next = { ...current };
  let event: string;

  if (roll === 20) {
    // Nat 20: regain 1 HP, stabilize
    next.successes = 3;
    next.stable = true;
    event = '💫 **Natural 20!** You regain 1 HP and are stabilized!';
  } else if (roll === 1) {
    // Nat 1: two failures
    next.failures = Math.min(3, next.failures + 2);
    event = '💀 **Natural 1!** Two death save failures!';
  } else if (roll >= 10) {
    next.successes = Math.min(3, next.successes + 1);
    event = `✅ Death save success (${roll}). Successes: ${next.successes}/3`;
  } else {
    next.failures = Math.min(3, next.failures + 1);
    event = `❌ Death save failure (${roll}). Failures: ${next.failures}/3`;
  }

  if (next.successes >= 3) {
    next.stable = true;
    if (!event.includes('Natural 20')) {
      event += ' — You are **stable**!';
    }
  }

  if (next.failures >= 3) {
    next.dead = true;
    event += ' — **You have died.**';
  }

  return { roll, result: next, event };
}

/**
 * Handle taking damage at 0 HP (automatic death save failures).
 */
export function damageAtZeroHp(current: DndDeathSaveState, damage: number, wasCrit: boolean, maxHp?: number): DndDeathSaveState {
  const next = { ...current };
  if (typeof maxHp === 'number' && damage >= maxHp) {
    next.failures = 3;
    next.dead = true;
    next.stable = false;
    return next;
  }
  const failures = wasCrit ? 2 : 1;
  next.failures = Math.min(3, next.failures + failures);
  if (next.failures >= 3) {
    next.dead = true;
  }
  return next;
}

export function formatDeathSaves(state: DndDeathSaveState): string {
  const s = '✅'.repeat(state.successes) + '⬜'.repeat(3 - state.successes);
  const f = '❌'.repeat(state.failures) + '⬜'.repeat(3 - state.failures);
  return `Saves: ${s} | Fails: ${f}`;
}

export function createDeathSaveState(): DndDeathSaveState {
  return { successes: 0, failures: 0, stable: false, dead: false };
}

// ─── Resting ────────────────────────────────────────────────────────

export interface ShortRestResult {
  hitDiceUsed: number;
  hpRegained: number;
  newHp: number;
  newMaxHp: number;
}

export interface LongRestResult {
  hpRegained: number;
  newHp: number;
  conditionsCleared: string[];
  exhaustionReduced: boolean;
  newExhaustion: number;
}

/**
 * Perform a short rest: spend hit dice to regain HP.
 * hitDiceToSpend: number of hit dice the player chooses to spend.
 */
export function shortRest(sheet: DndCharacterSheet, hitDiceToSpend: number): ShortRestResult {
  const maxDice = Math.min(hitDiceToSpend, sheet.level); // max = level
  const conMod = abilityModifier(sheet.abilities.con);
  let hpRegained = 0;

  for (let i = 0; i < maxDice; i++) {
    const roll = Math.floor(Math.random() * sheet.hitDieMax) + 1;
    hpRegained += Math.max(1, roll + conMod);
  }

  const newHp = Math.min(sheet.maxHp, sheet.hp + hpRegained);

  return {
    hitDiceUsed: maxDice,
    hpRegained: newHp - sheet.hp,
    newHp,
    newMaxHp: sheet.maxHp,
  };
}

/**
 * Perform a long rest: full HP restore, reduce exhaustion, clear some conditions.
 */
export function longRest(sheet: DndCharacterSheet): LongRestResult {
  const conditionsCleared = sheet.conditions.filter(c =>
    !['petrified', 'cursed'].includes(c),
  );

  const exhaustionReduced = sheet.exhaustion > 0;
  const newExhaustion = Math.max(0, sheet.exhaustion - 1);

  return {
    hpRegained: sheet.maxHp - sheet.hp,
    newHp: sheet.maxHp,
    conditionsCleared,
    exhaustionReduced,
    newExhaustion,
  };
}

/**
 * Apply short rest results to a character sheet.
 */
export function applyShortRest(sheet: DndCharacterSheet, hitDiceToSpend: number): { sheet: DndCharacterSheet; result: ShortRestResult } {
  const result = shortRest(sheet, hitDiceToSpend);
  return {
    sheet: { ...sheet, hp: result.newHp },
    result,
  };
}

/**
 * Apply long rest results to a character sheet.
 */
export function applyLongRest(sheet: DndCharacterSheet): { sheet: DndCharacterSheet; result: LongRestResult } {
  const result = longRest(sheet);
  const remainingConditions = sheet.conditions.filter(c =>
    ['petrified', 'cursed'].includes(c),
  );
  return {
    sheet: {
      ...sheet,
      hp: result.newHp,
      conditions: remainingConditions,
      exhaustion: result.newExhaustion,
      deathSaves: createDeathSaveState(),
    },
    result,
  };
}

// ─── Inspiration ────────────────────────────────────────────────────

/**
 * Grant inspiration to a player. Returns whether it was newly granted.
 */
export function grantInspiration(sheet: DndCharacterSheet): { granted: boolean; wasAlreadyInspired: boolean } {
  if (sheet.inspiration) {
    return { granted: false, wasAlreadyInspired: true };
  }
  return { granted: true, wasAlreadyInspired: false };
}

/**
 * Spend inspiration: reroll a d20 and take the higher result.
 */
export function spendInspiration(originalRoll: number): { newRoll: number; kept: number; improved: boolean } {
  const newRoll = Math.floor(Math.random() * 20) + 1;
  const kept = Math.max(originalRoll, newRoll);
  return { newRoll, kept, improved: newRoll > originalRoll };
}

// ─── Conditions ─────────────────────────────────────────────────────

import { VALID_CONDITIONS } from './classes.js';

/**
 * Add a condition to a character sheet. Validates the condition name.
 */
export function addCondition(sheet: DndCharacterSheet, condition: string): { added: boolean; error?: string } {
  const normalized = condition.toLowerCase().trim();
  if (!VALID_CONDITIONS.has(normalized)) {
    return { added: false, error: `"${condition}" is not a valid D&D 5e condition. Valid: ${[...VALID_CONDITIONS].join(', ')}` };
  }
  if (sheet.conditions.includes(normalized)) {
    return { added: false, error: `Already has condition: ${normalized}` };
  }
  sheet.conditions.push(normalized);
  return { added: true };
}

/**
 * Remove a condition from a character sheet.
 */
export function removeCondition(sheet: DndCharacterSheet, condition: string): { removed: boolean; error?: string } {
  const normalized = condition.toLowerCase().trim();
  const index = sheet.conditions.indexOf(normalized);
  if (index === -1) {
    return { removed: false, error: `Does not have condition: ${normalized}` };
  }
  sheet.conditions.splice(index, 1);
  return { removed: true };
}

/**
 * Apply exhaustion level change. Returns clamped value (0-6).
 */
export function setExhaustion(sheet: DndCharacterSheet, level: number): { newLevel: number; died: boolean } {
  const clamped = Math.max(0, Math.min(6, level));
  return { newLevel: clamped, died: clamped >= 6 };
}
