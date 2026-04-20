# LiteClaw

Lightweight agent runtime for local LLMs with WebUI, Discord, and WhatsApp support.

Designed for small models like Gemma 4 E4B running on consumer GPUs. LiteClaw aims to be a lighter alternative to OpenClaw while keeping a familiar workflow and migration path.

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### [0.2.0] - 2026-04-20

#### Added

- Fresh, lightweight **OpenClaw-style WebUI overhaul** with a responsive slim sidebar interface.
- Distinctly aligned message bubbles in WebUI: user right-aligned (accented), assistant left-aligned.
- Native injection of `{{STATE_DIR}}` into system prompts for robust agent workspace awareness.

#### Changed

- **Privacy-First Personality**: Personalized files in `config/personality/` are now git-ignored. Added `*.template.md` files for repo consistency—copy them to `.md` to customize your bot's soul without leaking it to GitHub.
- **Dynamic Name Logic**: Added `agent.name` to `config.yaml`. Use this to set your bot's callsign (e.g., "Molty Bot") for reliable @mention detection across all channels.
- **WhatsApp Group Context**: Messages in group chats are now saved to memory silently even when you don't tag the bot, so it has context when you finally address it.
- **Configurable History**: Added `agent.historyMessageLimit` to `config.yaml` to control how many previous messages are sent to the LLM (default: 20).
- **Response Formatting**: Added strict constraints to `system_prompt.md` to prevent "internal monologue" or action-narration spam (no more `(Thinking...)` text).
- Replaced noisy JSON metadata blocks in Discord and WhatsApp with a compact, minimal-token context header.
- Streamlined agent tagging logic to only tag when contextually relevant instead of blanket-tagging every reply.
- Agent identity now gracefully extracts Discord/WhatsApp sender handles for WebUI display instead of defaulting to generic 'You'.

#### Fixed

- Fixed aggressive infinite loops related to the web search tool by tightening the engine's tool-repair heuristic.
- Fixed `[object Object]` bug when restoring message chat history in the WebUI.
- Fixed ghosts diffs and execution failures tied to permissions/ghost line endings in `skills`.

### [0.1.0] - 2026-04-12

#### Added

- Initial LiteClaw runtime with WebUI, Discord, and WhatsApp support
- Core tools for filesystem access, shell execution, web search/fetch, and native vision
- Cross-channel confirmation handling for destructive actions
- Project-level skills support with selective injection
- Imported bundled `docx` and `pdf` skills plus a native Discord interactive chat skill
- Reply-context support for Discord and WhatsApp
- WebUI config editing, workspace support, and config reload signaling
- GitHub repository hygiene files including `.gitignore`, `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md`

#### Changed

- Improved tool-call recovery for smaller local models
- Improved multimodal handling so images are processed natively instead of relying on a fake `describe_image` tool
- Hid tool progress/results by default in Discord and WhatsApp while preserving them for WebUI
- Added rapid reply style support for Discord and WhatsApp
- Improved group-chat context by injecting compact sender and participant metadata
- Added native retrieval-style tool guidance so only relevant tool instructions are injected for a turn

#### Fixed

- Fixed broken XML-style tool-call parsing paths
- Fixed multi-step tool-call continuation for weaker models
- Fixed Discord presence getting stuck instead of returning to idle
- Fixed Discord attachment handling when image content types are missing
- Fixed reply-context loss in channel chats
- Reduced small-model bias toward useless directory listing loops

## Features

- Smart context management with lazy tool loading, compaction, and rolling history
- WebUI, Discord, and WhatsApp channels
- Core tools for filesystem access, command execution, web search/fetch, and native vision
- Cross-channel confirmations for destructive actions
- Project-level skills support with selective prompt injection
- OpenClaw migration helpers

## Quick Start

```bash
git clone https://github.com/NikoDhrmwn/liteclaw.git
cd liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

Open `http://localhost:7860` for the Web UI.

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
LLM_BASE_URL=http://localhost:8080/v1
LLM_API_KEY=sk-local
LLM_MODEL=gemma-4-e4b-heretic
```

You can use the project-root [.env.example](.env.example) as a reference.

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
npx tsx src/cli.ts status
npx tsx src/cli.ts channels status
npx tsx src/cli.ts message "hello"
```

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
npx tsx src/cli.ts migrate --openclaw-dir "C:\Users\yourname\.openclaw"
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
liteclaw channels login --channel discord
liteclaw channels login --channel whatsapp
liteclaw channels status
liteclaw status
liteclaw doctor
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
