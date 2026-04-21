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
import { AgentEngine, AgentRequest } from '../core/engine.js';
import { ConfirmationManager } from '../core/confirmation.js';
import { getConfig, getStateDir } from '../config.js';
import { createLogger, createSilentLogger } from '../logger.js';
import { printStepDone, printStepWarn } from '../logger.js';
import { preprocessImage } from '../tools/vision.js';

const log = createLogger('whatsapp');
const baileysLog = createSilentLogger('baileys');

interface MentionTarget {
  id: string;
  label: string;
  aliases: string[];
}

export class WhatsAppChannel {
  private sock: WASocket | null = null;
  private engine: AgentEngine;
  private confirmations: ConfirmationManager;
  private config: any;
  private sessionDir: string;

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
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log as any),
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
        // QR display handled by baileys internally
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;

        log.info({ reason, shouldReconnect }, 'WhatsApp connection closed');

        if (shouldReconnect) {
          printStepWarn('WhatsApp disconnected, reconnecting...');
          setTimeout(() => this.start(), 3000);
        } else {
          printStepWarn('WhatsApp logged out. Run: liteclaw channels login --channel whatsapp');
        }
      }

      if (connection === 'open') {
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

        await this.handleMessage(msg, unwrapped);
      }
    });
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
    const toolUpdates: string[] = [];

    try {
      for await (const event of this.engine.processRequest(request)) {
        switch (event.type) {
          case 'content':
            fullContent += event.content ?? '';
            break;
          case 'tool_start':
            toolUpdates.push(`⚙ _${event.toolName}_`);
            break;
          case 'tool_result':
            const icon = event.toolResult?.success ? '✓' : '✗';
            toolUpdates.push(`${icon} _${event.toolName}_`);
            break;
          case 'error':
            fullContent += `\n⚠ Error: ${event.error}`;
            break;
        }
      }

      // Send response
      await this.sendResponse(jid, fullContent, toolUpdates, mentionTargets);

      log.info({
        to: jid.replace('@s.whatsapp.net', ''),
        responseLength: fullContent.length,
        tools: toolUpdates.length,
      }, 'WhatsApp response sent');

    } catch (err: any) {
      log.error({ error: err.message }, 'WhatsApp message handling error');
      await this.sock?.sendMessage(jid, { text: `⚠ Error: ${err.message}` });
    } finally {
      clearInterval(typingInterval);
      // Clear composing state
      try {
        await this.sock?.sendPresenceUpdate('paused', jid);
      } catch { /* ignore */ }
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
      await this.sock.sendMessage(jid, {
        text: resolved.content,
        mentions: resolved.jids,
      });
      // Small delay between chunks
      await new Promise(resolve => setTimeout(resolve, 500));
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
        await this.sock.sendMessage(jid, {
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
              await this.sock?.sendMessage(jid, { text: '✅ Confirmed.' });
            } else if (['no', 'n', 'cancel', '❌'].includes(text)) {
              this.confirmations.resolveConfirmation(conf.id, false);
              this.sock?.ev.off('messages.upsert', handler);
              await this.sock?.sendMessage(jid, { text: '❌ Cancelled.' });
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

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

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
  const cleanedContent = sanitizeChannelContent(content).trim();
  const toolSummary = options.showToolProgress && toolUpdates.length > 0
    ? toolUpdates.join('\n').trim()
    : '';

  const fullText = [toolSummary, cleanedContent].filter(Boolean).join('\n\n').trim() || '(No response)';

  if (options.replyStyle === 'rapid') {
    return splitRapidMessages(fullText, maxLen);
  }

  return chunkText(fullText, maxLen);
}

function sanitizeChannelContent(text: string): string {
  return text
    .replace(/<tool_result>\s*[\s\S]*?<\/tool_result>/gi, '')
    .replace(/<\/?tool_result>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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
          bursts.push(...chunkText(piece, Math.min(maxLen, 500)));
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
