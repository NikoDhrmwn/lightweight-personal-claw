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
        log.info('WhatsApp connected');
        printStepDone('WhatsApp connected');
      }
    });

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        if (!msg.message) continue;

        await this.handleMessage(msg);
      }
    });
  }

  private async handleMessage(msg: any): Promise<void> {
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
    const messageContent = msg.message;

    if (messageContent?.conversation) {
      content = messageContent.conversation;
    } else if (messageContent?.extendedTextMessage?.text) {
      content = messageContent.extendedTextMessage.text;
    } else if (messageContent?.imageMessage?.caption) {
      content = messageContent.imageMessage.caption;
    }

    const mentionTargets = this.extractMentionTargets(msg);
    const replyContext = this.extractReplyContext(messageContent);

    // Handle image messages (native multimodal)
    const images: string[] = [];
    if (messageContent?.imageMessage) {
      try {
        const stream = await this.downloadMedia(msg);
        if (stream) {
          const base64 = stream.toString('base64');
          images.push(`data:image/jpeg;base64,${base64}`);
        }
      } catch (err: any) {
        log.warn({ error: err.message }, 'Failed to download WhatsApp image');
      }
    }

    if (!content && images.length === 0) return;

    log.info({
      from: jid.replace('@s.whatsapp.net', ''),
      contentLength: content.length,
      hasImages: images.length > 0,
    }, 'WhatsApp message received');

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

  private extractMentionTargets(msg: any): MentionTarget[] {
    const jid = msg.key.remoteJid!;
    const messageContent = msg.message;
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

function buildEffectiveIncomingMessage(replyContext: string | null, content: string): string {
  return replyContext ? `${replyContext}\n\nUser reply: ${content}` : content;
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
  const parts = [
    'Conversation info (untrusted metadata):',
    '```json',
    JSON.stringify({
      platform: 'whatsapp',
      conversation_label: meta.conversationLabel,
      is_group_chat: meta.isGroupChat,
      was_mentioned: meta.wasMentioned,
    }, null, 2),
    '```',
    '',
    'Sender (untrusted metadata):',
    '```json',
    JSON.stringify(meta.sender, null, 2),
    '```',
  ];

  if (meta.mentionTargets.length > 0) {
    parts.push(
      '',
      'Known participants you may address (untrusted metadata):',
      '```json',
      JSON.stringify(
        meta.mentionTargets.slice(0, 8).map(target => ({
          label: target.label,
          handle: `@${target.aliases[0]}`,
          aliases: target.aliases.slice(0, 4).map(alias => `@${alias}`),
          id: target.id,
        })),
        null,
        2
      ),
      '```',
      '',
      'Use only these handles if you want to tag someone in your reply.'
    );
  }

  if (meta.replyContext) {
    parts.push('', meta.replyContext);
  }

  parts.push('', content);
  return parts.join('\n');
}

function formatReplyContext(author: string, content: string): string {
  return `[Reply context]\n${author}: ${content}\n[/Reply context]`;
}

function didMentionMe(messageContent: any, selfJid?: string): boolean {
  if (!selfJid) return false;
  const contextInfo =
    messageContent?.extendedTextMessage?.contextInfo ??
    messageContent?.imageMessage?.contextInfo ??
    messageContent?.videoMessage?.contextInfo ??
    messageContent?.documentMessage?.contextInfo;

  const mentioned = contextInfo?.mentionedJid ?? [];
  return mentioned.includes(selfJid);
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
