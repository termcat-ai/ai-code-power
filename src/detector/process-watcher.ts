import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PerTabState, TabStatus } from '../core/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pidtree = require('pidtree') as (pid: number, opts?: { root?: boolean }) => Promise<number[]>;

const execFileAsync = promisify(execFile);

const TICK_MS = 5000;
const JSONL_FRESH_MS = 60_000;
const STALE_WINDOW_MS = 24 * 60 * 60 * 1000;

const CLAUDE_NAME_RE = /^claude(?:\.(?:exe|cmd|ps1))?$/i;
const CLAUDE_CMDLINE_RE = /[\\/]@anthropic-ai[\\/]claude-code[\\/]/i;
const CODEX_NAME_RE = /^codex(?:-tui)?(?:\.(?:exe|cmd|ps1))?$/i;
const CODEX_CMDLINE_RE = /[\\/]@openai[\\/]codex[\\/]/i;

export interface TerminalHandle {
  sessionId: string;
  getPid: () => Promise<number | null>;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  name: string;
  cmd?: string;
}

interface DetectorListeners {
  getKnownSessions: () => TerminalHandle[];
  getActiveSessionId: () => string | null;
  onTabState: (state: PerTabState) => void;
}

export class Detector {
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: DetectorListeners) {}

  start(): void {
    if (this.interval) return;
    void this.tick();
    this.interval = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  triggerNow(): void { void this.tick(); }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const terminals = this.deps.getKnownSessions();
      if (!terminals.length) return;

      const processes = await listProcesses().catch(() => [] as ProcessRow[]);
      const byPid = new Map<number, ProcessRow>();
      for (const p of processes) byPid.set(p.pid, p);

      for (const term of terminals) {
        const shellPid = await term.getPid().catch(() => null);
        const descendants = await this.getDescendants(shellPid, byPid);

        // Detect both kinds; prefer the most recently started one.
        const claudePid = this.findProcess(descendants, byPid, CLAUDE_NAME_RE, CLAUDE_CMDLINE_RE);
        const codexPid = this.findProcess(descendants, byPid, CODEX_NAME_RE, CODEX_CMDLINE_RE);

        let kind: 'claude' | 'codex' | null = null;
        let aiPid: number | null = null;

        if (claudePid !== null && codexPid !== null) {
          // Both present — prefer the newer process (lower pid = older on most platforms)
          // Simplistic: prefer codex if pid > claude (started later)
          kind = codexPid > claudePid ? 'codex' : 'claude';
          aiPid = kind === 'codex' ? codexPid : claudePid;
        } else if (claudePid !== null) {
          kind = 'claude';
          aiPid = claudePid;
        } else if (codexPid !== null) {
          kind = 'codex';
          aiPid = codexPid;
        }

        let cwd: string | null = null;
        let sessionFile: string | null = null;
        let status: TabStatus = 'idle';

        if (aiPid !== null && kind !== null) {
          if (kind === 'claude') {
            const pointer = await this.readClaudeSessionPointer(aiPid);
            cwd = pointer?.cwd ?? (await this.resolveCwd(aiPid).catch(() => null));
            const result = await this.resolveClaudeSessionFile(pointer?.sessionId ?? null, cwd);
            sessionFile = result.file;
            const fresh = result.mtimeMs && Date.now() - result.mtimeMs < JSONL_FRESH_MS;
            status = fresh ? 'active' : 'active-idle';
          } else {
            cwd = await this.resolveCwd(aiPid).catch(() => null);
            sessionFile = await this.resolveCodexSessionFile(cwd);
            if (sessionFile) {
              try {
                const stat = await fs.promises.stat(sessionFile);
                const fresh = Date.now() - stat.mtimeMs < JSONL_FRESH_MS;
                status = fresh ? 'active' : 'active-idle';
              } catch {
                status = 'active-idle';
              }
            } else {
              status = 'active-idle';
            }
          }
        } else {
          const mtimeMs = await this.latestGlobalMtime();
          if (mtimeMs && Date.now() - mtimeMs < STALE_WINDOW_MS) status = 'stale';
          else status = 'idle';
        }

        const state: PerTabState = {
          sessionId: term.sessionId,
          shellPid,
          kind,
          aiPid,
          detectedCwd: cwd,
          sessionFile,
          status,
          lastCheckedAt: Date.now(),
          adapter: null, // managed by extension.ts
        };
        this.deps.onTabState(state);
      }
    } finally {
      this.running = false;
    }
  }

  private async getDescendants(shellPid: number | null, byPid: Map<number, ProcessRow>): Promise<number[]> {
    if (!shellPid) return [];
    try {
      return await pidtree(shellPid);
    } catch {
      return this.walkDescendants(shellPid, byPid);
    }
  }

  private walkDescendants(rootPid: number, byPid: Map<number, { pid: number; ppid: number }>): number[] {
    const children = new Map<number, number[]>();
    for (const p of byPid.values()) {
      const arr = children.get(p.ppid) ?? [];
      arr.push(p.pid);
      children.set(p.ppid, arr);
    }
    const result: number[] = [];
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop()!;
      const kids = children.get(pid);
      if (!kids) continue;
      for (const c of kids) { result.push(c); stack.push(c); }
    }
    return result;
  }

  private findProcess(
    pids: number[],
    byPid: Map<number, ProcessRow>,
    nameRe: RegExp,
    cmdRe: RegExp,
  ): number | null {
    for (const pid of pids) {
      const row = byPid.get(pid);
      if (!row) continue;
      if (nameRe.test(row.name)) return pid;
      if (row.cmd && cmdRe.test(row.cmd)) return pid;
    }
    return null;
  }

  private async resolveCwd(pid: number): Promise<string | null> {
    if (process.platform === 'linux') {
      try { return await fs.promises.readlink(`/proc/${pid}/cwd`); } catch { return null; }
    }
    if (process.platform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: 2000 });
        for (const line of stdout.split('\n')) {
          if (line.startsWith('n')) return line.slice(1);
        }
      } catch { /* fall through */ }
    }
    return null;
  }

  private async readClaudeSessionPointer(claudePid: number): Promise<{ sessionId: string; cwd: string | null } | null> {
    const file = path.join(os.homedir(), '.claude', 'sessions', `${claudePid}.json`);
    try {
      const raw = await fs.promises.readFile(file, 'utf-8');
      const j = JSON.parse(raw) as { sessionId?: unknown; cwd?: unknown };
      if (typeof j.sessionId !== 'string' || !j.sessionId) return null;
      return { sessionId: j.sessionId, cwd: typeof j.cwd === 'string' ? j.cwd : null };
    } catch { return null; }
  }

  private async resolveClaudeSessionFile(
    sessionId: string | null,
    cwd: string | null,
  ): Promise<{ mtimeMs: number | null; file: string | null }> {
    if (sessionId && cwd) {
      const encoded = encodeCwd(cwd);
      const file = path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
      try {
        const stat = await fs.promises.stat(file);
        return { mtimeMs: stat.mtimeMs, file };
      } catch { /* fall through */ }
    }
    return this.latestClaudeJsonlForCwd(cwd);
  }

  private async latestClaudeJsonlForCwd(cwd: string | null): Promise<{ mtimeMs: number | null; file: string | null }> {
    if (!cwd) return { mtimeMs: null, file: null };
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
    try {
      const names = await fs.promises.readdir(dir);
      let latest: { mtimeMs: number; file: string } | null = null;
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const full = path.join(dir, name);
        try {
          const stat = await fs.promises.stat(full);
          if (!latest || stat.mtimeMs > latest.mtimeMs) latest = { mtimeMs: stat.mtimeMs, file: full };
        } catch { /* ignore */ }
      }
      return latest ?? { mtimeMs: null, file: null };
    } catch { return { mtimeMs: null, file: null }; }
  }

  private async resolveCodexSessionFile(cwd: string | null): Promise<string | null> {
    if (!cwd) return null;
    // Try SQLite first — rollout_path is the canonical file path, no reconstruction needed.
    const sqlitePath = await findCodexSqlite();
    if (sqlitePath) {
      const rolloutPath = await queryLatestCodexRolloutPath(sqlitePath, cwd);
      if (rolloutPath) {
        try { await fs.promises.access(rolloutPath); return rolloutPath; } catch { /* fall through */ }
      }
    }
    // Fallback: glob most recent JSONL in sessions tree
    return findLatestCodexJsonl();
  }

  private async latestGlobalMtime(): Promise<number | null> {
    // Check both Claude and Codex.
    const claudeRoot = path.join(os.homedir(), '.claude', 'projects');
    const codexRoot = path.join(os.homedir(), '.codex', 'sessions');
    let best: number | null = null;
    const depths: Record<string, number> = {};
    depths[claudeRoot] = 2; // ~/.claude/projects/encoded-cwd/*.jsonl = 2 levels
    depths[codexRoot] = 4;  // ~/.codex/sessions/YYYY/MM/DD/*.jsonl = 4 levels
    for (const root of [claudeRoot, codexRoot]) {
      const m = await latestMtimeInTree(root, depths[root] ?? 2);
      if (m && (best === null || m > best)) best = m;
    }
    return best;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function latestMtimeInTree(root: string, depth: number): Promise<number | null> {
  if (depth <= 0) return null;
  let best: number | null = null;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const stat = await fs.promises.stat(full);
        if (best === null || stat.mtimeMs > best) best = stat.mtimeMs;
      } catch { /* ignore */ }
    } else if (e.isDirectory()) {
      const sub = await latestMtimeInTree(full, depth - 1);
      if (sub && (best === null || sub > best)) best = sub;
    }
  }
  return best;
}

async function findCodexSqlite(): Promise<string | null> {
  const dir = path.join(os.homedir(), '.codex');
  try {
    const entries = await fs.promises.readdir(dir);
    const matches = entries.filter((n) => /^state_\d+\.sqlite$/.test(n)).sort();
    if (!matches.length) return null;
    // Pick highest version number
    const best = matches[matches.length - 1];
    return path.join(dir, best);
  } catch { return null; }
}

async function queryLatestCodexRolloutPath(sqlitePath: string, cwd: string): Promise<string | null> {
  try {
    // Try better-sqlite3 (may be available in Electron host).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (p: string, opts?: object) => {
      prepare(sql: string): { get(...args: unknown[]): unknown };
      close(): void;
    };
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(
        'SELECT rollout_path FROM threads WHERE cwd = ? ORDER BY updated_at_ms DESC LIMIT 1'
      ).get(cwd) as { rollout_path?: string } | undefined;
      return row?.rollout_path ?? null;
    } finally {
      db.close();
    }
  } catch { return null; }
}

type _BestFile = { mtimeMs: number; file: string };

async function findLatestCodexJsonl(): Promise<string | null> {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const state: { best: _BestFile | null } = { best: null };
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth <= 0) return;
    let entries: string[];
    try { entries = await fs.promises.readdir(dir); } catch { return; }
    for (const name of entries) {
      const full = path.join(dir, name);
      if (name.endsWith('.jsonl')) {
        try {
          const stat = await fs.promises.stat(full);
          if (!state.best || stat.mtimeMs > state.best.mtimeMs) state.best = { mtimeMs: stat.mtimeMs, file: full };
        } catch { /* ignore */ }
      } else {
        await walk(full, depth - 1);
      }
    }
  }
  await walk(root, 4);
  return state.best?.file ?? null;
}

// ---------------------------------------------------------------------------
// Cross-platform process list
// ---------------------------------------------------------------------------

async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') return listProcessesWindows();
  return listProcessesUnix();
}

async function listProcessesUnix(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,comm='], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 3000,
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cmdLine = match[3];
    const name = cmdLine.split(/[\\/]/).pop() ?? cmdLine;
    rows.push({ pid, ppid, name, cmd: cmdLine });
  }
  return rows;
}

async function listProcessesWindows(): Promise<ProcessRow[]> {
  const psCommand =
    'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCommand],
    { maxBuffer: 16 * 1024 * 1024, timeout: 5000 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const rows: ProcessRow[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
    const pid = Number(obj.ProcessId);
    const ppid = Number(obj.ParentProcessId);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const name = typeof obj.Name === 'string' ? obj.Name : '';
    const cmd = typeof obj.CommandLine === 'string' && obj.CommandLine.length > 0 ? obj.CommandLine : undefined;
    rows.push({ pid, ppid, name, cmd });
  }
  return rows;
}
