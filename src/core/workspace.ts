/**
 * LiteClaw — Workspace Path Resolver
 *
 * Single, shared path resolver used by:
 *   - filesystem tools (read_file, write_file, edit_file, delete_file, list_dir)
 *   - send_file tool
 *   - exec tool (cwd)
 *   - workspace API / gateway
 *
 * Blocks path traversal (../) by default. Absolute paths are only
 * allowed when `agent.workspace.allowAbsolutePaths` is explicitly
 * enabled in config.
 */

import { resolve, normalize, relative, isAbsolute, sep } from 'path';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('workspace');

// ─── Types ───────────────────────────────────────────────────────────

export interface ResolvedPath {
  /** The final absolute path, safe to pass to fs / spawn */
  absolute: string;
  /** Path relative to workspace root */
  relative: string;
}

export class PathEscapeError extends Error {
  constructor(requestedPath: string, workspace: string) {
    super(
      `Path "${requestedPath}" escapes the workspace root "${workspace}". ` +
      `Set agent.workspace.allowAbsolutePaths: true in config to allow absolute paths.`
    );
    this.name = 'PathEscapeError';
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Resolve a user-supplied path safely within the workspace.
 *
 * @param userPath  — The raw path from the LLM / user
 * @param workspaceRoot — Override for the workspace root
 *                        (defaults to config agent.workspace or cwd)
 * @returns ResolvedPath with absolute and relative forms
 * @throws PathEscapeError if the resolved path is outside the workspace
 *         and absolute paths are not explicitly allowed.
 */
export function resolveWorkspacePath(
  userPath: string,
  workspaceRoot?: string,
): ResolvedPath {
  const config = getConfig();
  const root = normalize(workspaceRoot ?? config.agent?.workspace ?? process.cwd());
  const allowAbsolute = !!config.agent?.allowAbsolutePaths;

  // Normalize the incoming path
  let candidate: string;

  if (isAbsolute(userPath)) {
    if (!allowAbsolute) {
      throw new PathEscapeError(userPath, root);
    }
    candidate = normalize(userPath);
  } else {
    candidate = normalize(resolve(root, userPath));
  }

  // Path-escape check: resolved must be within (or equal to) the root
  const rel = relative(root, candidate);

  // On Windows relative() uses \ but the escape check is the same
  const escaped = rel.startsWith('..') || (isAbsolute(rel) && !candidate.startsWith(root));

  if (escaped && !allowAbsolute) {
    throw new PathEscapeError(userPath, root);
  }

  log.debug({ userPath, resolved: candidate, workspace: root }, 'Path resolved');

  return {
    absolute: candidate,
    relative: rel || '.',
  };
}

/**
 * Quick boolean check — does this path stay inside the workspace?
 */
export function isInsideWorkspace(
  userPath: string,
  workspaceRoot?: string,
): boolean {
  try {
    resolveWorkspacePath(userPath, workspaceRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the resolved workspace root from config.
 */
export function getWorkspaceRoot(): string {
  const config = getConfig();
  return normalize(config.agent?.workspace ?? process.cwd());
}
