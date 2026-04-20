# LiteClaw

Lightweight agent runtime for local LLMs with WebUI, Discord, and WhatsApp support.

Designed for small models like Gemma 4 E4B running on consumer GPUs. LiteClaw aims to be a lighter alternative to OpenClaw while keeping a familiar workflow and migration path.

## Features

- Smart context management with lazy tool loading, compaction, and rolling history
- WebUI, Discord, and WhatsApp channels
- Core tools for filesystem access, command execution, web search/fetch, and native vision
- Cross-channel confirmations for destructive actions
- Project-level skills support with selective prompt injection
- OpenClaw migration helpers

## Quick Start

```bash
git clone https://github.com/your-org/liteclaw.git
cd liteclaw
npm install
npx tsx src/cli.ts setup
npx tsx src/cli.ts gateway run
```

Open `http://localhost:7860` for the Web UI.

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

## Requirements

- Node.js >= 20
- A running LLM backend such as llama-server or Ollama, or a compatible hosted provider
- Discord bot token for Discord usage
- A linked phone for WhatsApp usage

## Security Notes

- Keep secrets in your LiteClaw state directory `.env`, not in the repository root.
- Do not commit runtime logs, SQLite databases, or WhatsApp session files.
- Review [SECURITY.md](SECURITY.md) before publishing a fork or deployment.

