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

// Shell tools of both CLIs (Claude `Bash`, Codex `exec_command`/`shell`/...).
// Their commands are parsed for conservative file read/write patterns.
const SHELL_TOOL_RE = /^(Bash|shell|bash|exec|run_command|exec_command)$/;

// Path-carrying tools that target directories / search scopes, not file
// contents — excluded from the "unknown tool with a path → read" fallback.
const NON_FILE_PATH_TOOLS = new Set(['Grep', 'Glob', 'LS', 'ls', 'grep', 'glob', 'search', 'list_dir', 'web_search']);

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

// ---------------------------------------------------------------------------
// Shell command file attribution
// ---------------------------------------------------------------------------

// Shell command text from a shell tool's input. Claude Bash uses `command`
// (string); Codex uses `cmd` (string) or `command` (["bash","-lc","<script>"]).
function shellCommandFromInput(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const v = o.cmd ?? o.command ?? o.script;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const strs = v.filter((x): x is string => typeof x === 'string');
    const idx = strs.findIndex((s) => s === '-lc' || s === '-c');
    if (idx >= 0 && idx + 1 < strs.length) return strs[idx + 1];
    return strs.join(' ');
  }
  return null;
}

// Split a shell command into per-command token lists, honoring quotes and
// backslash escapes. Segment separators: && || ; | and newlines. Good enough
// for attribution — not a full shell grammar.
function splitShellSegments(s: string): string[][] {
  const segs: string[][] = [];
  let tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  const pushTok = (): void => { if (cur) { tokens.push(cur); cur = ''; } };
  const pushSeg = (): void => { pushTok(); if (tokens.length) segs.push(tokens); tokens = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; continue; }
    if (c === '&' && s[i + 1] === '&') { pushSeg(); i++; continue; }
    if (c === '|') { pushSeg(); if (s[i + 1] === '|') i++; continue; }
    if (c === ';' || c === '\n') { pushSeg(); continue; }
    if (/\s/.test(c)) { pushTok(); continue; }
    cur += c;
  }
  pushSeg();
  return segs;
}

// Redirect targets that aren't real files.
function isIgnoredTarget(t: string): boolean {
  return !t || t.startsWith('&') || t.startsWith('/dev/') || t === '-';
}

// Argument tokens that can't be file paths (options, globs, numbers, stdin).
function isFileArg(t: string): boolean {
  return !!t && !t.startsWith('-') && !t.includes('*') && !/^\d+$/.test(t);
}

// Read commands whose non-option args are files. sed handled separately.
const SHELL_READ_CMDS = new Set(['cat', 'head', 'tail']);
// head/tail options that consume a following value token.
const VALUE_OPTS = new Set(['-n', '-c']);

/**
 * Conservative file read/write extraction from a shell command line.
 *
 * Reads:  `cat f`, `sed -n '1,9p' f`, `head/tail [-n N] f`
 * Writes: `> f` / `>> f` redirects, `tee [-a] f`, `sed -i ... f`,
 *         heredoc targets (`cat > f <<EOF`), embedded apply_patch bodies.
 *
 * Anything ambiguous (git, grep/rg, mv/cp/rm, subshells…) is left out —
 * missing an op is better than misattributing one.
 */
export function parseShellFileOps(cmd: string): FileOp[] {
  const ops: FileOp[] = [];

  // Embedded apply_patch body (e.g. `apply_patch <<'EOF' ... `): every patched
  // file is a write.
  if (cmd.includes('*** Begin Patch')) {
    for (const p of parseApplyPatchPaths(cmd)) ops.push({ path: p, kind: 'write' });
  }

  // Drop heredoc bodies — only the command head before `<<` is parsed, so body
  // lines can't be misread as commands or redirects.
  const head = cmd.split(/<<-?\s*/)[0];

  for (const tokens of splitShellSegments(head)) {
    // Separate redirect targets from the argument list.
    const args: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const out = /^(\d*>{1,2}|&>)(.*)$/.exec(t);
      if (out) {
        const target = out[2] || tokens[++i] || '';
        if (!isIgnoredTarget(target)) ops.push({ path: target, kind: 'write' });
        continue;
      }
      const inp = /^\d*<(.*)$/.exec(t);
      if (inp) {
        const target = inp[1] || tokens[++i] || '';
        if (!isIgnoredTarget(target)) ops.push({ path: target, kind: 'read' });
        continue;
      }
      args.push(t);
    }

    // Program name: skip env assignments and sudo.
    let p = 0;
    while (p < args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[p])) p++;
    if (args[p] === 'sudo') p++;
    const prog = (args[p] ?? '').split('/').pop() ?? '';
    const rest = args.slice(p + 1);

    if (SHELL_READ_CMDS.has(prog)) {
      const files: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (VALUE_OPTS.has(rest[i])) { i++; continue; }
        if (isFileArg(rest[i])) files.push(rest[i]);
      }
      for (const f of files) ops.push({ path: f, kind: 'read' });
    } else if (prog === 'sed') {
      // Non-option tokens: first is the script, the rest are files. `-i` makes
      // them writes (in-place edit), otherwise reads.
      const inPlace = rest.some((t) => t.startsWith('-i'));
      const nonOpts = rest.filter((t) => !t.startsWith('-'));
      for (const f of nonOpts.slice(1).filter(isFileArg)) {
        ops.push({ path: f, kind: inPlace ? 'write' : 'read' });
      }
    } else if (prog === 'tee') {
      for (const f of rest.filter(isFileArg)) ops.push({ path: f, kind: 'write' });
    }
  }

  return ops;
}

/** File operations performed by a single tool call (apply_patch / shell may yield many). */
export function toolFileOps(tool: UnifiedToolCall): FileOp[] {
  const name = tool.name;

  // Codex apply_patch: parse the patch body; every touched file is a write.
  if (name === 'apply_patch') {
    const patch = patchTextFromInput(tool.input);
    if (patch) return parseApplyPatchPaths(patch).map((path) => ({ path, kind: 'write' as const }));
    const p = pathFromInput(tool.input);
    return p ? [{ path: p, kind: 'write' }] : [];
  }

  // Shell tools (Claude Bash, Codex exec_command/shell): parse the command
  // line for cat/sed/head/tail reads, redirect/tee/sed -i/apply_patch writes.
  if (SHELL_TOOL_RE.test(name)) {
    const cmd = shellCommandFromInput(tool.input);
    return cmd ? parseShellFileOps(cmd) : [];
  }

  if (CLAUDE_WRITE.has(name) || CODEX_WRITE.has(name)) {
    const p = pathFromInput(tool.input);
    return p ? [{ path: p, kind: 'write' }] : [];
  }

  if (CLAUDE_READ.has(name) || CODEX_READ.has(name)) {
    const p = pathFromInput(tool.input);
    return p ? [{ path: p, kind: 'read' }] : [];
  }

  // grep / glob / list_dir / search / skill / task → not attributed
  // (directory or non-file targets).
  if (tool.kind === 'skill' || tool.kind === 'task' || tool.kind === 'search' || NON_FILE_PATH_TOOLS.has(name)) {
    return [];
  }

  // Fallback (mirrors claude_code_power's isFileReadTool): any other tool —
  // MCP or custom — carrying a file path counts as a read. Erring toward
  // "read" so ambiguous file-path tools aren't flagged as writes.
  const p = pathFromInput(tool.input);
  return p ? [{ path: p, kind: 'read' }] : [];
}

/**
 * Distinct files read and written in a turn. Write-dominant: a file written at
 * any point in the turn is reported only as a write, never double-counted as a
 * read, so the counts reflect distinct files rather than operations.
 */
export function collectTurnFiles(turn: UnifiedPromptTurn): { reads: string[]; writes: string[] } {
  // Sub-agent tool calls count too — dedupe/write-dominance spans both sources.
  return collectFilesFromToolCalls([
    ...turn.apiCalls.flatMap((c) => c.toolCalls),
    ...(turn.subagents ?? []).flatMap((sa) => sa.toolCalls),
  ]);
}

/** Same distinct/write-dominant collection over an arbitrary tool-call list (e.g. one sub-agent's). */
export function collectFilesFromToolCalls(toolCalls: UnifiedToolCall[]): { reads: string[]; writes: string[] } {
  const readSet = new Set<string>();
  const writeSet = new Set<string>();
  for (const tool of toolCalls) {
    for (const op of toolFileOps(tool)) {
      if (op.kind === 'write') writeSet.add(op.path);
      else readSet.add(op.path);
    }
  }
  for (const w of writeSet) readSet.delete(w);
  return { reads: [...readSet], writes: [...writeSet] };
}
