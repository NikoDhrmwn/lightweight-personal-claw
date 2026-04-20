/**
 * LiteClaw — Command Execution Tool
 * 
 * Runs shell commands with safeBins allowlist checking
 * and optional confirmation for destructive operations.
 */

import { execSync, spawn } from 'child_process';
import { toolRegistry, ToolContext, ToolResult } from '../core/tools.js';
import { getConfig } from '../config.js';

// ─── Destructive command patterns ────────────────────────────────────

const DESTRUCTIVE_PATTERNS = [
  /\brm\s/i, /\bdel\s/i, /\brmdir\s/i, /\bformat\s/i,
  /\bdelete\s/i, /\bdrop\s/i, /\btruncate\s/i,
  /\bpurge\s/i, /\bwipe\s/i, /\bclear\s/i,
  /\bmkfs\b/i, /\bfdisk\b/i,
];

function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some(p => p.test(command));
}

// ─── SafeBins check ──────────────────────────────────────────────────

function isAllowed(command: string): boolean {
  const config = getConfig();
  const safeBins = config.tools?.exec?.safeBins ?? [];

  if (safeBins.length === 0) return true; // No restriction

  // Extract the first token (the binary)
  const bin = command.trim().split(/\s+/)[0].toLowerCase();

  // Check against allowlist
  return safeBins.some((safe: string) => {
    const safeLower = safe.toLowerCase();
    return bin === safeLower ||
      bin.endsWith(`\\${safeLower}`) ||
      bin.endsWith(`/${safeLower}`) ||
      bin === `${safeLower}.exe`;
  });
}

// ─── exec tool ───────────────────────────────────────────────────────

toolRegistry.register({
  name: 'exec',
  description: 'Execute a shell command and return the output. Use this for running programs, scripts, and system commands.',
  category: 'exec',
  parameters: [
    { name: 'command', type: 'string', description: 'The shell command to execute', required: true },
    { name: 'cwd', type: 'string', description: 'Working directory for the command (optional)' },
    { name: 'timeout', type: 'number', description: 'Timeout in seconds (default: 30)' },
  ],
  usageNotes: [
    'Use this only when the user explicitly wants a command, script, install, build, or terminal action.',
    'Prefer read_file or list_dir for inspection tasks; do not use exec just to read project files.',
    'Provide one complete shell command string in the command field.'
  ],
  examples: [
    { userIntent: 'run npm test', arguments: { command: 'npm test' } },
  ],
  keywords: ['run', 'execute', 'command', 'shell', 'terminal', 'cmd', 'powershell', 'script', 'install', 'npm', 'pip', 'python', 'node', 'git', 'build', 'compile'],
  handler: async (args, context): Promise<ToolResult> => {
    const command = args.command;
    if (!command) {
      return { success: false, output: 'No command specified' };
    }

    // Check allowlist
    if (!isAllowed(command)) {
      return {
        success: false,
        output: `Command not in safeBins allowlist: ${command.split(/\s+/)[0]}`,
      };
    }

    // Check for destructive commands — request confirmation
    const config = getConfig();
    if (config.tools?.exec?.confirmDestructive && isDestructive(command)) {
      if (context.requestConfirmation) {
        const confirmed = await context.requestConfirmation(
          `⚠️ Destructive command detected:\n\`${command}\`\n\nThis may delete data permanently.`
        );
        if (!confirmed) {
          return { success: false, output: 'User rejected the destructive command.' };
        }
      }
    }

    const cwd = args.cwd ? args.cwd : context.workingDir;
    const timeoutMs = (args.timeout ?? 30) * 1000;

    try {
      const output = execSync(command, {
        cwd,
        timeout: timeoutMs,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB
        shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
        windowsHide: true,
      });

      // Truncate large outputs
      const trimmedOutput = output.length > 5000
        ? output.slice(0, 2500) + `\n\n... [truncated ${output.length - 5000} chars] ...\n\n` + output.slice(-2500)
        : output;

      return {
        success: true,
        output: trimmedOutput || '(command completed with no output)',
      };
    } catch (err: any) {
      const stderr = err.stderr?.toString() ?? '';
      const stdout = err.stdout?.toString() ?? '';
      const combined = (stdout + '\n' + stderr).trim();

      return {
        success: false,
        output: `Command failed (exit ${err.status ?? '?'}):\n${combined.slice(0, 3000)}`,
      };
    }
  },
});
