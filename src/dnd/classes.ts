/**
 * D&D 5e Class Definitions & Stat Generation
 *
 * Provides pre-determined class data, random stat generation (4d6 drop lowest),
 * and starting character sheet computation for first-time onboarding.
 */

// ─── Class Definitions ──────────────────────────────────────────────

export interface DndClassDef {
  id: string;
  name: string;
  emoji: string;
  hitDie: number;
  primaryAbility: string;
  recommendedAbilityOrder: Array<keyof StatAllocation>;
  savingThrows: [string, string];
  description: string;
  startingAc: number;
  startingSpeed: number;
}

export const DND_CLASSES: DndClassDef[] = [
  {
    id: 'barbarian',
    name: 'Barbarian',
    emoji: '⚔️',
    hitDie: 12,
    primaryAbility: 'STR',
    recommendedAbilityOrder: ['str', 'con', 'dex', 'wis', 'int', 'cha'],
    savingThrows: ['STR', 'CON'],
    description: 'A fierce warrior of primal fury who channels rage in battle.',
    startingAc: 10,
    startingSpeed: 30,
  },
  {
    id: 'bard',
    name: 'Bard',
    emoji: '🎵',
    hitDie: 8,
    primaryAbility: 'CHA',
    recommendedAbilityOrder: ['cha', 'dex', 'con', 'wis', 'int', 'str'],
    savingThrows: ['DEX', 'CHA'],
    description: 'A magical performer whose words and music weave power.',
    startingAc: 11,
    startingSpeed: 30,
  },
  {
    id: 'cleric',
    name: 'Cleric',
    emoji: '✝️',
    hitDie: 8,
    primaryAbility: 'WIS',
    recommendedAbilityOrder: ['wis', 'con', 'str', 'dex', 'cha', 'int'],
    savingThrows: ['WIS', 'CHA'],
    description: 'A divine champion who channels the power of their deity.',
    startingAc: 16,
    startingSpeed: 30,
  },
  {
    id: 'druid',
    name: 'Druid',
    emoji: '🌿',
    hitDie: 8,
    primaryAbility: 'WIS',
    recommendedAbilityOrder: ['wis', 'con', 'dex', 'int', 'cha', 'str'],
    savingThrows: ['INT', 'WIS'],
    description: 'A guardian of nature who wields primal magic and wild shapes.',
    startingAc: 11,
    startingSpeed: 30,
  },
  {
    id: 'fighter',
    name: 'Fighter',
    emoji: '🛡️',
    hitDie: 10,
    primaryAbility: 'STR',
    recommendedAbilityOrder: ['str', 'con', 'dex', 'wis', 'cha', 'int'],
    savingThrows: ['STR', 'CON'],
    description: 'A master of combat techniques and martial weapons.',
    startingAc: 16,
    startingSpeed: 30,
  },
  {
    id: 'monk',
    name: 'Monk',
    emoji: '👊',
    hitDie: 8,
    primaryAbility: 'DEX',
    recommendedAbilityOrder: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
    savingThrows: ['STR', 'DEX'],
    description: 'A martial artist who harnesses the power of ki.',
    startingAc: 10,
    startingSpeed: 30,
  },
  {
    id: 'paladin',
    name: 'Paladin',
    emoji: '⚜️',
    hitDie: 10,
    primaryAbility: 'STR',
    recommendedAbilityOrder: ['str', 'cha', 'con', 'wis', 'dex', 'int'],
    savingThrows: ['WIS', 'CHA'],
    description: 'A holy warrior bound by an oath to fight for justice.',
    startingAc: 18,
    startingSpeed: 30,
  },
  {
    id: 'ranger',
    name: 'Ranger',
    emoji: '🏹',
    hitDie: 10,
    primaryAbility: 'DEX',
    recommendedAbilityOrder: ['dex', 'wis', 'con', 'str', 'int', 'cha'],
    savingThrows: ['STR', 'DEX'],
    description: 'A skilled hunter and tracker of the wilderness.',
    startingAc: 14,
    startingSpeed: 30,
  },
  {
    id: 'rogue',
    name: 'Rogue',
    emoji: '🗡️',
    hitDie: 8,
    primaryAbility: 'DEX',
    recommendedAbilityOrder: ['dex', 'con', 'wis', 'int', 'cha', 'str'],
    savingThrows: ['DEX', 'INT'],
    description: 'A cunning scoundrel who relies on stealth and trickery.',
    startingAc: 12,
    startingSpeed: 30,
  },
  {
    id: 'sorcerer',
    name: 'Sorcerer',
    emoji: '🔮',
    hitDie: 6,
    primaryAbility: 'CHA',
    recommendedAbilityOrder: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
    savingThrows: ['CON', 'CHA'],
    description: 'A spellcaster born with innate magical power.',
    startingAc: 10,
    startingSpeed: 30,
  },
  {
    id: 'warlock',
    name: 'Warlock',
    emoji: '👁️',
    hitDie: 8,
    primaryAbility: 'CHA',
    recommendedAbilityOrder: ['cha', 'con', 'dex', 'wis', 'int', 'str'],
    savingThrows: ['WIS', 'CHA'],
    description: 'A wielder of eldritch power drawn from an otherworldly pact.',
    startingAc: 12,
    startingSpeed: 30,
  },
  {
    id: 'wizard',
    name: 'Wizard',
    emoji: '📖',
    hitDie: 6,
    primaryAbility: 'INT',
    recommendedAbilityOrder: ['int', 'con', 'dex', 'wis', 'cha', 'str'],
    savingThrows: ['INT', 'WIS'],
    description: 'A scholarly mage who masters arcane spells through study.',
    startingAc: 10,
    startingSpeed: 30,
  },
];

export function getClassDef(classId: string): DndClassDef | undefined {
  return DND_CLASSES.find(c => c.id === classId.toLowerCase());
}

export function getClassById(classId: string): DndClassDef | null {
  return DND_CLASSES.find(c => c.id === classId.toLowerCase()) ?? null;
}

// ─── Stat Generation ────────────────────────────────────────────────

/**
 * Roll 4d6, drop the lowest die. Standard D&D 5e stat generation.
 */
function roll4d6DropLowest(): number {
  const rolls = Array.from({ length: 4 }, () => Math.floor(Math.random() * 6) + 1);
  rolls.sort((a, b) => a - b);
  return rolls[1] + rolls[2] + rolls[3];
}

/**
 * Generate a set of 6 ability scores using 4d6-drop-lowest method.
 * Returns sorted descending so players can see their best values first.
 */
export function rollStatArray(): number[] {
  const stats = Array.from({ length: 6 }, () => roll4d6DropLowest());
  return stats.sort((a, b) => b - a);
}

/**
 * Compute the ability modifier for a given ability score.
 */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Format an ability modifier as a signed string: "+2" or "-1"
 */
export function formatModifier(score: number): string {
  const mod = abilityModifier(score);
  return mod >= 0 ? `+${mod}` : `${mod}`;
}

// ─── Starting Character Sheet ───────────────────────────────────────

export interface StatAllocation {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

const ABILITY_LABELS: Record<keyof StatAllocation, string> = {
  str: 'STR',
  dex: 'DEX',
  con: 'CON',
  int: 'INT',
  wis: 'WIS',
  cha: 'CHA',
};

export function recommendStatAllocation(classDef: DndClassDef, rolledStats: number[]): StatAllocation {
  const sorted = [...rolledStats].sort((a, b) => b - a);
  const allocation: StatAllocation = { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
  classDef.recommendedAbilityOrder.forEach((ability, index) => {
    allocation[ability] = sorted[index] ?? 10;
  });
  return allocation;
}

export function formatRecommendedAbilityOrder(classDef: DndClassDef): string {
  return classDef.recommendedAbilityOrder.map(ability => ABILITY_LABELS[ability]).join(' > ');
}

/**
 * Build a starting character sheet from class + allocated stats.
 * HP = hit die max + CON modifier (level 1 rule).
 */
export function buildStartingSheet(classDef: DndClassDef, abilities: StatAllocation): {
  level: number;
  xp: number;
  gold: number;
  maxHp: number;
  hp: number;
  tempHp: number;
  ac: number;
  speed: number;
  proficiencyBonus: number;
  inspiration: boolean;
  passivePerception: number;
  abilities: StatAllocation;
  knownSkillIds: string[];
  equippedWeaponItemId: string | null;
  notes: string;
} {
  const conMod = abilityModifier(abilities.con);
  const wisMod = abilityModifier(abilities.wis);
  const dexMod = abilityModifier(abilities.dex);
  const startingHp = Math.max(1, classDef.hitDie + conMod);

  // Monk/Barbarian unarmored AC calculations
  let ac = classDef.startingAc;
  if (classDef.id === 'monk') {
    ac = 10 + dexMod + wisMod;
  } else if (classDef.id === 'barbarian') {
    ac = 10 + dexMod + abilityModifier(abilities.con);
  }

  return {
    level: 1,
    xp: 0,
    gold: 0,
    maxHp: startingHp,
    hp: startingHp,
    tempHp: 0,
    ac: Math.max(10, ac),
    speed: classDef.startingSpeed,
    proficiencyBonus: 2,
    inspiration: false,
    passivePerception: 10 + wisMod,
    abilities,
    knownSkillIds: [],
    equippedWeaponItemId: null,
    notes: `${classDef.name} — Saving Throws: ${classDef.savingThrows.join(', ')}`,
  };
}

// ─── Display Helpers ────────────────────────────────────────────────

/**
 * Format rolled stats for display: "16  14  13  12  10  8"
 */
export function formatRolledStats(stats: number[]): string {
  return stats.map(s => String(s).padStart(2)).join('  ');
}

/**
 * Format a class for a select menu label.
 */
export function formatClassOption(cls: DndClassDef): string {
  return `${cls.emoji} ${cls.name} — d${cls.hitDie} HD · ${cls.primaryAbility}`;
}

/**
 * HP bar using Unicode block characters.
 * Example: "██████░░░░ 60/100 HP"
 */
export function hpBar(current: number, maximum: number, width = 10): string {
  if (maximum <= 0) return `${'░'.repeat(width)} 0/0 HP ☠`;
  const ratio = Math.max(0, Math.min(1, current / maximum));
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const suffix = current <= 0 ? ' ☠' : ratio <= 0.25 ? ' ⚠' : '';
  return `${bar} ${current}/${maximum} HP${suffix}`;
}

/**
 * Condition icons mapping.
 */
export const CONDITION_ICONS: Record<string, string> = {
  poisoned: '[PSN]',
  blinded: '[BLD]',
  frightened: '[FRT]',
  unconscious: '[KO]',
  paralyzed: '[PAR]',
  stunned: '[STN]',
  grappled: '[GRP]',
  restrained: '[RST]',
  prone: '[PRN]',
  charmed: '[CHR]',
  invisible: '[INV]',
  exhaustion: '[EXH]',
  deafened: '[DEF]',
  incapacitated: '[INC]',
  petrified: '[PTR]',
};

/**
 * Valid D&D 5e conditions.
 */
export const VALID_CONDITIONS = new Set([
  'blinded', 'charmed', 'deafened', 'frightened', 'grappled',
  'incapacitated', 'invisible', 'paralyzed', 'petrified',
  'poisoned', 'prone', 'restrained', 'stunned', 'unconscious',
]);

/**
 * Format conditions for display.
 */
export function formatConditions(conditions: string[]): string {
  if (conditions.length === 0) return 'None';
  return conditions.map(c => CONDITION_ICONS[c] ?? `[${c.toUpperCase().slice(0, 3)}]`).join(' ');
}

/**
 * Exhaustion display with thin-line bar.
 */
export function exhaustionDisplay(level: number): string {
  const labels = ['', 'Fatigued', 'Slowed', 'Struggling', 'Critical', 'Near Death', 'Dead'];
  const bar = '━'.repeat(level) + '┄'.repeat(6 - level);
  return `Exhaustion \`${bar}\` ${level}/6 — ${labels[Math.min(level, 6)]}`;
}
