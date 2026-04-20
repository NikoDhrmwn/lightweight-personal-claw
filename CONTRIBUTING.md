# Contributing

## Development

```bash
npm install
npm run lint
npm run build
```

Run the gateway locally with:

```bash
npx tsx src/cli.ts gateway run
```

## Before Opening a PR

1. Make sure `.env`, logs, SQLite files, and session folders are not included.
2. Keep changes scoped and describe any channel-specific behavior changes clearly.
3. Run `npm run lint` and `npm run build`.
4. If your change affects Discord or WhatsApp behavior, include a short manual test note.

## Security

If you discover a security issue, follow [SECURITY.md](SECURITY.md) instead of filing a public bug report.

