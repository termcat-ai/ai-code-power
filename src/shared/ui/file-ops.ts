/**
 * Per-turn file read/write extraction.
 *
 * Answers "how many / which files did this turn read and write" for both the
 * Claude and Codex adapters. Pure functions, no side effects — the panel layer
 * calls `collectTurnFiles` per turn to render counts and the file list.
 */

import type { UnifiedPromptTurn, UnifiedToolCall } from '../../adapters/types';

// Claude built-in tools.
const CLAUDE_READ = new Set(['Read', 'NotebookRead']);
const CLAUDE_WRITE = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Codex tools that carry a single `path` argument.
const CODEX_READ = new Set(['read_file']);
const CODEX_WRITE = new Set(['write_file', 'edit_file', 'create_file']);

// Input keys that may hold a single target file path.
const FILE_PATH_KEYS = ['file_path', 'path', 'notebook_path', 'filepath'];

function pathFromInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const k of FILE_PATH_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Extract written file paths from an apply_patch patch body. Codex patches use
 * headers like `*** Add File: path`, `*** Update File: path`, `*** Delete File:
 * path` — all three count as writes.
 */
export function parseApplyPatchPaths(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch)) !== null) {
    const p = m[1].trim();
    if (p) out.push(p);
  }
  return out;
}

// apply_patch input may arrive as a raw patch string or wrapped in an object.
function patchTextFromInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ['input', 'patch', 'content', 'text']) {
      if (typeof o[k] === 'string') return o[k] as string;
    }
  }
  return null;
}

export type FileOp = { path: string; kind: 'read' | 'write' };

/** File operations performed by a single tool call (apply_patch may yield many). */
export function toolFileOps(tool: UnifiedToolCall): FileOp[] {
  const name = tool.name;

  // Codex apply_patch: parse the patch body; every touched file is a write.
  if (name === 'apply_patch') {
    const patch = patchTextFromInput(tool.input);
    if (patch) return parseApplyPatchPaths(patch).map((path) => ({ path, kind: 'write' as const }));
    const p = pathFromInput(tool.input);
    return p ? [{ path: p, kind: 'write' }] : [];
  }

  if (CLAUDE_WRITE.has(name) || CODEX_WRITE.has(name)) {
    const p = pathFromInput(tool.input);
    return p ? [{ path: p, kind: 'write' }] : [];
  }

  if (CLAUDE_READ.has(name) || CODEX_READ.has(name)) {
    const p = pathFromInput(tool.input);
    return p ? [{ path: p, kind: 'read' }] : [];
  }

  // shell / grep / glob / list_dir / search / mcp / skill / task → not attributed.
  return [];
}

/**
 * Distinct files read and written in a turn. Write-dominant: a file written at
 * any point in the turn is reported only as a write, never double-counted as a
 * read, so the counts reflect distinct files rather than operations.
 */
export function collectTurnFiles(turn: UnifiedPromptTurn): { reads: string[]; writes: string[] } {
  const readSet = new Set<string>();
  const writeSet = new Set<string>();
  for (const call of turn.apiCalls) {
    for (const tool of call.toolCalls) {
      for (const op of toolFileOps(tool)) {
        if (op.kind === 'write') writeSet.add(op.path);
        else readSet.add(op.path);
      }
    }
  }
  for (const w of writeSet) readSet.delete(w);
  return { reads: [...readSet], writes: [...writeSet] };
}
