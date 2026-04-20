/**
 * LiteClaw — Filesystem Tools
 * 
 * read_file, write_file, delete_file (with confirmation),
 * list_dir, and send_file (sends to originating channel).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, statSync, readdirSync } from 'fs';
import { join, basename, resolve } from 'path';
import { toolRegistry, ToolContext, ToolResult } from '../core/tools.js';

// ─── read_file ───────────────────────────────────────────────────────

toolRegistry.register({
  name: 'read_file',
  description: 'Read the contents of a file. Returns the text content. Specify startLine/endLine for partial reads.',
  category: 'filesystem',
  parameters: [
    { name: 'path', type: 'string', description: 'Absolute or relative path to the file', required: true },
    { name: 'startLine', type: 'number', description: 'Start line (1-indexed, optional)' },
    { name: 'endLine', type: 'number', description: 'End line (1-indexed, inclusive, optional)' },
  ],
  keywords: ['read', 'file', 'open', 'show', 'content', 'view', 'cat', 'type', 'display', 'look', 'check'],
  handler: async (args, context): Promise<ToolResult> => {
    const filePath = resolve(context.workingDir, args.path);

    if (!existsSync(filePath)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return { success: false, output: `Path is a directory. Use list_dir instead.` };
      }

      // Size guard: don't read huge files into context
      if (stat.size > 500_000) {
        return { success: false, output: `File is too large (${(stat.size / 1024).toFixed(0)} KB). Use startLine/endLine for partial reads.` };
      }

      let content = readFileSync(filePath, 'utf-8');

      // Apply line range if specified
      if (args.startLine || args.endLine) {
        const lines = content.split('\n');
        const start = Math.max(1, args.startLine ?? 1) - 1;
        const end = Math.min(lines.length, args.endLine ?? lines.length);
        content = lines.slice(start, end).join('\n');
        return {
          success: true,
          output: `File: ${filePath} (lines ${start + 1}-${end} of ${lines.length})\n\n${content}`,
        };
      }

      const lineCount = content.split('\n').length;
      return {
        success: true,
        output: `File: ${filePath} (${lineCount} lines, ${stat.size} bytes)\n\n${content}`,
      };
    } catch (err: any) {
      return { success: false, output: `Error reading file: ${err.message}` };
    }
  },
});

// ─── write_file ──────────────────────────────────────────────────────

toolRegistry.register({
  name: 'write_file',
  description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
  category: 'filesystem',
  parameters: [
    { name: 'path', type: 'string', description: 'Path to the file to write', required: true },
    { name: 'content', type: 'string', description: 'Content to write to the file', required: true },
  ],
  keywords: ['write', 'create', 'save', 'file', 'make', 'output', 'generate', 'put'],
  handler: async (args, context): Promise<ToolResult> => {
    const filePath = resolve(context.workingDir, args.path);

    try {
      const existed = existsSync(filePath);
      writeFileSync(filePath, args.content, 'utf-8');
      const size = statSync(filePath).size;

      return {
        success: true,
        output: `${existed ? 'Updated' : 'Created'} file: ${filePath} (${size} bytes)`,
        filePath,
      };
    } catch (err: any) {
      return { success: false, output: `Error writing file: ${err.message}` };
    }
  },
});

// ─── delete_file ─────────────────────────────────────────────────────

toolRegistry.register({
  name: 'delete_file',
  description: 'Delete a file. Requires user confirmation before proceeding.',
  category: 'filesystem',
  parameters: [
    { name: 'path', type: 'string', description: 'Path to the file to delete', required: true },
  ],
  keywords: ['delete', 'remove', 'rm', 'del', 'erase', 'destroy', 'clean'],
  requiresConfirmation: true,
  handler: async (args, context): Promise<ToolResult> => {
    const filePath = resolve(context.workingDir, args.path);

    if (!existsSync(filePath)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    try {
      unlinkSync(filePath);
      return { success: true, output: `Deleted: ${filePath}` };
    } catch (err: any) {
      return { success: false, output: `Error deleting file: ${err.message}` };
    }
  },
});

// ─── list_dir ────────────────────────────────────────────────────────

toolRegistry.register({
  name: 'list_dir',
  description: 'List the contents of a directory, showing files and subdirectories with sizes.',
  category: 'filesystem',
  parameters: [
    { name: 'path', type: 'string', description: 'Path to the directory to list', required: true },
  ],
  keywords: ['list', 'directory', 'folder', 'dir', 'ls', 'tree', 'files', 'contents', 'what'],
  handler: async (args, context): Promise<ToolResult> => {
    const dirPath = resolve(context.workingDir, args.path || '.');

    if (!existsSync(dirPath)) {
      return { success: false, output: `Directory not found: ${dirPath}` };
    }

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      const lines: string[] = [`Directory: ${dirPath}\n`];

      const dirs: string[] = [];
      const files: string[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // skip hidden

        if (entry.isDirectory()) {
          dirs.push(`  📁 ${entry.name}/`);
        } else {
          try {
            const stat = statSync(join(dirPath, entry.name));
            const sizeKB = (stat.size / 1024).toFixed(1);
            files.push(`  📄 ${entry.name}  (${sizeKB} KB)`);
          } catch {
            files.push(`  📄 ${entry.name}`);
          }
        }
      }

      lines.push(...dirs.sort(), ...files.sort());
      lines.push(`\nTotal: ${dirs.length} directories, ${files.length} files`);

      return { success: true, output: lines.join('\n') };
    } catch (err: any) {
      return { success: false, output: `Error listing directory: ${err.message}` };
    }
  },
});

// ─── send_file ───────────────────────────────────────────────────────

toolRegistry.register({
  name: 'send_file',
  description: 'Send a file to the user through the current chat channel (Discord attachment or WhatsApp document).',
  category: 'channel',
  parameters: [
    { name: 'path', type: 'string', description: 'Path to the file to send', required: true },
    { name: 'fileName', type: 'string', description: 'Display name for the file (optional)' },
  ],
  keywords: ['send', 'share', 'attach', 'upload', 'deliver', 'transfer', 'give'],
  handler: async (args, context): Promise<ToolResult> => {
    const filePath = resolve(context.workingDir, args.path);

    if (!existsSync(filePath)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    if (!context.sendFile) {
      return {
        success: false,
        output: 'File sending is not available in the current channel (WebUI only supports download).',
      };
    }

    try {
      await context.sendFile(filePath, args.fileName);
      return {
        success: true,
        output: `File sent: ${basename(filePath)}`,
        filePath,
      };
    } catch (err: any) {
      return { success: false, output: `Error sending file: ${err.message}` };
    }
  },
});
