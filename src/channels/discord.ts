/**
 * LiteClaw — Discord Channel
 * 
 * Features:
 * - Slash commands (/ask, /status, /clear, /help, /model)
 * - Emoji reaction progress (👀 → 🧠 → ⚙️ → ✅/❌)
 * - Dynamic bot status updates (reading files... → thinking... → idle)
 * - Button interactions for confirmations
 * - File attachment sending
 * - Formatted embed messages
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  AttachmentBuilder,
  ActivityType,
  type Message,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Partials,
} from 'discord.js';
import { existsSync } from 'fs';
import { basename, extname } from 'path';
import { AgentEngine, AgentRequest } from '../core/engine.js';
import { ConfirmationManager } from '../core/confirmation.js';
import { getConfig, getStateDir } from '../config.js';
import { createLogger } from '../logger.js';
import { preprocessImage } from '../tools/vision.js';
import type { InteractiveChoiceRequest } from '../core/tools.js';

const log = createLogger('discord');

interface MentionTarget {
  id: string;
  label: string;
  aliases: string[];
}

// ─── Reaction Emojis (progress indicators) ──────────────────────────

const REACTIONS = {
  /** Message received, starting to process */
  RECEIVED: '👀',
  /** Agent is thinking / generating */
  THINKING: '🧠',
  /** Running a tool */
  TOOL: '⚙️',
  /** Reading a file */
  READING: '📖',
  /** Writing a file */
  WRITING: '✍️',
  /** Searching the web */
  SEARCHING: '🔍',
  /** Running a command */
  EXECUTING: '💻',
  /** Processing complete — success */
  DONE: '✅',
  /** Processing complete — error */
  ERROR: '❌',
  /** Waiting for confirmation */
  WAITING: '⏳',
} as const;

// Tool name → specific reaction emoji
const TOOL_REACTIONS: Record<string, string> = {
  read_file: REACTIONS.READING,
  write_file: REACTIONS.WRITING,
  delete_file: REACTIONS.WRITING,
  list_dir: REACTIONS.READING,
  send_file: REACTIONS.READING,
  exec: REACTIONS.EXECUTING,
  web_search: REACTIONS.SEARCHING,
  web_fetch: REACTIONS.SEARCHING,
};

// ─── Dynamic Status Messages ─────────────────────────────────────────

const STATUS_MESSAGES = {
  idle: [
    'Chilling 🦎',
    'Ready to help.',
    'Awaiting orders...',
    'Standing by.',
    'Idling...',
    'At your service.',
    'Listening...',
    'All systems nominal.',
    'Resting...',
    'On standby.',
    'Powered by Gemma 4.',
    'Let me know if you need anything.',
    'Watching the world go by...',
    'Zen mode 🧘',
    'Fingers on keyboard...',
    'Cogitating in the background...',
    'Nothing to do, nothing to worry about.',
    'Calm before the storm.',
    'Waiting patiently...',
    'Daydreaming about tokens...',
  ],
  thinking: [
    'Thinking...',
    'Processing your request...',
    'Working on it...',
    'Let me think about that...',
    'Crunching tokens...',
    'Pondering...',
    'Reasoning through this...',
    'Analyzing...',
    'Mulling it over...',
    'Connecting the dots...',
    'Deep in thought...',
    'Brainstorming...',
    'Generating response...',
    'Almost there...',
    'Weighing options...',
    'Cooking up a response...',
    'Assembling thoughts...',
    'Running inference...',
  ],
  reading: [
    'Reading files...',
    'Scanning contents...',
    'Inspecting a file...',
    'Looking through files...',
    'Opening a file...',
    'Parsing content...',
    'Reading source code...',
    'Browsing directories...',
    'Peeking at files...',
    'Digesting file contents...',
  ],
  writing: [
    'Writing files...',
    'Creating a file...',
    'Saving changes...',
    'Updating a file...',
    'Drafting content...',
    'Generating output...',
    'Committing to disk...',
    'Building something...',
    'Crafting code...',
    'Putting pen to paper...',
  ],
  searching: [
    'Searching the web...',
    'Googling that...',
    'Browsing the internet...',
    'Looking it up...',
    'Scouring the web...',
    'Fetching search results...',
    'Researching...',
    'Finding sources...',
    'Querying Google...',
    'Gathering intel...',
  ],
  executing: [
    'Running a command...',
    'Executing in terminal...',
    'Running a script...',
    'In the shell...',
    'Processing command...',
    'Terminal time...',
    'Launching process...',
    'Hacking away...',
    'Compiling...',
    'Running the thing...',
  ],
  confirming: [
    'Waiting for confirmation...',
    'Need your approval...',
    'Paused — awaiting OK...',
    'Hold on — confirmation needed...',
    'Permission required...',
    'Awaiting the green light...',
  ],
} as const;

function pickRandom(arr: readonly string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Slash Command Definitions ───────────────────────────────────────

const SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask LiteClaw a question or give it a task')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Your message to the agent')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show LiteClaw status and health'),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear the current session\'s conversation history'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show LiteClaw commands and capabilities'),
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Show the current model and provider info'),
  new SlashCommandBuilder()
    .setName('tokens')
    .setDescription('Show current session token usage and compaction threshold'),
];

// ─── Discord Channel Class ───────────────────────────────────────────

export class DiscordChannel {
  private client: Client;
  private engine: AgentEngine;
  private confirmations: ConfirmationManager;
  private config: any;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private currentState: keyof typeof STATUS_MESSAGES = 'idle';
  private activeRequests = 0;
  private interactiveChoices = new Map<string, {
    prompt: string;
    options: string[];
    responses?: Record<string, string>;
    messageId: string;
    channelId: string;
    createdAt: number;
  }>();

  constructor(engine: AgentEngine, confirmations: ConfirmationManager) {
    this.engine = engine;
    this.confirmations = confirmations;
    this.config = getConfig().channels?.discord ?? {};

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [
        Partials.Channel,
        Partials.Message,
        Partials.Reaction,
        Partials.User,
        Partials.GuildMember,
        Partials.ThreadMember
      ],
    });

    this.client.on('debug', m => console.log('[DISCORD_DEBUG]', m));
    this.client.on('warn', m => console.warn('[DISCORD_WARN]', m));
    this.client.on('error', m => console.error('[DISCORD_ERROR]', m));
    this.client.on('raw', (p: any) => {
      // Workaround for discord.js dropping uncached DMs
      if (p.t === 'MESSAGE_CREATE' && !p.d.guild_id && p.d.channel_id) {
        if (!this.client.channels.cache.has(p.d.channel_id)) {
          console.log(`[RAW/HYDRATE] Auto-hydrating missing DM channel: ${p.d.channel_id}`);
          try {
            // Force add a partial DM channel
            (this.client.channels as any)._add({
              id: p.d.channel_id,
              type: 1, // ChannelType.DM
              recipients: [ p.d.author ]
            }, null, { cache: true });
          } catch (e) {
            console.error('[RAW/HYDRATE] Failed to inject channel', e);
          }
        }
      }
    });

    this.setupEventHandlers();
    this.setupConfirmationHandler();
  }

  // ─── Event Handlers ──────────────────────────────────────────────

  private setupEventHandlers(): void {
    this.client.once(Events.ClientReady, async (c) => {
      log.info({ user: c.user.tag }, 'Discord bot connected');
      console.log(`  ✓ Discord bot online as ${c.user.tag}`);

      // Register slash commands
      await this.registerSlashCommands(c.user.id);

      // Set initial idle status
      this.setStatus('idle');

      // Rotate idle status every 60s when not busy
      this.statusTimer = setInterval(() => {
        if (this.currentState === 'idle') {
          this.setStatus('idle');
        }
      }, 60_000);
    });

    // Regular messages (mention or DM)
    this.client.on(Events.MessageCreate, async (message) => {
      console.log('=> RAW messageCreate event fired!', message.author?.tag, message.content?.length);
      await this.handleMessage(message);
    });

    // Slash command interactions
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      } else if (interaction.isButton()) {
        await this.handleButtonInteraction(interaction as ButtonInteraction);
      }
    });
  }

  // ─── Dynamic Status ──────────────────────────────────────────────

  private setStatus(state: keyof typeof STATUS_MESSAGES): void {
    this.currentState = state;
    const statusText = pickRandom(STATUS_MESSAGES[state]);

    const statusMap: Record<string, 'online' | 'idle' | 'dnd' | 'invisible'> = {
      idle: 'online',
      thinking: 'dnd',
      reading: 'dnd',
      writing: 'dnd',
      searching: 'dnd',
      executing: 'dnd',
      confirming: 'idle',
    };

    this.client.user?.setPresence({
      status: statusMap[state] ?? 'online',
      activities: [{
        name: statusText,
        type: ActivityType.Custom,
        state: statusText,
      }],
    });

    log.debug({ state, statusText }, 'Updated Discord status');
  }

  private beginRequest(initialState: keyof typeof STATUS_MESSAGES = 'thinking'): void {
    this.activeRequests++;
    this.setStatus(initialState);
  }

  private endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests === 0) {
      this.setStatus('idle');
    }
  }

  /**
   * Transition status based on agent event,
   * mapping tool names to specific activity states.
   */
  private updateStatusForEvent(eventType: string, toolName?: string): void {
    switch (eventType) {
      case 'thinking':
        this.setStatus('thinking');
        break;
      case 'tool_start':
        if (toolName) {
          if (['read_file', 'list_dir', 'send_file'].includes(toolName)) {
            this.setStatus('reading');
          } else if (['write_file', 'delete_file'].includes(toolName)) {
            this.setStatus('writing');
          } else if (['web_search', 'web_fetch'].includes(toolName)) {
            this.setStatus('searching');
          } else if (toolName === 'exec') {
            this.setStatus('executing');
          } else {
            this.setStatus('thinking');
          }
        }
        break;
      case 'confirmation':
        this.setStatus('confirming');
        break;
    }
  }

  // ─── Reaction Progress ───────────────────────────────────────────

  /**
   * Add a reaction to the message. Silently fails on permission errors.
   */
  private async react(message: Message, emoji: string): Promise<void> {
    try {
      await message.react(emoji);
    } catch (err: any) {
      log.debug({ emoji, error: err.message }, 'Failed to react (missing permissions?)');
    }
  }

  /**
   * Remove a specific reaction the bot added.
   */
  private async unreact(message: Message, emoji: string): Promise<void> {
    try {
      const reaction = message.reactions.cache.find(r => r.emoji.name === emoji);
      if (reaction) {
        await reaction.users.remove(this.client.user!.id);
      } else {
        // Fallback: use raw REST API if cache is dead (happens in hydrated DMs)
        const emojiEncoded = encodeURIComponent(emoji);
        await (this.client as any).rest.delete(
          `/channels/${message.channelId}/messages/${message.id}/reactions/${emojiEncoded}/@me`
        );
      }
    } catch (err: any) {
      log.debug({ emoji, error: err.message }, 'Failed to remove reaction');
    }
  }

  /**
   * Get the appropriate reaction emoji for a tool.
   */
  private getToolReaction(toolName: string): string {
    return TOOL_REACTIONS[toolName] ?? REACTIONS.TOOL;
  }

  // ─── Slash Commands ──────────────────────────────────────────────

  private async registerSlashCommands(clientId: string): Promise<void> {
    try {
      const token = this.config.token ?? process.env.DISCORD_TOKEN;
      const guildId = this.config.guildId ?? process.env.DISCORD_GUILD_ID;
      const rest = new REST({ version: '10' }).setToken(token);

      const commandData = SLASH_COMMANDS.map(cmd => cmd.toJSON());

      if (guildId) {
        // Instant registration for a specific guild (faster for dev)
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
        log.info({ guildId, count: commandData.length }, 'Registered guild slash commands');
        console.log(`  ✓ Registered ${commandData.length} guild slash commands for ${guildId}`);
      } else {
        // Global registration (can take up to 1h to propagate)
        await rest.put(Routes.applicationCommands(clientId), { body: commandData });
        log.info({ count: commandData.length }, 'Registered global slash commands');
        console.log(`  ✓ Registered ${commandData.length} global slash commands (may take up to 1h to show up)`);
      }
    } catch (err: any) {
      log.error({ error: err.message }, 'Failed to register slash commands');
      console.log(`  ⚠ Failed to register slash commands: ${err.message}`);
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case 'ask':
        await this.handleAskCommand(interaction);
        break;
      case 'status':
        await this.handleStatusCommand(interaction);
        break;
      case 'clear':
        await this.handleClearCommand(interaction);
        break;
      case 'help':
        await this.handleHelpCommand(interaction);
        break;
      case 'model':
        await this.handleModelCommand(interaction);
        break;
      case 'tokens':
        await this.handleTokensCommand(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  }

  private async handleAskCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const message = interaction.options.getString('message', true);
    const mentionTargets = buildDiscordMentionTargetsFromInteraction(interaction);
    const effectiveMessage = buildStructuredIncomingMessage(
      {
        platform: 'discord',
        conversationLabel: interaction.guild
          ? `Guild #${interaction.channel?.isTextBased() && 'name' in interaction.channel ? interaction.channel.name : interaction.channelId}`
          : 'Discord DM',
        sender: {
          id: interaction.user.id,
          label: interaction.user.tag,
          name: interaction.user.displayName ?? interaction.user.username,
          username: interaction.user.username,
        },
        isGroupChat: Boolean(interaction.guildId),
        wasMentioned: false,
        mentionTargets,
      },
      message
    );

    // Defer reply since processing may take a while
    await interaction.deferReply();

    this.beginRequest('thinking');

    const sessionKey = `discord:${interaction.channelId}`;
    const request: AgentRequest = {
      message: effectiveMessage,
      sessionKey,
      channelType: 'discord',
      channelTarget: interaction.channelId,
      userIdentifier: interaction.user.tag,
      workingDir: this.config.workspace || getConfig().agent?.workspace || getStateDir(),
      sendInteractiveChoice: async (choiceRequest) => {
        return this.sendInteractiveChoice({
          channelId: interaction.channelId,
          replyTo: async (payload) => interaction.followUp(payload),
        }, choiceRequest);
      },
    };

    let fullContent = '';
    const toolUpdates: string[] = [];

    try {
      for await (const event of this.engine.processRequest(request)) {
        this.updateStatusForEvent(event.type, event.toolName);

        switch (event.type) {
          case 'content':
            fullContent += event.content ?? '';
            break;
          case 'tool_start':
            toolUpdates.push(`⚙ Running \`${event.toolName}\`...`);
            break;
          case 'tool_result':
            const icon = event.toolResult?.success ? '✓' : '✗';
            toolUpdates.push(`${icon} \`${event.toolName}\` ${event.toolResult?.success ? 'completed' : 'failed'}`);
            break;
          case 'error':
            fullContent += `\n⚠ Error: ${event.error}`;
            break;
        }
      }

      const messages = buildOutgoingMessages(
        fullContent,
        toolUpdates,
        {
          replyStyle: this.config.replyStyle ?? 'single',
          showToolProgress: this.config.showToolProgress ?? false,
        },
        1900
      );

      await interaction.editReply(messages[0] ?? '(No response)');
      for (let i = 1; i < messages.length; i++) {
        await interaction.followUp(messages[i]);
      }
    } catch (err: any) {
      log.error({ error: err.message }, 'Slash command /ask error');
      await interaction.editReply(`⚠ Error: ${err.message}`);
    } finally {
      this.endRequest();
    }
  }

  private async handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const config = getConfig();
    const port = config.gateway?.port ?? 7860;

    let gatewayStatus = '❌ Offline';
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json() as any;
        gatewayStatus = `✅ Online (uptime: ${Math.floor(data.uptime / 60)}m)`;
      }
    } catch { /* offline */ }

    const embed = new EmbedBuilder()
      .setTitle('🦎 LiteClaw Status')
      .addFields(
        { name: 'Gateway', value: gatewayStatus, inline: true },
        { name: 'Active Requests', value: `${this.activeRequests}`, inline: true },
        { name: 'Current State', value: this.currentState, inline: true },
        { name: 'Pending Confirmations', value: `${this.confirmations.getPending().length}`, inline: true },
      )
      .setColor(0x6c63ff)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  }

  private async handleClearCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    // Clear memory for this channel's session
    const { MemoryStore } = await import('../core/memory.js');
    const memory = new MemoryStore();
    const sessionKey = `discord:${interaction.channelId}`;
    memory.clearSession(sessionKey);
    memory.close();

    await interaction.reply({
      content: '🗑️ Session history cleared for this channel.',
      ephemeral: true,
    });
  }

  private async handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('🦎 LiteClaw Help')
      .setDescription('A lightweight AI agent running locally. Mention me or use slash commands.')
      .addFields(
        { name: 'Slash Commands', value: [
          '`/ask <message>` — Ask a question or give a task',
          '`/status` — Show bot status and health',
          '`/clear` — Clear conversation history',
          '`/model` — Show current model info',
          '`/help` — This help message',
        ].join('\n') },
        { name: 'Mention', value: 'You can also @mention me with your message in any channel.' },
        { name: 'Tools', value: [
          '📁 **File Operations** — read, write, delete, list, send files',
          '💻 **Command Execution** — run shell commands',
          '🔍 **Web Search** — Google Grounding + web fetch',
          '👁️ **Vision** — attach an image and I will inspect it natively',
        ].join('\n') },
        { name: 'Reactions', value: [
          '👀 Received your message',
          '🧠 Thinking...',
          '⚙️ Running a tool',
          '✅ Done / ❌ Error',
        ].join('\n') },
      )
      .setColor(0x6c63ff);

    await interaction.reply({ embeds: [embed] });
  }

  private async handleTokensCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionKey = `discord:${interaction.channelId}`;
    const { MemoryStore } = await import('../core/memory.js');
    const memory = new MemoryStore();
    const metrics = memory.getSessionMetrics(sessionKey);
    memory.close();

    const config = getConfig();
    const maxTokens = config.agent?.contextTokens ?? 64000;
    const threshold = config.agent?.compaction?.softThresholdTokens ?? 48000;
    
    const currentTokens = metrics.estimatedTokens;

    const percentage = Math.round((currentTokens / threshold) * 100);
    let statusEmoji = '🟢';
    if (percentage > 90) statusEmoji = '🔴';
    else if (percentage > 75) statusEmoji = '🟡';

    const embed = new EmbedBuilder()
      .setTitle('📊 Context Tokens')
      .setDescription(`Current session in this channel.`)
      .addFields(
        { name: 'Estimated Usage', value: `${currentTokens.toLocaleString()} tokens`, inline: true },
        { name: 'Messages', value: `${metrics.messageCount}`, inline: true },
        { name: 'Images', value: `${metrics.imageCount}`, inline: true },
        { name: 'Compaction Threshold', value: `${threshold.toLocaleString()} tokens`, inline: true },
        { name: 'System Max', value: `${maxTokens.toLocaleString()} tokens`, inline: true },
        { name: 'Status', value: `${statusEmoji} **${percentage}%** to compaction`, inline: false }
      )
      .setColor(0x6c63ff);

    await interaction.reply({ embeds: [embed] });
  }

  private async handleModelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const providers = this.engine.getLLMClient().getAllProviders();
    const activeProvider = this.engine.getLLMClient().getProviders()[0];
    const primaryId = activeProvider?.id ?? 'unknown';

    const fields: { name: string; value: string; inline: boolean }[] = [];
    for (const p of providers) {
      const isPrimary = p.id === primaryId;
      fields.push({
        name: `${isPrimary ? '★ ' : ''}${p.id}`,
        value: `Context: ${p.contextWindow} | Vision: ${p.supportsVision ? '✅' : '❌'}`,
        inline: true,
      });
    }

    const embed = new EmbedBuilder()
      .setTitle('🤖 Model Configuration')
      .addFields(fields.length > 0 ? fields : [{ name: 'No models', value: 'No models configured', inline: false }])
      .setColor(0x6c63ff);

    await interaction.reply({ embeds: [embed] });
  }

  // ─── Message Handler (with reactions + status) ───────────────────

  private async handleMessage(message: Message): Promise<void> {
    log.info({
      user: message.author?.tag,
      channel: message.channel.id,
      isPartial: message.partial,
      content: message.content ? '<has_content>' : '<empty>',
      attachments: message.attachments?.size ?? 0
    }, 'Discord message event triggered');

    if (message.partial) {
      try {
        await message.fetch();
      } catch (err) {
        log.error('Failed to fetch partial message');
        return;
      }
    }

    // Ignore own messages
    if (message.author.id === this.client.user?.id) return;
    // Ignore other bots unless configured
    if (message.author.bot && !this.config.allowBots) return;

    // Check if bot is mentioned or it's a DM
    const isMentioned = message.mentions.has(this.client.user!);
    const isDM = !message.guild;

    if (!isMentioned && !isDM) return;

    // Replace Discord mentions with readable string formats (@username) before sending to LLM.
    // Instead of stripping `<@123>`, we map it to `@username`.
    let content = message.content;
    const mentionTargets: MentionTarget[] = buildDiscordMentionTargetsFromMessage(message);

    for (const target of mentionTargets) {
      if (target.id === this.client.user?.id) continue;
      // Also catch role mentions, we'll just leave string variants.
      const pattern = new RegExp(`<@!?${target.id}>`, 'g');
      content = content.replace(pattern, `@${target.label}`);
    }

    // Strip out the bot's own mention
    if (this.client.user) {
       const selfPattern = new RegExp(`<@!?${this.client.user.id}>`, 'g');
       content = content.replace(selfPattern, '').trim();
    }

    if (!content && message.attachments.size === 0) return;

    const replyContext = await this.buildReplyContext(message);
    const effectiveMessage = buildStructuredIncomingMessage(
      {
        platform: 'discord',
        conversationLabel: message.guild
          ? `Guild #${message.channel.isTextBased() && 'name' in message.channel ? message.channel.name : message.channel.id}`
          : 'Discord DM',
        sender: {
          id: message.author.id,
          label: message.author.tag,
          name: message.member?.displayName || message.author.globalName || message.author.username,
          username: message.author.username,
          tag: message.author.tag,
        },
        isGroupChat: Boolean(message.guildId),
        wasMentioned: isMentioned,
        mentionTargets,
        replyContext,
      },
      content || '(image attached)'
    );

    log.info({
      user: message.author.tag,
      channel: message.channel.id,
      isDM,
      contentLength: content.length,
    }, 'Discord message passed filters');

    // ── Step 1: React with 👀 (received) ──
    await this.react(message, REACTIONS.RECEIVED);
    this.beginRequest('thinking');

    const images = await this.collectMessageImages(message);

    // ── Continuous typing indicator ──
    // Discord typing indicator lasts ~10s. We send every 7s to keep it alive.
    const typingInterval = setInterval(async () => {
      try {
        await (message.channel as any).sendTyping();
      } catch { /* ignore */ }
    }, 7_000);

    // Send initial typing
    try {
      await (message.channel as any).sendTyping();
    } catch { /* ignore */ }

    // Build session key
    const sessionKey = `discord:${message.channel.id}`;

    const request: AgentRequest = {
      message: effectiveMessage,
      images: images.length > 0 ? images : undefined,
      sessionKey,
      channelType: 'discord',
      channelTarget: message.channel.id,
      userIdentifier: message.author.tag,
      workingDir: this.config.workspace || getConfig().agent?.workspace || getStateDir(),
      sendFile: async (filePath: string, fileName?: string) => {
        await this.sendFile(message, filePath, fileName);
      },
      sendInteractiveChoice: async (choiceRequest) => {
        return this.sendInteractiveChoice({
          channelId: message.channel.id,
          replyTo: async (payload) => message.reply(payload),
        }, choiceRequest);
      },
    };

    // Process and accumulate response
    let fullContent = '';
    const toolUpdates: string[] = [];
    let hasThought = false;
    const addedReactions = new Set<string>();

    try {
      for await (const event of this.engine.processRequest(request)) {
        this.updateStatusForEvent(event.type, event.toolName);

        // Remove the looking emoji once the agent starts doing ANY work (thinking, content, tools)
        if (['thinking', 'content', 'tool_start'].includes(event.type) && addedReactions.has(REACTIONS.RECEIVED)) {
          await this.unreact(message, REACTIONS.RECEIVED);
          addedReactions.delete(REACTIONS.RECEIVED);
        }

        switch (event.type) {
          case 'thinking':
            // React with 🧠 on first thinking chunk
            if (!hasThought) {
              await this.react(message, REACTIONS.THINKING);
              addedReactions.add(REACTIONS.THINKING);
              hasThought = true;
            }
            break;

          case 'content':
            fullContent += event.content ?? '';
            // Remove thinking reaction once content starts flowing
            if (addedReactions.has(REACTIONS.THINKING)) {
              await this.unreact(message, REACTIONS.THINKING);
              addedReactions.delete(REACTIONS.THINKING);
            }
            break;

          case 'tool_start':
            // React with tool-specific emoji
            const toolEmoji = this.getToolReaction(event.toolName ?? '');
            if (!addedReactions.has(toolEmoji)) {
              await this.react(message, toolEmoji);
              addedReactions.add(toolEmoji);
            }
            toolUpdates.push(`⚙ Running \`${event.toolName}\`...`);
            break;

          case 'tool_result': {
            const icon = event.toolResult?.success ? '✓' : '✗';
            toolUpdates.push(`${icon} \`${event.toolName}\` ${event.toolResult?.success ? 'completed' : 'failed'}`);
            // Clean up tool-specific reaction
            const doneToolEmoji = this.getToolReaction(event.toolName ?? '');
            if (addedReactions.has(doneToolEmoji)) {
              await this.unreact(message, doneToolEmoji);
              addedReactions.delete(doneToolEmoji);
            }
            break;
          }

          case 'error':
            fullContent += `\n⚠ Error: ${event.error}`;
            break;
        }
      }

      // ── Final: remove intermediate reactions, add ✅ ──
      for (const emoji of addedReactions) {
        await this.unreact(message, emoji);
      }
      await this.react(message, REACTIONS.DONE);

      // Timeout to remove the check emoji after 10s
      setTimeout(async () => {
        await this.unreact(message, REACTIONS.DONE);
      }, 10_000);

      // Format and send response
      await this.sendResponse(message, fullContent, toolUpdates, mentionTargets);

      log.info({
        user: message.author.tag,
        responseLength: fullContent.length,
        tools: toolUpdates.length,
      }, 'Discord response sent');

    } catch (err: any) {
      log.error({ error: err.message }, 'Discord message handling error');

      // Clean up and add error reaction
      for (const emoji of addedReactions) {
        await this.unreact(message, emoji);
      }
      await this.react(message, REACTIONS.ERROR);
      await message.reply(`⚠ Error: ${err.message}`);
    } finally {
      clearInterval(typingInterval);
      this.endRequest();
    }
  }

  private async buildReplyContext(message: Message): Promise<string | null> {
    if (!message.reference?.messageId) return null;

    try {
      const referenced = typeof message.fetchReference === 'function'
        ? await message.fetchReference()
        : null;

      if (!referenced) return null;

      const referencedContent = referenced.content?.trim() || summarizeAttachments(referenced.attachments);
      if (!referencedContent) return null;

      return formatReplyContext(
        referenced.author?.tag || referenced.author?.username || 'Unknown user',
        referencedContent
      );
    } catch (err: any) {
      log.debug({ error: err.message, messageId: message.id }, 'Failed to fetch replied-to Discord message');
      return null;
    }
  }

  // ─── Response Sending ────────────────────────────────────────────

  private async collectMessageImages(message: Message): Promise<string[]> {
    const images: string[] = [];

    for (const [, attachment] of message.attachments) {
      const image = await this.fetchAttachmentAsImageData(attachment, 'message');
      if (image) images.push(image);
    }

    if (!message.reference?.messageId) return images;

    try {
      const referenced = typeof message.fetchReference === 'function'
        ? await message.fetchReference()
        : null;

      if (!referenced) return images;

      for (const [, attachment] of referenced.attachments) {
        const image = await this.fetchAttachmentAsImageData(attachment, 'quoted_reply');
        if (image) images.push(image);
      }
    } catch (err: any) {
      log.debug({ error: err.message, messageId: message.id }, 'Failed to fetch replied-to Discord images');
    }

    return images;
  }

  private async fetchAttachmentAsImageData(attachment: any, reason: string): Promise<string | null> {
    const contentType = attachment.contentType ?? '';
    const imageByType = contentType.startsWith('image/');
    const imageByExtension = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/i.test(
      attachment.name ?? extname(attachment.url)
    );

    if (!imageByType && !imageByExtension) return null;

    try {
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} when fetching attachment`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      return await preprocessImage(buffer);
    } catch (err: any) {
      log.warn({
        error: err.message,
        reason,
        attachmentName: attachment.name,
        contentType: attachment.contentType,
        url: attachment.url,
      }, 'Failed to fetch Discord image attachment');
      return null;
    }
  }

  private async sendResponse(
    message: Message,
    content: string,
    toolUpdates: string[],
    mentionTargets: MentionTarget[]
  ): Promise<void> {
    // Convert markdown tables to bullets if configured
    if (this.config.markdown?.tables === 'bullets') {
      content = convertTablesToBullets(content);
    }

    const messages = buildOutgoingMessages(
      content,
      toolUpdates,
      {
        replyStyle: this.config.replyStyle ?? 'single',
        showToolProgress: this.config.showToolProgress ?? false,
      },
      1900
    );

    for (let i = 0; i < messages.length; i++) {
      const resolved = resolveDiscordMentions(messages[i], mentionTargets);
      if (i === 0) {
        await message.reply({
          content: resolved.content,
          allowedMentions: {
            users: resolved.userIds,
            repliedUser: false,
          },
        });
      } else {
        await (message.channel as any).send({
          content: resolved.content,
          allowedMentions: {
            users: resolved.userIds,
          },
        });
      }
    }
  }

  // ─── File Sending ────────────────────────────────────────────────

  private async sendFile(message: Message, filePath: string, fileName?: string): Promise<void> {
    if (!existsSync(filePath)) {
      await (message.channel as any).send(`⚠ File not found: ${filePath}`);
      return;
    }

    const name = fileName ?? basename(filePath);
    const attachment = new AttachmentBuilder(filePath, { name });

    await (message.channel as any).send({
      content: `📎 Sending file: **${name}**`,
      files: [attachment],
    });

    log.info({ file: name, channel: message.channel.id }, 'Sent file to Discord');
  }

  // ─── Button Interactions (Confirmations) ─────────────────────────

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith('liteclaw_confirm_')) {
      const confirmId = customId.replace('liteclaw_confirm_', '');
      this.confirmations.resolveConfirmation(confirmId, true);
      await interaction.update({
        content: '✅ **Confirmed** — proceeding with the operation.',
        components: [],
      });
    } else if (customId.startsWith('liteclaw_reject_')) {
      const confirmId = customId.replace('liteclaw_reject_', '');
      this.confirmations.resolveConfirmation(confirmId, false);
      await interaction.update({
        content: '❌ **Cancelled** — operation was rejected.',
        components: [],
      });
    } else if (customId.startsWith('liteclaw_choice_')) {
      await this.handleInteractiveChoice(interaction);
    }
  }

  // ─── Confirmation Handler ────────────────────────────────────────

  private setupConfirmationHandler(): void {
    this.confirmations.on('confirmation_request', async (conf) => {
      if (conf.channelType !== 'discord' || !conf.channelTarget) return;

      this.setStatus('confirming');

      try {
        const channel = await this.client.channels.fetch(conf.channelTarget);
        if (!channel?.isTextBased()) return;

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`liteclaw_confirm_${conf.id}`)
            .setLabel('✅ Confirm')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`liteclaw_reject_${conf.id}`)
            .setLabel('❌ Cancel')
            .setStyle(ButtonStyle.Danger),
        );

        const embed = new EmbedBuilder()
          .setTitle('⚠️ Confirmation Required')
          .setDescription(conf.description)
          .addFields(
            { name: 'Tool', value: `\`${conf.toolName}\``, inline: true },
            { name: 'Timeout', value: `${conf.timeoutMs / 1000}s`, inline: true },
          )
          .setColor(0xffaa00)
          .setFooter({ text: `ID: ${conf.id}` });

        await (channel as any).send({ embeds: [embed], components: [row] });
      } catch (err: any) {
        log.error({ error: err.message }, 'Failed to send Discord confirmation');
      }
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    const token = this.config.token ?? process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error('Discord token not configured. Set DISCORD_TOKEN in .env or config.yaml');
    }

    await this.client.login(token);
  }

  stop(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.client.destroy();
  }

  private async sendInteractiveChoice(
    target: {
      channelId: string;
      replyTo: (payload: {
        content: string;
        components: ActionRowBuilder<ButtonBuilder>[];
      }) => Promise<any>;
    },
    request: InteractiveChoiceRequest
  ): Promise<string> {
    this.pruneInteractiveChoices();

    const options = request.options
      .map(option => option.trim())
      .filter(Boolean)
      .slice(0, 5);

    if (options.length === 0) {
      throw new Error('Interactive choices require at least one option.');
    }

    const choiceId = `choice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...options.map((option, index) =>
        new ButtonBuilder()
          .setCustomId(`liteclaw_choice_${choiceId}_${index}`)
          .setLabel(option.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
      )
    );

    const sent = await target.replyTo({
      content: request.prompt,
      components: [row],
    });

    this.interactiveChoices.set(choiceId, {
      prompt: request.prompt,
      options,
      responses: request.responses,
      messageId: sent?.id ?? '',
      channelId: target.channelId,
      createdAt: Date.now(),
    });

    return choiceId;
  }

  private async handleInteractiveChoice(interaction: ButtonInteraction): Promise<void> {
    const match = interaction.customId.match(/^liteclaw_choice_(choice_[^_]+_[^_]+)_(\d+)$/);
    if (!match) {
      await interaction.reply({ content: '⚠ That interactive choice is invalid.', ephemeral: true });
      return;
    }

    const [, choiceId, rawIndex] = match;
    const record = this.interactiveChoices.get(choiceId);
    if (!record) {
      await interaction.reply({ content: '⚠ That interactive choice has expired.', ephemeral: true });
      return;
    }

    const index = Number.parseInt(rawIndex, 10);
    const option = record.options[index];
    if (!option) {
      await interaction.reply({ content: '⚠ That choice option is no longer available.', ephemeral: true });
      return;
    }

    const response = record.responses?.[option]?.trim()
      || `${interaction.user} picked **${option}**.`;
    const content = response.includes(`<@${interaction.user.id}>`) || response.includes(interaction.user.username)
      ? response
      : `${interaction.user} ${response}`;

    await interaction.reply({
      content,
      allowedMentions: { users: [interaction.user.id] },
    });
  }

  private pruneInteractiveChoices(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [choiceId, record] of this.interactiveChoices) {
      if (record.createdAt < cutoff) {
        this.interactiveChoices.delete(choiceId);
      }
    }
  }
}

// ─── Utilities ───────────────────────────────────────────────────────

function splitMessage(text: string, maxLen: number): string[] {
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
    platform: 'discord' | 'whatsapp';
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
  const senderLabel = meta.sender.name || meta.sender.label || meta.sender.username || 'unknown';
  const senderHandle = meta.sender.username || meta.sender.tag || senderLabel;
  const chatType = meta.isGroupChat ? 'group' : 'DM';

  const parts: string[] = [
    `[context: ${meta.platform} | ${chatType} | ${meta.conversationLabel} | sender: ${senderLabel} (${senderHandle})]`,
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

function buildDiscordMentionTargetsFromInteraction(interaction: ChatInputCommandInteraction): MentionTarget[] {
  return dedupeMentionTargets([
    createDiscordMentionTarget(
      interaction.user.id,
      interaction.user.displayName ?? interaction.user.globalName ?? interaction.user.username,
      interaction.user.username,
      interaction.user.tag
    ),
  ]);
}

function buildDiscordMentionTargetsFromMessage(message: Message): MentionTarget[] {
  const targets: MentionTarget[] = [];
  targets.push(
    createDiscordMentionTarget(
      message.author.id,
      message.member?.displayName || message.author.globalName || message.author.username,
      message.author.username,
      message.author.tag
    )
  );

  for (const [, user] of message.mentions.users) {
    if (user.id === message.client.user?.id) continue;
    const member = message.guild?.members.cache.get(user.id);
    targets.push(
      createDiscordMentionTarget(
        user.id,
        member?.displayName || user.globalName || user.username,
        user.username,
        user.tag
      )
    );
  }

  if (message.reference?.messageId && message.mentions.repliedUser) {
    const user = message.mentions.repliedUser;
    const member = message.guild?.members.cache.get(user.id);
    targets.push(
      createDiscordMentionTarget(
        user.id,
        member?.displayName || user.globalName || user.username,
        user.username,
        user.tag
      )
    );
  }

  return dedupeMentionTargets(targets);
}

function createDiscordMentionTarget(id: string, ...labels: Array<string | undefined>): MentionTarget {
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
  const clean = label
    .replace(/^@+/, '')
    .replace(/#\d{4}$/g, '')
    .trim();
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

function resolveDiscordMentions(text: string, targets: MentionTarget[]): { content: string; userIds: string[] } {
  let content = text;
  const mentioned = new Set<string>();

  for (const target of targets) {
    const sortedAliases = [...target.aliases].sort((a, b) => b.length - a.length);
    for (const alias of sortedAliases) {
      const escaped = escapeRegex(alias.replace(/^@+/, ''));
      const pattern = new RegExp(`(^|[^\\w<])@${escaped}(?=$|[^\\w>])`, 'giu');
      content = content.replace(pattern, (match, prefix) => {
        mentioned.add(target.id);
        return `${prefix}<@${target.id}>`;
      });
    }
  }

  return { content, userIds: Array.from(mentioned) };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summarizeAttachments(attachments: Message['attachments']): string {
  if (!attachments || attachments.size === 0) return '';
  return Array.from(attachments.values())
    .map(att => att.name ? `[attachment: ${att.name}]` : '[attachment]')
    .join(' ');
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

  return splitMessage(fullText, maxLen);
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

function convertTablesToBullets(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inTable = false;
  let headers: string[] = [];

  for (const line of lines) {
    if (line.match(/^\|.*\|$/)) {
      if (line.match(/^\|[\s-:|]+\|$/)) {
        continue;
      }
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
      if (!inTable) {
        headers = cells;
        inTable = true;
      } else {
        const bullet = cells.map((c, i) => `**${headers[i] ?? ''}**: ${c}`).join(' · ');
        result.push(`• ${bullet}`);
      }
    } else {
      inTable = false;
      headers = [];
      result.push(line);
    }
  }

  return result.join('\n');
}
