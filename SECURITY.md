# Security Policy

## Supported Versions

Security fixes are provided on the latest development version of LiteClaw.

## Reporting a Vulnerability

Please do not open public issues for vulnerabilities involving secrets, token handling, remote code execution, or account compromise.

Instead:

1. Reproduce the issue with the smallest safe example you can manage.
2. Include affected files, config keys, and whether the issue impacts WebUI, Discord, WhatsApp, or the gateway.
3. Share the report privately with the maintainer before public disclosure.

## Publishing Checklist

Before pushing LiteClaw to a public repository:

1. Do not commit `.env`, logs, SQLite files, session folders, or state directories.
2. Rotate any Discord, Google, gateway, or LLM tokens that were ever written to logs.
3. Review `README.md`, scripts, and config templates for personal machine paths.
4. Verify `npm run lint` and `npm run build` succeed from a clean checkout.

