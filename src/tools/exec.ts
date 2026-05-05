/**
 * LiteClaw — Command Execution Tool
 * 
 * Runs shell commands with safeBins allowlist checking
 * and optional confirmation for destructive operations.
 */

import { execSync, spawnSync } from 'child_process';
import { toolRegistry, ToolContext, ToolResult } from '../core/tools.js';
import { getConfig } from '../config.js';
import { resolveWorkspacePath, PathEscapeError, getWorkspaceRoot } from '../core/workspace.js';

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
    { name: 'bin', type: 'string', description: 'The binary/executable to run (e.g. npm, python, git)' },
    { name: 'args', type: 'array', description: 'Array of arguments for the binary', items: { type: 'string' } },
    { name: 'command', type: 'string', description: 'Legacy shell command string (requires tools.exec.mode="shell" in config)' },
    { name: 'cwd', type: 'string', description: 'Working directory for the command (optional)' },
    { name: 'timeout', type: 'number', description: 'Timeout in seconds (default: 30)' },
  ],
  usageNotes: [
    'Use this only when you need to execute a program, script, install, build, or system command.',
    'Prefer read_file or list_dir for inspection tasks; do not use exec just to read project files.',
    'By default, you MUST use the structured `bin` and `args` fields. Shell features like pipes (|) are not supported unless the user explicitly enables legacy shell mode.'
  ],
  examples: [
    { userIntent: 'run npm test', arguments: { bin: 'npm', args: ['run', 'test'] } },
    { userIntent: 'check python version', arguments: { bin: 'python', args: ['--version'] } },
  ],
  keywords: ['run', 'execute', 'command', 'shell', 'terminal', 'cmd', 'powershell', 'script', 'install', 'npm', 'pip', 'python', 'node', 'git', 'build', 'compile'],
  handler: async (args, context): Promise<ToolResult> => {
    const config = getConfig();
    const mode = config.tools?.exec?.mode ?? 'structured';

    let bin = args.bin as string | undefined;
    let cmdArgs = args.args as string[] | undefined;
    const command = args.command as string | undefined;

    if (!bin && !command) {
      return { success: false, output: 'No command or binary specified. Provide `bin` and `args`, or `command` (if legacy mode enabled).' };
    }

    if (mode !== 'shell' && command && !bin) {
      return {
        success: false, 
        output: 'Legacy shell `command` mode is disabled. Please use the structured `bin` and `args` parameters instead. If you truly need shell syntax (like pipes or redirects), the user must set `tools.exec.mode = "shell"` in their config.'
      };
    }

    const fullCommandString = command || `${bin} ${(cmdArgs || []).map(a => `"${a}"`).join(' ')}`;
    const executable = bin || command!.trim().split(/\s+/)[0];

    // Check allowlist
    if (!isAllowed(executable)) {
      return {
        success: false,
        output: `Command not in safeBins allowlist: ${executable}`,
      };
    }

    // Check for destructive commands — request confirmation
    if (config.tools?.exec?.confirmDestructive && isDestructive(fullCommandString)) {
      if (context.requestConfirmation) {
        const confirmed = await context.requestConfirmation(
          `⚠️ Destructive command detected:\n\`${fullCommandString}\`\n\nThis may delete data permanently.`
        );
        if (!confirmed) {
          return { success: false, output: 'User rejected the destructive command.' };
        }
      }
    }

    // Resolve cwd safely through workspace
    let cwd: string;
    try {
      cwd = args.cwd
        ? resolveWorkspacePath(args.cwd, context.workingDir).absolute
        : context.workingDir;
    } catch (err) {
      if (err instanceof PathEscapeError) {
        return { success: false, output: err.message };
      }
      cwd = context.workingDir;
    }
    const timeoutMs = (args.timeout ?? 30) * 1000;

    try {
      let output: string;

      if (command && (!bin || mode === 'shell')) {
        // Legacy shell mode
        output = execSync(command, {
          cwd,
          timeout: timeoutMs,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024, // 1MB
          shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
          windowsHide: true,
        });
      } else {
        // Structured mode
        const spawnResult = spawnSync(bin!, cmdArgs || [], {
          cwd,
          timeout: timeoutMs,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024, // 1MB
          windowsHide: true,
          shell: process.platform === 'win32', // Needed on windows for some commands to resolve (.cmd files)
        });

        if (spawnResult.error) {
          throw spawnResult.error;
        }

        if (spawnResult.status !== 0) {
          const err: any = new Error(`Command failed with exit code ${spawnResult.status}`);
          err.status = spawnResult.status;
          err.stdout = spawnResult.stdout;
          err.stderr = spawnResult.stderr;
          throw err;
        }

        output = (spawnResult.stdout || '').toString();
      }

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
