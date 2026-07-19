/**
 * Watches a session's `subagents/` directory (`agent-*.jsonl`) with the same
 * incremental byte-offset strategy as ClaudeJsonlWatcher. Per-session (the dir
 * is session-specific), so no ref-counting — plain start/stop lifecycle owned
 * by ClaudeAdapter. The dir may not exist yet; chokidar picks it up on create.
 *
 * Each flush also (re)tries the sibling `agent-<id>.meta.json` until it loads —
 * meta may be written after the transcript, and attribution needs its toolUseId.
 */

import * as fs from 'fs';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseJsonlLine, type RawRecord } from './jsonl-parser';
import type { SubagentMeta } from './subagent-index';

type UpdateListener = (agentId: string, records: RawRecord[], meta: SubagentMeta | null) => void;

const MAX_FAILURES = 50;

export class SubagentWatcher {
  private watcher: FSWatcher | null = null;
  private byteOffsets = new Map<string, number>();
  private failures = new Map<string, number>();
  private corrupted = new Set<string>();
  private metas = new Map<string, SubagentMeta>();
  private listeners: UpdateListener[] = [];

  constructor(private readonly subagentsDir: string) {}

  onUpdate(cb: UpdateListener): { dispose: () => void } {
    this.listeners.push(cb);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== cb); } };
  }

  start(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(path.join(this.subagentsDir, 'agent-*.jsonl'), {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });
    this.watcher.on('add', (p) => this.handleChange(p));
    this.watcher.on('change', (p) => this.handleChange(p));
    this.watcher.on('unlink', (p) => { this.byteOffsets.delete(p); });
    this.watcher.on('error', () => { /* swallow */ });
  }

  stop(): void {
    this.watcher?.close().catch(() => {});
    this.watcher = null;
    this.byteOffsets.clear();
    this.failures.clear();
    this.corrupted.clear();
    this.metas.clear();
  }

  private async handleChange(filePath: string): Promise<void> {
    if (this.corrupted.has(filePath)) return;
    const agentId = path.basename(filePath, '.jsonl').replace(/^agent-/, '');

    let stat: fs.Stats;
    try { stat = await fs.promises.stat(filePath); } catch { return; }
    let offset = this.byteOffsets.get(filePath) ?? 0;
    if (stat.size < offset) offset = 0;
    if (stat.size === offset) return;
    this.byteOffsets.set(filePath, stat.size);

    let text = '';
    try {
      const fh = await fs.promises.open(filePath, 'r');
      try {
        const len = stat.size - offset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        text = buf.toString('utf-8');
      } finally { await fh.close(); }
    } catch { return; }

    const records: RawRecord[] = [];
    for (const line of text.split('\n')) {
      const rec = parseJsonlLine(line);
      if (rec) { records.push(rec); this.failures.set(filePath, 0); }
      else if (line.trim()) {
        const n = (this.failures.get(filePath) ?? 0) + 1;
        this.failures.set(filePath, n);
        if (n >= MAX_FAILURES) { this.corrupted.add(filePath); return; }
      }
    }
    if (!records.length) return;

    const meta = this.loadMeta(filePath);
    for (const cb of this.listeners) cb(agentId, records, meta);
  }

  private loadMeta(jsonlPath: string): SubagentMeta | null {
    const cached = this.metas.get(jsonlPath);
    if (cached) return cached;
    try {
      const raw = JSON.parse(fs.readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf-8'));
      if (!raw || typeof raw !== 'object') return null;
      const meta: SubagentMeta = {
        toolUseId: typeof raw.toolUseId === 'string' ? raw.toolUseId : undefined,
        agentType: typeof raw.agentType === 'string' ? raw.agentType : undefined,
        description: typeof raw.description === 'string' ? raw.description : undefined,
      };
      if (meta.toolUseId) this.metas.set(jsonlPath, meta); // cache only once complete
      return meta;
    } catch { return null; }
  }
}
