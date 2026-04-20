/**
 * LiteClaw — SQLite Memory Store
 * 
 * Per-channel, per-user conversation history with keyword search.
 * Compatible with import from OpenClaw's memory format.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../logger.js';

const log = createLogger('memory');

// ─── Types ───────────────────────────────────────────────────────────

export interface MemoryEntry {
  id?: number;
  sessionKey: string;
  role: string;
  content: string;
  timestamp: number;
  metadata?: string;
}

export interface SessionInfo {
  sessionKey: string;
  messageCount: number;
  lastActivity: number;
  firstActivity: number;
  userIdentifier?: string;
}

// ─── Memory Store ────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dataDir = process.env.LITECLAW_STATE_DIR ??
      join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.liteclaw');

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    const finalPath = dbPath ?? join(dataDir, 'memory.sqlite');
    this.db = new Database(finalPath);
    this.initialize();
    log.info({ path: finalPath }, 'Memory store initialized');
  }

  private initialize(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        metadata TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session
        ON messages(session_key, timestamp);

      CREATE INDEX IF NOT EXISTS idx_messages_content
        ON messages(content);

      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        messages_summarized INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_summaries_session
        ON summaries(session_key, timestamp);
    `);
  }

  /**
   * Save a message to memory.
   */
  saveMessage(entry: MemoryEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_key, role, content, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.sessionKey,
      entry.role,
      entry.content,
      entry.timestamp,
      entry.metadata ?? null
    );
  }

  /**
   * Get recent messages for a session.
   */
  getHistory(sessionKey: string, limit: number = 20): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, session_key as sessionKey, role, content, timestamp, metadata
      FROM messages
      WHERE session_key = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    const rows = stmt.all(sessionKey, limit) as MemoryEntry[];
    return rows.reverse(); // Oldest first
  }

  /**
   * Search messages by keyword across all sessions.
   */
  search(query: string, limit: number = 10): MemoryEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, session_key as sessionKey, role, content, timestamp, metadata
      FROM messages
      WHERE content LIKE ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(`%${query}%`, limit) as MemoryEntry[];
  }

  /**
   * Save a compaction summary.
   */
  saveSummary(sessionKey: string, summary: string, messageCount: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO summaries (session_key, summary, messages_summarized, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(sessionKey, summary, messageCount, Date.now());
  }

  /**
   * Get the latest summary for a session.
   */
  getLatestSummary(sessionKey: string): string | null {
    const stmt = this.db.prepare(`
      SELECT summary FROM summaries
      WHERE session_key = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const row = stmt.get(sessionKey) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  /**
   * List all sessions.
   */
  listSessions(): SessionInfo[] {
    const stmt = this.db.prepare(`
      SELECT
        m.session_key as sessionKey,
        COUNT(*) as messageCount,
        MAX(m.timestamp) as lastActivity,
        MIN(m.timestamp) as firstActivity,
        (SELECT metadata FROM messages m2 WHERE m2.session_key = m.session_key ORDER BY timestamp DESC LIMIT 1) as latestMetadata
      FROM messages m
      GROUP BY m.session_key
      ORDER BY lastActivity DESC
    `);
    const rows = stmt.all() as any[];
    return rows.map(r => {
      let identifier = undefined;
      if (r.latestMetadata) {
        try {
          const meta = JSON.parse(r.latestMetadata);
          identifier = meta.userIdentifier;
        } catch(e) {}
      }
      return {
        sessionKey: r.sessionKey,
        messageCount: r.messageCount,
        lastActivity: r.lastActivity,
        firstActivity: r.firstActivity,
        userIdentifier: identifier
      };
    });
  }

  /**
   * Prune old messages beyond retention limit.
   */
  prune(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const stmt = this.db.prepare(`
      DELETE FROM messages WHERE timestamp < ?
    `);
    const result = stmt.run(cutoff);
    if (result.changes > 0) {
      log.info({ pruned: result.changes }, 'Pruned old messages');
    }
    return result.changes;
  }

  /**
   * Clear all messages for a session.
   */
  clearSession(sessionKey: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_key = ?').run(sessionKey);
    this.db.prepare('DELETE FROM summaries WHERE session_key = ?').run(sessionKey);
  }

  close(): void {
    this.db.close();
  }
}
