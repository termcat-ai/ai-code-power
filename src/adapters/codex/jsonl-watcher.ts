import * as fs from 'fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseJsonlLine, normalizeRecords, type CodexEvent } from './jsonl-parser';

interface FileState {
  byteOffset: number;
  flushTimer: NodeJS.Timeout | null;
  buffered: CodexEvent[];
}

type EventListener = (events: CodexEvent[]) => void;

const BACKPRESSURE_MS = 100;

export class CodexJsonlWatcher {
  private watcher: FSWatcher | null = null;
  private fileState: FileState | null = null;
  private currentPath: string | null = null;
  private listeners: EventListener[] = [];

  onEvents(cb: EventListener): { dispose: () => void } {
    this.listeners.push(cb);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== cb); } };
  }

  start(filePath: string, initialByteOffset = 0): void {
    if (this.currentPath === filePath) return;
    this.stop();
    this.currentPath = filePath;
    this.fileState = { byteOffset: initialByteOffset, flushTimer: null, buffered: [] };
    this.watcher = chokidar.watch(filePath, {
      persistent: true,
      ignoreInitial: false,
      // usePolling ensures events fire in Electron main process where FSEvents may not be available.
      usePolling: true,
      interval: 800,
    });
    this.watcher.on('add', (p) => void this.handleChange(p));
    this.watcher.on('change', (p) => void this.handleChange(p));
    this.watcher.on('error', () => { /* swallow */ });
  }

  stop(): void {
    this.watcher?.close().catch(() => {});
    this.watcher = null;
    this.currentPath = null;
    if (this.fileState?.flushTimer) clearTimeout(this.fileState.flushTimer);
    this.fileState = null;
  }

  private async handleChange(filePath: string): Promise<void> {
    const state = this.fileState;
    if (!state) return;
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(filePath); } catch { return; }
    if (stat.size < state.byteOffset) state.byteOffset = 0;
    if (stat.size === state.byteOffset) return;
    const start = state.byteOffset;
    const buf = await readBuffer(filePath, start, stat.size);
    if (!buf.length) return;

    // Find the last newline to avoid consuming a partial line at the end.
    let lastNl = buf.length - 1;
    while (lastNl >= 0 && buf[lastNl] !== 0x0a) lastNl--;
    if (lastNl < 0) return; // no complete line yet

    state.byteOffset = start + lastNl + 1;
    const text = buf.slice(0, lastNl + 1).toString('utf-8');
    const lines = text.split('\n').filter(Boolean);
    if (!lines.length) return;

    const records = lines.map(parseJsonlLine).filter(Boolean) as NonNullable<ReturnType<typeof parseJsonlLine>>[];
    const events = normalizeRecords(records);
    if (!events.length) return;
    state.buffered.push(...events);
    if (state.flushTimer) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      const payload = state.buffered;
      state.buffered = [];
      for (const cb of this.listeners) cb(payload);
    }, BACKPRESSURE_MS);
  }
}

async function readBuffer(filePath: string, start: number, end: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(filePath, { start, end: Math.max(start, end - 1) });
    stream.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', () => resolve(Buffer.alloc(0)));
  });
}
