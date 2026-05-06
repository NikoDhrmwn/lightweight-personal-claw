import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import { splitMessage } from '../channels/utils.js';
import { MemoryStore } from '../core/memory.js';
import { buildProviders, LLMClient } from '../core/llm.js';
import type { LLMProvider } from '../core/llm.js';
import { DndStore } from './store.js';
import {
  DndSessionManager,
  getPlayerOnboardingState,
  isPlayerOnboardingComplete,
  parseCharacterSheet,
  parseCombatState,
  type DndActor,
  type SessionSummary,
  type VoteResolution,
} from './manager.js';
import { buildRagQuestionContext, DndRagStore, EmbeddingServerManager, LlmServerManager, ensureServersReady, syncSessionRag, ingestDocument, getPreconfiguredWorldScopeId, syncPreconfiguredWorldRag } from './rag.js';
import type {
  DndAbilityScores,
  DndCharacterSheet,
  DndCombatState,
  DndDowntimeProgressRecord,
  DndDowntimeRecord,
  DndDocumentRecord,
  DndInventoryItemRecord,
  DndPlayerRecord,
  DndOnboardingState,
  DndProgressEvent,
  DndSceneState,
  DndSessionDetails,
  DndSessionRecord,
  DndShopItemRecord,
  DndShopRecord,
  DndVoteDetails,
} from './types.js';
import {
  abilityModifier,
  DND_CLASSES,
  formatRecommendedAbilityOrder,
  getClassById,
  hpBar,
  formatModifier,
  formatConditions,
  exhaustionDisplay,
  type DndClassDef,
} from './classes.js';
import {
  CONSUMABLE_DEFINITIONS,
  SKILL_DEFINITIONS,
  WEAPON_DEFINITIONS,
  describeCombatantStatus,
  getCombatKitForClass,
  getWeaponDefinition,
  parseInventoryMetadata,
  type StarterItemTemplate,
} from './combat-system.js';
import { repairNarrativePacket, type ValidationResult } from './validator.js';
import {
  DEFAULT_PRECONFIGURED_WORLD_ID,
  getPreconfiguredWorld,
  PRECONFIGURED_WORLD_CHOICES,
  readPreconfiguredWorldLore,
} from './preconfigured-worlds.js';

const log = createLogger('dnd-discord');

const DND_BUTTON_PREFIX = 'dnd_vote_';
const DND_COMBAT_PREFIX = 'dnd_combat_';
const DND_ACTION_PREFIX = 'dnd_action_';
const DND_REGEN_PREFIX = 'dnd_regen_';
const DND_READY_PREFIX = 'dnd_ready_';
const DND_UNREADY_PREFIX = 'dnd_unready_';
const DND_ONBOARD_ROLL_PREFIX = 'dnd_ob_roll_';
const DND_ONBOARD_CLASS_PREFIX = 'dnd_ob_class_';
const DND_ONBOARD_MODAL_PREFIX = 'dnd_ob_modal_';
const DND_ROLL_PREFIX = 'dnd_roll_';
const DND_ONBOARD_ALLOC_PREFIX = 'dnd_ob_alloc_';

export const DND_SLASH_COMMANDS = [
  // ─── 🎲 Session & Gameplay ────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('dnd')
    .setDescription('🎲 Session management, turns, votes, and quests')
    .addSubcommand(sub =>
      sub.setName('start')
        .setDescription('Create a new DnD session thread')
        .addStringOption(opt =>
          opt.setName('title').setDescription('Session title').setRequired(true))
        .addStringOption(opt =>
          opt.setName('tone').setDescription('Campaign tone').setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('max_players').setDescription('Max players').setRequired(false).setMinValue(1).setMaxValue(8))
        .addStringOption(opt =>
          opt.setName('world_source').setDescription('Generate a fresh world or use a shared lorebook').setRequired(false)
            .addChoices(
              { name: '🎲 Random World', value: 'random' },
              { name: '📚 Preconfigured World', value: 'preconfigured' },
            ))
        .addStringOption(opt =>
          opt.setName('world_id').setDescription('Which preconfigured world to use').setRequired(false)
            .addChoices(...PRECONFIGURED_WORLD_CHOICES)))
    .addSubcommand(sub =>
      sub.setName('join')
        .setDescription('Join an existing DnD session')
        .addStringOption(opt =>
          opt.setName('character_name').setDescription('Your character name').setRequired(true))
        .addStringOption(opt =>
          opt.setName('class').setDescription('Character class').setRequired(false))
        .addStringOption(opt =>
          opt.setName('race').setDescription('Character race').setRequired(false))
        .addStringOption(opt =>
          opt.setName('session_id').setDescription('Session ID if not in the session thread').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('begin')
        .setDescription('Begin the current DnD session'))
    .addSubcommand(sub =>
      sub.setName('save')
        .setDescription('Save and pause the current session')
        .addStringOption(opt =>
          opt.setName('note').setDescription('Optional checkpoint note').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('resume')
        .setDescription('Resume a saved session in the current thread')
        .addStringOption(opt =>
          opt.setName('session_id').setDescription('Session ID to resume').setRequired(true))
        .addBooleanOption(opt =>
          opt.setName('partial_party').setDescription('Resume even if only some players are available').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('restore')
        .setDescription('Restore a specific checkpoint into the current thread')
        .addStringOption(opt =>
          opt.setName('checkpoint_id').setDescription('Checkpoint ID to restore').setRequired(true))
        .addBooleanOption(opt =>
          opt.setName('partial_party').setDescription('Restore with absent players marked unavailable').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show the current DnD session state'))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List resumable DnD sessions in this guild'))
    .addSubcommand(sub =>
      sub.setName('checkpoints')
        .setDescription('List saved checkpoints for the current or specified session')
        .addStringOption(opt =>
          opt.setName('session_id').setDescription('Session ID to inspect').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('available')
        .setDescription('Mark yourself available for turns again'))
    .addSubcommand(sub =>
      sub.setName('unavailable')
        .setDescription('Mark yourself unavailable so your turns are skipped'))
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End the current DnD session'))
    .addSubcommand(sub =>
      sub.setName('end-turn')
        .setDescription('End the current player turn'))
    .addSubcommand(sub =>
      sub.setName('skip-vote')
        .setDescription('Vote to skip a player who is unavailable')
        .addUserOption(opt =>
          opt.setName('player').setDescription('The player to skip').setRequired(true))
        .addStringOption(opt =>
          opt.setName('reason').setDescription('Optional reason for the skip vote').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('quest-complete')
        .setDescription('Mark a quest as completed and award XP')
        .addStringOption(opt =>
          opt.setName('title').setDescription('Quest title').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('xp').setDescription('Total XP to distribute').setRequired(true).setMinValue(0))
        .addStringOption(opt =>
          opt.setName('notes').setDescription('Optional notes').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('quest-log')
        .setDescription('Show combat and quest completion history'))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages),

  // ─── 📋 Character Sheet ───────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('📋 View and edit your character sheet')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('Show your full character sheet'))
    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Edit a character stat')
        .addStringOption(opt =>
          opt.setName('field').setDescription('Field to edit').setRequired(true)
            .addChoices(
              { name: 'HP', value: 'hp' },
              { name: 'Max HP', value: 'maxhp' },
              { name: 'AC', value: 'ac' },
              { name: 'Notes', value: 'notes' },
              { name: 'Inspiration', value: 'inspiration' },
              { name: 'STR', value: 'str' },
              { name: 'DEX', value: 'dex' },
              { name: 'CON', value: 'con' },
              { name: 'INT', value: 'int' },
              { name: 'WIS', value: 'wis' },
              { name: 'CHA', value: 'cha' },
            ))
        .addStringOption(opt =>
          opt.setName('value').setDescription('New value').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('class')
        .setDescription('Choose or change your class')
        .addStringOption(opt =>
          opt.setName('class_id').setDescription('Class to select').setRequired(true)
            .addChoices(...DND_CLASSES.map(c => ({ name: `${c.emoji} ${c.name}`, value: c.id })))))
    .addSubcommand(sub =>
      sub.setName('roll')
        .setDescription('Roll new ability scores (4d6 drop lowest ×6)'))
    .addSubcommand(sub =>
      sub.setName('short-rest')
        .setDescription('Take a short rest and spend hit dice to regain HP')
        .addIntegerOption(opt =>
          opt.setName('hit_dice').setDescription('Number of hit dice to spend').setRequired(true).setMinValue(1).setMaxValue(20)))
    .addSubcommand(sub =>
      sub.setName('long-rest')
        .setDescription('Take a long rest: full HP, reduce exhaustion, clear conditions'))
    .addSubcommand(sub =>
      sub.setName('condition')
        .setDescription('Add or remove a condition')
        .addStringOption(opt =>
          opt.setName('action').setDescription('Add or remove').setRequired(true)
            .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
        .addStringOption(opt =>
          opt.setName('name').setDescription('Condition name (e.g. poisoned, stunned)').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('exhaustion')
        .setDescription('Set exhaustion level (0-6)')
        .addIntegerOption(opt =>
          opt.setName('level').setDescription('Exhaustion level').setRequired(true).setMinValue(0).setMaxValue(6))),

  new SlashCommandBuilder()
    .setName('skills')
    .setDescription('View your learned combat techniques and abilities')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('Show your known skills and how to use them')),

  new SlashCommandBuilder()
    .setName('spells')
    .setDescription('View your spell-like abilities and magical options')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('Show your spell-like abilities')),

  new SlashCommandBuilder()
    .setName('avatar')
    .setDescription('Manage your character portrait')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('Show your current character portrait source'))
    .addSubcommand(sub =>
      sub.setName('discord')
        .setDescription('Use your Discord profile avatar as your character portrait'))
    .addSubcommand(sub =>
      sub.setName('upload')
        .setDescription('Set your portrait from an image attachment')
        .addAttachmentOption(opt =>
          opt.setName('image').setDescription('Portrait image').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('url')
        .setDescription('Set your portrait from an image URL')
        .addStringOption(opt =>
          opt.setName('image_url').setDescription('Direct image URL').setRequired(true))),

  // ─── 🎲 Dice Rolling ──────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('Manage character inventory and spending')
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('Show your inventory'))
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('Host only: give loot to a player')
        .addUserOption(opt =>
          opt.setName('player').setDescription('Who receives the item').setRequired(true))
        .addStringOption(opt =>
          opt.setName('name').setDescription('Item name').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('quantity').setDescription('Quantity').setRequired(false).setMinValue(1).setMaxValue(999))
        .addStringOption(opt =>
          opt.setName('category').setDescription('Item category').setRequired(false))
        .addStringOption(opt =>
          opt.setName('notes').setDescription('Optional notes').setRequired(false))
        .addBooleanOption(opt =>
          opt.setName('consumable').setDescription('Whether the item is consumable').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('spend-item')
        .setDescription('Spend or consume one of your items')
        .addStringOption(opt =>
          opt.setName('item_id').setDescription('Inventory item ID').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('quantity').setDescription('Amount to spend').setRequired(false).setMinValue(1).setMaxValue(999)))
    .addSubcommand(sub =>
      sub.setName('drop')
        .setDescription('Remove or drop an item from your inventory')
        .addStringOption(opt =>
          opt.setName('item_id').setDescription('Inventory item ID').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('quantity').setDescription('Amount to remove').setRequired(false).setMinValue(1).setMaxValue(999)))
    .addSubcommand(sub =>
      sub.setName('spend-gold')
        .setDescription('Spend gold from your character sheet')
        .addIntegerOption(opt =>
          opt.setName('amount').setDescription('Gold to spend').setRequired(true).setMinValue(1))
        .addStringOption(opt =>
          opt.setName('reason').setDescription('What you spent it on').setRequired(false))),

  new SlashCommandBuilder()
    .setName('turn')
    .setDescription('Submit your in-character turn action to the GM')
    .addStringOption(opt =>
      opt.setName('action')
        .setDescription('What your character does right now')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('end')
    .setDescription('Quick DnD shortcuts for ending things')
    .addSubcommand(sub =>
      sub.setName('turn')
        .setDescription('End your current turn')),

  new SlashCommandBuilder()
    .setName('flee')
    .setDescription('Attempt to flee the current combat encounter'),

  new SlashCommandBuilder()
    .setName('downtime')
    .setDescription('Manage between-session downtime activities')
    .addSubcommand(sub =>
      sub.setName('do')
        .setDescription('Start a downtime activity')
        .addStringOption(opt =>
          opt.setName('activity').setDescription('Downtime activity').setRequired(true)
            .addChoices(
              { name: 'Training', value: 'training' },
              { name: 'Crafting', value: 'crafting' },
              { name: 'Carousing', value: 'carousing' },
              { name: 'Research', value: 'research' },
              { name: 'Recuperating', value: 'recuperating' },
              { name: 'Work', value: 'work' },
              { name: 'Religious Service', value: 'religious_service' },
            ))
        .addStringOption(opt =>
          opt.setName('focus').setDescription('What you are focusing on').setRequired(false))
        .addIntegerOption(opt =>
          opt.setName('duration_minutes').setDescription('How long to spend on this activity').setRequired(false)
            .addChoices(
              { name: '15 minutes', value: 15 },
              { name: '30 minutes', value: 30 },
              { name: '1 hour', value: 60 },
              { name: '3 hours', value: 180 },
              { name: '6 hours', value: 360 },
            ))
        .addIntegerOption(opt =>
          opt.setName('item_value').setDescription('Crafting target market value in gp').setRequired(false).setMinValue(50).setMaxValue(5000)))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show your downtime cooldown and progress'))
    .addSubcommand(sub =>
      sub.setName('history')
        .setDescription('Show your recent downtime activity')),

  new SlashCommandBuilder()
    .setName('inspire')
    .setDescription('Grant inspiration to a party member')
    .addUserOption(opt =>
      opt.setName('player').setDescription('The player to inspire').setRequired(true)),

  new SlashCommandBuilder()
    .setName('death-save')
    .setDescription('Track death saves while at 0 HP')
    .addSubcommand(sub =>
      sub.setName('roll')
        .setDescription('Roll a death saving throw')
        .addBooleanOption(opt =>
          opt.setName('use_inspiration').setDescription('Spend inspiration on this roll').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show your current death save tracker'))
    .addSubcommand(sub =>
      sub.setName('damage')
        .setDescription('Host only: apply damage to a creature already at 0 HP')
        .addUserOption(opt =>
          opt.setName('player').setDescription('The player taking damage').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('damage').setDescription('Damage dealt').setRequired(true).setMinValue(1))
        .addBooleanOption(opt =>
          opt.setName('critical').setDescription('Was it a critical hit?').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('reset')
        .setDescription('Reset death save counters')
        .addUserOption(opt =>
          opt.setName('player').setDescription('Optional target player (host only)').setRequired(false))),

  new SlashCommandBuilder()
    .setName('vote')
    .setDescription('Create a party decision vote outside combat')
    .addStringOption(opt =>
      opt.setName('question').setDescription('The party decision to vote on').setRequired(true))
    .addStringOption(opt =>
      opt.setName('options').setDescription('2-4 options separated by |').setRequired(true))
    .addIntegerOption(opt =>
      opt.setName('timeout_seconds').setDescription('Vote timeout in seconds').setRequired(false).setMinValue(30).setMaxValue(300)),

  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Manage dynamic merchant inventories and purchases')
    .addSubcommand(sub =>
      sub.setName('open')
        .setDescription('Host only: open a shop for the session')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Shop name').setRequired(true))
        .addStringOption(opt =>
          opt.setName('items').setDescription('One item per line: name|price|stock|category|notes').setRequired(true))
        .addStringOption(opt =>
          opt.setName('description').setDescription('Optional shop description').setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View the active shop'))
    .addSubcommand(sub =>
      sub.setName('buy')
        .setDescription('Buy an item from the active shop')
        .addStringOption(opt =>
          opt.setName('item_id').setDescription('Shop item ID').setRequired(true))
        .addIntegerOption(opt =>
          opt.setName('quantity').setDescription('Quantity to buy').setRequired(false).setMinValue(1).setMaxValue(999)))
    .addSubcommand(sub =>
      sub.setName('close')
        .setDescription('Host only: close the active shop')),

  new SlashCommandBuilder()
    .setName('dice')
    .setDescription('🎲 Roll dice using standard notation (2d6+3, d20adv, 4d6kh3)')
    .addStringOption(opt =>
      opt.setName('roll').setDescription('Dice notation (e.g. 2d6+3, d20, d20adv, 4d6kh3)').setRequired(true))
    .addBooleanOption(opt =>
      opt.setName('public').setDescription('Show the roll to everyone (default: yes)').setRequired(false)),

  // ─── ⚔️ Combat ────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('combat')
    .setDescription('⚔️ Manage combat initiative and turn actions')
    .addSubcommand(sub =>
      sub.setName('enter')
        .setDescription('Enter combat and roll initiative')
        .addStringOption(opt =>
          opt.setName('enemies')
            .setDescription('Optional encounter lines: Name|HP|AC|AttackBonus|Damage|DEX|STR|CON|WIS|INT|CHA')
            .setRequired(false)))
    .addSubcommand(sub =>
      sub.setName('status')
        .setDescription('Show the current combat order'))
    .addSubcommand(sub =>
      sub.setName('menu')
        .setDescription('Repost the active-turn action menu'))
    .addSubcommand(sub =>
      sub.setName('end')
        .setDescription('End combat and optionally award XP')
        .addIntegerOption(opt =>
          opt.setName('xp').setDescription('Total XP to distribute').setRequired(false).setMinValue(0))
        .addStringOption(opt =>
          opt.setName('summary').setDescription('Combat summary/title').setRequired(false))
        .addStringOption(opt =>
          opt.setName('notes').setDescription('Optional notes').setRequired(false))),

  // ─── 📚 Campaign Lore ─────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('lore')
    .setDescription('📚 Manage campaign lore and the RAG knowledge base')
    .addSubcommand(sub =>
      sub.setName('upload')
        .setDescription('Upload a PDF, text, or markdown file to the session lore')
        .addAttachmentOption(opt =>
          opt.setName('file').setDescription('The document to ingest').setRequired(true))
        .addStringOption(opt =>
          opt.setName('type').setDescription('Document type').setRequired(false)
            .addChoices(
              { name: '📜 Campaign PDF', value: 'pdf' },
              { name: '📖 Lore Document', value: 'lore' },
              { name: '📝 Session Transcript', value: 'transcript' },
              { name: '📄 Plain Text', value: 'text' },
            )))
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List all ingested documents for this session'))
    .addSubcommand(sub =>
      sub.setName('search')
        .setDescription('Search the campaign knowledge base')
        .addStringOption(opt =>
          opt.setName('query').setDescription('What to search for').setRequired(true))),
];

interface LobbyState {
  readyPlayers: Set<string>;
  readyStatusNotifiers: Map<string, (content: string) => Promise<void>>;
  worldGenPromise: Promise<void> | null;
  worldLore: string | null;
  worldGenError: string | null;
  worldSource: 'random' | 'preconfigured';
  worldLabel: string;
  worldStatusText: string;
  lobbyMessageId: string | null;
  lobbyChannelId: string | null;
  countdownTimer: ReturnType<typeof setTimeout> | null;
  countdownSeconds: number | null;
  startupStatusText: string | null;
  midSessionJoiners: Set<string>;
  weavingJoiners: Set<string>;
  provisioningPromise: Promise<Array<{ userId: string; summary: string }>> | null;
}

export class DndDiscordController {
  private readonly manager: DndSessionManager;
  private readonly voteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly rag = new DndRagStore();
  private readonly embeddings = new EmbeddingServerManager();
  private readonly llm = new LlmServerManager();
  private readonly engine = new LLMClient();
  private readonly loadoutEngine = this.createLoadoutEngine();
  private readonly lobbies = new Map<string, LobbyState>();
  private readonly spentNarrativeTurns = new Map<string, string>();

  constructor(
    private readonly client: Client,
    private readonly memory: MemoryStore,
  ) {
    this.manager = new DndSessionManager(new DndStore());
  }

  private createLoadoutEngine(): LLMClient {
    const config = getConfig();
    const selectedId = String(config.llm?.defaults?.loadoutModel ?? '').trim();
    if (!selectedId) {
      return this.engine;
    }

    const selected = buildProviders().find((provider) => provider.id === selectedId);
    if (!selected) {
      log.warn({ loadoutModel: selectedId }, 'Configured loadout model not found; using primary runtime model instead');
      return this.engine;
    }

    const worker = new LLMClient();
    (worker as any).providers = [selected];
    (worker as any).allProviders = [selected];
    (worker as any).initialized = true;
    log.info({ provider: selected.id, model: selected.model }, 'Using dedicated loadout generation provider');
    return worker;
  }

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<string | boolean> {
    await this.flushExpiredVotes();

    switch (interaction.commandName) {
      case 'dnd':
        await this.handleDndCommand(interaction);
        return true;
      case 'stats':
        await this.handleStatsCommand(interaction);
        return true;
      case 'skills':
        await this.handleSkillsCommand(interaction);
        return true;
      case 'spells':
        await this.handleSpellsCommand(interaction);
        return true;
      case 'avatar':
        await this.handleAvatarCommand(interaction);
        return true;
      case 'inventory':
        await this.handleInventoryCommand(interaction);
        return true;
      case 'turn':
        await this.handleTurnCommand(interaction);
        return true;
      case 'end':
        await this.handleEndShortcutCommand(interaction);
        return true;
      case 'flee':
        await this.handleFleeCommand(interaction);
        return true;
      case 'downtime':
        await this.handleDowntimeCommand(interaction);
        return true;
      case 'inspire':
        await this.handleInspireCommand(interaction);
        return true;
      case 'death-save':
        await this.handleDeathSaveCommand(interaction);
        return true;
      case 'vote':
        await this.handlePartyVoteCommand(interaction);
        return true;
      case 'shop':
        await this.handleShopCommand(interaction);
        return true;
      case 'dice':
        return await this.handleDiceCommand(interaction);
      case 'combat':
        await this.handleCombatCommand(interaction);
        return true;
      case 'lore':
        await this.handleLoreCommand(interaction);
        return true;
      default:
        return false;
    }
  }

  async handleButton(interaction: ButtonInteraction): Promise<boolean | string> {
    await this.flushExpiredVotes();
    const customId = interaction.customId;

    if (customId.startsWith(DND_READY_PREFIX)) {
      const sessionId = customId.replace(DND_READY_PREFIX, '');
      const lobby = this.lobbies.get(sessionId);
      const details = this.manager.getSessionById(sessionId);
      if (!details) {
        await interaction.reply({ content: 'Session not found.', flags: MessageFlags.Ephemeral });
        return true;
      }

      if (!details.players.some(p => p.userId === interaction.user.id)) {
        await interaction.reply({ content: 'You are not a player in this session.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const player = requirePlayer(details.players, interaction.user.id);
      if (!player.isHost && !isPlayerOnboardingComplete(player)) {
        await interaction.reply({
          content: buildOnboardingReadyBlocker(player),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      if (lobby) {
        lobby.readyPlayers.add(interaction.user.id);
        lobby.readyStatusNotifiers.set(
          interaction.user.id,
          async (content: string) => {
            await interaction.editReply({ content, embeds: [], components: [] }).catch(() => undefined);
          },
        );
      }
      await interaction.reply({
        content: this.buildReadyStatusMessage(sessionId, interaction.user.id),
        flags: MessageFlags.Ephemeral,
      });

      if (lobby) {
        await this.refreshLobby(sessionId);
        await this.updateReadyStatusNotices(sessionId);
      }

      const isMidSessionJoiner = Boolean(lobby?.midSessionJoiners.has(interaction.user.id)) || details.session.phase === 'active';
      if (details.session.phase === 'active' && isMidSessionJoiner) {
        lobby?.weavingJoiners.add(interaction.user.id);
        await this.updateReadyStatusNotices(sessionId);
        lobby?.midSessionJoiners.delete(interaction.user.id);
        await this.triggerMidSessionWeaveIn(sessionId, interaction.user.id);
      } else if (lobby) {
        this.checkLobbyReadiness(sessionId);
      }
      return true;
    }

    if (customId.startsWith(DND_UNREADY_PREFIX)) {
      const sessionId = customId.replace(DND_UNREADY_PREFIX, '');
      const lobby = this.lobbies.get(sessionId);
      if (!lobby) return true;

      lobby.readyPlayers.delete(interaction.user.id);
      lobby.readyStatusNotifiers.delete(interaction.user.id);
      await interaction.reply({ content: 'You are no longer ready.', flags: MessageFlags.Ephemeral });

      await this.refreshLobby(sessionId);
      await this.updateReadyStatusNotices(sessionId);
      return true;
    }

    if (customId.startsWith(DND_BUTTON_PREFIX)) {
      await this.handleVoteButton(interaction);
      return true;
    }

    if (customId.startsWith(DND_COMBAT_PREFIX)) {
      await this.handleCombatButton(interaction);
      return true;
    }

    if (customId.startsWith(DND_ACTION_PREFIX)) {
      return await this.handleActionChoiceButton(interaction);
    }

    if (customId.startsWith(DND_REGEN_PREFIX)) {
      await this.handleRegenerateButton(interaction);
      return true;
    }

    if (customId.startsWith(DND_ROLL_PREFIX)) {
      return await this.handleRollButton(interaction as ButtonInteraction);
    }

    if (customId.startsWith(DND_ONBOARD_ROLL_PREFIX)) {
      const sessionId = customId.replace(DND_ONBOARD_ROLL_PREFIX, '');
      const details = this.manager.getSessionById(sessionId);
      if (!details) return true;
      const player = requirePlayer(details.players, interaction.user.id);
      const onboarding = getPlayerOnboardingState(player);
      if (!onboarding.selectedClassId) {
        await interaction.reply({
          content: 'Choose your class first, then roll. LiteClaw will auto-assign the rolled values using that class priority.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      const rolled = this.manager.generateOnboardingStats(sessionId, interaction.user.id);
      const refreshed = this.manager.getSessionById(sessionId) ?? details;
      const refreshedPlayer = requirePlayer(refreshed.players, interaction.user.id);
      const classDef = refreshedPlayer.onboardingState?.selectedClassId ? getClassById(refreshedPlayer.onboardingState.selectedClassId) : null;
      const sheet = this.manager.getCharacterSheet(sessionId, interaction.user.id);

      await interaction.update({
        embeds: [
          buildOnboardingEmbed(
            refreshed,
            interaction.user.id,
            classDef
              ? `Rolled stats auto-applied using the recommended ${formatRecommendedAbilityOrder(classDef)} priority for ${classDef.name}.`
              : 'Choose your class next and LiteClaw will auto-assign these values for you.',
          ),
          buildStatRollEmbed(refreshed.session, interaction.user.id, rolled, classDef),
          ...(classDef ? [buildAutoAssignmentEmbed(refreshed.session, refreshedPlayer, classDef, rolled, sheet.abilities)] : []),
        ],
        components: buildOnboardingComponents(refreshed, interaction.user.id),
      });
      return true;
    }

    if (customId.startsWith(DND_ONBOARD_MODAL_PREFIX)) {
      const sessionId = customId.replace(DND_ONBOARD_MODAL_PREFIX, '');
      const details = this.manager.getSessionById(sessionId);
      if (!details) return true;
      const player = requirePlayer(details.players, interaction.user.id);
      const onboarding = getPlayerOnboardingState(player);
      if (onboarding.rolledStats.length !== 6) {
        await interaction.reply({
          content: 'Roll your stats first so I can lock in the exact values for your allocation.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      if (!onboarding.selectedClassId) {
        await interaction.reply({
          content: 'Choose your class first. Rolling after class selection will auto-assign your stats using the recommended priority order.',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      const sheet = this.manager.getCharacterSheet(sessionId, interaction.user.id);
      const modal = buildStatModal(sessionId, onboarding.rolledStats, sheet.abilities);
      await (interaction as any).showModal(modal);
      return true;
    }

    return false;
  }

  async handleSelectMenu(interaction: any): Promise<boolean> {
    const customId = interaction.customId;

    if (customId.startsWith(DND_ONBOARD_CLASS_PREFIX)) {
      const sessionId = customId.replace(DND_ONBOARD_CLASS_PREFIX, '');
      const classId = interaction.values[0];
      const classDef = getClassById(classId);
      if (!classDef) return true;

      const details = this.manager.getSessionById(sessionId);
      if (!details) return true;

      const result = this.manager.selectOnboardingClass(sessionId, interaction.user.id, classId);
      await this.syncRagForSession(sessionId);

      const refreshed = this.manager.getSessionById(sessionId) ?? details;
      await interaction.update({
        embeds: [
          buildOnboardingEmbed(
            refreshed,
            interaction.user.id,
            result.autoAssigned
              ? `Class selected and rolled stats auto-applied using ${formatRecommendedAbilityOrder(classDef)}. You can adjust them manually if you want.`
              : `Class selected. Recommended stat order for ${classDef.name}: ${formatRecommendedAbilityOrder(classDef)}. Next, roll your stats and they will auto-apply.`,
          ),
          buildClassSelectedEmbed(details.session, result.player, result.sheet, classDef),
          ...(result.autoAssigned
            ? [buildAutoAssignmentEmbed(details.session, result.player, classDef, getPlayerOnboardingState(result.player).rolledStats, result.sheet.abilities)]
            : []),
        ],
        components: buildOnboardingComponents(refreshed, interaction.user.id),
      });
      return true;
    }

    return false;
  }

  async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
    const customId = interaction.customId;

    if (customId.startsWith(DND_ONBOARD_ALLOC_PREFIX)) {
      const sessionId = customId.replace(DND_ONBOARD_ALLOC_PREFIX, '');
      const allocationInput = interaction.fields.getTextInputValue('allocation');
      const parsedAllocation = parseAbilityAllocationInput(allocationInput);
      if (!parsedAllocation) {
        await interaction.reply({
          content: 'Enter exactly six numbers for STR, DEX, CON, INT, WIS, CHA. Example: `17, 16, 9, 9, 8, 8`',
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      const [str, dex, con, int, wis, cha] = parsedAllocation;

      const inputArr = [str, dex, con, int, wis, cha].sort((a, b) => b - a);

      const details = this.manager.getSessionById(sessionId);
      if (!details) return true;
      const player = requirePlayer(details.players, interaction.user.id);

      const rolled = player.onboardingState?.rolledStats;
      if (!rolled) {
        await interaction.reply({ content: '❌ You must roll your stats first!', flags: MessageFlags.Ephemeral });
        return true;
      }

      const rolledSorted = [...rolled].sort((a, b) => b - a);
      const matches = inputArr.every((val, i) => val === rolledSorted[i]);

      if (!matches) {
        await interaction.reply({
          content: `❌ **Anti-Cheat Triggered**: The values you entered do not match your roll (${rolled.join(', ')}). Please use the exact numbers you rolled!`,
          flags: MessageFlags.Ephemeral
        });
        return true;
      }

      const result = this.manager.allocateStats(sessionId, interaction.user.id, { str, dex, con, int, wis, cha });
      await this.syncRagForSession(sessionId);

      await interaction.reply({
        embeds: [
          buildOnboardingEmbed(this.manager.getSessionById(sessionId) ?? details, interaction.user.id, 'Character setup complete. You can now click Ready Up in the lobby and jump in.'),
          buildStatUpdateEmbed(details.session, result.player, result.sheet, 'All Abilities', 'Allocated from roll'),
        ],
        components: buildOnboardingComponents(this.manager.getSessionById(sessionId) ?? details, interaction.user.id),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    return false;
  }

  async shutdown(): Promise<void> {
    for (const timer of this.voteTimers.values()) {
      clearTimeout(timer);
    }
    this.voteTimers.clear();
    this.rag.close();
    this.manager.close();
  }

  scheduleOpenVotes(): void {
    for (const vote of this.manager.listOpenVotes()) {
      this.scheduleVoteTimeout(vote.id, vote.expiresAt);
    }
  }

  getSessionForThread(threadId: string): DndSessionDetails | null {
    return this.manager.getSessionForThread(threadId);
  }

  shouldQueueNarrativeActions(threadId: string): boolean {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) return false;
    if (this.isCombatActive(threadId)) return false;
    const availablePlayers = details.players.filter(player => player.status === 'available');
    if (availablePlayers.length < 2) return false;
    return Boolean(
      details.vote?.vote.kind === 'party_decision'
      || this.parseSceneState(details.session.sceneStateJson)?.partySituation?.toLowerCase().includes('together')
      || this.parseSceneState(details.session.sceneStateJson)?.currentObjective?.toLowerCase().includes('party'),
    );
  }

  queueNarrativeAction(threadId: string, userId: string, actionText: string): {
    queued: boolean;
    shouldResolve: boolean;
    waitingOn: string[];
    combinedActionText: string | null;
  } {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) {
      return { queued: false, shouldResolve: false, waitingOn: [], combinedActionText: null };
    }
    const queued = this.manager.queueNarrativeAction(details.session.id, userId, actionText);
    const availablePlayers = details.players.filter(player => player.status === 'available');
    const queuedIds = new Set(queued.map(entry => entry.userId));
    const waitingOn = availablePlayers
      .filter(player => !queuedIds.has(player.userId))
      .map(player => player.characterName);
    if (waitingOn.length > 0) {
      return { queued: true, shouldResolve: false, waitingOn, combinedActionText: null };
    }

    const voteSummary = details.vote?.vote.kind === 'party_decision'
      ? `Party vote in play: ${details.vote.vote.question}.`
      : null;
    const combinedActionText = [
      '[SYSTEM: Resolve these queued party actions together in one coherent scene update. Keep the same scene and continuity.]',
      voteSummary,
      ...queued.map(entry => `${entry.characterName}: ${entry.actionText}`),
    ].filter(Boolean).join('\n');
    this.manager.clearQueuedNarrativeActions(details.session.id);
    return { queued: true, shouldResolve: true, waitingOn: [], combinedActionText };
  }

  async buildQuestionContext(threadId: string, question: string): Promise<string> {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) {
      return 'No DnD session is attached to this thread.';
    }

    await this.ensureWorldRagReady(details.session);
    await this.syncRagForSession(details.session.id);
    return buildRagQuestionContext({
      rag: this.rag,
      embeddings: this.embeddings,
      sessionId: details.session.id,
      question,
      extraScopeIds: this.getWorldScopeIds(details.session),
    });
  }

  async buildNarrativeRagContext(threadId: string, message: string): Promise<string> {
    const details = this.manager.getSessionForThread(threadId);
    const ragContext = await this.buildQuestionContext(threadId, message);
    const sceneState = details ? this.parseSceneState(details.session.sceneStateJson) : null;
    const channel = await this.client.channels.fetch(threadId).catch(() => null);
    const recentSceneSnapshot = channel?.isTextBased()
      ? await this.buildRecentSceneSnapshot(channel)
      : '';
    const extras: string[] = [ragContext];
    if (sceneState) {
      extras.push([
        '<canonical_scene_state>',
        `Title: ${sceneState.title ?? 'Scene Update'}`,
        `Source: ${sceneState.source}`,
        `Updated: ${new Date(sceneState.updatedAt).toISOString()}`,
        `Location: ${sceneState.location ?? 'unknown'}`,
        `Time: ${sceneState.timeOfDay ?? 'unknown'}`,
        `Weather: ${sceneState.weather ?? 'unknown'}`,
        `NPCs: ${sceneState.activeNpcs.join(', ') || 'none'}`,
        `Conflict: ${sceneState.currentConflict ?? 'none'}`,
        `Objective: ${sceneState.currentObjective ?? 'none'}`,
        `Risks: ${sceneState.currentRisks.join(', ') || 'none'}`,
        `Party Situation: ${sceneState.partySituation ?? 'unknown'}`,
        `Summary: ${sceneState.summary}`,
        '',
        sceneState.narrative,
        '</canonical_scene_state>',
      ].join('\n'));
    }
    if (recentSceneSnapshot) {
      extras.push(`<recent_scene_snapshot>\n${recentSceneSnapshot}\n</recent_scene_snapshot>`);
    }
    return extras.join('\n\n');
  }

  isProtectedThread(threadId: string): boolean {
    return Boolean(this.manager.getSessionForThread(threadId));
  }

  isPlayerInThread(threadId: string, userId: string): boolean {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) return false;
    return details.players.some(player => player.userId === userId && player.status !== 'left');
  }

  isCombatActive(threadId: string): boolean {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) return false;
    return Boolean(this.manager.getCombatState(details.session.id)?.active);
  }

  validateNarrativeTurn(threadId: string, userId: string): { ok: true } | { ok: false; reason: string } {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) return { ok: true };
    if (this.isCombatActive(threadId)) return { ok: true };

    const activeUserId = details.session.activePlayerUserId;
    if (!activeUserId) {
      return { ok: false, reason: 'There is no active player turn right now.' };
    }

    if (activeUserId !== userId) {
      const activeName = details.players.find(player => player.userId === activeUserId)?.characterName ?? 'another player';
      return { ok: false, reason: `It is currently ${activeName}'s turn.` };
    }

    const turnMarker = this.getNarrativeTurnMarker(details.session);
    const spentMarker = this.spentNarrativeTurns.get(this.getNarrativeTurnKey(details.session.id, userId));
    if (spentMarker === turnMarker) {
      return { ok: false, reason: 'You have already acted this turn. Use `/dnd end-turn` to pass the spotlight.' };
    }

    return { ok: true };
  }

  markNarrativeTurnSpent(threadId: string, userId: string): void {
    const details = this.manager.getSessionForThread(threadId);
    if (!details || this.isCombatActive(threadId)) return;
    this.spentNarrativeTurns.set(
      this.getNarrativeTurnKey(details.session.id, userId),
      this.getNarrativeTurnMarker(details.session),
    );
  }

  buildNarrativeTurnSpentNotice(threadId: string, userId: string): string | null {
    const details = this.manager.getSessionForThread(threadId);
    if (!details || this.isCombatActive(threadId)) return null;
    if (details.session.activePlayerUserId !== userId) return null;
    return 'Turn spent. Use `/dnd end-turn` when you are ready to pass the spotlight.';
  }

  buildTableTalkPrompt(threadId: string, userId: string, message: string, ragContext?: string): string {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) return message;

    const speaker = details.players.find(player => player.userId === userId);
    const activePlayer = details.players.find(player => player.userId === details.session.activePlayerUserId);
    const shop = this.manager.getActiveShop(details.session.id);
    const shopSummary = shop
      ? `${shop.shop.name} (${shop.items.length} items, open)`
      : 'none';
    const worldMode = details.session.worldKey ? 'preconfigured lorebook' : 'generated session world';
    const worldIdentity = details.session.worldKey
      ? getPreconfiguredWorld(details.session.worldKey)?.name ?? details.session.worldKey
      : 'Random World';
    const worldAnchor = details.session.worldInfo?.slice(0, 1200) ?? 'No world summary stored.';
    const sceneState = this.parseSceneState(details.session.sceneStateJson);
    const canonicalScene = sceneState
      ? `${sceneState.title ?? 'Scene Update'} (${sceneState.source}, ${new Date(sceneState.updatedAt).toISOString()})\nSummary: ${sceneState.summary}\n${sceneState.narrative}`
      : 'No canonical scene state stored yet.';

    // Session state and world lore context — the GM persona and formatting rules
    // are now provided via systemPromptOverride in the engine request.
    return `
<session_state>
Title: ${details.session.title} (${details.session.id})
Phase: ${details.session.phase} | Round/Turn: ${details.session.roundNumber}/${details.session.turnNumber}
Active Player (Whose turn it is): ${activePlayer?.characterName ?? 'none'}
Speaking Player (Who sent the input): ${speaker?.characterName ?? 'unknown'}
Open Shop: ${shopSummary}
Party Status: ${details.players.map(player => `${player.characterName} [${player.status}]`).join(', ')}
World Mode: ${worldMode}
World Identity: ${worldIdentity}
World Anchor: ${worldAnchor}
</session_state>

<canonical_scene_state>
${canonicalScene}
</canonical_scene_state>

<world_lore>
${ragContext?.trim() || 'No active lore context.'}
</world_lore>

<player_input>
${message}
</player_input>

### GM RESPONSE GUIDELINES:
1. **Persona**: You are the D&D Game Master. Stay in character. No GIFs/emojis.
2. **Context**: React to the player input and the current scene. Describe the environment and NPC reactions vividly.
3. **NPCs**: Wrap NPC dialogue in \`<npc>**Name** says, "..."</npc>\` tags.
4. **Meta**: Wrap mechanics/rolls in \`<meta>...</meta>\` tags.
5. **Actions (MANDATORY)**: You MUST provide exactly 3 situational action choices in a \`<dnd_actions>["Option 1", "Option 2", "Option 3"]</dnd_actions>\` tag at the VERY END.
   - **DO NOT** use generic choices like "Explore" or "Talk".
   - **USE** choices specific to the scene, e.g., "Press the loose stone in the wall", "Confront the guard about the missing keys", or "Barricade the tavern door".
   - Keep each action choice short and button-friendly, ideally under 8 words and under 60 characters.
6. **Rolls**: If a check is needed, suggest it with a REAL notation like \`<dnd_roll>1d20+3</dnd_roll>\`. Never use placeholders like Wisdom, INT, modifier, or /dnd.
   - You may also mention the check in \`<meta>\`, but the actual dice notation must still go in \`<dnd_roll>\`.
7. **Combat Trigger (OPTIONAL)**: If the scene clearly becomes combat, include a \`<dnd_combat>{...}</dnd_combat>\` tag with JSON like \`{"start":true,"enemies":[{"name":"Harlen","hp":26,"ac":13,"attackBonus":4,"damage":"1d8+2","dex":12,"str":13,"con":12,"wis":10,"int":10,"cha":11}]}\`.
   - Use the actual NPC names from the narration.
   - Only include this tag when combat has truly begun.
8. **Improvised Combat**: If a player attempts something messy, ill-advised, comedic, nonstandard, or otherwise not covered by normal combat mechanics, you may adjudicate it narratively.
   - You may call for a roll, including bluffing, fleeing, panicking an enemy, wild wand misuse, environmental stunts, or reckless gambits.
   - The outcome can be partial success, self-inflicted trouble, damage, morale loss, an opening to escape, or no effect at all.
   - Keep it fair, vivid, and a little fun when the action invites it.
9. **Lorebook Fidelity**: If World Mode is preconfigured lorebook, stay inside that established setting and reuse its proper nouns, factions, locations, and tensions. Do not invent a replacement world.
10. **Continuity Discipline**: Treat both the canonical scene state and the recent scene snapshot as canon. Do not change location, weather, time of day, active NPCs, or the immediate situation unless the player action or the canon already establishes that change.
11. **No Branching Reality**: Do not write alternate versions of the same beat. Continue from the latest established moment instead of retrying, reframing, or replacing prior events inside the narrative itself.
12. **Canonical Priority**: If older lore, stale context, or joke bits conflict with the canonical scene state, follow the canonical scene state and continue cleanly from there.

Write your GM response now.`.trim();
  }

  private getNarrativeTurnKey(sessionId: string, userId: string): string {
    return `${sessionId}:${userId}`;
  }

  private getNarrativeTurnMarker(session: DndSessionRecord): string {
    return `${session.roundNumber}.${session.turnNumber}`;
  }

  buildTurnTrackerEmbed(threadId: string): EmbedBuilder | null {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) return null;
    return buildTurnTrackerEmbed(details);
  }

  private parseSceneState(sceneStateJson: string | null | undefined): DndSceneState | null {
    if (!sceneStateJson) return null;
    try {
      const parsed = JSON.parse(sceneStateJson) as Partial<DndSceneState>;
      return {
        title: parsed.title ?? null,
        location: parsed.location ?? null,
        timeOfDay: parsed.timeOfDay ?? null,
        weather: parsed.weather ?? null,
        activeNpcs: Array.isArray(parsed.activeNpcs) ? parsed.activeNpcs.filter(Boolean) : [],
        currentConflict: parsed.currentConflict ?? null,
        currentObjective: parsed.currentObjective ?? null,
        currentRisks: Array.isArray(parsed.currentRisks) ? parsed.currentRisks.filter(Boolean) : [],
        partySituation: parsed.partySituation ?? null,
        summary: parsed.summary ?? '',
        narrative: parsed.narrative ?? '',
        source: parsed.source ?? 'narrative',
        updatedAt: parsed.updatedAt ?? Date.now(),
        activePlayerUserId: parsed.activePlayerUserId ?? null,
        messageId: parsed.messageId ?? null,
      };
    } catch {
      return null;
    }
  }

  private summarizeCanonicalScene(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    const paragraphs = content
      .split(/\n{2,}/)
      .map(part => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 2);
    const candidate = (paragraphs.join(' ') || normalized).trim();
    return candidate.slice(0, 900);
  }

  async recordCanonicalSceneState(input: {
    threadId: string;
    sessionId: string;
    source: DndSceneState['source'];
    title: string | null;
    content: string;
    messageId?: string | null;
  }): Promise<void> {
    if (!input.sessionId) return;
    const cleanContent = input.content.replace(/\s+\n/g, '\n').trim();
    if (!cleanContent) return;

    const details = this.manager.getSessionById(input.sessionId);
    if (!details) return;

    const derived = deriveStructuredSceneState(cleanContent);

    const sceneState: DndSceneState = {
      title: input.title,
      location: derived.location,
      timeOfDay: derived.timeOfDay,
      weather: derived.weather,
      activeNpcs: derived.activeNpcs,
      currentConflict: derived.currentConflict,
      currentObjective: derived.currentObjective,
      currentRisks: derived.currentRisks,
      partySituation: derived.partySituation,
      summary: this.summarizeCanonicalScene(cleanContent),
      narrative: cleanContent.slice(0, 2400),
      source: input.source,
      updatedAt: Date.now(),
      activePlayerUserId: details.session.activePlayerUserId,
      messageId: input.messageId ?? null,
    };

    this.manager.updateSceneState(input.sessionId, sceneState);
    this.manager.updateSessionWorldState(input.sessionId, {
      sceneDanger: derived.currentRisks.length === 0 ? 'safe' : derived.currentRisks.length >= 2 ? 'danger' : 'tense',
      safeRest: derived.currentRisks.length === 0,
    });
    this.memory.saveMessage({
      sessionKey: `discord:${input.threadId}`,
      role: 'assistant',
      content: [
        '[CANONICAL_SCENE_STATE]',
        `Title: ${sceneState.title ?? 'Scene Update'}`,
        `Source: ${sceneState.source}`,
        'This canonical scene state supersedes older conflicting scene descriptions.',
        '',
        `Summary: ${sceneState.summary}`,
        '',
        sceneState.narrative,
      ].join('\n'),
      timestamp: sceneState.updatedAt,
      metadata: JSON.stringify({
        kind: 'dnd_scene_state',
        sessionId: input.sessionId,
        source: sceneState.source,
        title: sceneState.title,
        location: sceneState.location,
        messageId: sceneState.messageId ?? null,
      }),
    });
  }


  async processStructuredNarrativeResponse(threadId: string, content: string): Promise<{
    content: string;
    shopEmbeds: EmbedBuilder[];
    combatEmbeds: EmbedBuilder[];
    combatComponents: ActionRowBuilder<ButtonBuilder>[] | null;
    actionComponents: ActionRowBuilder<ButtonBuilder>[] | null;
    rollComponents: ActionRowBuilder<ButtonBuilder>[] | null;
    validation: ValidationResult | null;
  }> {
    const details = this.manager.getSessionForThread(threadId);
    if (!details) {
      return { content, shopEmbeds: [], combatEmbeds: [], combatComponents: null, actionComponents: null, rollComponents: null, validation: null };
    }

    const parsed = parseStructuredNarrative(content);
    if (parsed.directiveError) {
      log.warn({ threadId, sessionId: details.session.id, error: parsed.directiveError }, 'Failed to parse DnD structured narrative directive');
    }

    const shopEmbeds: EmbedBuilder[] = [];
    const combatEmbeds: EmbedBuilder[] = [];
    let combatComponents: ActionRowBuilder<ButtonBuilder>[] | null = null;
    const directive = parsed.shopDirective;
    if (directive) {
      try {
        if (directive.action === 'close') {
          this.manager.closeShop(details.session.id, details.session.hostUserId);
          shopEmbeds.push(
            new EmbedBuilder()
              .setTitle('Shop Closed')
              .setColor(0x95a5a6)
              .setDescription('The active shop has closed.')
              .setFooter({ text: `Session: ${details.session.title}` }),
          );
        } else {
          const items = directive.items ?? [];
          const opened = this.manager.openShop({
            sessionId: details.session.id,
            actorUserId: details.session.hostUserId,
            name: directive.name ?? 'Shop',
            description: directive.description,
            items,
          });
          shopEmbeds.push(buildShopEmbed(details.session, opened.shop, opened.items, 'A merchant offer is now available.'));
        }
        await this.syncRagForSession(details.session.id);
      } catch (error: any) {
        log.warn({ threadId, sessionId: details.session.id, error: error.message }, 'Failed to apply DnD structured narrative directive');
      }
    }

    if (parsed.combatDirective) {
      try {
        const currentCombat = this.manager.getCombatState(details.session.id);
        if (!currentCombat?.active) {
          const enemyDefinitions = parsed.combatDirective.enemies
            .map(enemy => [
              enemy.name,
              enemy.hp ?? 20,
              enemy.ac ?? 12,
              enemy.attackBonus ?? 3,
              enemy.damage ?? '1d6+1',
              enemy.dex ?? 12,
              enemy.str ?? 10,
              enemy.con ?? 10,
              enemy.wis ?? 10,
              enemy.int ?? 10,
              enemy.cha ?? 10,
            ].join('|'))
            .join('\n');

          const result = this.manager.enterCombat(
            details.session.id,
            details.session.hostUserId,
            enemyDefinitions,
          );
          await this.syncRagForSession(result.summary.session.id);
          combatEmbeds.push(buildCombatEmbed(
            result.summary.session,
            result.summary.players,
            result.combat,
            'Combat started.',
            'Combat started from the current narrative scene.',
          ));
          combatComponents = buildCombatActionRows(result.summary.session.id);
        }
      } catch (error: any) {
        log.warn({ threadId, sessionId: details.session.id, error: error.message }, 'Failed to apply DnD combat directive');
      }
    }

    const validation = repairNarrativePacket({
      session: details.session,
      sceneState: this.parseSceneState(details.session.sceneStateJson),
      content: parsed.cleanedContent,
      actionChoices: parsed.actionChoices,
      rollSuggestions: parsed.rollSuggestions,
    });
    if (!validation.ok) {
      log.warn({
        threadId,
        sessionId: details.session.id,
        issues: validation.issues.map(issue => issue.code),
        originalContent: parsed.cleanedContent.slice(0, 800),
      }, 'Validated and repaired GM narrative packet');
    }

    const refreshedDetails = this.manager.getSessionForThread(threadId) ?? details;
    const activeUserId = refreshedDetails.session.activePlayerUserId ?? refreshedDetails.session.hostUserId ?? '';
    const defaultChoices = buildSceneSpecificFallbackChoices(validation.repairedContent, null);
    const resolvedChoices = validation.repairedChoices.length > 0
      ? validation.repairedChoices
      : defaultChoices;
    const actionComponents = combatEmbeds.length > 0
      ? null
      : activeUserId
        ? buildActionChoiceRows(refreshedDetails.session.id, activeUserId, resolvedChoices)
        : null;

    const safeRollSuggestions = validation.repairedRolls;
    const rollComponents = activeUserId && safeRollSuggestions.length > 0
      ? buildRollChoiceRows(refreshedDetails.session.id, activeUserId, safeRollSuggestions)
      : null;

    return {
      content: validation.repairedContent,
      shopEmbeds,
      combatEmbeds,
      combatComponents,
      actionComponents,
      rollComponents,
      validation,
    };
  }

  /**
   * Helper to call LLM with proper structure and collect response.
   */
  private async generateGMNarrative(systemPrompt: string, userPrompt: string): Promise<string> {
    let fullText = '';
    const config = getConfig();
    const stream = this.engine.streamChat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      [],
      {
        temperature: 0.85, // Higher for better creativity
        maxTokens: 2000,
      }
    );

    for await (const chunk of stream) {
      if (chunk.type === 'content' && chunk.content) {
        fullText += chunk.content;
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error || 'LLM Generation failed');
      }
    }

    return fullText.trim();
  }

  private async generateValidatedNarrative(
    threadId: string,
    sessionId: string,
    systemPrompt: string,
    prompt: string,
  ): Promise<{
    content: string;
    shopEmbeds: EmbedBuilder[];
    combatEmbeds: EmbedBuilder[];
    combatComponents: ActionRowBuilder<ButtonBuilder>[] | null;
    actionComponents: ActionRowBuilder<ButtonBuilder>[] | null;
    rollComponents: ActionRowBuilder<ButtonBuilder>[] | null;
    validation: ValidationResult | null;
  }> {
    let attemptPrompt = prompt;
    let lastProcessed: Awaited<ReturnType<DndDiscordController['processStructuredNarrativeResponse']>> | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const rawText = await this.generateGMNarrative(systemPrompt, attemptPrompt);
      const processed = await this.processStructuredNarrativeResponse(threadId, rawText);
      lastProcessed = processed;
      if (!processed.validation?.shouldRegenerate) {
        return processed;
      }
      attemptPrompt = [
        prompt,
        '',
        '[SYSTEM CORRECTION: The previous draft broke continuity or world fidelity.]',
        `Issues: ${processed.validation.issues.map(issue => issue.code).join(', ')}`,
        'Regenerate from the same canonical scene. Do not move the scene, swap locations, or invent a replacement setting.',
      ].join('\n');
      log.warn({ sessionId, threadId, issues: processed.validation.issues.map(issue => issue.code), attempt }, 'Regenerating invalid GM response');
    }
    return lastProcessed ?? {
      content: '',
      shopEmbeds: [],
      combatEmbeds: [],
      combatComponents: null,
      actionComponents: null,
      rollComponents: null,
      validation: null,
    };
  }

  private async handleDndCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);

    try {
      this.assertDndCommandAccess(interaction, subcommand);

      switch (subcommand) {
        case 'start':
          await this.handleStart(interaction);
          return;
        case 'join':
          await this.handleJoin(interaction);
          return;
        case 'begin':
          await this.handleBegin(interaction);
          return;
        case 'save':
          await this.handleSave(interaction);
          return;
        case 'resume':
          await this.handleResume(interaction);
          return;
        case 'restore':
          await this.handleRestore(interaction);
          return;
        case 'status':
          await this.handleStatus(interaction);
          return;
        case 'list':
          await this.handleList(interaction);
          return;
        case 'checkpoints':
          await this.handleCheckpoints(interaction);
          return;
        case 'available':
          await this.handleAvailability(interaction, true);
          return;
        case 'unavailable':
          await this.handleAvailability(interaction, false);
          return;
        case 'end':
          await this.handleEnd(interaction);
          return;
        case 'end-turn':
          await this.handleEndTurn(interaction);
          return;
        case 'skip-vote':
          await this.handleVoteCommand(interaction);
          return;
        case 'quest-complete':
          await this.handleQuestComplete(interaction);
          return;
        case 'quest-log':
          await this.handleQuestLog(interaction);
          return;
        default:
          await interaction.reply({ content: 'Unknown DnD subcommand.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, `DnD command failed: ${error.message}`);
    }
  }

  private async handleStatsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const subcommand = interaction.options.getSubcommand(true);

      switch (subcommand) {
        case 'view': {
          const player = requirePlayer(details.players, interaction.user.id);
          const sheet = this.manager.getCharacterSheet(details.session.id, interaction.user.id);
          const inventory = this.manager.getInventory(details.session.id, interaction.user.id);
          const progress = this.manager.getProgressLog(details.session.id);
          const lastRewards = progress.slice(-3).reverse();
          await interaction.reply({
            embeds: [buildStatsEmbed(details.session, player, sheet, inventory, lastRewards)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'set': {
          const field = interaction.options.getString('field', true);
          const rawValue = interaction.options.getString('value', true);
          const result = this.manager.updateCharacterField(
            details.session.id, interaction.user.id, field, rawValue,
          );
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildStatUpdateEmbed(details.session, result.player, result.sheet, field, rawValue)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'class': {
          const classId = interaction.options.getString('class_id', true);
          const classDef = getClassById(classId);
          if (!classDef) throw new Error(`Unknown class: ${classId}`);
          const result = this.manager.selectOnboardingClass(
            details.session.id, interaction.user.id, classId,
          );
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [
              buildClassSelectedEmbed(details.session, result.player, result.sheet, classDef),
              buildOnboardingEmbed(
                this.manager.getSessionById(details.session.id) ?? details,
                interaction.user.id,
                result.autoAssigned
                  ? `Class selected and rolled stats auto-applied using ${formatRecommendedAbilityOrder(classDef)}.`
                  : `Class selected. Roll next and LiteClaw will auto-assign using ${formatRecommendedAbilityOrder(classDef)}.`,
              ),
              ...(result.autoAssigned
                ? [buildAutoAssignmentEmbed(details.session, result.player, classDef, getPlayerOnboardingState(result.player).rolledStats, result.sheet.abilities)]
                : []),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'roll': {
          const rolled = this.manager.generateOnboardingStats(details.session.id, interaction.user.id);
          const refreshed = this.manager.getSessionById(details.session.id) ?? details;
          const player = requirePlayer(refreshed.players, interaction.user.id);
          const classDef = player.onboardingState?.selectedClassId ? getClassById(player.onboardingState.selectedClassId) : null;
          await interaction.reply({
            embeds: [
              buildStatRollEmbed(details.session, interaction.user.id, rolled, classDef),
              buildOnboardingEmbed(
                refreshed,
                interaction.user.id,
                classDef
                  ? `Rolled stats auto-applied using ${formatRecommendedAbilityOrder(classDef)}.`
                  : 'Choose your class next and the rolled values will auto-assign for you.',
              ),
              ...(classDef ? [buildAutoAssignmentEmbed(details.session, player, classDef, rolled, this.manager.getCharacterSheet(details.session.id, interaction.user.id).abilities)] : []),
            ],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'short-rest': {
          const hitDice = interaction.options.getInteger('hit_dice', true);
          const result = this.manager.performShortRest(details.session.id, interaction.user.id, hitDice);
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildRestEmbed(details.session, result.player, result.sheet, 'short', result.hpRegained, result.hitDiceUsed)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'long-rest': {
          const result = this.manager.performLongRest(details.session.id, interaction.user.id);
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildRestEmbed(details.session, result.player, result.sheet, 'long', result.hpRegained, 0, result.conditionsCleared, result.exhaustionReduced)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'condition': {
          const action = interaction.options.getString('action', true);
          const condName = interaction.options.getString('name', true);
          if (action === 'add') {
            const result = this.manager.addCondition(details.session.id, interaction.user.id, condName);
            if (!result.added) throw new Error(result.error!);
            await this.syncRagForSession(details.session.id);
            await interaction.reply({
              embeds: [buildConditionEmbed(details.session, result.player, result.sheet, 'add', condName)],
              flags: MessageFlags.Ephemeral,
            });
          } else {
            const result = this.manager.removeCondition(details.session.id, interaction.user.id, condName);
            if (!result.removed) throw new Error(result.error!);
            await this.syncRagForSession(details.session.id);
            await interaction.reply({
              embeds: [buildConditionEmbed(details.session, result.player, result.sheet, 'remove', condName)],
              flags: MessageFlags.Ephemeral,
            });
          }
          return;
        }
        case 'exhaustion': {
          const level = interaction.options.getInteger('level', true);
          const result = this.manager.updateCharacterField(
            details.session.id, interaction.user.id, 'exhaustion', String(level),
          );
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildStatUpdateEmbed(details.session, result.player, result.sheet, 'exhaustion', String(level))],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        default:
          await interaction.reply({ content: 'Unknown stats command.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleSkillsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const player = requirePlayer(details.players, interaction.user.id);
      const sheet = this.manager.getCharacterSheet(details.session.id, interaction.user.id);
      await interaction.reply({
        embeds: [buildSkillsEmbed(details.session, player, sheet)],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleSpellsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const player = requirePlayer(details.players, interaction.user.id);
      const sheet = this.manager.getCharacterSheet(details.session.id, interaction.user.id);
      await interaction.reply({
        embeds: [buildSpellsEmbed(details.session, player, sheet)],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleAvatarCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const subcommand = interaction.options.getSubcommand(true);
      const player = requirePlayer(details.players, interaction.user.id);

      if (subcommand === 'view') {
        await interaction.reply({
          embeds: [buildAvatarEmbed(details.session, player)],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'discord') {
        const avatarUrl = interaction.user.displayAvatarURL({ extension: 'png', size: 512 });
        const updated = this.manager.setAvatar(details.session.id, interaction.user.id, {
          url: avatarUrl,
          source: 'discord',
        });
        await interaction.reply({
          embeds: [buildAvatarEmbed(details.session, updated, 'Using your Discord avatar as your character portrait.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'upload') {
        const attachment = interaction.options.getAttachment('image', true);
        if (!attachment.contentType?.startsWith('image/')) {
          throw new Error('Please upload an image file.');
        }
        const updated = this.manager.setAvatar(details.session.id, interaction.user.id, {
          url: attachment.url,
          source: 'upload',
        });
        await interaction.reply({
          embeds: [buildAvatarEmbed(details.session, updated, 'Portrait updated from uploaded image.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (subcommand === 'url') {
        const imageUrl = interaction.options.getString('image_url', true).trim();
        if (!/^https?:\/\//i.test(imageUrl)) {
          throw new Error('Please provide a direct http(s) image URL.');
        }
        const updated = this.manager.setAvatar(details.session.id, interaction.user.id, {
          url: imageUrl,
          source: 'upload',
        });
        await interaction.reply({
          embeds: [buildAvatarEmbed(details.session, updated, 'Portrait updated from direct URL.')],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.reply({ content: 'Unknown avatar command.', flags: MessageFlags.Ephemeral });
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleInventoryCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const subcommand = interaction.options.getSubcommand(true);

      switch (subcommand) {
        case 'view': {
          const player = requirePlayer(details.players, interaction.user.id);
          const items = this.manager.getInventory(details.session.id, interaction.user.id);
          const sheet = this.manager.getCharacterSheet(details.session.id, interaction.user.id);
          await interaction.reply({
            embeds: [buildInventoryEmbed(details.session, player, sheet.gold, items)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'add': {
          const target = interaction.options.getUser('player', true);
          const item = this.manager.addInventoryItem({
            sessionId: details.session.id,
            actorUserId: interaction.user.id,
            targetUserId: target.id,
            name: interaction.options.getString('name', true),
            quantity: interaction.options.getInteger('quantity') ?? 1,
            category: interaction.options.getString('category'),
            notes: interaction.options.getString('notes'),
            consumable: interaction.options.getBoolean('consumable') ?? false,
          });
          await interaction.reply({
            embeds: [buildInventoryItemAddedEmbed(details.session, item, target.id)],
          });
          return;
        }
        case 'spend-item': {
          const result = this.manager.spendInventoryItem({
            sessionId: details.session.id,
            userId: interaction.user.id,
            itemId: interaction.options.getString('item_id', true),
            quantity: interaction.options.getInteger('quantity') ?? 1,
          });
          await interaction.reply({
            embeds: [buildInventorySpendEmbed(details.session, result.item, result.spent)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'drop': {
          const result = this.manager.removeInventoryItem({
            sessionId: details.session.id,
            actorUserId: interaction.user.id,
            targetUserId: interaction.user.id,
            itemId: interaction.options.getString('item_id', true),
            quantity: interaction.options.getInteger('quantity') ?? undefined,
          });
          await interaction.reply({
            embeds: [buildInventoryDropEmbed(details.session, result.item, result.removed)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'spend-gold': {
          const result = this.manager.spendGold(
            details.session.id,
            interaction.user.id,
            interaction.options.getInteger('amount', true),
            interaction.options.getString('reason'),
          );
          await interaction.reply({
            embeds: [buildGoldSpendEmbed(details.session, result.player, result.sheet, result.spent, result.reason)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        default:
          await interaction.reply({ content: 'Unknown inventory command.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleTurnCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const action = interaction.options.getString('action', true).trim();

      if (details.session.phase !== 'active') {
        throw new Error('Turns can only be submitted while the session is active.');
      }

      if (!action) {
        throw new Error('Describe what your character does.');
      }

      const combat = this.manager.getCombatState(details.session.id);
      if (combat?.active) {
        try {
          const pendingBefore = this.safeGetPendingCombatActions(details.session.id);
          const actorName = details.players.find(player => player.userId === interaction.user.id)?.characterName ?? 'A party member';
          const actorIsFinalPending = Boolean(
            pendingBefore
            && pendingBefore.waitingOn.length === 1
            && pendingBefore.waitingOn[0] === actorName,
          );
          if (actorIsFinalPending) {
            await this.refreshPublicCombatStatusMessage(
              interaction.channel,
              details.session.id,
              `${actorName} locked in an action for this round.`,
              {
                headline: 'GM resolving the round',
                detail: 'All player actions are locked in. Enemy turns and narration are being resolved now.',
                readyStatus: `${pendingBefore!.submitted.length + 1} / ${pendingBefore!.submitted.length + 1} locked in`,
              },
            );
          }
          const result = await this.manager.submitCombatAction(details.session.id, interaction.user.id, action, this.engine);
          await this.syncRagForSession(result.summary.session.id);

          if (result.status === 'waiting') {
            await this.refreshPublicCombatStatusMessage(
              interaction.channel,
              result.summary.session.id,
              `${actorName} locked in an action for this round.`,
            );
            await interaction.editReply({
              content: `Action recorded. Waiting on: ${result.waitingOn.join(', ')}`,
            });
            return;
          }

          const mechanics = result.messages.join('\n') || 'Round resolved.';
          const actions = result.roundNarrative.join('\n');
          await interaction.editReply({
            embeds: [
              buildCombatEmbed(
                result.summary.session,
                result.summary.players,
                result.combat,
                mechanics,
                actions,
              ),
            ],
            components: result.combat.active ? buildCombatActionRows(result.summary.session.id) : [],
          });
          if (!result.combat.active) {
            await this.postCombatResolution(
              interaction.channelId,
              details.session.id,
              result.combat,
              result.messages,
              payload => interaction.followUp(payload as any),
            );
          }
          return;
        } catch (error: any) {
          if (shouldFallbackToNarrativeCombat(error.message)) {
            await interaction.editReply({
              content: 'Treating that as an improvised combat action. The GM can call for a roll and adjudicate the outcome.',
            });
            return;
          }
          throw error;
        }
      }

      const activeUserId = details.session.activePlayerUserId;
      if (!combat?.active && activeUserId && activeUserId !== interaction.user.id) {
        const activeName = details.players.find(player => player.userId === activeUserId)?.characterName ?? 'another player';
        throw new Error(`It is currently ${activeName}'s turn.`);
      }

      const gate = this.validateNarrativeTurn(interaction.channelId, interaction.user.id);
      if (!gate.ok) {
        throw new Error(gate.reason);
      }

      await interaction.editReply({
        content: 'Turn submitted to the GM.',
      });
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleEndShortcutCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const subcommand = interaction.options.getSubcommand(true);
      switch (subcommand) {
        case 'turn':
          await this.handleEndTurn(interaction);
          return;
        default:
          await interaction.reply({ content: 'Unknown end shortcut.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleDowntimeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const subcommand = interaction.options.getSubcommand(true);

      switch (subcommand) {
        case 'do': {
          const activityId = interaction.options.getString('activity', true) as
            | 'training'
            | 'crafting'
            | 'carousing'
            | 'research'
            | 'recuperating'
            | 'work'
            | 'religious_service';
          const focus = interaction.options.getString('focus');
          const durationMinutes = interaction.options.getInteger('duration_minutes') ?? 60;
          const itemValue = interaction.options.getInteger('item_value');
          const result = this.manager.performDowntime({
            sessionId: details.session.id,
            userId: interaction.user.id,
            activityId,
            focus,
            durationMinutes,
            itemValue,
          });
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildDowntimeResultEmbed(details.session, result.player, result.sheet, result.record, result.progress)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'status': {
          const player = requirePlayer(details.players, interaction.user.id);
          const sheet = this.manager.getCharacterSheet(details.session.id, interaction.user.id);
          const progress = this.manager.getDowntimeProgress(details.session.id, interaction.user.id);
          const history = this.manager.getDowntimeHistory(details.session.id, interaction.user.id, 1);
          await interaction.reply({
            embeds: [buildDowntimeStatusEmbed(details.session, player, sheet, history[0] ?? null, progress)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'history': {
          const history = this.manager.getDowntimeHistory(details.session.id, interaction.user.id, 8);
          await interaction.reply({
            embeds: [buildDowntimeHistoryEmbed(details.session, history)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        default:
          await interaction.reply({ content: 'Unknown downtime command.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleFleeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const combat = this.manager.getCombatState(details.session.id);
      if (!combat?.active) {
        throw new Error('You can only flee while combat is active.');
      }

      const result = this.manager.fleeCombat(details.session.id, interaction.user.id);
      await this.syncRagForSession(details.session.id);
      await interaction.reply({
        embeds: [buildCombatEmbed(result.summary.session, result.summary.players, result.combat, result.message, 'Flee attempt recorded.')],
        components: result.combat.active ? buildCombatActionRows(result.summary.session.id) : [],
      });
      if (!result.combat.active) {
        await this.postCombatResolution(
          interaction.channelId,
          details.session.id,
          result.combat,
          [result.message],
          payload => interaction.followUp(payload as any),
        );
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleInspireCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const target = interaction.options.getUser('player', true);
      const result = this.manager.grantInspiration(details.session.id, interaction.user.id, target.id);
      await this.syncRagForSession(details.session.id);
      await interaction.reply({
        embeds: [buildInspirationEmbed(details.session, result.player, result.sheet, interaction.user.id)],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleDeathSaveCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const subcommand = interaction.options.getSubcommand(true);

      switch (subcommand) {
        case 'roll': {
          const useInspiration = interaction.options.getBoolean('use_inspiration') ?? false;
          const result = this.manager.rollDeathSave(details.session.id, interaction.user.id, useInspiration);
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildDeathSaveEmbed(details.session, result.player, result.sheet, result.event, result.roll, useInspiration)],
          });
          return;
        }
        case 'status': {
          const player = requirePlayer(details.players, interaction.user.id);
          const sheet = this.manager.getCharacterSheet(details.session.id, interaction.user.id);
          await interaction.reply({
            embeds: [buildDeathSaveStatusEmbed(details.session, player, sheet)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'damage': {
          const target = interaction.options.getUser('player', true);
          const damage = interaction.options.getInteger('damage', true);
          const critical = interaction.options.getBoolean('critical') ?? false;
          const result = this.manager.applyDeathSaveDamage(details.session.id, interaction.user.id, target.id, damage, critical);
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildDeathSaveDamageEmbed(details.session, result.player, result.sheet, damage, critical)],
          });
          return;
        }
        case 'reset': {
          const target = interaction.options.getUser('player') ?? interaction.user;
          const result = this.manager.resetDeathSaves(details.session.id, interaction.user.id, target.id);
          await this.syncRagForSession(details.session.id);
          await interaction.reply({
            embeds: [buildDeathSaveResetEmbed(details.session, result.player, result.sheet)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        default:
          await interaction.reply({ content: 'Unknown death save command.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handlePartyVoteCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const question = interaction.options.getString('question', true);
      const options = interaction.options.getString('options', true)
        .split('|')
        .map(part => part.trim())
        .filter(Boolean);
      const timeoutSeconds = interaction.options.getInteger('timeout_seconds') ?? 120;

      const vote = this.manager.createPartyDecisionVote({
        sessionId: details.session.id,
        initiatorUserId: interaction.user.id,
        question,
        options,
        timeoutMs: timeoutSeconds * 1000,
      });

      const message = await interaction.reply({
        embeds: [buildVoteEmbed(details.session, details.players, vote)],
        components: [buildVoteButtons(vote)],
        fetchReply: true,
      });

      this.manager.attachVoteMessage(vote.vote.id, interaction.channelId, message.id);
      this.scheduleVoteTimeout(vote.vote.id, vote.vote.expiresAt);
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleShopCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const subcommand = interaction.options.getSubcommand(true);

      switch (subcommand) {
        case 'open': {
          const items = parseShopItemsInput(interaction.options.getString('items', true));
          const shop = this.manager.openShop({
            sessionId: details.session.id,
            actorUserId: interaction.user.id,
            name: interaction.options.getString('name', true),
            description: interaction.options.getString('description'),
            items,
          });
          await interaction.reply({
            embeds: [buildShopEmbed(details.session, shop.shop, shop.items, 'Shop opened.')],
          });
          return;
        }
        case 'view': {
          const shop = this.manager.getActiveShop(details.session.id);
          if (!shop) {
            throw new Error('There is no active shop in this session.');
          }
          await interaction.reply({
            embeds: [buildShopEmbed(details.session, shop.shop, shop.items, 'Current active shop.')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'buy': {
          const result = this.manager.buyShopItem({
            sessionId: details.session.id,
            userId: interaction.user.id,
            itemId: interaction.options.getString('item_id', true),
            quantity: interaction.options.getInteger('quantity') ?? 1,
          });
          await interaction.reply({
            embeds: [buildShopPurchaseEmbed(details.session, result)],
          });
          return;
        }
        case 'close': {
          this.manager.closeShop(details.session.id, interaction.user.id);
          await interaction.reply({
            content: 'Shop closed.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        default:
          await interaction.reply({ content: 'Unknown shop command.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleDiceCommand(interaction: ChatInputCommandInteraction): Promise<string | boolean> {
    try {
      const { rollDice, formatDiceRoll } = await import('./mechanics.js');
      const requestedNotation = interaction.options.getString('roll', true);
      const isPublic = interaction.options.getBoolean('public') ?? true;
      const details = this.manager.getSessionForThread(interaction.channelId);
      const sheet = details?.players.some(player => player.userId === interaction.user.id)
        ? this.manager.getCharacterSheet(details.session.id, interaction.user.id)
        : null;
      const notation = normalizeSuggestedRollNotation(requestedNotation, sheet);
      const roll = rollDice(notation);
      const resultText = formatDiceRoll(roll);

      const embed = new EmbedBuilder()
        .setTitle('🎲 Dice Roll')
        .setColor(0xe67e22)
        .setDescription(resultText)
        .setFooter({ text: `Rolled by ${interaction.user.displayName}` })
        .setTimestamp();

      // Save to memory so agent sees it
      this.memory.saveMessage({
        sessionKey: `discord:${interaction.channelId}`,
        role: 'user',
        content: `[SYSTEM] ${interaction.user.displayName} rolled ${notation}: ${resultText}`,
        timestamp: Date.now(),
      });

      await interaction.reply({
        embeds: [embed],
        flags: isPublic ? undefined : MessageFlags.Ephemeral,
      });

      if (details && this.isPlayerInThread(interaction.channelId, interaction.user.id)) {
        return `[ROLL] ${interaction.user.displayName} rolled ${notation}: ${resultText}`;
      }

      return true;
    } catch (error: any) {
      await replyError(interaction, error.message);
      return true;
    }
  }

  private async handleRollButton(interaction: ButtonInteraction): Promise<string | boolean> {
    const customId = interaction.customId;
    const parts = customId.replace(DND_ROLL_PREFIX, '').split('_');
    if (parts.length < 3) return false;

    const [sessionId, activeUserId, ...notationParts] = parts;
    let notation = decodeRollButtonNotation(notationParts.join('_'));

    if (interaction.user.id !== activeUserId) {
      await interaction.reply({ content: 'It is not your turn to roll!', flags: MessageFlags.Ephemeral });
      return true;
    }

    try {
      const { rollDice, formatDiceRoll } = await import('./mechanics.js');
      const details = this.manager.getSessionById(sessionId);
      const sheet = details ? this.manager.getCharacterSheet(sessionId, interaction.user.id) : null;
      notation = normalizeSuggestedRollNotation(notation, sheet);
      const roll = rollDice(notation);
      const resultText = formatDiceRoll(roll);

      const embed = new EmbedBuilder()
        .setTitle('🎲 Dice Roll')
        .setColor(0xe67e22)
        .setDescription(resultText)
        .setFooter({ text: `Rolled by ${interaction.user.displayName}` })
        .setTimestamp();

      // Save to memory so agent sees it
      this.memory.saveMessage({
        sessionKey: `discord:${interaction.channelId}`,
        role: 'user',
        content: `[SYSTEM] ${interaction.user.displayName} rolled ${notation}: ${resultText}`,
        timestamp: Date.now(),
      });

      await interaction.deferUpdate();

      // Disable the button row after use
      const originalMessage = interaction.message;
      if (originalMessage) {
        const rows = originalMessage.components.map(row => {
          const newRow = ActionRowBuilder.from(row as any);
          newRow.components.forEach((comp: any) => {
            if (comp.data.custom_id === customId) {
              comp.setDisabled(true);
            }
          });
          return newRow;
        }) as ActionRowBuilder<ButtonBuilder>[];
        await originalMessage.edit({ components: rows }).catch(() => undefined);
      }

      await interaction.followUp({
        embeds: [embed],
      });

      return `[ROLL] ${interaction.user.displayName} rolled ${notation}: ${resultText}`;
    } catch (error: any) {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: `Roll failed: ${error.message}`, flags: MessageFlags.Ephemeral }).catch(() => undefined);
      } else {
        await interaction.reply({ content: `Roll failed: ${error.message}`, flags: MessageFlags.Ephemeral });
      }
    }
    return true;
  }

  private async handleLoreCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);

      switch (subcommand) {
        case 'upload': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const attachment = interaction.options.getAttachment('file', true);
          const docType = (interaction.options.getString('type') ?? detectDocType(attachment.name)) as 'pdf' | 'lore' | 'transcript' | 'text';

          if (attachment.size > 8 * 1024 * 1024) {
            throw new Error('File too large (max 8 MB).');
          }

          const response = await fetch(attachment.url);
          if (!response.ok) throw new Error('Failed to download attachment.');
          const buffer = Buffer.from(await response.arrayBuffer());
          const documentId = `DOC-${randomBase36(8).toUpperCase()}`;

          const doc = await ingestDocument({
            rag: this.rag,
            embeddings: this.embeddings,
            sessionId: details.session.id,
            documentId,
            filename: attachment.name,
            sourceType: docType,
            buffer,
            uploadedBy: interaction.user.id,
          });

          await interaction.editReply({
            embeds: [buildDocumentUploadEmbed(details.session, doc)],
          });
          return;
        }
        case 'list': {
          const docs = this.rag.listDocuments(details.session.id);
          await interaction.reply({
            embeds: [buildDocumentListEmbed(details.session, docs)],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'search': {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const query = interaction.options.getString('query', true);
          await this.ensureWorldRagReady(details.session);
          const context = await buildRagQuestionContext({
            rag: this.rag,
            embeddings: this.embeddings,
            sessionId: details.session.id,
            question: query,
            extraScopeIds: this.getWorldScopeIds(details.session),
          });
          await interaction.editReply({
            embeds: [buildLoreSearchEmbed(details.session, query, context)],
          });
          return;
        }
        default:
          await interaction.reply({ content: 'Unknown lore command.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleVoteCommand(interaction: ChatInputCommandInteraction): Promise<void> {

    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const player = interaction.options.getUser('player', true);
      const reason = interaction.options.getString('reason');

      const vote = this.manager.createSkipTurnVote({
        sessionId: details.session.id,
        initiatorUserId: interaction.user.id,
        targetUserId: player.id,
        reason,
      });

      const message = await interaction.reply({
        embeds: [buildVoteEmbed(details.session, details.players, vote)],
        components: [buildVoteButtons(vote)],
        fetchReply: true,
      });

      this.manager.attachVoteMessage(vote.vote.id, interaction.channelId, message.id);
      this.scheduleVoteTimeout(vote.vote.id, vote.vote.expiresAt);
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleQuestComplete(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const title = interaction.options.getString('title', true);
      const xp = interaction.options.getInteger('xp', true);
      const notes = interaction.options.getString('notes');
      const result = this.manager.applyQuestCompletion(details.session.id, interaction.user.id, title, xp, notes);
      await this.syncRagForSession(result.summary.session.id);
      await interaction.reply({
        embeds: [buildProgressEventEmbed(result.summary.session, result.event, result.summary.players)],
      });
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleQuestLog(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const logEntries = this.manager.getProgressLog(details.session.id);
      await interaction.reply({
        embeds: [buildProgressLogEmbed(details.session, logEntries)],
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleCombatCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);

    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);

      switch (subcommand) {
        case 'enter': {
          const result = this.manager.enterCombat(
            details.session.id,
            interaction.user.id,
            interaction.options.getString('enemies'),
          );
          await this.syncRagForSession(result.summary.session.id);
          const message = await interaction.reply({
            embeds: [buildCombatEmbed(result.summary.session, result.summary.players, result.combat, 'Combat started.', 'Use `/turn action: ...` to attack, use skills, or consume items.')],
            components: buildCombatActionRows(result.summary.session.id),
            fetchReply: true,
          });
          this.manager.recordCombatActionMessage(result.summary.session.id, interaction.channelId, message.id);
          return;
        }
        case 'status': {
          const combat = this.manager.getCombatState(details.session.id);
          if (!combat) {
            throw new Error('Combat is not active in this session.');
          }
          await interaction.reply({
            embeds: [buildCombatEmbed(details.session, details.players, combat, 'Order view requested.', 'Current combat order.')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        case 'menu': {
          const combat = this.manager.getCombatState(details.session.id);
          if (!combat) {
            throw new Error('Combat is not active in this session.');
          }
          const message = await interaction.reply({
            content: `Active turn menu for **${combat.order[combat.turnIndex]?.characterName ?? 'Unknown'}**. Main actions should go through \`/turn\`.`,
            components: buildCombatActionRows(details.session.id),
            fetchReply: true,
          });
          this.manager.recordCombatActionMessage(details.session.id, interaction.channelId, message.id);
          return;
        }
        case 'end': {
          const xp = interaction.options.getInteger('xp') ?? 0;
          const summary = interaction.options.getString('summary') ?? 'Combat resolved';
          const notes = interaction.options.getString('notes');
          const result = this.manager.endCombat(details.session.id, interaction.user.id, xp, summary, notes);
          const resumed = this.manager.restoreNarrativeTurnAfterCombat(details.session.id, interaction.user.id, details.session.activePlayerUserId);
          await this.syncRagForSession(result.summary.session.id);
          await interaction.reply({
            embeds: [
              buildCombatEndEmbed(resumed.session, resumed.players, result.event, summary),
            ],
          });
          return;
        }
        default:
          await interaction.reply({ content: 'Unknown combat command.', flags: MessageFlags.Ephemeral });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleEndTurn(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const details = this.requireCurrentSession(interaction);
      this.assertPlayer(details, interaction.user.id);
      const currentCombat = this.manager.getCombatState(details.session.id);

      if (currentCombat?.active) {
        const next = await this.manager.advanceCombatTurn(details.session.id, interaction.user.id, this.engine);
        await this.syncRagForSession(next.summary.session.id);
        const mechanics = next.messages.join('\n') || `Turn advanced to ${activePlayerLabel(next.summary)}.`;
        const actions = next.roundNarrative.join('\n');
        const message = await interaction.reply({
          embeds: [buildCombatEmbed(next.summary.session, next.summary.players, next.combat, mechanics, actions)],
          components: next.combat.active ? buildCombatActionRows(next.summary.session.id) : [],
          fetchReply: true,
        });

        if (next.combat.active) {
          this.manager.recordCombatActionMessage(next.summary.session.id, interaction.channelId, message.id);
        } else {
          await this.postCombatResolution(
            interaction.channelId,
            next.summary.session.id,
            next.combat,
            next.messages,
            payload => interaction.followUp(payload as any),
          );
        }
        return;
      }

      const updated = await this.manager.advanceTurn(details.session.id, interaction.user.id, this.engine);
      await this.syncRagForSession(updated.session.id);
      const combat = parseCombatState(updated.session.combatStateJson);

      if (combat?.active) {
        const message = await interaction.reply({
          embeds: [buildCombatEmbed(updated.session, updated.players, combat, 'Session turn advanced.', `Turn advanced to ${activePlayerLabel(updated)}.`)],
          components: buildCombatActionRows(updated.session.id),
          fetchReply: true,
        });
        this.manager.recordCombatActionMessage(updated.session.id, interaction.channelId, message.id);
      } else {
        const nextActivePlayer = updated.players.find(player => player.userId === updated.session.activePlayerUserId) ?? null;
        const waitingMessage = await interaction.reply({
          embeds: [buildGenerationStatusEmbed(updated, 'turn', nextActivePlayer)],
          fetchReply: true,
        });
        const nextPrompt = await this.buildNarrativeTurnPrompt(updated.session.id, interaction.channelId);
        const trackerEmbed = this.buildTurnTrackerEmbed(interaction.channelId);
        const promptMessage = await interaction.editReply({
          embeds: [nextPrompt.embed, ...(trackerEmbed ? [trackerEmbed] : [])],
          components: nextPrompt.components,
        });
        await this.recordCanonicalSceneState({
          threadId: interaction.channelId,
          sessionId: updated.session.id,
          source: 'turnprompt',
          title: nextPrompt.embed.data.title ?? null,
          content: nextPrompt.content,
          messageId: (promptMessage as any)?.id ?? (waitingMessage as any)?.id ?? null,
        });
      }
    } catch (error: any) {
      await replyError(interaction, error.message);
    }
  }

  private async handleVoteButton(interaction: ButtonInteraction): Promise<void> {
    const [, , voteId, optionId] = interaction.customId.split('_');
    if (!voteId || !optionId) {
      await interaction.reply({ content: 'That vote button is invalid.', flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const result = await this.manager.castVote(voteId, interaction.user.id, optionId, this.engine);
      const details = this.manager.getSessionById(result.vote.vote.sessionId);
      if (!details) {
        throw new Error('Session not found after vote.');
      }

      await interaction.reply({
        content: `Vote recorded: **${labelForOption(result.vote, optionId)}**.`,
        flags: MessageFlags.Ephemeral,
      });

      await this.refreshVoteMessage(details, result.vote, result.resolved);
      if (result.resolved) {
        this.clearVoteTimer(voteId);
      }
    } catch (error: any) {
      await interaction.reply({
        content: `Could not record vote: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async handleCombatButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.split('_');
    const sessionId = parts[2];
    const action = parts[3];
    if (!sessionId || !action) {
      await interaction.reply({ content: 'That combat control is invalid.', flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      const details = this.manager.getSessionById(sessionId);
      if (!details) {
        throw new Error('Combat session no longer exists.');
      }
      this.assertPlayer(details, interaction.user.id);
      const combat = this.manager.getCombatState(sessionId);
      if (!combat?.active) {
        throw new Error('Combat is no longer active.');
      }

      if (action === 'endturn') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const next = await this.manager.advanceCombatTurn(sessionId, interaction.user.id, this.engine);
        await this.syncRagForSession(next.summary.session.id);
        await interaction.editReply({
          content: 'Round force-resolved by host.',
        });

        const channel = interaction.channel;
        if (channel?.isSendable()) {
          const mechanics = next.messages.join('\n') || 'Round resolved.';
          const actions = next.roundNarrative.join('\n');
          await channel.send({
            embeds: [buildCombatEmbed(next.summary.session, next.summary.players, next.combat, mechanics, actions)],
            components: next.combat.active ? buildCombatActionRows(sessionId) : [],
          }).then((message: any) => {
            if (message?.id && next.combat.active) {
              this.manager.recordCombatActionMessage(sessionId, interaction.channelId, message.id);
            }
          }).catch(() => { });
          if (!next.combat.active) {
            await this.postCombatResolution(
              interaction.channelId,
              sessionId,
              next.combat,
              next.messages,
              payload => channel.send(payload as any),
            );
          }
        }
        return;
      }

      if (action === 'attack') {
        try {
          const pendingBefore = this.safeGetPendingCombatActions(sessionId);
          const actorName = details.players.find(player => player.userId === interaction.user.id)?.characterName ?? 'A party member';
          const actorIsFinalPending = Boolean(
            pendingBefore
            && pendingBefore.waitingOn.length === 1
            && pendingBefore.waitingOn[0] === actorName,
          );
          if (actorIsFinalPending) {
            await this.refreshPublicCombatStatusMessage(
              interaction.channel,
              sessionId,
              `${actorName} locked in a quick attack for this round.`,
              {
                headline: 'GM resolving the round',
                detail: 'All player actions are locked in. Enemy turns and narration are being resolved now.',
                readyStatus: `${pendingBefore!.submitted.length + 1} / ${pendingBefore!.submitted.length + 1} locked in`,
              },
            );
          }
          const result = await this.manager.submitCombatAction(sessionId, interaction.user.id, 'I attack the nearest enemy with my weapon', this.engine);
          await this.syncRagForSession(result.summary.session.id);

          if (result.status === 'waiting') {
            await this.refreshPublicCombatStatusMessage(
              interaction.channel,
              result.summary.session.id,
              `${actorName} locked in a quick attack for this round.`,
            );
            await interaction.reply({
              content: `Action recorded (Quick Attack). Waiting on: ${result.waitingOn.join(', ')}`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const mechanics = result.messages.join('\n') || 'Round resolved.';
          const actions = result.roundNarrative.join('\n');
          const message = await interaction.reply({
            embeds: [buildCombatEmbed(result.summary.session, result.summary.players, result.combat, mechanics, actions)],
            components: result.combat.active ? buildCombatActionRows(result.summary.session.id) : [],
            fetchReply: true,
          });
          if ((message as any)?.id && result.combat.active) {
            this.manager.recordCombatActionMessage(sessionId, interaction.channelId, (message as any).id);
          }
          if (!result.combat.active) {
            await this.postCombatResolution(
              interaction.channelId,
              sessionId,
              result.combat,
              result.messages,
              payload => interaction.followUp(payload as any),
            );
          }
          return;
        } catch (error: any) {
          if (shouldFallbackToNarrativeCombat(error.message)) {
            await interaction.reply({
              content: 'Your standard attack is not a clean mechanical fit here. Use `/turn action: ...` to improvise, bluff, flee, or attempt something messy and let the GM adjudicate it.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw error;
        }
      }

      await interaction.reply({
        content: `Use \`/turn action: ...\` for ${combatActionLabel(action).toLowerCase()} actions so LiteClaw can validate skills, weapons, and items properly.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: any) {
      await interaction.reply({
        content: `Could not use combat action: ${error.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  private async refreshPublicCombatStatusMessage(
    channel: any,
    sessionId: string,
    summaryText: string,
    statusOverride?: { headline: string; detail: string; readyStatus?: string } | null,
  ): Promise<void> {
    if (!channel?.isSendable?.()) {
      return;
    }

    const details = this.manager.getSessionById(sessionId);
    const combat = this.manager.getCombatState(sessionId);
    if (!details || !combat?.active) {
      return;
    }

    const pending = this.safeGetPendingCombatActions(sessionId);
    const pendingLine = pending
      ? pending.waitingOn.length > 0
        ? `Waiting on: ${pending.waitingOn.join(', ')}.`
        : pending.submitted.length > 0
          ? 'All player actions are locked in. The GM is resolving the round.'
          : 'Round open. Everyone can lock in an action.'
      : 'Combat status updated.';

    const payload = {
      embeds: [
        buildCombatEmbed(
          details.session,
          details.players,
          combat,
          summaryText,
          pendingLine,
          statusOverride,
        ),
      ],
      components: buildCombatActionRows(sessionId),
    };

    const lastMessageId = combat.lastActionMessageId;
    if (lastMessageId && channel.messages?.fetch) {
      try {
        const message = await channel.messages.fetch(lastMessageId);
        await message.edit(payload);
        return;
      } catch {
        // Fall through and post a fresh status message.
      }
    }

    try {
      const sent = await channel.send(payload as any);
      if (sent?.id) {
        this.manager.recordCombatActionMessage(sessionId, channel.id, sent.id);
      }
    } catch {
      // Ignore channel send failures during combat status refresh.
    }
  }

  private safeGetPendingCombatActions(sessionId: string): { submitted: string[]; waitingOn: string[] } | null {
    try {
      const pending = this.manager.getPendingCombatActions(sessionId);
      return {
        submitted: pending.submitted,
        waitingOn: pending.waitingOn,
      };
    } catch {
      return null;
    }
  }

  private async handleActionChoiceButton(interaction: ButtonInteraction): Promise<string | boolean> {
    const withoutPrefix = interaction.customId.slice(DND_ACTION_PREFIX.length);
    const firstUnderscore = withoutPrefix.indexOf('_');
    if (firstUnderscore === -1) {
      await interaction.reply({ content: 'That action button is invalid.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const sessionId = withoutPrefix.slice(0, firstUnderscore);
    const rest = withoutPrefix.slice(firstUnderscore + 1);
    const lastUnderscore = rest.lastIndexOf('_');
    if (lastUnderscore === -1) {
      await interaction.reply({ content: 'That action button is invalid.', flags: MessageFlags.Ephemeral });
      return true;
    }
    const activeUserId = rest.slice(0, lastUnderscore);
    const label = (interaction.component as any)?.label ?? '';

    const combat = this.manager.getCombatState(sessionId);
    if (!combat?.active && interaction.user.id !== activeUserId) {
      const details = this.manager.getSessionById(sessionId);
      const activeName = details?.players.find(p => p.userId === activeUserId)?.characterName ?? 'another player';
      await interaction.reply({
        content: `It is currently **${activeName}**'s turn.`,
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.deferUpdate();

    try {
      await interaction.editReply({ components: [] });
    } catch { /* ignore if message is gone */ }

    return label;
  }

  private async handleRegenerateButton(interaction: ButtonInteraction): Promise<void> {
    const parts = interaction.customId.replace(DND_REGEN_PREFIX, '').split('_');
    const [sessionId, kind] = parts;
    if (!sessionId || !kind) {
      await interaction.reply({ content: 'That regenerate button is invalid.', flags: MessageFlags.Ephemeral });
      return;
    }

    const details = this.manager.getSessionById(sessionId);
    if (!details) {
      await interaction.reply({ content: 'This session no longer exists.', flags: MessageFlags.Ephemeral });
      return;
    }

    this.assertPlayer(details, interaction.user.id);
    await interaction.deferUpdate();

    if (kind === 'opening') {
      const openingPlayer = activePlayerRecord(details);
      await interaction.message.edit({
        embeds: [buildGenerationStatusEmbed(details, 'regenerate', openingPlayer)],
        components: [],
      });
      await this.postOpeningScene(details.session.id, interaction.channelId, interaction.message);
      return;
    }

    if (kind === 'turnprompt') {
      const spotlight = activePlayerRecord(details);
      await interaction.message.edit({
        embeds: [buildGenerationStatusEmbed(details, 'regenerate', spotlight)],
        components: [],
      });
      const nextPrompt = await this.buildNarrativeTurnPrompt(details.session.id, interaction.channelId);
      const trackerEmbed = this.buildTurnTrackerEmbed(interaction.channelId);
      await interaction.message.edit({
        embeds: [nextPrompt.embed, ...(trackerEmbed ? [trackerEmbed] : [])],
        components: nextPrompt.components,
      });
      await this.recordCanonicalSceneState({
        threadId: interaction.channelId,
        sessionId: details.session.id,
        source: 'regenerate',
        title: nextPrompt.embed.data.title ?? null,
        content: nextPrompt.content,
        messageId: interaction.message.id,
      });
      return;
    }

    await interaction.followUp({ content: 'Unknown regenerate target.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
  }

  private async handleStart(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId || !interaction.channel) {
      throw new Error('DnD sessions can only be started inside a guild text channel.');
    }

    await interaction.deferReply();

    // Ensure servers are ready
    try {
      await ensureServersReady(this.embeddings, this.llm, async (msg) => {
        await interaction.editReply({ content: msg });
      });
    } catch (err: any) {
      await interaction.editReply({ content: `❌ Server initialization failed: ${err.message}` });
      return;
    }

    const title = interaction.options.getString('title', true);
    const tone = interaction.options.getString('tone');
    const maxPlayers = interaction.options.getInteger('max_players') ?? 6;
    const worldId = interaction.options.getString('world_id');
    const requestedWorldSource = interaction.options.getString('world_source') as 'random' | 'preconfigured' | null;
    const worldSource: 'random' | 'preconfigured' = requestedWorldSource === 'preconfigured' || !!worldId
      ? 'preconfigured'
      : 'random';
    const preconfiguredWorld = worldSource === 'preconfigured'
      ? getPreconfiguredWorld(worldId ?? DEFAULT_PRECONFIGURED_WORLD_ID)
      : null;
    if (worldSource === 'preconfigured' && !preconfiguredWorld) {
      throw new Error('That preconfigured world is not available.');
    }
    const thread = await ensureSessionThread(interaction);

    const summary = this.manager.createSession({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      threadId: thread.id,
      title,
      tone,
      maxPlayers,
      worldKey: preconfiguredWorld?.id ?? null,
      host: actorFromInteraction(interaction),
    });
    await this.syncRagForSession(summary.session.id);

    // Initialize lobby state
    this.lobbies.set(summary.session.id, {
      readyPlayers: new Set(),
      worldGenPromise: null,
      readyStatusNotifiers: new Map(),
      worldLore: null,
      worldGenError: null,
      worldSource,
      worldLabel: preconfiguredWorld?.name ?? 'Random World',
      worldStatusText: preconfiguredWorld ? `Provisioning shared lorebook: ${preconfiguredWorld.name}` : 'Generating a fresh world dossier...',
      lobbyMessageId: null,
      lobbyChannelId: null,
      countdownTimer: null,
      countdownSeconds: null,
      startupStatusText: null,
      midSessionJoiners: new Set(),
      weavingJoiners: new Set(),
      provisioningPromise: null,
    });

    if (preconfiguredWorld) {
      this.provisionPreconfiguredWorldBackground(summary.session.id, preconfiguredWorld.id);
    } else {
      this.generateWorldBackground(summary.session.id, title, tone);
    }

    const lobbyMessage = await thread.send({
      content: `DnD session **${summary.session.id}** is live in this thread. Players can join with \`/dnd join\`.`,
      embeds: [buildSessionEmbed(summary, 'Lobby opened. Waiting for players to ready up...')],
      components: [buildLobbyButtons(summary.session.id)],
    });

    await interaction.editReply({
      content: `DnD session **${summary.session.id}** created in ${thread}. All game flow now continues inside the thread.`,
      embeds: [],
      components: [],
    });

    const lobby = this.lobbies.get(summary.session.id);
    if (lobby) {
      lobby.lobbyMessageId = lobbyMessage.id;
      lobby.lobbyChannelId = lobbyMessage.channelId;
    }
  }

  private async generateWorldBackground(sessionId: string, title: string, tone: string | null): Promise<void> {
    const lobby = this.lobbies.get(sessionId);
    if (!lobby) return;

    lobby.worldGenPromise = (async () => {
      try {
        lobby.worldStatusText = 'Generating a fresh world dossier...';
        log.info({ sessionId }, 'Generating DnD world lore...');
        const llmModel =
          getConfig().llm?.providers?.local?.models?.[0]?.id
          ?? process.env.LLM_MODEL
          ?? 'gemma-4-e4b-heretic';
        const prompt = [
          `You are preparing a D&D session package for an adventure titled "${title}".`,
          tone ? `Tone: ${tone}.` : 'Tone: adventurous fantasy.',
          'Invent a specific place, local culture, current tension, landmarks, factions, and a recent incident that makes the world feel lived in.',
          'Do not treat the adventure title as the town name unless it naturally fits. Invent proper nouns for the settlement, district, region, NPCs, and local landmarks.',
          'Return exactly one tagged section and nothing else:',
          '<world_lore> ... </world_lore>',
          'Inside <world_lore>, write a detailed GM-facing lore dossier in rich prose and compact reference paragraphs.',
          'Include: where the party is, what kind of place it is, what people here fear or want, important nearby landmarks, active factions, notable NPCs, rumors, and the immediate situation brewing beneath the surface.',
          'Make <world_lore> detailed enough that a GM can answer follow-up questions about the town, surroundings, and tensions without making things up from nothing.',
          'Keep <world_lore> around 700-1100 words.',
          'This lore is for the GM only. Do NOT include an opening scene or player-facing content.',
        ].join('\n');

        const rawText = await this.generateGMNarrative('', prompt);
        const worldLoreMatch = rawText.match(/<world_lore>([\s\S]*?)<\/world_lore>/i);
        const loreText = (worldLoreMatch?.[1] ?? '').replace(/\r/g, '').trim() || buildFallbackWorldLore(title, tone);

        lobby.worldLore = loreText;
        lobby.worldStatusText = 'Random world ready';
        this.manager.updateWorldInfo(sessionId, loreText);
        log.info({ sessionId }, 'World lore generated and stored.');

        await this.refreshLobby(sessionId);
        await this.updateReadyStatusNotices(sessionId);
        this.checkLobbyReadiness(sessionId);
      } catch (err: any) {
        log.error({ sessionId, error: err.message }, 'World generation failed');
        lobby.worldGenError = err.message;
        lobby.worldLore = buildFallbackWorldLore(title, tone);
        lobby.worldStatusText = 'Random world fallback loaded';
        this.manager.updateWorldInfo(sessionId, lobby.worldLore);
        await this.refreshLobby(sessionId);
        await this.updateReadyStatusNotices(sessionId);
        this.checkLobbyReadiness(sessionId);
      }
    })();
  }

  private async provisionPreconfiguredWorldBackground(sessionId: string, worldId: string): Promise<void> {
    const lobby = this.lobbies.get(sessionId);
    const details = this.manager.getSessionById(sessionId);
    if (!lobby || !details) return;

    lobby.worldGenPromise = (async () => {
      try {
        const world = getPreconfiguredWorld(worldId);
        if (!world) {
          throw new Error(`Unknown preconfigured world: ${worldId}`);
        }

        lobby.worldStatusText = `Loading shared lorebook: ${world.name}`;
        const loreText = readPreconfiguredWorldLore(world);
        this.manager.updateWorldInfo(sessionId, buildPreconfiguredWorldSummary(world.name, world.tagline, world.description, loreText));
        await this.ensureWorldRagReady(this.manager.getSessionById(sessionId)?.session ?? details.session);

        lobby.worldLore = loreText;
        lobby.worldStatusText = `Shared lorebook ready: ${world.name}`;
        await this.refreshLobby(sessionId);
        await this.updateReadyStatusNotices(sessionId);
        this.checkLobbyReadiness(sessionId);
      } catch (err: any) {
        log.error({ sessionId, worldId, error: err.message }, 'Preconfigured world provisioning failed');
        lobby.worldGenError = err.message;
        lobby.worldStatusText = `Preconfigured world failed: ${err.message}`;
        await this.refreshLobby(sessionId);
        await this.updateReadyStatusNotices(sessionId);
      }
    })();
  }

  private async handleJoin(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionId = interaction.options.getString('session_id')
      ?? this.manager.getSessionForThread(interaction.channelId)?.session.id
      ?? null;
    if (!sessionId) {
      throw new Error('Use this inside a session thread or provide a `session_id`.');
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const before = this.manager.getSessionById(sessionId);
    const summary = this.manager.joinSession({
      sessionId,
      user: actorFromInteraction(interaction),
      characterName: interaction.options.getString('character_name', true),
      className: interaction.options.getString('class'),
      race: interaction.options.getString('race'),
    });
    await this.syncRagForSession(summary.session.id);

    const lobby = this.lobbies.get(sessionId);
    if (lobby) {
      await this.refreshLobby(summary.session.id);
      if (before?.session.phase === 'active' && !before.players.some(p => p.userId === interaction.user.id)) {
        lobby.midSessionJoiners.add(interaction.user.id);
      }
    }

    const joinedMidSession = before?.session.phase === 'active'
      && !before.players.some(player => player.userId === interaction.user.id);

    if (lobby && joinedMidSession) {
      lobby.midSessionJoiners.add(interaction.user.id);
    }

    const joinNotice = joinedMidSession
      ? `You joined **${summary.session.title}** midway as **${characterFor(summary.players, interaction.user.id)}**. Once you "Ready Up" in your character setup, the GM will weave you into the current scene. Please wait a moment after readying while that handoff is generated.\n\nTip: ${pickLoadingTip(summary.session.id, interaction.user.id, 'weave')}`
      : `Welcome to **${summary.session.title}**. We'll walk through your character setup one step at a time.`;

    await interaction.editReply({
      content: joinNotice,
      embeds: [buildOnboardingEmbed(summary, interaction.user.id)],
      components: buildOnboardingComponents(summary, interaction.user.id),
    });
  }

  private async handleBegin(interaction: ChatInputCommandInteraction): Promise<void> {
    const details = this.requireCurrentSession(interaction);
    const summary = this.manager.beginSession(details.session.id, interaction.user.id);
    await this.syncRagForSession(summary.session.id);
    await interaction.reply({
      embeds: [buildSessionEmbed(summary, `Adventure begun. ${activePlayerLabel(summary)} has the first turn.`)],
    });
  }

  private async handleSave(interaction: ChatInputCommandInteraction): Promise<void> {
    const details = this.requireCurrentSession(interaction);
    const note = interaction.options.getString('note');
    const saved = this.manager.saveSession(details.session.id, interaction.user.id, note);
    await this.syncRagForSession(saved.summary.session.id);
    await interaction.reply({
      embeds: [buildSessionEmbed(saved.summary, `Checkpoint saved as **${saved.checkpointId}**. Session paused.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionId = interaction.options.getString('session_id', true);
    const partialParty = interaction.options.getBoolean('partial_party') ?? true;
    const thread = await ensureSessionThread(interaction);
    const summary = this.manager.resumeSession({
      sessionId,
      actorUserId: interaction.user.id,
      channelId: interaction.channelId,
      threadId: thread.id,
      partialParty,
    });
    await this.syncRagForSession(summary.session.id);

    await interaction.reply({
      content: partialParty
        ? 'Session resumed in partial-party mode. Returning players can use `/dnd join` or `/dnd available` when they are back.'
        : 'Session resumed.',
      embeds: [buildSessionEmbed(summary, buildResumeNotice(summary, partialParty))],
    });
  }

  private async handleRestore(interaction: ChatInputCommandInteraction): Promise<void> {
    const checkpointId = interaction.options.getString('checkpoint_id', true);
    const partialParty = interaction.options.getBoolean('partial_party') ?? true;
    const thread = await ensureSessionThread(interaction);
    const summary = this.manager.restoreCheckpoint({
      checkpointId,
      actorUserId: interaction.user.id,
      channelId: interaction.channelId,
      threadId: thread.id,
      partialParty,
    });
    await this.syncRagForSession(summary.session.id);

    await interaction.reply({
      content: `Checkpoint **${checkpointId}** restored.`,
      embeds: [buildSessionEmbed(summary, buildResumeNotice(summary, partialParty))],
    });
  }

  private async handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
    const details = this.requireCurrentSession(interaction);
    await interaction.reply({
      embeds: [buildSessionEmbed(details, 'Current session snapshot.')],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleList(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      throw new Error('Session listing is only available in guilds.');
    }

    const sessions = this.manager.listSessionsForGuild(interaction.guildId);
    await interaction.reply({
      embeds: [buildSessionListEmbed(sessions)],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleCheckpoints(interaction: ChatInputCommandInteraction): Promise<void> {
    const sessionId = interaction.options.getString('session_id')
      ?? this.manager.getSessionForThread(interaction.channelId)?.session.id
      ?? null;
    if (!sessionId) {
      throw new Error('Use this in a session thread or provide a `session_id`.');
    }

    const details = this.manager.getSessionById(sessionId);
    if (!details) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const checkpoints = this.manager.listCheckpoints(sessionId);
    await interaction.reply({
      embeds: [buildCheckpointEmbed(details.session, checkpoints)],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleAvailability(interaction: ChatInputCommandInteraction, available: boolean): Promise<void> {
    const details = this.requireCurrentSession(interaction);
    const summary = await this.manager.setAvailability(details.session.id, interaction.user.id, available, this.engine);
    await interaction.reply({
      content: available
        ? 'You are back in the turn order.'
        : 'You are marked unavailable. The session will skip your turns until you return.',
      embeds: [buildSessionEmbed(summary, available ? `${interaction.user} is available again.` : `${interaction.user} is unavailable and will be skipped.`)],
      flags: MessageFlags.Ephemeral,
    });
  }

  private async handleEnd(interaction: ChatInputCommandInteraction): Promise<void> {
    const details = this.requireCurrentSession(interaction);
    const summary = this.manager.endSession(details.session.id, interaction.user.id);
    await interaction.reply({
      embeds: [buildSessionEmbed(summary, 'Session completed and closed.')],
    });
  }

  private requireCurrentSession(interaction: ChatInputCommandInteraction): DndSessionDetails {
    const sessionId = interaction.options.getString('session_id') ?? undefined;
    if (sessionId) {
      const details = this.manager.getSessionById(sessionId);
      if (!details) throw new Error(`Session not found: ${sessionId}`);
      return details;
    }

    const details = this.manager.getSessionForThread(interaction.channelId);
    if (!details) {
      throw new Error('No DnD session is attached to this thread.');
    }
    return details;
  }

  private assertDndCommandAccess(interaction: ChatInputCommandInteraction, subcommand: string): void {
    const details = this.manager.getSessionForThread(interaction.channelId);
    if (!details) return;
    if (subcommand === 'join') return;
    this.assertPlayer(details, interaction.user.id);
  }

  private assertPlayer(details: DndSessionDetails, userId: string): void {
    const player = details.players.find(entry => entry.userId === userId && entry.status !== 'left');
    if (!player) {
      throw new Error('Only active session players can use commands in this DnD thread.');
    }
  }

  private scheduleVoteTimeout(voteId: string, expiresAt: number): void {
    this.clearVoteTimer(voteId);
    const delay = Math.max(0, expiresAt - Date.now());
    const timer = setTimeout(async () => {
      try {
        const resolution = await this.manager.resolveExpiredVote(voteId, this.engine);
        if (!resolution) return;
        const details = this.manager.getSessionById(resolution.session.id);
        if (details) {
          await this.refreshVoteMessage(details, resolution.vote, resolution);
        }
      } catch (error: any) {
        log.warn({ voteId, error: error.message }, 'Failed to resolve timed-out vote');
      } finally {
        this.clearVoteTimer(voteId);
      }
    }, delay);

    this.voteTimers.set(voteId, timer);
  }

  private clearVoteTimer(voteId: string): void {
    const timer = this.voteTimers.get(voteId);
    if (timer) {
      clearTimeout(timer);
      this.voteTimers.delete(voteId);
    }
  }

  private async refreshVoteMessage(details: DndSessionDetails, vote: DndVoteDetails, resolution: VoteResolution | null): Promise<void> {
    if (!vote.vote.messageChannelId || !vote.vote.messageId) return;
    const channel = await this.client.channels.fetch(vote.vote.messageChannelId);
    if (!channel?.isTextBased()) return;

    const message = await channel.messages.fetch(vote.vote.messageId).catch(() => null);
    if (!message) return;

    const resolvedVote = this.manager.getVote(vote.vote.id) ?? vote;
    await message.edit({
      embeds: [buildVoteEmbed(details.session, details.players, resolvedVote, resolution)],
      components: resolvedVote.vote.status === 'open' ? [buildVoteButtons(resolvedVote)] : [],
    });
  }

  private async flushExpiredVotes(): Promise<void> {
    for (const vote of this.manager.listOpenVotes()) {
      if (vote.expiresAt > Date.now()) continue;
      const resolution = await this.manager.resolveExpiredVote(vote.id, this.engine);
      if (!resolution) continue;
      const details = this.manager.getSessionById(resolution.session.id);
      if (details) {
        await this.refreshVoteMessage(details, resolution.vote, resolution);
      }
    }
  }

  private buildReadyStatusMessage(sessionId: string, userId?: string): string {
    const lobby = this.lobbies.get(sessionId);
    const details = this.manager.getSessionById(sessionId);
    if (!lobby || !details) {
      return 'You are ready!';
    }

    const playerCount = details.players.length;
    const readyCount = lobby.readyPlayers.size;
    const isReady = userId ? lobby.readyPlayers.has(userId) : false;
    const isMidJoiner = userId ? lobby.midSessionJoiners.has(userId) : false;
    const isWeavingIn = userId ? lobby.weavingJoiners.has(userId) : false;
    const lead = isReady
      ? `You are ready! ${readyCount}/${playerCount} players.`
      : `Ready check: ${readyCount}/${playerCount} players.`;

    if (lobby.startupStatusText) {
      return `${lead}
${lobby.startupStatusText}

Tip: ${pickLoadingTip(sessionId, userId ?? 'party', 'startup')}`;
    }

    if (details.session.phase !== 'lobby') {
      if (isMidJoiner || isWeavingIn) {
        return `${lead}
Please wait while the GM weaves you into the current scene.

Tip: ${pickLoadingTip(sessionId, userId ?? 'party', 'weave')}`;
      }
      return `${lead}
The session is already moving. Please wait while the GM resolves the current beat and hands the spotlight around.

Tip: ${pickLoadingTip(sessionId, userId ?? 'party', 'startup')}`;
    }

    if (lobby.countdownSeconds !== null) {
      return `${lead}
Game starting in ${lobby.countdownSeconds}s...

Tip: ${pickLoadingTip(sessionId, userId ?? 'party', 'startup')}`;
    }

    if (lobby.worldLore) {
      return readyCount === playerCount
        ? `${lead}
All players are ready. Countdown is about to begin...

Tip: ${pickLoadingTip(sessionId, userId ?? 'party', 'startup')}`
        : `${lead}
World is ready. Waiting for the rest of the party.

Tip: ${pickLoadingTip(sessionId, userId ?? 'party', 'startup')}`;
    }

    const worldStatus = lobby.worldGenError
      ? `World setup hit a snag, but a fallback is loading: ${lobby.worldStatusText}`
      : `World setup is still running: ${lobby.worldStatusText}`;
    return `${lead}
${worldStatus}`;
  }

  private async updateReadyStatusNotices(sessionId: string): Promise<void> {
    const lobby = this.lobbies.get(sessionId);
    if (!lobby) return;

    const updates = Array.from(lobby.readyStatusNotifiers.entries()).map(async ([userId, notify]) => {
      try {
        await notify(this.buildReadyStatusMessage(sessionId, userId));
      } catch {
        lobby.readyStatusNotifiers.delete(userId);
      }
    });

    await Promise.allSettled(updates);
  }

  private async refreshLobby(sessionId: string): Promise<void> {
    const lobby = this.lobbies.get(sessionId);
    const details = this.manager.getSessionById(sessionId);
    if (!lobby || !details) return;

    if (!lobby.lobbyChannelId || !lobby.lobbyMessageId) return;

    try {
      const channel = await this.client.channels.fetch(lobby.lobbyChannelId);
      if (!channel?.isTextBased()) return;

      const message = await channel.messages.fetch(lobby.lobbyMessageId).catch(() => null);
      if (!message) return;

      const description = details.session.phase === 'lobby'
        ? 'Lobby in progress. Ready up to start.'
        : (lobby.startupStatusText ?? 'Session is now active. The GM is preparing the next beat.');

      await message.edit({
        embeds: [buildSessionEmbed(details, description, lobby)],
        components: details.session.phase === 'lobby' && !lobby.countdownTimer ? [buildLobbyButtons(sessionId)] : [],
      });
    } catch (err: any) {
      log.error({ sessionId, error: err.message }, 'Failed to refresh lobby');
    }
  }



  private checkLobbyReadiness(sessionId: string): void {
    const lobby = this.lobbies.get(sessionId);
    const details = this.manager.getSessionById(sessionId);
    if (!lobby || !details) return;

    if (lobby.countdownTimer) return;

    const players = details.players;
    const allReady = players.every(p => lobby.readyPlayers.has(p.userId));
    const worldReady = !!lobby.worldLore;

    if (allReady && worldReady) {
      this.startCountdown(sessionId);
    }
  }

  private startCountdown(sessionId: string): void {
    const lobby = this.lobbies.get(sessionId);
    if (!lobby) return;

    lobby.provisioningPromise = this.prepareCombatLoadouts(sessionId);
    void this.syncRagForSession(sessionId).catch(() => undefined);

    let seconds = 10;
    lobby.countdownSeconds = seconds;

    const tick = async () => {
      if (seconds > 0) {
        lobby.countdownSeconds = seconds;
        await this.refreshLobby(sessionId);
        await this.updateReadyStatusNotices(sessionId);
        seconds--;
        lobby.countdownTimer = setTimeout(tick, 1000);
      } else {
        lobby.countdownTimer = null;
        lobby.countdownSeconds = null;
        lobby.startupStatusText = 'Please wait while the GM is generating the opening scene.';
        await this.updateReadyStatusNotices(sessionId);
        try {
          const details = this.manager.getSessionById(sessionId);
          if (!details) return;
          const provisioning = await (lobby.provisioningPromise ?? Promise.resolve([]));
          if (lobby.lobbyChannelId && provisioning.length > 0) {
            const provisioningChannel = await this.client.channels.fetch(lobby.lobbyChannelId).catch(() => null);
            if (provisioningChannel?.isTextBased()) {
              await (provisioningChannel as any).send({
                embeds: [
                  new EmbedBuilder()
                    .setTitle('Combat Kits Prepared')
                    .setColor(0x2e86ab)
                    .setDescription(provisioning.map(entry => entry.summary).join('\n').slice(0, 4096)),
                ],
              }).catch(() => null);
            }
          }
          const summary = this.manager.beginSession(sessionId, details.session.hostUserId);
          await this.syncRagForSession(sessionId);
          await this.refreshLobby(sessionId);

          // Generate and send opening scene via GM pipeline with RAG context
          if (lobby.lobbyChannelId) {
            await this.postOpeningScene(sessionId, lobby.lobbyChannelId);
            lobby.startupStatusText = null;
            await this.updateReadyStatusNotices(sessionId);
          }
        } catch (err: any) {
          lobby.startupStatusText = null;
          await this.updateReadyStatusNotices(sessionId);
          log.error({ sessionId, error: err.message }, 'Failed to start session after countdown');
        }
      }
    };

    tick();
  }

  private async prepareCombatLoadouts(sessionId: string): Promise<Array<{ userId: string; summary: string }>> {
    const details = this.manager.getSessionById(sessionId);
    if (!details) return [];

    const players = details.players.filter(player => player.status !== 'left');
    const generated = await Promise.allSettled(
      players.map(player => this.generateAndApplyLoadoutForPlayer(details, player)),
    );

    return generated.map((result, index) => {
      const player = players[index];
      if (result.status === 'fulfilled') {
        return result.value;
      }

      const fallback = this.manager.provisionCombatLoadouts(sessionId).find(entry => entry.userId === player.userId);
      return fallback ?? {
        userId: player.userId,
        summary: `${player.characterName}: loadout generation failed and fallback could not be applied.`,
      };
    });
  }

  private async ensurePlayerCombatLoadout(details: DndSessionDetails, player: DndPlayerRecord): Promise<{ userId: string; summary: string }> {
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const inventory = this.manager.getInventory(details.session.id, player.userId);
    if (hasUsableCombatLoadout(sheet, inventory)) {
      return {
        userId: player.userId,
        summary: `${player.characterName}: ${summarizeLoadout(sheet, inventory)}`,
      };
    }

    try {
      return await this.generateAndApplyLoadoutForPlayer(details, player);
    } catch (error: any) {
      log.warn({ sessionId: details.session.id, userId: player.userId, error: error.message }, 'Dedicated loadout generation failed for player');
      const fallback = this.manager.provisionCombatLoadouts(details.session.id).find(entry => entry.userId === player.userId);
      return fallback ?? {
        userId: player.userId,
        summary: `${player.characterName}: loadout generation failed and fallback could not be applied.`,
      };
    }
  }

  private estimateCombatXp(combat: DndCombatState): number {
    const base = combat.enemies.reduce((sum, enemy) => sum + enemy.maxHp + enemy.ac + enemy.attackBonus * 2, 0);
    return Math.max(25, Math.round(base * 5));
  }

  private async resolveCombatAftermath(
    sessionId: string,
    channelId: string,
    combat: DndCombatState,
    messageSummary: string[],
  ): Promise<{ combatEnd: EmbedBuilder; aftermath?: { embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[] } }> {
    const details = this.manager.getSessionById(sessionId);
    if (!details) {
      throw new Error('Session not found after combat resolution.');
    }

    const activePlayers = details.players.filter(player => player.status !== 'left');
    const downedPlayers = activePlayers.filter(player => parseCharacterSheet(player.characterSheetJson).hp <= 0);
    const playersWon = combat.victory === 'players';
    const xpAward = playersWon ? this.estimateCombatXp(combat) : 0;
    if (!playersWon) {
      for (const player of activePlayers) {
        this.manager.confiscateInventory(
          sessionId,
          details.session.hostUserId,
          player.userId,
          'watchtower evidence locker',
          'Confiscated after capture',
        );
      }
    }
    const summary = playersWon
      ? `The party wins the fight. ${xpAward} XP has been awarded automatically.`
      : downedPlayers.length === activePlayers.length
        ? 'The party has been overwhelmed. The story will continue with consequences instead of a hard stop.'
        : 'The fight ends badly for the party, and the story will continue with consequences instead of a hard stop.';

    const ended = this.manager.endCombat(
      sessionId,
      details.session.hostUserId,
      xpAward,
      playersWon ? 'Combat victory' : 'Combat defeat',
      playersWon
        ? `Automatic reward after combat. ${messageSummary.join(' ').slice(0, 240)}`
        : `Automatic consequence after defeat. ${messageSummary.join(' ').slice(0, 240)}`,
    );
    const resumed = this.manager.restoreNarrativeTurnAfterCombat(
      sessionId,
      details.session.hostUserId,
      details.session.activePlayerUserId,
    );
    await this.syncRagForSession(sessionId);

    const combatEnd = buildCombatEndEmbed(
      resumed.session,
      resumed.players,
      ended.event,
      summary,
    );

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      return { combatEnd };
    }

    try {
      await this.ensureWorldRagReady(resumed.session);
      const ragContext = await buildRagQuestionContext({
        rag: this.rag,
        embeddings: this.embeddings,
        sessionId,
        question: playersWon ? 'combat aftermath victory' : 'combat aftermath defeat capture',
        extraScopeIds: this.getWorldScopeIds(resumed.session),
      });

      const prompt = this.buildTableTalkPrompt(
        channelId,
        resumed.session.hostUserId,
        playersWon
          ? '[SYSTEM: Combat has just ended with the party victorious. Weave the immediate aftermath back into the story. Mention visible consequences, any salvageable loot or advantage, and the next pressure or opportunity. End with a prompt for the active player to act.]'
          : '[SYSTEM: Combat has just ended with the party defeated or downed. Do not end the adventure. Weave the consequences back into the story in a survivable but costly way, such as capture, imprisonment, forced surrender, stripped gear, waking under guard, or being dragged somewhere dangerous. Prefer consequences over arbitrary death. End with a prompt for the active player or party to respond.]',
        ragContext,
      );

      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const gmPromptPath = resolve(process.cwd(), 'config/dnd_gm_prompt.md');
      let systemPrompt = '';
      try {
        systemPrompt = readFileSync(gmPromptPath, 'utf-8');
      } catch {
        // ignore missing prompt file
      }

      const processed = await this.generateValidatedNarrative(channelId, sessionId, systemPrompt, prompt);
      return {
        combatEnd,
        aftermath: {
          embed: new EmbedBuilder()
            .setTitle(playersWon ? 'Aftermath' : 'Aftermath - Trouble Ahead')
            .setColor(playersWon ? 0x27ae60 : 0xe67e22)
            .setDescription(processed.content.slice(0, 4096)),
          components: processed.combatComponents ?? processed.actionComponents ?? [],
        },
      };
    } catch (error: any) {
      log.warn({ sessionId, channelId, error: error.message }, 'Failed to generate combat aftermath narrative');
      return { combatEnd };
    }
  }

  private async postCombatResolution(
    channelId: string,
    sessionId: string,
    combat: DndCombatState,
    messages: string[],
    send: (payload: Record<string, any>) => Promise<any>,
  ): Promise<void> {
    if (combat.active) return;
    const aftermath = await this.resolveCombatAftermath(sessionId, channelId, combat, messages);
    await send({ embeds: [aftermath.combatEnd] });
    if (aftermath.aftermath) {
      await send({
        embeds: [aftermath.aftermath.embed],
        components: aftermath.aftermath.components,
      });
    }
  }

  private async buildNarrativeTurnPrompt(
    sessionId: string,
    channelId: string,
  ): Promise<{ embed: EmbedBuilder; components: ActionRowBuilder<ButtonBuilder>[]; content: string }> {
    const details = this.manager.getSessionById(sessionId);
    if (!details) {
      throw new Error('Session not found while building next-turn prompt.');
    }

    const activeUserId = details.session.activePlayerUserId;
    const activePlayer = activeUserId
      ? details.players.find(player => player.userId === activeUserId)
      : null;
    if (!activePlayer) {
      throw new Error('There is no active player to hand the scene to.');
    }

    try {
      await this.syncRagForSession(sessionId);
      await this.ensureWorldRagReady(details.session);
      const ragContext = await this.buildNarrativeRagContext(channelId, `next turn prompt for ${activePlayer.characterName}`);

      const prompt = this.buildTableTalkPrompt(
        channelId,
        activePlayer.userId,
        `[SYSTEM: The spotlight has just passed to ${activePlayer.characterName}. Briefly describe what they notice now, what immediate opportunity, pressure, or complication is in front of them, and tailor the framing to that character's position in the scene. Do not repeat the whole scene. Do not resolve an action. End with exactly three unique, scene-specific action choices for this player.]`,
        ragContext,
      );

      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const gmPromptPath = resolve(process.cwd(), 'config/dnd_gm_prompt.md');
      let systemPrompt = '';
      try {
        systemPrompt = readFileSync(gmPromptPath, 'utf-8');
      } catch {
        // fallback to empty system prompt
      }

      const processed = await this.generateValidatedNarrative(channelId, details.session.id, systemPrompt, prompt);
      const embed = new EmbedBuilder()
        .setTitle(`Your Turn - ${activePlayer.characterName}`)
        .setColor(0x8e44ad)
        .setDescription(processed.content.slice(0, 4096))
        .setFooter({ text: 'Only the active player can take the next spotlight action outside combat.' });
      applyPlayerPortrait(embed, activePlayer, `Spotlight: ${activePlayer.characterName}`);
      const actionRows = processed.actionComponents && processed.actionComponents.length > 0
        ? processed.actionComponents
        : buildActionChoiceRows(
          details.session.id,
          activePlayer.userId,
          buildSceneSpecificFallbackChoices(processed.content, null),
        );
      const components = [...actionRows, ...buildRegenerateRows(details.session.id, 'turnprompt')].slice(0, 5);
      return { embed, components, content: processed.content };
    } catch (error: any) {
      log.warn({ sessionId, channelId, error: error.message }, 'Failed to generate bespoke turn prompt');
      const fallbackContent = `${activePlayer.characterName}, the spotlight is on you. What do you do next?`;
      const embed = new EmbedBuilder()
        .setTitle(`Your Turn - ${activePlayer.characterName}`)
        .setColor(0x8e44ad)
        .setDescription(fallbackContent)
        .setFooter({ text: 'Only the active player can take the next spotlight action outside combat.' });
      applyPlayerPortrait(embed, activePlayer, `Spotlight: ${activePlayer.characterName}`);
      const components = [
        ...buildActionChoiceRows(
          details.session.id,
          activePlayer.userId,
          buildSceneSpecificFallbackChoices(embed.data.description ?? '', null),
        ),
        ...buildRegenerateRows(details.session.id, 'turnprompt'),
      ].slice(0, 5);
      return { embed, components, content: fallbackContent };
    }
  }

  private async generateAndApplyLoadoutForPlayer(details: DndSessionDetails, player: DndPlayerRecord): Promise<{ userId: string; summary: string }> {
    const defaultKit = getCombatKitForClass(player.className?.toLowerCase() ?? player.onboardingState?.selectedClassId ?? null);
    if (!defaultKit) {
      return { userId: player.userId, summary: `${player.characterName}: no class kit available.` };
    }

    const sheet = parseCharacterSheet(player.characterSheetJson);
    const generated = await this.generatePlayerLoadoutWithRetries(details.session, player, sheet, defaultKit);
    const applied = this.manager.applyCombatLoadout({
      sessionId: details.session.id,
      actorUserId: details.session.hostUserId,
      targetUserId: player.userId,
      skillIds: generated.skillIds,
      items: generated.items,
      equippedWeaponName: generated.equippedWeaponName,
    });

    return {
      userId: applied.userId,
      summary: `${applied.summary} (${generated.source})`,
    };
  }

  private async generatePlayerLoadoutWithRetries(
    session: DndSessionRecord,
    player: DndPlayerRecord,
    sheet: DndCharacterSheet,
    defaultKit: { skillIds: string[]; items: StarterItemTemplate[]; equippedWeaponName: string | null },
  ): Promise<{ skillIds: string[]; items: StarterItemTemplate[]; equippedWeaponName: string | null; source: string }> {
    const classId = player.className?.toLowerCase() ?? player.onboardingState?.selectedClassId ?? null;
    const allowedSkills = Object.values(SKILL_DEFINITIONS).filter(skill => skill.classIds.includes(classId ?? ''));
    const allowedWeapons = Object.values(WEAPON_DEFINITIONS).filter(weapon =>
      !weapon.requirement || sheet.abilities[weapon.requirement.ability] >= weapon.requirement.minimum);
    const shuffledSkills = shuffleArray(allowedSkills);
    const shuffledWeapons = shuffleArray(allowedWeapons);
    const shuffledConsumables = shuffleArray(Object.values(CONSUMABLE_DEFINITIONS));
    const safeFallback = buildCompatibleFallbackLoadout(
      allowedSkills.map(skill => skill.id),
      allowedWeapons.map(weapon => weapon.id),
      defaultKit,
    );
    const loadoutTheme = pickLoadoutTheme();
    const preferredSkillCount = pickPreferredSkillCount(allowedSkills.length);
    const consumableLimit = pickConsumableLimit();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.loadoutEngine.complete([
          {
            role: 'system',
            content: [
              'You are assigning a balanced starting combat loadout for a tabletop RPG character.',
              'Return JSON only.',
              'Use only the ids listed by the user.',
              'Vary loadouts across runs so two characters of the same class do not always receive the exact same kit.',
              'Keep it balanced: 1-3 skills, exactly 1 weapon, and 0-3 consumable entries.',
              'Never choose a weapon outside the allowedWeaponIds list.',
              'Do not always include every available skill or the default weapon unless that is clearly the best fit.',
              'Schema:',
              '{"skillIds":["id"],"weaponId":"id","consumables":[{"id":"health_potion","quantity":2}],"notes":"short reason"}',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({
              sessionTitle: session.title,
              tone: session.tone,
              player: {
                characterName: player.characterName,
                className: player.className,
                race: player.race,
                level: sheet.level,
                hp: sheet.hp,
                maxHp: sheet.maxHp,
                ac: sheet.ac,
                abilities: sheet.abilities,
              },
              desiredTheme: loadoutTheme,
              preferredSkillCount,
              preferredConsumableLimit: consumableLimit,
              allowedSkillIds: shuffledSkills.map(skill => ({
                id: skill.id,
                name: skill.name,
                kind: skill.kind,
                usesPerCombat: skill.usesPerCombat,
              })),
              allowedWeaponIds: shuffledWeapons.map(weapon => ({
                id: weapon.id,
                name: weapon.name,
                attackAbility: weapon.attackAbility,
                damageNotation: weapon.damageNotation,
              })),
              allowedConsumables: shuffledConsumables.map(item => ({
                id: item.id,
                name: item.name,
                effect: item.effect,
                target: item.target,
              })),
              safeFallbackIfGenerationFails: {
                skillIds: safeFallback.skillIds,
                equippedWeaponName: safeFallback.equippedWeaponName,
                items: safeFallback.items.map(item => ({ name: item.name, quantity: item.quantity })),
              },
            }),
          },
        ], { maxTokens: 500 });

        const parsed = parseJsonObject(response);
        const validated = validateGeneratedLoadout(
          parsed,
          allowedSkills.map(skill => skill.id),
          allowedWeapons.map(weapon => weapon.id),
          safeFallback,
        );
        return { ...validated, source: `AI generated on attempt ${attempt}` };
      } catch (error: any) {
        log.warn({ sessionId: session.id, userId: player.userId, attempt, error: error?.message ?? String(error) }, 'Loadout generation attempt failed');
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 250 * Math.pow(2, attempt - 1)));
        }
      }
    }

    return { ...safeFallback, source: 'deterministic fallback kit' };
  }

  private async syncRagForSession(sessionId: string): Promise<void> {
    const details = this.manager.getSessionById(sessionId);
    if (!details) return;
    const progress = this.manager.getProgressLog(sessionId);
    await syncSessionRag({
      rag: this.rag,
      embeddings: this.embeddings,
      session: details.session,
      players: details.players,
      progress,
    });
  }

  private getWorldScopeIds(session: DndSessionRecord): string[] {
    return session.worldKey ? [getPreconfiguredWorldScopeId(session.worldKey)] : [];
  }

  private async ensureWorldRagReady(session: DndSessionRecord): Promise<void> {
    if (!session.worldKey) return;

    const world = getPreconfiguredWorld(session.worldKey);
    if (!world) {
      throw new Error(`Configured world "${session.worldKey}" is not available.`);
    }

    await syncPreconfiguredWorldRag({
      rag: this.rag,
      embeddings: this.embeddings,
      worldId: world.id,
      worldName: world.name,
      loreText: readPreconfiguredWorldLore(world),
    });
  }

  private async buildRecentSceneSnapshot(channel: any): Promise<string> {
    try {
      const messages = await channel.messages.fetch({ limit: 12 });
      const ordered = Array.from(messages.values()).sort((a: any, b: any) => a.createdTimestamp - b.createdTimestamp);
      const lines = ordered
        .filter((message: any) => !message.author?.bot || message.author?.id === this.client.user?.id)
        .map((message: any) => {
          const content = String(message.content ?? '').trim();
          const embedText = Array.isArray(message.embeds)
            ? message.embeds
              .map((embed: any) => [embed.title, embed.description].filter(Boolean).join(': ').trim())
              .filter(Boolean)
              .join(' | ')
            : '';
          const combined = [content, embedText].filter(Boolean).join(' | ').replace(/\s+/g, ' ').trim();
          if (!combined) return null;
          if (/starter kit prepared|combat kits prepared|turn tracker/i.test(combined)) return null;
          return `${message.author?.displayName ?? message.author?.username ?? 'Unknown'}: ${combined}`.slice(0, 280);
        })
        .filter((line: string | null): line is string => Boolean(line));

      return lines.slice(-8).join('\n');
    } catch {
      return '';
    }
  }

  private async postOpeningScene(sessionId: string, channelId: string, targetMessage?: any): Promise<void> {
    const details = this.manager.getSessionById(sessionId);
    if (!details) {
      throw new Error('Session not found while generating opening scene.');
    }

    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      throw new Error('Opening scene channel is unavailable.');
    }

    const openingPlayer = details.players.find(player => player.userId === details.session.activePlayerUserId) ?? null;
    const waitingMessage = targetMessage
      ? await targetMessage.edit({
        content: null,
        embeds: [buildGenerationStatusEmbed(details, 'opening', openingPlayer)],
        components: [],
      })
      : await (channel as any).send({
        embeds: [buildGenerationStatusEmbed(details, 'opening', openingPlayer)],
      });

    await this.syncRagForSession(sessionId);
    await this.ensureWorldRagReady(details.session);
    const ragContext = await buildRagQuestionContext({
      rag: this.rag,
      embeddings: this.embeddings,
      sessionId,
      question: 'opening scene session start',
      extraScopeIds: this.getWorldScopeIds(details.session),
    });

    const prompt = this.buildTableTalkPrompt(
      channelId,
      details.session.hostUserId,
      details.session.worldKey
        ? '[SYSTEM: The adventure begins inside the preconfigured shared world. Describe the opening scene using only the provided lorebook context and established setting details. Do not invent a new world, continent, kingdom, or replacement setting. You may introduce a local scene, NPCs, and immediate tension that fit the lorebook. End with a natural prompt for the active player to act.]'
        : '[SYSTEM: The adventure begins. Describe the opening scene that introduces the party to the world. Set the stage vividly using the world lore. Introduce at least one NPC or immediate situation. End with a natural prompt for the active player to act.]',
      ragContext,
    );

    const { readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const gmPromptPath = resolve(process.cwd(), 'config/dnd_gm_prompt.md');
    let systemPrompt = '';
    try {
      systemPrompt = readFileSync(gmPromptPath, 'utf-8');
    } catch {
      // ignore missing prompt file
    }

    try {
      const processed = await this.generateValidatedNarrative(channelId, details.session.id, systemPrompt, prompt);
      const narrativeEmbed = new EmbedBuilder()
        .setTitle('Opening Scene')
        .setColor(0x8e44ad)
        .setDescription(processed.content.slice(0, 4096));
      applyPlayerPortrait(narrativeEmbed, openingPlayer, openingPlayer ? `Spotlight: ${openingPlayer.characterName}` : null);
      const trackerEmbed = this.buildTurnTrackerEmbed(channelId);
      const openingComponents = [
        ...(processed.actionComponents || []),
        ...buildRegenerateRows(details.session.id, 'opening'),
      ].slice(0, 5);

      const sceneMessage = await waitingMessage.edit({
        content: null,
        embeds: [narrativeEmbed, ...(trackerEmbed ? [trackerEmbed] : [])],
        components: openingComponents,
      });
      await this.recordCanonicalSceneState({
        threadId: channelId,
        sessionId: details.session.id,
        source: targetMessage ? 'regenerate' : 'opening',
        title: narrativeEmbed.data.title ?? null,
        content: processed.content,
        messageId: sceneMessage?.id ?? targetMessage?.id ?? null,
      });

      for (const embed of processed.shopEmbeds) {
        await (channel as any).send({ embeds: [embed] });
      }

      for (const embed of processed.combatEmbeds) {
        await (channel as any).send({ embeds: [embed] });
      }

      if (processed.combatComponents && processed.combatComponents.length > 0) {
        await (channel as any).send({
          content: '**Combat Actions**',
          components: processed.combatComponents,
        });
      }
    } catch (err: any) {
      log.error({ sessionId, channelId, error: err.message }, 'Failed to generate opening scene via GM pipeline');
      const defaultChoices = buildSceneSpecificFallbackChoices(
        `The adventure **${details.session.title}** begins. ${details.session.worldInfo ?? ''}`,
        null,
      );
      const openingComponents = [
        ...buildActionChoiceRows(details.session.id, details.session.activePlayerUserId ?? '', defaultChoices),
        ...buildRegenerateRows(details.session.id, 'opening'),
      ].slice(0, 5);
      const fallbackEmbed = new EmbedBuilder()
        .setTitle('Opening Scene')
        .setColor(0x8e44ad)
        .setDescription(`The adventure **${details.session.title}** begins. **${activePlayerLabel(details)}**, what do you do?`.slice(0, 4096));
      applyPlayerPortrait(fallbackEmbed, openingPlayer, openingPlayer ? `Spotlight: ${openingPlayer.characterName}` : null);
      const trackerEmbed = this.buildTurnTrackerEmbed(channelId);
      const sceneMessage = await waitingMessage.edit({
        content: null,
        embeds: [fallbackEmbed, ...(trackerEmbed ? [trackerEmbed] : [])],
        components: openingComponents,
      });
      await this.recordCanonicalSceneState({
        threadId: channelId,
        sessionId: details.session.id,
        source: targetMessage ? 'regenerate' : 'opening',
        title: fallbackEmbed.data.title ?? null,
        content: fallbackEmbed.data.description ?? '',
        messageId: sceneMessage?.id ?? targetMessage?.id ?? null,
      });
    }
  }

  private async triggerMidSessionWeaveIn(sessionId: string, userId: string): Promise<void> {
    const details = this.manager.getSessionById(sessionId);
    if (!details) return;

    const player = details.players.find(p => p.userId === userId);
    if (!player) return;

    const lobby = this.lobbies.get(sessionId);
    const targetChannelId = lobby?.lobbyChannelId ?? details.session.threadId ?? details.session.channelId;
    const channel = targetChannelId
      ? await this.client.channels.fetch(targetChannelId).catch(() => null)
      : null;

    if (!channel?.isTextBased()) return;

    const waitingMessage = await (channel as any).send({
      embeds: [buildGenerationStatusEmbed(details, 'weave', player)],
    }).catch(() => null);

    try {
      const loadout = await this.ensurePlayerCombatLoadout(details, player);
      await this.syncRagForSession(sessionId);
      await this.ensureWorldRagReady(details.session);
      const sceneSnapshot = await this.buildRecentSceneSnapshot(channel);
      const ragContext = await this.buildNarrativeRagContext(channel.id, `weaving in new character ${player.characterName}`);

      const prompt = this.buildTableTalkPrompt(
        channel.id,
        details.session.hostUserId,
        `[SYSTEM: A new player has joined midway. Their character is ${player.characterName}, a ${player.race || ''} ${player.className || ''}. Weave them into the CURRENT ongoing scene naturally.${details.session.worldKey ? ' Keep them inside the established shared world lore; do not invent a replacement setting or contradict the lorebook.' : ''} Do not start a new opening scene. Do not skip time. Do not relocate the party. Do not hard cut to a different room, district, or hour unless the recent scene snapshot already shows that change happened. The new character must enter through something immediately plausible in the exact current moment. Use the recent scene snapshot to anchor continuity.

<recent_scene_snapshot>
${sceneSnapshot || 'No recent scene snapshot available.'}
</recent_scene_snapshot>

End with a prompt for the party to interact.]`,
        ragContext,
      );

      const { readFileSync } = await import('fs');
      const { resolve } = await import('path');
      const gmPromptPath = resolve(process.cwd(), 'config/dnd_gm_prompt.md');
      let systemPrompt = '';
      try {
        systemPrompt = readFileSync(gmPromptPath, 'utf-8');
      } catch {
        // Fallback
      }

      const processed = await this.generateValidatedNarrative(channel.id, sessionId, systemPrompt, prompt);

      const weaveEmbed = new EmbedBuilder()
        .setTitle('A New Arrival')
        .setColor(0x3498db)
        .setDescription(processed.content.slice(0, 4096))
        .setFooter({ text: `${player.characterName} joins the fray.` });
      applyPlayerPortrait(weaveEmbed, player, `${player.characterName} enters the scene`);

      const weaveMessage = waitingMessage
        ? await waitingMessage.edit({
            content: null,
            embeds: [weaveEmbed, ...processed.shopEmbeds, ...processed.combatEmbeds],
            components: processed.combatComponents ?? processed.actionComponents,
          })
        : await (channel as any).send({
            embeds: [weaveEmbed, ...processed.shopEmbeds, ...processed.combatEmbeds],
            components: processed.combatComponents ?? processed.actionComponents,
          });
      await this.recordCanonicalSceneState({
        threadId: channel.id,
        sessionId,
        source: 'weave',
        title: weaveEmbed.data.title ?? null,
        content: processed.content,
        messageId: weaveMessage?.id ?? null,
      });
      await (channel as any).send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Starter Kit Prepared')
            .setColor(0x2e86ab)
            .setDescription(loadout.summary.slice(0, 4096)),
        ],
      });
    } catch (err: any) {
      log.error({ sessionId, userId, error: err.message }, 'Failed to trigger mid-session weave-in');
      if (waitingMessage) {
        await waitingMessage.edit({
          content: `**${player.characterName}** joins the party. Please give the GM a moment to anchor them to the current scene.`,
          embeds: [],
          components: [],
        }).catch(() => undefined);
      } else {
        await (channel as any).send({
          content: `**${player.characterName}** joins the party. Please give the GM a moment to anchor them to the current scene.`,
        });
      }
    }
  }

}

function parseJsonObject(raw: string): any {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in loadout generation response.');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateGeneratedLoadout(
  parsed: any,
  allowedSkillIds: string[],
  allowedWeaponIds: string[],
  defaultKit: { skillIds: string[]; items: StarterItemTemplate[]; equippedWeaponName: string | null },
): { skillIds: string[]; items: StarterItemTemplate[]; equippedWeaponName: string | null } {
  const skillIds: string[] = Array.isArray(parsed?.skillIds)
    ? Array.from(new Set<string>(parsed.skillIds.map((value: unknown) => String(value).trim()).filter((id: string) => allowedSkillIds.includes(id)))).slice(0, 3)
    : [];

  const selectedWeaponId = allowedWeaponIds.includes(String(parsed?.weaponId ?? ''))
    ? String(parsed.weaponId)
    : findWeaponIdByName(defaultKit.equippedWeaponName) ?? allowedWeaponIds[0] ?? null;
  if (!selectedWeaponId) {
    throw new Error('No valid weapon id available for generated loadout.');
  }

  const consumables = Array.isArray(parsed?.consumables) ? parsed.consumables : [];
  const items: StarterItemTemplate[] = [
    buildWeaponTemplate(selectedWeaponId),
    ...consumables
      .map((entry: any) => buildConsumableTemplate(String(entry?.id ?? ''), Number(entry?.quantity ?? 1)))
      .filter((value: StarterItemTemplate | null): value is StarterItemTemplate => Boolean(value))
      .slice(0, 3),
  ];

  return {
    skillIds: skillIds.length > 0 ? skillIds : defaultKit.skillIds,
    items: dedupeTemplates(items.length > 1 ? items : defaultKit.items),
    equippedWeaponName: WEAPON_DEFINITIONS[selectedWeaponId]?.name ?? defaultKit.equippedWeaponName,
  };
}

function buildCompatibleFallbackLoadout(
  allowedSkillIds: string[],
  allowedWeaponIds: string[],
  defaultKit: { skillIds: string[]; items: StarterItemTemplate[]; equippedWeaponName: string | null },
): { skillIds: string[]; items: StarterItemTemplate[]; equippedWeaponName: string | null } {
  const fallbackSkillIds = defaultKit.skillIds.filter(skillId => allowedSkillIds.includes(skillId));
  const skillIds = fallbackSkillIds.length > 0
    ? fallbackSkillIds
    : allowedSkillIds.slice(0, Math.min(2, allowedSkillIds.length));

  const preferredWeaponId = findWeaponIdByName(defaultKit.equippedWeaponName);
  const selectedWeaponId = preferredWeaponId && allowedWeaponIds.includes(preferredWeaponId)
    ? preferredWeaponId
    : allowedWeaponIds[0] ?? null;

  const consumableItems = dedupeTemplates(
    defaultKit.items
      .filter(item => item.metadata.consumableId && CONSUMABLE_DEFINITIONS[item.metadata.consumableId])
      .slice(0, 2),
  );

  const items: StarterItemTemplate[] = [
    ...(selectedWeaponId ? [buildWeaponTemplate(selectedWeaponId)] : []),
    ...consumableItems,
  ];

  return {
    skillIds,
    items: items.length > 0 ? items : consumableItems,
    equippedWeaponName: selectedWeaponId ? WEAPON_DEFINITIONS[selectedWeaponId]?.name ?? null : null,
  };
}

function extractInlineRollSuggestions(content: string): string[] {
  const suggestions = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!/(roll|check|saving throw|initiative|perception|investigation|insight|stealth|athletics|arcana)/i.test(line)) {
      continue;
    }
    const matches = line.match(/\b\d+d\d+(?:\s*[+-]\s*(?:\d+|[a-z]+(?:\s+[a-z]+)?))?/gi) ?? [];
    for (const match of matches) {
      suggestions.add(match.replace(/\s+/g, ''));
    }
  }
  return Array.from(suggestions).slice(0, 3);
}

function buildSceneSpecificFallbackChoices(content: string, existingChoices: string[] | null): string[] {
  const picked = new Set<string>((existingChoices ?? []).map(choice => choice.trim()).filter(Boolean));
  const npcMatch = content.match(/\*\*([^*]{2,40})\*\*\s+says/i) ?? content.match(/\b([A-Z][a-z]{2,20})\s+says\b/);
  const npcName = npcMatch?.[1]?.trim() ?? null;

  const lower = content.toLowerCase();
  const environmentChoice =
    lower.includes('cellar') ? 'Search the cellar shadows'
      : lower.includes('alley') ? 'Sweep the alley for clues'
        : lower.includes('bridge') ? 'Inspect the damaged bridge'
          : lower.includes('wagon') ? 'Check the overturned wagon'
            : lower.includes('door') ? 'Examine the sealed door'
              : 'Inspect the scene closely';

  const socialChoice = npcName
    ? `Question ${npcName} immediately`
    : lower.includes('guard')
      ? "Press the guard for details"
      : 'Confront the nearest witness';

  const tensionChoice =
    lower.includes('hiss') || lower.includes('thump') || lower.includes('dark')
      ? 'Advance toward the disturbance'
      : lower.includes('chest')
        ? 'Secure the old chest first'
        : lower.includes('stairs')
          ? 'Hold the stairs and listen'
          : 'Ready yourself for trouble';

  for (const choice of [environmentChoice, socialChoice, tensionChoice]) {
    if (picked.size >= 3) break;
    if (!hasGenericChoiceShape(choice)) {
      picked.add(choice);
    }
  }

  const fallbackPool = [
    'Follow the freshest clue',
    'Probe the loudest threat',
    'Take cover and observe',
  ];
  for (const choice of fallbackPool) {
    if (picked.size >= 3) break;
    picked.add(choice);
  }

  return Array.from(picked).slice(0, 3);
}

function hasGenericChoiceShape(choice: string): boolean {
  const normalized = choice.trim().toLowerCase();
  return normalized === 'explore the area'
    || normalized === 'talk to someone'
    || normalized === 'use an ability';
}

function shuffleArray<T>(values: T[]): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function pickLoadoutTheme(): string {
  const themes = [
    'aggressive opener',
    'careful survivor',
    'battlefield control',
    'duelist pressure',
    'supportive opportunist',
    'high-risk improviser',
  ];
  return themes[Math.floor(Math.random() * themes.length)] ?? 'balanced adventurer';
}

function pickPreferredSkillCount(maxSkillCount: number): number {
  return Math.max(1, Math.min(maxSkillCount, 1 + Math.floor(Math.random() * Math.min(3, Math.max(1, maxSkillCount)))));
}

function pickConsumableLimit(): number {
  return Math.floor(Math.random() * 3);
}

function buildWeaponTemplate(weaponId: string): StarterItemTemplate {
  const weapon = WEAPON_DEFINITIONS[weaponId];
  if (!weapon) {
    throw new Error(`Unknown weapon id: ${weaponId}`);
  }
  return {
    name: weapon.name,
    category: 'weapon',
    notes: weapon.notes ?? null,
    consumable: false,
    quantity: 1,
    metadata: {
      kind: 'weapon',
      weaponId: weapon.id,
      requirement: weapon.requirement ?? null,
    },
  };
}

function buildConsumableTemplate(consumableId: string, quantity: number): StarterItemTemplate | null {
  const consumable = CONSUMABLE_DEFINITIONS[consumableId];
  if (!consumable) return null;
  return {
    name: consumable.name,
    category: 'consumable',
    notes: consumable.effect === 'heal' ? 'Restore health in combat.' : 'Single-use combat item.',
    consumable: true,
    quantity: Math.max(1, Math.min(3, Math.floor(quantity || 1))),
    metadata: {
      kind: 'consumable',
      consumableId: consumable.id,
    },
  };
}

function dedupeTemplates(items: StarterItemTemplate[]): StarterItemTemplate[] {
  const seen = new Map<string, StarterItemTemplate>();
  for (const item of items) {
    const key = `${item.name.toLowerCase()}|${item.metadata.weaponId ?? item.metadata.consumableId ?? 'gear'}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...item });
      continue;
    }
    existing.quantity = Math.max(existing.quantity, item.quantity);
  }
  return Array.from(seen.values());
}

function findWeaponIdByName(name: string | null): string | null {
  if (!name) return null;
  const normalized = name.trim().toLowerCase();
  const match = Object.values(WEAPON_DEFINITIONS).find(weapon => weapon.name.toLowerCase() === normalized);
  return match?.id ?? null;
}

async function ensureSessionThread(interaction: ChatInputCommandInteraction): Promise<ThreadChannel> {
  const channel = interaction.channel;
  if (!channel) {
    throw new Error('No channel available for this interaction.');
  }

  if (channel.isThread()) {
    return channel;
  }

  if (channel.type !== ChannelType.GuildText) {
    throw new Error('DnD sessions currently require a regular guild text channel or a thread.');
  }

  return await (channel as TextChannel).threads.create({
    name: `dnd-${slugify(interaction.options.getString('title') ?? 'session')}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `LiteClaw DnD session requested by ${interaction.user.tag}`,
  });
}

function buildOnboardingEmbed(summary: SessionSummary | DndSessionDetails, userId: string, notice?: string): EmbedBuilder {
  const session = summary.session;
  const player = summary.players.find(p => p.userId === userId);
  const onboarding = player ? getPlayerOnboardingState(player) : {
    step: 'intro' as const,
    rolledStats: [],
    selectedClassId: null,
    allocated: false,
  };
  const sheet = player?.characterSheetJson ? parseCharacterSheet(player.characterSheetJson) : null;
  const classDef = onboarding.selectedClassId ? getClassById(onboarding.selectedClassId) : null;

  const checklist = [
    `${onboarding.selectedClassId ? '✅' : '1.'} Choose your class`,
    `${onboarding.rolledStats.length === 6 ? '✅' : '2.'} Roll your ability scores`,
    `${onboarding.allocated ? '✅' : '3.'} Review or adjust the auto-assignment`,
    `${player && isPlayerOnboardingComplete(player) ? '✅' : '4.'} Ready up in the lobby`,
  ].join('\n');

  const embed = new EmbedBuilder()
    .setAuthor({ name: `Character Setup · ${session.title}` })
    .setDescription(notice ?? '*Follow the steps below. Each unlocks the next.*')
    .setColor(0x3949AB)
    .addFields(
      { name: 'Progress', value: checklist, inline: false },
      { name: 'Next', value: describeNextOnboardingStep(onboarding), inline: false },
    );

  if (classDef) {
    embed.addFields({ name: 'Class', value: `${classDef.emoji} **${classDef.name}** · ${formatRecommendedAbilityOrder(classDef)}`, inline: false });
  }
  if (onboarding.rolledStats.length === 6) {
    embed.addFields({ name: 'Rolled', value: onboarding.rolledStats.map(v => `\`${v}\``).join(' '), inline: false });
  }
  if (sheet) {
    embed.addFields({ name: 'Sheet', value: `\`${hpBar(sheet.hp, sheet.maxHp, 8)}\` · AC ${sheet.ac}`, inline: false });
  }

  return embed;
}

function buildOnboardingComponents(summary: SessionSummary | DndSessionDetails, userId: string): ActionRowBuilder<any>[] {
  const sessionId = summary.session.id;
  const player = summary.players.find(entry => entry.userId === userId);
  const onboarding = player ? getPlayerOnboardingState(player) : {
    step: 'intro' as const,
    rolledStats: [],
    selectedClassId: null,
    allocated: false,
  };

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DND_ONBOARD_ROLL_PREFIX}${sessionId}`)
      .setLabel(onboarding.rolledStats.length === 6 ? 'Re-roll Stats' : 'Roll Stats')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!onboarding.selectedClassId)
      .setEmoji('🎲'),
    new ButtonBuilder()
      .setCustomId(`${DND_ONBOARD_MODAL_PREFIX}${sessionId}`)
      .setLabel(onboarding.allocated ? 'Adjust Stats' : 'Adjust Stats')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(onboarding.rolledStats.length !== 6 || !onboarding.selectedClassId)
      .setEmoji('✍️'),
    new ButtonBuilder()
      .setCustomId(`${DND_READY_PREFIX}${sessionId}`)
      .setLabel('Ready Up')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!player || !isPlayerOnboardingComplete(player))
      .setEmoji('✅'),
  );

  const select = new StringSelectMenuBuilder()
    .setCustomId(`${DND_ONBOARD_CLASS_PREFIX}${sessionId}`)
    .setPlaceholder(onboarding.selectedClassId ? 'Class selected - change if needed...' : 'Step 1: Select your class...')
    .setDisabled(false)
    .addOptions(
      DND_CLASSES.map(cls =>
        new StringSelectMenuOptionBuilder()
          .setLabel(cls.name)
          .setValue(cls.id)
          .setEmoji(cls.emoji)
          .setDefault(cls.id === onboarding.selectedClassId)
          .setDescription(`${cls.primaryAbility} based · d${cls.hitDie} Hit Die`)
      )
    );

  const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  return [row1, row2];
}

function buildStatModal(sessionId: string, rolledStats: number[], abilities: DndAbilityScores): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`${DND_ONBOARD_ALLOC_PREFIX}${sessionId}`)
    .setTitle(`Adjust Stats (${rolledStats.join(', ')})`.slice(0, 45));

  const input = new TextInputBuilder()
    .setCustomId('allocation')
    .setLabel('STR, DEX, CON, INT, WIS, CHA')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Enter six values in STR, DEX, CON, INT, WIS, CHA order')
    .setValue([abilities.str, abilities.dex, abilities.con, abilities.int, abilities.wis, abilities.cha].join(', '))
    .setRequired(true)
    .setMinLength(11)
    .setMaxLength(64);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  return modal;
}

function describeNextOnboardingStep(onboarding: DndOnboardingState): string {
  if (!onboarding.selectedClassId) {
    return 'Start by choosing your class. That unlocks the best-fit stat priority for auto-assignment.';
  }
  if (onboarding.rolledStats.length !== 6) {
    return 'Roll your stats next. LiteClaw will auto-assign the values using your class recommendation.';
  }
  if (!onboarding.allocated) {
    return `Your rolled values are ready: ${onboarding.rolledStats.join(', ')}. Use Adjust Stats only if you want to override the auto-assignment.`;
  }
  return 'Your stats are auto-assigned. Review them, tweak them if needed, then click Ready Up.';
}

function buildOnboardingReadyBlocker(player: DndPlayerRecord): string {
  const onboarding = getPlayerOnboardingState(player);
  if (onboarding.rolledStats.length !== 6) {
    return 'Finish onboarding first: click **Roll Stats** in your setup message.';
  }
  if (!onboarding.selectedClassId) {
    return 'Finish onboarding first: choose your class in the setup message.';
  }
  if (!onboarding.allocated) {
    return 'Finish onboarding first: click **Assign Stats** and place the six rolled numbers.';
  }
  return 'Finish onboarding in your setup message before marking yourself ready.';
}

function parseAbilityAllocationInput(value: string): number[] | null {
  const numbers = value
    .split(/[,\s/|]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => Number(part));

  if (numbers.length !== 6 || numbers.some(number => !Number.isFinite(number))) {
    return null;
  }

  return numbers.map(number => Math.floor(number));
}

function buildFallbackWorldLore(title: string, tone: string | null): string {
  return [
    `The adventure titled "${title}" unfolds in a weathered frontier settlement where trade, superstition, and old grudges live side by side.${tone ? ` The prevailing mood is ${tone}.` : ' The prevailing mood is tense, adventurous, and a little haunted.'}`,
    `The settlement sits at the edge of larger trouble rather than the center of power. Wagons, ferries, patrol roads, or caravan paths connect it to the wider world, but help from afar is slow, expensive, and unreliable. Local people solve problems themselves, hide them, or weaponize them against rivals.`,
    `Most folk here know one another by face if not by name. That makes strangers visible immediately and secrets hard to bury for long. Inns, shrines, counting houses, mills, watch posts, and market lanes serve as social pressure points where gossip travels faster than official orders.`,
    `At least two factions are in quiet conflict: one benefits from the town staying frightened and dependent, while another wants stability restored before trade, harvest, or civic order collapses. A few named locals carry influence far beyond their station: an innkeeper who hears everything, a guard or reeve stretched too thin, a merchant with something to lose, and someone ordinary who witnessed too much.`,
    `The land around the settlement should feel close and usable in play: roads leading into dark timber, marsh, ruined stone, river crossing, quarry, shrine, watchtower, or old battlefield. People speak of these places with familiarity, but also with the tone reserved for locations that take something from those who linger.`,
    `Whatever crisis opens the session is not isolated. It ties into the place's recent history: a disappearance, theft, desecration, sabotage, suspicious fire, bad omen, missing patrol, or attack that exposes a deeper rot already present beneath daily life.`,
    `Rumors circulate in different directions and do not align cleanly. Some residents blame outsiders. Some blame old curses. Some think a local notable is involved. The truth should feel close enough to investigate from the first scene, but layered enough that every answer reveals another motive, fear, or betrayal.`,
  ].join('\n\n');
}

function buildPreconfiguredWorldSummary(name: string, tagline: string, description: string, loreText: string): string {
  const paragraphs = loreText
    .split(/\n\s*\n/)
    .map(part => part.replace(/^#+\s+/gm, '').trim())
    .filter(Boolean);

  return [
    `${name}. ${tagline}`,
    description,
    ...paragraphs.slice(0, 3),
  ].join('\n\n').slice(0, 5000);
}

function buildFallbackOpeningScene(title: string, tone: string | null, worldLore?: string | null): string {
  const loreFlavor = worldLore?.split(/\n+/)[0]?.trim() || '';
  return [
    `${tone ? `The night carries a ${tone} edge.` : 'The night carries a hard, uneasy edge.'} Rain slicks the stones outside the busiest public house in the district, where wagon mud, spilled ale, and ash have all been trampled together into a dark paste underfoot. Lanterns swing in the wind, throwing weak light across anxious faces, and the smell of wet wool, smoke, and river-cold iron hangs stubbornly in the air.`,
    `The party has arrived at the exact moment local nerves snap. A shout rises from the street. Someone has gone missing, something valuable has been disturbed, or violence has broken whatever fragile calm this place was pretending to keep. A few townsfolk argue over what happened. One is breathless, one is frightened, and one is already trying too hard to control the story.`,
    loreFlavor ? `Everything about the scene suggests the trouble belongs to this place rather than falling from nowhere: ${loreFlavor}` : `Everything about the scene suggests the trouble belongs to this place rather than falling from nowhere; the people here have been bracing for something, and now it has finally reached the door.`,
    `The party can step toward the commotion, pin down the nearest witness, watch the crowd for the first lie, or move straight toward the place everyone else suddenly fears to approach.`,
  ].join('\n\n');
}

function parseWorldGenerationPackage(value: string): { worldLore: string; openingScene: string } {
  const worldLoreMatch = value.match(/<world_lore>([\s\S]*?)<\/world_lore>/i);
  const openingSceneMatch = value.match(/<opening_scene>([\s\S]*?)<\/opening_scene>/i);

  const worldLore = (worldLoreMatch?.[1] ?? '')
    .replace(/\r/g, '')
    .trim();
  const openingScene = (openingSceneMatch?.[1] ?? value)
    .replace(/\r/g, '')
    .trim();

  return { worldLore, openingScene };
}

function sanitizeOpeningScene(value: string): string {
  if (!value.trim()) return '';

  const lines = value
    .split(/\r?\n/)
    .map(line => line.trimEnd());

  const filtered = lines.filter(line => {
    const normalized = line.trim().toLowerCase();
    if (!normalized) return true;
    if (normalized.startsWith('## architectural decisions')) return false;
    if (normalized.startsWith('## opening scene')) return false;
    if (normalized.startsWith('## starting condition')) return false;
    if (normalized.startsWith('## what the party notices')) return false;
    if (normalized.startsWith('## immediate hook')) return false;
    if (/^\d+\.\s+\*\*/.test(normalized)) return false;
    if (normalized.startsWith('---')) return false;
    if (/^\d+\.\s/.test(normalized)) return false;
    if (normalized.includes('word count')) return false;
    return true;
  });

  const cleaned = filtered
    .map(line => line
      .replace(/^#+\s*(opening scene|starting condition|what the party notices|immediate hook)\s*:?\s*/i, '')
      .replace(/^\*\*(opening scene|starting condition|what the party notices|immediate hook)\*\*:\s*/i, '')
      .replace(/^(opening scene|starting condition|what the party notices|immediate hook)\s*:\s*/i, '')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

function trimOpeningSceneToCompleteThought(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  if (/[.!?"”']\s*$/.test(trimmed)) {
    return trimmed;
  }

  const lastSentenceBreak = Math.max(
    trimmed.lastIndexOf('. '),
    trimmed.lastIndexOf('! '),
    trimmed.lastIndexOf('? '),
    trimmed.lastIndexOf('.”'),
    trimmed.lastIndexOf('!"'),
    trimmed.lastIndexOf('?"'),
  );

  if (lastSentenceBreak > Math.max(80, Math.floor(trimmed.length * 0.5))) {
    return trimmed.slice(0, lastSentenceBreak + 1).trim();
  }

  return trimmed;
}

interface StructuredNarrativeShopDirective {
  action: 'open' | 'close';
  name?: string;
  description?: string | null;
  items?: Array<{
    name: string;
    priceGp: number;
    stock: number;
    category?: string | null;
    notes?: string | null;
  }>;
}

interface StructuredNarrativeCombatDirective {
  start: true;
  enemies: Array<{
    name: string;
    hp?: number;
    ac?: number;
    attackBonus?: number;
    damage?: string;
    dex?: number;
    str?: number;
    con?: number;
    wis?: number;
    int?: number;
    cha?: number;
  }>;
}

function parseStructuredNarrative(content: string): {
  cleanedContent: string;
  shopDirective: StructuredNarrativeShopDirective | null;
  combatDirective: StructuredNarrativeCombatDirective | null;
  actionChoices: string[] | null;
  rollSuggestions: string[] | null;
  directiveError: string | null;
} {
  // Parse <dnd_actions> directive
  let actionChoices: string[] | null = null;
  let rollSuggestions: string[] | null = null;
  let workingContent = content;
  const actionsMatch = content.match(/<dnd_actions>([\s\S]*?)<\/dnd_actions>/i);
  if (actionsMatch) {
    workingContent = workingContent.replace(actionsMatch[0], '').trim();
    try {
      let rawJson = actionsMatch[1].trim();
      // Basic robustness: if it's not valid JSON, try to fix common LLM mistakes
      // like single quotes or missing brackets
      if (!rawJson.startsWith('[')) rawJson = '[' + rawJson;
      if (!rawJson.endsWith(']')) rawJson = rawJson + ']';

      // Attempt a "relaxed" JSON parse if standard fails
      let parsed;
      try {
        parsed = JSON.parse(rawJson);
      } catch {
        // Try to replace single quotes with double quotes for a second attempt
        // Be careful not to break escaped quotes inside strings
        const relaxed = rawJson.replace(/'/g, '"');
        parsed = JSON.parse(relaxed);
      }

      if (Array.isArray(parsed) && parsed.length > 0) {
        actionChoices = parsed
          .map((c: any) => String(c).trim())
          .filter(c => c.length > 0)
          .slice(0, 3);
      }
    } catch {
      // If JSON fails, try to extract quoted strings or bullet points
      const quotedMatches = actionsMatch[1].match(/"([^"]+)"|'([^']+)'/g);
      if (quotedMatches && quotedMatches.length > 0) {
        actionChoices = quotedMatches
          .map(m => m.replace(/["']/g, '').trim())
          .filter(m => m.length > 2)
          .slice(0, 3);
      } else {
        const bulletMatches = actionsMatch[1].match(/(?:^|\n)[-*•]\s*(.+)/g);
        if (bulletMatches && bulletMatches.length > 0) {
          actionChoices = bulletMatches
            .map(m => m.replace(/^[-*•]\s*/, '').trim())
            .filter(m => m.length > 0)
            .slice(0, 3);
        }
      }
    }
  }

  // If still no choices, try to infer from the end of the content (experimental)
  if (!actionChoices) {
    const endLines = content.split('\n').slice(-5).join('\n');
    const listMatches = endLines.match(/(?:^|\n)\d\.\s*(.+)/g);
    if (listMatches && listMatches.length >= 2) {
      actionChoices = listMatches
        .map(m => m.replace(/^\d\.\s*/, '').trim())
        .slice(0, 3);
    }
  }

  const match = workingContent.match(/<dnd_shop>([\s\S]*?)<\/dnd_shop>/i);
  let cleanedContent = workingContent;
  let shopDirective: StructuredNarrativeShopDirective | null = null;
  let combatDirective: StructuredNarrativeCombatDirective | null = null;
  let directiveError: string | null = null;

  if (match) {
    cleanedContent = cleanedContent.replace(match[0], '').trim();
    try {
      const parsed = JSON.parse(match[1]) as StructuredNarrativeShopDirective;
      if (parsed.action === 'close') {
        shopDirective = { action: 'close' };
      } else if (parsed.action === 'open') {
        if (!parsed.name?.trim()) throw new Error('Shop name is required');
        const items = Array.isArray(parsed.items) ? parsed.items : [];
        if (items.length === 0) throw new Error('At least one shop item is required');
        shopDirective = {
          action: 'open',
          name: parsed.name.trim(),
          description: parsed.description?.trim() || null,
          items: items.map(item => ({
            name: String(item.name ?? '').trim(),
            priceGp: Number(item.priceGp ?? 0),
            stock: Number(item.stock ?? 0),
            category: item.category?.trim() || null,
            notes: item.notes?.trim() || null,
          })).filter(item => item.name.length > 0),
        };
      } else {
        throw new Error('Unsupported shop action');
      }
    } catch (error: any) {
      directiveError = error.message;
    }
  }

  const combatMatch = cleanedContent.match(/<dnd_combat>([\s\S]*?)<\/dnd_combat>/i);
  if (combatMatch) {
    cleanedContent = cleanedContent.replace(combatMatch[0], '').trim();
    try {
      const parsed = JSON.parse(combatMatch[1]) as StructuredNarrativeCombatDirective;
      if (!parsed?.start || !Array.isArray(parsed.enemies) || parsed.enemies.length === 0) {
        throw new Error('Combat directive must include at least one enemy');
      }

      combatDirective = {
        start: true,
        enemies: parsed.enemies
          .map(enemy => ({
            name: String(enemy.name ?? '').trim(),
            hp: Number(enemy.hp ?? 20),
            ac: Number(enemy.ac ?? 12),
            attackBonus: Number(enemy.attackBonus ?? 3),
            damage: String(enemy.damage ?? '1d6+1').trim(),
            dex: Number(enemy.dex ?? 12),
            str: Number(enemy.str ?? 10),
            con: Number(enemy.con ?? 10),
            wis: Number(enemy.wis ?? 10),
            int: Number(enemy.int ?? 10),
            cha: Number(enemy.cha ?? 10),
          }))
          .filter(enemy => enemy.name.length > 0),
      };

      if (combatDirective.enemies.length === 0) {
        throw new Error('Combat directive contains no valid enemy names');
      }
    } catch (error: any) {
      directiveError = directiveError ? `${directiveError}; ${error.message}` : error.message;
    }
  }

  // Parse <dnd_roll> directives
  const rollMatches = workingContent.matchAll(/<dnd_roll>([\s\S]*?)<\/dnd_roll>/gi);
  for (const rMatch of rollMatches) {
    if (!rollSuggestions) rollSuggestions = [];
    const notation = rMatch[1].trim();
    if (notation) {
      rollSuggestions.push(notation);
      workingContent = workingContent.replace(rMatch[0], '');
    }
  }
  cleanedContent = workingContent;
  if (!rollSuggestions || rollSuggestions.length === 0) {
    const inlineRolls = extractInlineRollSuggestions(workingContent);
    if (inlineRolls.length > 0) {
      rollSuggestions = inlineRolls;
    }
  }

  // Handle <npc> and <meta> tags for Discord formatting
  let finalContent = cleanedContent.trim();
  if (finalContent.includes('<npc>') || finalContent.includes('<meta>')) {
    // Process tags into standard Discord markdown
    finalContent = finalContent
      .replace(/<npc>([\s\S]*?)<\/npc>/gi, '$1') // Prompt handles bolding
      .replace(/<meta>([\s\S]*?)<\/meta>/gi, '\n> **Meta**: $1');
  }
  finalContent = finalContent
    .replace(/<npc>([\s\S]*?)(?=\n\s*\n|$)/gi, '$1')
    .replace(/<meta>([\s\S]*?)(?=\n\s*\n|$)/gi, '\n> **Meta**: $1');

  // Safety net: strip any remaining raw XML-like tags that should never reach players.
  // We use a whitelist approach: keep content of narrative tags, but strip content of system tags.

  // 1. Strip content of known system/data tags ENTIRELY
  const systemTags = 'world_lore|world_state|system_role|formatting_rules|session_state|player_input|dnd_actions|dnd_shop|dnd_combat|dnd_roll|system_note|think|thought|thinking|reasoning|internal_monologue|world_context|observation|task|plan|replan|thought_process';
  finalContent = finalContent
    .replace(new RegExp(`<(${systemTags})>[\\s\\S]*?<\\/\\1>`, 'gi'), '')
    .replace(new RegExp(`<(${systemTags})>[\\s\\S]*?(?:<\\/\\1>|$)`, 'gi'), ''); // Handle unclosed tags

  // 2. Generic stripper for any other tags that are NOT in our allowed whitelist
  // Allowed to keep content: gm_response, opening_scene, narrative, response
  // Allowed to keep tag + content (handled later): npc, meta
  finalContent = finalContent.replace(/<([a-z0-9_-]+)>([\s\S]*?)<\/\1>/gi, (match, tagName, tagContent) => {
    const lowerTag = tagName.toLowerCase();
    if (['npc', 'meta'].includes(lowerTag)) return match;
    if (['gm_response', 'opening_scene', 'narrative', 'response'].includes(lowerTag)) return tagContent;
    return ''; // Strip any other tagged block entirely
  });

  // 3. Strip any remaining standalone tags (strip tag only)
  finalContent = finalContent.replace(/<(?!\/?(?:npc|meta)\b)[^>]+>/g, '');

  // 4. Strip personality bleed (GIFs from common providers)
  finalContent = finalContent.replace(/https?:\/\/[\S]*(tenor|giphy|gfycat|giphy\.com|media\.giphy\.com)[\S]*/gi, '');

  // 5. Cleanup whitespace, code fences, and duplicate UI scaffolding
  finalContent = finalContent
    .replace(/^\s*```(?:\w+)?\s*\n?/g, '')
    .replace(/\n?```\s*$/g, '')
    .replace(/^\s*\*\*What do you do\?\*\*\s*$/gim, '')
    .replace(/^\s*What do you do\?\s*$/gim, '')
    .replace(/^\s*\*\*Suggested rolls:\*\*\s*$/gim, '')
    .replace(/^\s*Suggested rolls:\s*$/gim, '')
    .replace(/^\s*(?:[-*]|\d+\.)\s+Roll\s+[^\n]+$/gim, '')
    .replace(/^\s*---+\s*$/gm, '')
    .replace(/^\s*GM\s*Response:\s*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!actionChoices || actionChoices.length < 3) {
    actionChoices = buildSceneSpecificFallbackChoices(finalContent, actionChoices);
  }

  return {
    cleanedContent: finalContent,
    shopDirective,
    combatDirective,
    actionChoices,
    rollSuggestions,
    directiveError,
  };
}

function buildSessionEmbed(summary: SessionSummary | DndSessionDetails, description: string, lobby?: LobbyState): EmbedBuilder {
  const session = summary.session;
  const players = summary.players;
  const combat = parseCombatState(session.combatStateJson);
  const spotlight = activePlayerRecord(summary);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `LiteClaw DnD · ${session.title}` })
    .setDescription(description)
    .setColor(colorForPhase(session.phase))
    .addFields(
      { name: 'Phase', value: `\`${session.phase.toUpperCase()}\``, inline: true },
      { name: 'Turn', value: `\`${session.roundNumber}.${session.turnNumber}\``, inline: true },
      { name: 'Spotlight', value: activePlayerLabel(summary), inline: true },
    );

  if (combat?.active) {
    embed.addFields({ name: 'Combat', value: `⚔️ Round ${combat.round}`, inline: true });
  }

  if (session.phase === 'lobby') {
    const worldStatus = lobby
      ? (lobby.worldGenError ? `❌ ${lobby.worldGenError}` : lobby.worldLore ? `✅ ${lobby.worldStatusText}` : `⏳ ${lobby.worldStatusText}`)
      : session.worldInfo
        ? '✅ World ready'
        : '⏳ Preparing world';

    if (lobby) {
      const readyCount = lobby.readyPlayers.size;
      const totalCount = players.length;
      const readyBar = totalCount > 0
        ? `\`${'█'.repeat(readyCount)}${'░'.repeat(Math.max(0, totalCount - readyCount))}\` ${readyCount}/${totalCount}`
        : '0/0';

      embed.addFields(
        { name: 'Ready', value: readyBar, inline: true },
        { name: 'World', value: `${lobby.worldLabel}\n${worldStatus}`, inline: true },
      );

      const playerList = players.map(p => {
        let icon = '⏳';
        if (lobby.readyPlayers.has(p.userId)) icon = '✅';
        else if (!p.isHost && !isPlayerOnboardingComplete(p)) icon = '🛠️';
        return `${icon} **${p.characterName}**`;
      }).join(' · ');

      embed.addFields({ name: 'Players', value: playerList || 'No players', inline: false });
    } else {
      embed.addFields(
        { name: 'World', value: worldStatus, inline: true },
        { name: 'Players', value: formatPlayers(players), inline: false }
      );
    }
  } else {
    embed.addFields({ name: 'Party', value: formatPlayers(players), inline: false });
  }

  applyPlayerPortrait(
    embed,
    spotlight,
    spotlight
      ? `Spotlight: ${spotlight.characterName}`
      : players[0]?.characterName
        ? `Party Lead: ${players[0].characterName}`
        : null,
  );
  embed.setFooter({ text: session.id });
  return embed.setTimestamp(new Date(session.updatedAt));
}

function buildTurnTrackerEmbed(summary: SessionSummary | DndSessionDetails): EmbedBuilder {
  const session = summary.session;
  const players = summary.players;
  const combat = parseCombatState(session.combatStateJson);
  const spotlight = activePlayerRecord(summary);
  const party = players.map(player => {
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const arrow = player.userId === session.activePlayerUserId ? '▸' : player.status === 'unavailable' ? '–' : ' ';
    return `\`${arrow}\` **${player.characterName}** \`${hpBar(sheet.hp, sheet.maxHp, 6)}\``;
  }).join('\n').slice(0, 1024) || 'No party members.';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `Turn Tracker · ${session.title}` })
    .setColor(combat?.active ? 0xB71C1C : 0x3949AB)
    .setDescription(
      combat?.active
        ? `⚔️ **Combat** Round ${combat.round} · ${combat.order[combat.turnIndex]?.characterName ?? 'Unknown'} acting`
        : `Spotlight: **${spotlight?.characterName ?? activePlayerLabel(summary)}**`,
    )
    .addFields(
      { name: 'Turn', value: `\`${session.roundNumber}.${session.turnNumber}\``, inline: true },
      { name: 'Active', value: activePlayerLabel(summary), inline: true },
      { name: 'Party', value: party, inline: false },
    )
    .setFooter({ text: session.id })
    .setTimestamp(new Date(session.updatedAt));

  return applyPlayerPortrait(embed, spotlight, spotlight ? `Spotlight: ${spotlight.characterName}` : null);
}

function buildLobbyButtons(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DND_READY_PREFIX}${sessionId}`)
      .setLabel('Ready Up')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${DND_UNREADY_PREFIX}${sessionId}`)
      .setLabel('Not Ready')
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildStatsEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  inventory: DndInventoryItemRecord[],
  recentRewards: DndProgressEvent[],
): EmbedBuilder {
  const nextLevelXp = nextLevelThreshold(sheet.level);
  const xpLine = nextLevelXp
    ? `${sheet.xp} / ${nextLevelXp} XP`
    : `${sheet.xp} XP (max level)`;

  const xpBar = nextLevelXp
    ? `\`${'█'.repeat(Math.round((sheet.xp / nextLevelXp) * 10))}${'░'.repeat(Math.max(0, 10 - Math.round((sheet.xp / nextLevelXp) * 10)))}\``
    : '';

  const conditionsLine = sheet.conditions.length > 0
    ? formatConditions(sheet.conditions)
    : '—';

  const exhaustionLine = sheet.exhaustion > 0
    ? exhaustionDisplay(sheet.exhaustion)
    : '—';

  const knownSkillsLine = formatKnownSkillsDetailed(sheet);
  const spellLine = formatSpellsDetailed(sheet);
  const loadoutLine = formatEquippedLoadout(sheet, inventory);
  const encumbranceLine = summarizeEncumbrance(sheet, inventory);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Character Sheet` })
    .setColor(0x3949AB)
    .setDescription([
      `*${player.className ?? 'Unknown'} · ${player.race ?? 'Unknown'} · Lv${sheet.level}*`,
      '',
      `❤️ \`${hpBar(sheet.hp, sheet.maxHp)}\``,
      `🛡️ **${sheet.ac}** AC  ·  🏃 **${sheet.speed}** ft  ·  🎯 +**${sheet.proficiencyBonus}** Prof`,
      `⭐ ${xpLine} ${xpBar}`,
      sheet.inspiration ? '✨ **Inspired**' : '',
    ].filter(Boolean).join('\n'))
    .addFields(
      { name: 'Abilities', value: formatAbilityScoresDetailed(sheet), inline: false },
      { name: 'Loadout', value: loadoutLine, inline: false },
      { name: 'Skills', value: knownSkillsLine, inline: false },
      { name: 'Spells', value: spellLine, inline: false },
    );

  // Only add conditions/exhaustion if present
  if (sheet.conditions.length > 0 || sheet.exhaustion > 0) {
    embed.addFields(
      { name: 'Conditions', value: conditionsLine, inline: true },
      { name: 'Exhaustion', value: exhaustionLine, inline: true },
    );
  }

  if (sheet.notes) {
    embed.addFields({ name: 'Notes', value: sheet.notes, inline: false });
  }

  const rewards = recentRewards.length > 0
    ? recentRewards.map(event => `${event.type}: ${event.title} (+${event.xpAward} XP)`).join('\n')
    : null;
  if (rewards) {
    embed.addFields({ name: 'Recent Rewards', value: rewards, inline: false });
  }

  embed
    .addFields({ name: 'Carry', value: encumbranceLine, inline: true })
    .setFooter({ text: session.id });

  return applyPlayerPortrait(embed, player, `${player.characterName}`);
}

function buildVoteEmbed(
  session: DndSessionRecord,
  players: DndPlayerRecord[],
  vote: DndVoteDetails,
  resolution?: VoteResolution | null,
): EmbedBuilder {
  const tally = tallyForDisplay(vote);
  const pending = players
    .filter(player => (vote.vote.kind !== 'skip_turn' || player.userId !== vote.vote.targetUserId) && player.status !== 'left')
    .filter(player => !vote.ballots.some(ballot => ballot.voterUserId === player.userId))
    .map(player => player.characterName);

  const outcome = resolution
    ? vote.vote.kind === 'skip_turn'
      ? resolution.shouldSkipTarget
        ? `${resolution.targetPlayer?.characterName ?? 'The player'} is now unavailable and will be skipped.`
        : 'The party chose to keep waiting.'
      : `Winning choice: **${resolution.winningOptionLabel}**.`
    : `Vote closes <t:${Math.floor(vote.vote.expiresAt / 1000)}:R>.`;

  return new EmbedBuilder()
    .setAuthor({ name: `${vote.vote.kind === 'party_decision' ? 'Party Vote' : 'Vote'} · ${session.title}` })
    .setDescription(vote.vote.question)
    .setColor(resolution ? 0x00C853 : 0xFFC107)
    .addFields(
      { name: 'Tally', value: tally, inline: true },
      { name: 'Pending', value: pending.length > 0 ? pending.join(', ') : '✅ All voted', inline: true },
      { name: 'Outcome', value: outcome, inline: false },
    )
    .setFooter({ text: session.id });
}

function buildProgressEventEmbed(
  session: DndSessionRecord,
  event: DndProgressEvent,
  players: DndPlayerRecord[],
): EmbedBuilder {
  const share = players.length > 0 ? Math.floor(event.xpAward / players.length) : 0;
  return new EmbedBuilder()
    .setAuthor({ name: `${capitalize(event.type)} Reward · ${session.title}` })
    .setColor(event.type === 'quest' ? 0xFFC107 : 0xFFAB00)
    .setDescription(event.notes ?? event.title)
    .addFields(
      { name: 'XP', value: `**${event.xpAward}** total · **${share}** per player`, inline: false },
    );
}

function buildProgressLogEmbed(session: DndSessionRecord, logEntries: DndProgressEvent[]): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `Rewards Log · ${session.title}` })
    .setColor(0xFFC107)
    .setDescription(
      logEntries.length > 0
        ? logEntries.slice(-12).reverse().map(entry => {
          const when = `<t:${Math.floor(entry.createdAt / 1000)}:R>`;
          return `**${capitalize(entry.type)}** · ${entry.title} · ${entry.xpAward} XP · ${when}`;
        }).join('\n')
        : '*No rewards logged yet.*',
    );
}

function buildCombatEmbed(
  session: DndSessionRecord,
  players: DndPlayerRecord[],
  combat: DndCombatState,
  mechanics: string,
  actions?: string,
  statusOverride?: { headline: string; detail: string; readyStatus?: string } | null,
): EmbedBuilder {
  const order = combat.order.map((entry, index) => {
    const active = index === combat.turnIndex ? ' <- active' : '';
    const side = entry.side === 'enemy' ? 'Enemy' : 'Player';
    return `${index + 1}. ${entry.characterName} (${side}, ${entry.initiative})${active}`;
  }).join('\n');
  const partyStatus = formatCombatPartyStatus(players, combat);
  const enemyStatus = formatCombatEnemyStatus(combat);

  const gmNarrative = combat.lastRoundNarrative ? `\n\n**GM:** ${combat.lastRoundNarrative}` : '';
  const actionSummary = actions ? `${actions}` : '';

  let description = actionSummary;
  if (gmNarrative) {
    description += gmNarrative;
  } else if (!actionSummary) {
    description = mechanics || 'Round resolved.';
  }

  const tableStatus = describeCombatTableStatus(players, combat, statusOverride ?? undefined);

  const embed = new EmbedBuilder()
    .setAuthor({ name: `⚔️ Combat · ${session.title}` })
    .setColor(0xB71C1C)
    .setDescription(description || '*Combat in progress…*')
    .addFields(
      { name: 'Round', value: `\`${combat.round}\``, inline: true },
      { name: 'Ready', value: tableStatus.readyStatus, inline: true },
      { name: 'Board', value: `${players.filter(player => player.status !== 'left').length}P / ${combat.enemies.filter(enemy => enemy.hp > 0).length}E`, inline: true },
      { name: 'Status', value: `**${tableStatus.headline}**\n${tableStatus.detail}`, inline: false },
    );

  // If we have a GM narrative or separate action intent, put the mechanical log in a field to avoid duplication
  if ((gmNarrative || actionSummary) && mechanics && mechanics !== 'Round resolved.') {
    embed.addFields({ name: 'Mechanical Log', value: mechanics.slice(0, 1024), inline: false });
  }

  embed.addFields(
    { name: 'Party Status', value: partyStatus, inline: false },
    { name: 'Enemy Status', value: enemyStatus, inline: false },
  );

  const activePlayer = players.find(player => player.userId === session.activePlayerUserId) ?? null;
  return applyPlayerPortrait(embed, activePlayer, activePlayer ? `Active Turn: ${activePlayer.characterName}` : null);
}

function describeCombatTableStatus(
  players: DndPlayerRecord[],
  combat: DndCombatState,
  statusOverride?: { headline: string; detail: string; readyStatus?: string },
): { headline: string; detail: string; readyStatus: string } {
  const livingPlayers = players.filter(player => {
    const sheet = parseCharacterSheet(player.characterSheetJson);
    return sheet.hp > 0 && player.status !== 'left';
  });
  const submitted = livingPlayers
    .filter(player => combat.pendingPlayerActions[player.userId])
    .map(player => player.characterName);
  const waitingOn = livingPlayers
    .filter(player => !combat.pendingPlayerActions[player.userId])
    .map(player => player.characterName);
  const total = livingPlayers.length;

  if (statusOverride) {
    return {
      headline: statusOverride.headline,
      detail: statusOverride.detail,
      readyStatus: statusOverride.readyStatus ?? `${submitted.length} / ${total} locked in`,
    };
  }

  if (total === 0) {
    return {
      headline: 'Combat resolving',
      detail: 'No living party members are available to submit actions.',
      readyStatus: '0 / 0 locked in',
    };
  }

  if (submitted.length === 0) {
    return {
      headline: 'Waiting on player actions',
      detail: waitingOn.length === 1
        ? `${waitingOn[0]} has the floor. The GM is waiting for that action.`
        : `${waitingOn.join(', ')} can lock in actions now.`,
      readyStatus: `0 / ${total} locked in`,
    };
  }

  if (waitingOn.length > 0) {
    return {
      headline: 'Waiting on the rest of the table',
      detail: `Ready: ${submitted.join(', ')}. Waiting: ${waitingOn.join(', ')}.`,
      readyStatus: `${submitted.length} / ${total} locked in`,
    };
  }

  return {
    headline: 'GM resolving the round',
    detail: `All player actions are locked in. Enemy turns and narration are being resolved.`,
    readyStatus: `${submitted.length} / ${total} locked in`,
  };
}

function buildCombatEndEmbed(
  session: DndSessionRecord,
  players: DndPlayerRecord[],
  event: DndProgressEvent | null,
  summary: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `Combat Ended · ${session.title}` })
    .setColor(0x00C853)
    .setDescription(summary)
    .addFields(
      { name: 'Party', value: `${players.filter(player => player.status !== 'left').length} members`, inline: true },
      { name: 'XP', value: `${event?.xpAward ?? 0}`, inline: true },
    );
}

function formatCombatPartyStatus(players: DndPlayerRecord[], combat?: DndCombatState): string {
  return players
    .filter(player => player.status !== 'left')
    .map(player => {
      const sheet = parseCharacterSheet(player.characterSheetJson);
      const hp = `\`${hpBar(sheet.hp, sheet.maxHp)}\``;
      const conditions = sheet.conditions.length > 0 ? ` [${sheet.conditions.join(', ')}]` : '';
      const availability = player.status !== 'available' ? ` (${player.status})` : '';
      return `**${player.characterName}** ${hp}${conditions}${availability}`;
    })
    .join('\n')
    .slice(0, 1024) || 'No party members tracked.';
}

function formatCombatEnemyStatus(combat: DndCombatState): string {
  return combat.enemies
    .filter(enemy => enemy.hp > 0)
    .map(enemy => {
      const hp = `\`${hpBar(enemy.hp, enemy.maxHp)}\``;
      const numeric = `${enemy.hp}/${enemy.maxHp} HP`;
      const conditions = enemy.conditions.length > 0 ? ` [${enemy.conditions.join(', ')}]` : '';
      return `**${enemy.name}** ${hp} ${numeric}${conditions}`;
    })
    .join('\n')
    .slice(0, 1024) || 'No enemies tracked.';
}

function buildCombatActionRows(sessionId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildCombatButton(sessionId, 'attack', 'Quick Attack', ButtonStyle.Danger),
    buildCombatButton(sessionId, 'cast', 'Use /turn', ButtonStyle.Primary),
    buildCombatButton(sessionId, 'help', 'Status Tip', ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    buildCombatButton(sessionId, 'custom', 'Improvise /turn', ButtonStyle.Secondary),
    buildCombatButton(sessionId, 'endturn', 'End Turn', ButtonStyle.Success),
  );
  return [row1, row2];
}

function buildCombatButton(sessionId: string, action: string, label: string, style: ButtonStyle): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`${DND_COMBAT_PREFIX}${sessionId}_${action}`)
    .setLabel(label)
    .setStyle(style);
}

function buildRegenerateRows(sessionId: string, kind: 'opening' | 'turnprompt'): ActionRowBuilder<ButtonBuilder>[] {
  const label = kind === 'opening' ? 'Regenerate Scene' : 'Regenerate Prompt';
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DND_REGEN_PREFIX}${sessionId}_${kind}`)
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * Build a single row of up to 3 narrative action choice buttons.
 * Button IDs encode: dnd_action_<sessionId>_<activeUserId>_<index>
 * Labels are deliberately kept short for Discord UI readability.
 */
function buildRollChoiceRows(sessionId: string, activeUserId: string, notations: string[]): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = sanitizeRollSuggestions(notations).slice(0, 5).map((notation, i) => {
    const encodedNotation = encodeRollButtonNotation(notation);
    return new ButtonBuilder()
      .setCustomId(`${DND_ROLL_PREFIX}${sessionId}_${activeUserId}_${encodedNotation}`.slice(0, 100))
      .setLabel(`Roll ${notation}`.slice(0, 80))
      .setStyle(ButtonStyle.Secondary);
  });
  if (buttons.length === 0) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

function buildActionChoiceRows(sessionId: string, activeUserId: string, choices: string[]): ActionRowBuilder<ButtonBuilder>[] {
  const buttons = choices.slice(0, 3).map((label, i) => {
    const safeLabel = truncateChoiceLabel(label, 58);
    return new ButtonBuilder()
      .setCustomId(`${DND_ACTION_PREFIX}${sessionId}_${activeUserId}_${i}`)
      .setLabel(safeLabel)
      .setStyle(ButtonStyle.Primary);
  });
  if (buttons.length === 0) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

function truncateChoiceLabel(label: string, maxLength: number): string {
  const normalized = label.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const cutoff = Math.max(12, maxLength - 1);
  const sliced = normalized.slice(0, cutoff);
  const lastSpace = sliced.lastIndexOf(' ');
  const smartSlice = lastSpace >= Math.floor(cutoff * 0.6)
    ? sliced.slice(0, lastSpace)
    : sliced;

  return `${smartSlice.trimEnd()}…`;
}

function normalizeSuggestedRollNotation(notation: string, sheet: DndCharacterSheet | null): string {
  let normalized = notation.trim().toLowerCase();
  const abilities: Array<{ aliases: string[]; value: number }> = sheet
    ? [
      { aliases: ['strength', 'str'], value: abilityModifier(sheet.abilities.str) },
      { aliases: ['dexterity', 'dex'], value: abilityModifier(sheet.abilities.dex) },
      { aliases: ['constitution', 'con'], value: abilityModifier(sheet.abilities.con) },
      { aliases: ['intelligence', 'int'], value: abilityModifier(sheet.abilities.int) },
      { aliases: ['wisdom', 'wis'], value: abilityModifier(sheet.abilities.wis) },
      { aliases: ['charisma', 'cha'], value: abilityModifier(sheet.abilities.cha) },
    ]
    : [];

  normalized = normalized
    .replace(/<\/?dnd[^>]*>/g, '')
    .replace(/\/dnd\b/g, '')
    .replace(/\s+modifier\b/g, '')
    .replace(/\s+mod\b/g, '')
    .replace(/[.,;:]+$/g, '');

  for (const ability of abilities) {
    for (const alias of ability.aliases) {
      normalized = normalized.replace(new RegExp(`\\b${alias}\\b`, 'g'), String(ability.value));
    }
  }

  return normalized
    .replace(/\+mod\b/gi, '+0')
    .replace(/\+modifier\b/gi, '+0')
    .replace(/\+\+/g, '+')
    .replace(/\+-/g, '-')
    .replace(/--/g, '+')
    .replace(/-\+/g, '-')
    .replace(/\s+/g, '');
}

function encodeRollButtonNotation(notation: string): string {
  return encodeURIComponent(notation).replace(/\./g, '%2E');
}

function decodeRollButtonNotation(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeRollSuggestions(notations: string[]): string[] {
  const cleaned = new Set<string>();
  for (const raw of notations) {
    const normalized = normalizeSuggestedRollNotation(raw, null)
      .replace(/[^a-z0-9+\-dkrhl!<>=]/gi, '')
      .slice(0, 24);
    if (!normalized) continue;
    if (!/^\d*d\d+/i.test(normalized)) continue;
    cleaned.add(normalized);
  }
  return Array.from(cleaned).slice(0, 5);
}

function pickLoadingTip(sessionId: string, userId: string, mode: 'startup' | 'weave'): string {
  const startupTips = [
    'Open `/stats view` while you wait so your skills and gear are fresh in your head.',
    'Pay attention to named NPCs. They usually matter again later.',
    'Short, specific actions tend to get the best GM responses.',
    'If a roll is suggested, the dice buttons and `/dice roll` both feed the GM automatically.',
    'Your inventory and conditions can matter in narrative scenes, not just combat.',
    'Use `/inventory view` before a risky scene if you want to remember your consumables.',
    'NPCs often reveal more when you press on what they are avoiding, not what they already explained.',
    'In suspicious scenes, asking who benefits is usually as useful as asking what happened.',
    'If the party splits attention well, one player can press an NPC while another inspects the scene.',
    'A failed roll can still move the story; it just tends to move it sideways.',
    'If a button option feels close but not exact, `/turn action: ...` lets you phrase your own move.',
    'The GM responds best when actions mention a concrete object, person, or threat in the scene.',
    'You can use `/dice roll` manually if you want to jump on a suggested check fast.',
    'Combat loadouts matter, but positioning and timing matter too.',
    'Conditions, exhaustion, and low HP can change how NPCs treat you.',
    'When in doubt, ask what seems out of place. That is often where the hook lives.',
    'A good opening move usually either gathers leverage or removes uncertainty.',
    'Merchants, guards, servants, and porters often notice things nobles miss.',
    'The first lie in a scene is usually easier to spot than the whole truth.',
    'Your class skills are often more useful when you describe how you use them in context.',
    'If the world feels tense, try identifying who is afraid before deciding who is dangerous.',
    'You do not need to solve the whole mystery at once. One solid clue is enough to shift momentum.',
    'When the GM names a place twice, it is probably worth checking.',
    'Sometimes the safest move is not retreat. It is forcing the other side to speak first.',
    'A short pause here usually means the GM is stitching your current state into the next beat.',
  ];
  const weaveTips = [
    'The GM is anchoring your entrance to the current scene, so a short pause is normal.',
    'Once you appear, react to the immediate tension instead of reintroducing your whole backstory.',
    'Glance at `/stats view` so you know what your character can do the moment you arrive.',
    'A strong first line usually references what your character sees or hears right now.',
    'If combat is already hot, expect your entrance to be practical and fast rather than cinematic.',
    'Mid-scene entrances work best when your character latches onto the problem already in motion.',
    'You do not need a dramatic monologue on arrival. A useful action is usually more memorable.',
    'If the party is under pressure, entering with urgency feels more natural than entering with mystery.',
    'A newcomer gains trust faster by noticing the same threat the rest of the party is facing.',
    'If you arrive during a tense conversation, interrupting with relevant information can land well.',
    'If you arrive during combat, focus on who needs help or who is about to break the line.',
    'A good weave-in usually answers one question immediately: why are you here right now?',
    'Look for the loudest danger, the most nervous NPC, or the object everyone keeps watching.',
    'You do not have to explain your full history the second you arrive. The scene can earn that later.',
    'Joining mid-session feels smoother when your first move supports the current momentum.',
    'If you are unsure how to enter, react to the environment before you react to the party.',
    'Characters tend to bond faster over shared pressure than over shared exposition.',
    'If you spot an opening to help, take it. Trust often starts there.',
    'The cleanest entrance is usually one the party can understand in a single glance.',
    'If the moment is chaotic, let your first action be readable before it is dramatic.',
  ];
  const tips = mode === 'startup' ? startupTips : weaveTips;
  const seed = `${sessionId}:${userId}:${mode}:${Math.floor(Date.now() / 4000)}`;
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(index)) | 0;
  }
  return tips[Math.abs(hash) % tips.length] ?? tips[0];
}

function buildSessionListEmbed(sessions: DndSessionRecord[]): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: 'LiteClaw DnD · Sessions' })
    .setColor(0x5E35B1)
    .setDescription(
      sessions.length > 0
        ? sessions.slice(0, 12).map(session => {
          const updatedAt = `<t:${Math.floor(session.updatedAt / 1000)}:R>`;
          return `**${session.title}** · \`${session.phase}\` · ${updatedAt}\n\`${session.id}\``;
        }).join('\n\n')
        : '*No sessions found in this guild yet.*',
    );
}

function buildCheckpointEmbed(
  session: DndSessionRecord,
  checkpoints: Array<{ id: string; note: string | null; createdBy: string; createdAt: number }>,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `Checkpoints · ${session.title}` })
    .setColor(0xFFAB00)
    .setDescription(
      checkpoints.length > 0
        ? checkpoints.map(checkpoint => {
          const when = `<t:${Math.floor(checkpoint.createdAt / 1000)}:R>`;
          const note = checkpoint.note ? ` — ${checkpoint.note}` : '';
          return `\`${checkpoint.id}\` by <@${checkpoint.createdBy}> ${when}${note}`;
        }).join('\n')
        : '*No checkpoints saved yet.*',
    );
}

function buildVoteButtons(vote: DndVoteDetails): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...vote.options.map(option =>
      new ButtonBuilder()
        .setCustomId(`${DND_BUTTON_PREFIX}${vote.vote.id}_${option.id}`)
        .setLabel(option.label)
        .setStyle(option.id === 'skip' ? ButtonStyle.Danger : ButtonStyle.Secondary),
    ),
  );
}

function formatPlayers(players: DndPlayerRecord[]): string {
  if (players.length === 0) return 'No players yet.';
  return players.map(player => {
    const sheet = parseCharacterSheet(player.characterSheetJson);
    const flags = [
      player.isHost ? '👑' : null,
      player.status === 'available' ? '🟢' : player.status === 'unavailable' ? '🔴' : '⚪',
    ].filter(Boolean).join('');
    const hp = `\`${hpBar(sheet.hp, sheet.maxHp, 8)}\``;
    const conditions = sheet.conditions.length > 0 ? ` ${formatConditions(sheet.conditions)}` : '';
    return `${flags} **${player.characterName}** (${player.className ?? '?'} Lv${sheet.level}) ${hp}${conditions}`;
  }).join('\n');
}

function formatAbilityScores(sheet: DndCharacterSheet): string {
  const abilities = sheet.abilities;
  return [
    `STR ${abilities.str}`,
    `DEX ${abilities.dex}`,
    `CON ${abilities.con}`,
    `INT ${abilities.int}`,
    `WIS ${abilities.wis}`,
    `CHA ${abilities.cha}`,
  ].join(' · ');
}

function activePlayerLabel(summary: SessionSummary | DndSessionDetails): string {
  const active = summary.players.find(player => player.userId === summary.session.activePlayerUserId);
  return active ? active.characterName : 'None';
}

function activePlayerRecord(summary: SessionSummary | DndSessionDetails): DndPlayerRecord | null {
  return summary.players.find(player => player.userId === summary.session.activePlayerUserId) ?? null;
}

function applyPlayerPortrait(
  embed: EmbedBuilder,
  player: DndPlayerRecord | null | undefined,
  label?: string | null,
): EmbedBuilder {
  const avatarUrl = player?.avatarUrl?.trim();
  if (!avatarUrl) return embed;
  embed.setThumbnail(avatarUrl);
  if (label) {
    embed.setAuthor({ name: label, iconURL: avatarUrl });
  }
  return embed;
}

function buildGenerationStatusEmbed(
  summary: SessionSummary | DndSessionDetails,
  mode: 'opening' | 'turn' | 'weave' | 'regenerate',
  player?: DndPlayerRecord | null,
): EmbedBuilder {
  const session = summary.session;
  const spotlight = player ?? activePlayerRecord(summary);
  const tipMode = mode === 'weave' ? 'weave' : 'startup';
  const tip = pickLoadingTip(session.id, spotlight?.userId ?? 'party', tipMode);
  const title = mode === 'opening'
    ? 'GM is Preparing the Opening Scene'
    : mode === 'weave'
      ? 'GM is Weaving a New Arrival'
      : mode === 'regenerate'
        ? 'GM is Reworking the Scene'
        : 'GM is Framing the Next Beat';
  const description = mode === 'opening'
    ? 'The table is ready. Give the GM a moment to stitch the world, the party, and the first hook together.'
    : mode === 'weave'
      ? `Give the GM a moment to thread ${spotlight?.characterName ?? 'the new character'} into the exact current situation.`
      : mode === 'regenerate'
        ? `The GM is rebuilding this beat in place. Give it a moment to come back sharper and cleaner.`
        : `The spotlight is moving to **${spotlight?.characterName ?? activePlayerLabel(summary)}**. Give the GM a moment to frame what happens next.`;

  const embed = new EmbedBuilder()
    .setAuthor({ name: title })
    .setColor(mode === 'weave' ? 0x3949AB : 0x5E35B1)
    .setDescription(description)
    .addFields(
      { name: 'Turn', value: `\`${session.roundNumber}.${session.turnNumber}\``, inline: true },
      { name: 'Spotlight', value: spotlight?.characterName ?? activePlayerLabel(summary), inline: true },
      { name: 'Tip', value: `*${tip}*`, inline: false },
    )
    .setFooter({ text: session.id })
    .setTimestamp(new Date(session.updatedAt));

  return applyPlayerPortrait(embed, spotlight, spotlight ? `Spotlight: ${spotlight.characterName}` : null);
}

function buildResumeNotice(summary: SessionSummary, partialParty: boolean): string {
  if (!partialParty) {
    return `${summary.session.title} resumed with the saved party state.`;
  }
  const unavailable = summary.players.filter(player => player.status === 'unavailable').map(player => player.characterName);
  if (unavailable.length === 0) {
    return `${summary.session.title} resumed. Everyone is already available.`;
  }
  return `${summary.session.title} resumed in partial-party mode. Waiting on: ${unavailable.join(', ')}.`;
}

function colorForPhase(phase: DndSessionRecord['phase']): number {
  switch (phase) {
    case 'lobby': return 0x5E35B1;
    case 'active': return 0x3949AB;
    case 'paused': return 0xFFAB00;
    case 'completed': return 0x546E7A;
    default: return 0x546E7A;
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
}

function characterFor(players: DndPlayerRecord[], userId: string): string {
  return players.find(player => player.userId === userId)?.characterName ?? 'Unknown character';
}

function labelForOption(vote: DndVoteDetails, optionId: string): string {
  return vote.options.find(option => option.id === optionId)?.label ?? optionId;
}

function tallyForDisplay(vote: DndVoteDetails): string {
  return vote.options.map(option => {
    const count = vote.ballots.filter(ballot => ballot.optionId === option.id).length;
    return `${option.label}: **${count}**`;
  }).join('\n');
}

function combatActionLabel(action: string): string {
  switch (action) {
    case 'attack': return 'Attack';
    case 'cast': return 'Cast Spell';
    case 'help': return 'Help';
    case 'dash': return 'Dash';
    case 'disengage': return 'Disengage';
    case 'custom': return 'Improvised Action';
    case 'endturn': return 'End Turn';
    default: return action;
  }
}

function shouldFallbackToNarrativeCombat(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('no usable combat action matched')
    || normalized.includes('requires ')
    || normalized.includes('is not a usable weapon')
    || normalized.includes('is not a usable combat consumable')
    || normalized.includes('has no combat behavior defined')
    || normalized.includes('unsupported combat action');
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function nextLevelThreshold(level: number): number | null {
  const thresholds = [
    0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000,
    85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000,
  ];
  return thresholds[level] ?? null;
}

function requirePlayer(players: DndPlayerRecord[], userId: string): DndPlayerRecord {
  const player = players.find(entry => entry.userId === userId);
  if (!player) {
    throw new Error('You are not part of this session.');
  }
  return player;
}

function actorFromInteraction(interaction: ChatInputCommandInteraction): DndActor {
  const memberDisplayName = interaction.member && 'displayName' in interaction.member
    ? interaction.member.displayName
    : undefined;

  return {
    userId: interaction.user.id,
    username: interaction.user.username,
    displayName: memberDisplayName ?? interaction.user.displayName ?? interaction.user.username,
  };
}

async function replyError(interaction: ChatInputCommandInteraction, message: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }
}

function randomBase36(length: number): string {
  return Math.random().toString(36).slice(2, 2 + length).padEnd(length, '0');
}

function detectDocType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop();
  switch (ext) {
    case 'pdf': return 'pdf';
    case 'md': case 'markdown': return 'lore';
    case 'txt': case 'log': return 'text';
    default: return 'text';
  }
}

function formatAbilityScoresDetailed(sheet: DndCharacterSheet): string {
  const a = sheet.abilities;
  return [
    `STR \`${String(a.str).padStart(2)}\` (${formatModifier(a.str)})`,
    `DEX \`${String(a.dex).padStart(2)}\` (${formatModifier(a.dex)})`,
    `CON \`${String(a.con).padStart(2)}\` (${formatModifier(a.con)})`,
    `INT \`${String(a.int).padStart(2)}\` (${formatModifier(a.int)})`,
    `WIS \`${String(a.wis).padStart(2)}\` (${formatModifier(a.wis)})`,
    `CHA \`${String(a.cha).padStart(2)}\` (${formatModifier(a.cha)})`,
  ].join(' · ');
}

function formatKnownSkillsDetailed(sheet: DndCharacterSheet): string {
  const skillIds = sheet.knownSkillIds ?? [];
  if (skillIds.length === 0) {
    return 'None learned yet.';
  }

  return skillIds
    .map(skillId => {
      const skill = SKILL_DEFINITIONS[skillId];
      if (!skill) {
        return `• ${skillId}`;
      }

      const usage = skill.usesPerCombat === null
        ? 'at will'
        : `${skill.usesPerCombat}/combat`;

      const effect = skill.kind === 'heal'
        ? `heals ${skill.healNotation ?? 'special'}`
        : `deals ${skill.damageNotation ?? 'special'}`;

      return `• **${skill.name}** — ${capitalize(skill.kind)}, ${effect}, ${usage}`;
    })
    .join('\n')
    .slice(0, 1024);
}

function isSpellLikeSkill(skillId: string): boolean {
  const skill = SKILL_DEFINITIONS[skillId];
  if (!skill) return false;
  if (skill.resourceKind === 'spell') return true;
  return ['wizard', 'sorcerer', 'warlock', 'cleric', 'druid', 'bard', 'paladin', 'ranger'].some(classId =>
    skill.classIds.includes(classId)
  );
}

function formatSpellsDetailed(sheet: DndCharacterSheet): string {
  const spellIds = (sheet.knownSkillIds ?? []).filter(isSpellLikeSkill);
  if (spellIds.length === 0) {
    return 'No spell-like abilities prepared.';
  }

  return spellIds.map(skillId => {
    const skill = SKILL_DEFINITIONS[skillId];
    if (!skill) return `• ${skillId}`;
    const usage = skill.usesPerCombat === null ? 'at will' : `${skill.usesPerCombat}/combat`;
    const effect = skill.kind === 'heal'
      ? `restores ${skill.healNotation ?? 'special'}`
      : `hits for ${skill.damageNotation ?? 'special'}`;
    return `• **${skill.name}** — ${effect}, ${usage}`;
  }).join('\n').slice(0, 1024);
}

function deriveStructuredSceneState(content: string): Pick<DndSceneState, 'location' | 'timeOfDay' | 'weather' | 'activeNpcs' | 'currentConflict' | 'currentObjective' | 'currentRisks' | 'partySituation'> {
  const locationMatch = content.match(/\b(?:in|inside|beneath|at|within) the ([A-Z][A-Za-z' -]{2,60})/);
  const weatherMatch = content.match(/\b(rain|storm|drizzle|snow|fog|mist|wind|heat|cold|sun|lightning)\b/i);
  const timeMatch = content.match(/\b(dawn|morning|midday|afternoon|evening|night|midnight|sunset|sunrise)\b/i);
  const npcMatches = Array.from(content.matchAll(/\b([A-Z][a-z]+) says,/g)).map(match => match[1]);
  const riskMatches = Array.from(content.matchAll(/\b(fire|blood|guards?|storm|shadow|monster|collapse|alarm|combat|danger|hiss|growl|threat)\b/gi)).map(match => match[1].toLowerCase());

  return {
    location: locationMatch?.[1]?.trim() ?? null,
    timeOfDay: timeMatch?.[1]?.toLowerCase() ?? null,
    weather: weatherMatch?.[1]?.toLowerCase() ?? null,
    activeNpcs: Array.from(new Set(npcMatches)).slice(0, 8),
    currentConflict: riskMatches.length > 0 ? `Immediate pressure involving ${Array.from(new Set(riskMatches)).slice(0, 2).join(' and ')}` : null,
    currentObjective: /\bmust|need to|have to|tasked to|brought here to\b/i.test(content) ? summarizeSentence(content) : null,
    currentRisks: Array.from(new Set(riskMatches)).slice(0, 6),
    partySituation: summarizeSentence(content),
  };
}

function summarizeSentence(content: string): string {
  const sentence = content
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .find(Boolean)
    ?? content.trim();
  return sentence.slice(0, 220);
}

function inferItemWeight(item: DndInventoryItemRecord): number {
  if (typeof item.weight === 'number' && Number.isFinite(item.weight)) {
    return item.weight;
  }
  const metadata = parseInventoryMetadata(item);
  if (metadata?.weaponId) {
    const weaponWeights: Record<string, number> = {
      greataxe: 7,
      longsword: 3,
      warhammer: 2,
      mace: 4,
      quarterstaff: 4,
      shortsword: 2,
      dagger: 1,
      shortbow: 2,
      wand: 1,
      focus: 1,
      lute: 2,
    };
    return weaponWeights[metadata.weaponId] ?? 1;
  }
  if (metadata?.consumableId) {
    const consumableWeights: Record<string, number> = {
      health_potion: 0.5,
      fire_bomb: 1,
    };
    return consumableWeights[metadata.consumableId] ?? 0.5;
  }
  return 1;
}

function summarizeEncumbrance(sheet: DndCharacterSheet, items: DndInventoryItemRecord[]): string {
  const carried = items
    .filter(item => !parseInventoryMetadata(item)?.confiscated)
    .reduce((sum, item) => sum + inferItemWeight(item) * Math.max(1, item.quantity), 0);
  const capacity = Math.max(30, sheet.abilities.str * 15);
  const ratio = carried / capacity;
  const status = ratio >= 1 ? 'Overburdened' : ratio >= 0.66 ? 'Heavy' : ratio >= 0.33 ? 'Comfortable' : 'Light';
  return `${carried.toFixed(1)} / ${capacity} lb (${status})`;
}

// ─── New Embed Builders ─────────────────────────────────────────────

function buildStatUpdateEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  field: string,
  newValue: string,
): EmbedBuilder {
  const fieldLabel = field.toUpperCase() === field ? field : capitalize(field);
  return new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Stat Updated` })
    .setColor(0x3949AB)
    .setDescription(`**${fieldLabel}** set to **${newValue}**\n\n❤️ \`${hpBar(sheet.hp, sheet.maxHp)}\` · 🛡️ **${sheet.ac}** AC${sheet.inspiration ? ' · ✨ Inspired' : ''}`)
    .setFooter({ text: session.id });
}

function buildClassSelectedEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  classDef: DndClassDef,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `${classDef.emoji} ${player.characterName} · Class Selected` })
    .setColor(0xFFC107)
    .setDescription([
      `You are now a **${classDef.name}**! *${classDef.description}*`,
      '',
      `🎲 d${classDef.hitDie} Hit Die · ⚡ ${classDef.primaryAbility} · 🛡️ ${classDef.savingThrows.join('/')}`,
      `❤️ \`${hpBar(sheet.hp, sheet.maxHp)}\` · 🛡️ **${sheet.ac}** AC · 🏃 **${sheet.speed}** ft`,
    ].join('\n'))
    .setFooter({ text: `Roll next to auto-assign · ${session.id}` });
}

function buildStatRollEmbed(
  session: DndSessionRecord,
  userId: string,
  rolled: number[],
  classDef: DndClassDef | null,
): EmbedBuilder {
  const abilityLabels = [
    'Strength',
    'Dexterity',
    'Constitution',
    'Intelligence',
    'Wisdom',
    'Charisma',
  ];
  const rollDisplay = rolled.map((val, i) =>
    `**${abilityLabels[i] ?? `Roll ${i + 1}`}:** \`${val}\` (${formatModifier(val)})`,
  ).join('\n');

  return new EmbedBuilder()
    .setAuthor({ name: '🎲 Ability Score Rolls' })
    .setColor(0xFFAB00)
    .setDescription([
      rollDisplay,
      '',
      `Values: \`${rolled.join(', ')}\``,
      '',
      classDef
        ? `Auto-assigned using **${classDef.name}** priority. Use **Adjust Stats** to override.`
        : `Choose your class next to auto-assign these values.`,
    ].join('\n'))
    .setFooter({ text: `Re-roll: /stats roll · ${session.id}` });
}

function buildAutoAssignmentEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  classDef: DndClassDef,
  rolled: number[],
  abilities: DndAbilityScores,
): EmbedBuilder {
  const mapping: Array<[string, number]> = [
    ['STR', abilities.str],
    ['DEX', abilities.dex],
    ['CON', abilities.con],
    ['INT', abilities.int],
    ['WIS', abilities.wis],
    ['CHA', abilities.cha],
  ];

  return new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Auto Assignment` })
    .setColor(0x00C853)
    .setDescription([
      `Applied **${classDef.name}** priority: \`${formatRecommendedAbilityOrder(classDef)}\``,
      '',
      mapping.map(([label, value]) => `**${label}** \`${value}\` (${formatModifier(value)})`).join(' · '),
    ].join('\n'))
    .setFooter({ text: `Adjust Stats to override · ${session.id}` });
}

function buildDocumentUploadEmbed(
  session: DndSessionRecord,
  doc: DndDocumentRecord,
): EmbedBuilder {
  const typeEmoji: Record<string, string> = {
    pdf: '📜', lore: '📖', transcript: '📝', text: '📄',
  };
  return new EmbedBuilder()
    .setAuthor({ name: `📜 Document Ingested` })
    .setColor(0x00C853)
    .setDescription(`**${doc.filename}** added to campaign knowledge.`)
    .addFields(
      { name: 'ID', value: `\`${doc.id}\``, inline: true },
      { name: 'Type', value: doc.sourceType, inline: true },
      { name: 'Chunks', value: `${doc.chunkCount}`, inline: true },
    )
    .setFooter({ text: session.id });
}

function buildDocumentListEmbed(
  session: DndSessionRecord,
  docs: DndDocumentRecord[],
): EmbedBuilder {
  const typeEmoji: Record<string, string> = {
    pdf: '📜', lore: '📖', transcript: '📝', text: '📄',
  };

  const list = docs.length > 0
    ? docs.slice(0, 15).map(doc => {
      const emoji = typeEmoji[doc.sourceType] ?? '📄';
      const when = `<t:${Math.floor(doc.uploadedAt / 1000)}:R>`;
      return `${emoji} **${doc.filename}** — \`${doc.id}\` · ${doc.chunkCount} chunks · ${when}`;
    }).join('\n')
    : 'No documents have been uploaded to this session yet.\nUse `/lore upload` to add campaign PDFs, lore docs, or transcripts.';

  return new EmbedBuilder()
    .setAuthor({ name: `📚 Campaign Lore · ${session.title}` })
    .setColor(0x7C4DFF)
    .setDescription(list)
    .setFooter({ text: `${docs.length} document${docs.length !== 1 ? 's' : ''}` });
}

function buildLoreSearchEmbed(
  session: DndSessionRecord,
  query: string,
  context: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `🔍 Lore Search · "${query}"` })
    .setColor(0x7C4DFF)
    .setDescription(context.slice(0, 4000))
    .setFooter({ text: session.id });
}

function buildRestEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  restType: 'short' | 'long',
  hpRegained: number,
  hitDiceUsed = 0,
  conditionsCleared: string[] = [],
  exhaustionReduced = false,
): EmbedBuilder {
  const emoji = restType === 'short' ? '🏕️' : '🌙';
  const label = restType === 'short' ? 'Short Rest' : 'Long Rest';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${emoji} ${label} · ${player.characterName}` })
    .setColor(restType === 'short' ? 0xFFAB00 : 0x43A047)
    .setDescription(`❤️ \`${hpBar(sheet.hp, sheet.maxHp)}\` · +${hpRegained} HP regained`);

  if (restType === 'short' && hitDiceUsed > 0) {
    embed.addFields({ name: '🎲 Hit Dice Spent', value: `${hitDiceUsed}`, inline: true });
  }

  if (conditionsCleared.length > 0) {
    embed.addFields({ name: '✨ Conditions Cleared', value: formatConditions(conditionsCleared), inline: true });
  }

  if (exhaustionReduced) {
    embed.addFields({ name: '😮‍💨 Exhaustion', value: `Reduced by 1 → ${exhaustionDisplay(sheet.exhaustion)}`, inline: false });
  }

  embed.setFooter({ text: `Session: ${session.title}` });
  return embed;
}

function buildConditionEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  action: 'add' | 'remove',
  conditionName: string,
): EmbedBuilder {
  const emoji = action === 'add' ? '🔥' : '✨';
  const verb = action === 'add' ? 'Applied' : 'Removed';
  const currentConditions = sheet.conditions.length > 0
    ? formatConditions(sheet.conditions)
    : '— None';

  return new EmbedBuilder()
    .setAuthor({ name: `${emoji} Condition ${verb} · ${player.characterName}` })
    .setColor(action === 'add' ? 0xD50000 : 0x43A047)
    .setDescription(`**${conditionName}** ${verb.toLowerCase()}.\n\n❤️ \`${hpBar(sheet.hp, sheet.maxHp)}\`${sheet.conditions.length > 0 ? `\n🔥 ${currentConditions}` : ''}`)
    .setFooter({ text: session.id });
}

function buildInventoryEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  gold: number,
  items: DndInventoryItemRecord[],
): EmbedBuilder {
  const sheet = parseCharacterSheet(player.characterSheetJson);
  const accessibleItems = items.filter(item => !parseInventoryMetadata(item)?.confiscated);
  const confiscatedItems = items.filter(item => parseInventoryMetadata(item)?.confiscated);
  const encumbrance = summarizeEncumbrance(sheet, items);
  const lines = accessibleItems.length > 0
    ? accessibleItems.slice(0, 20).map(item => {
      const metadata = parseInventoryMetadata(item);
      const weapon = metadata?.weaponId ? getWeaponDefinition(metadata.weaponId) : null;
      const equipped = sheet.equippedWeaponItemId === item.id ? ' - equipped' : '';
      const category = item.category ? ` - ${item.category}` : '';
      const notes = item.notes ? ` - ${item.notes}` : '';
      const consumable = item.consumable ? ' - consumable' : '';
      const weight = ` - ${inferItemWeight(item) * Math.max(1, item.quantity)} lb`;
      const detail = weapon
        ? ` - ${weapon.attackAbility.toUpperCase()} to hit - ${weapon.damageNotation}`
        : metadata?.consumableId
          ? ` - ${metadata.consumableId.replace(/_/g, ' ')}`
          : '';
      return `\`${item.id}\` **${item.name}** x${item.quantity}${equipped}${category}${consumable}${detail}${weight}${notes}`;
    }).join('\n')
    : 'No accessible items right now.';
  const confiscated = confiscatedItems.length > 0
    ? confiscatedItems.slice(0, 10).map(item => {
      const metadata = parseInventoryMetadata(item);
      const storedAt = metadata?.storedAt ? ` - ${metadata.storedAt}` : '';
      return `\`${item.id}\` **${item.name}** x${item.quantity}${storedAt}`;
    }).join('\n')
    : 'None.';

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Inventory` })
    .setColor(0x00C853)
    .addFields(
      { name: 'Gold', value: `${gold} gp`, inline: true },
      { name: 'Items', value: `${items.length}`, inline: true },
      { name: 'Carry', value: encumbrance, inline: true },
      { name: 'Equipped', value: formatEquippedLoadout(sheet, items), inline: false },
      { name: 'Accessible', value: lines, inline: false },
    );

  if (confiscatedItems.length > 0) {
    embed.addFields({ name: 'Confiscated', value: confiscated, inline: false });
  }

  embed.setFooter({ text: session.id });
  return applyPlayerPortrait(embed, player, `${player.characterName}`);
}

function buildSkillsEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Skills` })
    .setColor(0x3949AB)
    .setDescription(formatKnownSkillsDetailed(sheet))
    .setFooter({ text: session.id });
  return applyPlayerPortrait(embed, player, `${player.characterName}`);
}

function buildSpellsEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Spells` })
    .setColor(0x7C4DFF)
    .setDescription(formatSpellsDetailed(sheet))
    .setFooter({ text: session.id });
  return applyPlayerPortrait(embed, player, `${player.characterName}`);
}

function buildAvatarEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  notice?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Portrait` })
    .setColor(0x3949AB)
    .setDescription(notice ?? '*Manage how your character appears.*')
    .addFields(
      { name: 'Source', value: player.avatarSource ?? 'class_default', inline: true },
    )
    .setFooter({ text: session.id });

  if (player.avatarUrl) {
    embed.setImage(player.avatarUrl);
  }

  return applyPlayerPortrait(embed, player, `${player.characterName} - portrait`);
}

function buildInventoryItemAddedEmbed(
  session: DndSessionRecord,
  item: DndInventoryItemRecord,
  targetUserId: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: 'Item Added' })
    .setColor(0x00C853)
    .setDescription(`**${item.name}** ×${item.quantity} → <@${targetUserId}>`)
    .addFields(
      { name: 'ID', value: `\`${item.id}\``, inline: true },
      { name: 'Type', value: `${item.category ?? '—'}${item.consumable ? ' · consumable' : ''}`, inline: true },
    )
    .setFooter({ text: session.id });
}

function buildInventorySpendEmbed(
  session: DndSessionRecord,
  item: DndInventoryItemRecord | null,
  spent: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: 'Item Spent' })
    .setColor(0xFFAB00)
    .setDescription(item
      ? `Used from **${item.name}**. **${item.quantity}** remaining.`
      : `Last item consumed.`)
    .setFooter({ text: session.id });
}

function buildInventoryDropEmbed(
  session: DndSessionRecord,
  item: DndInventoryItemRecord | null,
  removed: number,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: 'Item Removed' })
    .setColor(0x546E7A)
    .setDescription(item
      ? `Removed ${removed} from **${item.name}**. **${item.quantity}** remaining.`
      : `Removed the final ${removed} item(s).`)
    .setFooter({ text: session.id });
}

function buildGoldSpendEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  spent: number,
  reason: string | null,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Gold Spent` })
    .setColor(0xFFC107)
    .setDescription(reason ? `**${spent}** gp on ${reason}. **${sheet.gold}** gp remaining.` : `**${spent}** gp spent. **${sheet.gold}** gp remaining.`)
    .setFooter({ text: session.id });
}

function buildShopEmbed(
  session: DndSessionRecord,
  shop: DndShopRecord,
  items: DndShopItemRecord[],
  description: string,
): EmbedBuilder {
  const lines = items.length > 0
    ? items.slice(0, 20).map(item => {
      const details = [
        `${item.priceGp} gp`,
        `stock ${item.stock}`,
        item.category,
      ].filter(Boolean).join(' · ');
      const notes = item.notes ? `\n${item.notes}` : '';
      return `\`${item.id}\` **${item.name}** · ${details}${notes}`;
    }).join('\n\n')
    : 'This shop is out of stock.';

  return new EmbedBuilder()
    .setAuthor({ name: `📜 ${shop.name}` })
    .setColor(0x7C4DFF)
    .setDescription([description, shop.description].filter(Boolean).join('\n\n'))
    .addFields(
      { name: 'Wares', value: lines, inline: false },
    )
    .setFooter({ text: session.id });
}

function buildShopPurchaseEmbed(
  session: DndSessionRecord,
  result: {
    shop: DndShopRecord;
    item: DndShopItemRecord;
    purchasedQuantity: number;
    totalCost: number;
    player: DndPlayerRecord;
    sheet: DndCharacterSheet;
    inventoryItem: DndInventoryItemRecord;
  },
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `${result.player.characterName} · Purchase` })
    .setColor(0x00C853)
    .setDescription(`**${result.item.name}** ×${result.purchasedQuantity} from **${result.shop.name}** for **${result.totalCost} gp**.`)
    .addFields(
      { name: 'Gold', value: `${result.sheet.gold} gp`, inline: true },
      { name: 'Stock', value: `${result.item.stock}`, inline: true },
    )
    .setFooter({ text: session.id });
}

function parseShopItemsInput(raw: string): Array<{
  name: string;
  priceGp: number;
  stock: number;
  category?: string | null;
  notes?: string | null;
}> {
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const items = lines.map((line, index) => {
    const [name, price, stock, category, ...noteParts] = line.split('|').map(part => part.trim());
    if (!name || !price || !stock) {
      throw new Error(`Shop item line ${index + 1} must use: name|price|stock|category|notes`);
    }
    const priceGp = Number(price);
    const stockCount = Number(stock);
    if (!Number.isFinite(priceGp) || priceGp < 0) {
      throw new Error(`Invalid price on shop line ${index + 1}.`);
    }
    if (!Number.isFinite(stockCount) || stockCount < 0) {
      throw new Error(`Invalid stock on shop line ${index + 1}.`);
    }
    return {
      name,
      priceGp: Math.floor(priceGp),
      stock: Math.floor(stockCount),
      category: category || null,
      notes: noteParts.join('|').trim() || null,
    };
  });

  if (items.length === 0) {
    throw new Error('Provide at least one shop item.');
  }
  return items;
}

function buildDowntimeResultEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  record: DndDowntimeRecord,
  progress: DndDowntimeProgressRecord[],
): EmbedBuilder {
  const activeProgress = progress
    .filter(entry => !entry.completedAt && entry.progress < entry.target)
    .slice(0, 4)
    .map(entry => `${entry.label}: ${entry.progress}/${entry.target}`)
    .join('\n');

  const goldLine = record.goldDelta === 0
    ? `${record.goldAfter} gp`
    : `${record.goldAfter} gp (${record.goldDelta > 0 ? '+' : ''}${record.goldDelta} gp)`;

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Downtime` })
    .setColor(0xFFC107)
    .setDescription(record.summary)
    .addFields(
      { name: 'Activity', value: `${humanizeDowntimeActivity(record.activityId)}${record.focus ? ` — ${record.focus}` : ''}`, inline: false },
      { name: 'Time', value: formatDowntimeWindow(record), inline: true },
      { name: 'Gold', value: goldLine, inline: true },
      { name: 'Next', value: `<t:${Math.floor(record.cooldownUntil / 1000)}:R>`, inline: true },
      { name: 'HP', value: `\`${hpBar(sheet.hp, sheet.maxHp, 8)}\``, inline: false },
    );

  if (activeProgress) {
    embed.addFields({ name: 'Projects', value: activeProgress, inline: false });
  }

  return embed.setFooter({ text: session.id });
}

function buildDowntimeStatusEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  latest: DndDowntimeRecord | null,
  progress: DndDowntimeProgressRecord[],
): EmbedBuilder {
  const progressLine = progress.length > 0
    ? progress.slice(0, 6).map(entry => {
      const status = entry.completedAt ? 'Complete' : `${entry.progress}/${entry.target}`;
      return `${entry.label}: ${status}`;
    }).join('\n')
    : 'No ongoing projects.';

  const cooldownLine = latest
    ? latest.cooldownUntil > Date.now()
      ? `<t:${Math.floor(latest.cooldownUntil / 1000)}:R>`
      : 'Ready now'
    : 'Ready now';

  return new EmbedBuilder()
    .setAuthor({ name: `${player.characterName} · Downtime Status` })
    .setColor(0x3949AB)
    .addFields(
      { name: 'Gold', value: `${sheet.gold} gp`, inline: true },
      { name: 'Next', value: cooldownLine, inline: true },
      { name: 'Phase', value: capitalize(session.phase), inline: true },
      { name: 'Latest', value: latest ? latest.summary : '*No downtime recorded yet.*', inline: false },
      { name: 'Projects', value: progressLine, inline: false },
    )
    .setFooter({ text: session.id });
}

function buildDowntimeHistoryEmbed(
  session: DndSessionRecord,
  records: DndDowntimeRecord[],
): EmbedBuilder {
  const body = records.length > 0
    ? records.map(record => {
      const when = `<t:${Math.floor(record.createdAt / 1000)}:R>`;
      const gold = record.goldDelta === 0 ? '' : ` · ${record.goldDelta > 0 ? '+' : ''}${record.goldDelta} gp`;
      return `**${humanizeDowntimeActivity(record.activityId)}**${record.focus ? ` - ${record.focus}` : ''}${gold}\n${record.summary}\n${when}`;
    }).join('\n\n')
    : 'No downtime history yet.';

  return new EmbedBuilder()
    .setAuthor({ name: `Downtime History · ${session.title}` })
    .setColor(0x546E7A)
    .setDescription(body);
}

function humanizeDowntimeActivity(activityId: DndDowntimeRecord['activityId']): string {
  switch (activityId) {
    case 'religious_service':
      return 'Religious Service';
    default:
      return activityId.split('_').map(capitalize).join(' ');
  }
}

function buildInspirationEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  grantedByUserId: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `✨ Inspiration · ${player.characterName}` })
    .setColor(0xFFC107)
    .setDescription(`<@${grantedByUserId}> granted inspiration to **${player.characterName}**.${sheet.inspiration ? ' ⭐ Ready to spend.' : ''}`)
    .setFooter({ text: session.id });
}

function buildDeathSaveEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  event: string,
  roll: number,
  usedInspiration: boolean,
): EmbedBuilder {
  const tracker = formatDeathSaveTracker(sheet);
  return new EmbedBuilder()
    .setAuthor({ name: `☠️ Death Save · ${player.characterName}` })
    .setColor(sheet.deathSaves.dead ? 0x212121 : sheet.hp > 0 ? 0x00C853 : 0x212121)
    .setDescription(`${event}\n\n🎲 **${roll}**${usedInspiration ? ' (inspired)' : ''} · HP ${sheet.hp}/${sheet.maxHp}\n${tracker}`)
    .setFooter({ text: session.id });
}

function buildDeathSaveStatusEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `☠️ Death Save Status · ${player.characterName}` })
    .setColor(0x212121)
    .setDescription(`HP ${sheet.hp}/${sheet.maxHp} · ${sheet.deathSaves.dead ? '**Dead**' : sheet.deathSaves.stable ? 'Stable' : 'Dying'}\n${formatDeathSaveTracker(sheet)}`)
    .setFooter({ text: session.id });
}

function buildDeathSaveDamageEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
  damage: number,
  critical: boolean,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `☠️ Death Save Damage · ${player.characterName}` })
    .setColor(sheet.deathSaves.dead ? 0x212121 : 0xD50000)
    .setDescription(`**${damage}** damage${critical ? ' (critical)' : ''} at 0 HP → ${critical ? 'two' : 'one'} automatic failure${critical ? 's' : ''}.\n${formatDeathSaveTracker(sheet)}`)
    .setFooter({ text: session.id });
}

function buildDeathSaveResetEmbed(
  session: DndSessionRecord,
  player: DndPlayerRecord,
  sheet: DndCharacterSheet,
): EmbedBuilder {
  return new EmbedBuilder()
    .setAuthor({ name: `Death Saves Reset · ${player.characterName}` })
    .setColor(0x546E7A)
    .setDescription(`HP ${sheet.hp}/${sheet.maxHp}\n${formatDeathSaveTracker(sheet)}`)
    .setFooter({ text: session.id });
}

function formatDeathSaveTracker(sheet: DndCharacterSheet): string {
  const state = sheet.deathSaves;
  const successes = '✅'.repeat(state.successes) + '⬜'.repeat(Math.max(0, 3 - state.successes));
  const failures = '❌'.repeat(state.failures) + '⬜'.repeat(Math.max(0, 3 - state.failures));
  const status = state.dead ? 'Dead' : state.stable ? 'Stable' : 'Dying';
  return `Successes: ${successes}\nFailures: ${failures}\nStatus: ${status}`;
}


function formatEquippedLoadout(sheet: DndCharacterSheet, items: DndInventoryItemRecord[]): string {
  const accessibleItems = items.filter(item => !parseInventoryMetadata(item)?.confiscated);
  const equippedItem = sheet.equippedWeaponItemId
    ? accessibleItems.find(item => item.id === sheet.equippedWeaponItemId)
    : accessibleItems.find(item => parseInventoryMetadata(item)?.weaponId);
  const equippedMeta = equippedItem ? parseInventoryMetadata(equippedItem) : null;
  const weapon = equippedMeta?.weaponId ? getWeaponDefinition(equippedMeta.weaponId) : null;
  const skillNames = (sheet.knownSkillIds ?? [])
    .map(skillId => SKILL_DEFINITIONS[skillId]?.name ?? skillId)
    .slice(0, 3);
  const consumables = items
    .filter(item => !parseInventoryMetadata(item)?.confiscated && Boolean(parseInventoryMetadata(item)?.consumableId))
    .slice(0, 3)
    .map(item => `${item.name} x${item.quantity}`);

  const parts = [
    weapon
      ? `Weapon: **${weapon.name}** (${weapon.attackAbility.toUpperCase()}, ${weapon.damageNotation})`
      : 'Weapon: none equipped',
    skillNames.length > 0 ? `Skills: ${skillNames.join(', ')}` : 'Skills: none learned',
    consumables.length > 0 ? `Consumables: ${consumables.join(', ')}` : 'Consumables: none',
  ];

  return parts.join('\n').slice(0, 1024);
}

function hasUsableCombatLoadout(sheet: DndCharacterSheet, items: DndInventoryItemRecord[]): boolean {
  const hasSkills = (sheet.knownSkillIds?.length ?? 0) > 0;
  const hasWeapon = items.some(item => !parseInventoryMetadata(item)?.confiscated && Boolean(parseInventoryMetadata(item)?.weaponId));
  return hasSkills && hasWeapon;
}

function summarizeLoadout(sheet: DndCharacterSheet, items: DndInventoryItemRecord[]): string {
  const accessibleItems = items.filter(item => !parseInventoryMetadata(item)?.confiscated);
  const equippedItem = sheet.equippedWeaponItemId
    ? accessibleItems.find(item => item.id === sheet.equippedWeaponItemId)
    : accessibleItems.find(item => parseInventoryMetadata(item)?.weaponId);
  const weaponName = equippedItem?.name ?? 'no weapon equipped';
  const skills = (sheet.knownSkillIds ?? [])
    .map(skillId => SKILL_DEFINITIONS[skillId]?.name ?? skillId)
    .slice(0, 3)
    .join(', ') || 'no learned skills';
  return `ready with **${weaponName}** and skills: ${skills}`;
}


function formatDowntimeWindow(record: DndDowntimeRecord): string {
  const totalMinutes = Math.max(1, Math.round(record.durationDays * 24 * 60));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalMinutes % 60 === 0) return `${Math.floor(totalMinutes / 60)}h`;
  return `${(totalMinutes / 60).toFixed(1)}h`;
}
