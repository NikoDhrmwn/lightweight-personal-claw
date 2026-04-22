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
    { name: 'lineNumbers', type: 'boolean', description: 'Include line numbers in output (optional, default: false)' },
  ],
  usageNotes: [
    'Use this when you already know the file path or filename you need to inspect.',
    'Prefer this over list_dir when the user mentions a specific file like SOUL.md, package.json, or app.py.',
    'If the file may be large, include startLine/endLine instead of reading the whole thing.',
    'Do not call list_dir first unless the path is genuinely unknown.'
  ],
  examples: [
    { userIntent: 'read package.json', arguments: { path: 'package.json' } },
    { userIntent: 'inspect SOUL.md', arguments: { path: 'SOUL.md' } },
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

      // Extension check for common binary formats
      const binaryExtensions = ['.exe', '.dll', '.so', '.dylib', '.bin', '.pdf', '.docx', '.xlsx', '.pptx', '.zip', '.gz', '.tar', '.7z', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.mp3', '.mp4', '.mov'];
      const ext = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
      if (binaryExtensions.includes(ext)) {
        return { success: false, output: `File '${args.path}' appears to be a binary file. LiteClaw can only read text files. Use 'send_file' if you need to share it.` };
      }

      let content = readFileSync(filePath, 'utf-8');

      // Basic binary content detection (look for null bytes or weird control chars)
      if (content.includes('\u0000')) {
        return { success: false, output: `File '${args.path}' contains binary data and cannot be read as text.` };
      }

      const allLines = content.split('\n');

      // Apply line range if specified
      let start = 0;
      let end = allLines.length;
      if (args.startLine || args.endLine) {
        start = Math.max(1, args.startLine ?? 1) - 1;
        end = Math.min(allLines.length, args.endLine ?? allLines.length);
      }

      const slice = allLines.slice(start, end);
      
      if (args.lineNumbers) {
        content = slice.map((line, idx) => {
          const lineNum = start + idx + 1;
          return `${lineNum.toString().padStart(4, ' ')} | ${line}`;
        }).join('\n');
      } else {
        content = slice.join('\n');
      }

      return {
        success: true,
        output: `File: ${filePath} (lines ${start + 1}-${end} of ${allLines.length})\n\n${content}`,
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
  usageNotes: [
    'Use this only after you have already determined the exact file path and full content to save.',
    'For edits, read the target file first when needed so you do not overwrite the wrong content.',
    'This overwrites the entire file content.'
  ],
  examples: [
    { userIntent: 'create a notes file', arguments: { path: 'notes.txt', content: 'Hello' } },
  ],
  keywords: ['write', 'create', 'save', 'file', 'output', 'generate', 'put'],
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

// ─── edit_file ───────────────────────────────────────────────────────

toolRegistry.register({
  name: 'edit_file',
  description: 'Edit an existing file using search and replace blocks. Much safer than overwriting the whole file.',
  category: 'filesystem',
  parameters: [
    { name: 'path', type: 'string', description: 'Path to the file to edit', required: true },
    { 
      name: 'edits', 
      type: 'array', 
      description: 'List of edits to apply', 
      required: true,
      items: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'The exact string to find in the file' },
          replace: { type: 'string', description: 'The string to replace it with' }
        },
        required: ['search', 'replace']
      }
    },
  ],
  usageNotes: [
    'Use this for modifying existing code. It prevents accidental truncation.',
    'The "search" string MUST match exactly, including indentation and whitespace.',
    'If the search string matches multiple times, the tool will fail to ensure precision.',
    'If you need to replace multiple different parts, include them in the same call as separate edits.'
  ],
  keywords: ['edit', 'modify', 'replace', 'fix', 'update', 'change', 'patch'],
  handler: async (args, context): Promise<ToolResult> => {
    const filePath = resolve(context.workingDir, args.path);

    if (!existsSync(filePath)) {
      return { success: false, output: `File not found: ${filePath}` };
    }

    try {
      let content = readFileSync(filePath, 'utf-8');
      const edits = args.edits as { search: string, replace: string }[];

      for (const edit of edits) {
        const parts = content.split(edit.search);
        
        if (parts.length === 1) {
          return { 
            success: false, 
            output: `Search block not found in ${args.path}. Ensure whitespace and indentation match exactly.\n\nSearch attempt:\n${edit.search}` 
          };
        }
        
        if (parts.length > 2) {
          return { 
            success: false, 
            output: `Search block matches multiple times (${parts.length - 1}) in ${args.path}. Provide more context in the search string to make it unique.` 
          };
        }

        content = parts.join(edit.replace);
      }

      writeFileSync(filePath, content, 'utf-8');
      return {
        success: true,
        output: `Successfully applied ${edits.length} edits to ${filePath}`,
        filePath,
      };
    } catch (err: any) {
      return { success: false, output: `Error editing file: ${err.message}` };
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
  usageNotes: [
    'Use this only when the user clearly asked to remove a file.',
    'This requires confirmation and should not be used for ordinary editing.',
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
  usageNotes: [
    'Use this when the user asks what files exist, asks to browse a directory, or the target path is unknown.',
    'Do not use this if the user already named a specific file; read_file is better then.',
    'If you only need a single file, avoid directory listings because they add noise for small models.'
  ],
  examples: [
    { userIntent: 'what files are here', arguments: { path: '.' } },
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
  usageNotes: [
    'Use this only when the user wants the actual file delivered back into the chat.',
    'Do not use this just to confirm a file exists.'
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
