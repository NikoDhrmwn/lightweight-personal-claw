/**
 * LiteClaw — WhatsApp Channel
 *
 * Uses @whiskeysockets/baileys (same as OpenClaw).
 * Handles QR pairing, session persistence, interactive buttons
 * for confirmations, and file/media sending.
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  type WASocket,
  type BaileysEventMap,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, basename, extname } from 'path';
import { lookup } from 'mime-types';
import { AgentEngine, AgentRequest, AgentStreamEvent } from '../core/engine.js';
import { ConfirmationManager } from '../core/confirmation.js';
import { getConfig, getStateDir } from '../config.js';
import { createLogger, createSilentLogger } from '../logger.js';
import { printStepDone, printStepWarn, printStepError } from '../logger.js';
import { preprocessImage } from '../tools/vision.js';
import { sanitizeChannelContent, splitMessage, formatForWhatsApp } from './utils.js';

const log = createLogger('whatsapp');
const baileysLog = createSilentLogger('baileys');

interface MentionTarget {
  id: string;
  label: string;
  aliases: string[];
}

interface WhatsAppProgressState {
  startedAt: number;
  status: 'starting' | 'thinking' | 'planning' | 'working' | 'done' | 'error';
  planSummary?: string;
  tasks: Array<{
    id: string;
    title: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked' | 'skipped';
    summary?: string;
  }>;
  recentTools: string[];
  currentTaskLabel?: string;
  error?: string;
  messageKey?: any;
  lastUpdateAt?: number;
  isCreatingTracker?: boolean;
}

interface MessageQueueItem {
  jid: string;
  content: any;
  options?: any;
  retries: number;
  resolve: (val: any) => void;
  reject: (err: any) => void;
}

export class WhatsAppChannel {
  private sock: WASocket | null = null;
  private engine: AgentEngine;
  private confirmations: ConfirmationManager;
  private config: any;
  private sessionDir: string;
  private progresses = new Map<string, WhatsAppProgressState>();
  private messageQueue: MessageQueueItem[] = [];
  private isProcessingQueue = false;
  private isReconnecting = false;

  constructor(engine: AgentEngine, confirmations: ConfirmationManager) {
    this.engine = engine;
    this.confirmations = confirmations;
    this.config = getConfig().channels?.whatsapp ?? {};
    this.sessionDir = join(getStateDir(), 'whatsapp-session');

    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    this.setupConfirmationHandler();
  }

  async start(): Promise<void> {
    if (this.isReconnecting) return;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLog as any),
        },
        logger: baileysLog as any,
        generateHighQualityLinkPreview: false,
        getMessage: async () => ({ conversation: '' }),
      });

      // Save credentials on update
      this.sock.ev.on('creds.update', saveCreds);

      // Handle connection events
      this.sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          printStepWarn('WhatsApp not linked — scan QR code to pair');
        }

        if (connection === 'close') {
          const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
          const shouldReconnect = reason !== DisconnectReason.loggedOut;

          log.info({ reason, shouldReconnect }, 'WhatsApp connection closed');

          if (shouldReconnect) {
            this.isReconnecting = true;
            printStepWarn(`WhatsApp disconnected (reason: ${reason}), reconnecting in 5s...`);
            setTimeout(() => {
              this.isReconnecting = false;
              this.start();
            }, 5000);
          } else {
            printStepError('WhatsApp logged out. Run: liteclaw channels login --channel whatsapp');
          }
        }

        if (connection === 'open') {
          this.isReconnecting = false;
          const me = (this.sock as any)?.authState?.creds?.me || {};
          log.info({
            id: this.sock?.user?.id,
            lid: (this.sock?.user as any)?.lid,
            credsMe: me
          }, 'WhatsApp connected - Identity Details');
          printStepDone('WhatsApp connected');
        }
      });

      // Handle incoming messages
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
          const unwrapped = unwrapMessage(msg.message);
          if (!unwrapped) continue;

          // Check for text commands first
          if (await this.handleTextCommand(msg, unwrapped)) continue;

          await this.handleMessage(msg, unwrapped);
        }
      });
    } catch (err: any) {
      log.error({ error: err.message }, 'Failed to start WhatsApp channel');
      this.isReconnecting = true;
      setTimeout(() => {
        this.isReconnecting = false;
        this.start();
      }, 10000);
    }
  }

  private async handleTextCommand(msg: any, messageContent: any): Promise<boolean> {
    const jid = msg.key.remoteJid!;
    let text = '';

    if (messageContent?.conversation) {
      text = messageContent.conversation;
    } else if (messageContent?.extendedTextMessage?.text) {
      text = messageContent.extendedTextMessage.text;
    }

    text = text.trim();
    if (!text.startsWith('/')) return false;

    const [cmd, ...args] = text.slice(1).split(/\s+/);
    const command = cmd.toLowerCase();
    const sessionKey = `whatsapp:${jid}`;

    log.info({ command, from: jid }, 'WhatsApp command received');

    switch (command) {
      case 'help':
        await this.sendMessageWithRetry(jid, {
          text: `*LiteClaw Commands*\n\n` +
                `*/reset* - Clear conversation history\n` +
                `*/status* - Show current status\n` +
                `*/help* - Show this help message\n` +
                `*/clear* - Alias for /reset`
        });
        return true;

      case 'reset':
      case 'clear':
        this.engine.getMemory().clearSession(sessionKey);
        await this.sendMessageWithRetry(jid, { text: '🗑 *History cleared.* Starting a fresh conversation.' });
        return true;

      case 'status':
        const metrics = this.engine.getMemory().getSessionMetrics(sessionKey);
        const uptime = process.uptime();
        await this.sendMessageWithRetry(jid, {
          text: `*LiteClaw Status*\n\n` +
                `🤖 *Agent:* ${this.config.agent?.name || 'Molty'}\n` +
                `⏳ *Uptime:* ${formatDurationShort(uptime * 1000)}\n` +
                `💬 *Messages:* ${metrics.messageCount}\n` +
                `🪙 *Tokens used:* ~${metrics.estimatedTokens}\n` +
                `📅 *Last activity:* ${metrics.lastActivity ? new Date(metrics.lastActivity).toLocaleString() : 'never'}`
        });
        return true;

      default:
        return false;
    }
  }

  private async handleMessage(msg: any, messageContent: any): Promise<void> {
    const jid = msg.key.remoteJid!;

    // Check allow policy
    const allowFrom = this.config.allowFrom ?? ['*'];
    if (!allowFrom.includes('*')) {
      const phone = jid.replace('@s.whatsapp.net', '');
      if (!allowFrom.some((pattern: string) => phone.includes(pattern))) {
        return;
      }
    }

    // Extract text content
    let content = '';

    if (messageContent?.conversation) {
      content = messageContent.conversation;
    } else if (messageContent?.extendedTextMessage?.text) {
      content = messageContent.extendedTextMessage.text;
    } else if (messageContent?.imageMessage?.caption) {
      content = messageContent.imageMessage.caption;
    }

    const mentionTargets = this.extractMentionTargets(msg, messageContent);
    const replyContext = this.extractReplyContext(messageContent);

    const images = await this.collectIncomingImages(msg, messageContent);

    if (!content && images.length === 0) return;

    log.info({
      from: jid.replace('@s.whatsapp.net', ''),
      contentLength: content.length,
      hasImages: images.length > 0,
    }, 'WhatsApp message received');

    // Build session key
    const sessionKey = `whatsapp:${jid}`;

    const request: AgentRequest = {
      message: buildStructuredIncomingMessage(
        {
          conversationLabel: jid.endsWith('@g.us') ? `WhatsApp group ${jid}` : `WhatsApp DM ${jid}`,
          sender: {
            id: msg.key.participant || jid,
            label: msg.pushName || jid.split('@')[0],
            name: msg.pushName || jid.split('@')[0],
            jid: msg.key.participant || jid,
          },
          isGroupChat: jid.endsWith('@g.us'),
          wasMentioned: didMentionMe(messageContent, this.sock?.user?.id),
          mentionTargets,
          replyContext,
        },
        content || '(image attached)'
      ),
      images: images.length > 0 ? images : undefined,
      sessionKey,
      channelType: 'whatsapp',
      channelTarget: jid,
      userIdentifier: msg.pushName || jid.split('@')[0],
      sendFile: async (filePath: string, fileName?: string) => {
        await this.sendFile(jid, filePath, fileName);
      },
    };

    // Ignore group chat messages unless mentioned or replied to (but save to memory for context)
    const isGroupChat = jid.endsWith('@g.us');
    if (isGroupChat) {
      const selfJidRaw = this.sock?.user?.id || '';
      const selfLid = (this.sock?.user as any)?.lid || (this.sock as any)?.authState?.creds?.me?.lid || '';
      const selfJid = selfJidRaw.split(':')[0] + '@s.whatsapp.net';
      const myName = this.config.agent?.name || this.sock?.user?.name || 'Molty';

      const namePattern = new RegExp(`\\b${escapeRegex(myName)}\\b`, 'i');
      const isMentioned = didMentionMe(messageContent, selfJid) ||
                          didMentionMe(messageContent, selfJidRaw) ||
                          (selfLid && didMentionMe(messageContent, selfLid)) ||
                          content.toLowerCase().includes(`@${myName.toLowerCase()}`) ||
                          namePattern.test(content); // Handle informal mentions like "oi molty"

      const isReplyToMe = messageContent?.extendedTextMessage?.contextInfo?.participant === selfJid ||
                          messageContent?.extendedTextMessage?.contextInfo?.participant === selfJidRaw ||
                          (selfLid && normalizeJid(messageContent?.extendedTextMessage?.contextInfo?.participant || '') === normalizeJid(selfLid));

      log.info({
        isGroupChat, isMentioned, isReplyToMe,
        selfJid, selfLid, myName,
        exactText: content,
        mentionedJids: messageContent?.extendedTextMessage?.contextInfo?.mentionedJid
      }, 'WhatsApp group filter check VERY VERBOSE');

      if (!isMentioned && !isReplyToMe) {
        this.engine.saveMessageSilent(request);
        return;
      }
    }

    // Send read receipts if configured
    if (this.config.sendReadReceipts) {
      await this.sock?.readMessages([msg.key]);
    }

    // ── Continuous composing presence ──
    // WhatsApp shows "typing..." when we update presence
    const sendComposing = async () => {
      try {
        await this.sock?.sendPresenceUpdate('composing', jid);
      } catch { /* ignore */ }
    };

    await sendComposing();
    const typingInterval = setInterval(sendComposing, 5_000);

    // Process and accumulate response
    let fullContent = '';
    const showProgress = this.config.showToolProgress ?? true;
    let progress: WhatsAppProgressState | undefined;

    if (showProgress) {
      progress = {
        startedAt: Date.now(),
        status: 'starting',
        tasks: [],
        recentTools: [],
      };
      this.progresses.set(sessionKey, progress);
    }

    try {
      for await (const event of this.engine.processRequest(request)) {
        if (progress) {
          applyEventToWhatsAppProgress(progress, event);
          await this.updateProgress(jid, progress);
        }

        switch (event.type) {
          case 'content':
            fullContent += event.content ?? '';
            break;
          case 'error':
            if (!progress) fullContent += `\n⚠ Error: ${event.error}`;
            break;
        }
      }

      // Final progress update
      if (progress) {
        progress.status = progress.status === 'error' ? 'error' : 'done';
        // Final update to the tracker (Outcome will show a preview)
        await this.updateProgress(jid, progress, fullContent);
        this.progresses.delete(sessionKey);
      }

      // Always send the full response as a separate message for readability
      if (fullContent.trim()) {
        await this.sendResponse(jid, fullContent, [], mentionTargets);
      }

      log.info({
        to: jid.replace('@s.whatsapp.net', ''),
        responseLength: fullContent.length,
      }, 'WhatsApp turn completed');

    } catch (err: any) {
      log.error({ error: err.message }, 'WhatsApp message handling error');
      await this.sendMessageWithRetry(jid, { text: `⚠ Error: ${err.message}` });
    } finally {
      clearInterval(typingInterval);
      // Clear composing state
      try {
        await this.sock?.sendPresenceUpdate('paused', jid);
      } catch { /* ignore */ }
    }
  }

  private async updateProgress(jid: string, progress: WhatsAppProgressState, finalContent?: string): Promise<void> {
    if (!this.sock) return;

    // Throttle updates to avoid rate limits (max 1 update per 1.5s)
    const now = Date.now();
    const isFinal = progress.status === 'done' || progress.status === 'error';
    if (!isFinal && progress.lastUpdateAt && now - progress.lastUpdateAt < 1500) {
      return;
    }
    progress.lastUpdateAt = now;

    const text = buildWhatsAppProgressMessage(progress, finalContent);

    try {
      if (!progress.messageKey) {
        if (progress.isCreatingTracker) return;
        progress.isCreatingTracker = true;

        try {
          const sent = await this.sendMessageWithRetry(jid, { text });
          progress.messageKey = sent?.key;
        } finally {
          progress.isCreatingTracker = false;
        }
      } else {
        await this.sendMessageWithRetry(jid, { edit: progress.messageKey, text });
      }
    } catch (err: any) {
      log.warn({ error: err.message }, 'Failed to update WhatsApp progress');
    }
  }

  private async sendMessageWithRetry(jid: string, content: any, options?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.messageQueue.push({ jid, content, options, retries: 0, resolve, reject });
      void this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessingQueue || !this.sock || this.messageQueue.length === 0) return;
    this.isProcessingQueue = true;

    try {
      while (this.messageQueue.length > 0) {
        const item = this.messageQueue.shift()!;
        try {
          const result = await this.sock.sendMessage(item.jid, item.content, item.options);
          item.resolve(result);
        } catch (err: any) {
          if (item.retries < 3) {
            item.retries++;
            log.warn({ error: err.message, retry: item.retries }, 'Message send failed, retrying...');
            this.messageQueue.unshift(item);
            await new Promise(r => setTimeout(r, 1000 * item.retries));
          } else {
            log.error({ error: err.message }, 'Message send failed after retries');
            item.reject(err);
          }
        }
        // Small delay between messages to be safe
        await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      this.isProcessingQueue = false;
    }
  }

  private extractReplyContext(messageContent: any): string | null {
    const contextInfo =
      messageContent?.extendedTextMessage?.contextInfo ??
      messageContent?.imageMessage?.contextInfo ??
      messageContent?.videoMessage?.contextInfo ??
      messageContent?.documentMessage?.contextInfo;

    const quoted = contextInfo?.quotedMessage;
    if (!quoted) return null;

    const participant = contextInfo?.participant || contextInfo?.remoteJid || 'Quoted user';
    const quotedText =
      quoted?.conversation ??
      quoted?.extendedTextMessage?.text ??
      quoted?.imageMessage?.caption ??
      quoted?.videoMessage?.caption ??
      quoted?.documentMessage?.caption ??
      '(quoted media)';

    return quotedText ? formatReplyContext(participant, quotedText) : null;
  }

  private async sendResponse(
    jid: string,
    content: string,
    toolUpdates: string[],
    mentionTargets: MentionTarget[]
  ): Promise<void> {
    if (!this.sock) return;

    const messages = buildOutgoingMessages(
      content,
      toolUpdates,
      {
        replyStyle: this.config.replyStyle ?? 'single',
        showToolProgress: this.config.showToolProgress ?? false,
      },
      4000
    );

    for (const chunk of messages) {
      const resolved = resolveWhatsAppMentions(chunk, mentionTargets);
      await this.sendMessageWithRetry(jid, {
        text: resolved.content,
        mentions: resolved.jids,
      });
    }
  }

  private extractMentionTargets(msg: any, messageContent: any): MentionTarget[] {
    const jid = msg.key.remoteJid!;
    const contextInfo =
      messageContent?.extendedTextMessage?.contextInfo ??
      messageContent?.imageMessage?.contextInfo ??
      messageContent?.videoMessage?.contextInfo ??
      messageContent?.documentMessage?.contextInfo;

    const targets: MentionTarget[] = [];
    const senderJid = msg.key.participant || jid;
    const senderLabel = msg.pushName || senderJid.split('@')[0];
    targets.push(createMentionTarget(senderJid, senderLabel, senderJid.split('@')[0]));

    const quotedParticipant = contextInfo?.participant;
    if (quotedParticipant) {
      targets.push(
        createMentionTarget(
          quotedParticipant,
          quotedParticipant.split('@')[0],
          quotedParticipant.split('@')[0]
        )
      );
    }

    const mentioned = contextInfo?.mentionedJid ?? [];
    for (const mentionedJid of mentioned) {
      targets.push(
        createMentionTarget(
          mentionedJid,
          mentionedJid.split('@')[0],
          mentionedJid.split('@')[0]
        )
      );
    }

    return dedupeMentionTargets(targets);
  }

  private async sendFile(jid: string, filePath: string, fileName?: string): Promise<void> {
    if (!this.sock || !existsSync(filePath)) return;

    const name = fileName ?? basename(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = lookup(ext) || 'application/octet-stream';
    const buffer = readFileSync(filePath);

    // Determine send type based on mime
    if (mimeType.startsWith('image/')) {
      await this.sock.sendMessage(jid, {
        image: buffer,
        caption: `📎 ${name}`,
        mimetype: mimeType,
      });
    } else if (mimeType.startsWith('video/')) {
      await this.sock.sendMessage(jid, {
        video: buffer,
        caption: `📎 ${name}`,
        mimetype: mimeType,
      });
    } else if (mimeType.startsWith('audio/')) {
      await this.sock.sendMessage(jid, {
        audio: buffer,
        mimetype: mimeType,
      });
    } else {
      // Send as document
      await this.sock.sendMessage(jid, {
        document: buffer,
        fileName: name,
        mimetype: mimeType,
      });
    }

    log.info({ file: name, jid }, 'Sent file via WhatsApp');
  }

  private async collectIncomingImages(msg: any, messageContent: any): Promise<string[]> {
    const images: string[] = [];

    if (messageContent?.imageMessage) {
      const current = await this.downloadMessageImage(msg, 'message');
      if (current) images.push(current);
    }

    const quotedImage = await this.downloadQuotedReplyImage(messageContent);
    if (quotedImage) images.push(quotedImage);

    return images;
  }

  private async downloadMessageImage(msg: any, reason: string): Promise<string | null> {
    try {
      const stream = await this.downloadMedia(msg);
      if (!stream) return null;
      return await preprocessImage(stream);
    } catch (err: any) {
      log.warn({ error: err.message, reason }, 'Failed to download WhatsApp image');
      return null;
    }
  }

  private async downloadQuotedReplyImage(messageContent: any): Promise<string | null> {
    const contextInfo =
      messageContent?.extendedTextMessage?.contextInfo ??
      messageContent?.imageMessage?.contextInfo ??
      messageContent?.videoMessage?.contextInfo ??
      messageContent?.documentMessage?.contextInfo;

    const quotedImage = contextInfo?.quotedMessage?.imageMessage;
    if (!quotedImage) return null;

    try {
      const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
      const stream = await downloadContentFromMessage(quotedImage, 'image');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (chunks.length === 0) return null;
      return await preprocessImage(Buffer.concat(chunks));
    } catch (err: any) {
      log.warn({ error: err.message }, 'Failed to download quoted WhatsApp image');
      return null;
    }
  }

  private async downloadMedia(msg: any): Promise<Buffer | null> {
    try {
      const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
      const buffer = await downloadMediaMessage(msg, 'buffer', {}) as Buffer;
      return buffer;
    } catch (err: any) {
      log.warn({ error: err.message }, 'Media download failed');
      return null;
    }
  }

  private setupConfirmationHandler(): void {
    this.confirmations.on('confirmation_request', async (conf) => {
      if (conf.channelType !== 'whatsapp' || !conf.channelTarget || !this.sock) return;

      const jid = conf.channelTarget;

      try {
        // Try interactive buttons first
        await this.sendMessageWithRetry(jid, {
          text: `⚠️ *Confirmation Required*\n\n${conf.description}\n\n_Tool: \`${conf.toolName}\`_\n_Timeout: ${conf.timeoutMs / 1000}s_\n\nReply *yes* to confirm or *no* to cancel.`,
        } as any);

        // Set up a temporary listener for the response
        const handler = async ({ messages, type }: any) => {
          if (type !== 'notify') return;
          for (const respMsg of messages) {
            if (respMsg.key.remoteJid !== jid || respMsg.key.fromMe) continue;
            const text = (respMsg.message?.conversation ??
              respMsg.message?.extendedTextMessage?.text ?? '').toLowerCase().trim();

            if (['yes', 'y', 'confirm', '✅'].includes(text)) {
              this.confirmations.resolveConfirmation(conf.id, true);
              this.sock?.ev.off('messages.upsert', handler);
              await this.sendMessageWithRetry(jid, { text: '✅ Confirmed.' });
            } else if (['no', 'n', 'cancel', '❌'].includes(text)) {
              this.confirmations.resolveConfirmation(conf.id, false);
              this.sock?.ev.off('messages.upsert', handler);
              await this.sendMessageWithRetry(jid, { text: '❌ Cancelled.' });
            }
          }
        };

        this.sock.ev.on('messages.upsert', handler);

        // Auto-remove handler after timeout
        setTimeout(() => {
          this.sock?.ev.off('messages.upsert', handler);
        }, conf.timeoutMs);

      } catch (err: any) {
        log.error({ error: err.message }, 'Failed to send WhatsApp confirmation');
      }
    });
  }

  stop(): void {
    this.sock?.end(undefined);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────

// chunkText is replaced by splitMessage from utils.js

function buildStructuredIncomingMessage(
  meta: {
    conversationLabel: string;
    sender: Record<string, string | undefined>;
    isGroupChat: boolean;
    wasMentioned: boolean;
    mentionTargets: MentionTarget[];
    replyContext?: string | null;
  },
  content: string
): string {
  // Compact context header — one line for LLM context, won't clutter WebUI
  const senderLabel = meta.sender.name || meta.sender.label || 'unknown';
  const senderHandle = meta.sender.jid?.split('@')[0] || senderLabel;
  const chatType = meta.isGroupChat ? 'group' : 'DM';

  const parts: string[] = [
    `[context: whatsapp | ${chatType} | ${meta.conversationLabel} | sender: ${senderLabel} (${senderHandle})]`,
  ];

  if (meta.mentionTargets.length > 0) {
    const handles = meta.mentionTargets
      .slice(0, 8)
      .map(t => `@${t.aliases[0]} (${t.label})`)
      .join(', ');
    parts.push(`[participants: ${handles}]`);
  }

  if (meta.replyContext) {
    parts.push(meta.replyContext);
  }

  parts.push('', content);
  return parts.join('\n');
}

function formatReplyContext(author: string, content: string): string {
  return `[Reply context]\n${author}: ${content}\n[/Reply context]`;
}

// Normalize JIDs: strip device suffix (e.g., "123:10")
// and handle @s.whatsapp.net, @c.us, and @lid consistently
function normalizeJid(id: string): string {
  if (!id) return '';
  // Strip domain and device IDs
  return id.split(':')[0].split('@')[0];
}

function didMentionMe(messageContent: any, selfId?: string): boolean {
  if (!selfId) return false;

  const contextInfo =
    messageContent?.extendedTextMessage?.contextInfo ??
    messageContent?.imageMessage?.contextInfo ??
    messageContent?.videoMessage?.contextInfo ??
    messageContent?.documentMessage?.contextInfo;

  const mentioned: string[] = contextInfo?.mentionedJid ?? [];

  const normalizedSelf = normalizeJid(selfId);
  const matched = mentioned.some(m => normalizeJid(m) === normalizedSelf);

  if (!matched && mentioned.length > 0) {
    log.debug({
      selfId,
      normalizedSelf,
      mentioned: mentioned.map(m => `${m} -> ${normalizeJid(m)}`)
    }, 'No ID match in mentions');
  }

  return matched;
}

/**
 * Unwrap message content from Baileys wrappers (ephemeral, viewOnce, etc.)
 */
function unwrapMessage(msg: any): any {
  if (!msg) return null;

  if (msg.ephemeralMessage) return unwrapMessage(msg.ephemeralMessage.message);
  if (msg.viewOnceMessage) return unwrapMessage(msg.viewOnceMessage.message);
  if (msg.viewOnceMessageV2) return unwrapMessage(msg.viewOnceMessageV2.message);
  if (msg.viewOnceMessageV2Extension) return unwrapMessage(msg.viewOnceMessageV2Extension.message);

  return msg;
}

function createMentionTarget(id: string, ...labels: Array<string | undefined>): MentionTarget {
  const aliases = labels
    .flatMap(label => label ? buildNameAliases(label) : [])
    .filter(Boolean);
  return {
    id,
    label: labels.find(Boolean) ?? id,
    aliases: aliases.length > 0 ? aliases : [id],
  };
}

function dedupeMentionTargets(targets: MentionTarget[]): MentionTarget[] {
  const merged = new Map<string, MentionTarget>();
  for (const target of targets) {
    const existing = merged.get(target.id);
    if (!existing) {
      merged.set(target.id, target);
      continue;
    }
    existing.aliases = Array.from(new Set([...existing.aliases, ...target.aliases]));
  }
  return Array.from(merged.values());
}

function buildNameAliases(label: string): string[] {
  const clean = label.replace(/^@+/, '').trim();
  if (!clean) return [];

  const aliases = new Set<string>();
  aliases.add(clean);
  aliases.add(clean.toLowerCase());
  aliases.add(clean.replace(/\s+/g, '_'));
  aliases.add(clean.replace(/\s+/g, ''));
  aliases.add(clean.replace(/[^\p{L}\p{N}_ ]/gu, '').trim());
  aliases.add(clean.replace(/[^\p{L}\p{N}_ ]/gu, '').replace(/\s+/g, '_').trim());
  return Array.from(aliases).filter(Boolean);
}

function resolveWhatsAppMentions(text: string, targets: MentionTarget[]): { content: string; jids: string[] } {
  let content = text;
  const jids = new Set<string>();

  for (const target of targets) {
    const sortedAliases = [...target.aliases].sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
      const escaped = escapeRegex(alias.replace(/^@+/, ''));
      const pattern = new RegExp(`(^|[^\\w])@${escaped}(?=$|[^\\w])`, 'giu');
      content = content.replace(pattern, (match, prefix) => {
        jids.add(target.id);
        return `${prefix}@${target.label}`;
      });
    }
  }

  return { content, jids: Array.from(jids) };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOutgoingMessages(
  content: string,
  toolUpdates: string[],
  options: { replyStyle: 'single' | 'rapid'; showToolProgress: boolean },
  maxLen: number
): string[] {
  const sanitized = sanitizeChannelContent(content).trim();
  const cleanedContent = formatForWhatsApp(sanitized);
  const toolSummary = options.showToolProgress && toolUpdates.length > 0
    ? toolUpdates.join('\n').trim()
    : '';

  const fullText = [toolSummary, cleanedContent].filter(Boolean).join('\n\n').trim() || '(No response)';

  if (options.replyStyle === 'rapid') {
    return splitRapidMessages(fullText, maxLen);
  }

  return splitMessage(fullText, maxLen);
}

// sanitizeChannelContent is imported from utils.js

function splitRapidMessages(text: string, maxLen: number): string[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean);

  const bursts: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= Math.min(maxLen, 500)) {
      bursts.push(paragraph);
      continue;
    }

    const pieces = paragraph
      .split(/(?<=[.!?])\s+|\n/)
      .map(p => p.trim())
      .filter(Boolean);

    let current = '';
    for (const piece of pieces) {
      const candidate = current ? `${current} ${piece}` : piece;
      if (candidate.length > Math.min(maxLen, 500)) {
        if (current) bursts.push(current);
        if (piece.length > Math.min(maxLen, 500)) {
          bursts.push(...splitMessage(piece, Math.min(maxLen, 500)));
          current = '';
        } else {
          current = piece;
        }
      } else {
        current = candidate;
      }
    }

    if (current) bursts.push(current);
  }

  return bursts.length > 0 ? bursts : ['(No response)'];
}

function applyEventToWhatsAppProgress(progress: WhatsAppProgressState, event: AgentStreamEvent): void {
  switch (event.type) {
    case 'thinking':
      if (progress.status === 'starting') progress.status = 'thinking';
      break;
    case 'plan':
      progress.status = 'planning';
      progress.planSummary = event.plan?.summary ?? progress.planSummary;
      progress.tasks = (event.plan?.tasks ?? []).map((task, index) => ({
        id: task.id || `task_${index + 1}`,
        title: task.title || `Task ${index + 1}`,
        status: task.status || 'pending',
        summary: task.summary,
      }));
      break;
    case 'task_update': {
      progress.status = event.taskStatus === 'in_progress' ? 'working' : progress.status;
      if (event.plan?.summary) progress.planSummary = event.plan.summary;

      const taskId = event.taskId || event.taskTitle || `task_${event.taskIndex ?? progress.tasks.length + 1}`;
      const title = event.taskTitle || 'Task';
      const existing = progress.tasks.find((task) => task.id === taskId);
      if (existing) {
        existing.title = title;
        existing.status = event.taskStatus || existing.status;
        existing.summary = event.taskSummary || existing.summary;
      } else {
        progress.tasks.push({
          id: taskId,
          title,
          status: event.taskStatus || 'pending',
          summary: event.taskSummary,
        });
      }

      if (event.taskIndex && event.taskTotal) {
        progress.currentTaskLabel = `[${event.taskIndex}/${event.taskTotal}] ${title}`;
      } else {
        progress.currentTaskLabel = title;
      }
      break;
    }
    case 'tool_start':
      progress.status = 'working';
      pushRecentToolUpdate(progress, `⚙ _${event.toolName ?? 'tool'}_...`);
      break;
    case 'tool_result':
      pushRecentToolUpdate(
        progress,
        `${event.toolResult?.success ? '✓' : '✗'} _${event.toolName ?? 'tool'}_`
      );
      break;
    case 'error':
      progress.status = 'error';
      progress.error = event.error;
      break;
    case 'done':
      if (progress.status !== 'error') progress.status = 'done';
      break;
  }
}

function pushRecentToolUpdate(progress: WhatsAppProgressState, text: string): void {
  progress.recentTools.push(text);
  if (progress.recentTools.length > 5) {
    progress.recentTools = progress.recentTools.slice(-5);
  }
}

function buildWhatsAppProgressMessage(progress: WhatsAppProgressState, finalContent?: string): string {
  const elapsedMs = Date.now() - progress.startedAt;
  const completed = progress.tasks.filter((task) => task.status === 'completed').length;
  const active = progress.tasks.filter((task) => task.status === 'in_progress').length;
  const total = progress.tasks.length;
  const pending = Math.max(0, total - completed - active);
  const failed = progress.tasks.filter((task) => task.status === 'failed' || task.status === 'blocked').length;

  const lines = [
    `*LiteClaw · ${whatsappProgressStatusLabel(progress.status).toUpperCase()}*`,
    '',
    `📊 *Overview*`,
    `${whatsappProgressStatusLabel(progress.status)}  •  ${formatDurationShort(elapsedMs)}`,
    `${whatsappTaskStatusIcon('completed')} ${completed}/${total || 0} done  •  ${whatsappTaskStatusIcon('in_progress')} ${active} active`,
    `${whatsappTaskStatusIcon('pending')} ${pending} pending${failed ? `  •  ${whatsappTaskStatusIcon('failed')} ${failed} issue${failed === 1 ? '' : 's'}` : ''}`,
  ];

  if (progress.planSummary) {
    lines.push('', `🗺 *Plan*`, progress.planSummary);
  }

  if (progress.tasks.length > 0) {
    lines.push('', `📋 *Tasks*`);
    progress.tasks.slice(0, 10).forEach((task, i) => {
      lines.push(`${i + 1}. ${whatsappTaskStatusIcon(task.status)} ${task.title}${task.summary ? ` - ${task.summary}` : ''}`);
    });
  }

  if (progress.recentTools.length > 0 || progress.currentTaskLabel || progress.error) {
    lines.push('', `⚙ *Activity*`);
    if (progress.currentTaskLabel && progress.status !== 'done') {
      lines.push(`Focus: ${progress.currentTaskLabel}`);
    }
    progress.recentTools.forEach(tool => lines.push(`- ${tool}`));
    if (progress.error) {
      lines.push(`⚠ *Error:* ${progress.error}`);
    }
  }

  if (finalContent || progress.status === 'done' || progress.status === 'error') {
    lines.push('', `🏁 *Outcome*`);
    if (progress.status === 'error') {
      lines.push('_Failed to complete task._');
    } else {
      const sanitized = sanitizeChannelContent(finalContent || '');
      const formatted = formatForWhatsApp(sanitized).slice(0, 500);
      lines.push(formatted ? `${formatted}${formatted.length >= 500 ? '...' : ''}` : '_Response sent below._');
    }
  }

  return lines.join('\n');
}

function whatsappProgressStatusLabel(status: WhatsAppProgressState['status']): string {
  switch (status) {
    case 'thinking': return '🧠 Thinking';
    case 'planning': return '🗺 Planning';
    case 'working': return '⚙ Working';
    case 'done': return '✅ Complete';
    case 'error': return '❌ Error';
    case 'starting':
    default:
      return '👀 Starting';
  }
}

function whatsappTaskStatusIcon(status: string): string {
  switch (status) {
    case 'completed': return '✅';
    case 'in_progress': return '🟡';
    case 'failed': return '❌';
    case 'blocked': return '⚠';
    case 'skipped': return '⏭';
    default: return '⏳';
  }
}

function formatDurationShort(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
