import { createLogger } from '../logger.js';
import { DndStore } from './store.js';
import type {
  DndCombatEnemy,
  DndCheckpointRecord,
  DndCharacterSheet,
  DndCombatState,
  DndDowntimeActivityId,
  DndDowntimeProgressRecord,
  DndDowntimeRecord,
  DndInventoryItemRecord,
  DndQueuedNarrativeAction,
  DndSceneState,
  DndDeathSaveState,
  DndAbilityScores,
  DndOnboardingStep,
  DndPlayerRecord,
  DndOnboardingState,
  DndProgressEvent,
  DndSessionDetails,
  DndSessionRecord,
  DndShopItemRecord,
  DndShopRecord,
  DndVoteDetails,
  DndVoteOption,
  DndVoteRecord,
} from './types.js';
import { getClassById, type DndClassDef, buildStartingSheet, recommendStatAllocation, rollStatArray, type StatAllocation } from './classes.js';
import {
  buildProvisioningSummary,
  createCombatState,
  createInventoryMetadataJson,
  detectAction,
  describeCombatantStatus,
  getCombatKitForClass,
  isAccessibleInventoryItem,
  parseEnemyDefinitions,
  parseInventoryMetadata,
  resolvePlayerAction,
  resolveCombatRound,
  runEnemyTurns,
  advanceTurnIndex,
  SKILL_DEFINITIONS,
  type StarterItemTemplate,
  type RoundResolutionResult,
} from './combat-system.js';

const log = createLogger('dnd-manager');

const DEFAULT_VOTE_TIMEOUT_MS = 90_000;
const LEVEL_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
  85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
];

export interface SessionSummary {
  session: DndSessionRecord;
  players: DndPlayerRecord[];
}

export interface VoteResolution {
  vote: DndVoteDetails;
  winningOptionId: string;
  winningOptionLabel: string;
  shouldSkipTarget: boolean;
  targetPlayer: DndPlayerRecord | null;
  session: DndSessionRecord;
  players: DndPlayerRecord[];
}

export interface DndActor {
  userId: string;
  username: string;
  displayName: string;
}

export class DndSessionManager {
  constructor(private readonly store: DndStore) { }

  close(): void {
    this.store.close();
  }

  createSession(input: {
    guildId: string;
    channelId: string;
    threadId: string;
    title: string;
    tone?: string | null;
    maxPlayers?: number;
    worldKey?: string | null;
    host: DndActor;
  }): SessionSummary {
    const session = this.store.createSession({
      id: generateSessionId(),
      guildId: input.guildId,
      channelId: input.channelId,
      threadId: input.threadId,
      hostUserId: input.host.userId,
      title: input.title,
      tone: input.tone ?? null,
      maxPlayers: clampPlayerCount(input.maxPlayers ?? 6),
      worldKey: input.worldKey ?? null,
    });

    this.store.upsertPlayer(session.id, {
      userId: input.host.userId,
      displayName: input.host.displayName,
      characterName: input.host.displayName || input.host.username,
      characterSheet: createDefaultCharacterSheet(),
      isHost: true,
      status: 'available',
    });

    return this.requireDetails(session.id);
  }

  getSessionForThread(threadId: string): DndSessionDetails | null {
    const session = this.store.getSessionByThread(threadId);
    return session ? this.store.getSessionDetails(session.id) : null;
  }

  getSessionById(sessionId: string): DndSessionDetails | null {
    return this.store.getSessionDetails(sessionId);
  }

  listSessionsForGuild(guildId: string): DndSessionRecord[] {
    return this.store.listSessionsForGuild(guildId);
  }

  listCheckpoints(sessionId: string): DndCheckpointRecord[] {
    return this.store.listCheckpoints(sessionId);
  }

  getProgressLog(sessionId: string): DndProgressEvent[] {
    return this.store.getProgressLog(sessionId);
  }

  getDowntimeHistory(sessionId: string, userId: string, limit = 10): DndDowntimeRecord[] {
    return this.store.listDowntimeRecords(sessionId, userId, limit);
  }

  getDowntimeProgress(sessionId: string, userId: string): DndDowntimeProgressRecord[] {
    return this.store.listDowntimeProgress(sessionId, userId);
  }

  getInventory(sessionId: string, userId: string): DndInventoryItemRecord[] {
    this.requirePlayerInSession(sessionId, userId);
    return this.store.listInventoryItems(sessionId, userId);
  }

  updateSessionWorldState(
    sessionId: string,
    patch: {
      safeRest?: boolean;
      sceneDanger?: 'safe' | 'tense' | 'danger';
      restInProgress?: boolean;
      restStartedAt?: number | null;
      restType?: 'short' | 'long' | null;
      queuedActionsJson?: string | null;
    },
  ): SessionSummary {
    this.requireDetails(sessionId);
    this.store.updateSessionWorldState(sessionId, patch);
    return this.requireDetails(sessionId);
  }

  getQueuedNarrativeActions(sessionId: string): DndQueuedNarrativeAction[] {
    const details = this.requireDetails(sessionId);
    if (!details.session.queuedActionsJson) return [];
    try {
      const parsed = JSON.parse(details.session.queuedActionsJson) as DndQueuedNarrativeAction[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  queueNarrativeAction(sessionId: string, userId: string, actionText: string): DndQueuedNarrativeAction[] {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const existing = this.getQueuedNarrativeActions(sessionId)
      .filter(entry => entry.userId !== userId);
    existing.push({
      userId,
      characterName: player.characterName,
      actionText: actionText.trim(),
      createdAt: Date.now(),
    });
    this.store.updateSessionWorldState(sessionId, { queuedActionsJson: JSON.stringify(existing) });
    return existing;
  }

  clearQueuedNarrativeActions(sessionId: string): void {
    this.requireDetails(sessionId);
    this.store.updateSessionWorldState(sessionId, { queuedActionsJson: null });
  }

  setAvatar(
    sessionId: string,
    userId: string,
    avatar: { url: string | null; source: 'discord' | 'upload' | 'class_default' | null },
  ): DndPlayerRecord {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    this.store.upsertPlayer(sessionId, {
      userId: player.userId,
      displayName: player.displayName,
      characterName: player.characterName,
      className: player.className,
      race: player.race,
      characterSheet: parseCharacterSheet(player.characterSheetJson),
      isHost: player.isHost,
      status: player.status,
      onboardingState: player.onboardingState ?? null,
      avatarUrl: avatar.url,
      avatarSource: avatar.source,
    });
    return this.store.getPlayers(sessionId).find(entry => entry.userId === userId)!;
  }

  confiscateInventory(
    sessionId: string,
    actorUserId: string,
    userId: string,
    storedAt: string,
    reason = 'Confiscated after capture',
  ): { player: DndPlayerRecord; sheet: DndCharacterSheet; confiscated: number } {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);
    const player = requirePlayer(details.players, userId);
    const items = this.store.listInventoryItems(sessionId, userId);
    let confiscated = 0;

    for (const item of items) {
      const metadata = parseInventoryMetadata(item) ?? { kind: item.consumable ? 'consumable' : 'gear' as const };
      if (metadata.confiscated) continue;
      this.store.updateInventoryItem(item.id, {
        metadataJson: createInventoryMetadataJson({
          ...metadata,
          confiscated: true,
          confiscatedReason: reason,
          storedAt,
        }),
      });
      confiscated += 1;
    }

    const sheet = parseCharacterSheet(player.characterSheetJson);
    sheet.equippedWeaponItemId = null;
    sheet.hp = Math.max(1, sheet.hp);
    sheet.conditions = sheet.conditions.filter(condition => condition !== 'unconscious');
    const updatedPlayer = this.setCharacterSheet(sessionId, userId, sheet, player.className ?? undefined, player.race ?? undefined);
    return { player: updatedPlayer, sheet, confiscated };
  }

  getActiveShop(sessionId: string): { shop: DndShopRecord; items: DndShopItemRecord[] } | null {
    const shop = this.store.getActiveShop(sessionId);
    if (!shop) return null;
    return { shop, items: this.store.listShopItems(shop.id) };
  }

  joinSession(input: {
    sessionId: string;
    user: DndActor;
    characterName: string;
    className?: string | null;
    race?: string | null;
  }): SessionSummary {
    const details = this.requireDetails(input.sessionId);
    ensureSessionJoinable(details.session);

    const existing = details.players.find(player => player.userId === input.user.userId);
    if (!existing && details.players.filter(player => player.status !== 'left').length >= details.session.maxPlayers) {
      throw new Error(`This session is full (${details.session.maxPlayers} players).`);
    }

    this.store.upsertPlayer(details.session.id, {
      userId: input.user.userId,
      displayName: input.user.displayName || input.user.username,
      characterName: input.characterName.trim() || input.user.displayName || input.user.username,
      className: cleanOptional(input.className),
      race: cleanOptional(input.race),
      characterSheet: existing ? undefined : createDefaultCharacterSheet(),
      status: 'available',
      onboardingState: normalizeOnboardingState(existing?.onboardingState),
    });

    const updated = this.requireDetails(details.session.id);
    if (!updated.session.activePlayerUserId && updated.session.phase === 'active') {
      const next = findNextAvailablePlayer(updated.players);
      this.store.updateTurnState(updated.session.id, {
        activePlayerUserId: next?.userId ?? null,
        roundNumber: updated.session.roundNumber,
        turnNumber: updated.session.turnNumber,
      });
      return this.requireDetails(updated.session.id);
    }

    return updated;
  }

  updateWorldInfo(sessionId: string, worldInfo: string): void {
    this.store.updateWorldInfo(sessionId, worldInfo);
  }

  updateSceneState(sessionId: string, sceneState: DndSceneState | null): void {
    this.requireDetails(sessionId);
    this.store.updateSceneState(sessionId, sceneState);
  }

  updateSessionPhase(sessionId: string, phase: 'lobby' | 'active' | 'paused' | 'completed'): void {
    this.store.updateSessionPhase(sessionId, phase);
  }

  beginSession(sessionId: string, actorUserId: string): SessionSummary {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);

    const availablePlayers = details.players.filter(player => isEligibleForTurns(player));
    if (availablePlayers.length === 0) {
      throw new Error('At least one available player is required to begin the session.');
    }

    this.provisionCombatLoadouts(sessionId);
    this.store.updateSessionPhase(sessionId, 'active');
    this.store.updateTurnState(sessionId, {
      activePlayerUserId: availablePlayers[0].userId,
      roundNumber: 1,
      turnNumber: 1,
    });

    return this.requireDetails(sessionId);
  }

  saveSession(sessionId: string, actorUserId: string, note?: string | null): { summary: SessionSummary; checkpointId: string } {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);

    this.store.updateSessionPhase(sessionId, 'paused');
    const checkpointId = generateCheckpointId();
    this.store.saveCheckpoint(sessionId, checkpointId, actorUserId, note ?? null);

    return {
      summary: this.requireDetails(sessionId),
      checkpointId,
    };
  }

  resumeSession(input: {
    sessionId: string;
    actorUserId: string;
    channelId: string;
    threadId: string;
    partialParty?: boolean;
  }): SessionSummary {
    const details = this.requireDetails(input.sessionId);
    ensureHost(details.session, input.actorUserId);

    this.store.updateSessionThread(details.session.id, input.channelId, input.threadId);
    this.store.updateSessionPhase(details.session.id, 'active');

    if (input.partialParty) {
      for (const player of details.players) {
        if (!player.isHost) {
          this.store.updatePlayerStatus(details.session.id, player.userId, 'unavailable');
        }
      }
    }

    const updated = this.requireDetails(details.session.id);
    const next = findNextAvailablePlayer(updated.players, updated.session.activePlayerUserId);
    this.store.updateTurnState(updated.session.id, {
      activePlayerUserId: next?.userId ?? null,
      roundNumber: Math.max(1, updated.session.roundNumber),
      turnNumber: Math.max(1, updated.session.turnNumber),
    });

    return this.requireDetails(updated.session.id);
  }

  restoreCheckpoint(input: {
    checkpointId: string;
    actorUserId: string;
    channelId: string;
    threadId: string;
    partialParty?: boolean;
  }): SessionSummary {
    const checkpoint = this.store.getCheckpointById(input.checkpointId);
    if (!checkpoint) {
      throw new Error(`Unknown checkpoint: ${input.checkpointId}`);
    }

    const current = this.requireDetails(checkpoint.sessionId);
    ensureHost(current.session, input.actorUserId);

    const snapshot = JSON.parse(checkpoint.snapshotJson) as {
      session: DndSessionRecord;
      players: DndPlayerRecord[];
    };

    this.store.replaceSessionFromSnapshot(current.session.id, snapshot, input.channelId, input.threadId);
    this.store.updateSessionPhase(current.session.id, 'active');

    if (input.partialParty) {
      const restored = this.requireDetails(current.session.id);
      for (const player of restored.players) {
        if (!player.isHost) {
          this.store.updatePlayerStatus(restored.session.id, player.userId, 'unavailable');
        }
      }
    }

    return this.requireDetails(current.session.id);
  }

  endSession(sessionId: string, actorUserId: string): SessionSummary {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);
    this.store.updateSessionPhase(sessionId, 'completed');
    return this.requireDetails(sessionId);
  }

  async setAvailability(sessionId: string, actorUserId: string, available: boolean, engine: any): Promise<SessionSummary> {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, actorUserId);
    this.store.updatePlayerStatus(sessionId, actorUserId, available ? 'available' : 'unavailable');
    const updated = this.requireDetails(sessionId);

    if (!available && updated.session.activePlayerUserId === actorUserId) {
      return await this.advanceTurn(sessionId, actorUserId, engine, true);
    }

    if (available && !updated.session.activePlayerUserId && updated.session.phase === 'active') {
      this.store.updateTurnState(sessionId, {
        activePlayerUserId: actorUserId,
        roundNumber: updated.session.roundNumber,
        turnNumber: updated.session.turnNumber,
      });
      return this.requireDetails(sessionId);
    }

    log.info({ sessionId, actorUserId, status: available ? 'available' : 'unavailable', characterName: player.characterName }, 'Updated player availability');
    return updated;
  }

  getCharacterSheet(sessionId: string, userId: string): DndCharacterSheet {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    return parseCharacterSheet(player.characterSheetJson);
  }

  /**
   * Update a single field on a character sheet. Used by /stats set commands.
   */
  updateCharacterField(
    sessionId: string,
    userId: string,
    field: string,
    value: any,
  ): { sheet: DndCharacterSheet; player: DndPlayerRecord } {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);

    switch (field) {
      case 'hp':
        sheet.hp = Math.max(0, Math.min(sheet.maxHp, Math.floor(Number(value))));
        break;
      case 'maxhp':
        sheet.maxHp = Math.max(1, Math.min(999, Math.floor(Number(value))));
        sheet.hp = Math.min(sheet.hp, sheet.maxHp);
        break;
      case 'ac':
        sheet.ac = Math.max(0, Math.min(30, Math.floor(Number(value))));
        break;
      case 'notes':
        sheet.notes = String(value).slice(0, 500);
        break;
      case 'inspiration':
        sheet.inspiration = value === true || value === 'true' || value === 'on';
        break;
      case 'conditions':
        if (Array.isArray(value)) {
          sheet.conditions = value;
        }
        break;
      case 'exhaustion':
        sheet.exhaustion = Math.max(0, Math.min(6, Math.floor(Number(value))));
        break;
      default:
        // Check if it's an ability score key
        if (field in sheet.abilities) {
          const key = field as keyof DndAbilityScores;
          sheet.abilities[key] = Math.max(1, Math.min(30, Math.floor(Number(value))));
          // Recalculate passive perception if WIS changed
          if (key === 'wis') {
            sheet.passivePerception = 10 + abilityModifier(sheet.abilities.wis);
          }
        } else {
          throw new Error(`Unknown character field: ${field}`);
        }
    }

    this.store.upsertPlayer(sessionId, {
      userId: player.userId,
      displayName: player.displayName,
      characterName: player.characterName,
      className: player.className,
      race: player.race,
      characterSheet: sheet,
      isHost: player.isHost,
      status: player.status,
    });

    const updatedPlayer = this.store.getPlayers(sessionId).find(p => p.userId === userId)!;
    return { sheet, player: updatedPlayer };
  }

  /**
   * Replace the entire character sheet (used for class selection & stat allocation).
   */
  setCharacterSheet(sessionId: string, userId: string, sheet: DndCharacterSheet, className?: string, race?: string): DndPlayerRecord {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);

    this.store.upsertPlayer(sessionId, {
      userId: player.userId,
      displayName: player.displayName,
      characterName: player.characterName,
      className: className ?? player.className,
      race: race ?? player.race,
      characterSheet: sheet,
      isHost: player.isHost,
      status: player.status,
    });

    return this.store.getPlayers(sessionId).find(p => p.userId === userId)!;
  }

  learnCombatSkill(sessionId: string, userId: string, skillId: string): DndPlayerRecord {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);

    if (!SKILL_DEFINITIONS[skillId]) {
      throw new Error(`Unknown skill: ${skillId}`);
    }

    if (sheet.knownSkillIds.includes(skillId)) {
      throw new Error(`${player.characterName} already knows ${SKILL_DEFINITIONS[skillId].name}.`);
    }

    sheet.knownSkillIds.push(skillId);
    return this.setCharacterSheet(sessionId, userId, sheet);
  }

  getKnownSkills(sessionId: string, userId: string): any[] {
    const sheet = this.getCharacterSheet(sessionId, userId);
    return sheet.knownSkillIds.map(id => SKILL_DEFINITIONS[id]).filter(Boolean);
  }

  /**
   * Generate onboarding stat rolls for a player.
   */
  generateOnboardingStats(sessionId: string, userId: string): number[] {
    const rolled = rollStatArray();
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);

    const state: DndOnboardingState = {
      step: 'rolled',
      rolledStats: rolled,
      selectedClassId: player.onboardingState?.selectedClassId ?? null,
      allocated: false,
    };

    this.store.updateOnboardingState(sessionId, userId, state);
    if (state.selectedClassId) {
      const classDef = getClassById(state.selectedClassId);
      if (classDef) {
        const allocation = recommendStatAllocation(classDef, rolled);
        this.applyRecommendedOnboarding(sessionId, userId, classDef, allocation, rolled);
      }
    }
    return rolled;
  }

  selectOnboardingClass(
    sessionId: string,
    userId: string,
    classId: string,
  ): { sheet: DndCharacterSheet; player: DndPlayerRecord; classDef: DndClassDef; autoAssigned: boolean } {
    const classDef = getClassById(classId);
    if (!classDef) throw new Error(`Unknown class: ${classId}`);

    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const onboarding = normalizeOnboardingState(player.onboardingState);

    if (onboarding.rolledStats.length === 6) {
      const allocation = recommendStatAllocation(classDef, onboarding.rolledStats);
      const result = this.applyRecommendedOnboarding(sessionId, userId, classDef, allocation, onboarding.rolledStats);
      return { ...result, classDef, autoAssigned: true };
    }

    const currentSheet = this.getCharacterSheet(sessionId, userId);
    const result = this.applyOnboarding(sessionId, userId, classId, currentSheet.abilities);
    return { ...result, classDef, autoAssigned: false };
  }

  /**
   * Apply class selection and stat allocation for onboarding.
   */
  applyOnboarding(
    sessionId: string,
    userId: string,
    classId: string,
    allocation: StatAllocation,
  ): { sheet: DndCharacterSheet; player: DndPlayerRecord } {
    const classDef = getClassById(classId);
    if (!classDef) throw new Error(`Unknown class: ${classId}`);

    const sheet = buildStartingSheet(classDef, allocation);
    const fullSheet: DndCharacterSheet = {
      ...sheet,
      conditions: [],
      exhaustion: 0,
      deathSaves: createDefaultCharacterSheet().deathSaves,
      hitDieMax: classDef.hitDie,
    };

    const player = this.setCharacterSheet(sessionId, userId, fullSheet, classDef.name);
    const existing = normalizeOnboardingState(player.onboardingState);
    this.store.updateOnboardingState(sessionId, userId, {
      step: 'class_selected',
      rolledStats: existing.rolledStats,
      selectedClassId: classId,
      allocated: false,
    });
    const updatedPlayer = this.store.getPlayers(sessionId).find(p => p.userId === userId)!;
    return { sheet: fullSheet, player: updatedPlayer };
  }

  private applyRecommendedOnboarding(
    sessionId: string,
    userId: string,
    classDef: DndClassDef,
    allocation: StatAllocation,
    rolledStats: number[],
  ): { sheet: DndCharacterSheet; player: DndPlayerRecord } {
    const sheet = buildStartingSheet(classDef, allocation);
    const fullSheet: DndCharacterSheet = {
      ...sheet,
      conditions: [],
      exhaustion: 0,
      deathSaves: createDefaultCharacterSheet().deathSaves,
      hitDieMax: classDef.hitDie,
    };

    const player = this.setCharacterSheet(sessionId, userId, fullSheet, classDef.name);
    this.store.updateOnboardingState(sessionId, userId, {
      step: 'completed',
      rolledStats,
      selectedClassId: classDef.id,
      allocated: true,
    });
    const updatedPlayer = this.store.getPlayers(sessionId).find(p => p.userId === userId)!;
    return { sheet: fullSheet, player: updatedPlayer };
  }

  // ─── Resting ────────────────────────────────────────────────────────

  allocateStats(
    sessionId: string,
    userId: string,
    abilities: DndAbilityScores,
  ): { sheet: DndCharacterSheet; player: DndPlayerRecord } {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = this.getCharacterSheet(sessionId, userId);

    const updatedSheet: DndCharacterSheet = {
      ...sheet,
      abilities,
    };

    const onboarding: DndOnboardingState = {
      ...normalizeOnboardingState(player.onboardingState),
      step: 'completed',
      allocated: true,
    };

    const updatedPlayer = this.store.upsertPlayer(sessionId, {
      ...player,
      characterSheet: updatedSheet,
      onboardingState: onboarding,
    });

    return { sheet: updatedSheet, player: updatedPlayer };
  }

  performShortRest(sessionId: string, userId: string, hitDice: number): { sheet: DndCharacterSheet; player: DndPlayerRecord; hitDiceUsed: number; hpRegained: number } {
    const { applyShortRest } = require('./mechanics.js');
    const details = this.requireDetails(sessionId);
    ensureRestAllowed(details.session, 'short');
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    this.store.updateSessionWorldState(sessionId, {
      restInProgress: true,
      restStartedAt: Date.now(),
      restType: 'short',
    });
    const { sheet: updated, result } = applyShortRest(sheet, hitDice);
    const updatedPlayer = this.setCharacterSheet(sessionId, userId, updated);
    this.store.updateSessionWorldState(sessionId, {
      restInProgress: false,
      restStartedAt: null,
      restType: null,
    });
    return { sheet: updated, player: updatedPlayer, hitDiceUsed: result.hitDiceUsed, hpRegained: result.hpRegained };
  }

  performLongRest(sessionId: string, userId: string): { sheet: DndCharacterSheet; player: DndPlayerRecord; hpRegained: number; conditionsCleared: string[]; exhaustionReduced: boolean } {
    const { applyLongRest } = require('./mechanics.js');
    const details = this.requireDetails(sessionId);
    ensureRestAllowed(details.session, 'long');
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    this.store.updateSessionWorldState(sessionId, {
      restInProgress: true,
      restStartedAt: Date.now(),
      restType: 'long',
    });
    const { sheet: updated, result } = applyLongRest(sheet);
    const updatedPlayer = this.setCharacterSheet(sessionId, userId, updated);
    this.store.updateSessionWorldState(sessionId, {
      restInProgress: false,
      restStartedAt: null,
      restType: null,
    });
    return { sheet: updated, player: updatedPlayer, hpRegained: result.hpRegained, conditionsCleared: result.conditionsCleared, exhaustionReduced: result.exhaustionReduced };
  }

  // ─── Conditions ─────────────────────────────────────────────────────

  addCondition(sessionId: string, userId: string, condition: string): { sheet: DndCharacterSheet; player: DndPlayerRecord; added: boolean; error?: string } {
    const { addCondition } = require('./mechanics.js');
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const result = addCondition(sheet, condition);
    if (!result.added) return { sheet, player, added: false, error: result.error };
    const updatedPlayer = this.setCharacterSheet(sessionId, userId, sheet);
    return { sheet, player: updatedPlayer, added: true };
  }

  removeCondition(sessionId: string, userId: string, condition: string): { sheet: DndCharacterSheet; player: DndPlayerRecord; removed: boolean; error?: string } {
    const { removeCondition } = require('./mechanics.js');
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const result = removeCondition(sheet, condition);
    if (!result.removed) return { sheet, player, removed: false, error: result.error };
    const updatedPlayer = this.setCharacterSheet(sessionId, userId, sheet);
    return { sheet, player: updatedPlayer, removed: true };
  }

  // ─── Inspiration ────────────────────────────────────────────────────

  toggleInspiration(sessionId: string, userId: string, grant: boolean): { sheet: DndCharacterSheet; player: DndPlayerRecord } {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    sheet.inspiration = grant;
    const updatedPlayer = this.setCharacterSheet(sessionId, userId, sheet);
    return { sheet, player: updatedPlayer };
  }

  grantInspiration(sessionId: string, actorUserId: string, targetUserId: string): { sheet: DndCharacterSheet; player: DndPlayerRecord } {
    const details = this.requireDetails(sessionId);
    const actor = requirePlayer(details.players, actorUserId);
    const canGrant = details.session.hostUserId === actorUserId || actor.className?.toLowerCase() === 'bard';
    if (!canGrant) {
      throw new Error('Only the host or a Bard can grant inspiration.');
    }

    const target = requirePlayer(details.players, targetUserId);
    const sheet = parseCharacterSheet(target.characterSheetJson);
    if (sheet.inspiration) {
      throw new Error(`${target.characterName} already has inspiration.`);
    }
    sheet.inspiration = true;
    const updatedPlayer = this.setCharacterSheet(sessionId, targetUserId, sheet);
    return { sheet, player: updatedPlayer };
  }

  getDeathSaves(sessionId: string, userId: string): DndDeathSaveState {
    const sheet = this.getCharacterSheet(sessionId, userId);
    return sheet.deathSaves;
  }

  rollDeathSave(sessionId: string, userId: string, useInspiration = false): {
    sheet: DndCharacterSheet;
    player: DndPlayerRecord;
    roll: number;
    event: string;
    usedInspiration: boolean;
  } {
    const { rollDeathSave, spendInspiration, createDeathSaveState } = require('./mechanics.js');
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    if (sheet.hp > 0) {
      throw new Error('Death saves only apply while you are at 0 HP.');
    }
    if (sheet.deathSaves.dead) {
      throw new Error('This character is already marked dead.');
    }

    let outcome = rollDeathSave(sheet.deathSaves);
    let used = false;
    if (useInspiration) {
      if (!sheet.inspiration) {
        throw new Error('You do not have inspiration to spend.');
      }
      const reroll = spendInspiration(outcome.roll);
      if (reroll.newRoll > outcome.roll) {
        outcome = rollDeathSave(createDeathSaveState());
        outcome.roll = reroll.kept;
        if (reroll.kept === 20) {
          outcome.result = createDeathSaveState();
          outcome.event = 'Natural 20 with inspiration! You regain 1 HP and wake up.';
        } else if (reroll.kept === 1) {
          outcome.result = { ...sheet.deathSaves, failures: Math.min(3, sheet.deathSaves.failures + 2), dead: Math.min(3, sheet.deathSaves.failures + 2) >= 3, stable: false };
          outcome.event = 'Natural 1 even after inspiration. Two death save failures.';
        } else if (reroll.kept >= 10) {
          outcome.result = { ...sheet.deathSaves, successes: Math.min(3, sheet.deathSaves.successes + 1) };
          if (outcome.result.successes >= 3) {
            outcome.result.stable = true;
          }
          outcome.event = `Death save success (${reroll.kept}) using inspiration.`;
        } else {
          outcome.result = { ...sheet.deathSaves, failures: Math.min(3, sheet.deathSaves.failures + 1), stable: false };
          if (outcome.result.failures >= 3) {
            outcome.result.dead = true;
          }
          outcome.event = `Death save failure (${reroll.kept}) even after inspiration.`;
        }
      }
      sheet.inspiration = false;
      used = true;
    }

    sheet.deathSaves = outcome.result;
    if (outcome.roll === 20) {
      sheet.hp = 1;
      sheet.deathSaves = createDeathSaveState();
    }
    if (sheet.hp > 0) {
      sheet.conditions = sheet.conditions.filter(condition => condition !== 'unconscious');
    }

    const updatedPlayer = this.setCharacterSheet(sessionId, userId, sheet);
    return {
      sheet,
      player: updatedPlayer,
      roll: outcome.roll,
      event: outcome.event,
      usedInspiration: used,
    };
  }

  applyDeathSaveDamage(sessionId: string, actorUserId: string, targetUserId: string, damage: number, wasCrit: boolean): {
    sheet: DndCharacterSheet;
    player: DndPlayerRecord;
  } {
    const { damageAtZeroHp } = require('./mechanics.js');
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);
    const player = requirePlayer(details.players, targetUserId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    if (sheet.hp > 0) {
      throw new Error('Automatic death save failures only apply while the target is at 0 HP.');
    }
    sheet.deathSaves = damageAtZeroHp(sheet.deathSaves, damage, wasCrit, sheet.maxHp);
    const updatedPlayer = this.setCharacterSheet(sessionId, targetUserId, sheet);
    return { sheet, player: updatedPlayer };
  }

  resetDeathSaves(sessionId: string, actorUserId: string, targetUserId: string): { sheet: DndCharacterSheet; player: DndPlayerRecord } {
    const { createDeathSaveState } = require('./mechanics.js');
    const details = this.requireDetails(sessionId);
    if (details.session.hostUserId !== actorUserId && actorUserId !== targetUserId) {
      throw new Error('Only the host or the affected player can reset death saves.');
    }
    const player = requirePlayer(details.players, targetUserId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    sheet.deathSaves = createDeathSaveState();
    const updatedPlayer = this.setCharacterSheet(sessionId, targetUserId, sheet);
    return { sheet, player: updatedPlayer };
  }

  performDowntime(input: {
    sessionId: string;
    userId: string;
    activityId: DndDowntimeActivityId;
    focus?: string | null;
    durationMinutes?: number;
    weeks?: number;
    itemValue?: number | null;
  }): {
    record: DndDowntimeRecord;
    player: DndPlayerRecord;
    sheet: DndCharacterSheet;
    progress: DndDowntimeProgressRecord[];
  } {
    const details = this.requireDetails(input.sessionId);
    if (!['paused', 'completed'].includes(details.session.phase)) {
      throw new Error('Downtime can only be used while a session is paused or completed.');
    }

    const player = requirePlayer(details.players, input.userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const latest = this.store.getLatestDowntimeRecord(input.sessionId, input.userId);
    if (latest && latest.cooldownUntil > Date.now()) {
      throw new Error(`You are still busy with downtime until ${formatAbsoluteDate(latest.cooldownUntil)}.`);
    }

    const durationMinutes = normalizeDowntimeMinutes(input.durationMinutes ?? legacyWeeksToMinutes(input.weeks ?? 1));
    const outcome = resolveDowntimeActivity({
      activityId: input.activityId,
      focus: cleanOptional(input.focus),
      durationMinutes,
      itemValue: input.itemValue ?? null,
      player,
      sheet,
      now: Date.now(),
      getProgress: key => this.store.getDowntimeProgress(input.sessionId, input.userId, key),
    });

    const nextSheet: DndCharacterSheet = {
      ...outcome.sheet,
      gold: Math.max(0, outcome.sheet.gold),
    };
    const updatedPlayer = this.setCharacterSheet(input.sessionId, input.userId, nextSheet);

    for (const progress of outcome.progressUpdates) {
      this.store.upsertDowntimeProgress({
        sessionId: input.sessionId,
        userId: input.userId,
        progressKey: progress.progressKey,
        label: progress.label,
        progress: progress.progress,
        target: progress.target,
        updatedAt: outcome.createdAt,
        completedAt: progress.progress >= progress.target ? outcome.createdAt : null,
      });
    }

    const record: DndDowntimeRecord = {
      id: generateDowntimeId(),
      sessionId: input.sessionId,
      userId: input.userId,
      activityId: input.activityId,
      focus: outcome.focus,
      durationDays: outcome.durationDays,
      goldDelta: outcome.goldDelta,
      goldBefore: outcome.goldBefore,
      goldAfter: nextSheet.gold,
      cooldownUntil: outcome.cooldownUntil,
      summary: outcome.summary,
      detailsJson: JSON.stringify(outcome.details),
      createdAt: outcome.createdAt,
    };
    this.store.createDowntimeRecord(record);

    return {
      record,
      player: updatedPlayer,
      sheet: nextSheet,
      progress: this.store.listDowntimeProgress(input.sessionId, input.userId),
    };
  }

  addInventoryItem(input: {
    sessionId: string;
    actorUserId: string;
    targetUserId: string;
    name: string;
    quantity?: number;
    category?: string | null;
    notes?: string | null;
    consumable?: boolean;
    metadataJson?: string | null;
  }): DndInventoryItemRecord {
    const details = this.requireDetails(input.sessionId);
    ensureHost(details.session, input.actorUserId);
    requirePlayer(details.players, input.targetUserId);

    const name = input.name.trim();
    if (!name) throw new Error('Item name cannot be empty.');
    const quantity = Math.max(1, Math.min(999, Math.floor(input.quantity ?? 1)));

    const existing = this.store.listInventoryItems(input.sessionId, input.targetUserId)
      .find(item => item.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      this.store.updateInventoryItem(existing.id, {
        quantity: existing.quantity + quantity,
        category: input.category !== undefined ? cleanOptional(input.category) : existing.category,
        notes: input.notes !== undefined ? cleanOptional(input.notes) : existing.notes,
        consumable: input.consumable !== undefined ? input.consumable : existing.consumable,
        metadataJson: input.metadataJson !== undefined ? input.metadataJson : existing.metadataJson,
      });
      return this.store.getInventoryItem(existing.id)!;
    }

    const now = Date.now();
    const item: DndInventoryItemRecord = {
      id: generateInventoryItemId(),
      sessionId: input.sessionId,
      userId: input.targetUserId,
      name,
      quantity,
      category: cleanOptional(input.category),
      notes: cleanOptional(input.notes),
      consumable: Boolean(input.consumable),
      metadataJson: input.metadataJson ?? null,
      weight: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.createInventoryItem(item);
    return item;
  }

  spendInventoryItem(input: {
    sessionId: string;
    userId: string;
    itemId: string;
    quantity?: number;
  }): { item: DndInventoryItemRecord | null; spent: number } {
    const details = this.requireDetails(input.sessionId);
    requirePlayer(details.players, input.userId);
    const item = this.store.getInventoryItem(input.itemId);
    if (!item || item.sessionId !== input.sessionId || item.userId !== input.userId) {
      throw new Error('Inventory item not found.');
    }
    if (!isAccessibleInventoryItem(item)) {
      throw new Error('That item is currently confiscated and not accessible.');
    }
    const spend = Math.max(1, Math.min(item.quantity, Math.floor(input.quantity ?? 1)));
    const remaining = item.quantity - spend;
    if (remaining <= 0) {
      this.store.deleteInventoryItem(item.id);
      return { item: null, spent: spend };
    }
    this.store.updateInventoryItem(item.id, { quantity: remaining });
    return { item: this.store.getInventoryItem(item.id), spent: spend };
  }

  removeInventoryItem(input: {
    sessionId: string;
    actorUserId: string;
    targetUserId: string;
    itemId: string;
    quantity?: number;
  }): { item: DndInventoryItemRecord | null; removed: number } {
    const details = this.requireDetails(input.sessionId);
    if (input.actorUserId !== input.targetUserId) {
      ensureHost(details.session, input.actorUserId);
    } else {
      requirePlayer(details.players, input.targetUserId);
    }
    const item = this.store.getInventoryItem(input.itemId);
    if (!item || item.sessionId !== input.sessionId || item.userId !== input.targetUserId) {
      throw new Error('Inventory item not found.');
    }
    if (input.actorUserId === input.targetUserId && !isAccessibleInventoryItem(item)) {
      throw new Error('That item is currently confiscated and not accessible.');
    }
    const removed = Math.max(1, Math.min(item.quantity, Math.floor(input.quantity ?? item.quantity)));
    const remaining = item.quantity - removed;
    if (remaining <= 0) {
      this.store.deleteInventoryItem(item.id);
      return { item: null, removed };
    }
    this.store.updateInventoryItem(item.id, { quantity: remaining });
    return { item: this.store.getInventoryItem(item.id), removed };
  }

  spendGold(sessionId: string, userId: string, amount: number, reason?: string | null): { sheet: DndCharacterSheet; player: DndPlayerRecord; spent: number; reason: string | null } {
    const details = this.requireDetails(sessionId);
    const player = requirePlayer(details.players, userId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const spent = Math.max(1, Math.floor(amount));
    if (sheet.gold < spent) {
      throw new Error(`You only have ${sheet.gold} gp.`);
    }
    sheet.gold -= spent;
    const updatedPlayer = this.setCharacterSheet(sessionId, userId, sheet);
    return { sheet, player: updatedPlayer, spent, reason: cleanOptional(reason) };
  }

  openShop(input: {
    sessionId: string;
    actorUserId: string;
    name: string;
    description?: string | null;
    items: Array<{
      name: string;
      priceGp: number;
      stock: number;
      category?: string | null;
      notes?: string | null;
    }>;
  }): { shop: DndShopRecord; items: DndShopItemRecord[] } {
    const details = this.requireDetails(input.sessionId);
    ensureHost(details.session, input.actorUserId);
    if (parseCombatState(details.session.combatStateJson)?.active) {
      throw new Error('Shops cannot be opened during combat.');
    }

    const name = input.name.trim();
    if (!name) throw new Error('Shop name cannot be empty.');
    const items = input.items
      .map(item => ({
        name: item.name.trim(),
        priceGp: Math.max(0, Math.min(100_000, Math.floor(item.priceGp))),
        stock: Math.max(0, Math.min(999, Math.floor(item.stock))),
        category: cleanOptional(item.category),
        notes: cleanOptional(item.notes),
      }))
      .filter(item => item.name.length > 0);
    if (items.length === 0) {
      throw new Error('A shop needs at least one item.');
    }

    const now = Date.now();
    const shop: DndShopRecord = {
      id: generateShopId(),
      sessionId: input.sessionId,
      name,
      description: cleanOptional(input.description),
      openedBy: input.actorUserId,
      isOpen: true,
      createdAt: now,
      updatedAt: now,
    };
    const shopItems: DndShopItemRecord[] = items.map(item => ({
      id: generateShopItemId(),
      shopId: shop.id,
      name: item.name,
      priceGp: item.priceGp,
      stock: item.stock,
      category: item.category,
      notes: item.notes,
      createdAt: now,
      updatedAt: now,
    }));

    this.store.createShop(shop, shopItems);
    return { shop, items: shopItems };
  }

  closeShop(sessionId: string, actorUserId: string): void {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);
    const active = this.store.getActiveShop(sessionId);
    if (!active) {
      throw new Error('There is no open shop in this session.');
    }
    this.store.closeShop(active.id);
  }

  buyShopItem(input: {
    sessionId: string;
    userId: string;
    itemId: string;
    quantity?: number;
  }): {
    shop: DndShopRecord;
    item: DndShopItemRecord;
    purchasedQuantity: number;
    totalCost: number;
    player: DndPlayerRecord;
    sheet: DndCharacterSheet;
    inventoryItem: DndInventoryItemRecord;
  } {
    const details = this.requireDetails(input.sessionId);
    const player = requirePlayer(details.players, input.userId);
    const active = this.store.getActiveShop(input.sessionId);
    if (!active) {
      throw new Error('There is no open shop right now.');
    }
    const shopItem = this.store.getShopItem(input.itemId);
    if (!shopItem || shopItem.shopId !== active.id) {
      throw new Error('That item is not sold in the active shop.');
    }
    const quantity = Math.max(1, Math.min(999, Math.floor(input.quantity ?? 1)));
    if (shopItem.stock < quantity) {
      throw new Error(`Only ${shopItem.stock} of ${shopItem.name} remain in stock.`);
    }

    const totalCost = shopItem.priceGp * quantity;
    const sheet = parseCharacterSheet(player.characterSheetJson);
    if (sheet.gold < totalCost) {
      throw new Error(`${player.characterName} only has ${sheet.gold} gp.`);
    }

    sheet.gold -= totalCost;
    const updatedPlayer = this.setCharacterSheet(input.sessionId, input.userId, sheet);
    const inventoryItem = this.addInventoryItem({
      sessionId: input.sessionId,
      actorUserId: details.session.hostUserId,
      targetUserId: input.userId,
      name: shopItem.name,
      quantity,
      category: shopItem.category,
      notes: shopItem.notes,
      consumable: looksConsumable(shopItem.name, shopItem.category),
    });
    this.store.updateShopItemStock(shopItem.id, shopItem.stock - quantity);

    return {
      shop: active,
      item: { ...shopItem, stock: shopItem.stock - quantity },
      purchasedQuantity: quantity,
      totalCost,
      player: updatedPlayer,
      sheet,
      inventoryItem,
    };
  }

  provisionCombatLoadouts(sessionId: string): Array<{ userId: string; summary: string }> {
    const details = this.requireDetails(sessionId);
    const results: Array<{ userId: string; summary: string }> = [];

    for (const player of details.players) {
      if (player.status === 'left') continue;
      const classId = player.className?.toLowerCase() ?? player.onboardingState?.selectedClassId ?? null;
      const kit = getCombatKitForClass(classId);
      if (!kit) continue;
      const sheet = parseCharacterSheet(player.characterSheetJson);
      const ownedItems = this.store.listInventoryItems(sessionId, player.userId);
      const alreadyProvisioned = (sheet.knownSkillIds?.length ?? 0) > 0
        && ownedItems.some(item => {
          if (!isAccessibleInventoryItem(item)) return false;
          const metadata = parseInventoryMetadata(item);
          return Boolean(metadata?.weaponId || metadata?.consumableId);
        });
      if (alreadyProvisioned) {
        results.push({ userId: player.userId, summary: buildProvisioningSummary(player, sheet, ownedItems) });
        continue;
      }

      results.push(this.applyCombatLoadout({
        sessionId,
        actorUserId: details.session.hostUserId,
        targetUserId: player.userId,
        skillIds: kit.skillIds,
        items: kit.items,
        equippedWeaponName: kit.equippedWeaponName,
      }));
    }

    return results;
  }

  applyCombatLoadout(input: {
    sessionId: string;
    actorUserId: string;
    targetUserId: string;
    skillIds: string[];
    items: StarterItemTemplate[];
    equippedWeaponName?: string | null;
  }): { userId: string; summary: string } {
    const details = this.requireDetails(input.sessionId);
    const player = requirePlayer(details.players, input.targetUserId);
    if (details.session.hostUserId !== input.actorUserId) {
      ensureHost(details.session, input.actorUserId);
    }

    const sheet = parseCharacterSheet(player.characterSheetJson);
    const ownedItems = this.store.listInventoryItems(input.sessionId, player.userId);
    const knownSkills = new Set(sheet.knownSkillIds ?? []);
    for (const skillId of input.skillIds) {
      if (skillId.trim()) knownSkills.add(skillId.trim());
    }
    sheet.knownSkillIds = Array.from(knownSkills);

    for (const item of input.items) {
      const existing = ownedItems.find(entry => entry.name.toLowerCase() === item.name.toLowerCase());
      const metadataJson = createInventoryMetadataJson(item.metadata);
      if (existing) {
        this.store.updateInventoryItem(existing.id, {
          quantity: Math.max(existing.quantity, item.quantity),
          category: item.category,
          notes: item.notes,
          consumable: item.consumable,
          metadataJson,
        });
        const refreshed = this.store.getInventoryItem(existing.id);
        if (refreshed) {
          const index = ownedItems.findIndex(entry => entry.id === existing.id);
          if (index >= 0) ownedItems[index] = refreshed;
        }
        continue;
      }

      const created = this.addInventoryItem({
        sessionId: input.sessionId,
        actorUserId: details.session.hostUserId,
        targetUserId: player.userId,
        name: item.name,
        quantity: item.quantity,
        category: item.category,
        notes: item.notes,
        consumable: item.consumable,
        metadataJson,
      });
      ownedItems.push(created);
    }

    const desired = input.equippedWeaponName
      ? ownedItems.find(item => item.name.toLowerCase() === input.equippedWeaponName!.toLowerCase())
      : ownedItems.find(item => parseInventoryMetadata(item)?.weaponId);
    if (desired) {
      sheet.equippedWeaponItemId = desired.id;
    }

    this.setCharacterSheet(input.sessionId, player.userId, sheet, player.className ?? undefined, player.race ?? undefined);
    return { userId: player.userId, summary: buildProvisioningSummary(player, sheet, ownedItems) };
  }

  async advanceTurn(sessionId: string, actorUserId: string, engine: any, allowHostOverride = false): Promise<SessionSummary> {
    const details = this.requireDetails(sessionId);
    if (!allowHostOverride) {
      const isHost = details.session.hostUserId === actorUserId;
      if (!isHost && details.session.activePlayerUserId !== actorUserId) {
        throw new Error('Only the active player can end this turn.');
      }
    }

    const combat = parseCombatState(details.session.combatStateJson);
    if (combat?.active) {
      const result = await this.advanceCombatTurn(sessionId, actorUserId, engine, allowHostOverride);
      return result.summary;
    }

    const result = computeNextTurn(details.players, details.session);
    this.store.updateTurnState(sessionId, result);
    return this.requireDetails(sessionId);
  }

  enterCombat(sessionId: string, actorUserId: string, enemyDefinitions?: string | null): { summary: SessionSummary; combat: DndCombatState } {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);

    const players = details.players.filter(player => isEligibleForTurns(player));
    const enemies = parseEnemyDefinitions(enemyDefinitions, players.length);
    let combat = createCombatState(players, enemies);
    const playerSheets = new Map(details.players.map(player => [player.userId, parseCharacterSheet(player.characterSheetJson)]));
    if (combat.order[combat.turnIndex]?.side === 'enemy') {
      const enemyResult = runEnemyTurns({
        combat,
        players: details.players,
        playerSheets,
      });
      for (const update of enemyResult.playerUpdates) {
        const player = requirePlayer(details.players, update.userId);
        this.setCharacterSheet(sessionId, update.userId, update.sheet, player.className ?? undefined, player.race ?? undefined);
        playerSheets.set(update.userId, update.sheet);
      }
      combat = enemyResult.combat;
    }

    if (combat.order.length === 0) {
      throw new Error('No available players can enter combat right now.');
    }

    this.store.updateCombatState(sessionId, combat);
    this.store.updateSessionWorldState(sessionId, {
      sceneDanger: 'danger',
      safeRest: false,
      restInProgress: false,
      restStartedAt: null,
      restType: null,
    });
    this.store.updateTurnState(sessionId, {
      activePlayerUserId: combat.active && combat.order[combat.turnIndex]?.side === 'player'
        ? combat.order[combat.turnIndex].userId
        : null,
      roundNumber: combat.round,
      turnNumber: 1,
    });

    return {
      summary: this.requireDetails(sessionId),
      combat,
    };
  }

  getCombatState(sessionId: string): DndCombatState | null {
    const details = this.requireDetails(sessionId);
    return parseCombatState(details.session.combatStateJson);
  }

  async submitCombatAction(sessionId: string, actorUserId: string, actionInput: string | any, engine: any): Promise<{
    summary: SessionSummary;
    combat: DndCombatState;
    status: 'waiting' | 'resolved';
    waitingOn: string[];
    messages: string[];
    roundNarrative: string[];
  }> {
    const details = this.requireDetails(sessionId);
    const combat = requireCombat(details.session);

    if (!combat.active) {
      throw new Error('Combat is not active.');
    }

    // Validate actor is a living player in combat
    const actor = requirePlayer(details.players, actorUserId);
    if (!isEligibleForTurns(actor)) {
      throw new Error('You cannot act while incapacitated or not in the party.');
    }

    // Record the action
    const pending = combat.pendingPlayerActions || {};
    if (typeof actionInput === 'string') {
      pending[actorUserId] = {
        actionText: actionInput.trim(),
        submittedAt: Date.now(),
      };
    } else {
      pending[actorUserId] = {
        actionText: actionInput.actionText || 'Acts decisively.',
        actionJson: JSON.stringify(actionInput),
        submittedAt: Date.now(),
      };
    }
    combat.pendingPlayerActions = pending;

    this.store.updateCombatState(sessionId, combat);

    // Check if everyone is ready
    const livingPlayers = details.players.filter(p => isEligibleForTurns(p));
    const readyPlayers = Object.keys(pending);
    const waitingOn = livingPlayers
      .filter(p => !readyPlayers.includes(p.userId))
      .map(p => p.characterName);

    if (waitingOn.length > 0) {
      return {
        summary: this.requireDetails(sessionId),
        combat,
        status: 'waiting',
        waitingOn,
        messages: [],
        roundNarrative: [],
      };
    }

    // Everyone is ready! Resolve the round
    const resolution = await this.resolveCombatRoundWithNarrative(sessionId, engine);
    return {
      summary: this.requireDetails(sessionId),
      combat: resolution.combat,
      status: 'resolved',
      waitingOn: [],
      messages: resolution.messages,
      roundNarrative: resolution.roundNarrative,
    };
  }

  private resolveCombatRoundInternal(
    sessionId: string,
    combat: DndCombatState,
    players: DndPlayerRecord[],
    playerSheets: Map<string, DndCharacterSheet>,
  ): {
    summary: SessionSummary;
    combat: DndCombatState;
    status: 'resolved';
    waitingOn: string[];
    messages: string[];
    roundNarrative: string[];
  } {
    const result = resolveCombatRound({
      combat,
      players,
      playerSheets,
      getInventory: (userId: string) => this.store.listInventoryItems(sessionId, userId),
    });

    for (const update of result.playerUpdates) {
      const player = requirePlayer(players, update.userId);
      this.setCharacterSheet(sessionId, update.userId, update.sheet, player.className ?? undefined, player.race ?? undefined);
      playerSheets.set(update.userId, update.sheet);
    }
    for (const update of result.inventoryUpdates) {
      this.store.updateInventoryItem(update.id, {
        quantity: update.quantity,
        category: update.category,
        notes: update.notes,
        consumable: update.consumable,
        metadataJson: update.metadataJson,
      });
    }
    for (const itemId of result.removedInventoryItemIds) {
      this.store.deleteInventoryItem(itemId);
    }

    const finalCombat = result.combat;
    this.store.updateCombatState(sessionId, finalCombat.active ? finalCombat : { ...finalCombat, active: false });
    this.store.updateTurnState(sessionId, {
      activePlayerUserId: null,
      roundNumber: finalCombat.round,
      turnNumber: combat.round + 1,
    });

    if (!finalCombat.active) {
      this.store.updateSessionWorldState(sessionId, {
        restInProgress: false,
        restStartedAt: null,
        restType: null,
      });
    }

    return {
      summary: this.requireDetails(sessionId),
      combat: finalCombat,
      status: 'resolved',
      waitingOn: [],
      messages: result.messages,
      roundNarrative: result.roundNarrative,
    };
  }

  /**
   * Host can force-resolve a combat round, skipping any players who haven't submitted.
   */
  async advanceCombatTurn(sessionId: string, actorUserId: string, engine: any, allowHostOverride = false): Promise<{ summary: SessionSummary; combat: DndCombatState; messages: string[]; roundNarrative: string[] }> {
    const details = this.requireDetails(sessionId);
    const combat = requireCombat(details.session);

    const isHost = details.session.hostUserId === actorUserId;
    if (!allowHostOverride && !isHost) {
      throw new Error('Only the host can force-resolve a combat round.');
    }

    const playerSheets = new Map(details.players.map(player => [player.userId, parseCharacterSheet(player.characterSheetJson)]));
    const result = await this.resolveCombatRoundWithNarrative(sessionId, engine);

    return {
      summary: this.requireDetails(sessionId),
      combat: result.combat,
      messages: result.messages,
      roundNarrative: result.roundNarrative,
    };
  }

  getPendingCombatActions(sessionId: string): { combat: DndCombatState; submitted: string[]; waitingOn: string[] } {
    const details = this.requireDetails(sessionId);
    const combat = parseCombatState(details.session.combatStateJson);
    if (!combat?.active) {
      throw new Error('Combat is not active.');
    }

    const playerSheets = new Map(details.players.map(player => [player.userId, parseCharacterSheet(player.characterSheetJson)]));
    const livingPlayers = details.players.filter(p => {
      const sheet = playerSheets.get(p.userId);
      return sheet && sheet.hp > 0 && p.status !== 'left';
    });

    const submitted = livingPlayers
      .filter(p => combat.pendingPlayerActions[p.userId])
      .map(p => p.characterName);
    const waitingOn = livingPlayers
      .filter(p => !combat.pendingPlayerActions[p.userId])
      .map(p => p.characterName);

    return { combat, submitted, waitingOn };
  }

  recordCombatActionMessage(sessionId: string, channelId: string, messageId: string): void {
    const details = this.requireDetails(sessionId);
    const combat = requireCombat(details.session);
    combat.lastActionMessageChannelId = channelId;
    combat.lastActionMessageId = messageId;
    this.store.updateCombatState(sessionId, combat);
  }

  endCombat(
    sessionId: string,
    actorUserId: string,
    xpAward = 0,
    title = 'Combat resolved',
    notes?: string | null,
  ): { summary: SessionSummary; event: DndProgressEvent | null } {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);

    this.store.updateCombatState(sessionId, null);
    this.store.updateSessionWorldState(sessionId, {
      sceneDanger: 'tense',
      restInProgress: false,
      restStartedAt: null,
      restType: null,
    });
    const event = xpAward > 0
      ? this.awardXp(sessionId, actorUserId, 'combat', title, xpAward, notes)
      : null;

    return {
      summary: this.requireDetails(sessionId),
      event,
    };
  }

  restoreNarrativeTurnAfterCombat(
    sessionId: string,
    actorUserId: string,
    preferredActiveUserId?: string | null,
  ): SessionSummary {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);

    const active = findNextAvailablePlayer(details.players, preferredActiveUserId ?? null)
      ?? findNextAvailablePlayer(details.players, null);

    this.store.updateTurnState(sessionId, {
      activePlayerUserId: active?.userId ?? null,
      roundNumber: details.session.roundNumber,
      turnNumber: details.session.turnNumber,
    });

    return this.requireDetails(sessionId);
  }

  fleeCombat(sessionId: string, actorUserId: string): {
    summary: SessionSummary;
    combat: DndCombatState;
    success: boolean;
    message: string;
  } {
    const details = this.requireDetails(sessionId);
    const combat = requireCombat(details.session);
    const active = combat.order[combat.turnIndex];
    if (!active || active.side !== 'player' || active.userId !== actorUserId) {
      throw new Error('It is not your combat turn.');
    }

    const player = requirePlayer(details.players, actorUserId);
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const pursuer = combat.enemies[0];
    const { rollAbilityCheck, formatDiceRoll } = require('./mechanics.js');
    const playerRoll = rollAbilityCheck(sheet.abilities.dex, 0, sheet.exhaustion);
    const enemyRoll = pursuer
      ? rollAbilityCheck(pursuer.abilities.dex ?? 10, 0, 0)
      : { total: 0, notation: 'd20+0', rolls: [0], modifier: 0 };

    const success = playerRoll.total >= enemyRoll.total;
    const message = success
      ? `${player.characterName} escapes the fight. ${formatDiceRoll(playerRoll)} vs ${formatDiceRoll(enemyRoll)}.`
      : `${player.characterName} tries to flee but is cut off. ${formatDiceRoll(playerRoll)} vs ${formatDiceRoll(enemyRoll)}.`;

    if (!success) {
      return { summary: details, combat, success, message };
    }

    const endedCombat: DndCombatState = {
      ...combat,
      active: false,
      victory: 'players',
      log: [
        ...combat.log,
        {
          id: `flee_${Date.now()}`,
          round: combat.round,
          actorName: player.characterName,
          summary: message,
          createdAt: Date.now(),
        },
      ],
    };
    this.store.updateCombatState(sessionId, endedCombat);
    this.store.updateSessionWorldState(sessionId, {
      sceneDanger: 'tense',
      restInProgress: false,
      restStartedAt: null,
      restType: null,
    });
    this.store.updateTurnState(sessionId, {
      activePlayerUserId: actorUserId,
      roundNumber: details.session.roundNumber,
      turnNumber: details.session.turnNumber,
    });
    return { summary: this.requireDetails(sessionId), combat: endedCombat, success, message };
  }

  applyQuestCompletion(
    sessionId: string,
    actorUserId: string,
    title: string,
    xpAward: number,
    notes?: string | null,
  ): { summary: SessionSummary; event: DndProgressEvent } {
    const details = this.requireDetails(sessionId);
    ensureHost(details.session, actorUserId);
    const event = this.awardXp(sessionId, actorUserId, 'quest', title, xpAward, notes);
    return {
      summary: this.requireDetails(sessionId),
      event,
    };
  }

  createSkipTurnVote(input: {
    sessionId: string;
    initiatorUserId: string;
    targetUserId: string;
    reason?: string | null;
    timeoutMs?: number;
  }): DndVoteDetails {
    const details = this.requireDetails(input.sessionId);
    if (details.session.phase !== 'active') {
      throw new Error('Skip votes can only be created while a session is active.');
    }
    if (details.session.currentVoteId) {
      throw new Error('There is already an open vote for this session.');
    }

    const initiator = requirePlayer(details.players, input.initiatorUserId);
    const target = requirePlayer(details.players, input.targetUserId);
    if (target.status === 'left') {
      throw new Error('That player has already left the session.');
    }

    const options: DndVoteOption[] = [
      { id: 'skip', label: 'Skip turns for now' },
      { id: 'wait', label: 'Keep waiting' },
    ];
    const question = input.reason
      ? `Should ${target.characterName} be marked unavailable and skipped? Reason: ${input.reason}`
      : `Should ${target.characterName} be marked unavailable and skipped until they return?`;

    const vote = this.store.createVote({
      id: generateVoteId(),
      sessionId: input.sessionId,
      kind: 'skip_turn',
      targetUserId: input.targetUserId,
      question,
      options,
      createdBy: input.initiatorUserId,
      expiresAt: Date.now() + Math.max(15_000, input.timeoutMs ?? DEFAULT_VOTE_TIMEOUT_MS),
      metadata: {
        initiatorCharacter: initiator.characterName,
        reason: cleanOptional(input.reason),
      },
    });

    return this.store.getVoteDetails(vote.id)!;
  }

  createPartyDecisionVote(input: {
    sessionId: string;
    initiatorUserId: string;
    question: string;
    options: string[];
    timeoutMs?: number;
  }): DndVoteDetails {
    const details = this.requireDetails(input.sessionId);
    ensureHost(details.session, input.initiatorUserId);
    if (details.session.currentVoteId) {
      throw new Error('There is already an open vote for this session.');
    }
    if (parseCombatState(details.session.combatStateJson)?.active) {
      throw new Error('Party decision votes are disabled during combat.');
    }

    const question = input.question.trim();
    if (!question) {
      throw new Error('Vote question cannot be empty.');
    }

    const cleanedOptions = input.options
      .map(option => option.trim())
      .filter(Boolean)
      .slice(0, 4);
    if (cleanedOptions.length < 2) {
      throw new Error('Provide at least two options for a party vote.');
    }

    const vote = this.store.createVote({
      id: generateVoteId(),
      sessionId: input.sessionId,
      kind: 'party_decision',
      targetUserId: '',
      question,
      options: cleanedOptions.map((label, index) => ({
        id: `option_${index + 1}`,
        label,
      })),
      createdBy: input.initiatorUserId,
      expiresAt: Date.now() + Math.max(30_000, input.timeoutMs ?? 120_000),
      metadata: {
        initiatorUserId: input.initiatorUserId,
      },
    });

    return this.store.getVoteDetails(vote.id)!;
  }

  attachVoteMessage(voteId: string, channelId: string, messageId: string): void {
    this.store.recordVoteMessage(voteId, channelId, messageId);
  }

  async castVote(voteId: string, voterUserId: string, optionId: string, engine: any): Promise<{ vote: DndVoteDetails; resolved: VoteResolution | null }> {
    const vote = this.requireVote(voteId);
    if (vote.vote.status !== 'open') {
      throw new Error('That vote is no longer open.');
    }

    const details = this.requireDetails(vote.vote.sessionId);
    const voter = requirePlayer(details.players, voterUserId);
    if (voter.status === 'left') {
      throw new Error('Players who have left cannot vote.');
    }
    if (vote.vote.kind === 'skip_turn' && voter.userId === vote.vote.targetUserId) {
      throw new Error('The targeted player cannot vote on their own skip.');
    }
    if (!vote.options.some(option => option.id === optionId)) {
      throw new Error('Unknown vote option.');
    }

    this.store.castBallot(voteId, voterUserId, optionId);
    const updatedVote = this.requireVote(voteId);
    const resolution = await this.tryResolveVote(updatedVote, details.players, engine);
    return {
      vote: resolution?.vote ?? updatedVote,
      resolved: resolution,
    };
  }

  async resolveExpiredVote(voteId: string, engine: any): Promise<VoteResolution | null> {
    const vote = this.requireVote(voteId);
    if (vote.vote.status !== 'open') return null;
    if (vote.vote.expiresAt > Date.now()) return null;
    const details = this.requireDetails(vote.vote.sessionId);
    return await this.forceResolveVote(vote, details.players, engine);
  }

  listOpenVotes(): DndVoteRecord[] {
    return this.store.listOpenVotes();
  }

  getVote(voteId: string): DndVoteDetails | null {
    return this.store.getVoteDetails(voteId);
  }

  private async tryResolveVote(vote: DndVoteDetails, players: DndPlayerRecord[], engine: any): Promise<VoteResolution | null> {
    const eligibleVoters = players.filter(player => player.userId !== vote.vote.targetUserId && player.status !== 'left');
    const tally = tallyVotes(vote);
    const majority = Math.floor(eligibleVoters.length / 2) + 1;
    const hasMajority = vote.options.some(option => (tally[option.id] ?? 0) >= majority);

    if (hasMajority || vote.ballots.length >= eligibleVoters.length) {
      return await this.forceResolveVote(vote, players, engine);
    }

    return null;
  }

  private async forceResolveVote(vote: DndVoteDetails, players: DndPlayerRecord[], engine: any): Promise<VoteResolution> {
    const tally = tallyVotes(vote);
    const winningOption = [...vote.options]
      .sort((a, b) => {
        const countDiff = (tally[b.id] ?? 0) - (tally[a.id] ?? 0);
        if (countDiff !== 0) return countDiff;
        return a.label.localeCompare(b.label);
      })[0];
    const winningOptionId = winningOption?.id ?? vote.options[0]?.id ?? 'unknown';
    const winningOptionLabel = winningOption?.label ?? winningOptionId;

    this.store.resolveVote(vote.vote.id, winningOptionId);

    if (vote.vote.kind === 'skip_turn' && winningOptionId === 'skip') {
      this.store.updatePlayerStatus(vote.vote.sessionId, vote.vote.targetUserId, 'unavailable');
      const refreshed = this.requireDetails(vote.vote.sessionId);
      if (refreshed.session.activePlayerUserId === vote.vote.targetUserId) {
        const advanced = await this.advanceTurn(vote.vote.sessionId, refreshed.session.hostUserId, engine, true);
        return {
          vote: this.requireVote(vote.vote.id),
          winningOptionId,
          winningOptionLabel,
          shouldSkipTarget: true,
          targetPlayer: advanced.players.find(player => player.userId === vote.vote.targetUserId) ?? null,
          session: advanced.session,
          players: advanced.players,
        };
      }
    }

    const refreshed = this.requireDetails(vote.vote.sessionId);
    return {
      vote: this.requireVote(vote.vote.id),
      winningOptionId,
      winningOptionLabel,
      shouldSkipTarget: vote.vote.kind === 'skip_turn' && winningOptionId === 'skip',
      targetPlayer: refreshed.players.find(player => player.userId === vote.vote.targetUserId) ?? null,
      session: refreshed.session,
      players: refreshed.players,
    };
  }

  private awardXp(
    sessionId: string,
    actorUserId: string,
    type: DndProgressEvent['type'],
    title: string,
    xpAward: number,
    notes?: string | null,
  ): DndProgressEvent {
    const details = this.requireDetails(sessionId);
    const recipients = details.players.filter(player => player.status !== 'left');
    if (recipients.length === 0) {
      throw new Error('There are no players to award XP to.');
    }

    const share = Math.max(0, Math.floor(xpAward / recipients.length));
    for (const player of recipients) {
      const sheet = parseCharacterSheet(player.characterSheetJson);
      const updated = applyXp(sheet, share);
      this.store.upsertPlayer(sessionId, {
        userId: player.userId,
        displayName: player.displayName,
        characterName: player.characterName,
        className: player.className,
        race: player.race,
        characterSheet: updated,
        isHost: player.isHost,
        status: player.status,
      });
    }

    const event: DndProgressEvent = {
      id: generateProgressEventId(),
      type,
      title,
      xpAward,
      createdAt: Date.now(),
      createdBy: actorUserId,
      notes: cleanOptional(notes),
    };
    this.store.appendProgressEvent(sessionId, event);
    return event;
  }

  private requireVote(voteId: string): DndVoteDetails {
    const vote = this.store.getVoteDetails(voteId);
    if (!vote) {
      throw new Error(`Unknown vote: ${voteId}`);
    }
    return vote;
  }

  async resolveCombatRoundWithNarrative(sessionId: string, engine: any): Promise<RoundResolutionResult> {
    const details = this.requireDetails(sessionId);
    const combat = parseCombatState(details.session.combatStateJson);
    if (!combat) throw new Error('Combat not active.');

    const players = details.players;
    const playerSheets = new Map(players.map(p => [p.userId, parseCharacterSheet(p.characterSheetJson)]));

    const result = resolveCombatRound({
      combat,
      players,
      playerSheets,
      getInventory: (userId) => this.getInventory(sessionId, userId),
    });


    // First, persist the mechanical changes so we don't lose progress if narration fails
    this.store.updateCombatState(sessionId, result.combat);
    for (const update of result.playerUpdates) {
      const player = players.find(p => p.userId === update.userId)!;
      this.store.upsertPlayer(sessionId, {
        ...player,
        characterSheet: update.sheet,
      });
    }

    // Ask GM to narrate the round
    try {
      const prompt = `Narrate this combat round in 2-3 immersive, visceral sentences per action. Combine them into a single cohesive story of the round.
Characters and actions:
${result.roundNarrative.join('\n')}

Mechanical outcomes:
${result.messages.join('\n')}

The narrative should be cinematic and match the campaign tone. Don't mention specific damage numbers or HP, describe the impact and the feeling of the combat.`;

      const narrative = await engine.generateText(prompt, { system: "You are an expert Dungeon Master narrating a cinematic combat round." });
      result.combat.lastRoundNarrative = narrative.trim();

      // Update with the narrative
      this.store.updateCombatState(sessionId, result.combat);
    } catch (error: any) {
      log.warn({ error: error.message, sessionId }, 'Failed to generate combat narrative, falling back to basic summary');
      result.combat.lastRoundNarrative = "The clash of steel and magic echoes as the round resolves. " + result.messages.join(' ');
      this.store.updateCombatState(sessionId, result.combat);
    }

    return result;
  }

  private requireDetails(sessionId: string): DndSessionDetails {
    const details = this.store.getSessionDetails(sessionId);
    if (!details) throw new Error('Session not found.');
    return details;
  }

  private requirePlayerInSession(sessionId: string, userId: string): DndPlayerRecord {
    const details = this.requireDetails(sessionId);
    const player = details.players.find(p => p.userId === userId);
    if (!player) throw new Error('You are not part of this session.');
    return player;
  }

  private requireCombat(session: DndSessionRecord): DndCombatState {
    const combat = parseCombatState(session.combatStateJson);
    if (!combat || !combat.active) throw new Error('Combat is not active.');
    return combat;
  }

  private requireTurn(session: DndSessionRecord, userId: string): void {
    if (session.activePlayerUserId !== userId) {
      throw new Error('It is not your turn.');
    }
  }
}

function ensureHost(session: DndSessionRecord, actorUserId: string): void {
  if (session.hostUserId !== actorUserId) {
    throw new Error('Only the session host can do that.');
  }
}

function ensureSessionJoinable(session: DndSessionRecord): void {
  if (session.phase === 'completed') {
    throw new Error('That session has already ended.');
  }
}

function ensureRestAllowed(session: DndSessionRecord, type: 'short' | 'long'): void {
  if (!session.safeRest || session.sceneDanger === 'danger') {
    throw new Error(`${type === 'long' ? 'Long' : 'Short'} rests require a safe scene.`);
  }
  if (session.restInProgress) {
    throw new Error('A rest is already in progress.');
  }
}

function requirePlayer(players: DndPlayerRecord[], userId: string): DndPlayerRecord {
  const player = players.find(entry => entry.userId === userId);
  if (!player) {
    throw new Error('You are not part of this session.');
  }
  return player;
}

function clampPlayerCount(count: number): number {
  return Math.max(1, Math.min(8, Math.floor(count)));
}

function cleanOptional(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeOnboardingState(state?: DndOnboardingState | null): DndOnboardingState {
  const rolledStats = Array.isArray(state?.rolledStats)
    ? state.rolledStats.filter(value => Number.isFinite(value)).map(value => Math.floor(value))
    : [];
  const selectedClassId = state?.selectedClassId ?? null;
  const allocated = Boolean(state?.allocated);

  let step: DndOnboardingStep = 'intro';
  if (allocated && selectedClassId && rolledStats.length === 6) {
    step = 'completed';
  } else if (selectedClassId) {
    step = 'class_selected';
  } else if (rolledStats.length === 6) {
    step = 'rolled';
  }

  return {
    step,
    rolledStats,
    selectedClassId,
    allocated,
  };
}

function generateSessionId(): string {
  return `LC-${randomBase36(6).toUpperCase()}`;
}

function generateCheckpointId(): string {
  return `CP-${randomBase36(8).toUpperCase()}`;
}

function generateVoteId(): string {
  return `V-${randomBase36(8).toUpperCase()}`;
}

function generateProgressEventId(): string {
  return `P-${randomBase36(8).toUpperCase()}`;
}

function generateInventoryItemId(): string {
  return `I-${randomBase36(8).toUpperCase()}`;
}

function generateShopId(): string {
  return `S-${randomBase36(8).toUpperCase()}`;
}

function generateShopItemId(): string {
  return `SI-${randomBase36(8).toUpperCase()}`;
}

function looksConsumable(name: string, category?: string | null): boolean {
  const text = `${name} ${category ?? ''}`.toLowerCase();
  return ['potion', 'scroll', 'ammo', 'ammunition', 'food', 'rations'].some(token => text.includes(token));
}

function randomBase36(length: number): string {
  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, '0');
}

function isEligibleForTurns(player: DndPlayerRecord): boolean {
  return player.status === 'available' || player.status === 'joined';
}

function findNextAvailablePlayer(players: DndPlayerRecord[], currentUserId?: string | null): DndPlayerRecord | null {
  const eligible = players.filter(isEligibleForTurns);
  if (eligible.length === 0) return null;
  if (!currentUserId) return eligible[0] ?? null;

  const startIndex = eligible.findIndex(player => player.userId === currentUserId);
  if (startIndex === -1) return eligible[0] ?? null;
  return eligible[(startIndex + 1) % eligible.length] ?? null;
}

function computeNextTurn(players: DndPlayerRecord[], session: DndSessionRecord): {
  activePlayerUserId: string | null;
  roundNumber: number;
  turnNumber: number;
} {
  const eligible = players.filter(isEligibleForTurns);
  if (eligible.length === 0) {
    return {
      activePlayerUserId: null,
      roundNumber: session.roundNumber,
      turnNumber: session.turnNumber,
    };
  }

  if (!session.activePlayerUserId) {
    return {
      activePlayerUserId: eligible[0].userId,
      roundNumber: session.roundNumber,
      turnNumber: session.turnNumber,
    };
  }

  const index = eligible.findIndex(player => player.userId === session.activePlayerUserId);
  if (index === -1) {
    return {
      activePlayerUserId: eligible[0].userId,
      roundNumber: session.roundNumber,
      turnNumber: session.turnNumber + 1,
    };
  }

  const nextIndex = (index + 1) % eligible.length;
  const wrapped = nextIndex <= index;
  return {
    activePlayerUserId: eligible[nextIndex].userId,
    roundNumber: wrapped ? session.roundNumber + 1 : session.roundNumber,
    turnNumber: session.turnNumber + 1,
  };
}

function tallyVotes(vote: DndVoteDetails): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const ballot of vote.ballots) {
    counts[ballot.optionId] = (counts[ballot.optionId] ?? 0) + 1;
  }
  return counts;
}

export function createDefaultCharacterSheet(): DndCharacterSheet {
  const deathSaves: DndDeathSaveState = {
    successes: 0,
    failures: 0,
    stable: false,
    dead: false,
  };
  return {
    level: 1,
    xp: 0,
    gold: 0,
    maxHp: 10,
    hp: 10,
    tempHp: 0,
    ac: 10,
    speed: 30,
    proficiencyBonus: 2,
    inspiration: false,
    passivePerception: 10,
    abilities: {
      str: 10,
      dex: 10,
      con: 10,
      int: 10,
      wis: 10,
      cha: 10,
    },
    conditions: [],
    exhaustion: 0,
    deathSaves,
    hitDieMax: 10,
    knownSkillIds: [],
    equippedWeaponItemId: null,
    notes: '',
  };
}

export function getPlayerOnboardingState(player: DndPlayerRecord): DndOnboardingState {
  return normalizeOnboardingState(player.onboardingState);
}

export function isPlayerOnboardingComplete(player: DndPlayerRecord): boolean {
  const onboarding = normalizeOnboardingState(player.onboardingState);
  return onboarding.allocated && Boolean(onboarding.selectedClassId) && onboarding.rolledStats.length === 6;
}

export function parseCharacterSheet(sheetJson: string | null): DndCharacterSheet {
  if (!sheetJson) return createDefaultCharacterSheet();
  try {
    const parsed = JSON.parse(sheetJson) as Partial<DndCharacterSheet>;
    return {
      ...createDefaultCharacterSheet(),
      ...parsed,
      abilities: {
        ...createDefaultCharacterSheet().abilities,
        ...(parsed.abilities ?? {}),
      },
      conditions: Array.isArray(parsed.conditions) ? parsed.conditions : [],
      exhaustion: typeof parsed.exhaustion === 'number' ? parsed.exhaustion : 0,
      deathSaves: parsed.deathSaves && typeof parsed.deathSaves === 'object'
        ? {
          successes: typeof parsed.deathSaves.successes === 'number' ? parsed.deathSaves.successes : 0,
          failures: typeof parsed.deathSaves.failures === 'number' ? parsed.deathSaves.failures : 0,
          stable: Boolean(parsed.deathSaves.stable),
          dead: Boolean(parsed.deathSaves.dead),
        }
        : createDefaultCharacterSheet().deathSaves,
      hitDieMax: typeof parsed.hitDieMax === 'number' ? parsed.hitDieMax : 10,
      gold: typeof parsed.gold === 'number' ? parsed.gold : 0,
      tempHp: typeof parsed.tempHp === 'number' ? parsed.tempHp : 0,
      knownSkillIds: Array.isArray(parsed.knownSkillIds) ? parsed.knownSkillIds.map(value => String(value)) : [],
      equippedWeaponItemId: typeof parsed.equippedWeaponItemId === 'string' ? parsed.equippedWeaponItemId : null,
    };
  } catch {
    return createDefaultCharacterSheet();
  }
}

export function parseCombatState(raw: string | null): DndCombatState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DndCombatState>;
    return {
      active: Boolean(parsed.active),
      round: typeof parsed.round === 'number' ? parsed.round : 1,
      turnIndex: typeof parsed.turnIndex === 'number' ? parsed.turnIndex : 0,
      order: Array.isArray(parsed.order)
        ? parsed.order.map((entry: any, index) => ({
          id: typeof entry?.id === 'string' ? entry.id : `${entry?.side === 'enemy' ? 'enemy' : 'player'}:${entry?.userId ?? index}`,
          side: entry?.side === 'enemy' ? 'enemy' : 'player',
          userId: typeof entry?.userId === 'string' ? entry.userId : '',
          characterName: typeof entry?.characterName === 'string' ? entry.characterName : 'Unknown',
          initiative: typeof entry?.initiative === 'number' ? entry.initiative : 0,
        }))
        : [],
      enemies: Array.isArray(parsed.enemies) ? parsed.enemies : [],
      log: Array.isArray(parsed.log) ? parsed.log : [],
      skillUsesByActor: parsed.skillUsesByActor && typeof parsed.skillUsesByActor === 'object' ? parsed.skillUsesByActor : {},
      victory: parsed.victory === 'players' || parsed.victory === 'enemies' ? parsed.victory : null,
      lastActionMessageChannelId: parsed.lastActionMessageChannelId ?? null,
      lastActionMessageId: parsed.lastActionMessageId ?? null,
      activeEffects: parsed.activeEffects ?? [],
      lastRoundNarrative: parsed.lastRoundNarrative ?? null,
      pendingPlayerActions: parsed.pendingPlayerActions && typeof parsed.pendingPlayerActions === 'object'
        ? parsed.pendingPlayerActions as Record<string, { actionText: string; submittedAt: number }>
        : {},
    };
  } catch {
    return null;
  }
}

function requireCombat(session: DndSessionRecord): DndCombatState {
  const combat = parseCombatState(session.combatStateJson);
  if (!combat?.active || combat.order.length === 0) {
    throw new Error('Combat is not currently active in this session.');
  }
  return combat;
}

function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

function rollInitiative(sheet: DndCharacterSheet): number {
  return Math.floor(Math.random() * 20) + 1 + abilityModifier(sheet.abilities.dex);
}

function applyXp(sheet: DndCharacterSheet, xpGain: number): DndCharacterSheet {
  const nextXp = Math.max(0, sheet.xp + xpGain);
  const nextLevel = levelForXp(nextXp);
  const previousLevel = sheet.level;
  const levelDelta = Math.max(0, nextLevel - previousLevel);
  const hpGain = levelDelta > 0 ? levelDelta * Math.max(1, 5 + abilityModifier(sheet.abilities.con)) : 0;

  return {
    ...sheet,
    xp: nextXp,
    level: nextLevel,
    proficiencyBonus: proficiencyBonusForLevel(nextLevel),
    maxHp: sheet.maxHp + hpGain,
    hp: Math.min(sheet.maxHp + hpGain, sheet.hp + hpGain),
  };
}

function levelForXp(xp: number): number {
  for (let level = LEVEL_THRESHOLDS.length; level >= 1; level--) {
    if (xp >= LEVEL_THRESHOLDS[level - 1]) return level;
  }
  return 1;
}

function proficiencyBonusForLevel(level: number): number {
  if (level >= 17) return 6;
  if (level >= 13) return 5;
  if (level >= 9) return 4;
  if (level >= 5) return 3;
  return 2;
}

function normalizeDowntimeMinutes(minutes: number): number {
  const allowed = [15, 30, 60, 180, 360];
  const requested = Math.max(15, Math.min(360, Math.floor(minutes)));
  return allowed.reduce((closest, current) =>
    Math.abs(current - requested) < Math.abs(closest - requested) ? current : closest,
    allowed[0]);
}

function legacyWeeksToMinutes(weeks: number): number {
  const clamped = Math.max(1, Math.min(4, Math.floor(weeks)));
  if (clamped <= 1) return 60;
  if (clamped === 2) return 180;
  return 360;
}

function downtimeEffortUnits(durationMinutes: number): number {
  if (durationMinutes >= 360) return 8;
  if (durationMinutes >= 180) return 5;
  if (durationMinutes >= 60) return 3;
  if (durationMinutes >= 30) return 2;
  return 1;
}

function generateDowntimeId(): string {
  return `DT-${randomBase36(8).toUpperCase()}`;
}

function formatAbsoluteDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function keyedProgress(
  existing: DndDowntimeProgressRecord | null,
  progressKey: string,
  label: string,
  addProgress: number,
  target: number,
): DndDowntimeProgressRecord {
  const current = existing?.completedAt ? 0 : (existing?.progress ?? 0);
  return {
    sessionId: existing?.sessionId ?? '',
    userId: existing?.userId ?? '',
    progressKey,
    label,
    progress: Math.min(target, current + addProgress),
    target,
    updatedAt: Date.now(),
    completedAt: null,
  };
}

function resolveDowntimeActivity(args: {
  activityId: DndDowntimeActivityId;
  focus: string | null;
  durationMinutes: number;
  itemValue: number | null;
  player: DndPlayerRecord;
  sheet: DndCharacterSheet;
  now: number;
  getProgress: (key: string) => DndDowntimeProgressRecord | null;
}): {
  sheet: DndCharacterSheet;
  focus: string | null;
  durationDays: number;
  cooldownUntil: number;
  createdAt: number;
  goldBefore: number;
  goldDelta: number;
  summary: string;
  details: Record<string, unknown>;
  progressUpdates: Array<{
    progressKey: string;
    label: string;
    progress: number;
    target: number;
  }>;
} {
  const { activityId, focus, durationMinutes, itemValue, player, sheet, now, getProgress } = args;
  const goldBefore = sheet.gold;
  const effort = downtimeEffortUnits(durationMinutes);
  const progressUpdates: Array<{ progressKey: string; label: string; progress: number; target: number }> = [];
  const durationDays = durationMinutes / (24 * 60);
  const cooldownUntil = now + (durationMinutes * 60 * 1000);

  switch (activityId) {
    case 'work': {
      const rolls = Array.from({ length: effort }, () => Math.floor(Math.random() * 4) + 1);
      const goldDelta = rolls.reduce((sum, roll) => sum + (roll * Math.max(1, sheet.proficiencyBonus - 1)), 0);
      return {
        sheet: { ...sheet, gold: goldBefore + goldDelta },
        focus,
        durationDays,
        cooldownUntil,
        createdAt: now,
        goldBefore,
        goldDelta,
        summary: `${player.characterName} worked for ${formatDowntimeDuration(durationMinutes)} and earned ${goldDelta} gp.`,
        details: { rolls, durationMinutes, effort },
        progressUpdates,
      };
    }
    case 'training': {
      const topic = focus ?? 'new proficiency';
      const cost = effort * 5;
      if (goldBefore < cost) {
        throw new Error(`Training costs ${cost} gp for ${formatDowntimeDuration(durationMinutes)}.`);
      }
      const progress = keyedProgress(getProgress(`training:${topic.toLowerCase()}`), `training:${topic.toLowerCase()}`, `Training: ${topic}`, effort, 8);
      progressUpdates.push({
        progressKey: progress.progressKey,
        label: progress.label,
        progress: progress.progress,
        target: progress.target,
      });
      const completed = progress.progress >= progress.target;
      return {
        sheet: { ...sheet, gold: goldBefore - cost },
        focus: topic,
        durationDays,
        cooldownUntil,
        createdAt: now,
        goldBefore,
        goldDelta: -cost,
        summary: completed
          ? `${player.characterName} completed training in ${topic}.`
          : `${player.characterName} trained in ${topic} for ${formatDowntimeDuration(durationMinutes)} (${progress.progress}/8 effort).`,
        details: { durationMinutes, effort, completed },
        progressUpdates,
      };
    }
    case 'crafting': {
      const item = focus ?? 'custom item';
      const marketValue = Math.max(50, Math.min(5000, Math.floor(itemValue ?? 100)));
      const targetEffort = Math.max(2, Math.ceil(marketValue / 75));
      const totalMaterials = Math.ceil(marketValue / 2);
      const materialPerEffort = Math.ceil(totalMaterials / targetEffort);
      const cost = materialPerEffort * effort;
      if (goldBefore < cost) {
        throw new Error(`Crafting ${item} requires ${cost} gp in materials for ${formatDowntimeDuration(durationMinutes)}.`);
      }
      const progress = keyedProgress(getProgress(`crafting:${item.toLowerCase()}`), `crafting:${item.toLowerCase()}`, `Crafting: ${item}`, effort, targetEffort);
      progressUpdates.push({
        progressKey: progress.progressKey,
        label: progress.label,
        progress: progress.progress,
        target: progress.target,
      });
      const completed = progress.progress >= progress.target;
      return {
        sheet: { ...sheet, gold: goldBefore - cost },
        focus: item,
        durationDays,
        cooldownUntil,
        createdAt: now,
        goldBefore,
        goldDelta: -cost,
        summary: completed
          ? `${player.characterName} finished crafting ${item}.`
          : `${player.characterName} crafted ${item} for ${formatDowntimeDuration(durationMinutes)} (${progress.progress}/${targetEffort} effort).`,
        details: { durationMinutes, effort, marketValue, totalMaterials, completed },
        progressUpdates,
      };
    }
    case 'research': {
      const question = focus ?? 'an unresolved mystery';
      const cost = effort * 8;
      if (goldBefore < cost) {
        throw new Error(`Research costs ${cost} gp for ${formatDowntimeDuration(durationMinutes)}.`);
      }
      return {
        sheet: { ...sheet, gold: goldBefore - cost },
        focus: question,
        durationDays,
        cooldownUntil,
        createdAt: now,
        goldBefore,
        goldDelta: -cost,
        summary: `${player.characterName} researched "${question}" for ${formatDowntimeDuration(durationMinutes)}.`,
        details: { durationMinutes, effort },
        progressUpdates,
      };
    }
    case 'recuperating': {
      const roll = Math.floor(Math.random() * 20) + 1;
      const total = roll + abilityModifier(sheet.abilities.con);
      let nextSheet = { ...sheet };
      let effect = 'No extra recovery this time.';
      if (total >= 15) {
        if (nextSheet.exhaustion > 0) {
          nextSheet = { ...nextSheet, exhaustion: Math.max(0, nextSheet.exhaustion - 1) };
          effect = 'Recovered enough to reduce exhaustion by 1.';
        } else if (nextSheet.conditions.length > 0) {
          const [removed, ...rest] = nextSheet.conditions;
          nextSheet = { ...nextSheet, conditions: rest };
          effect = `Recovered enough to clear ${removed}.`;
        } else {
          effect = 'Recovered gracefully, but there were no lingering ailments to clear.';
        }
      }
      return {
        sheet: nextSheet,
        focus,
        durationDays,
        cooldownUntil,
        createdAt: now,
        goldBefore,
        goldDelta: 0,
        summary: `${player.characterName} spent ${formatDowntimeDuration(durationMinutes)} recuperating. ${effect}`,
        details: { roll, total, dc: 15, durationMinutes },
        progressUpdates,
      };
    }
    case 'carousing': {
      const roll = Math.floor(Math.random() * 20) + 1;
      const total = roll + abilityModifier(sheet.abilities.cha);
      let goldDelta = 0;
      let summary = `${player.characterName} caroused for ${formatDowntimeDuration(durationMinutes)} and made some memorable connections.`;
      if (total >= 18) {
        summary = `${player.characterName} made a valuable contact while carousing.`;
      } else if (total <= 8) {
        goldDelta = -Math.min(goldBefore, 5 * effort);
        summary = `${player.characterName} ran into complications while carousing and lost ${Math.abs(goldDelta)} gp covering the fallout.`;
      }
      return {
        sheet: { ...sheet, gold: goldBefore + goldDelta },
        focus,
        durationDays,
        cooldownUntil,
        createdAt: now,
        goldBefore,
        goldDelta,
        summary,
        details: { roll, total, durationMinutes, effort },
        progressUpdates,
      };
    }
    case 'religious_service': {
      const deity = focus ?? 'their faith';
      const roll = Math.floor(Math.random() * 20) + 1 + abilityModifier(sheet.abilities.wis);
      const inspired = roll >= 16 && !sheet.inspiration;
      return {
        sheet: inspired ? { ...sheet, inspiration: true } : sheet,
        focus: deity,
        durationDays,
        cooldownUntil,
        createdAt: now,
        goldBefore,
        goldDelta: 0,
        summary: inspired
          ? `${player.characterName} devoted ${formatDowntimeDuration(durationMinutes)} to ${deity} and returned inspired.`
          : `${player.characterName} devoted ${formatDowntimeDuration(durationMinutes)} to religious service for ${deity}.`,
        details: { durationMinutes, effort, roll, inspired },
        progressUpdates,
      };
    }
    default:
      throw new Error(`Unsupported downtime activity: ${activityId}`);
  }
}

function formatDowntimeDuration(durationMinutes: number): string {
  if (durationMinutes < 60) return `${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`;
  const hours = durationMinutes / 60;
  return Number.isInteger(hours)
    ? `${hours} hour${hours === 1 ? '' : 's'}`
    : `${hours.toFixed(1)} hours`;
}
