/**
 * LiteClaw — Cross-Channel Confirmation System
 * 
 * Handles destructive operation confirmations across WebUI (modals),
 * Discord (button interactions), and WhatsApp (interactive messages).
 */

import { EventEmitter } from 'events';
import { createLogger } from '../logger.js';

const log = createLogger('confirmation');

// ─── Types ───────────────────────────────────────────────────────────

export interface PendingConfirmation {
  id: string;
  toolName: string;
  description: string;
  channelType: 'webui' | 'discord' | 'whatsapp' | 'cli';
  channelTarget?: string;
  createdAt: number;
  timeoutMs: number;
  resolve: (confirmed: boolean) => void;
}

// ─── Confirmation Manager ────────────────────────────────────────────

export class ConfirmationManager extends EventEmitter {
  private pending = new Map<string, PendingConfirmation>();
  private defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 60_000) {
    super();
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Create a pending confirmation and wait for user response.
   * Emits 'confirmation_request' event for channels to handle.
   */
  async requestConfirmation(
    toolName: string,
    description: string,
    channelType: 'webui' | 'discord' | 'whatsapp' | 'cli',
    channelTarget?: string
  ): Promise<boolean> {
    const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        log.info({ id }, 'Confirmation timed out — defaulting to reject');
        resolve(false);
      }, this.defaultTimeoutMs);

      const confirmation: PendingConfirmation = {
        id,
        toolName,
        description,
        channelType,
        channelTarget,
        createdAt: Date.now(),
        timeoutMs: this.defaultTimeoutMs,
        resolve: (confirmed: boolean) => {
          clearTimeout(timeout);
          this.pending.delete(id);
          log.info({ id, confirmed }, 'Confirmation resolved');
          resolve(confirmed);
        },
      };

      this.pending.set(id, confirmation);

      // Emit event for the appropriate channel to render the confirmation UI
      this.emit('confirmation_request', confirmation);

      log.info(
        { id, tool: toolName, channel: channelType },
        'Confirmation requested'
      );
    });
  }

  /**
   * Resolve a pending confirmation (called by channel handlers).
   */
  resolveConfirmation(id: string, confirmed: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      log.warn({ id }, 'Attempted to resolve unknown confirmation');
      return false;
    }
    pending.resolve(confirmed);
    return true;
  }

  /**
   * Get all pending confirmations (for status display).
   */
  getPending(): PendingConfirmation[] {
    return Array.from(this.pending.values());
  }

  /**
   * Get a specific pending confirmation by ID.
   */
  getPendingById(id: string): PendingConfirmation | undefined {
    return this.pending.get(id);
  }

  /**
   * Cancel all pending confirmations.
   */
  cancelAll(): void {
    for (const [id, conf] of this.pending) {
      conf.resolve(false);
    }
    this.pending.clear();
  }
}

// ─── Build confirmation messages for each channel ────────────────────

export function buildWebUIConfirmation(conf: PendingConfirmation) {
  return {
    type: 'confirmation',
    id: conf.id,
    tool: conf.toolName,
    description: conf.description,
    timeoutMs: conf.timeoutMs,
  };
}

export function buildDiscordConfirmation(conf: PendingConfirmation) {
  return {
    embeds: [
      {
        title: '⚠️ Confirmation Required',
        description: conf.description,
        color: 0xffaa00, // Amber
        fields: [
          { name: 'Tool', value: `\`${conf.toolName}\``, inline: true },
          { name: 'Timeout', value: `${conf.timeoutMs / 1000}s`, inline: true },
        ],
        footer: { text: `ID: ${conf.id}` },
      },
    ],
    components: [
      {
        type: 1, // ActionRow
        components: [
          {
            type: 2, // Button
            style: 3, // Success (green)
            label: '✅ Confirm',
            custom_id: `liteclaw_confirm_${conf.id}`,
          },
          {
            type: 2,
            style: 4, // Danger (red)
            label: '❌ Cancel',
            custom_id: `liteclaw_reject_${conf.id}`,
          },
        ],
      },
    ],
  };
}

export function buildWhatsAppConfirmation(conf: PendingConfirmation) {
  return {
    text: `⚠️ *Confirmation Required*\n\n${conf.description}\n\n_Tool: \`${conf.toolName}\`_\n_Timeout: ${conf.timeoutMs / 1000}s_`,
    buttons: [
      { buttonId: `liteclaw_confirm_${conf.id}`, buttonText: { displayText: '✅ Confirm' } },
      { buttonId: `liteclaw_reject_${conf.id}`, buttonText: { displayText: '❌ Cancel' } },
    ],
  };
}
