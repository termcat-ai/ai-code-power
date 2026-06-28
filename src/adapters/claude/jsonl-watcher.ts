import * as fs from 'fs';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';
import { normalizeEvents, parseJsonlLine, type RawRecord, type ClaudeEvent } from './jsonl-parser';

interface FileState {
  byteOffset: number;
  corrupted: boolean;
  consecutiveFailures: number;
  buffered: ClaudeEvent[];
  flushTimer: NodeJS.Timeout | null;
}

type EventListener = (filePath: string, events: ClaudeEvent[]) => void;
type CorruptListener = (filePath: string) => void;

const MAX_FAILURES = 50;
const BACKPRESSURE_MS = 200;
const BURST_THRESHOLD = 200;

/**
 * Watches *.jsonl files under a Claude project directory and emits normalized events.
 * ref-counted: acquire()/release().
 */
export class ClaudeJsonlWatcher {
  private watcher: FSWatcher | null = null;
  private fileStates = new Map<string, FileState>();
  private listeners: EventListener[] = [];
  private corruptListeners: CorruptListener[] = [];
  private refCount = 0;

  constructor(private readonly projectDir: string) {}

  acquire(): void { this.refCount++; if (this.refCount === 1) this.start(); }
  release(): void { this.refCount = Math.max(0, this.refCount - 1); if (this.refCount === 0) this.stop(); }

  onEvents(cb: EventListener): { dispose: () => void } {
    this.listeners.push(cb);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== cb); } };
  }

  onCorrupt(cb: CorruptListener): { dispose: () => void } {
    this.corruptListeners.push(cb);
    return { dispose: () => { this.corruptListeners = this.corruptListeners.filter((l) => l !== cb); } };
  }

  private start(): void {
    try { fs.mkdirSync(this.projectDir, { recursive: true }); } catch { /* non-fatal */ }
    this.watcher = chokidar.watch(path.join(this.projectDir, '*.jsonl'), {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });
    this.watcher.on('add', (p) => this.handleChange(p));
    this.watcher.on('change', (p) => this.handleChange(p));
    this.watcher.on('unlink', (p) => this.fileStates.delete(p));
    this.watcher.on('error', () => { /* swallow */ });
  }

  private stop(): void {
    this.watcher?.close().catch(() => {});
    this.watcher = null;
    for (const s of this.fileStates.values()) { if (s.flushTimer) clearTimeout(s.flushTimer); }
    this.fileStates.clear();
  }

  private getOrInit(filePath: string): FileState {
    let s = this.fileStates.get(filePath);
    if (!s) {
      s = { byteOffset: 0, corrupted: false, consecutiveFailures: 0, buffered: [], flushTimer: null };
      this.fileStates.set(filePath, s);
    }
    return s;
  }

  private async handleChange(filePath: string): Promise<void> {
    const state = this.getOrInit(filePath);
    if (state.corrupted) return;
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(filePath); } catch { return; }
    if (stat.size < state.byteOffset) state.byteOffset = 0;
    if (stat.size === state.byteOffset) return;
    const start = state.byteOffset;
    state.byteOffset = stat.size;
    const lines = await readLines(filePath, start, stat.size);
    if (!lines.length) return;

    const records: RawRecord[] = [];
    for (const line of lines) {
      const rec = parseJsonlLine(line);
      if (rec) { records.push(rec); state.consecutiveFailures = 0; }
      else if (line.trim()) {
        state.consecutiveFailures++;
        if (state.consecutiveFailures >= MAX_FAILURES) {
          state.corrupted = true;
          for (const cb of this.corruptListeners) cb(filePath);
          return;
        }
      }
    }

    const events = normalizeEvents(records);
    if (!events.length) return;
    state.buffered.push(...events);
    if (state.flushTimer) return;
    const delay = state.buffered.length > BURST_THRESHOLD ? BACKPRESSURE_MS : 0;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const payload = state.buffered;
      state.buffered = [];
      for (const cb of this.listeners) cb(filePath, payload);
    }, delay);
  }
}

async function readLines(filePath: string, start: number, end: number): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const buf: Buffer[] = [];
    const stream = fs.createReadStream(filePath, { start, end: Math.max(start, end - 1) });
    stream.on('data', (chunk) => buf.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    stream.on('end', () => {
      const text = Buffer.concat(buf).toString('utf-8');
      resolve(text ? text.split('\n') : []);
    });
    stream.on('error', () => resolve([]));
  });
}
