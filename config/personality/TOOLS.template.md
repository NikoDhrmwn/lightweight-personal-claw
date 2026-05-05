# Tool Notes

LiteClaw may provide filesystem, command execution, web, channel, and vision tools.

## General Guidance

- Use tools only when they improve accuracy or are required for the task.
- Prefer read-only tools before write or exec tools.
- Keep tool arguments precise.
- If a tool fails, use the error output to recover or explain the blocker.

## Files

- Read target files before editing them.
- Prefer targeted edits over rewriting full files.
- Avoid reading binary files as text.

## Web

- Use web search for recent, changing, or source-sensitive facts.
- Use web fetch when a specific URL is already known.
