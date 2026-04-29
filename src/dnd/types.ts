export type DndSessionPhase = 'lobby' | 'active' | 'paused' | 'completed';

export type DndPlayerStatus = 'joined' | 'available' | 'unavailable' | 'left';

export type DndVoteKind = 'skip_turn' | 'party_decision';

export type DndVoteStatus = 'open' | 'resolved' | 'cancelled';

export interface DndSessionRecord {
  id: string;
  guildId: string;
  channelId: string;
  threadId: string;
  hostUserId: string;
  title: string;
  tone: string | null;
  maxPlayers: number;
  phase: DndSessionPhase;
  activePlayerUserId: string | null;
  roundNumber: number;
  turnNumber: number;
  currentVoteId: string | null;
  combatStateJson: string | null;
  progressLogJson: string | null;
  sourceSessionId: string | null;
  lastCheckpointId: string | null;
  notes: string | null;
  worldKey: string | null;
  worldInfo: string | null;
  sceneStateJson: string | null;
  safeRest: boolean;
  sceneDanger: 'safe' | 'tense' | 'danger';
  restInProgress: boolean;
  restStartedAt: number | null;
  restType: 'short' | 'long' | null;
  queuedActionsJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DndSceneState {
  title: string | null;
  location: string | null;
  timeOfDay: string | null;
  weather: string | null;
  activeNpcs: string[];
  currentConflict: string | null;
  currentObjective: string | null;
  currentRisks: string[];
  partySituation: string | null;
  summary: string;
  narrative: string;
  source: 'opening' | 'turnprompt' | 'narrative' | 'weave' | 'regenerate' | 'aftermath';
  updatedAt: number;
  activePlayerUserId: string | null;
  messageId?: string | null;
}

export interface DndPlayerRecord {
  sessionId: string;
  userId: string;
  displayName: string;
  characterName: string;
  className: string | null;
  race: string | null;
  characterSheetJson: string | null;
  status: DndPlayerStatus;
  isHost: boolean;
  turnOrder: number;
  joinedAt: number;
  lastActiveAt: number;
  absentSince: number | null;
  avatarUrl?: string | null;
  avatarSource?: 'discord' | 'upload' | 'class_default' | null;
  onboardingState?: DndOnboardingState | null;
}

export interface DndSessionSnapshot {
  session: DndSessionRecord;
  players: DndPlayerRecord[];
}

export interface DndAbilityScores {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

export type DndAbilityKey = keyof DndAbilityScores;

export interface DndActiveEffect {
  id: string;
  name: string;
  targetUserId?: string;      // for buffs/debuffs on allies
  targetEnemyId?: string;     // for debuffs on enemies
  durationRounds: number;     // ticks down each round
  effect: 'ac_bonus' | 'attack_bonus' | 'damage_bonus' | 'stunned' | 'prone' | 'disadvantage_attacks' | 'advantage_attacks';
  value: number;
}

export interface DndDeathSaveState {
  successes: number;
  failures: number;
  stable: boolean;
  dead: boolean;
}

export interface DndCharacterSheet {
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
  abilities: DndAbilityScores;
  conditions: string[];
  exhaustion: number;
  deathSaves: DndDeathSaveState;
  hitDieMax: number;
  knownSkillIds: string[];
  equippedWeaponItemId: string | null;
  notes: string;
}

export type DndOnboardingStep = 'intro' | 'rolled' | 'class_selected' | 'completed';

export interface DndOnboardingState {
  step: DndOnboardingStep;
  rolledStats: number[];
  selectedClassId: string | null;
  allocated: boolean;
}

export interface DndDocumentRecord {
  id: string;
  sessionId: string;
  filename: string;
  sourceType: 'pdf' | 'lore' | 'transcript' | 'text';
  chunkCount: number;
  uploadedBy: string;
  uploadedAt: number;
}

export interface DndCombatant {
  id: string;
  side: 'player' | 'enemy';
  userId: string;
  characterName: string;
  initiative: number;
}

export interface DndCombatEnemy {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  ac: number;
  attackBonus: number;
  damageNotation: string;
  abilities: DndAbilityScores;
  conditions: string[];
  notes?: string | null;
}

export interface DndCombatLogEntry {
  id: string;
  round: number;
  actorName: string;
  summary: string;
  createdAt: number;
}

export interface DndPendingPlayerAction {
  actionText: string;
  actionJson?: string | null;
  submittedAt: number;
}

export interface DndCombatState {
  active: boolean;
  round: number;
  turnIndex: number;
  order: DndCombatant[];
  enemies: DndCombatEnemy[];
  log: DndCombatLogEntry[];
  skillUsesByActor: Record<string, Record<string, number>>;
  victory: 'players' | 'enemies' | null;
  lastActionMessageChannelId?: string | null;
  lastActionMessageId?: string | null;
  pendingPlayerActions: Record<string, DndPendingPlayerAction>;
  activeEffects: DndActiveEffect[];
  lastRoundNarrative?: string | null;
}

export interface DndProgressEvent {
  id: string;
  type: 'combat' | 'quest';
  title: string;
  xpAward: number;
  createdAt: number;
  createdBy: string;
  notes?: string | null;
}

export type DndDowntimeActivityId =
  | 'training'
  | 'crafting'
  | 'carousing'
  | 'research'
  | 'recuperating'
  | 'work'
  | 'religious_service';

export interface DndDowntimeRecord {
  id: string;
  sessionId: string;
  userId: string;
  activityId: DndDowntimeActivityId;
  focus: string | null;
  durationDays: number;
  goldDelta: number;
  goldBefore: number;
  goldAfter: number;
  cooldownUntil: number;
  summary: string;
  detailsJson: string | null;
  createdAt: number;
}

export interface DndDowntimeProgressRecord {
  sessionId: string;
  userId: string;
  progressKey: string;
  label: string;
  progress: number;
  target: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface DndInventoryItemRecord {
  id: string;
  sessionId: string;
  userId: string;
  name: string;
  quantity: number;
  category: string | null;
  notes: string | null;
  consumable: boolean;
  weight: number | null;
  metadataJson: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DndQueuedNarrativeAction {
  userId: string;
  characterName: string;
  actionText: string;
  createdAt: number;
}

export interface DndShopRecord {
  id: string;
  sessionId: string;
  name: string;
  description: string | null;
  openedBy: string;
  isOpen: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DndShopItemRecord {
  id: string;
  shopId: string;
  name: string;
  priceGp: number;
  stock: number;
  category: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DndCheckpointRecord {
  id: string;
  sessionId: string;
  note: string | null;
  snapshotJson: string;
  createdBy: string;
  createdAt: number;
}

export interface DndVoteRecord {
  id: string;
  sessionId: string;
  kind: DndVoteKind;
  status: DndVoteStatus;
  targetUserId: string;
  question: string;
  optionsJson: string;
  createdBy: string;
  messageChannelId: string | null;
  messageId: string | null;
  expiresAt: number;
  resolvedAt: number | null;
  winningOptionId: string | null;
  metadataJson: string | null;
  createdAt: number;
}

export interface DndBallotRecord {
  voteId: string;
  voterUserId: string;
  optionId: string;
  createdAt: number;
}

export interface DndVoteOption {
  id: string;
  label: string;
}

export interface DndVoteDetails {
  vote: DndVoteRecord;
  options: DndVoteOption[];
  ballots: DndBallotRecord[];
}

export interface DndSessionDetails {
  session: DndSessionRecord;
  players: DndPlayerRecord[];
  vote: DndVoteDetails | null;
}

export interface CreateDndSessionInput {
  id: string;
  guildId: string;
  channelId: string;
  threadId: string;
  hostUserId: string;
  title: string;
  tone?: string | null;
  maxPlayers: number;
  worldKey?: string | null;
}
