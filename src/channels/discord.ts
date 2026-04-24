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
  type InteractionEditReplyOptions,
  type AnySelectMenuInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
  type ThreadChannel,
  type DMChannel,
  type User,
  Partials,
} from 'discord.js';
import { existsSync } from 'fs';
import { basename, extname } from 'path';
import { AgentEngine, AgentRequest, AgentStreamEvent } from '../core/engine.js';
import { ConfirmationManager } from '../core/confirmation.js';
import { getConfig, getStateDir } from '../config.js';
import { createLogger } from '../logger.js';
import { preprocessImage } from '../tools/vision.js';
import type { InteractiveChoiceRequest } from '../core/tools.js';
import { sanitizeChannelContent, splitMessage } from './utils.js';
import { DND_SLASH_COMMANDS, DndDiscordController } from '../dnd/discord.js';
import type { DndSessionDetails } from '../dnd/types.js';

const log = createLogger('discord');

interface MentionTarget {
  id: string;
  label: string;
  aliases: string[];
}

interface DiscordProgressState {
  startedAt: number;
  status: 'starting' | 'thinking' | 'planning' | 'working' | 'done' | 'error';
  planSummary: string;
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    summary?: string;
  }>;
  currentTaskLabel?: string;
  recentTools: string[];
  error?: string;
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
  new SlashCommandBuilder()
    .setName('question')
    .setDescription('Ask the GM an out-of-band question about the current DnD session')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Your question for the GM')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Whether the GM answer should be private or visible to the table')
        .setRequired(false)
        .addChoices(
          { name: 'private', value: 'private' },
          { name: 'public', value: 'public' },
        )),
  ...DND_SLASH_COMMANDS,
];

// ─── Discord Channel Class ───────────────────────────────────────────

export class DiscordChannel {
  private client: Client;
  private engine: AgentEngine;
  private confirmations: ConfirmationManager;
  private dnd: DndDiscordController;
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
              recipients: [p.d.author]
            }, null, { cache: true });
          } catch (e) {
            console.error('[RAW/HYDRATE] Failed to inject channel', e);
          }
        }
      }
    });

    this.dnd = new DndDiscordController(this.client, this.engine.getMemory());
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
      this.dnd.scheduleOpenVotes();

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
    this.client.on('interactionCreate', async (interaction) => {
      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      } else if (interaction.isButton()) {
        await this.handleButtonInteraction(interaction as ButtonInteraction);
      } else if (interaction.isAnySelectMenu()) {
        await this.handleSelectMenuInteraction(interaction);
      } else if (interaction.isModalSubmit()) {
        await this.handleModalInteraction(interaction);
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
      case 'plan':
      case 'task_update':
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
      const rest = new REST({ version: '10' }).setToken(token);
      const commandData = SLASH_COMMANDS.map(cmd => cmd.toJSON());
      const configuredGuildId = this.config.guildId ?? process.env.DISCORD_GUILD_ID;
      const connectedGuildIds = this.client.guilds.cache.map(guild => guild.id);
      const guildIds = configuredGuildId
        ? [configuredGuildId]
        : connectedGuildIds;

      if (guildIds.length > 0) {
        // Clear stale global commands so Discord does not show duplicate
        // entries when this bot has previously registered globally.
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        log.info('Cleared global slash commands before guild registration');

        for (const guildId of guildIds) {
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
          log.info({ guildId, count: commandData.length }, 'Registered guild slash commands');
          console.log(`  ✓ Registered ${commandData.length} guild slash commands for ${guildId}`);
        }
        if (!configuredGuildId && guildIds.length > 1) {
          console.log(`  ✓ Registered commands across ${guildIds.length} connected guilds for faster Discord propagation`);
        }
      } else {
        // Fallback when the bot is not yet aware of any guilds.
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
    const dndResult = await this.dnd.handleCommand(interaction);
    if (dndResult === true) {
      return;
    }
    if (typeof dndResult === 'string') {
      // It's a roll result! Trigger the engine so the GM reacts.
      await this.processDndActionChoice(interaction, dndResult);
      return;
    }

    const dndSession = this.dnd.getSessionForThread(interaction.channelId);
    const inProtectedDndThread = Boolean(dndSession);
    const isDndPlayer = dndSession
      ? this.dnd.isPlayerInThread(interaction.channelId, interaction.user.id)
      : false;

    if (interaction.commandName === 'clear' && inProtectedDndThread) {
      await interaction.reply({
        content: 'This thread is protected as an active DnD session. `/clear` is disabled here.',
        ephemeral: true,
      });
      return;
    }

    if (inProtectedDndThread && !isDndPlayer) {
      await interaction.reply({
        content: 'Only enrolled DnD session players can use LiteClaw commands in this thread. Use `/dnd join` to join midway.',
        ephemeral: true,
      });
      return;
    }

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
      case 'question':
        await this.handleQuestionCommand(interaction);
        break;
      default:
        await interaction.reply({ content: 'Unknown command.', ephemeral: true });
    }
  }

  private async handleAskCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const message = interaction.options.getString('message', true);
    const mentionTargets = buildDiscordMentionTargetsFromInteraction(interaction);
    const dndSession = this.dnd.getSessionForThread(interaction.channelId);
    let dndRagContext = 'No relevant RAG context found for this session yet.';
    if (dndSession) {
      try {
        dndRagContext = await this.dnd.buildNarrativeRagContext(interaction.channelId, message);
      } catch (error: any) {
        log.warn({ error: error.message, channelId: interaction.channelId }, 'Failed to build DnD narrative RAG context');
      }
    }
    const rawMessage = dndSession
      ? this.dnd.buildTableTalkPrompt(interaction.channelId, interaction.user.id, message, dndRagContext)
      : message;
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
      rawMessage
    );

    // Defer reply since processing may take a while
    await interaction.deferReply();

    const sessionKey = `discord:${interaction.channelId}`;
    const request: AgentRequest = {
      message: effectiveMessage,
      sessionKey,
      disablePlanner: Boolean(dndSession),
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

    // For DnD sessions, use the dedicated GM system prompt and keep reasoning enabled
    if (dndSession) {
      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const gmPromptPath = resolve(process.cwd(), 'config/dnd_gm_prompt.md');
      if (existsSync(gmPromptPath)) {
        request.systemPromptOverride = readFileSync(gmPromptPath, 'utf-8');
      }
    }

    let fullContent = '';
    const toolUpdates: string[] = [];
    const progress = createDiscordProgressState();
    let lastProgressFlush = 0;

    const flushProgress = async (force = false, finalContent?: string): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastProgressFlush < 1500) return;
      lastProgressFlush = now;

      const hasPlan = progress.tasks.length > 0;
      const payload: InteractionEditReplyOptions = {
        embeds: hasPlan ? [buildDiscordProgressEmbed(progress, finalContent)] : [],
      };

      if (finalContent !== undefined) {
        payload.content = finalContent || null;
      } else if (!hasPlan) {
        payload.content = `_${discordProgressStatusLabel(progress.status)}..._`;
      } else {
        payload.content = null;
      }

      await interaction.editReply(payload);
    };

    try {
      this.beginRequest('thinking');
      await flushProgress(true);
      for await (const event of this.engine.processRequest(request)) {
        this.updateStatusForEvent(event.type, event.toolName);
        applyEventToDiscordProgress(progress, event);

        switch (event.type) {
          case 'content':
            fullContent += event.content ?? '';
            break;
          case 'plan':
            toolUpdates.push(`🗺️ Planned ${event.plan?.tasks?.length ?? 0} task${(event.plan?.tasks?.length ?? 0) === 1 ? '' : 's'}`);
            break;
          case 'task_update': {
            const prefix = event.taskIndex && event.taskTotal
              ? `[${event.taskIndex}/${event.taskTotal}] `
              : '';
            if (event.taskStatus === 'in_progress') {
              toolUpdates.push(`→ ${prefix}${event.taskTitle}`);
            } else if (event.taskStatus) {
              const icon = event.taskStatus === 'completed' ? '✓' : event.taskStatus === 'blocked' ? '⚠' : '✗';
              toolUpdates.push(`${icon} ${prefix}${event.taskTitle}${event.taskSummary ? ` — ${event.taskSummary}` : ''}`);
            }
            break;
          }
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

        await flushProgress();
      }

      const structuredNarrative = dndSession
        ? await this.dnd.processStructuredNarrativeResponse(interaction.channelId, fullContent)
        : { content: fullContent, shopEmbeds: [], combatEmbeds: [], combatComponents: null, actionComponents: null, rollComponents: null };

      progress.status = progress.error ? 'error' : 'done';

      if (dndSession) {
        // For DnD: send narrative as a rich embed, clear progress embed
        const narrativeEmbed = new EmbedBuilder()
          .setColor(0x8e44ad)
          .setDescription(structuredNarrative.content.slice(0, 4096));
        const trackerEmbed = this.dnd.buildTurnTrackerEmbed(interaction.channelId);

        await interaction.editReply({
          content: null,
          embeds: [
            narrativeEmbed,
            ...(trackerEmbed ? [trackerEmbed] : []),
            ...structuredNarrative.shopEmbeds,
            ...structuredNarrative.combatEmbeds,
          ],
          components: [
            ...(structuredNarrative.combatComponents || []),
            ...(structuredNarrative.actionComponents || []),
            ...(structuredNarrative.rollComponents || []),
          ].slice(0, 5),
        });
      } else {
        // Non-DnD: standard text output
        const messages = buildOutgoingMessages(
          structuredNarrative.content,
          toolUpdates,
          {
            replyStyle: this.config.replyStyle ?? 'single',
            showToolProgress: this.config.showToolProgress ?? false,
          },
          1900
        );
        await flushProgress(true, messages[0] ?? '(No response)');
        for (let i = 1; i < messages.length; i++) {
          await interaction.followUp(messages[i]);
        }
      }
    } catch (err: any) {
      log.error({ error: err.message }, 'Slash command /ask error');
      progress.status = 'error';
      progress.error = err.message;
      await flushProgress(true, `⚠ Error: ${err.message}`);
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
        {
          name: 'Slash Commands', value: [
            '`/ask <message>` — Ask a question or give a task',
            '`/status` — Show bot status and health',
            '`/clear` — Clear conversation history',
            '`/model` — Show current model info',
            '`/help` — This help message',
          ].join('\n')
        },
        { name: 'Mention', value: 'You can also @mention me with your message in any channel.' },
        {
          name: 'Tools', value: [
            '📁 **File Operations** — read, write, delete, list, send files',
            '💻 **Command Execution** — run shell commands',
            '🔍 **Web Search** — Google Grounding + web fetch',
            '👁️ **Vision** — attach an image and I will inspect it natively',
          ].join('\n')
        },
        {
          name: 'Reactions', value: [
            '👀 Received your message',
            '🧠 Thinking...',
            '⚙️ Running a tool',
            '✅ Done / ❌ Error',
          ].join('\n')
        },
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

  private async handleQuestionCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const dndDetails = this.dnd.getSessionForThread(interaction.channelId);
    if (!dndDetails) {
      await interaction.reply({
        content: '`/question` is only available inside a protected DnD session thread.',
        ephemeral: true,
      });
      return;
    }

    if (!this.dnd.isPlayerInThread(interaction.channelId, interaction.user.id)) {
      await interaction.reply({
        content: 'Only enrolled DnD session players can ask private GM questions in this thread.',
        ephemeral: true,
      });
      return;
    }

    const message = interaction.options.getString('message', true);
    const mode = interaction.options.getString('mode') === 'public' ? 'public' : 'private';
    let ragContext = 'RAG session context is not available yet.';
    try {
      ragContext = await this.dnd.buildQuestionContext(interaction.channelId, message);
    } catch (error: any) {
      log.warn({ error: error.message, channelId: interaction.channelId }, 'Failed to build DnD RAG question context');
    }

    const mentionTargets = buildDiscordMentionTargetsFromInteraction(interaction);
    const effectiveMessage = buildStructuredIncomingMessage(
      {
        platform: 'discord',
        conversationLabel: `DnD Thread #${interaction.channel?.isTextBased() && 'name' in interaction.channel ? interaction.channel.name : interaction.channelId}`,
        sender: {
          id: interaction.user.id,
          label: interaction.user.tag,
          name: interaction.user.displayName ?? interaction.user.username,
          username: interaction.user.username,
        },
        isGroupChat: true,
        wasMentioned: false,
        mentionTargets,
      },
      buildDndQuestionPrompt(dndDetails, interaction.user.id, message, mode, ragContext),
    );

    await interaction.deferReply({ ephemeral: mode === 'private' });

    const request: AgentRequest = {
      message: effectiveMessage,
      sessionKey: `discord:dnd-question:${dndDetails.session.id}:${interaction.user.id}:${mode}`,
      disablePlanner: true,
      disableReasoning: true,
      channelType: 'discord',
      channelTarget: interaction.channelId,
      userIdentifier: `${interaction.user.tag} [dnd-question:${mode}]`,
      workingDir: this.config.workspace || getConfig().agent?.workspace || getStateDir(),
    };

    let fullContent = '';
    const toolUpdates: string[] = [];
    const progress = createDiscordProgressState();
    let lastProgressFlush = 0;

    const flushProgress = async (force = false, finalContent?: string): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastProgressFlush < 1500) return;
      lastProgressFlush = now;

      const hasPlan = progress.tasks.length > 0;
      const payload: InteractionEditReplyOptions = {
        embeds: hasPlan ? [buildDiscordProgressEmbed(progress, finalContent)] : [],
      };

      if (finalContent !== undefined) {
        payload.content = finalContent || null;
      } else if (!hasPlan) {
        payload.content = `_${discordProgressStatusLabel(progress.status)}..._`;
      } else {
        payload.content = null;
      }

      await interaction.editReply(payload);
    };

    try {
      this.beginRequest('thinking');
      await flushProgress(true);
      for await (const event of this.engine.processRequest(request)) {
        this.updateStatusForEvent(event.type, event.toolName);
        applyEventToDiscordProgress(progress, event);

        switch (event.type) {
          case 'content':
            fullContent += event.content ?? '';
            break;
          case 'plan':
            toolUpdates.push(`Planned ${event.plan?.tasks?.length ?? 0} tasks`);
            break;
          case 'task_update':
            if (event.taskStatus === 'in_progress') {
              toolUpdates.push(`Working on ${event.taskTitle}`);
            }
            break;
          case 'tool_start':
            toolUpdates.push(`Running \`${event.toolName}\`...`);
            break;
          case 'tool_result':
            toolUpdates.push(`${event.toolResult?.success ? 'Finished' : 'Failed'} \`${event.toolName}\``);
            break;
          case 'error':
            fullContent += `\nError: ${event.error}`;
            break;
        }

        await flushProgress();
      }

      const messages = buildOutgoingMessages(
        fullContent,
        toolUpdates,
        {
          replyStyle: 'single',
          showToolProgress: false,
        },
        1900,
      );

      progress.status = progress.error ? 'error' : 'done';
      await flushProgress(true, messages[0] ?? '(No response)');
      for (let i = 1; i < messages.length; i++) {
        await interaction.followUp({ content: messages[i], ephemeral: mode === 'private' });
      }
    } catch (err: any) {
      log.error({ error: err.message }, 'Slash command /question error');
      progress.status = 'error';
      progress.error = err.message;
      await flushProgress(true, `Error: ${err.message}`);
    } finally {
      this.endRequest();
    }
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

    const dndSession = this.dnd.getSessionForThread(message.channel.id);
    const inProtectedDndThread = Boolean(dndSession);
    const isDndPlayer = dndSession
      ? this.dnd.isPlayerInThread(message.channel.id, message.author.id)
      : false;

    if (inProtectedDndThread && !isDndPlayer) {
      await message.reply({
        content: 'This DnD thread is reserved for enrolled players. Use `/dnd join` if you want to join the campaign midway.',
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const replyMeta = await this.getReplyMetadata(message);

    // Check if bot is mentioned, directly replied to, or it's a DM
    const isMentioned = message.mentions.has(this.client.user!);
    const isDM = !message.guild;
    const isReplyToBot = replyMeta.authorId === this.client.user?.id;
    const shouldTreatAsDndTableTalk = inProtectedDndThread && isDndPlayer && (isMentioned || isReplyToBot);

    if (shouldTreatAsDndTableTalk) {
      const gate = this.dnd.validateNarrativeTurn(message.channel.id, message.author.id);
      if (!gate.ok) {
        await message.reply({
          content: gate.reason,
          allowedMentions: { repliedUser: false },
        });
        return;
      }
    }

    if (!isMentioned && !isDM && !shouldTreatAsDndTableTalk) return;

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

    const replyContext = replyMeta.context;
    let dndRagContext = 'No relevant RAG context found for this session yet.';
    if (shouldTreatAsDndTableTalk) {
      try {
        dndRagContext = await this.dnd.buildNarrativeRagContext(message.channel.id, content || '(image attached)');
      } catch (error: any) {
        log.warn({ error: error.message, channelId: message.channel.id }, 'Failed to build DnD narrative RAG context');
      }
    }
    const effectivePrompt = shouldTreatAsDndTableTalk
      ? this.dnd.buildTableTalkPrompt(message.channel.id, message.author.id, content || '(image attached)', dndRagContext)
      : (content || '(image attached)');

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
        wasMentioned: isMentioned || shouldTreatAsDndTableTalk,
        mentionTargets,
        replyContext,
      },
      effectivePrompt
    );

    const images = await this.collectMessageImages(message);

    await this.processAgentTurn({
      channel: message.channel as any,
      author: message.author,
      replyTo: message,
      effectiveMessage,
      mentionTargets,
      images: images.length > 0 ? images : undefined,
      shouldTreatAsDndTableTalk,
    });
  }

  /**
   * Core logic for processing a single agent turn and sending the response.
   * Shared by handleMessage and handleButtonInteraction.
   */
  private async processAgentTurn(params: {
    channel: TextChannel | ThreadChannel | DMChannel;
    author: User;
    replyTo: Message | null;
    effectiveMessage: string;
    mentionTargets: MentionTarget[];
    images?: string[];
    shouldTreatAsDndTableTalk: boolean;
  }): Promise<void> {
    const { channel, author, replyTo, effectiveMessage, mentionTargets, images, shouldTreatAsDndTableTalk } = params;
    const sessionKey = `discord:${channel.id}`;

    log.info({
      user: author.tag,
      channel: channel.id,
      contentLength: effectiveMessage.length,
    }, 'Processing Discord agent turn');

    let fullContent = '';
    const toolUpdates: string[] = [];
    let hasThought = false;
    const addedReactions = new Set<string>();
    const progress = createDiscordProgressState();
    let progressMessage: Message | null = null;
    let lastProgressFlush = 0;

    const flushProgress = async (force = false, finalContent?: string): Promise<void> => {
      if (!progressMessage) return;
      const now = Date.now();
      if (!force && now - lastProgressFlush < 1500) return;
      lastProgressFlush = now;

      const hasPlan = progress.tasks.length > 0;
      const payload: any = {
        embeds: hasPlan ? [buildDiscordProgressEmbed(progress, finalContent)] : [],
      };

      if (finalContent !== undefined) {
        payload.content = finalContent || null;
      } else if (!hasPlan) {
        payload.content = `_${discordProgressStatusLabel(progress.status)}..._`;
      } else {
        payload.content = null;
      }

      await progressMessage.edit(payload);
    };

    const typingInterval = setInterval(async () => {
      try {
        await (channel as any).sendTyping();
      } catch { /* ignore */ }
    }, 7_000);

    try {
      // ── Step 1: React with 👀 (received) ──
      if (replyTo) await this.react(replyTo, REACTIONS.RECEIVED);
      this.beginRequest('thinking');

      const progressPayload = {
        content: `_${discordProgressStatusLabel(progress.status)}..._`,
        allowedMentions: { repliedUser: false },
      };

      progressMessage = replyTo
        ? await replyTo.reply(progressPayload)
        : await (channel as any).send(progressPayload);

      // ── Build Request ──
      const request: AgentRequest = {
        message: effectiveMessage,
        images,
        sessionKey,
        disablePlanner: shouldTreatAsDndTableTalk,
        channelType: 'discord',
        channelTarget: channel.id,
        userIdentifier: author.tag,
        workingDir: this.config.workspace || getConfig().agent?.workspace || getStateDir(),
        sendFile: async (filePath: string, fileName?: string) => {
          if (replyTo) {
            await this.sendFile(replyTo, filePath, fileName);
          } else {
            // Fallback for button interactions if we don't have a direct replyTo message
            const name = fileName ?? basename(filePath);
            const attachment = new AttachmentBuilder(filePath, { name });
            await (channel as any).send({
              content: `📎 Sending file: **${name}**`,
              files: [attachment],
            });
          }
        },
        sendInteractiveChoice: async (choiceRequest) => {
          return this.sendInteractiveChoice({
            channelId: channel.id,
            replyTo: async (payload) => replyTo ? replyTo.reply(payload) : (channel as any).send(payload),
          }, choiceRequest);
        },
      };

      // For DnD sessions, use the dedicated GM system prompt and keep reasoning enabled
      if (shouldTreatAsDndTableTalk) {
        const { readFileSync } = await import('fs');
        const { resolve } = await import('path');
        const gmPromptPath = resolve(process.cwd(), 'config/dnd_gm_prompt.md');
        if (existsSync(gmPromptPath)) {
          request.systemPromptOverride = readFileSync(gmPromptPath, 'utf-8');
        }
      }

      for await (const event of this.engine.processRequest(request)) {
        this.updateStatusForEvent(event.type, event.toolName);
        applyEventToDiscordProgress(progress, event);
        await flushProgress();

        // Remove the looking emoji once the agent starts doing ANY work
        if (['thinking', 'content', 'tool_start', 'plan', 'task_update'].includes(event.type) && addedReactions.has(REACTIONS.RECEIVED) && replyTo) {
          await this.unreact(replyTo, REACTIONS.RECEIVED);
          addedReactions.delete(REACTIONS.RECEIVED);
        }

        switch (event.type) {
          case 'thinking':
            if (!hasThought && replyTo) {
              await this.react(replyTo, REACTIONS.THINKING);
              addedReactions.add(REACTIONS.THINKING);
              hasThought = true;
            }
            break;

          case 'content':
            fullContent += event.content ?? '';
            if (addedReactions.has(REACTIONS.THINKING) && replyTo) {
              await this.unreact(replyTo, REACTIONS.THINKING);
              addedReactions.delete(REACTIONS.THINKING);
            }
            break;

          case 'plan':
            toolUpdates.push(`🗺️ Planned ${event.plan?.tasks?.length ?? 0} task${(event.plan?.tasks?.length ?? 0) === 1 ? '' : 's'}`);
            break;

          case 'task_update': {
            const prefix = event.taskIndex && event.taskTotal ? `[${event.taskIndex}/${event.taskTotal}] ` : '';
            if (event.taskStatus === 'in_progress') {
              toolUpdates.push(`→ ${prefix}${event.taskTitle}`);
            } else if (event.taskStatus) {
              const icon = event.taskStatus === 'completed' ? '✓' : event.taskStatus === 'blocked' ? '⚠' : '✗';
              toolUpdates.push(`${icon} ${prefix}${event.taskTitle}${event.taskSummary ? ` — ${event.taskSummary}` : ''}`);
            }
            break;
          }

          case 'tool_start':
            const toolEmoji = this.getToolReaction(event.toolName ?? '');
            if (!addedReactions.has(toolEmoji) && replyTo) {
              await this.react(replyTo, toolEmoji);
              addedReactions.add(toolEmoji);
            }
            toolUpdates.push(`⚙ Running \`${event.toolName}\`...`);
            break;

          case 'tool_result': {
            const icon = event.toolResult?.success ? '✓' : '✗';
            toolUpdates.push(`${icon} \`${event.toolName}\` ${event.toolResult?.success ? 'completed' : 'failed'}`);
            const doneToolEmoji = this.getToolReaction(event.toolName ?? '');
            if (addedReactions.has(doneToolEmoji) && replyTo) {
              await this.unreact(replyTo, doneToolEmoji);
              addedReactions.delete(doneToolEmoji);
            }
            break;
          }

          case 'error':
            fullContent += `\n⚠ Error: ${event.error}`;
            break;
        }
      }

      await flushProgress(true);
      for (const emoji of addedReactions) {
        if (replyTo) await this.unreact(replyTo, emoji);
      }
      if (replyTo) await this.react(replyTo, REACTIONS.DONE);

      setTimeout(async () => {
        if (replyTo) await this.unreact(replyTo, REACTIONS.DONE);
      }, 10_000);

      // Format and send response
      const structuredNarrative = shouldTreatAsDndTableTalk
        ? await this.dnd.processStructuredNarrativeResponse(channel.id, fullContent)
        : { content: fullContent, shopEmbeds: [], combatEmbeds: [], combatComponents: null, actionComponents: null, rollComponents: null };

      progress.status = progress.error ? 'error' : 'done';

      if (shouldTreatAsDndTableTalk) {
        this.dnd.markNarrativeTurnSpent(channel.id, author.id);

        // For DnD narrative responses, send as a rich embed for best markdown rendering
        const spentNotice = this.dnd.buildNarrativeTurnSpentNotice(channel.id, author.id);
        const decoratedContent = spentNotice && !(structuredNarrative.combatEmbeds?.length > 0)
          ? `${structuredNarrative.content}\n\n*${spentNotice}*`
          : structuredNarrative.content;
        const resolvedContent = resolveDiscordMentions(decoratedContent, mentionTargets);
        const narrativeEmbed = new EmbedBuilder()
          .setColor(0x8e44ad)
          .setDescription(resolvedContent.content.slice(0, 4096));
        const trackerEmbed = this.dnd.buildTurnTrackerEmbed(channel.id);
        const actionComponents = spentNotice && !(structuredNarrative.combatEmbeds?.length > 0)
          ? []
          : (structuredNarrative.actionComponents || []);

        if (progressMessage) {
          const components = [
            ...(structuredNarrative.combatComponents || []),
            ...actionComponents,
            ...(structuredNarrative.rollComponents || []),
          ].slice(0, 5); // Discord limit

          await progressMessage.edit({
            content: null,
            embeds: [
              ...(progress.tasks.length > 0 ? [buildDiscordProgressEmbed(progress, resolvedContent.content)] : []),
              narrativeEmbed,
              ...(trackerEmbed ? [trackerEmbed] : []),
              ...structuredNarrative.shopEmbeds,
              ...structuredNarrative.combatEmbeds,
            ],
            components,
            allowedMentions: {
              users: resolvedContent.userIds,
              repliedUser: false,
            },
          });
        } else {
          const components = [
            ...(structuredNarrative.combatComponents || []),
            ...actionComponents,
            ...(structuredNarrative.rollComponents || []),
          ].slice(0, 5);

          await (channel as any).send({
            embeds: [
              narrativeEmbed,
              ...(trackerEmbed ? [trackerEmbed] : []),
              ...structuredNarrative.shopEmbeds,
              ...structuredNarrative.combatEmbeds,
            ],
            components,
            allowedMentions: { users: resolvedContent.userIds },
          });
        }
      } else {
        // Non-DnD responses: standard text output
        const messages = buildOutgoingMessages(
          structuredNarrative.content,
          toolUpdates,
          {
            replyStyle: this.config.replyStyle ?? 'single',
            showToolProgress: this.config.showToolProgress ?? false,
          },
          1900
        );

        const first = messages[0] ?? '(No response)';
        const resolvedFirst = resolveDiscordMentions(first, mentionTargets);

        if (progressMessage) {
          await progressMessage.edit({
            content: resolvedFirst.content,
            embeds: progress.tasks.length > 0 ? [buildDiscordProgressEmbed(progress, resolvedFirst.content)] : [],
            allowedMentions: {
              users: resolvedFirst.userIds,
              repliedUser: false,
            },
          });
        }

        for (let i = 1; i < messages.length; i++) {
          const resolved = resolveDiscordMentions(messages[i], mentionTargets);
          await (channel as any).send({
            content: resolved.content,
            allowedMentions: {
              users: resolved.userIds,
            },
          });
        }
      }

      log.info({
        user: author.tag,
        responseLength: fullContent.length,
        tools: toolUpdates.length,
      }, 'Discord response sent');

    } catch (err: any) {
      log.error({ error: err.message }, 'Discord agent turn error');
      for (const emoji of addedReactions) {
        if (replyTo) await this.unreact(replyTo, emoji);
      }
      if (replyTo) {
        await this.react(replyTo, REACTIONS.ERROR);
        await replyTo.reply(`⚠ Error: ${err.message}`);
      } else {
        await (channel as any).send(`⚠ Error: ${err.message}`);
      }
    } finally {
      clearInterval(typingInterval);
      this.endRequest();
    }
  }

  private async getReplyMetadata(message: Message): Promise<{ context: string | null; authorId: string | null }> {
    if (!message.reference?.messageId) {
      return { context: null, authorId: null };
    }

    try {
      const referenced = typeof message.fetchReference === 'function'
        ? await message.fetchReference()
        : null;

      if (!referenced) return { context: null, authorId: null };

      const referencedContent = referenced.content?.trim() || summarizeAttachments(referenced.attachments);
      if (!referencedContent) {
        return {
          context: null,
          authorId: referenced.author?.id ?? null,
        };
      }

      return {
        context: formatReplyContext(
          referenced.author?.tag || referenced.author?.username || 'Unknown user',
          referencedContent
        ),
        authorId: referenced.author?.id ?? null,
      };
    } catch (err: any) {
      log.debug({ error: err.message, messageId: message.id }, 'Failed to fetch replied-to Discord message');
      return { context: null, authorId: null };
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

    const dndResult = await this.dnd.handleButton(interaction);
    if (dndResult === true) {
      return;
    }
    if (typeof dndResult === 'string') {
      // It's a DnD action choice OR a roll result!
      await this.processDndActionChoice(interaction, dndResult);
      return;
    }

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

  /**
   * Specifically handles action choices from DnD buttons by feeding them back into the engine.
   */
  private async processDndActionChoice(interaction: ChatInputCommandInteraction | ButtonInteraction, actionText: string): Promise<void> {
    const channel = interaction.channel;
    if (!channel || !channel.isTextBased()) return;

    // Post the action as a visible message so the table sees what was chosen
    await (channel as any).send({
      content: `${interaction.user} **→** ${actionText}`,
    });

    // Build the engine request
    const mentionTargets: MentionTarget[] = [
      createDiscordMentionTarget(
        interaction.user.id,
        (interaction.member as any)?.displayName || interaction.user.globalName || interaction.user.username,
        interaction.user.username,
        interaction.user.tag
      )
    ];

    const dndRagContext = await this.dnd.buildNarrativeRagContext(channel.id, actionText);
    const effectivePrompt = this.dnd.buildTableTalkPrompt(channel.id, interaction.user.id, actionText, dndRagContext);

    const effectiveMessage = buildStructuredIncomingMessage(
      {
        platform: 'discord',
        conversationLabel: interaction.guild
          ? `Guild #${'name' in channel ? (channel as any).name : channel.id}`
          : 'Discord DM',
        sender: {
          id: interaction.user.id,
          label: interaction.user.tag,
          name: (interaction.member as any)?.displayName || interaction.user.globalName || interaction.user.username,
          username: interaction.user.username,
          tag: interaction.user.tag,
        },
        isGroupChat: Boolean(interaction.guildId),
        wasMentioned: true,
        mentionTargets,
      },
      effectivePrompt
    );

    await this.processAgentTurn({
      channel: channel as any,
      author: interaction.user,
      replyTo: null, // Buttons don't have a specific message to reply to for reactions
      effectiveMessage,
      mentionTargets,
      shouldTreatAsDndTableTalk: true,
    });
  }

  private async handleSelectMenuInteraction(interaction: AnySelectMenuInteraction): Promise<void> {
    if (await this.dnd.handleSelectMenu(interaction)) {
      return;
    }
  }

  private async handleModalInteraction(interaction: ModalSubmitInteraction): Promise<void> {
    if (await this.dnd.handleModalSubmit(interaction)) {
      return;
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
    void this.dnd.shutdown();
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



function buildEffectiveIncomingMessage(replyContext: string | null, content: string): string {
  return replyContext ? `${replyContext}\n\nUser reply: ${content}` : content;
}

function buildDndQuestionPrompt(
  details: DndSessionDetails,
  userId: string,
  question: string,
  mode: 'private' | 'public',
  ragContext: string,
): string {
  const asker = details.players.find(player => player.userId === userId);
  const activePlayer = details.players.find(player => player.userId === details.session.activePlayerUserId);
  const playerSummary = details.players
    .map(player => `${player.characterName} [${player.status}]${player.userId === details.session.hostUserId ? ' host' : ''}`)
    .join(', ');
  const voteSummary = details.vote
    ? `${details.vote.vote.question} | status=${details.vote.vote.status}`
    : 'none';

  return [
    `This is a ${mode} out-of-band player question about an ongoing DnD session.`,
    'Answer as the session GM, but do not advance turns, do not treat this as an in-world action, and do not change the party decision state.',
    mode === 'public'
      ? 'The answer will be visible to the table, so phrase it as GM clarification for the group.'
      : 'The answer will only be visible to the asking player, so you can be concise and direct.',
    'Keep the answer grounded in the current session state. If something is unknown, say so clearly.',
    '',
    `Session: ${details.session.title} (${details.session.id})`,
    `Phase: ${details.session.phase}`,
    `Tone: ${details.session.tone ?? 'not set'}`,
    `Round/Turn: ${details.session.roundNumber}/${details.session.turnNumber}`,
    `Active player: ${activePlayer?.characterName ?? 'none'}`,
    `Asking player: ${asker?.characterName ?? 'unknown player'}`,
    `Players: ${playerSummary}`,
    `Open vote: ${voteSummary}`,
    '',
    'Relevant retrieved context:',
    ragContext,
    '',
    `Question: ${question}`,
  ].join('\n');
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
  const toolSummary = (options.showToolProgress || !cleanedContent) && toolUpdates.length > 0
    ? toolUpdates.join('\n').trim()
    : '';

  const fullText = [toolSummary, cleanedContent].filter(Boolean).join('\n\n').trim() || '(No response)';

  if (options.replyStyle === 'rapid') {
    return splitRapidMessages(fullText, maxLen);
  }

  return splitMessage(fullText, maxLen);
}

function createDiscordProgressState(): DiscordProgressState {
  return {
    startedAt: Date.now(),
    status: 'starting',
    planSummary: '',
    tasks: [],
    recentTools: [],
  };
}

function applyEventToDiscordProgress(progress: DiscordProgressState, event: AgentStreamEvent): void {
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
      pushRecentToolUpdate(progress, `Running ${event.toolName ?? 'tool'}...`);
      break;
    case 'tool_result':
      pushRecentToolUpdate(
        progress,
        `${event.toolResult?.success ? 'Done' : 'Failed'} ${event.toolName ?? 'tool'}`
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

function pushRecentToolUpdate(progress: DiscordProgressState, text: string): void {
  progress.recentTools.push(text);
  if (progress.recentTools.length > 5) {
    progress.recentTools = progress.recentTools.slice(-5);
  }
}

function buildDiscordProgressEmbed(progress: DiscordProgressState, finalContent?: string): EmbedBuilder {
  const elapsedMs = Date.now() - progress.startedAt;
  const completed = progress.tasks.filter((task) => task.status === 'completed').length;
  const failed = progress.tasks.filter((task) => task.status === 'failed' || task.status === 'blocked').length;
  const active = progress.tasks.filter((task) => task.status === 'in_progress').length;
  const total = progress.tasks.length;
  const pending = Math.max(0, total - completed - failed - active);

  const embed = new EmbedBuilder()
    .setTitle(embedTitleForProgress(progress))
    .setColor(progress.status === 'error' ? 0xff5f6d : progress.status === 'done' ? 0x7eff37 : 0xffa928)
    .setDescription(buildOverviewBlock(progress, elapsedMs, total, completed, active, pending, failed))
    .setFooter({ text: footerForProgress(progress) })
    .setTimestamp();

  if (progress.planSummary) {
    embed.addFields({
      name: '\u{1F5FA} Plan',
      value: truncateDiscordEmbedField(progress.planSummary, 1024),
      inline: false,
    });
  }

  if (progress.tasks.length > 0) {
    const taskLines = progress.tasks
      .slice(0, 8)
      .map((task, index) => `${index + 1}. ${discordTaskStatusIcon(task.status)} ${task.title}${task.summary ? ` - ${task.summary}` : ''}`);
    embed.addFields({
      name: '\u{1F4CB} Tasks',
      value: truncateDiscordEmbedField(taskLines.join('\n'), 1024),
      inline: false,
    });
    embed.addFields({
      name: '\u{1F4D8} Legend',
      value: `${discordTaskStatusIcon('completed')} completed\n${discordTaskStatusIcon('in_progress')} active\n${discordTaskStatusIcon('pending')} pending\n${discordTaskStatusIcon('blocked')} blocked\n${discordTaskStatusIcon('failed')} failed`,
      inline: false,
    });
  }

  if (progress.currentTaskLabel || progress.recentTools.length > 0 || progress.error) {
    const activityLines = [
      progress.currentTaskLabel ? `Current focus\n${progress.currentTaskLabel}` : '',
      ...progress.recentTools.map((line) => `- ${line}`),
      progress.error ? `Error: ${progress.error}` : '',
    ].filter(Boolean);

    if (activityLines.length > 0) {
      embed.addFields({
        name: '\u{2699} Activity',
        value: truncateDiscordEmbedField(activityLines.join('\n'), 1024),
        inline: false,
      });
    }
  }

  const finalState = buildFinalStateBlock(progress, finalContent);
  if (finalState) {
    embed.addFields({
      name: '\u{1F3C1} Outcome',
      value: truncateDiscordEmbedField(finalState, 1024),
      inline: false,
    });
  }

  return embed;
}

function discordProgressStatusLabel(status: DiscordProgressState['status']): string {
  switch (status) {
    case 'thinking': return '\u{1F9E0} Thinking';
    case 'planning': return '\u{1F5FA} Planning';
    case 'working': return '\u{2699} Working';
    case 'done': return '\u{2705} Complete';
    case 'error': return '\u{274C} Error';
    case 'starting':
    default:
      return '\u{1F440} Starting';
  }
}

function discordTaskStatusIcon(status: string): string {
  switch (status) {
    case 'completed': return '\u{2705}';
    case 'in_progress': return '\u{1F7E1}';
    case 'failed': return '\u{274C}';
    case 'blocked': return '\u{26A0}';
    default: return '\u{23F3}';
  }
}

function formatDurationShort(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function truncateDiscordEmbedField(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function embedTitleForProgress(progress: DiscordProgressState): string {
  switch (progress.status) {
    case 'planning':
      return 'LiteClaw \u00B7 Task Planner';
    case 'working':
      return 'LiteClaw \u00B7 In Progress';
    case 'done':
      return 'LiteClaw \u00B7 Completed';
    case 'error':
      return 'LiteClaw \u00B7 Needs Attention';
    case 'thinking':
      return 'LiteClaw \u00B7 Thinking';
    case 'starting':
    default:
      return 'LiteClaw \u00B7 Starting';
  }
}

function buildOverviewBlock(
  progress: DiscordProgressState,
  elapsedMs: number,
  total: number,
  completed: number,
  active: number,
  pending: number,
  failed: number
): string {
  const lines = [
    `\u{1F4CA} Overview`,
    `${discordProgressStatusLabel(progress.status)}  \u2022  ${formatDurationShort(elapsedMs)}`,
    '',
    `${discordTaskStatusIcon('completed')} ${completed}/${total || 0} done  \u2022  ${discordTaskStatusIcon('in_progress')} ${active} active`,
    `${discordTaskStatusIcon('pending')} ${pending} pending${failed ? `  \u2022  ${discordTaskStatusIcon('blocked')} ${failed} issue${failed === 1 ? '' : 's'}` : ''}`,
  ];

  if (progress.currentTaskLabel && progress.status !== 'done' && progress.status !== 'error') {
    lines.push('');
    lines.push(`Current: ${progress.currentTaskLabel}`);
  }

  return lines.join('\n');
}

function footerForProgress(progress: DiscordProgressState): string {
  switch (progress.status) {
    case 'done':
      return 'Plan execution finished';
    case 'error':
      return 'Plan execution stopped with an error';
    default:
      return 'Live progress updates';
  }
}

function buildFinalStateBlock(progress: DiscordProgressState, finalContent?: string): string | null {
  if (progress.status !== 'done' && progress.status !== 'error') {
    return null;
  }

  if (progress.status === 'error') {
    return progress.error
      ? `The task ended with an error:\n${progress.error}`
      : 'The task ended before a final answer was produced.';
  }

  const condensed = sanitizeChannelContent(finalContent ?? '').replace(/\s+/g, ' ').trim();
  if (!condensed) {
    return 'Reply sent below.';
  }

  return 'Reply sent below.';
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
