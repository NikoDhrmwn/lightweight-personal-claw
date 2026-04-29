import { abilityModifier, getClassById } from './classes.js';
import { rollDice, type DiceRoll } from './mechanics.js';
import type {
  DndAbilityKey,
  DndAbilityScores,
  DndActiveEffect,
  DndCharacterSheet,
  DndCombatEnemy,
  DndCombatLogEntry,
  DndCombatState,
  DndCombatant,
  DndInventoryItemRecord,
  DndPendingPlayerAction,
  DndPlayerRecord,
} from './types.js';

export interface DndItemRequirement {
  ability: DndAbilityKey;
  minimum: number;
}

export interface DndWeaponDefinition {
  id: string;
  name: string;
  aliases: string[];
  attackAbility: DndAbilityKey;
  damageAbility: DndAbilityKey;
  damageNotation: string;
  requirement?: DndItemRequirement | null;
  tags?: string[];
  notes?: string;
  weight?: number;
}

export interface DndConsumableDefinition {
  id: string;
  name: string;
  aliases: string[];
  effect: 'heal' | 'damage';
  notation: string;
  target: 'self' | 'ally' | 'enemy';
  notes?: string;
  weight?: number;
}

export interface DndSkillDefinition {
  id: string;
  name: string;
  aliases: string[];
  classIds: string[];
  kind: 'attack' | 'heal' | 'buff' | 'debuff' | 'crowd_control' | 'defense';
  attackAbility: DndAbilityKey;
  damageNotation?: string;
  healNotation?: string;
  usesPerCombat: number | null;
  requirement?: DndItemRequirement | null;
  appliesCondition?: string;
  notes?: string;
  resourceKind?: 'spell' | 'ability' | 'technique';
}

export interface DndInventoryMetadata {
  kind: 'weapon' | 'consumable' | 'gear';
  weaponId?: string;
  consumableId?: string;
  requirement?: DndItemRequirement | null;
  confiscated?: boolean;
  confiscatedReason?: string;
  storedAt?: string;
}

export interface StarterItemTemplate {
  name: string;
  category: string;
  notes: string | null;
  consumable: boolean;
  quantity: number;
  metadata: DndInventoryMetadata;
}

export interface StarterCombatKit {
  skillIds: string[];
  items: StarterItemTemplate[];
  equippedWeaponName: string | null;
}

export interface ParsedCombatAction {
  kind: 'skill' | 'item' | 'weapon' | 'skip' | 'improvise';
  skill?: DndSkillDefinition;
  item?: DndInventoryItemRecord;
  weapon?: DndInventoryItemRecord;
  targetSide: 'enemy' | 'ally' | 'self';
  targetName?: string | null;
  raw: string;
}

export interface CombatResolutionSummary {
  combat: DndCombatState;
  playerUpdates: Array<{ userId: string; sheet: DndCharacterSheet }>;
  inventoryUpdates: DndInventoryItemRecord[];
  removedInventoryItemIds: string[];
  messages: string[];
}

export interface RoundResolutionResult {
  combat: DndCombatState;
  playerUpdates: Array<{ userId: string; sheet: DndCharacterSheet }>;
  inventoryUpdates: DndInventoryItemRecord[];
  removedInventoryItemIds: string[];
  messages: string[];
  roundNarrative: string[];
}

const DEFAULT_ABILITIES: DndAbilityScores = {
  str: 10,
  dex: 10,
  con: 10,
  int: 10,
  wis: 10,
  cha: 10,
};

export const WEAPON_DEFINITIONS: Record<string, DndWeaponDefinition> = {
  greataxe: {
    id: 'greataxe',
    name: 'Greataxe',
    aliases: ['greataxe', 'axe'],
    attackAbility: 'str',
    damageAbility: 'str',
    damageNotation: '1d12',
    requirement: { ability: 'str', minimum: 14 },
    tags: ['heavy', 'melee'],
    weight: 7,
  },
  longsword: {
    id: 'longsword',
    name: 'Longsword',
    aliases: ['longsword', 'sword', 'blade'],
    attackAbility: 'str',
    damageAbility: 'str',
    damageNotation: '1d8',
    requirement: { ability: 'str', minimum: 11 },
    tags: ['melee'],
    weight: 3,
  },
  warhammer: {
    id: 'warhammer',
    name: 'Warhammer',
    aliases: ['warhammer', 'hammer'],
    attackAbility: 'str',
    damageAbility: 'str',
    damageNotation: '1d8',
    requirement: { ability: 'str', minimum: 12 },
    tags: ['melee'],
    weight: 2,
  },
  mace: {
    id: 'mace',
    name: 'Mace',
    aliases: ['mace'],
    attackAbility: 'str',
    damageAbility: 'str',
    damageNotation: '1d6',
    requirement: { ability: 'str', minimum: 10 },
    tags: ['melee'],
    weight: 4,
  },
  quarterstaff: {
    id: 'quarterstaff',
    name: 'Quarterstaff',
    aliases: ['quarterstaff', 'staff'],
    attackAbility: 'str',
    damageAbility: 'str',
    damageNotation: '1d6',
    requirement: { ability: 'str', minimum: 8 },
    tags: ['melee', 'focus'],
    weight: 4,
  },
  shortsword: {
    id: 'shortsword',
    name: 'Shortsword',
    aliases: ['shortsword', 'short sword'],
    attackAbility: 'dex',
    damageAbility: 'dex',
    damageNotation: '1d6',
    requirement: { ability: 'dex', minimum: 11 },
    tags: ['melee', 'finesse'],
    weight: 2,
  },
  dagger: {
    id: 'dagger',
    name: 'Dagger',
    aliases: ['dagger', 'knife'],
    attackAbility: 'dex',
    damageAbility: 'dex',
    damageNotation: '1d4',
    requirement: { ability: 'dex', minimum: 9 },
    tags: ['melee', 'thrown', 'finesse'],
    weight: 1,
  },
  shortbow: {
    id: 'shortbow',
    name: 'Shortbow',
    aliases: ['shortbow', 'bow'],
    attackAbility: 'dex',
    damageAbility: 'dex',
    damageNotation: '1d6',
    requirement: { ability: 'dex', minimum: 12 },
    tags: ['ranged'],
    weight: 2,
  },
  wand: {
    id: 'wand',
    name: 'Arcane Wand',
    aliases: ['wand', 'arcane wand'],
    attackAbility: 'int',
    damageAbility: 'int',
    damageNotation: '1d4',
    requirement: { ability: 'int', minimum: 12 },
    tags: ['focus', 'ranged'],
    weight: 1,
  },
  focus: {
    id: 'focus',
    name: 'Sacred Focus',
    aliases: ['focus', 'holy symbol', 'totem'],
    attackAbility: 'wis',
    damageAbility: 'wis',
    damageNotation: '1d4',
    requirement: { ability: 'wis', minimum: 12 },
    tags: ['focus'],
    weight: 1,
  },
  lute: {
    id: 'lute',
    name: 'Battle Lute',
    aliases: ['lute', 'battle lute'],
    attackAbility: 'cha',
    damageAbility: 'cha',
    damageNotation: '1d4',
    requirement: { ability: 'cha', minimum: 12 },
    tags: ['focus'],
    weight: 2,
  },
};

export const CONSUMABLE_DEFINITIONS: Record<string, DndConsumableDefinition> = {
  health_potion: {
    id: 'health_potion',
    name: 'Minor Health Potion',
    aliases: ['health potion', 'potion', 'minor health potion'],
    effect: 'heal',
    notation: '2d4+2',
    target: 'self',
    weight: 0.5,
  },
  fire_bomb: {
    id: 'fire_bomb',
    name: 'Fire Bomb',
    aliases: ['fire bomb', 'bomb'],
    effect: 'damage',
    notation: '2d6',
    target: 'enemy',
    weight: 1,
  },
};

export const SKILL_DEFINITIONS: Record<string, DndSkillDefinition> = {
  rage_strike: { id: 'rage_strike', name: 'Rage Strike', aliases: ['rage strike', 'rage'], classIds: ['barbarian'], kind: 'attack', attackAbility: 'str', damageNotation: '1d10', usesPerCombat: 2 },
  reckless_cleave: { id: 'reckless_cleave', name: 'Reckless Cleave', aliases: ['reckless cleave', 'cleave'], classIds: ['barbarian'], kind: 'attack', attackAbility: 'str', damageNotation: '2d6', usesPerCombat: 1 },
  cutting_word: { id: 'cutting_word', name: 'Cutting Word', aliases: ['cutting word', 'mockery'], classIds: ['bard'], kind: 'attack', attackAbility: 'cha', damageNotation: '1d8', usesPerCombat: 2, appliesCondition: 'frightened' },
  rallying_song: { id: 'rallying_song', name: 'Rallying Song', aliases: ['rallying song', 'song'], classIds: ['bard'], kind: 'heal', attackAbility: 'cha', healNotation: '1d8', usesPerCombat: 2 },
  sacred_flame: { id: 'sacred_flame', name: 'Sacred Flame', aliases: ['sacred flame'], classIds: ['cleric'], kind: 'attack', attackAbility: 'wis', damageNotation: '1d8', usesPerCombat: null, resourceKind: 'spell' },
  healing_word: { id: 'healing_word', name: 'Healing Word', aliases: ['healing word', 'heal'], classIds: ['cleric', 'paladin', 'bard'], kind: 'heal', attackAbility: 'wis', healNotation: '1d6', usesPerCombat: 2, resourceKind: 'spell' },
  thorn_whip: { id: 'thorn_whip', name: 'Thorn Whip', aliases: ['thorn whip'], classIds: ['druid'], kind: 'attack', attackAbility: 'wis', damageNotation: '1d8', usesPerCombat: null, resourceKind: 'spell' },
  moon_burst: { id: 'moon_burst', name: 'Moon Burst', aliases: ['moon burst', 'moonbeam'], classIds: ['druid'], kind: 'attack', attackAbility: 'wis', damageNotation: '2d4', usesPerCombat: 2, resourceKind: 'spell' },
  power_strike: { id: 'power_strike', name: 'Power Strike', aliases: ['power strike'], classIds: ['fighter'], kind: 'attack', attackAbility: 'str', damageNotation: '1d10', usesPerCombat: null },
  second_wind: { id: 'second_wind', name: 'Second Wind', aliases: ['second wind'], classIds: ['fighter'], kind: 'heal', attackAbility: 'con', healNotation: '1d10', usesPerCombat: 1 },
  flurry: { id: 'flurry', name: 'Flurry of Blows', aliases: ['flurry', 'flurry of blows'], classIds: ['monk'], kind: 'attack', attackAbility: 'dex', damageNotation: '2d4', usesPerCombat: 2 },
  centered_breath: { id: 'centered_breath', name: 'Centered Breath', aliases: ['centered breath', 'breath'], classIds: ['monk'], kind: 'heal', attackAbility: 'wis', healNotation: '1d6', usesPerCombat: 1 },
  divine_smite: { id: 'divine_smite', name: 'Divine Smite', aliases: ['divine smite', 'smite'], classIds: ['paladin'], kind: 'attack', attackAbility: 'str', damageNotation: '2d6', usesPerCombat: 2, resourceKind: 'spell' },
  aimed_shot: { id: 'aimed_shot', name: 'Aimed Shot', aliases: ['aimed shot'], classIds: ['ranger'], kind: 'attack', attackAbility: 'dex', damageNotation: '1d10', usesPerCombat: null },
  hunters_mark: { id: 'hunters_mark', name: 'Hunter Mark', aliases: ['hunter mark', 'hunters mark'], classIds: ['ranger'], kind: 'attack', attackAbility: 'wis', damageNotation: '1d8', usesPerCombat: 2, resourceKind: 'spell' },
  sneak_attack: { id: 'sneak_attack', name: 'Sneak Attack', aliases: ['sneak attack'], classIds: ['rogue'], kind: 'attack', attackAbility: 'dex', damageNotation: '2d6', usesPerCombat: 1 },
  evasive_step: { id: 'evasive_step', name: 'Evasive Step', aliases: ['evasive step', 'evade'], classIds: ['rogue'], kind: 'heal', attackAbility: 'dex', healNotation: '1d4', usesPerCombat: 1, notes: 'Regain footing and recover a little stamina.' },
  fireball: { id: 'fireball', name: 'Fireball', aliases: ['fireball'], classIds: ['sorcerer', 'wizard'], kind: 'attack', attackAbility: 'int', damageNotation: '2d8', usesPerCombat: 2, resourceKind: 'spell' },
  magic_missile: { id: 'magic_missile', name: 'Magic Missile', aliases: ['magic missile'], classIds: ['wizard'], kind: 'attack', attackAbility: 'int', damageNotation: '2d4', usesPerCombat: null, resourceKind: 'spell' },
  chaos_bolt: { id: 'chaos_bolt', name: 'Chaos Bolt', aliases: ['chaos bolt'], classIds: ['sorcerer'], kind: 'attack', attackAbility: 'cha', damageNotation: '2d6', usesPerCombat: null, resourceKind: 'spell' },
  eldritch_blast: { id: 'eldritch_blast', name: 'Eldritch Blast', aliases: ['eldritch blast'], classIds: ['warlock'], kind: 'attack', attackAbility: 'cha', damageNotation: '1d10', usesPerCombat: null, resourceKind: 'spell' },
  dark_pact: { id: 'dark_pact', name: 'Dark Pact', aliases: ['dark pact'], classIds: ['warlock'], kind: 'heal', attackAbility: 'cha', healNotation: '1d8', usesPerCombat: 1, resourceKind: 'spell' },
  // New Skills for Phase 3
  shield_of_faith: { id: 'shield_of_faith', name: 'Shield of Faith', aliases: ['shield of faith', 'shield'], classIds: ['cleric', 'paladin'], kind: 'buff', attackAbility: 'wis', usesPerCombat: 1, resourceKind: 'spell', notes: '+2 AC for 3 rounds' },
  bless: { id: 'bless', name: 'Bless', aliases: ['bless'], classIds: ['cleric', 'paladin'], kind: 'buff', attackAbility: 'cha', usesPerCombat: 1, resourceKind: 'spell', notes: '+2 to attack rolls for 3 rounds' },
  bane: { id: 'bane', name: 'Bane', aliases: ['bane'], classIds: ['cleric', 'bard'], kind: 'debuff', attackAbility: 'cha', usesPerCombat: 1, resourceKind: 'spell', notes: '-2 to enemy attack rolls for 3 rounds' },
  hex: { id: 'hex', name: 'Hex', aliases: ['hex'], classIds: ['warlock'], kind: 'debuff', attackAbility: 'cha', usesPerCombat: 1, resourceKind: 'spell', notes: 'Extra damage on hit' },
  sleep: { id: 'sleep', name: 'Sleep', aliases: ['sleep'], classIds: ['wizard', 'sorcerer', 'bard'], kind: 'crowd_control', attackAbility: 'int', usesPerCombat: 1, resourceKind: 'spell', notes: 'Target becomes stunned for 1 round' },
  hold_person: { id: 'hold_person', name: 'Hold Person', aliases: ['hold person', 'hold'], classIds: ['cleric', 'druid', 'wizard', 'warlock'], kind: 'crowd_control', attackAbility: 'wis', usesPerCombat: 1, resourceKind: 'spell', notes: 'Target becomes stunned for 2 rounds' },
  grease: { id: 'grease', name: 'Grease', aliases: ['grease'], classIds: ['wizard', 'sorcerer'], kind: 'crowd_control', attackAbility: 'int', usesPerCombat: 1, resourceKind: 'spell', notes: 'Target becomes prone' },
  dodge: { id: 'dodge', name: 'Dodge', aliases: ['dodge'], classIds: ['fighter', 'monk', 'rogue'], kind: 'defense', attackAbility: 'dex', usesPerCombat: null, notes: 'Disadvantage on attacks against you for 1 round' },
  parry: { id: 'parry', name: 'Parry', aliases: ['parry'], classIds: ['fighter', 'rogue'], kind: 'defense', attackAbility: 'dex', usesPerCombat: 1, notes: 'Reduce damage from the next hit' },
};

const CLASS_KITS: Record<string, StarterCombatKit> = {
  barbarian: createKit(['rage_strike', 'reckless_cleave'], [weaponItem('greataxe'), potionItem()], 'Greataxe'),
  bard: createKit(['cutting_word', 'rallying_song'], [weaponItem('lute'), weaponItem('dagger'), potionItem()], 'Battle Lute'),
  cleric: createKit(['sacred_flame', 'healing_word'], [weaponItem('focus'), weaponItem('mace'), potionItem()], 'Sacred Focus'),
  druid: createKit(['thorn_whip', 'moon_burst'], [weaponItem('quarterstaff'), potionItem()], 'Quarterstaff'),
  fighter: createKit(['power_strike', 'second_wind'], [weaponItem('longsword'), weaponItem('dagger'), potionItem()], 'Longsword'),
  monk: createKit(['flurry', 'centered_breath'], [weaponItem('quarterstaff'), potionItem()], 'Quarterstaff'),
  paladin: createKit(['divine_smite', 'healing_word'], [weaponItem('warhammer'), potionItem()], 'Warhammer'),
  ranger: createKit(['aimed_shot', 'hunters_mark'], [weaponItem('shortbow'), weaponItem('shortsword'), potionItem()], 'Shortbow'),
  rogue: createKit(['sneak_attack', 'evasive_step'], [weaponItem('shortsword'), weaponItem('dagger'), potionItem(), bombItem()], 'Shortsword'),
  sorcerer: createKit(['fireball', 'chaos_bolt'], [weaponItem('wand'), potionItem()], 'Arcane Wand'),
  warlock: createKit(['eldritch_blast', 'dark_pact'], [weaponItem('wand'), potionItem()], 'Arcane Wand'),
  wizard: createKit(['fireball', 'magic_missile'], [weaponItem('wand'), potionItem()], 'Arcane Wand'),
};

export function getWeaponDefinition(id: string): DndWeaponDefinition | null {
  return WEAPON_DEFINITIONS[id] ?? null;
}

export function getSkillDefinition(id: string): DndSkillDefinition | null {
  return SKILL_DEFINITIONS[id] ?? null;
}

export function getCombatKitForClass(classId: string | null | undefined): StarterCombatKit | null {
  if (!classId) return null;
  return CLASS_KITS[classId.toLowerCase()] ?? null;
}

export function parseInventoryMetadata(item: DndInventoryItemRecord): DndInventoryMetadata | null {
  if (!item.metadataJson) return null;
  try {
    return JSON.parse(item.metadataJson) as DndInventoryMetadata;
  } catch {
    return null;
  }
}

export function createInventoryMetadataJson(metadata: DndInventoryMetadata): string {
  return JSON.stringify(metadata);
}

export function isAccessibleInventoryItem(item: DndInventoryItemRecord): boolean {
  return !parseInventoryMetadata(item)?.confiscated;
}

export function parseEnemyDefinitions(input: string | null | undefined, playerCount: number): DndCombatEnemy[] {
  const trimmed = input?.trim();
  if (!trimmed) {
    return Array.from({ length: Math.max(1, Math.ceil(playerCount / 2)) }, (_, index) =>
      buildEnemy(`raider_${index + 1}`, `Raider ${index + 1}`, 20, 12, 4, '1d8+2', { str: 12, dex: 12, con: 12, int: 9, wis: 10, cha: 9 }));
  }

  return trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name, hpRaw, acRaw, attackBonusRaw, damageNotationRaw, dexRaw, strRaw, conRaw, wisRaw, intRaw, chaRaw] = line.split('|').map(part => part.trim());
      return buildEnemy(
        `enemy_${index + 1}`,
        name || `Enemy ${index + 1}`,
        clampNumber(hpRaw, 18, 1, 999),
        clampNumber(acRaw, 12, 5, 30),
        clampNumber(attackBonusRaw, 3, 0, 20),
        damageNotationRaw || '1d6+1',
        {
          dex: clampNumber(dexRaw, 12, 1, 30),
          str: clampNumber(strRaw, 10, 1, 30),
          con: clampNumber(conRaw, 10, 1, 30),
          wis: clampNumber(wisRaw, 10, 1, 30),
          int: clampNumber(intRaw, 10, 1, 30),
          cha: clampNumber(chaRaw, 10, 1, 30),
        },
      );
    });
}

export function createCombatState(players: DndPlayerRecord[], enemies: DndCombatEnemy[]): DndCombatState {
  const order: DndCombatant[] = [
    ...players.map(player => ({
      id: `player:${player.userId}`,
      side: 'player' as const,
      userId: player.userId,
      characterName: player.characterName,
      initiative: rollInitiativeFromPlayer(player),
    })),
    ...enemies.map(enemy => ({
      id: `enemy:${enemy.id}`,
      side: 'enemy' as const,
      userId: enemy.id,
      characterName: enemy.name,
      initiative: rollInitiativeFromAbilities(enemy.abilities),
    })),
  ].sort((a, b) => b.initiative - a.initiative || a.characterName.localeCompare(b.characterName));

  return {
    active: true,
    round: 1,
    turnIndex: 0,
    order,
    enemies,
    log: [],
    skillUsesByActor: {},
    victory: null,
    lastActionMessageChannelId: null,
    lastActionMessageId: null,
    pendingPlayerActions: {},
    activeEffects: [],
  };
}

export function getStarterWeaponIdForSheet(sheet: DndCharacterSheet): string | null {
  for (const weapon of Object.values(WEAPON_DEFINITIONS)) {
    if (!weapon.requirement) continue;
    if (sheet.abilities[weapon.requirement.ability] >= weapon.requirement.minimum) {
      return weapon.id;
    }
  }
  return 'dagger';
}

export function detectAction(
  rawAction: string,
  actor: DndPlayerRecord,
  sheet: DndCharacterSheet,
  inventory: DndInventoryItemRecord[],
  combat: DndCombatState,
  players: DndPlayerRecord[],
): ParsedCombatAction {
  const lowered = rawAction.toLowerCase().trim();
  if (!lowered || lowered === 'skip' || lowered === 'pass') {
    return { kind: 'skip', targetSide: 'self', raw: rawAction };
  }

  const skill = (sheet.knownSkillIds ?? [])
    .map(id => getSkillDefinition(id))
    .filter((value): value is DndSkillDefinition => Boolean(value))
    .find(def => def.aliases.some(alias => lowered.includes(alias)));
  if (skill) {
    return {
      kind: 'skill',
      skill,
      targetSide: skill.kind === 'heal' ? inferAllyTarget(lowered, actor, players) : 'enemy',
      targetName: skill.kind === 'heal' ? extractNamedTarget(lowered, players.map(p => p.characterName)) : extractNamedTarget(lowered, combat.enemies.map(e => e.name)),
      raw: rawAction,
    };
  }

  const accessibleInventory = inventory.filter(isAccessibleInventoryItem);

  const item = accessibleInventory.find(entry => {
    const metadata = parseInventoryMetadata(entry);
    const aliases = metadata?.consumableId ? (CONSUMABLE_DEFINITIONS[metadata.consumableId]?.aliases ?? []) : [entry.name.toLowerCase()];
    return aliases.some(alias => lowered.includes(alias));
  });
  if (item) {
    const metadata = parseInventoryMetadata(item);
    const consumable = metadata?.consumableId ? CONSUMABLE_DEFINITIONS[metadata.consumableId] : null;
    return {
      kind: 'item',
      item,
      targetSide: consumable?.target === 'enemy' ? 'enemy' : consumable?.target === 'ally' ? 'ally' : 'self',
      targetName: consumable?.target === 'enemy'
        ? extractNamedTarget(lowered, combat.enemies.map(e => e.name))
        : extractNamedTarget(lowered, players.map(p => p.characterName)),
      raw: rawAction,
    };
  }

  const explicitWeapon = accessibleInventory.find(entry => {
    const metadata = parseInventoryMetadata(entry);
    if (!metadata?.weaponId) return false;
    const weapon = WEAPON_DEFINITIONS[metadata.weaponId];
    return weapon.aliases.some(alias => lowered.includes(alias));
  });
  const equipped = explicitWeapon
    ?? accessibleInventory.find(entry => entry.id === sheet.equippedWeaponItemId)
    ?? accessibleInventory.find(entry => parseInventoryMetadata(entry)?.weaponId);
  if (equipped) {
    return {
      kind: 'weapon',
      weapon: equipped,
      targetSide: 'enemy',
      targetName: extractNamedTarget(lowered, combat.enemies.map(e => e.name)),
      raw: rawAction,
    };
  }

  // Fallback: treat as improvised action
  return {
    kind: 'improvise',
    targetSide: 'enemy',
    targetName: extractNamedTarget(lowered, combat.enemies.map(e => e.name)),
    raw: rawAction,
  };
}

export function resolvePlayerAction(args: {
  combat: DndCombatState;
  actor: DndPlayerRecord;
  actorSheet: DndCharacterSheet;
  action: ParsedCombatAction;
  players: DndPlayerRecord[];
  playerSheets: Map<string, DndCharacterSheet>;
  inventory: DndInventoryItemRecord[];
}): CombatResolutionSummary {
  const messages: string[] = [];
  const inventoryUpdates: DndInventoryItemRecord[] = [];
  const removedInventoryItemIds: string[] = [];
  const playerUpdates = new Map<string, DndCharacterSheet>();
  const combat = cloneCombatState(args.combat);

  if (args.action.kind === 'skip') {
    messages.push(`${args.actor.characterName} holds position and gives up the turn.`);
    appendCombatLog(combat, args.actor.characterName, messages[0]);
    return {
      combat,
      playerUpdates: [],
      inventoryUpdates,
      removedInventoryItemIds,
      messages,
    };
  }

  if (args.action.kind === 'skill' && args.action.skill) {
    const skill = args.action.skill;
    ensureSkillOwnership(args.actorSheet, skill.id);
    const usedCount = combat.skillUsesByActor[args.actor.userId]?.[skill.id] ?? 0;
    if (skill.usesPerCombat !== null && usedCount >= skill.usesPerCombat) {
      throw new Error(`${args.actor.characterName} has already used ${skill.name} ${skill.usesPerCombat} time(s) this combat.`);
    }

    if (skill.kind === 'heal') {
      const targetPlayer = resolveAllyTarget(args.action.targetName, args.players, args.actor.userId);
      const targetSheet = cloneSheet(args.playerSheets.get(targetPlayer.userId) ?? playerUpdates.get(targetPlayer.userId));
      const healRoll = rollDice(skill.healNotation ?? '1d4');
      const healed = scaleCombatNumber(healRoll.total, abilityModifier(args.actorSheet.abilities[skill.attackAbility]));
      targetSheet.hp = Math.min(targetSheet.maxHp, targetSheet.hp + healed);
      playerUpdates.set(targetPlayer.userId, targetSheet);
      messages.push(`${args.actor.characterName} uses ${skill.name} on ${targetPlayer.characterName}, restoring ${healed} HP.`);
    } else if (skill.kind === 'buff') {
      const targetPlayer = resolveAllyTarget(args.action.targetName, args.players, args.actor.userId);
      const effect = createActiveEffectFromSkill(skill, targetPlayer.userId, undefined);
      combat.activeEffects.push(effect);
      messages.push(`${args.actor.characterName} casts ${skill.name} on ${targetPlayer.characterName}: ${skill.notes ?? 'Applied buff'}.`);
    } else if (skill.kind === 'debuff' || skill.kind === 'crowd_control') {
      const enemy = resolveEnemyTarget(combat, args.action.targetName);
      const effect = createActiveEffectFromSkill(skill, undefined, enemy.id);
      combat.activeEffects.push(effect);
      messages.push(`${args.actor.characterName} uses ${skill.name} on ${enemy.name}: ${skill.notes ?? 'Applied condition'}.`);
    } else if (skill.kind === 'defense') {
      const effect = createActiveEffectFromSkill(skill, args.actor.userId, undefined);
      combat.activeEffects.push(effect);
      messages.push(`${args.actor.characterName} adopts a defensive stance with ${skill.name}: ${skill.notes ?? 'Gained defense'}.`);
    } else {
      const enemy = resolveEnemyTarget(combat, args.action.targetName);
      const attackRoll = performAttackRoll(combat, args.actor.userId, skill.attackAbility);
      if (attackRoll.total >= enemy.ac) {
        const damage = scaleCombatNumber(rollDice(skill.damageNotation ?? '1d6').total, abilityModifier(args.actorSheet.abilities[skill.attackAbility]));
        enemy.hp = Math.max(0, enemy.hp - damage);
        if (skill.appliesCondition && enemy.hp > 0) {
          enemy.conditions = Array.from(new Set([...enemy.conditions, skill.appliesCondition]));
        }
        messages.push(`${args.actor.characterName} hits ${enemy.name} with ${skill.name} (${attackRoll.total} vs AC ${enemy.ac}) for ${damage} damage.`);
        if (enemy.hp <= 0) {
          messages.push(`${enemy.name} is defeated.`);
        }
      } else {
        messages.push(`${args.actor.characterName} uses ${skill.name}, but misses ${enemy.name} (${attackRoll.total} vs AC ${enemy.ac}).`);
      }
    }

    combat.skillUsesByActor[args.actor.userId] ??= {};
    combat.skillUsesByActor[args.actor.userId][skill.id] = usedCount + 1;
    messages.forEach(message => appendCombatLog(combat, args.actor.characterName, message));
    return {
      combat,
      playerUpdates: Array.from(playerUpdates.entries()).map(([userId, sheet]) => ({ userId, sheet })),
      inventoryUpdates,
      removedInventoryItemIds,
      messages,
    };
  }

  if (args.action.kind === 'item' && args.action.item) {
    const metadata = parseInventoryMetadata(args.action.item);
    if (!metadata?.consumableId) {
      throw new Error(`${args.action.item.name} is not a usable combat consumable.`);
    }
    const consumable = CONSUMABLE_DEFINITIONS[metadata.consumableId];
    if (!consumable) {
      throw new Error(`${args.action.item.name} has no combat behavior defined.`);
    }

    if (consumable.effect === 'heal') {
      const targetPlayer = consumable.target === 'self'
        ? args.players.find(player => player.userId === args.actor.userId)!
        : resolveAllyTarget(args.action.targetName, args.players, args.actor.userId);
      const targetSheet = cloneSheet(args.playerSheets.get(targetPlayer.userId) ?? playerUpdates.get(targetPlayer.userId));
      const healed = rollDice(consumable.notation).total;
      targetSheet.hp = Math.min(targetSheet.maxHp, targetSheet.hp + healed);
      playerUpdates.set(targetPlayer.userId, targetSheet);
      messages.push(`${args.actor.characterName} uses ${consumable.name} and restores ${healed} HP to ${targetPlayer.characterName}.`);
    } else {
      const enemy = resolveEnemyTarget(combat, args.action.targetName);
      const damage = rollDice(consumable.notation).total;
      enemy.hp = Math.max(0, enemy.hp - damage);
      messages.push(`${args.actor.characterName} uses ${consumable.name} on ${enemy.name} for ${damage} damage.`);
      if (enemy.hp <= 0) {
        messages.push(`${enemy.name} is defeated.`);
      }
    }

    if (args.action.item.quantity <= 1) {
      removedInventoryItemIds.push(args.action.item.id);
    } else {
      inventoryUpdates.push({
        ...args.action.item,
        quantity: args.action.item.quantity - 1,
        updatedAt: Date.now(),
      });
    }
    messages.forEach(message => appendCombatLog(combat, args.actor.characterName, message));
    return {
      combat,
      playerUpdates: Array.from(playerUpdates.entries()).map(([userId, sheet]) => ({ userId, sheet })),
      inventoryUpdates,
      removedInventoryItemIds,
      messages,
    };
  }

  if (args.action.kind === 'weapon' && args.action.weapon) {
    const metadata = parseInventoryMetadata(args.action.weapon);
    if (!metadata?.weaponId) {
      throw new Error(`${args.action.weapon.name} is not a usable weapon.`);
    }
    const weapon = getWeaponDefinition(metadata.weaponId);
    if (!weapon) {
      throw new Error(`Weapon definition missing for ${args.action.weapon.name}.`);
    }
    if (weapon.requirement && args.actorSheet.abilities[weapon.requirement.ability] < weapon.requirement.minimum) {
      throw new Error(`${weapon.name} requires ${weapon.requirement.ability.toUpperCase()} ${weapon.requirement.minimum}.`);
    }

    const enemy = resolveEnemyTarget(combat, args.action.targetName);
    const attackRoll = performAttackRoll(combat, args.actor.userId, weapon.attackAbility);
    if (attackRoll.total >= enemy.ac) {
      const baseDamage = rollDice(weapon.damageNotation).total + Math.max(0, abilityModifier(args.actorSheet.abilities[weapon.damageAbility]));
      const damage = scaleCombatNumber(baseDamage, abilityModifier(args.actorSheet.abilities[weapon.damageAbility]));
      enemy.hp = Math.max(0, enemy.hp - damage);
      messages.push(`${args.actor.characterName} strikes ${enemy.name} with ${weapon.name} (${attackRoll.total} vs AC ${enemy.ac}) for ${damage} damage.`);
      if (enemy.hp <= 0) {
        messages.push(`${enemy.name} is defeated.`);
      }
    } else {
      messages.push(`${args.actor.characterName} attacks with ${weapon.name}, but misses ${enemy.name} (${attackRoll.total} vs AC ${enemy.ac}).`);
    }
    messages.forEach(message => appendCombatLog(combat, args.actor.characterName, message));
    return {
      combat,
      playerUpdates: [],
      inventoryUpdates,
      removedInventoryItemIds,
      messages,
    };
  }

  if (args.action.kind === 'improvise') {
    const ability = inferImproviseAbility(args.action.raw, args.actorSheet);
    const roll = performAttackRoll(combat, args.actor.userId, ability);
    const enemy = resolveEnemyTarget(combat, args.action.targetName);

    if (roll.total >= 15) {
      // Full effect: +2 AC or disadvantage on one enemy
      combat.activeEffects.push({
        id: `improvise-${args.actor.userId}-${Date.now()}`,
        name: `Improvised Maneuver (${args.actor.characterName})`,
        targetUserId: args.actor.userId,
        durationRounds: 1,
        effect: 'ac_bonus',
        value: 2,
      });
      messages.push(`${args.actor.characterName} pulls off a brilliant improvised maneuver (${roll.total})! They gain +2 AC for the round.`);
    } else if (roll.total >= 10) {
      // Partial effect: +1 AC
      combat.activeEffects.push({
        id: `improvise-partial-${args.actor.userId}-${Date.now()}`,
        name: `Partial Maneuver (${args.actor.characterName})`,
        targetUserId: args.actor.userId,
        durationRounds: 1,
        effect: 'ac_bonus',
        value: 1,
      });
      messages.push(`${args.actor.characterName} attempts something clever (${roll.total}), gaining +1 AC from their focused defense.`);
    } else {
      messages.push(`${args.actor.characterName}'s improvised attempt (${roll.total}) falls flat, leaving them exposed.`);
    }
    messages.forEach(message => appendCombatLog(combat, args.actor.characterName, message));
    return {
      combat,
      playerUpdates: [],
      inventoryUpdates,
      removedInventoryItemIds,
      messages,
    };
  }

  throw new Error(`Unsupported combat action: ${args.action.kind}`);
}

export function resolveCombatRound(args: {
  combat: DndCombatState;
  players: DndPlayerRecord[];
  playerSheets: Map<string, DndCharacterSheet>;
  getInventory: (userId: string) => DndInventoryItemRecord[];
}): RoundResolutionResult {
  const combat = cloneCombatState(args.combat);
  const messages: string[] = [];
  const roundNarrative: string[] = [];
  const inventoryUpdates: DndInventoryItemRecord[] = [];
  const removedInventoryItemIds: string[] = [];
  const playerUpdates = new Map<string, DndCharacterSheet>();

  const livingPlayers = args.players.filter(p => {
    const sheet = args.playerSheets.get(p.userId);
    return sheet && sheet.hp > 0 && p.status !== 'left';
  });

  // Resolve player actions in initiative order
  for (const combatant of combat.order) {
    if (combatant.side !== 'player') continue;
    const pending = combat.pendingPlayerActions[combatant.userId];
    if (!pending) continue;

    const actor = args.players.find(p => p.userId === combatant.userId);
    if (!actor) continue;
    const actorSheet = cloneSheet(playerUpdates.get(actor.userId) ?? args.playerSheets.get(actor.userId));
    if (!actorSheet || actorSheet.hp <= 0) continue;

    const inventory = args.getInventory(actor.userId);
    let action: ParsedCombatAction;
    if (pending.actionJson) {
      try {
        action = JSON.parse(pending.actionJson);
      } catch {
        action = detectAction(pending.actionText, actor, actorSheet, inventory, combat, args.players);
      }
    } else {
      action = detectAction(pending.actionText, actor, actorSheet, inventory, combat, args.players);
    }

    const result = resolvePlayerAction({
      combat,
      actor,
      actorSheet,
      action,
      players: args.players,
      playerSheets: new Map([...args.playerSheets, ...playerUpdates]),
      inventory,
    });

    for (const update of result.playerUpdates) {
      playerUpdates.set(update.userId, update.sheet);
    }
    inventoryUpdates.push(...result.inventoryUpdates);
    removedInventoryItemIds.push(...result.removedInventoryItemIds);
    messages.push(...result.messages);

    // Build narrative snippet for this action
    const narrativeSnippet = buildActionNarrativeSnippet(actor.characterName, pending.actionText, action, result.messages);
    roundNarrative.push(narrativeSnippet);
  }

  // Clear pending actions for the round
  combat.pendingPlayerActions = {};

  // Run enemy turns
  const enemyResult = runEnemyTurns({
    combat,
    players: args.players,
    playerSheets: new Map([...args.playerSheets, ...playerUpdates]),
  });

  for (const update of enemyResult.playerUpdates) {
    playerUpdates.set(update.userId, update.sheet);
  }
  messages.push(...enemyResult.messages);

  // Advance to next round
  advanceTurnIndex(enemyResult.combat, args.players, new Map([...args.playerSheets, ...playerUpdates]));

  // Decrement active effects
  enemyResult.combat.activeEffects = enemyResult.combat.activeEffects
    .map(effect => ({ ...effect, durationRounds: effect.durationRounds - 1 }))
    .filter(effect => effect.durationRounds > 0);

  return {
    combat: enemyResult.combat,
    playerUpdates: Array.from(playerUpdates.entries()).map(([userId, sheet]) => ({ userId, sheet })),
    inventoryUpdates,
    removedInventoryItemIds,
    messages,
    roundNarrative,
  };
}

function buildActionNarrativeSnippet(actorName: string, rawText: string, action: ParsedCombatAction, resultMessages: string[]): string {
  if (action.kind === 'improvise') {
    return `**${actorName}** attempts something unconventional: "_${rawText}_"`;
  }
  if (action.kind === 'skill' && action.skill) {
    return `**${actorName}** uses **${action.skill.name}**`;
  }
  if (action.kind === 'weapon' && action.weapon) {
    return `**${actorName}** attacks with **${action.weapon.name}**`;
  }
  if (action.kind === 'item' && action.item) {
    return `**${actorName}** uses **${action.item.name}**`;
  }
  return `**${actorName}** acts`;
}

function inferImproviseAbility(rawText: string, sheet: DndCharacterSheet): DndAbilityKey {
  const lowered = rawText.toLowerCase();
  const abilityHints: Array<{ keywords: string[]; ability: DndAbilityKey }> = [
    { keywords: ['block', 'dodge', 'parry', 'evade', 'duck', 'roll'], ability: 'dex' },
    { keywords: ['staff', 'wand', 'spell', 'magic', 'arcane', 'blast', 'fireball'], ability: 'int' },
    { keywords: ['focus', 'holy', 'prayer', 'sacred', 'divine', 'totem'], ability: 'wis' },
    { keywords: ['taunt', 'mock', 'insult', 'seduce', 'charm', 'intimidate'], ability: 'cha' },
    { keywords: ['shove', 'grapple', 'break', 'smash', 'charge', 'tackle'], ability: 'str' },
    { keywords: ['endure', 'resist', 'tough', 'brace'], ability: 'con' },
  ];

  for (const hint of abilityHints) {
    if (hint.keywords.some(kw => lowered.includes(kw))) {
      return hint.ability;
    }
  }

  // Default to the character's highest ability
  const entries = Object.entries(sheet.abilities) as [DndAbilityKey, number][];
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[0] ?? 'str';
}

export function runEnemyTurns(args: {
  combat: DndCombatState;
  players: DndPlayerRecord[];
  playerSheets: Map<string, DndCharacterSheet>;
}): CombatResolutionSummary {
  const combat = cloneCombatState(args.combat);
  const messages: string[] = [];
  const playerUpdates = new Map<string, DndCharacterSheet>();

  while (combat.active) {
    const current = combat.order[combat.turnIndex];
    if (!current || current.side !== 'enemy') break;
    const enemy = combat.enemies.find(entry => entry.id === current.userId);
    if (!enemy || enemy.hp <= 0) {
      advanceTurnIndex(combat, args.players, args.playerSheets);
      continue;
    }

    const livingPlayers = args.players
      .map(player => ({ player, sheet: cloneSheet(playerUpdates.get(player.userId) ?? args.playerSheets.get(player.userId)) }))
      .filter(entry => entry.sheet.hp > 0 && entry.player.status !== 'left');
    if (livingPlayers.length === 0) {
      combat.active = false;
      combat.victory = 'enemies';
      break;
    }

    if (enemy.conditions.includes('stunned')) {
      enemy.conditions = enemy.conditions.filter(condition => condition !== 'stunned');
      const summary = `${enemy.name} is stunned and loses the turn.`;
      messages.push(summary);
      appendCombatLog(combat, enemy.name, summary);
      advanceTurnIndex(combat, args.players, args.playerSheets);
      continue;
    }

    livingPlayers.sort((a, b) => a.sheet.hp - b.sheet.hp || a.player.characterName.localeCompare(b.player.characterName));
    const target = livingPlayers[0];

    // Check for disadvantage against this player
    const disadvantage = combat.activeEffects.some(e => e.targetUserId === target.player.userId && e.effect === 'disadvantage_attacks');

    // Check for AC bonus
    let acBonus = 0;
    for (const e of combat.activeEffects) {
      if (e.targetUserId === target.player.userId && e.effect === 'ac_bonus') acBonus += e.value;
    }

    const targetAc = target.sheet.ac + acBonus;

    let roll: DiceRoll;
    if (disadvantage) {
      const r1 = d20(enemy.attackBonus);
      const r2 = d20(enemy.attackBonus);
      roll = r1.total < r2.total ? r1 : r2;
    } else {
      roll = d20(enemy.attackBonus);
    }

    if (roll.total >= targetAc) {
      const damage = rollDice(enemy.damageNotation).total;
      target.sheet.hp = Math.max(0, target.sheet.hp - damage);
      if (target.sheet.hp === 0) {
        target.sheet.conditions = Array.from(new Set([...target.sheet.conditions, 'unconscious']));
      }
      playerUpdates.set(target.player.userId, target.sheet);
      const summary = `${enemy.name} hits ${target.player.characterName} (${roll.total} vs AC ${targetAc}) for ${damage} damage.`;
      messages.push(summary);
      appendCombatLog(combat, enemy.name, summary);
    } else {
      const summary = `${enemy.name} attacks ${target.player.characterName}, but misses (${roll.total} vs AC ${targetAc}).`;
      messages.push(summary);
      appendCombatLog(combat, enemy.name, summary);
    }

    advanceTurnIndex(combat, args.players, new Map([...args.playerSheets, ...playerUpdates]));
    if (combat.victory) break;
  }

  return {
    combat,
    playerUpdates: Array.from(playerUpdates.entries()).map(([userId, sheet]) => ({ userId, sheet })),
    inventoryUpdates: [],
    removedInventoryItemIds: [],
    messages,
  };
}

export function advanceTurnIndex(combat: DndCombatState, players: DndPlayerRecord[], playerSheets: Map<string, DndCharacterSheet>): void {
  if (!combat.active || combat.order.length === 0) return;

  if (combat.enemies.every(enemy => enemy.hp <= 0)) {
    combat.active = false;
    combat.victory = 'players';
    return;
  }
  const livingPlayers = players.filter(player => (playerSheets.get(player.userId)?.hp ?? 0) > 0 && player.status !== 'left');
  if (livingPlayers.length === 0) {
    combat.active = false;
    combat.victory = 'enemies';
    return;
  }

  const originalIndex = combat.turnIndex;
  for (let step = 1; step <= combat.order.length; step += 1) {
    const nextIndex = (originalIndex + step) % combat.order.length;
    const wrapped = nextIndex <= combat.turnIndex;
    const entry = combat.order[nextIndex];
    if (entry.side === 'enemy') {
      const enemy = combat.enemies.find(candidate => candidate.id === entry.userId);
      if (!enemy || enemy.hp <= 0) continue;
    } else {
      const sheet = playerSheets.get(entry.userId);
      const player = players.find(candidate => candidate.userId === entry.userId);
      if (!player || !sheet || sheet.hp <= 0 || player.status === 'left') continue;
    }
    combat.turnIndex = nextIndex;
    if (wrapped) combat.round += 1;
    return;
  }

  combat.active = false;
  combat.victory = combat.enemies.every(enemy => enemy.hp <= 0) ? 'players' : 'enemies';
}

export function describeCombatantStatus(combat: DndCombatState): string {
  const enemies = combat.enemies
    .map(enemy => `${enemy.name}: ${enemy.hp}/${enemy.maxHp} HP${enemy.conditions.length ? ` [${enemy.conditions.join(', ')}]` : ''}`)
    .join('\n');
  return enemies || 'No enemies tracked.';
}

export function buildProvisioningSummary(
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  inventory: DndInventoryItemRecord[] = [],
): string {
  const skills = (sheet.knownSkillIds ?? []).map(skillId => SKILL_DEFINITIONS[skillId]?.name ?? skillId).join(', ') || 'None';
  const equippedWeapon = inventory.find(item => item.id === sheet.equippedWeaponItemId)?.name
    ?? inventory.find(item => parseInventoryMetadata(item)?.weaponId)?.name
    ?? 'Unarmed';
  const consumables = inventory
    .filter(item => parseInventoryMetadata(item)?.consumableId)
    .map(item => `${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ''}`)
    .join(', ');

  const parts = [
    `${player.characterName}: skills ${skills}`,
    `weapon ${equippedWeapon}`,
  ];
  if (consumables) {
    parts.push(`consumables ${consumables}`);
  }
  return parts.join(' | ');
}

function buildEnemy(
  id: string,
  name: string,
  hp: number,
  ac: number,
  attackBonus: number,
  damageNotation: string,
  abilities: DndAbilityScores,
): DndCombatEnemy {
  return {
    id,
    name,
    hp,
    maxHp: hp,
    ac,
    attackBonus,
    damageNotation,
    abilities: { ...DEFAULT_ABILITIES, ...abilities },
    conditions: [],
    notes: null,
  };
}

function createKit(skillIds: string[], items: StarterItemTemplate[], equippedWeaponName: string | null): StarterCombatKit {
  return { skillIds, items, equippedWeaponName };
}

function weaponItem(weaponId: string): StarterItemTemplate {
  const weapon = WEAPON_DEFINITIONS[weaponId];
  return {
    name: weapon.name,
    category: 'weapon',
    notes: weapon.notes ?? null,
    consumable: false,
    quantity: 1,
    metadata: {
      kind: 'weapon',
      weaponId: weapon.id,
      requirement: weapon.requirement ?? null,
    },
  };
}

function potionItem(): StarterItemTemplate {
  return {
    name: CONSUMABLE_DEFINITIONS.health_potion.name,
    category: 'consumable',
    notes: 'Restore health in combat.',
    consumable: true,
    quantity: 2,
    metadata: { kind: 'consumable', consumableId: 'health_potion' },
  };
}

function bombItem(): StarterItemTemplate {
  return {
    name: CONSUMABLE_DEFINITIONS.fire_bomb.name,
    category: 'consumable',
    notes: 'Explodes for direct combat damage.',
    consumable: true,
    quantity: 1,
    metadata: { kind: 'consumable', consumableId: 'fire_bomb' },
  };
}

function ensureSkillOwnership(sheet: DndCharacterSheet, skillId: string): void {
  if (!(sheet.knownSkillIds ?? []).includes(skillId)) {
    throw new Error(`You do not know the skill "${SKILL_DEFINITIONS[skillId]?.name ?? skillId}".`);
  }
}

function resolveEnemyTarget(combat: DndCombatState, targetName?: string | null): DndCombatEnemy {
  const living = combat.enemies.filter(enemy => enemy.hp > 0);
  if (living.length === 0) {
    throw new Error('There are no living enemies remaining.');
  }
  if (!targetName) return living[0];
  const normalized = normalize(targetName);
  return living.find(enemy => normalize(enemy.name).includes(normalized)) ?? living[0];
}

function resolveAllyTarget(targetName: string | null | undefined, players: DndPlayerRecord[], actorUserId: string): DndPlayerRecord {
  if (!targetName) {
    return players.find(player => player.userId === actorUserId) ?? players[0];
  }
  const normalized = normalize(targetName);
  return players.find(player => normalize(player.characterName).includes(normalized)) ?? players.find(player => player.userId === actorUserId) ?? players[0];
}

function inferAllyTarget(lowered: string, actor: DndPlayerRecord, players: DndPlayerRecord[]): 'ally' | 'self' {
  return players.some(player => player.userId !== actor.userId && lowered.includes(player.characterName.toLowerCase())) ? 'ally' : 'self';
}

function extractNamedTarget(text: string, names: string[]): string | null {
  const lowered = text.toLowerCase();
  return names.find(name => lowered.includes(name.toLowerCase())) ?? null;
}

function performAttackRoll(combat: DndCombatState, actorUserId: string, ability: DndAbilityKey, sheet?: DndCharacterSheet): DiceRoll {
  const combatant = combat.order.find(c => c.userId === actorUserId);

  let bonus = 0;
  let advantage = false;
  let disadvantage = false;

  if (sheet) {
    bonus += abilityModifier(sheet.abilities[ability]) + (sheet.proficiencyBonus ?? 2);
  }

  // Check active effects for actor
  for (const effect of combat.activeEffects) {
    if (effect.targetUserId === actorUserId || (combatant?.side === 'enemy' && effect.targetEnemyId === actorUserId)) {
      if (effect.effect === 'attack_bonus') bonus += effect.value;
      if (effect.effect === 'advantage_attacks') advantage = true;
      if (effect.effect === 'disadvantage_attacks') disadvantage = true;
      if (effect.effect === 'stunned') disadvantage = true;
    }
  }

  if (advantage && !disadvantage) {
    const r1 = Math.floor(Math.random() * 20) + 1;
    const r2 = Math.floor(Math.random() * 20) + 1;
    const roll = Math.max(r1, r2);
    return {
      notation: `d20adv${bonus >= 0 ? `+${bonus}` : bonus}`,
      rolls: [r1, r2],
      modifier: bonus,
      total: roll + bonus,
    };
  } else if (disadvantage && !advantage) {
    const r1 = Math.floor(Math.random() * 20) + 1;
    const r2 = Math.floor(Math.random() * 20) + 1;
    const roll = Math.min(r1, r2);
    return {
      notation: `d20dis${bonus >= 0 ? `+${bonus}` : bonus}`,
      rolls: [r1, r2],
      modifier: bonus,
      total: roll + bonus,
    };
  }

  return d20(bonus);
}

function createActiveEffectFromSkill(skill: DndSkillDefinition, targetUserId?: string, targetEnemyId?: string): DndActiveEffect {
  const effect: any = {
    id: `${skill.id}-${Date.now()}`,
    name: skill.name,
    targetUserId,
    targetEnemyId,
    durationRounds: 3, // Default duration
    effect: 'ac_bonus',
    value: 0,
  };

  switch (skill.id) {
    case 'shield_of_faith':
      effect.effect = 'ac_bonus';
      effect.value = 2;
      effect.durationRounds = 3;
      break;
    case 'bless':
      effect.effect = 'attack_bonus';
      effect.value = 2;
      effect.durationRounds = 3;
      break;
    case 'bane':
      effect.effect = 'attack_bonus';
      effect.value = -2;
      effect.durationRounds = 3;
      break;
    case 'hex':
      effect.effect = 'damage_bonus';
      effect.value = 3;
      effect.durationRounds = 3;
      break;
    case 'sleep':
      effect.effect = 'stunned';
      effect.durationRounds = 1;
      break;
    case 'hold_person':
      effect.effect = 'stunned';
      effect.durationRounds = 2;
      break;
    case 'grease':
      effect.effect = 'prone';
      effect.durationRounds = 1;
      break;
    case 'dodge':
      effect.effect = 'disadvantage_attacks';
      effect.durationRounds = 1;
      break;
    case 'parry':
      effect.effect = 'ac_bonus';
      effect.value = 3;
      effect.durationRounds = 1;
      break;
  }

  return effect;
}

function d20(modifier: number): DiceRoll {
  const roll = Math.floor(Math.random() * 20) + 1;
  return {
    notation: `d20${modifier >= 0 ? `+${modifier}` : modifier}`,
    rolls: [roll],
    modifier,
    total: roll + modifier,
  };
}

function scaleCombatNumber(base: number, abilityMod: number): number {
  const multiplier = 1 + Math.max(0, abilityMod) * 0.12;
  return Math.max(1, Math.round(base * multiplier));
}

function rollInitiativeFromPlayer(player: DndPlayerRecord): number {
  const classDef = getClassById(player.className?.toLowerCase() ?? '');
  const fallbackDex = classDef?.recommendedAbilityOrder[0] === 'dex' ? 14 : 10;
  const sheet = safeParseSheet(player.characterSheetJson);
  return rollInitiativeFromAbilities({ ...DEFAULT_ABILITIES, dex: sheet?.abilities.dex ?? fallbackDex });
}

function rollInitiativeFromAbilities(abilities: DndAbilityScores): number {
  return Math.floor(Math.random() * 20) + 1 + abilityModifier(abilities.dex);
}

function appendCombatLog(combat: DndCombatState, actorName: string, summary: string): void {
  const entry: DndCombatLogEntry = {
    id: `CL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    round: combat.round,
    actorName,
    summary,
    createdAt: Date.now(),
  };
  combat.log.push(entry);
  if (combat.log.length > 30) {
    combat.log = combat.log.slice(-30);
  }
}

function cloneCombatState(combat: DndCombatState): DndCombatState {
  return JSON.parse(JSON.stringify(combat)) as DndCombatState;
}

function cloneSheet(sheet: DndCharacterSheet | undefined): DndCharacterSheet {
  if (!sheet) {
    throw new Error('Character sheet not found for combat resolution.');
  }
  return JSON.parse(JSON.stringify(sheet)) as DndCharacterSheet;
}

function safeParseSheet(sheetJson: string | null): DndCharacterSheet | null {
  if (!sheetJson) return null;
  try {
    return JSON.parse(sheetJson) as DndCharacterSheet;
  } catch {
    return null;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function clampNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
