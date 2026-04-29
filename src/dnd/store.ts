import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getStateDir } from '../config.js';
import { createLogger } from '../logger.js';
import type {
  CreateDndSessionInput,
  DndBallotRecord,
  DndCheckpointRecord,
  DndCharacterSheet,
  DndCombatState,
  DndDowntimeProgressRecord,
  DndDowntimeRecord,
  DndInventoryItemRecord,
  DndOnboardingState,
  DndPlayerRecord,
  DndProgressEvent,
  DndShopItemRecord,
  DndShopRecord,
  DndPlayerStatus,
  DndSceneState,
  DndSessionDetails,
  DndSessionPhase,
  DndSessionRecord,
  DndSessionSnapshot,
  DndVoteDetails,
  DndVoteKind,
  DndVoteOption,
  DndVoteRecord,
  DndVoteStatus,
} from './types.js';

const log = createLogger('dnd-store');

export class DndStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dataDir = getStateDir();
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const finalPath = dbPath ?? join(dataDir, 'dnd.sqlite');
    this.db = new Database(finalPath);
    this.initialize();
    log.info({ path: finalPath }, 'DND store initialized');
  }

  private initialize(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dnd_sessions (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        host_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        tone TEXT,
        max_players INTEGER NOT NULL,
        phase TEXT NOT NULL,
        active_player_user_id TEXT,
        round_number INTEGER NOT NULL DEFAULT 1,
        turn_number INTEGER NOT NULL DEFAULT 1,
        current_vote_id TEXT,
        combat_state_json TEXT,
        progress_log_json TEXT,
        source_session_id TEXT,
        last_checkpoint_id TEXT,
        notes TEXT,
        world_key TEXT,
        world_info TEXT,
        scene_state_json TEXT,
        safe_rest INTEGER NOT NULL DEFAULT 0,
        scene_danger TEXT NOT NULL DEFAULT 'tense',
        rest_in_progress INTEGER NOT NULL DEFAULT 0,
        rest_started_at_ms INTEGER,
        rest_type TEXT,
        queued_actions_json TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_sessions_thread
        ON dnd_sessions(thread_id, updated_at_ms DESC);

      CREATE INDEX IF NOT EXISTS idx_dnd_sessions_guild_phase
        ON dnd_sessions(guild_id, phase, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS dnd_players (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        character_name TEXT NOT NULL,
        class_name TEXT,
        race TEXT,
        character_sheet_json TEXT,
        status TEXT NOT NULL,
        is_host INTEGER NOT NULL DEFAULT 0,
        turn_order INTEGER NOT NULL,
        joined_at_ms INTEGER NOT NULL,
        last_active_at_ms INTEGER NOT NULL,
        absent_since_ms INTEGER,
        onboarding_json TEXT,
        avatar_url TEXT,
        avatar_source TEXT,
        PRIMARY KEY (session_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_players_session_order
        ON dnd_players(session_id, turn_order, joined_at_ms);

      CREATE TABLE IF NOT EXISTS dnd_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        note TEXT,
        snapshot_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_checkpoints_session
        ON dnd_checkpoints(session_id, created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS dnd_votes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        message_channel_id TEXT,
        message_id TEXT,
        expires_at_ms INTEGER NOT NULL,
        resolved_at_ms INTEGER,
        winning_option_id TEXT,
        metadata_json TEXT,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_votes_session
        ON dnd_votes(session_id, status, created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS dnd_vote_ballots (
        vote_id TEXT NOT NULL,
        voter_user_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (vote_id, voter_user_id)
      );

      CREATE TABLE IF NOT EXISTS dnd_downtime_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        focus TEXT,
        duration_days INTEGER NOT NULL,
        gold_delta INTEGER NOT NULL,
        gold_before INTEGER NOT NULL,
        gold_after INTEGER NOT NULL,
        cooldown_until_ms INTEGER NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT,
        created_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_downtime_records_player
        ON dnd_downtime_records(session_id, user_id, created_at_ms DESC);

      CREATE TABLE IF NOT EXISTS dnd_downtime_progress (
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        progress_key TEXT NOT NULL,
        label TEXT NOT NULL,
        progress INTEGER NOT NULL,
        target INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        PRIMARY KEY (session_id, user_id, progress_key)
      );

      CREATE TABLE IF NOT EXISTS dnd_inventory_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT,
        notes TEXT,
        consumable INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        weight REAL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_inventory_player
        ON dnd_inventory_items(session_id, user_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS dnd_shops (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        opened_by TEXT NOT NULL,
        is_open INTEGER NOT NULL DEFAULT 1,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_shops_session
        ON dnd_shops(session_id, is_open, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS dnd_shop_items (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        name TEXT NOT NULL,
        price_gp INTEGER NOT NULL,
        stock INTEGER NOT NULL,
        category TEXT,
        notes TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_shop_items_shop
        ON dnd_shop_items(shop_id, updated_at_ms DESC);
    `);

    this.ensureColumn('dnd_sessions', 'combat_state_json', 'ALTER TABLE dnd_sessions ADD COLUMN combat_state_json TEXT');
    this.ensureColumn('dnd_sessions', 'progress_log_json', 'ALTER TABLE dnd_sessions ADD COLUMN progress_log_json TEXT');
    this.ensureColumn('dnd_sessions', 'source_session_id', 'ALTER TABLE dnd_sessions ADD COLUMN source_session_id TEXT');
    this.ensureColumn('dnd_sessions', 'last_checkpoint_id', 'ALTER TABLE dnd_sessions ADD COLUMN last_checkpoint_id TEXT');
    this.ensureColumn('dnd_sessions', 'notes', 'ALTER TABLE dnd_sessions ADD COLUMN notes TEXT');
    this.ensureColumn('dnd_sessions', 'world_key', 'ALTER TABLE dnd_sessions ADD COLUMN world_key TEXT');
    this.ensureColumn('dnd_sessions', 'world_info', 'ALTER TABLE dnd_sessions ADD COLUMN world_info TEXT');
    this.ensureColumn('dnd_sessions', 'scene_state_json', 'ALTER TABLE dnd_sessions ADD COLUMN scene_state_json TEXT');
    this.ensureColumn('dnd_sessions', 'safe_rest', 'ALTER TABLE dnd_sessions ADD COLUMN safe_rest INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('dnd_sessions', 'scene_danger', "ALTER TABLE dnd_sessions ADD COLUMN scene_danger TEXT NOT NULL DEFAULT 'tense'");
    this.ensureColumn('dnd_sessions', 'rest_in_progress', 'ALTER TABLE dnd_sessions ADD COLUMN rest_in_progress INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('dnd_sessions', 'rest_started_at_ms', 'ALTER TABLE dnd_sessions ADD COLUMN rest_started_at_ms INTEGER');
    this.ensureColumn('dnd_sessions', 'rest_type', 'ALTER TABLE dnd_sessions ADD COLUMN rest_type TEXT');
    this.ensureColumn('dnd_sessions', 'queued_actions_json', 'ALTER TABLE dnd_sessions ADD COLUMN queued_actions_json TEXT');

    this.ensureColumn('dnd_players', 'character_sheet_json', 'ALTER TABLE dnd_players ADD COLUMN character_sheet_json TEXT');
    this.ensureColumn('dnd_players', 'onboarding_json', 'ALTER TABLE dnd_players ADD COLUMN onboarding_json TEXT');
    this.ensureColumn('dnd_players', 'avatar_url', 'ALTER TABLE dnd_players ADD COLUMN avatar_url TEXT');
    this.ensureColumn('dnd_players', 'avatar_source', 'ALTER TABLE dnd_players ADD COLUMN avatar_source TEXT');

    this.ensureColumn('dnd_votes', 'message_channel_id', 'ALTER TABLE dnd_votes ADD COLUMN message_channel_id TEXT');
    this.ensureColumn('dnd_votes', 'message_id', 'ALTER TABLE dnd_votes ADD COLUMN message_id TEXT');
    this.ensureColumn('dnd_votes', 'metadata_json', 'ALTER TABLE dnd_votes ADD COLUMN metadata_json TEXT');

    this.ensureColumn('dnd_downtime_records', 'details_json', 'ALTER TABLE dnd_downtime_records ADD COLUMN details_json TEXT');

    this.ensureColumn('dnd_inventory_items', 'category', 'ALTER TABLE dnd_inventory_items ADD COLUMN category TEXT');
    this.ensureColumn('dnd_inventory_items', 'notes', 'ALTER TABLE dnd_inventory_items ADD COLUMN notes TEXT');
    this.ensureColumn('dnd_inventory_items', 'consumable', 'ALTER TABLE dnd_inventory_items ADD COLUMN consumable INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('dnd_inventory_items', 'metadata_json', 'ALTER TABLE dnd_inventory_items ADD COLUMN metadata_json TEXT');
    this.ensureColumn('dnd_inventory_items', 'weight', 'ALTER TABLE dnd_inventory_items ADD COLUMN weight REAL');
  }

  close(): void {
    this.db.close();
  }

  createSession(input: CreateDndSessionInput): DndSessionRecord {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO dnd_sessions (
        id, guild_id, channel_id, thread_id, host_user_id, title, tone,
        max_players, phase, active_player_user_id, round_number, turn_number,
        current_vote_id, combat_state_json, progress_log_json, source_session_id, last_checkpoint_id, notes, world_key, world_info, scene_state_json,
        safe_rest, scene_danger, rest_in_progress, rest_started_at_ms, rest_type, queued_actions_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'lobby', NULL, 1, 1, NULL, NULL, '[]', NULL, NULL, NULL, ?, NULL, NULL, 0, 'tense', 0, NULL, NULL, NULL, ?, ?)
    `).run(
      input.id,
      input.guildId,
      input.channelId,
      input.threadId,
      input.hostUserId,
      input.title,
      input.tone ?? null,
      input.maxPlayers,
      input.worldKey ?? null,
      now,
      now,
    );

    return this.getSessionById(input.id)!;
  }

  getSessionById(sessionId: string): DndSessionRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        guild_id as guildId,
        channel_id as channelId,
        thread_id as threadId,
        host_user_id as hostUserId,
        title,
        tone,
        max_players as maxPlayers,
        phase,
        active_player_user_id as activePlayerUserId,
        round_number as roundNumber,
        turn_number as turnNumber,
        current_vote_id as currentVoteId,
        combat_state_json as combatStateJson,
        progress_log_json as progressLogJson,
        source_session_id as sourceSessionId,
        last_checkpoint_id as lastCheckpointId,
        notes,
        world_key as worldKey,
        world_info as worldInfo,
        scene_state_json as sceneStateJson,
        safe_rest as safeRest,
        scene_danger as sceneDanger,
        rest_in_progress as restInProgress,
        rest_started_at_ms as restStartedAt,
        rest_type as restType,
        queued_actions_json as queuedActionsJson,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_sessions
      WHERE id = ?
    `).get(sessionId) as DndSessionRecord | undefined;

    return row
      ? {
          ...row,
          safeRest: Boolean((row as any).safeRest),
          restInProgress: Boolean((row as any).restInProgress),
        }
      : null;
  }

  getSessionByThread(threadId: string): DndSessionRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        guild_id as guildId,
        channel_id as channelId,
        thread_id as threadId,
        host_user_id as hostUserId,
        title,
        tone,
        max_players as maxPlayers,
        phase,
        active_player_user_id as activePlayerUserId,
        round_number as roundNumber,
        turn_number as turnNumber,
        current_vote_id as currentVoteId,
        combat_state_json as combatStateJson,
        progress_log_json as progressLogJson,
        source_session_id as sourceSessionId,
        last_checkpoint_id as lastCheckpointId,
        notes,
        world_key as worldKey,
        world_info as worldInfo,
        scene_state_json as sceneStateJson,
        safe_rest as safeRest,
        scene_danger as sceneDanger,
        rest_in_progress as restInProgress,
        rest_started_at_ms as restStartedAt,
        rest_type as restType,
        queued_actions_json as queuedActionsJson,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_sessions
      WHERE thread_id = ?
      ORDER BY updated_at_ms DESC
      LIMIT 1
    `).get(threadId) as DndSessionRecord | undefined;

    return row
      ? {
          ...row,
          safeRest: Boolean((row as any).safeRest),
          restInProgress: Boolean((row as any).restInProgress),
        }
      : null;
  }

  listSessionsForGuild(guildId: string, includeCompleted = false): DndSessionRecord[] {
    const rows = this.db.prepare(`
      SELECT
        id,
        guild_id as guildId,
        channel_id as channelId,
        thread_id as threadId,
        host_user_id as hostUserId,
        title,
        tone,
        max_players as maxPlayers,
        phase,
        active_player_user_id as activePlayerUserId,
        round_number as roundNumber,
        turn_number as turnNumber,
        current_vote_id as currentVoteId,
        combat_state_json as combatStateJson,
        progress_log_json as progressLogJson,
        source_session_id as sourceSessionId,
        last_checkpoint_id as lastCheckpointId,
        notes,
        world_key as worldKey,
        world_info as worldInfo,
        scene_state_json as sceneStateJson,
        safe_rest as safeRest,
        scene_danger as sceneDanger,
        rest_in_progress as restInProgress,
        rest_started_at_ms as restStartedAt,
        rest_type as restType,
        queued_actions_json as queuedActionsJson,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_sessions
      WHERE guild_id = ?
        AND (? = 1 OR phase <> 'completed')
      ORDER BY updated_at_ms DESC
    `).all(guildId, includeCompleted ? 1 : 0) as DndSessionRecord[];

    return rows.map((row: any) => ({
      ...row,
      safeRest: Boolean(row.safeRest),
      restInProgress: Boolean(row.restInProgress),
    }));
  }

  listOpenVotes(): DndVoteRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        kind,
        status,
        target_user_id as targetUserId,
        question,
        options_json as optionsJson,
        created_by as createdBy,
        message_channel_id as messageChannelId,
        message_id as messageId,
        expires_at_ms as expiresAt,
        resolved_at_ms as resolvedAt,
        winning_option_id as winningOptionId,
        metadata_json as metadataJson,
        created_at_ms as createdAt
      FROM dnd_votes
      WHERE status = 'open'
      ORDER BY expires_at_ms ASC
    `).all() as DndVoteRecord[];
  }

  getPlayers(sessionId: string): DndPlayerRecord[] {
    return this.db.prepare(`
      SELECT
        session_id as sessionId,
        user_id as userId,
        display_name as displayName,
        character_name as characterName,
        class_name as className,
        race,
        character_sheet_json as characterSheetJson,
        status,
        is_host as isHost,
        turn_order as turnOrder,
        joined_at_ms as joinedAt,
        last_active_at_ms as lastActiveAt,
        absent_since_ms as absentSince,
        onboarding_json as onboardingJson,
        avatar_url as avatarUrl,
        avatar_source as avatarSource
      FROM dnd_players
      WHERE session_id = ?
      ORDER BY turn_order ASC, joined_at_ms ASC
    `).all(sessionId).map((row: any) => ({
      ...row,
      isHost: Boolean(row.isHost),
      onboardingState: row.onboardingJson ? JSON.parse(row.onboardingJson) : null,
    })) as DndPlayerRecord[];
  }

  getSessionDetails(sessionId: string): DndSessionDetails | null {
    const session = this.getSessionById(sessionId);
    if (!session) return null;
    return {
      session,
      players: this.getPlayers(sessionId),
      vote: session.currentVoteId ? this.getVoteDetails(session.currentVoteId) : null,
    };
  }

  upsertPlayer(
    sessionId: string,
    user: {
      userId: string;
      displayName: string;
      characterName: string;
      className?: string | null;
      race?: string | null;
      characterSheet?: DndCharacterSheet | null;
      isHost?: boolean;
      status?: DndPlayerStatus;
      onboardingState?: DndOnboardingState | null;
      avatarUrl?: string | null;
      avatarSource?: 'discord' | 'upload' | 'class_default' | null;
    },
  ): DndPlayerRecord {
    const existing = this.db.prepare(`
      SELECT turn_order as turnOrder
      FROM dnd_players
      WHERE session_id = ? AND user_id = ?
    `).get(sessionId, user.userId) as { turnOrder: number } | undefined;

    const maxOrder = this.db.prepare(`
      SELECT COALESCE(MAX(turn_order), 0) as maxOrder
      FROM dnd_players
      WHERE session_id = ?
    `).get(sessionId) as { maxOrder: number };

    const now = Date.now();
    const turnOrder = existing?.turnOrder ?? (maxOrder.maxOrder + 1);

    this.db.prepare(`
      INSERT INTO dnd_players (
        session_id, user_id, display_name, character_name, class_name, race,
        character_sheet_json, status, is_host, turn_order, joined_at_ms, last_active_at_ms, absent_since_ms, onboarding_json, avatar_url, avatar_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user_id) DO UPDATE SET
        display_name = excluded.display_name,
        character_name = excluded.character_name,
        class_name = excluded.class_name,
        race = excluded.race,
        character_sheet_json = COALESCE(excluded.character_sheet_json, dnd_players.character_sheet_json),
        status = excluded.status,
        is_host = CASE WHEN excluded.is_host = 1 THEN 1 ELSE dnd_players.is_host END,
        last_active_at_ms = excluded.last_active_at_ms,
        absent_since_ms = excluded.absent_since_ms,
        onboarding_json = COALESCE(excluded.onboarding_json, dnd_players.onboarding_json),
        avatar_url = COALESCE(excluded.avatar_url, dnd_players.avatar_url),
        avatar_source = COALESCE(excluded.avatar_source, dnd_players.avatar_source)
    `).run(
      sessionId,
      user.userId,
      user.displayName,
      user.characterName,
      user.className ?? null,
      user.race ?? null,
      user.characterSheet ? JSON.stringify(user.characterSheet) : null,
      user.status ?? 'joined',
      user.isHost ? 1 : 0,
      turnOrder,
      now,
      now,
      user.status === 'unavailable' ? now : null,
      user.onboardingState ? JSON.stringify(user.onboardingState) : null,
      user.avatarUrl ?? null,
      user.avatarSource ?? null,
    );

    this.touchSession(sessionId);
    return this.getPlayers(sessionId).find(player => player.userId === user.userId)!;
  }

  updatePlayerStatus(sessionId: string, userId: string, status: DndPlayerStatus): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE dnd_players
      SET
        status = ?,
        last_active_at_ms = ?,
        absent_since_ms = CASE WHEN ? = 'unavailable' THEN COALESCE(absent_since_ms, ?) ELSE NULL END
      WHERE session_id = ? AND user_id = ?
    `).run(status, now, status, now, sessionId, userId);
    this.touchSession(sessionId);
  }

  updateOnboardingState(sessionId: string, userId: string, state: DndOnboardingState): void {
    this.db.prepare(`
      UPDATE dnd_players
      SET onboarding_json = ?, last_active_at_ms = ?
      WHERE session_id = ? AND user_id = ?
    `).run(JSON.stringify(state), Date.now(), sessionId, userId);
    this.touchSession(sessionId);
  }

  updateSessionPhase(sessionId: string, phase: DndSessionPhase): void {
    this.db.prepare(`
      UPDATE dnd_sessions SET phase = ?, updated_at_ms = ? WHERE id = ?
    `).run(phase, Date.now(), sessionId);
  }

  updateWorldInfo(sessionId: string, worldInfo: string): void {
    this.db.prepare(`
      UPDATE dnd_sessions SET world_info = ?, updated_at_ms = ? WHERE id = ?
    `).run(worldInfo, Date.now(), sessionId);
  }

  updateSceneState(sessionId: string, sceneState: DndSceneState | null): void {
    this.db.prepare(`
      UPDATE dnd_sessions SET scene_state_json = ?, updated_at_ms = ? WHERE id = ?
    `).run(sceneState ? JSON.stringify(sceneState) : null, Date.now(), sessionId);
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
  ): void {
    const existing = this.getSessionById(sessionId);
    if (!existing) return;

    this.db.prepare(`
      UPDATE dnd_sessions
      SET
        safe_rest = ?,
        scene_danger = ?,
        rest_in_progress = ?,
        rest_started_at_ms = ?,
        rest_type = ?,
        queued_actions_json = ?,
        updated_at_ms = ?
      WHERE id = ?
    `).run(
      patch.safeRest !== undefined ? (patch.safeRest ? 1 : 0) : (existing.safeRest ? 1 : 0),
      patch.sceneDanger ?? existing.sceneDanger,
      patch.restInProgress !== undefined ? (patch.restInProgress ? 1 : 0) : (existing.restInProgress ? 1 : 0),
      patch.restStartedAt !== undefined ? patch.restStartedAt : existing.restStartedAt,
      patch.restType !== undefined ? patch.restType : existing.restType,
      patch.queuedActionsJson !== undefined ? patch.queuedActionsJson : existing.queuedActionsJson,
      Date.now(),
      sessionId,
    );
  }

  updateSessionThread(sessionId: string, channelId: string, threadId: string): void {
    this.db.prepare(`
      UPDATE dnd_sessions
      SET channel_id = ?, thread_id = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(channelId, threadId, Date.now(), sessionId);
  }

  updateTurnState(
    sessionId: string,
    state: { activePlayerUserId: string | null; roundNumber: number; turnNumber: number },
  ): void {
    this.db.prepare(`
      UPDATE dnd_sessions
      SET active_player_user_id = ?, round_number = ?, turn_number = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(state.activePlayerUserId, state.roundNumber, state.turnNumber, Date.now(), sessionId);
  }

  updateCurrentVote(sessionId: string, voteId: string | null): void {
    this.db.prepare(`
      UPDATE dnd_sessions
      SET current_vote_id = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(voteId, Date.now(), sessionId);
  }

  updateCombatState(sessionId: string, combatState: DndCombatState | null): void {
    this.db.prepare(`
      UPDATE dnd_sessions
      SET combat_state_json = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(combatState ? JSON.stringify(combatState) : null, Date.now(), sessionId);
  }

  getProgressLog(sessionId: string): DndProgressEvent[] {
    const row = this.db.prepare(`
      SELECT progress_log_json as progressLogJson
      FROM dnd_sessions
      WHERE id = ?
    `).get(sessionId) as { progressLogJson: string | null } | undefined;

    return parseProgressLog(row?.progressLogJson ?? null);
  }

  appendProgressEvent(sessionId: string, event: DndProgressEvent): void {
    const next = [...this.getProgressLog(sessionId), event];
    this.db.prepare(`
      UPDATE dnd_sessions
      SET progress_log_json = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(JSON.stringify(next), Date.now(), sessionId);
  }

  createDowntimeRecord(record: DndDowntimeRecord): void {
    this.db.prepare(`
      INSERT INTO dnd_downtime_records (
        id, session_id, user_id, activity_id, focus, duration_days, gold_delta,
        gold_before, gold_after, cooldown_until_ms, summary, details_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionId,
      record.userId,
      record.activityId,
      record.focus,
      record.durationDays,
      record.goldDelta,
      record.goldBefore,
      record.goldAfter,
      record.cooldownUntil,
      record.summary,
      record.detailsJson,
      record.createdAt,
    );
    this.touchSession(record.sessionId);
  }

  listDowntimeRecords(sessionId: string, userId?: string | null, limit = 10): DndDowntimeRecord[] {
    const sql = userId
      ? `
        SELECT
          id,
          session_id as sessionId,
          user_id as userId,
          activity_id as activityId,
          focus,
          duration_days as durationDays,
          gold_delta as goldDelta,
          gold_before as goldBefore,
          gold_after as goldAfter,
          cooldown_until_ms as cooldownUntil,
          summary,
          details_json as detailsJson,
          created_at_ms as createdAt
        FROM dnd_downtime_records
        WHERE session_id = ? AND user_id = ?
        ORDER BY created_at_ms DESC
        LIMIT ?
      `
      : `
        SELECT
          id,
          session_id as sessionId,
          user_id as userId,
          activity_id as activityId,
          focus,
          duration_days as durationDays,
          gold_delta as goldDelta,
          gold_before as goldBefore,
          gold_after as goldAfter,
          cooldown_until_ms as cooldownUntil,
          summary,
          details_json as detailsJson,
          created_at_ms as createdAt
        FROM dnd_downtime_records
        WHERE session_id = ?
        ORDER BY created_at_ms DESC
        LIMIT ?
      `;

    return (userId
      ? this.db.prepare(sql).all(sessionId, userId, limit)
      : this.db.prepare(sql).all(sessionId, limit)) as DndDowntimeRecord[];
  }

  getLatestDowntimeRecord(sessionId: string, userId: string): DndDowntimeRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        user_id as userId,
        activity_id as activityId,
        focus,
        duration_days as durationDays,
        gold_delta as goldDelta,
        gold_before as goldBefore,
        gold_after as goldAfter,
        cooldown_until_ms as cooldownUntil,
        summary,
        details_json as detailsJson,
        created_at_ms as createdAt
      FROM dnd_downtime_records
      WHERE session_id = ? AND user_id = ?
      ORDER BY created_at_ms DESC
      LIMIT 1
    `).get(sessionId, userId) as DndDowntimeRecord | undefined;

    return row ?? null;
  }

  upsertDowntimeProgress(record: DndDowntimeProgressRecord): void {
    this.db.prepare(`
      INSERT INTO dnd_downtime_progress (
        session_id, user_id, progress_key, label, progress, target, updated_at_ms, completed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, user_id, progress_key) DO UPDATE SET
        label = excluded.label,
        progress = excluded.progress,
        target = excluded.target,
        updated_at_ms = excluded.updated_at_ms,
        completed_at_ms = excluded.completed_at_ms
    `).run(
      record.sessionId,
      record.userId,
      record.progressKey,
      record.label,
      record.progress,
      record.target,
      record.updatedAt,
      record.completedAt,
    );
    this.touchSession(record.sessionId);
  }

  getDowntimeProgress(sessionId: string, userId: string, progressKey: string): DndDowntimeProgressRecord | null {
    const row = this.db.prepare(`
      SELECT
        session_id as sessionId,
        user_id as userId,
        progress_key as progressKey,
        label,
        progress,
        target,
        updated_at_ms as updatedAt,
        completed_at_ms as completedAt
      FROM dnd_downtime_progress
      WHERE session_id = ? AND user_id = ? AND progress_key = ?
      LIMIT 1
    `).get(sessionId, userId, progressKey) as DndDowntimeProgressRecord | undefined;

    return row ?? null;
  }

  listDowntimeProgress(sessionId: string, userId: string): DndDowntimeProgressRecord[] {
    return this.db.prepare(`
      SELECT
        session_id as sessionId,
        user_id as userId,
        progress_key as progressKey,
        label,
        progress,
        target,
        updated_at_ms as updatedAt,
        completed_at_ms as completedAt
      FROM dnd_downtime_progress
      WHERE session_id = ? AND user_id = ?
      ORDER BY updated_at_ms DESC
    `).all(sessionId, userId) as DndDowntimeProgressRecord[];
  }

  createInventoryItem(item: DndInventoryItemRecord): void {
    this.db.prepare(`
      INSERT INTO dnd_inventory_items (
        id, session_id, user_id, name, quantity, category, notes, consumable, metadata_json, weight, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.sessionId,
      item.userId,
      item.name,
      item.quantity,
      item.category,
      item.notes,
      item.consumable ? 1 : 0,
      item.metadataJson,
      item.weight ?? null,
      item.createdAt,
      item.updatedAt,
    );
    this.touchSession(item.sessionId);
  }

  getInventoryItem(itemId: string): DndInventoryItemRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        user_id as userId,
        name,
        quantity,
        category,
        notes,
        consumable,
        metadata_json as metadataJson,
        weight,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_inventory_items
      WHERE id = ?
      LIMIT 1
    `).get(itemId) as any;

    return row ? { ...row, consumable: Boolean(row.consumable) } as DndInventoryItemRecord : null;
  }

  listInventoryItems(sessionId: string, userId: string): DndInventoryItemRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        user_id as userId,
        name,
        quantity,
        category,
        notes,
        consumable,
        metadata_json as metadataJson,
        weight,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_inventory_items
      WHERE session_id = ? AND user_id = ?
      ORDER BY LOWER(name) ASC, updated_at_ms DESC
    `).all(sessionId, userId).map((row: any) => ({
      ...row,
      consumable: Boolean(row.consumable),
    })) as DndInventoryItemRecord[];
  }

  updateInventoryItem(itemId: string, patch: {
    quantity?: number;
    category?: string | null;
    notes?: string | null;
    consumable?: boolean;
    metadataJson?: string | null;
    weight?: number | null;
  }): void {
    const existing = this.getInventoryItem(itemId);
    if (!existing) return;
    this.db.prepare(`
      UPDATE dnd_inventory_items
      SET
        quantity = ?,
        category = ?,
        notes = ?,
        consumable = ?,
        metadata_json = ?,
        weight = ?,
        updated_at_ms = ?
      WHERE id = ?
    `).run(
      patch.quantity ?? existing.quantity,
      patch.category !== undefined ? patch.category : existing.category,
      patch.notes !== undefined ? patch.notes : existing.notes,
      patch.consumable !== undefined ? (patch.consumable ? 1 : 0) : (existing.consumable ? 1 : 0),
      patch.metadataJson !== undefined ? patch.metadataJson : existing.metadataJson,
      patch.weight !== undefined ? patch.weight : existing.weight,
      Date.now(),
      itemId,
    );
    this.touchSession(existing.sessionId);
  }

  deleteInventoryItem(itemId: string): void {
    const existing = this.getInventoryItem(itemId);
    if (!existing) return;
    this.db.prepare(`DELETE FROM dnd_inventory_items WHERE id = ?`).run(itemId);
    this.touchSession(existing.sessionId);
  }

  createShop(shop: DndShopRecord, items: DndShopItemRecord[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`UPDATE dnd_shops SET is_open = 0, updated_at_ms = ? WHERE session_id = ? AND is_open = 1`)
        .run(shop.updatedAt, shop.sessionId);
      this.db.prepare(`
        INSERT INTO dnd_shops (
          id, session_id, name, description, opened_by, is_open, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shop.id,
        shop.sessionId,
        shop.name,
        shop.description,
        shop.openedBy,
        shop.isOpen ? 1 : 0,
        shop.createdAt,
        shop.updatedAt,
      );

      const stmt = this.db.prepare(`
        INSERT INTO dnd_shop_items (
          id, shop_id, name, price_gp, stock, category, notes, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items) {
        stmt.run(
          item.id,
          item.shopId,
          item.name,
          item.priceGp,
          item.stock,
          item.category,
          item.notes,
          item.createdAt,
          item.updatedAt,
        );
      }
    });
    tx();
    this.touchSession(shop.sessionId);
  }

  getActiveShop(sessionId: string): DndShopRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        name,
        description,
        opened_by as openedBy,
        is_open as isOpen,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_shops
      WHERE session_id = ? AND is_open = 1
      ORDER BY updated_at_ms DESC
      LIMIT 1
    `).get(sessionId) as any;
    return row ? { ...row, isOpen: Boolean(row.isOpen) } as DndShopRecord : null;
  }

  listShopItems(shopId: string): DndShopItemRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        shop_id as shopId,
        name,
        price_gp as priceGp,
        stock,
        category,
        notes,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_shop_items
      WHERE shop_id = ?
      ORDER BY LOWER(name) ASC, updated_at_ms DESC
    `).all(shopId) as DndShopItemRecord[];
  }

  getShopItem(itemId: string): DndShopItemRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        shop_id as shopId,
        name,
        price_gp as priceGp,
        stock,
        category,
        notes,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_shop_items
      WHERE id = ?
      LIMIT 1
    `).get(itemId) as DndShopItemRecord | undefined;
    return row ?? null;
  }

  updateShopItemStock(itemId: string, stock: number): void {
    const existing = this.getShopItem(itemId);
    if (!existing) return;
    this.db.prepare(`
      UPDATE dnd_shop_items
      SET stock = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(stock, Date.now(), itemId);
    const shop = this.getShopById(existing.shopId);
    if (shop) this.touchSession(shop.sessionId);
  }

  closeShop(shopId: string): void {
    const shop = this.getShopById(shopId);
    if (!shop) return;
    this.db.prepare(`UPDATE dnd_shops SET is_open = 0, updated_at_ms = ? WHERE id = ?`).run(Date.now(), shopId);
    this.touchSession(shop.sessionId);
  }

  private getShopById(shopId: string): DndShopRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        name,
        description,
        opened_by as openedBy,
        is_open as isOpen,
        created_at_ms as createdAt,
        updated_at_ms as updatedAt
      FROM dnd_shops
      WHERE id = ?
      LIMIT 1
    `).get(shopId) as any;
    return row ? { ...row, isOpen: Boolean(row.isOpen) } as DndShopRecord : null;
  }

  saveCheckpoint(sessionId: string, checkpointId: string, createdBy: string, note?: string | null): DndCheckpointRecord {
    const details = this.getSessionDetails(sessionId);
    if (!details) {
      throw new Error('Session not found for checkpoint');
    }

    const snapshot: DndSessionSnapshot = {
      session: details.session,
      players: details.players,
    };

    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO dnd_checkpoints (id, session_id, note, snapshot_json, created_by, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(checkpointId, sessionId, note ?? null, JSON.stringify(snapshot), createdBy, createdAt);

    this.db.prepare(`
      UPDATE dnd_sessions
      SET last_checkpoint_id = ?, updated_at_ms = ?
      WHERE id = ?
    `).run(checkpointId, createdAt, sessionId);

    return {
      id: checkpointId,
      sessionId,
      note: note ?? null,
      snapshotJson: JSON.stringify(snapshot),
      createdBy,
      createdAt,
    };
  }

  getLatestCheckpoint(sessionId: string): DndCheckpointRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        note,
        snapshot_json as snapshotJson,
        created_by as createdBy,
        created_at_ms as createdAt
      FROM dnd_checkpoints
      WHERE session_id = ?
      ORDER BY created_at_ms DESC
      LIMIT 1
    `).get(sessionId) as DndCheckpointRecord | undefined;

    return row ?? null;
  }

  getCheckpointById(checkpointId: string): DndCheckpointRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        note,
        snapshot_json as snapshotJson,
        created_by as createdBy,
        created_at_ms as createdAt
      FROM dnd_checkpoints
      WHERE id = ?
      LIMIT 1
    `).get(checkpointId) as DndCheckpointRecord | undefined;

    return row ?? null;
  }

  listCheckpoints(sessionId: string, limit = 10): DndCheckpointRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        note,
        snapshot_json as snapshotJson,
        created_by as createdBy,
        created_at_ms as createdAt
      FROM dnd_checkpoints
      WHERE session_id = ?
      ORDER BY created_at_ms DESC
      LIMIT ?
    `).all(sessionId, limit) as DndCheckpointRecord[];
  }

  replaceSessionFromSnapshot(
    targetSessionId: string,
    snapshot: { session: DndSessionRecord; players: DndPlayerRecord[] },
    channelId: string,
    threadId: string,
  ): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE dnd_sessions
        SET
          title = ?,
          tone = ?,
          max_players = ?,
          phase = ?,
          active_player_user_id = ?,
          round_number = ?,
          turn_number = ?,
          current_vote_id = NULL,
          combat_state_json = ?,
          progress_log_json = ?,
          source_session_id = ?,
          last_checkpoint_id = ?,
          notes = ?,
          world_key = ?,
          world_info = ?,
          scene_state_json = ?,
          safe_rest = ?,
          scene_danger = ?,
          rest_in_progress = ?,
          rest_started_at_ms = ?,
          rest_type = ?,
          queued_actions_json = ?,
          channel_id = ?,
          thread_id = ?,
          updated_at_ms = ?
        WHERE id = ?
      `).run(
        snapshot.session.title,
        snapshot.session.tone,
        snapshot.session.maxPlayers,
        snapshot.session.phase,
        snapshot.session.activePlayerUserId,
        snapshot.session.roundNumber,
        snapshot.session.turnNumber,
        snapshot.session.combatStateJson,
        snapshot.session.progressLogJson ?? '[]',
        snapshot.session.sourceSessionId,
        snapshot.session.lastCheckpointId,
        snapshot.session.notes,
        snapshot.session.worldKey,
        snapshot.session.worldInfo,
        snapshot.session.sceneStateJson,
        snapshot.session.safeRest ? 1 : 0,
        snapshot.session.sceneDanger,
        snapshot.session.restInProgress ? 1 : 0,
        snapshot.session.restStartedAt,
        snapshot.session.restType,
        snapshot.session.queuedActionsJson,
        channelId,
        threadId,
        now,
        targetSessionId,
      );

      this.db.prepare(`DELETE FROM dnd_players WHERE session_id = ?`).run(targetSessionId);

      for (const player of snapshot.players) {
        this.db.prepare(`
          INSERT INTO dnd_players (
            session_id, user_id, display_name, character_name, class_name, race, character_sheet_json,
            status, is_host, turn_order, joined_at_ms, last_active_at_ms, absent_since_ms, onboarding_json, avatar_url, avatar_source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          targetSessionId,
          player.userId,
          player.displayName,
          player.characterName,
          player.className,
          player.race,
          player.characterSheetJson,
          player.status,
          player.isHost ? 1 : 0,
          player.turnOrder,
          player.joinedAt,
          player.lastActiveAt,
          player.absentSince,
          player.onboardingState ? JSON.stringify(player.onboardingState) : null,
          player.avatarUrl ?? null,
          player.avatarSource ?? null,
        );
      }
    });

    tx();
  }

  createVote(input: {
    id: string;
    sessionId: string;
    kind: DndVoteKind;
    targetUserId: string;
    question: string;
    options: DndVoteOption[];
    createdBy: string;
    expiresAt: number;
    metadata?: Record<string, unknown>;
  }): DndVoteRecord {
    const createdAt = Date.now();
    this.db.prepare(`
      INSERT INTO dnd_votes (
        id, session_id, kind, status, target_user_id, question, options_json,
        created_by, message_channel_id, message_id, expires_at_ms, resolved_at_ms,
        winning_option_id, metadata_json, created_at_ms
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, ?)
    `).run(
      input.id,
      input.sessionId,
      input.kind,
      input.targetUserId,
      input.question,
      JSON.stringify(input.options),
      input.createdBy,
      input.expiresAt,
      input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt,
    );

    this.updateCurrentVote(input.sessionId, input.id);
    return this.getVote(input.id)!;
  }

  recordVoteMessage(voteId: string, channelId: string, messageId: string): void {
    this.db.prepare(`
      UPDATE dnd_votes
      SET message_channel_id = ?, message_id = ?
      WHERE id = ?
    `).run(channelId, messageId, voteId);
  }

  getVote(voteId: string): DndVoteRecord | null {
    const row = this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        kind,
        status,
        target_user_id as targetUserId,
        question,
        options_json as optionsJson,
        created_by as createdBy,
        message_channel_id as messageChannelId,
        message_id as messageId,
        expires_at_ms as expiresAt,
        resolved_at_ms as resolvedAt,
        winning_option_id as winningOptionId,
        metadata_json as metadataJson,
        created_at_ms as createdAt
      FROM dnd_votes
      WHERE id = ?
    `).get(voteId) as DndVoteRecord | undefined;

    return row ?? null;
  }

  getVoteDetails(voteId: string): DndVoteDetails | null {
    const vote = this.getVote(voteId);
    if (!vote) return null;
    const ballots = this.db.prepare(`
      SELECT vote_id as voteId, voter_user_id as voterUserId, option_id as optionId, created_at_ms as createdAt
      FROM dnd_vote_ballots
      WHERE vote_id = ?
      ORDER BY created_at_ms ASC
    `).all(voteId) as DndBallotRecord[];

    return {
      vote,
      options: parseVoteOptions(vote.optionsJson),
      ballots,
    };
  }

  castBallot(voteId: string, voterUserId: string, optionId: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO dnd_vote_ballots (vote_id, voter_user_id, option_id, created_at_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(vote_id, voter_user_id) DO UPDATE SET
        option_id = excluded.option_id,
        created_at_ms = excluded.created_at_ms
    `).run(voteId, voterUserId, optionId, now);
  }

  resolveVote(voteId: string, winningOptionId: string): void {
    const vote = this.getVote(voteId);
    if (!vote) return;
    const now = Date.now();
    this.db.prepare(`
      UPDATE dnd_votes
      SET status = 'resolved', winning_option_id = ?, resolved_at_ms = ?
      WHERE id = ?
    `).run(winningOptionId, now, voteId);

    this.updateCurrentVote(vote.sessionId, null);
  }

  getVoteBallots(voteId: string): DndBallotRecord[] {
    return this.db.prepare(`
      SELECT vote_id as voteId, voter_user_id as voterUserId, option_id as optionId, created_at_ms as createdAt
      FROM dnd_vote_ballots
      WHERE vote_id = ?
    `).all(voteId) as DndBallotRecord[];
  }

  private touchSession(sessionId: string): void {
    this.db.prepare(`
      UPDATE dnd_sessions
      SET updated_at_ms = ?
      WHERE id = ?
    `).run(Date.now(), sessionId);
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some(row => row.name === column)) return;
    this.db.exec(ddl);
  }
}

function parseVoteOptions(json: string): DndVoteOption[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseProgressLog(json: string | null): DndProgressEvent[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
