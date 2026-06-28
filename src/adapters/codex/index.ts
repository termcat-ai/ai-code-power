import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { IAdapter, UnifiedPromptTurn, UnifiedSessionMeta, EnvConfig } from '../types';
import type { PtyInjector } from '../../shared/actions/pty-inject';
import { CodexJsonlWatcher } from './jsonl-watcher';
import { CodexSessionIndex } from './session-index';
import { CodexConfigReader } from './config-reader';
import { CodexSseStrategy } from './sse-strategy';
import { parseJsonlLine, normalizeRecords } from './jsonl-parser';

export class CodexAdapter implements IAdapter {
  readonly kind = 'codex' as const;

  private watcher: CodexJsonlWatcher = new CodexJsonlWatcher();
  private index: CodexSessionIndex = new CodexSessionIndex();
  private sessionFile: string | null = null;
  private cwd: string;
  private updateListeners: Array<() => void> = [];
  private watcherDisposable: { dispose: () => void } | null = null;

  private readonly configReader = new CodexConfigReader();
  private readonly sseStrategy = new CodexSseStrategy();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async startWatching(sessionFile: string): Promise<void> {
    if (this.sessionFile === sessionFile) return;
    this.stopWatching();
    this.sessionFile = sessionFile;

    const seedOffset = this.seedParse(sessionFile);

    this.watcherDisposable = this.watcher.onEvents((events) => {
      this.index.addEvents(events);
      for (const cb of this.updateListeners) cb();
    });
    this.watcher.start(sessionFile, seedOffset);
  }

  stopWatching(): void {
    this.watcherDisposable?.dispose();
    this.watcherDisposable = null;
    this.watcher.stop();
    this.sessionFile = null;
    this.index = new CodexSessionIndex();
  }

  onUpdate(cb: () => void): { dispose: () => void } {
    this.updateListeners.push(cb);
    return { dispose: () => { this.updateListeners = this.updateListeners.filter((l) => l !== cb); } };
  }

  getPromptTurns(): UnifiedPromptTurn[] {
    return this.index.getPromptTurns();
  }

  getSystemPrompt(): string | null {
    return this.index.getSystemPrompt(); // from session_meta.base_instructions
  }

  getMetadata(): UnifiedSessionMeta {
    const threadId = this.sessionFile ? extractThreadId(this.sessionFile) : 'unknown';
    const model = this.index.getLastModel();
    const mode = this.index.getApprovalMode();
    return { kind: 'codex', model, cwd: this.cwd, mode, threadId };
  }

  async launch(injector: PtyInjector, sessionId: string, proxyUrl?: string | null): Promise<void> {
    // Panel launches build the full command (preset key/baseUrl/model) in
    // extension.ts via buildCodexLaunch; this interface stub covers a bare launch.
    await injector.sendLine(sessionId, buildCodexLaunch({ proxyUrl }));
  }

  /**
   * Upstream the proxy must forward Codex traffic to. Depends on auth mode:
   * ChatGPT login → chatgpt.com/backend-api/codex; API key → api.openai.com/v1.
   * Resolved at loadEnvConfig() time (the proxy resolver is synchronous).
   */
  private upstreamBaseUrl = 'https://api.openai.com/v1';
  getUpstreamBaseUrl(): string { return this.upstreamBaseUrl; }

  getMode(): string | null {
    return this.index.getApprovalMode();
  }

  async setMode(mode: string, injector: PtyInjector, sessionId: string): Promise<void> {
    // codex reads approval_policy at startup and applies it via `-c` on the next
    // launch (see buildCodexLaunch). Reflect it in the in-memory index for display
    // and hint a restart — no config file is written (codex ignores config.json).
    this.index.setApprovalMode(mode);
    await injector.fillLine(sessionId, `# codex approval_policy='${mode}' — 重启 codex 后生效`);
  }

  private cachedConfig: EnvConfig | null = null;

  async loadEnvConfig(): Promise<void> {
    const cfg = await this.configReader.read();
    const apiKeyMasked = await this.configReader.readApiKeyMasked();
    this.cachedConfig = { baseUrl: cfg.baseUrl ?? null, model: cfg.model ?? this.index.getLastModel(), apiKeyMasked };
    this.upstreamBaseUrl = await resolveCodexUpstream();
  }

  getEnvConfig(): EnvConfig {
    return this.cachedConfig ?? { baseUrl: null, model: this.index.getLastModel(), apiKeyMasked: null };
  }

  async writeProxyEnv(_proxyUrl: string): Promise<void> {
    // No-op: launch() injects the proxy URL live via `codex -c openai_base_url`,
    // so nothing is persisted (a stale proxy.env would point at a dead port).
  }

  async restoreEnv(): Promise<void> {
    // Clean up any proxy.env left behind by older plugin versions.
    try {
      await fs.promises.unlink(proxyEnvPath());
    } catch { /* none to remove */ }
  }

  getSseStrategy() { return this.sseStrategy; }
  getSessionFile(): string | null { return this.sessionFile; }

  private seedParse(filePath: string): number {
    try {
      const buf = fs.readFileSync(filePath);
      const records = buf.toString('utf-8').split('\n').map(parseJsonlLine).filter(Boolean) as NonNullable<ReturnType<typeof parseJsonlLine>>[];
      this.index.addEvents(normalizeRecords(records));
      return buf.length;
    } catch { return 0; }
  }
}

export interface CodexLaunchOpts {
  /** Proxy URL — when set it wins the openai_base_url slot (proxy then forwards to baseUrl). */
  proxyUrl?: string | null;
  /** Preset base URL (relay/proxy station). Used when proxyUrl is absent. */
  baseUrl?: string | null;
  model?: string | null;
  approvalPolicy?: string | null;
}

/**
 * Build the `codex` launch command. Codex reads config at startup and has no env
 * var for base_url/model, so everything except the API key is injected as `-c`
 * overrides here (the key is sourced from codex-active.env before this command).
 * - openai_base_url ← proxyUrl ?? baseUrl. Codex appends `/responses`, so a proxy
 *   root (no /v1) receives `/responses` and forwards to the right upstream.
 * - approval_policy ∈ untrusted | on-request | never.
 */
export function buildCodexLaunch(opts: CodexLaunchOpts = {}): string {
  let cmd = 'codex';
  const base = opts.proxyUrl ?? opts.baseUrl;
  if (base) cmd += ` -c 'openai_base_url="${base}"'`;
  if (opts.model) cmd += ` -c 'model="${opts.model}"'`;
  if (opts.approvalPolicy) cmd += ` -c 'approval_policy="${opts.approvalPolicy}"'`;
  return cmd;
}

function extractThreadId(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const m = base.match(/([a-f0-9-]{32,})/i);
  return m ? m[1] : base.replace(/\.jsonl$/, '');
}

function proxyEnvPath(): string {
  return path.join(os.homedir(), '.codex', 'proxy.env');
}

/**
 * Decide which real endpoint Codex traffic should be forwarded to, based on
 * ~/.codex/auth.json. ChatGPT login (no API key, has access_token) talks to
 * chatgpt.com; an API key talks to api.openai.com. Defaults to api.openai.com.
 */
async function resolveCodexUpstream(): Promise<string> {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const j = JSON.parse(await fs.promises.readFile(authPath, 'utf-8')) as Record<string, unknown>;
    const apiKey = j.OPENAI_API_KEY;
    if (typeof apiKey === 'string' && apiKey.trim()) return 'https://api.openai.com/v1';
    const tokens = (j.tokens && typeof j.tokens === 'object') ? j.tokens as Record<string, unknown> : null;
    if (j.auth_mode === 'chatgpt' || (tokens && tokens.access_token)) {
      return 'https://chatgpt.com/backend-api/codex';
    }
  } catch { /* fall through to default */ }
  return 'https://api.openai.com/v1';
}

