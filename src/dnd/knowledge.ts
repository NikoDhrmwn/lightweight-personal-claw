export interface DndKnowledgeChunk {
  key: string;
  title: string;
  content: string;
}

export const DND_SYSTEM_KNOWLEDGE: DndKnowledgeChunk[] = [
  {
    key: 'overview',
    title: 'LiteClaw DnD System Overview',
    content: [
      'LiteClaw DnD is a Discord-first session system with persistent session state, player rosters, checkpoints, combat, inventory, downtime, shops, voting, and lore search.',
      'DnD sessions live inside Discord threads and are isolated by session/thread so one campaign does not bleed into another.',
      'The GM should treat slash commands and persisted state as the source of truth for what the system can do.',
      'When a player asks how the bot works, answer using these system notes and avoid inventing unsupported commands.',
    ].join('\n'),
  },
  {
    key: 'session_commands',
    title: 'Session Commands',
    content: [
      '/dnd start: Host creates a session thread and opens the lobby.',
      '/dnd join: Player joins a session and starts guided onboarding.',
      '/dnd begin: Host begins the session once the lobby is ready.',
      '/dnd save: Host saves a checkpoint and pauses the session.',
      '/dnd resume: Host resumes a saved session in the current thread.',
      '/dnd restore: Host restores a specific checkpoint by checkpoint ID.',
      '/dnd status: Show current session snapshot.',
      '/dnd list: List resumable sessions in the guild.',
      '/dnd checkpoints: List checkpoints for a session.',
      '/dnd available and /dnd unavailable: Toggle whether the player can take turns.',
      '/dnd end: Host ends the session.',
      '/dnd end-turn: Active player ends their turn.',
      '/dnd skip-vote: Start a party vote to skip an unavailable player.',
      '/dnd quest-complete and /dnd quest-log: Track quest rewards and recent progression.',
    ].join('\n'),
  },
  {
    key: 'player_commands',
    title: 'Player Sheet and Progression Commands',
    content: [
      '/stats view: Show the full character sheet.',
      '/stats set: Edit HP, AC, notes, inspiration, or ability scores.',
      '/stats class: Choose or change class.',
      '/stats roll: Roll a fresh ability score array.',
      '/stats short-rest and /stats long-rest: Resolve rest mechanics.',
      '/stats condition: Add or remove a DnD condition.',
      '/stats exhaustion: Set exhaustion level from 0 to 6.',
      '/inventory view, add, spend-item, drop, spend-gold: Manage items and gold.',
      '/downtime do, status, history: Manage between-session downtime.',
      '/inspire: Grant inspiration to a party member when allowed.',
      '/death-save roll, status, damage, reset: Track death saving throws.',
    ].join('\n'),
  },
  {
    key: 'combat_and_party',
    title: 'Combat, Voting, Dice, and Shops',
    content: [
      '/combat enter: Enter combat and roll initiative.',
      '/combat status: Show the current combat order.',
      '/combat menu: Repost the active-turn action menu.',
      '/combat end: End combat and optionally award XP.',
      '/vote: Create a public party decision vote outside combat.',
      '/dice: Roll dice notation like d20, 2d6+3, or 4d6kh3.',
      '/shop open: Host opens a shop with line-based inventory input.',
      '/shop view: Show the currently active shop.',
      '/shop buy: Purchase an item from the active shop.',
      '/shop close: Host closes the active shop.',
      'The GM may also open or close shops automatically from structured narrative output when merchant scenes appear.',
    ].join('\n'),
  },
  {
    key: 'lore_and_questions',
    title: 'Lore Search and GM Question Commands',
    content: [
      '/lore upload: Upload a PDF, markdown, transcript, or text file into session RAG.',
      '/lore list: List ingested documents for the session.',
      '/lore search: Search the campaign knowledge base.',
      '/question: Ask the GM an out-of-band question about the current DnD session without consuming an in-world action.',
      '/question mode:private keeps the reply private to the player.',
      '/question mode:public lets the table see the answer.',
      'Normal player table-talk in a protected DnD thread can also be answered by the GM agent and should use session RAG context.',
    ].join('\n'),
  },
  {
    key: 'onboarding_faq',
    title: 'Onboarding and Lobby FAQ',
    content: [
      'Joining now opens guided onboarding: roll stats, choose class, assign rolled values, then ready up in the lobby.',
      'Players cannot mark themselves ready until onboarding is complete.',
      'Hosts are created with the session and are not blocked by the player onboarding gate.',
      'If a player asks what to do next during onboarding, tell them the next unlocked step in the setup message.',
    ].join('\n'),
  },
];
