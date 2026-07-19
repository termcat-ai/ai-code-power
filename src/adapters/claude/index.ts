import * as fs from 'fs';
import * as path from 'path';
import type { IAdapter, UnifiedPromptTurn, UnifiedSessionMeta, EnvConfig } from '../types';
import type { PtyInjector } from '../../shared/actions/pty-inject';
import { ClaudeJsonlWatcher } from './jsonl-watcher';
import { ClaudeSessionIndex } from './session-index';
import { SubagentIndex } from './subagent-index';
import { SubagentWatcher } from './subagent-watcher';
import { SettingsReader } from './settings-reader';
import { PresetStore, ACTIVE_ENV_PATH } from './preset-store';
import { ClaudeSseStrategy } from './sse-strategy';
import { projectDir } from './project-hash';
import { parseJsonlLine, normalizeEvents } from './jsonl-parser';

export class ClaudeAdapter implements IAdapter {
  readonly kind = 'claude' as const;

  private watcher: ClaudeJsonlWatcher | null = null;
  private index: ClaudeSessionIndex = new ClaudeSessionIndex();
  private subagentIndex: SubagentIndex = new SubagentIndex();
  private subagentWatcher: SubagentWatcher | null = null;
  private subagentWatcherDisposable: { dispose: () => void } | null = null;
  private sessionFile: string | null = null;
  private cwd: string;
  private updateListeners: Array<() => void> = [];
  private watcherEventDisposable: { dispose: () => void } | null = null;
  private systemPrompt: string | null = null;

  readonly settingsReader = new SettingsReader();
  readonly presetStore = new PresetStore();
  private readonly sseStrategy = new ClaudeSseStrategy();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async startWatching(sessionFile: string): Promise<void> {
    if (this.sessionFile === sessionFile) return;
    this.stopWatching();
    this.sessionFile = sessionFile;
    const dir = projectDir(this.cwd);

    // Seed parse from disk synchronously before watcher fires.
    this.seedParse(sessionFile);

    this.watcher = new ClaudeJsonlWatcher(dir);
    this.watcherEventDisposable = this.watcher.onEvents((filePath, events) => {
      if (filePath !== sessionFile) return;
      this.index.addEvents(events);
      for (const cb of this.updateListeners) cb();
    });
    this.watcher.acquire();

    // Sub-agent transcripts live in <session-uuid>/subagents/ next to the
    // session JSONL. Attribution is lazy (setSubagentLookup) — any update just
    // invalidates the turns cache and the next getPromptTurns re-attributes.
    this.index.setSubagentLookup((toolUseId) => this.subagentIndex.byToolUseId(toolUseId));
    const subagentsDir = path.join(dir, path.basename(sessionFile, '.jsonl'), 'subagents');
    this.subagentWatcher = new SubagentWatcher(subagentsDir);
    this.subagentWatcherDisposable = this.subagentWatcher.onUpdate((agentId, records, meta) => {
      if (this.subagentIndex.addRecords(agentId, records, meta)) {
        this.index.invalidateTurns();
        for (const cb of this.updateListeners) cb();
      }
    });
    this.subagentWatcher.start();
  }

  stopWatching(): void {
    this.watcherEventDisposable?.dispose();
    this.watcherEventDisposable = null;
    this.watcher?.release();
    this.watcher = null;
    this.subagentWatcherDisposable?.dispose();
    this.subagentWatcherDisposable = null;
    this.subagentWatcher?.stop();
    this.subagentWatcher = null;
    this.subagentIndex = new SubagentIndex();
    this.sessionFile = null;
    this.index = new ClaudeSessionIndex();
  }

  onUpdate(cb: () => void): { dispose: () => void } {
    this.updateListeners.push(cb);
    return { dispose: () => { this.updateListeners = this.updateListeners.filter((l) => l !== cb); } };
  }

  getPromptTurns(): UnifiedPromptTurn[] {
    return this.index.getPromptTurns();
  }

  getSystemPrompt(): string | null {
    return this.systemPrompt;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  getMetadata(): UnifiedSessionMeta {
    const sessionId = this.sessionFile ? path.basename(this.sessionFile, '.jsonl') : 'unknown';
    const mode = this.index.getLatestPermissionMode();
    const model = this.presetStore.getActive()?.model ?? null;
    return { kind: 'claude', model, cwd: this.cwd, mode, threadId: sessionId };
  }

  async launch(injector: PtyInjector, sessionId: string, proxyUrl?: string | null): Promise<void> {
    const envPath = this.presetStore.activeEnvPath();
    // Scope ANTHROPIC_BASE_URL to the claude process only (prefix assignment after
    // `set +a`) — NOT exported into the shell, so it can't leak into the next
    // proxy-off launch and cause ConnectionRefused to a dead proxy port.
    const prefix = proxyUrl ? `ANTHROPIC_BASE_URL=${shellEscape(proxyUrl)} ` : '';
    const cmd = `set -a; source ${shellEscape(envPath)}; set +a; ${prefix}claude`;
    await injector.sendLine(sessionId, cmd);
  }

  getMode(): string | null {
    return this.index.getLatestPermissionMode();
  }

  async setMode(mode: string, injector: PtyInjector, sessionId: string): Promise<void> {
    // Inject /permission-mode slash command
    await injector.fillLine(sessionId, `/permission-mode ${mode}`);
  }

  getEnvConfig(): EnvConfig {
    const active = this.presetStore.getActive();
    if (!active) return { baseUrl: null, model: null, apiKeyMasked: null };
    return {
      baseUrl: active.baseUrl ?? null,
      model: active.model ?? null,
      apiKeyMasked: active.apiKey ? maskSecret(active.apiKey) : null,
    };
  }

  async writeProxyEnv(_proxyUrl: string): Promise<void> {
    // The proxy base URL is injected at launch time from live state (see launch),
    // not persisted here — that avoids a stale proxy port lingering in active.env.
    // Keep active.env reflecting the pure preset so a proxy-off launch is clean.
    const active = this.presetStore.getActive();
    if (active) await this.presetStore.writeActiveEnv(active);
  }

  async restoreEnv(): Promise<void> {
    const active = this.presetStore.getActive();
    if (active) await this.presetStore.writeActiveEnv(active);
  }

  getSseStrategy() { return this.sseStrategy; }

  private seedParse(filePath: string): void {
    try {
      const text = fs.readFileSync(filePath, 'utf-8');
      const records = [];
      for (const line of text.split('\n')) {
        const r = parseJsonlLine(line);
        if (r) records.push(r);
      }
      this.index.addEvents(normalizeEvents(records));
    } catch { /* file may not exist yet */ }
  }

  /** Return the raw JSONL record map for the current session file (for raw viewer). */
  getRawRecordMap(): Map<string, Record<string, unknown>> {
    const out = new Map<string, Record<string, unknown>>();
    if (!this.sessionFile) return out;
    try {
      const text = fs.readFileSync(this.sessionFile, 'utf-8');
      for (const line of text.split('\n')) {
        const r = parseJsonlLine(line);
        if (r && typeof r.uuid === 'string') out.set(r.uuid, r);
      }
    } catch { /* ignore */ }
    return out;
  }

  getMainBranch() { return this.index.getMainBranch(); }
  getSessionFile() { return this.sessionFile; }
}

function shellEscape(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function maskSecret(s: string): string {
  if (s.length <= 10) return '***';
  return s.slice(0, 6) + '...' + s.slice(-4);
}
