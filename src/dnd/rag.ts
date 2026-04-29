import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { spawn, execSync } from 'child_process';
import { createRequire } from 'module';
import { getStateDir } from '../config.js';
import { createLogger } from '../logger.js';
import type { DndDocumentRecord, DndPlayerRecord, DndProgressEvent, DndSessionRecord } from './types.js';
import { parseCharacterSheet } from './manager.js';
import { DND_SYSTEM_KNOWLEDGE } from './knowledge.js';

const require_cjs = createRequire(import.meta.url);
const pdfParse = require_cjs('pdf-parse');

const log = createLogger('dnd-rag');

const QWEN_ROOT = 'E:\\Qwen3.6';
const EMBED_SCRIPT = join(QWEN_ROOT, 'start-embed-liteclaw.bat');
const EMBED_URL = 'http://127.0.0.1:8081/v1/embeddings';
const EMBED_MODELS_URL = 'http://127.0.0.1:8081/v1/models';

export interface RagHit {
  content: string;
  sourceType: string;
  sourceKey: string;
  similarity: number;
}

export class DndRagStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const stateDir = getStateDir();
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    this.db = new Database(dbPath ?? join(stateDir, 'dnd-rag.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dnd_rag_chunks (
        session_id TEXT NOT NULL,
        chunk_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        source_key TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_rag_session
        ON dnd_rag_chunks(session_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS dnd_rag_documents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        source_type TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        uploaded_by TEXT NOT NULL,
        uploaded_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dnd_rag_docs_session
        ON dnd_rag_documents(session_id, uploaded_at_ms DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertChunks(sessionId: string, chunks: Array<{ chunkId: string; sourceType: string; sourceKey: string; content: string; embedding: number[] }>): void {
    const stmt = this.db.prepare(`
      INSERT INTO dnd_rag_chunks (session_id, chunk_id, source_type, source_key, content, embedding_json, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        session_id = excluded.session_id,
        source_type = excluded.source_type,
        source_key = excluded.source_key,
        content = excluded.content,
        embedding_json = excluded.embedding_json,
        updated_at_ms = excluded.updated_at_ms
    `);

    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const chunk of chunks) {
        stmt.run(
          sessionId,
          chunk.chunkId,
          chunk.sourceType,
          chunk.sourceKey,
          chunk.content,
          JSON.stringify(chunk.embedding),
          now,
        );
      }
    });
    tx();
  }

  query(sessionId: string, queryEmbedding: number[], limit = 5): RagHit[] {
    return this.queryMany([sessionId], queryEmbedding, limit);
  }

  queryMany(scopeIds: string[], queryEmbedding: number[], limit = 5): RagHit[] {
    const uniqueScopeIds = [...new Set(scopeIds.filter(Boolean))];
    if (uniqueScopeIds.length === 0) {
      return [];
    }

    const placeholders = uniqueScopeIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT source_type as sourceType, source_key as sourceKey, content, embedding_json as embeddingJson
      FROM dnd_rag_chunks
      WHERE session_id IN (${placeholders})
    `).all(...uniqueScopeIds) as Array<{ sourceType: string; sourceKey: string; content: string; embeddingJson: string }>;

    return rows
      .map(row => ({
        content: row.content,
        sourceType: row.sourceType,
        sourceKey: row.sourceKey,
        similarity: cosineSimilarity(queryEmbedding, JSON.parse(row.embeddingJson) as number[]),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  hasChunks(sessionId: string, sourceKey?: string): boolean {
    const row = sourceKey
      ? this.db.prepare(`
        SELECT COUNT(*) as cnt
        FROM dnd_rag_chunks
        WHERE session_id = ? AND source_key = ?
      `).get(sessionId, sourceKey) as { cnt: number }
      : this.db.prepare(`
        SELECT COUNT(*) as cnt
        FROM dnd_rag_chunks
        WHERE session_id = ?
      `).get(sessionId) as { cnt: number };

    return row.cnt > 0;
  }

  // ─── Document Management ────────────────────────────────────────

  saveDocument(doc: DndDocumentRecord): void {
    this.db.prepare(`
      INSERT INTO dnd_rag_documents (id, session_id, filename, source_type, chunk_count, uploaded_by, uploaded_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        chunk_count = excluded.chunk_count,
        uploaded_at_ms = excluded.uploaded_at_ms
    `).run(doc.id, doc.sessionId, doc.filename, doc.sourceType, doc.chunkCount, doc.uploadedBy, doc.uploadedAt);
  }

  listDocuments(sessionId: string): DndDocumentRecord[] {
    return this.db.prepare(`
      SELECT
        id,
        session_id as sessionId,
        filename,
        source_type as sourceType,
        chunk_count as chunkCount,
        uploaded_by as uploadedBy,
        uploaded_at_ms as uploadedAt
      FROM dnd_rag_documents
      WHERE session_id = ?
      ORDER BY uploaded_at_ms DESC
    `).all(sessionId) as DndDocumentRecord[];
  }

  deleteDocument(documentId: string): void {
    const doc = this.db.prepare(`SELECT session_id as sessionId FROM dnd_rag_documents WHERE id = ?`).get(documentId) as { sessionId: string } | undefined;
    if (!doc) return;
    this.db.prepare(`DELETE FROM dnd_rag_chunks WHERE session_id = ? AND source_key = ?`).run(doc.sessionId, documentId);
    this.db.prepare(`DELETE FROM dnd_rag_documents WHERE id = ?`).run(documentId);
  }

  getDocumentCount(sessionId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM dnd_rag_documents WHERE session_id = ?`).get(sessionId) as { cnt: number };
    return row.cnt;
  }
}

export class EmbeddingServerManager {
  async ensureRunning(): Promise<void> {
    if (await this.isRunning()) {
      return;
    }

    if (!existsSync(EMBED_SCRIPT)) {
      throw new Error(`Embedding bootstrap script not found: ${EMBED_SCRIPT}`);
    }

    spawn('cmd.exe', ['/c', 'start', '""', EMBED_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (await this.isRunning()) {
        log.info('Embedding server is ready');
        return;
      }
    }

    throw new Error('Embedding server did not become ready on port 8081');
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    await this.ensureRunning();

    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: texts.map(text => `search_document: ${text}`),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: HTTP ${response.status}`);
    }

    const data = await response.json() as { data?: Array<{ embedding: number[] }> };
    return (data.data ?? []).map(item => item.embedding);
  }

  async embedQuery(text: string): Promise<number[]> {
    await this.ensureRunning();

    const response = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: [`search_query: ${text}`],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`Embedding query failed: HTTP ${response.status}`);
    }

    const data = await response.json() as { data?: Array<{ embedding: number[] }> };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) {
      throw new Error('Embedding server returned no embedding');
    }
    return embedding;
  }

  private async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(EMBED_MODELS_URL, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

const LLM_BASE_URL = process.env.LLM_BASE_URL ?? 'http://localhost:8080/v1';
const LLM_MODELS_URL = `${LLM_BASE_URL}/models`;
const LLM_SCRIPT = join(QWEN_ROOT, 'start-heretic.bat');

export class LlmServerManager {
  async isRunning(): Promise<boolean> {
    try {
      const response = await fetch(LLM_MODELS_URL, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning(): Promise<void> {
    if (await this.isRunning()) return;

    if (!existsSync(LLM_SCRIPT)) {
      log.warn(`LLM launch script not found: ${LLM_SCRIPT}. LLM server must be started manually.`);
      throw new Error('LLM server is not running and no launch script was found.');
    }

    log.info('Starting LLM server...');
    spawn('cmd.exe', ['/c', 'start', '""', LLM_SCRIPT], {
      detached: true,
      stdio: 'ignore',
    }).unref();

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await sleep(3000);
      if (await this.isRunning()) {
        log.info('LLM server is ready');
        return;
      }
    }
    throw new Error('LLM server did not become ready in time.');
  }
}

export interface ServerReadinessResult {
  embedReady: boolean;
  llmReady: boolean;
  embedStarted: boolean;
  llmStarted: boolean;
}

/**
 * Ensure the embedding server is running for session RAG.
 * The LLM server is checked for status but is not required to start a DnD session.
 */
export async function ensureServersReady(
  embeddings: EmbeddingServerManager,
  llm: LlmServerManager,
  onProgress?: (message: string) => void,
): Promise<ServerReadinessResult> {
  const result: ServerReadinessResult = {
    embedReady: false, llmReady: false,
    embedStarted: false, llmStarted: false,
  };

  const embedOk = await embeddings['isRunning']();
  const llmOk = await llm.isRunning();

  result.embedReady = embedOk;
  result.llmReady = llmOk;

  if (embedOk) return result;

  // Start missing servers
  const tasks: Promise<void>[] = [];
  if (!embedOk) {
    onProgress?.('🔄 Starting embedding server...');
    result.embedStarted = true;
    await embeddings.ensureRunning();
    result.embedReady = true;
  }
  return result;
  if (!llmOk) {
    onProgress?.('🔄 Starting LLM server...');
    result.llmStarted = true;
    tasks.push(llm.ensureRunning());
  }

  await Promise.all(tasks);
  result.embedReady = true;
  result.llmReady = true;
  return result;
}

export async function syncSessionRag(args: {
  rag: DndRagStore;
  embeddings: EmbeddingServerManager;
  session: DndSessionRecord;
  players: DndPlayerRecord[];
  progress: DndProgressEvent[];
}): Promise<void> {
  const chunks = buildRagChunks(args.session, args.players, args.progress);
  if (chunks.length === 0) return;
  const embeddings = await args.embeddings.embedTexts(chunks.map(chunk => chunk.content));
  args.rag.upsertChunks(args.session.id, chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings[index] ?? [],
  })));
}

export async function buildRagQuestionContext(args: {
  rag: DndRagStore;
  embeddings: EmbeddingServerManager;
  sessionId: string;
  question: string;
  extraScopeIds?: string[];
}): Promise<string> {
  const queryEmbedding = await args.embeddings.embedQuery(args.question);
  const hits = args.rag.queryMany([args.sessionId, ...(args.extraScopeIds ?? [])], queryEmbedding, 5);
  if (hits.length === 0) {
    return 'No relevant RAG context found for this session yet.';
  }

  return hits.map((hit, index) =>
    `[RAG ${index + 1}] (${hit.sourceType}/${hit.sourceKey}, sim=${hit.similarity.toFixed(3)}) ${hit.content}`,
  ).join('\n');
}

export function getPreconfiguredWorldScopeId(worldId: string): string {
  return `__world__:${worldId}`;
}

export async function syncPreconfiguredWorldRag(args: {
  rag: DndRagStore;
  embeddings: EmbeddingServerManager;
  worldId: string;
  worldName: string;
  loreText: string;
}): Promise<void> {
  const scopeId = getPreconfiguredWorldScopeId(args.worldId);
  if (args.rag.hasChunks(scopeId, args.worldId)) {
    return;
  }

  const textChunks = chunkText(args.loreText, 900, 120);
  if (textChunks.length === 0) {
    throw new Error(`No lore text found for preconfigured world ${args.worldId}`);
  }

  const embeddings = await args.embeddings.embedTexts(textChunks.map(chunk => [
    `Preconfigured world lore: ${args.worldName}`,
    chunk,
  ].join('\n')));

  args.rag.upsertChunks(scopeId, textChunks.map((chunk, index) => ({
    chunkId: `${scopeId}:lore:${index}`,
    sourceType: 'world_lore',
    sourceKey: args.worldId,
    content: [
      `Preconfigured world lore for ${args.worldName}`,
      chunk,
    ].join('\n'),
    embedding: embeddings[index] ?? [],
  })));
}

function buildRagChunks(
  session: DndSessionRecord,
  players: DndPlayerRecord[],
  progress: DndProgressEvent[],
): Array<{ chunkId: string; sourceType: string; sourceKey: string; content: string }> {
  const chunks: Array<{ chunkId: string; sourceType: string; sourceKey: string; content: string }> = [];

  for (const doc of DND_SYSTEM_KNOWLEDGE) {
    chunks.push({
      chunkId: `${session.id}:system:${doc.key}`,
      sourceType: 'system',
      sourceKey: doc.key,
      content: [
        `System reference: ${doc.title}`,
        doc.content,
      ].join('\n'),
    });
  }

  chunks.push({
    chunkId: `${session.id}:session`,
    sourceType: 'session',
    sourceKey: session.id,
    content: [
      `Session ${session.title}`,
      `Tone: ${session.tone ?? 'not set'}`,
      `Phase: ${session.phase}`,
      `Round: ${session.roundNumber}`,
      `Turn: ${session.turnNumber}`,
      `Notes: ${session.notes ?? 'none'}`,
    ].join('\n'),
  });

  if (session.worldInfo?.trim()) {
    const loreChunks = chunkText(session.worldInfo, 900, 120);
    loreChunks.forEach((chunk, index) => {
      chunks.push({
        chunkId: `${session.id}:world:${index}`,
        sourceType: 'world',
        sourceKey: `${session.id}:${index}`,
        content: [
          `World lore for session ${session.title}`,
          chunk,
        ].join('\n'),
      });
    });
  }

  for (const player of players) {
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const conditionsText = sheet.conditions.length > 0 ? `Conditions: ${sheet.conditions.join(', ')}` : 'Conditions: none';
    chunks.push({
      chunkId: `${session.id}:player:${player.userId}`,
      sourceType: 'player',
      sourceKey: player.userId,
      content: [
        `${player.characterName}`,
        `Class: ${player.className ?? 'unknown'}`,
        `Race: ${player.race ?? 'unknown'}`,
        `Status: ${player.status}`,
        `Level: ${sheet.level}`,
        `XP: ${sheet.xp}`,
        `HP: ${sheet.hp}/${sheet.maxHp}`,
        `AC: ${sheet.ac}`,
        `Abilities: STR ${sheet.abilities.str}, DEX ${sheet.abilities.dex}, CON ${sheet.abilities.con}, INT ${sheet.abilities.int}, WIS ${sheet.abilities.wis}, CHA ${sheet.abilities.cha}`,
        conditionsText,
        `Exhaustion: ${sheet.exhaustion}`,
        `Inspiration: ${sheet.inspiration ? 'Yes' : 'No'}`,
        `Notes: ${sheet.notes || 'none'}`,
      ].join('\n'),
    });
  }

  for (const entry of progress.slice(-20)) {
    chunks.push({
      chunkId: `${session.id}:progress:${entry.id}`,
      sourceType: entry.type,
      sourceKey: entry.id,
      content: [
        `${entry.type} reward`,
        `Title: ${entry.title}`,
        `XP: ${entry.xpAward}`,
        `Notes: ${entry.notes ?? 'none'}`,
      ].join('\n'),
    });
  }

  return chunks;
}

// ─── Document Ingestion ─────────────────────────────────────────────

const CHUNK_SIZE = 500;
const CHUNK_OVERLAP = 50;

/**
 * Split text into overlapping chunks for embedding.
 */
function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 20) {
      chunks.push(chunk);
    }
    start += chunkSize - overlap;
  }
  return chunks;
}

/**
 * Parse a file buffer into plain text based on extension.
 * Supports .pdf, .txt, .md, .docx.
 */
export async function extractTextFromFile(buffer: Buffer, filename: string): Promise<string> {
  const ext = extname(filename).toLowerCase();

  switch (ext) {
    case '.pdf': {
      try {
        const result = await pdfParse(buffer);
        return result.text ?? '';
      } catch (err: any) {
        log.warn({ error: err.message }, 'PDF parse failed, trying raw text');
        return buffer.toString('utf-8');
      }
    }
    case '.txt':
    case '.md':
    case '.markdown':
      return buffer.toString('utf-8');
    case '.docx': {
      try {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
      } catch {
        return buffer.toString('utf-8');
      }
    }
    default:
      return buffer.toString('utf-8');
  }
}

/**
 * Ingest a document into the RAG store: extract text, chunk, embed, store.
 */
export async function ingestDocument(args: {
  rag: DndRagStore;
  embeddings: EmbeddingServerManager;
  sessionId: string;
  documentId: string;
  filename: string;
  sourceType: 'pdf' | 'lore' | 'transcript' | 'text';
  buffer: Buffer;
  uploadedBy: string;
}): Promise<DndDocumentRecord> {
  const text = await extractTextFromFile(args.buffer, args.filename);
  if (!text.trim()) {
    throw new Error(`Could not extract any text from ${args.filename}`);
  }

  const textChunks = chunkText(text);
  log.info({ filename: args.filename, chunks: textChunks.length, textLength: text.length }, 'Chunked document for embedding');

  // Embed in batches of 16
  const BATCH_SIZE = 16;
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < textChunks.length; i += BATCH_SIZE) {
    const batch = textChunks.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = await args.embeddings.embedTexts(batch);
    allEmbeddings.push(...batchEmbeddings);
  }

  const ragChunks = textChunks.map((chunk, index) => ({
    chunkId: `${args.sessionId}:doc:${args.documentId}:${index}`,
    sourceType: args.sourceType,
    sourceKey: args.documentId,
    content: `[${args.filename}] ${chunk}`,
    embedding: allEmbeddings[index] ?? [],
  }));

  args.rag.upsertChunks(args.sessionId, ragChunks);

  const doc: DndDocumentRecord = {
    id: args.documentId,
    sessionId: args.sessionId,
    filename: args.filename,
    sourceType: args.sourceType,
    chunkCount: textChunks.length,
    uploadedBy: args.uploadedBy,
    uploadedAt: Date.now(),
  };
  args.rag.saveDocument(doc);

  log.info({ documentId: args.documentId, filename: args.filename, chunks: textChunks.length }, 'Document ingested into RAG');
  return doc;
}

/**
 * Ingest a session transcript turn into RAG.
 */
export async function ingestTranscriptTurn(args: {
  rag: DndRagStore;
  embeddings: EmbeddingServerManager;
  sessionId: string;
  turnId: string;
  narrative: string;
  playerActions?: string;
}): Promise<void> {
  const content = [
    `[Turn ${args.turnId}]`,
    args.narrative,
    args.playerActions ? `Player Actions: ${args.playerActions}` : '',
  ].filter(Boolean).join('\n');

  const chunks = chunkText(content);
  if (chunks.length === 0) return;

  const embeddings = await args.embeddings.embedTexts(chunks);
  args.rag.upsertChunks(args.sessionId, chunks.map((chunk, index) => ({
    chunkId: `${args.sessionId}:transcript:${args.turnId}:${index}`,
    sourceType: 'transcript',
    sourceKey: `turn-${args.turnId}`,
    content: chunk,
    embedding: embeddings[index] ?? [],
  })));
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
