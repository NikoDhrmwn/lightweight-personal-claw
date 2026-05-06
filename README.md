# LiteClaw

Lightweight agent runtime for local LLMs with WebUI, Discord, and WhatsApp support.

Designed for small models like Gemma 4 E4B running on consumer GPUs. LiteClaw aims to be a lighter alternative to OpenClaw while keeping a familiar workflow and migration path.

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


### [0.8.2] - 2026-05-05

#### Added

- **Model Context Protocol (MCP)**: Native client support for MCP servers.
    - Automated tool discovery and registration from MCP servers.
    - Added `mcp_list`, `mcp_get_resource`, and `mcp_call_tool` utilities.
    - Integrated MCP session management into the core engine.
    - Support for GitHub MCP via Copilot API.

### [0.8.1] - 2026-05-04

#### Fixed

- **Gemini Tool Calling**: Resolved issues where Gemini models would fail or behave inconsistently during tool interactions.
    - Ensured the `name` field is explicitly included in tool result messages for native Google API compatibility.
    - Implemented tool result content normalization to strip internal `<tool_result>` envelopes and recovery/system nudges before sending to the model.
    - Improved tool call deduplication by including `extra_content` (parameters not in the core function schema) in the deduplication signature.

### [0.8.0] - 2026-04-29

#### Added

- **Gateway Auth Hardening**: Mandated Bearer tokens on all `/api/*` routes when bound to non-loopback interfaces.
- **Resource Limits**: Implemented 10-file and 20MB attachment limits per request in the WebUI gateway.
- **Extraction Timeouts**: Added a 30-second processing timeout and 500,000-character extraction cap to document ingestion.
- **Structured Exec Mode**: Refactored the `exec` tool to use `bin` and `args` parameters by default instead of vulnerable shell strings.
- **Tool Enforcement**: Implemented granular enablement checks to prevent disabled tool categories from being accessed or lazy-loaded.

### [0.7.2] - 2026-04-29

#### Added

- **Workspace Path Safety**: Implemented a centralized `workspace.ts` path resolver with absolute path opt-in and path traversal (`../`) blocking to contain execution within the project root.
- **Tool Path Validation**: All filesystem operations (`read_file`, `write_file`, etc.) and `exec` cwd arguments now enforce secure workspace containment.


## Features

- **Autonomous Task Planner**: Breaks down complex requests into multi-step executable plans.
- **Smart Context Management**: Lazy tool loading, compaction, and rolling history to stay within model context limits.
- **Multi-Channel**: Native support for WebUI, Discord, and WhatsApp.
- **Discord DnD Sessions**: New slash-command workflow for multiplayer session threads, persistent player rosters, join/resume flows, partial-party resumes, and vote-based turn skipping.
- **Core Tools**: Filesystem access, command execution, web search/fetch, and native vision.
- **MCP Integrations**: Connect external MCP servers and expose their tools, prompts, and resources to the agent.
- **Safety First**: Cross-channel confirmations for destructive or sensitive actions.
- **Skills System**: Project-level skills support with selective prompt injection.

## Discord DnD Commands

LiteClaw now includes a lightweight DnD session subsystem for Discord:

- `/dnd start` creates a dedicated session thread and opens the lobby.
- `/dnd join` joins the current or specified session with a character profile, including joining midway through an active session.
- `/dnd begin` starts play and establishes turn order.
- `/dnd save` pauses the session and stores a checkpoint in SQLite.
- `/dnd resume` restores a saved session into the current thread, including partial-party mode.
- `/dnd restore` restores a specific checkpoint by checkpoint ID.
- `/dnd list` shows resumable sessions in the current guild.
- `/dnd checkpoints` lists saved checkpoints for a session.
- `/dnd available` and `/dnd unavailable` toggle whether your turns should be skipped.
- `/stats` shows your persistent character sheet, level, and XP progress.
- `/quest complete` and `/quest log` track quest completions and XP rewards.
- `/combat enter`, `/combat status`, `/combat menu`, and `/combat end` manage initiative and active-turn combat controls.
- `/vote skip-turn` opens a party vote to skip a player who is unavailable.
- `/end-turn` advances to the next available player.
- `/question` asks the GM an out-of-band question tied to the current DnD session without consuming a turn or polluting the main session context.
- `/question mode:private|public` controls whether the answer stays private or is visible to the table.

### DnD RAG Notes

- LiteClaw stores DnD retrieval data in its state directory and uses a local embedding server for session-aware GM answers.
- Configure any local embedding bootstrap command in your LiteClaw state/config files instead of hardcoding machine-specific paths.
- Starting or refreshing a DnD session can ensure the configured embedding server is running before syncing session context.

## Quick Start

```bash
git clone https://github.com/NikoDhrmwn/liteclaw.git
cd liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

Open `http://localhost:7860` for the Web UI.

For guided first-time setup with recommendations for local 4B-9B models:

```bash
npx tsx src/cli.ts setup --interactive
```

## Windows Setup

LiteClaw works well from Windows Terminal, PowerShell, or Command Prompt.

### PowerShell

```powershell
git clone https://github.com/NikoDhrmwn/liteclaw.git
Set-Location liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

### Command Prompt

```bat
git clone https://github.com/NikoDhrmwn/liteclaw.git
cd liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

### Batch launcher

If you prefer a double-clickable launcher on Windows:

```bat
start-liteclaw.bat
```

That script installs dependencies if needed and starts LiteClaw from the project folder.

## First-Time Configuration

Initialize the local state directory:

```bash
npx tsx src/cli.ts setup
```

Or run the guided onboarding wizard:

```bash
npx tsx src/cli.ts init
```

This creates your LiteClaw state under:

- Windows: `%USERPROFILE%\.liteclaw`

Then put your secrets in:

```text
%USERPROFILE%\.liteclaw\.env
```

Example values:

```env
DISCORD_TOKEN=
GOOGLE_API_KEY=
GATEWAY_TOKEN=
GITHUB_PERSONAL_ACCESS_TOKEN=
LLM_BASE_URL=http://localhost:8080/v1
LLM_API_KEY=sk-local
LLM_MODEL=gemma-4-e4b-heretic
```

You can use the project-root [.env.example](.env.example) as a reference.

## Prompt and Personality Customization

LiteClaw ships neutral, universal prompt templates by default. User-editable prompt files live in:

```text
%USERPROFILE%\.liteclaw\personality\
```

Recommended prompt commands:

```bash
npx tsx src/cli.ts prompts list
npx tsx src/cli.ts prompts doctor
npx tsx src/cli.ts prompts edit system
npx tsx src/cli.ts prompts edit behavior
npx tsx src/cli.ts prompts reset --profile neutral
```

Use `prompts doctor` after edits. It flags oversized prompts, personal machine paths, unsafe instructions, and reliability issues that commonly hurt smaller local models.

## Running LiteClaw

Start the gateway and WebUI:

```bash
npx tsx src/cli.ts gateway run
```

Or, after building:

```bash
npm run build
node dist/cli.js gateway run
```

Useful terminal commands:

```bash
npx tsx src/cli.ts doctor
npx tsx src/cli.ts mcp list
npx tsx src/cli.ts mcp add github
npx tsx src/cli.ts status
npx tsx src/cli.ts channels status
npx tsx src/cli.ts message "hello"
```

## MCP Setup

LiteClaw 0.8.2 adds native MCP client support. MCP tools are discovered at startup and injected into the agent like built-in tools, while MCP prompts and resources are available through `mcp_*` utility tools.

### Quick GitHub setup

```bash
liteclaw mcp add github
liteclaw mcp login github
liteclaw mcp doctor
```

The GitHub preset uses the official remote GitHub MCP endpoint:

```text
https://api.githubcopilot.com/mcp/
```

Credentials are stored in your LiteClaw state `.env` as:

```env
GITHUB_PERSONAL_ACCESS_TOKEN=...
```

After setup, GitHub MCP tools will appear to the agent with a `github_` prefix, making tasks like pull requests, issue work, and repository review available through the normal tool-calling flow.

## Migrating From OpenClaw

If you already use OpenClaw, LiteClaw can import configuration and local state.

### Default migration

```bash
npx tsx src/cli.ts migrate
```

This attempts to import from the default OpenClaw directory:

- Windows: `%USERPROFILE%\.openclaw`

### Custom migration path

```powershell
npx tsx src/cli.ts migrate --openclaw-dir "/path/to/.openclaw"
```

Migration can bring over:

- model configuration
- Discord and WhatsApp channel config
- WhatsApp session files when present
- memory database
- personality files from the OpenClaw workspace

After migrating, review:

- `%USERPROFILE%\.liteclaw\config.yaml`
- `%USERPROFILE%\.liteclaw\.env`
- `%USERPROFILE%\.liteclaw\personality\`

## Common Commands

```bash
liteclaw gateway run
liteclaw init
liteclaw channels login --channel discord
liteclaw channels login --channel whatsapp
liteclaw channels status
liteclaw status
liteclaw doctor
liteclaw mcp list
liteclaw mcp add github
liteclaw mcp login github
liteclaw prompts list
liteclaw prompts doctor
liteclaw prompts edit system
liteclaw prompts edit behavior
liteclaw config get <key>
liteclaw models list
liteclaw message "hello"
liteclaw migrate
```

If you have not installed the global CLI yet, use the same commands through `npx tsx src/cli.ts ...`.

Examples:

```bash
npx tsx src/cli.ts channels login --channel discord
npx tsx src/cli.ts channels login --channel whatsapp
npx tsx src/cli.ts mcp doctor
npx tsx src/cli.ts config get gateway.port
npx tsx src/cli.ts models list
```

## Requirements

- Node.js >= 20
- A running LLM backend such as llama-server or Ollama, or a compatible hosted provider
- Discord bot token for Discord usage
- A linked phone for WhatsApp usage

## Security Notes

- Keep secrets in your LiteClaw state directory `.env`, not in the repository root.
- Do not commit runtime logs, SQLite databases, or WhatsApp session files.
- Review [SECURITY.md](SECURITY.md) before publishing a fork or deployment.
