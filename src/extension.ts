/**
 * ai-code-power plugin entry point.
 * Unified call-viewer for claude and codex CLIs.
 */

import * as path from 'path';
import { Store } from './core/state';
import type { PerTabState } from './core/types';
import { ClaudeAdapter } from './adapters/claude';
import { PresetStore, type Preset } from './adapters/claude/preset-store';
import { CodexAdapter, buildCodexLaunch } from './adapters/codex';
import { CodexPresetStore, type CodexPreset } from './adapters/codex/preset-store';
import type { IAdapter, UnifiedPromptTurn } from './adapters/types';
import { Detector } from './detector/process-watcher';
import type { TerminalHandle } from './detector/process-watcher';
import { ProxyServer } from './shared/proxy/proxy-server';
import { CaptureStore } from './shared/proxy/capture-store';
import { PtyInjector } from './shared/actions/pty-inject';
import { turnsToMsgBlocks } from './shared/ui/msg-block-adapter';
import { ClaudeSseStrategy } from './adapters/claude/sse-strategy';
import { CodexSseStrategy } from './adapters/codex/sse-strategy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { v4: uuidv4 } = require('uuid') as { v4: () => string };

// ---------------------------------------------------------------------------
// Host API shape
// ---------------------------------------------------------------------------

interface HostTerminalInfo {
  sessionId: string;
  shellPid?: number | null;
  isActive?: boolean;
}

interface ShowFormField {
  id: string;
  label: string;
  type?: 'text' | 'password' | 'textarea' | 'select';
  value?: string;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  options?: Array<{ label: string; value: string }>;
}

interface HostAPI {
  terminal: {
    getActiveTerminal(): Promise<HostTerminalInfo | null>;
    getTerminals(): Promise<HostTerminalInfo[]>;
    getPid(sessionId: string): Promise<number | null>;
    write(sessionId: string, data: string): Promise<void>;
    focus(sessionId: string): Promise<void>;
    onDidOpenTerminal(cb: (t: HostTerminalInfo) => void): { dispose: () => void };
    onDidCloseTerminal(cb: (t: HostTerminalInfo) => void): { dispose: () => void };
  };
  ui: {
    registerPanel(opts: unknown, onEvent?: (sectionId: string, eventId: string, payload: unknown) => void): { dispose: () => void };
    setPanelData(panelId: string, sections: unknown[]): void;
    showNotification(message: string, type?: 'info' | 'success' | 'warning' | 'error'): void;
    showConfirm(message: string, options?: { confirmText?: string; cancelText?: string }): Promise<boolean>;
    showInputBox(options: { title?: string; placeholder?: string; value?: string; password?: boolean }): Promise<string | undefined>;
    showForm(options: { title?: string; description?: string; fields: ShowFormField[]; submitText?: string; cancelText?: string }): Promise<Record<string, string> | undefined>;
    showMessage(options: { title?: string; content?: string; format?: 'plain' | 'pre' | 'code'; tabs?: Array<{ label: string; content: string; format?: string }>; closeText?: string }): Promise<void>;
  };
  events: {
    emit(name: string, data?: unknown): void;
    on(name: string, cb: (...args: unknown[]) => void): { dispose: () => void };
  };
}

type SectionDescriptor = {
  id?: string;
  template: string;
  data: unknown;
  fill?: boolean;
  variant?: string;
};

type PluginContext = { api: HostAPI; logger: unknown };

const PANEL_ID = 'ai-code-power';
const DRIVE_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
// Real codex 0.142 approval_policy values (on-failure is deprecated, omitted).
// Applied at launch via `codex -c approval_policy=...`, not a config file.
const CODEX_APPROVAL_MODES = ['untrusted', 'on-request', 'never'] as const;

// ---------------------------------------------------------------------------
// Module-level singletons
// ---------------------------------------------------------------------------

let api: HostAPI;
let store: Store;
let captureStore: CaptureStore;
let proxyServer: ProxyServer;
let injector: PtyInjector;
let detector: Detector;
let claudePresetStore: PresetStore;
let codexPresetStore: CodexPresetStore;
let selectedCliKind: 'claude' | 'codex' = 'claude';
// Approval policy chosen in the panel, injected into the next codex launch
// (`-c approval_policy=...`). null = no override, leave codex's own default.
let selectedCodexApproval: typeof CODEX_APPROVAL_MODES[number] | null = null;
// When proxy was last enabled. Used to decide whether traffic has been captured
// since — i.e. whether the user still needs to relaunch the CLI. null = proxy off.
let proxyEnabledAt: number | null = null;
let disposables: Array<{ dispose: () => void }> = [];

const knownTerminals = new Map<string, HostTerminalInfo>();

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

export async function activate(context: PluginContext): Promise<void> {
  if (!context.api) throw new Error('ai-code-power: host did not inject .api');
  api = context.api;

  claudePresetStore = new PresetStore();
  await claudePresetStore.load().catch(() => {});
  codexPresetStore = new CodexPresetStore();
  await codexPresetStore.load().catch(() => {});

  store = new Store();
  captureStore = new CaptureStore(200);
  proxyServer = new ProxyServer(captureStore, () => {
    const activeId = store.getState().activeTabSessionId;
    if (activeId) {
      const tab = store.getTab(activeId);
      const adapter = tab?.adapter;
      // Codex: a preset baseUrl (relay station) is the real upstream; otherwise
      // fall back to the auth-resolved endpoint (ChatGPT vs api.openai.com).
      if (adapter?.kind === 'codex') {
        return codexPresetStore.getActive()?.baseUrl || (adapter as CodexAdapter).getUpstreamBaseUrl();
      }
      const base = adapter?.getEnvConfig().baseUrl;
      if (base) return base;
    }
    return 'https://api.anthropic.com';
  }, () => {
    // Strategy resolver — evaluated per request so switching the CLI (dropdown or
    // a newly-detected process) never leaves the proxy parsing the wrong format.
    const activeId = store.getState().activeTabSessionId;
    const adapter = activeId ? store.getTab(activeId)?.adapter ?? null : null;
    return adapter?.getSseStrategy()
      ?? (selectedCliKind === 'codex' ? new CodexSseStrategy() : new ClaudeSseStrategy());
  });

  injector = new PtyInjector(
    (sid, data) => api.terminal.write(sid, data),
    (sid) => api.terminal.focus(sid).catch(() => {}),
  );

  // -----------------------------------------------------------------------
  // Detector
  // -----------------------------------------------------------------------

  detector = new Detector({
    getKnownSessions: (): TerminalHandle[] =>
      [...knownTerminals.values()].map((t) => ({
        sessionId: t.sessionId,
        getPid: () => api.terminal.getPid(t.sessionId),
      })),
    getActiveSessionId: () => store.getState().activeTabSessionId,
    onTabState: (detectedState) => void reconcileTab(detectedState),
  });
  detector.start();

  // -----------------------------------------------------------------------
  // Panel registration
  // -----------------------------------------------------------------------

  try {
    const panel = api.ui.registerPanel(
      {
        id: PANEL_ID,
        title: 'AI Code Viewer',
        icon: 'sparkles',
        slot: 'sidebar-right',
        defaultSize: 380,
        defaultVisible: false,
        priority: 15,
        sections: [],
      },
      (sectionId, eventId, payload) => {
        void handleEvent(sectionId, eventId, payload).catch(() => {});
      },
    );
    disposables.push(panel);
  } catch { /* non-fatal */ }

  // -----------------------------------------------------------------------
  // Terminal lifecycle
  // -----------------------------------------------------------------------

  disposables.push(
    api.terminal.onDidOpenTerminal((term) => {
      knownTerminals.set(term.sessionId, term);
      detector.triggerNow();
    }),
    api.terminal.onDidCloseTerminal((term) => {
      knownTerminals.delete(term.sessionId);
      store.removeTab(term.sessionId);
    }),
    api.events.on('terminal:active-change', (sessionId: unknown) => {
      if (typeof sessionId === 'string') {
        store.setActiveTab(sessionId);
        pushPanel(sessionId);
      }
    }),
  );

  // Seed already-open terminals
  try {
    const existing = await api.terminal.getTerminals();
    for (const t of existing) knownTerminals.set(t.sessionId, t);
    const active = existing.find((t) => t.isActive);
    if (active) {
      store.setActiveTab(active.sessionId);
      pushPanel(active.sessionId);
    }
    if (knownTerminals.size > 0) detector.triggerNow();
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Deactivate
// ---------------------------------------------------------------------------

export function deactivate(): void {
  detector?.stop();
  for (const d of disposables) { try { d.dispose(); } catch { /* ignore */ } }
  disposables = [];
  for (const [, tab] of store.getState().perTabStates) {
    tab.adapter?.stopWatching();
  }
  proxyServer?.stop().catch(() => {});
  knownTerminals.clear();
}

// ---------------------------------------------------------------------------
// Tab reconciliation
// ---------------------------------------------------------------------------

async function reconcileTab(detected: PerTabState): Promise<void> {
  const existing = store.getTab(detected.sessionId);
  const existingKind = existing?.adapter?.kind ?? null;
  const newKind = detected.kind;

  let adapter: IAdapter | null = existing?.adapter ?? null;

  if (newKind !== existingKind) {
    if (adapter) { adapter.stopWatching(); adapter = null; }

    if (newKind === 'claude' && detected.detectedCwd) {
      const claudeAdapter = new ClaudeAdapter(detected.detectedCwd);
      await claudeAdapter.presetStore.load();
      adapter = claudeAdapter;
    } else if (newKind === 'codex' && detected.detectedCwd) {
      const codexAdapter = new CodexAdapter(detected.detectedCwd);
      await codexAdapter.loadEnvConfig().catch(() => {});
      adapter = codexAdapter;
    }

    if (adapter) {
      disposables.push(adapter.onUpdate(() => pushPanel(detected.sessionId)));
    }
  }

  if (adapter && detected.sessionFile && detected.sessionFile !== existing?.sessionFile) {
    await adapter.startWatching(detected.sessionFile);
  }

  detected.adapter = adapter;
  store.upsertTab(detected);
  pushPanel(detected.sessionId);
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

// Enable/disable proxy capture toward a target state (driven by the header
// "请求捕捉" checkbox). Idempotent: a no-op when already in the requested state.
async function setProxyCapture(activeId: string, adapter: IAdapter | null, enable: boolean): Promise<void> {
  if (enable === store.getState().proxyEnabled) return;
  if (!enable) {
    if (adapter) await adapter.restoreEnv().catch(() => {});
    await proxyServer.stop().catch(() => {});
    store.setProxyEnabled(false);
    proxyEnabledAt = null;
    api.ui.showNotification('Proxy stopped', 'info');
  } else {
    try {
      const port = proxyServer.getPort() ?? await proxyServer.start();
      if (port) {
        // launchCli reads the live proxy port directly, so no env file needs
        // pre-writing here. Claude still routes its base URL via writeProxyEnv.
        if (adapter) {
          await adapter.writeProxyEnv(`http://127.0.0.1:${port}`).catch(() => {});
        }
        store.setProxyEnabled(true);
        proxyEnabledAt = Date.now();
        api.ui.showNotification(`Proxy started on :${port}`, 'success');
        // The proxy only sees traffic from a CLI launched through it. A CLI
        // already running bypasses it — warn the user to relaunch.
        const st = store.getTab(activeId)?.status;
        if (st === 'active' || st === 'active-idle') {
          const cliLabel = (adapter?.kind ?? selectedCliKind) === 'codex' ? 'Codex' : 'Claude';
          api.ui.showNotification(`代理已启用 — 需点 ▶ 重启 ${cliLabel} 才能抓取当前会话的完整上下行`, 'warning');
        }
      }
    } catch (err) {
      api.ui.showNotification(`Proxy start failed: ${String(err)}`, 'error');
    }
  }
  pushPanel(activeId);
}

async function handleEvent(sectionId: string, eventId: string, payload: unknown): Promise<void> {
  const activeId = store.getState().activeTabSessionId;
  if (!activeId) return;
  const tab = store.getTab(activeId);
  const adapter = tab?.adapter ?? null;
  const p = payload as Record<string, unknown> | undefined;

  // ── Toggle turn expansion ───────────────────────────────────────────────
  if (eventId === 'toggleExpand') {
    const target = Number((p as { itemId?: string } | undefined)?.itemId);
    if (Number.isFinite(target) && target > 0) {
      store.toggleTurnExpansion(activeId, target);
      pushPanel(activeId);
    }
    return;
  }

  // ── Goto turn → switch to 调用详情 tab and scroll ───────────────────────
  if (eventId === 'gotoTurn') {
    const target = Number((p as { itemId?: string } | undefined)?.itemId);
    if (!Number.isFinite(target) || target <= 0) return;
    const turns = adapter?.getPromptTurns() ?? [];
    const turn = turns.find((t) => t.index === target);
    if (turn) {
      store.setGoto(activeId, `user-${turn.index}-${turn._internalId ?? turn.index}`);
      pushPanel(activeId);
    }
    return;
  }

  // ── View raw JSONL for a turn ────────────────────────────────────────────
  if (eventId === 'viewRaw') {
    const target = Number((p as { itemId?: string } | undefined)?.itemId);
    if (!Number.isFinite(target) || target <= 0) return;
    await openRawTurnModal(target, activeId, adapter);
    return;
  }

  // ── Toggle proxy capture (header checkbox) ───────────────────────────────
  if (eventId === 'capture') {
    await setProxyCapture(activeId, adapter, Boolean((p as { checked?: boolean })?.checked));
    return;
  }

  // ── Launch CLI ──────────────────────────────────────────────────────────
  if (eventId === 'launchCli') {
    await launchCli(activeId, adapter);
    return;
  }

  // ── form field-change ────────────────────────────────────────────────────
  if (eventId === 'field-change' || eventId === 'form:change') {
    const fieldId = (p as { id?: string; fieldId?: string } | undefined)?.id
      ?? (p as { id?: string; fieldId?: string } | undefined)?.fieldId;
    const value = (p as { value?: string } | undefined)?.value ?? '';

    if (fieldId === 'cliType' && (value === 'claude' || value === 'codex')) {
      const st = store.getTab(activeId)?.status;
      if (st === 'active' || st === 'active-idle') {
        api.ui.showNotification('CLI 运行中，无法切换 — 请先退出当前 CLI', 'info');
        return;
      }
      selectedCliKind = value;
      pushPanel(activeId);
      return;
    }

    if (fieldId === 'preset' && value && adapter?.kind === 'claude') {
      const ps = (adapter as ClaudeAdapter).presetStore;
      await ps.setActive(value).catch(() => {});
      const newActive = ps.getActive();
      if (newActive) await ps.writeActiveEnv(newActive).catch(() => {});
      // Also sync plugin-level store
      await claudePresetStore.load().catch(() => {});
      pushPanel(activeId);
      return;
    }

    if (fieldId === 'preset' && value && (adapter?.kind ?? selectedCliKind) === 'codex') {
      await codexPresetStore.setActive(value).catch(() => {});
      const active = codexPresetStore.getActive();
      if (active) await codexPresetStore.writeActiveEnv(active).catch(() => {});
      pushPanel(activeId);
      return;
    }
    return;
  }

  // ── Cycle drive mode (Claude) ────────────────────────────────────────────
  if (eventId === 'cycleDriveMode') {
    if (adapter?.kind !== 'claude') {
      api.ui.showNotification('Drive mode is only available for Claude', 'info');
      return;
    }
    const current = adapter.getMode() ?? 'default';
    const idx = DRIVE_MODES.indexOf(current as typeof DRIVE_MODES[number]);
    const next = DRIVE_MODES[(idx + 1) % DRIVE_MODES.length];
    await adapter.setMode(next, injector, activeId).catch(() => {});
    pushPanel(activeId);
    return;
  }

  // ── Cycle approval mode (Codex) ──────────────────────────────────────────
  // Codex reads approval_policy at startup and can't change it mid-session, so
  // we just record the choice and inject it into the next launch (-c approval_policy).
  if (eventId === 'cycleApprovalMode') {
    const running = adapter?.kind === 'codex' ? adapter.getMode() : null;
    const current = selectedCodexApproval ?? running;
    const idx = CODEX_APPROVAL_MODES.indexOf(current as typeof CODEX_APPROVAL_MODES[number]);
    selectedCodexApproval = CODEX_APPROVAL_MODES[(idx + 1) % CODEX_APPROVAL_MODES.length];
    if (running) {
      api.ui.showNotification(`approval_policy → ${selectedCodexApproval}（重启 codex 后生效）`, 'info');
    }
    pushPanel(activeId);
    return;
  }

  // ── Create preset ────────────────────────────────────────────────────────
  if (eventId === 'createPreset') {
    await presetFlow(activeId, null);
    return;
  }

  // ── Edit preset ──────────────────────────────────────────────────────────
  if (eventId === 'editPreset') {
    const active = (adapter?.kind ?? selectedCliKind) === 'codex'
      ? codexPresetStore.getActive()
      : ((adapter?.kind === 'claude'
          ? (adapter as ClaudeAdapter).presetStore.getActive()
          : null) ?? claudePresetStore.getActive());
    await presetFlow(activeId, active ?? null);
    return;
  }

  void sectionId; // suppress unused warning
}

// ---------------------------------------------------------------------------
// Launch helper
// ---------------------------------------------------------------------------

async function launchCli(sessionId: string, adapter: IAdapter | null): Promise<void> {
  // Use the proxy only when it's actually enabled and running right now — never
  // a stale ~/.codex/proxy.env from a previous session (dead port = can't connect).
  const proxyUrl = (store.getState().proxyEnabled && proxyServer.getPort())
    ? `http://127.0.0.1:${proxyServer.getPort()}`
    : null;

  const kind = adapter?.kind ?? selectedCliKind;

  // Codex: source the preset's OPENAI_API_KEY (kept off the command line), then
  // inject baseUrl/model/approval_policy as `-c` overrides (codex has no env var
  // for those). Proxy, when on, wins the openai_base_url slot and forwards to the
  // preset baseUrl via the proxy upstream resolver.
  if (kind === 'codex') {
    const preset = codexPresetStore.getActive();
    const cmd = buildCodexLaunch({
      proxyUrl,
      baseUrl: preset?.baseUrl,
      model: preset?.model,
      approvalPolicy: selectedCodexApproval,
    });
    const full = preset?.apiKey
      ? `set -a; source '${codexPresetStore.activeEnvPath()}'; set +a; ${cmd}`
      : cmd;
    await injector.sendLine(sessionId, full).catch(() => {});
    return;
  }

  // Claude
  if (adapter) {
    await adapter.launch(injector, sessionId, proxyUrl).catch(() => {});
    return;
  }
  // No live adapter — claude
  const preset = claudePresetStore.getActive();
  if (preset) {
    await claudePresetStore.writeActiveEnv(preset).catch(() => {});
    const envPath = claudePresetStore.activeEnvPath();
    // Prefix form: scoped to claude only, never exported into the shell.
    const prefix = proxyUrl ? `ANTHROPIC_BASE_URL='${proxyUrl}' ` : '';
    await injector.sendLine(sessionId, `set -a; source '${envPath}'; set +a; ${prefix}claude`);
  } else if (proxyUrl) {
    await injector.sendLine(sessionId, `ANTHROPIC_BASE_URL='${proxyUrl}' claude`);
  } else {
    await injector.sendLine(sessionId, 'claude');
  }
}

// ---------------------------------------------------------------------------
// Preset create / edit flow
// ---------------------------------------------------------------------------

async function presetFlow(sessionId: string, existing: Preset | CodexPreset | null): Promise<void> {
  const kind = store.getTab(sessionId)?.adapter?.kind ?? selectedCliKind;
  const isCodex = kind === 'codex';
  const isEdit = existing !== null;
  const result = await api.ui.showForm({
    title: isEdit ? `Edit Preset: ${existing!.name}` : 'Create Preset',
    fields: [
      { id: 'name', label: 'Name', type: 'text', value: existing?.name ?? '', required: true, placeholder: 'My Preset' },
      { id: 'apiKey', label: 'API Key', type: 'password', value: existing?.apiKey ?? '', placeholder: isCodex ? 'sk-...' : 'sk-ant-...' },
      { id: 'baseUrl', label: 'Base URL', type: 'text', value: existing?.baseUrl ?? '', placeholder: isCodex ? 'https://中转站/v1' : 'https://api.anthropic.com' },
      { id: 'model', label: 'Model', type: 'text', value: existing?.model ?? '', placeholder: isCodex ? 'gpt-5.5' : 'claude-sonnet-4-6' },
    ],
    submitText: isEdit ? 'Save' : 'Create',
    cancelText: 'Cancel',
  }).catch(() => undefined);

  if (!result || !result.name) return;

  const preset = {
    id: existing?.id ?? uuidv4(),
    name: result.name,
    ...(result.apiKey ? { apiKey: result.apiKey } : {}),
    ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}),
    ...(result.model ? { model: result.model } : {}),
  };

  if (isCodex) {
    await codexPresetStore.upsert(preset).catch(() => {});
    await codexPresetStore.setActive(preset.id).catch(() => {});
    await codexPresetStore.writeActiveEnv(preset).catch(() => {});
  } else {
    // Claude: a running adapter owns its own store; otherwise the plugin-level one.
    const ps = store.getTab(sessionId)?.adapter?.kind === 'claude'
      ? (store.getTab(sessionId)!.adapter as ClaudeAdapter).presetStore
      : claudePresetStore;
    await ps.upsert(preset).catch(() => {});
    await ps.setActive(preset.id).catch(() => {});
    await ps.writeActiveEnv(preset).catch(() => {});
    await claudePresetStore.load().catch(() => {}); // sync plugin-level cache
  }

  api.ui.showNotification(`Preset "${preset.name}" ${isEdit ? 'updated' : 'created'}`, 'success');
  pushPanel(sessionId);
}

// ---------------------------------------------------------------------------
// Raw turn viewer
// ---------------------------------------------------------------------------

type RawTab = { label: string; content: string; format: 'pre' };
type RawGroup = { label: string; tabs: RawTab[] };
type RawResult = { tabs: RawTab[] } | { groups: RawGroup[] };

function fmtN(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

/** Merge Anthropic SSE stream into readable text (text deltas + tool inputs + usage). */
function mergeResponseSse(rawSse: string): string {
  type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: string };
  const blocks = new Map<number, Block>();
  let model = '';
  let inputTokens = 0, outputTokens = 0, cacheRead = 0;
  let stopReason = '';

  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }

    if (d.type === 'message_start') {
      const msg = d.message as Record<string, unknown> | undefined;
      model = (msg?.model as string) ?? '';
      const u = msg?.usage as Record<string, number> | undefined;
      if (u) {
        inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        cacheRead = u.cache_read_input_tokens ?? 0;
      }
    }
    if (d.type === 'content_block_start') {
      const idx = d.index as number;
      const cb = d.content_block as Record<string, unknown> | undefined;
      if (cb?.type === 'text') blocks.set(idx, { type: 'text', text: '' });
      else if (cb?.type === 'tool_use') blocks.set(idx, { type: 'tool_use', name: (cb.name as string) ?? '', input: '' });
    }
    if (d.type === 'content_block_delta') {
      const idx = d.index as number;
      const blk = blocks.get(idx);
      const delta = d.delta as Record<string, unknown> | undefined;
      if (blk?.type === 'text' && delta?.type === 'text_delta') blk.text += (delta.text as string) ?? '';
      if (blk?.type === 'tool_use' && delta?.type === 'input_json_delta') blk.input += (delta.partial_json as string) ?? '';
    }
    if (d.type === 'message_delta') {
      const delta = d.delta as Record<string, unknown> | undefined;
      stopReason = (delta?.stop_reason as string) ?? '';
      const u = d.usage as Record<string, number> | undefined;
      if (u?.output_tokens) outputTokens = u.output_tokens;
    }
  }

  const meta: string[] = [];
  if (model) meta.push(`model: ${model}`);
  if (inputTokens > 0) meta.push(`in: ${fmtN(inputTokens)}`);
  if (outputTokens > 0) meta.push(`out: ${fmtN(outputTokens)}`);
  if (cacheRead > 0) meta.push(`cache: ${fmtN(cacheRead)}`);
  if (stopReason) meta.push(`stop: ${stopReason}`);

  const out: string[] = [`# ${meta.join('  |  ')}`];
  const SEP = '─'.repeat(60);
  for (const [, blk] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
    out.push('');
    if (blk.type === 'text') {
      out.push(blk.text || '(empty text block)');
    } else {
      out.push(SEP);
      out.push(`[TOOL USE: ${blk.name}]`);
      try { out.push(JSON.stringify(JSON.parse(blk.input), null, 2)); }
      catch { out.push(blk.input || '{}'); }
      out.push(SEP);
    }
  }
  if (blocks.size === 0) out.push('\n(no content blocks found)');
  return out.join('\n');
}

/** Parse token counts from raw Anthropic SSE stream. */
function parseUsageFromSse(rawSse: string): { input: number; output: number; cacheRead: number } | null {
  let input = 0, output = 0, cacheRead = 0, found = false;
  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
      if (d.type === 'message_start') {
        const u = (d.message as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
        if (u) {
          input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          cacheRead = u.cache_read_input_tokens ?? 0;
          found = true;
        }
      }
      if (d.type === 'message_delta') {
        const u = d.usage as Record<string, number> | undefined;
        if (u?.output_tokens) output = u.output_tokens;
      }
    } catch { /* skip */ }
  }
  return found ? { input, output, cacheRead } : null;
}

/** Format a JSONL assistant message into readable text (fallback when no proxy). */
function formatAssistantMsgFromJsonl(msg: Record<string, unknown>): string {
  const meta: string[] = [];
  if (msg.model) meta.push(`model: ${msg.model as string}`);
  const usage = msg.usage as Record<string, number> | undefined;
  if (usage) {
    const inp = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    if (inp) meta.push(`in: ${fmtN(inp)}`);
    if (usage.output_tokens) meta.push(`out: ${fmtN(usage.output_tokens)}`);
    if (usage.cache_read_input_tokens) meta.push(`cache: ${fmtN(usage.cache_read_input_tokens)}`);
  }
  if (msg.stop_reason) meta.push(`stop: ${msg.stop_reason as string}`);

  const out: string[] = [
    `# ${meta.join('  |  ')}`,
    '# (JSONL 重建 — 系统提示词未存储；启用 proxy 可捕获完整 SSE)',
  ];
  const content = msg.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return out.join('\n');
  const SEP = '─'.repeat(60);
  for (const block of content) {
    out.push('');
    if (block.type === 'text') {
      out.push((block.text as string) ?? '');
    } else if (block.type === 'tool_use') {
      out.push(SEP);
      out.push(`[TOOL USE: ${block.name as string}]`);
      try { out.push(JSON.stringify(block.input, null, 2)); }
      catch { out.push(String(block.input)); }
      out.push(SEP);
    }
  }
  return out.join('\n');
}

/** Build raw view for Codex turns from JSONL data (no proxy needed). */
function buildCodexRawResult(turn: UnifiedPromptTurn): RawResult {
  const SEP = '─'.repeat(60);
  const NOTE = '# (JSONL 重建 — 启用 proxy 可捕获完整 SSE 流)\n';

  // idx: 0-based index into turn.apiCalls
  const makeTabs = (call: UnifiedPromptTurn['apiCalls'][0], idx: number): RawTab[] => {
    const u = call.tokenUsage;
    const upSuffix = (u.freshInputTokens > 0 || u.cacheReadTokens > 0)
      ? `  · in:${fmtN(u.freshInputTokens)}${u.cacheReadTokens > 0 ? ` cache:${fmtN(u.cacheReadTokens)}` : ''}`
      : '';
    const outParts: string[] = [];
    if (u.outputTokens > 0) outParts.push(`out:${fmtN(u.outputTokens)}`);
    if (u.reasoningTokens > 0) outParts.push(`reasoning:${fmtN(u.reasoningTokens)}`);
    const outSuffix = outParts.length ? `  · ${outParts.join(' ')}` : '';

    // 上行（REQUEST）:
    //   Call 0 (first): user prompt — the message that triggered this turn
    //   Call N>0: tool results returned by tools in the previous call
    const upLines: string[] = [NOTE];
    if (idx === 0) {
      upLines.push('[USER PROMPT]');
      upLines.push(turn.userText || '(empty)');
    } else {
      const prevToolCalls = turn.apiCalls[idx - 1]?.toolCalls ?? [];
      const resultsWithOutput = prevToolCalls.filter((tc) => tc.output != null);
      if (resultsWithOutput.length > 0) {
        for (const tc of resultsWithOutput) {
          upLines.push('');
          upLines.push(SEP);
          upLines.push(`[TOOL RESULT: ${tc.name}]${tc.isError ? ' (ERROR)' : ''}`);
          upLines.push((tc.output as string).slice(0, 3000) + ((tc.output as string).length > 3000 ? '\n... (truncated)' : ''));
          upLines.push(SEP);
        }
      } else {
        upLines.push('\n(无工具结果输入)');
      }
    }

    // 下行（合并）: tool calls made by the model + assistant text
    const downLines: string[] = [NOTE];
    let hasDown = false;
    for (const tc of call.toolCalls) {
      downLines.push('');
      downLines.push(SEP);
      downLines.push(`[TOOL CALL: ${tc.name}]`);
      try { downLines.push(JSON.stringify(tc.input, null, 2)); } catch { downLines.push(String(tc.input)); }
      downLines.push(SEP);
      hasDown = true;
    }
    if (call.assistantText) {
      downLines.push('');
      downLines.push('[ASSISTANT]');
      downLines.push(call.assistantText);
      hasDown = true;
    }
    if (!hasDown) downLines.push('\n(暂无响应内容)');

    return [
      { label: `上行（REQUEST）${upSuffix}`, content: upLines.join('\n'), format: 'pre' },
      { label: `下行（合并）${outSuffix}`, content: downLines.join('\n'), format: 'pre' },
    ];
  };

  if (!turn.apiCalls.length) {
    return { tabs: [{ label: '调用详情', content: NOTE + '调用进行中，尚未收到模型响应或 token 统计，请稍后查看', format: 'pre' }] };
  }
  if (turn.apiCalls.length === 1) {
    return { tabs: makeTabs(turn.apiCalls[0], 0) };
  }
  return { groups: turn.apiCalls.map((c, i) => ({ label: `调用 ${i + 1}`, tabs: makeTabs(c, i) })) };
}

/** Build RawResult for showMessage: proxy captures first, JSONL fallback. */
function buildRawResult(turn: UnifiedPromptTurn, adapter: IAdapter | null): RawResult {
  const errTab = (msg: string): RawResult => ({ tabs: [{ label: 'Error', content: msg, format: 'pre' }] });

  // ── Proxy capture path ───────────────────────────────────────────────────
  const userTs = turn.ts;
  const captures = captureStore
    .getByTimeRange(userTs - 5_000, userTs + 120_000)
    .sort((a, b) => a.captureTs - b.captureTs);
  console.log(`[ai-code-power] buildRawResult: userTs=${userTs}(${new Date(userTs).toISOString()}) now=${Date.now()} storeSize=${captureStore.size()} capturesInWindow=${captures.length}`);

  if (captures.length > 0) {
    // Use the adapter's own SSE strategy for parsing (OpenAI vs Anthropic formats differ).
    const strategy = adapter?.getSseStrategy() ?? null;
    const makeTabs = (c: typeof captures[0]): RawTab[] => {
      const ts = new Date(c.captureTs).toISOString();
      const upNote = `# ${ts}  upstream: ${c.upstreamUrl}\n\n`;
      const reqJson = JSON.stringify(c.request, null, 2);

      // Parse token usage via strategy (handles both OpenAI and Anthropic SSE formats).
      const unifiedUsage = c.rawResponseSse && strategy ? strategy.parseUsage(c.rawResponseSse) : null;
      // Fall back to Anthropic-specific parser for Claude when no strategy.
      const legacyUsage = !unifiedUsage && c.rawResponseSse ? parseUsageFromSse(c.rawResponseSse) : null;

      const freshIn = unifiedUsage ? unifiedUsage.freshInputTokens
        : legacyUsage ? legacyUsage.input - legacyUsage.cacheRead : 0;
      const cacheRead = unifiedUsage ? unifiedUsage.cacheReadTokens : legacyUsage?.cacheRead ?? 0;
      const outTokens = unifiedUsage ? unifiedUsage.outputTokens : legacyUsage?.output ?? 0;

      const upSuffix = (freshIn > 0 || cacheRead > 0)
        ? `  · in:${fmtN(freshIn)}${cacheRead > 0 ? ` cache:${fmtN(cacheRead)}` : ''}`
        : '';
      const outSuffix = outTokens > 0 ? `  · out:${fmtN(outTokens)}` : '';
      const rawSse = c.rawResponseSse ?? '(not yet captured)';
      // Merge SSE via strategy (correct format) or fall back to Anthropic merger.
      const merged = c.rawResponseSse
        ? (strategy ? strategy.mergeSse(c.rawResponseSse) : mergeResponseSse(c.rawResponseSse))
        : '(not yet captured)';
      return [
        { label: `上行（REQUEST）${upSuffix}`, content: upNote + reqJson, format: 'pre' },
        { label: `下行（流式）${outSuffix}`, content: rawSse, format: 'pre' },
        { label: `下行（合并）${outSuffix}`, content: merged, format: 'pre' },
      ];
    };
    if (captures.length === 1) return { tabs: makeTabs(captures[0]) };
    return { groups: captures.map((c, i) => ({ label: `调用 ${i + 1}`, tabs: makeTabs(c) })) };
  }

  // ── Codex JSONL reconstruction path ─────────────────────────────────────
  if (adapter?.kind === 'codex') {
    return buildCodexRawResult(turn);
  }

  // ── JSONL reconstruction path (Claude only) ─────────────────────────────
  if (adapter?.kind !== 'claude') {
    return errTab('No proxy captures available. Enable proxy to capture API traffic.');
  }
  const claudeAdapter = adapter as ClaudeAdapter;
  const rawByUuid = claudeAdapter.getRawRecordMap();
  const branch = claudeAdapter.getMainBranch();

  const JSONL_NOTE = '# JSONL 重建 — 系统提示词和工具定义未存储\n# 启用 proxy 可捕获完整 SSE 流。\n\n';
  const userUuid = turn._internalId;
  if (!userUuid) return errTab('Turn UUID not found');

  // Identify assistant UUIDs for this turn (between this user prompt and the next)
  const turnAssistantUuids = new Set<string>();
  let inTurn = false;
  let stopUuid: string | null = null;
  for (const e of branch) {
    if (e.kind === 'user-prompt') {
      if (e.uuid === userUuid) { inTurn = true; continue; }
      if (inTurn) { stopUuid = e.uuid; break; }
    }
    if (inTurn && e.kind === 'assistant-msg') turnAssistantUuids.add(e.uuid);
  }

  // Walk branch to build cumulative messages and per-call entries
  type CallEntry = { upstream: object[]; responseMsg: Record<string, unknown> };
  const callEntries: CallEntry[] = [];
  const cumMsgs: object[] = [];

  for (const e of branch) {
    if (e.uuid === stopUuid) break;
    const raw = rawByUuid.get(e.uuid);
    if (!raw) continue;
    if (raw.type === 'user' && !raw.isMeta) {
      const msg = raw.message as Record<string, unknown> | undefined;
      if (msg) cumMsgs.push({ role: 'user', content: msg.content });
    } else if (raw.type === 'assistant') {
      const msg = raw.message as Record<string, unknown> | undefined;
      if (msg) {
        if (turnAssistantUuids.has(e.uuid)) callEntries.push({ upstream: [...cumMsgs], responseMsg: msg });
        cumMsgs.push({ role: 'assistant', content: msg.content });
      }
    }
  }

  if (callEntries.length === 0) return errTab('No assistant events found in JSONL for this turn');

  const makeJsonlTabs = (entry: CallEntry): RawTab[] => {
    const usage = entry.responseMsg.usage as Record<string, number> | undefined;
    const freshIn = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    const out = usage?.output_tokens ?? 0;
    const upSuffix = freshIn > 0 || cacheRead > 0
      ? `  · in:${fmtN(freshIn)}${cacheRead > 0 ? ` cache:${fmtN(cacheRead)}` : ''}`
      : '';
    const outSuffix = out > 0 ? `  · out:${fmtN(out)}` : '';
    return [
      { label: `上行（REQUEST）${upSuffix}`, content: JSONL_NOTE + JSON.stringify(entry.upstream, null, 2), format: 'pre' },
      { label: `下行（合并）${outSuffix}`, content: formatAssistantMsgFromJsonl(entry.responseMsg), format: 'pre' },
    ];
  };

  if (callEntries.length === 1) return { tabs: makeJsonlTabs(callEntries[0]) };
  return { groups: callEntries.map((entry, i) => ({ label: `调用 ${i + 1}`, tabs: makeJsonlTabs(entry) })) };
}

async function openRawTurnModal(turnIndex: number, sessionId: string, adapter: IAdapter | null): Promise<void> {
  const turns = adapter?.getPromptTurns() ?? [];
  const turn = turns.find((t) => t.index === turnIndex);
  if (!turn) {
    api.ui.showNotification('Turn not found', 'warning');
    return;
  }
  const result = buildRawResult(turn, adapter);
  await api.ui.showMessage({ title: `Turn #${turnIndex} — Raw`, ...result });
}

// ---------------------------------------------------------------------------
// Panel sections helpers
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

function buildHistorySections(turns: UnifiedPromptTurn[], expandedTurns: Set<number>): SectionDescriptor[] {
  if (!turns.length) {
    return [{ id: 'history-empty', template: 'text', data: { content: '尚无历史 — 第一次输入 prompt 后会在这里出现', format: 'plain', color: 'muted' } }];
  }

  const sections: SectionDescriptor[] = [];
  const reversed = turns.slice().reverse();

  for (const turn of reversed) {
    const expanded = expandedTurns.has(turn.index);
    const preview = turn.userText.replace(/\n+/g, ' ').slice(0, 140);
    const toolCount = turn.apiCalls.reduce((acc, c) => acc + c.toolCalls.length, 0);
    const cacheTokens = turn.totalTokens.cacheReadTokens;

    const inlineBadges: Array<{ icon: string; text: string; color: string }> = [];
    if (toolCount > 0) inlineBadges.push({ icon: 'wrench', text: String(toolCount), color: 'muted' });
    if (turn.totalTokens.freshInputTokens > 0) inlineBadges.push({ icon: 'arrow-up', text: fmtTokens(turn.totalTokens.freshInputTokens), color: 'muted' });
    if (turn.totalTokens.outputTokens > 0) inlineBadges.push({ icon: 'arrow-down', text: fmtTokens(turn.totalTokens.outputTokens), color: 'muted' });
    if (cacheTokens > 0) inlineBadges.push({ icon: 'database', text: fmtTokens(cacheTokens), color: 'info' });

    sections.push({
      id: `turn-${turn.index}`,
      template: 'list',
      data: {
        items: [{
          id: String(turn.index),
          label: `#${turn.index}  ${preview || '(empty)'}`,
          inlineBadges,
          leadingAction: { id: 'toggleExpand', icon: expanded ? 'chevron-down' : 'chevron-right', tooltip: expanded ? '收起' : '展开' },
          actions: [
            { id: 'viewRaw', icon: 'code', tooltip: '查看原始记录' },
            { id: 'gotoTurn', icon: 'arrow-right', tooltip: '调用详情' },
          ],
        }],
        selectable: false,
        itemHeight: 52,
      },
    });

    if (expanded) {
      for (const call of turn.apiCalls) {
        for (const tool of call.toolCalls) {
          const inputObj = (tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input))
            ? tool.input as Record<string, unknown> : null;
          const hint = String(inputObj?.file_path ?? inputObj?.path ?? inputObj?.cmd ?? inputObj?.command ?? inputObj?.query ?? '');
          const shortHint = hint.length > 60 ? hint.slice(0, 57) + '...' : hint;
          sections.push({
            id: `turn-${turn.index}-tool-${tool.id}`,
            template: 'list',
            variant: 'nested',
            data: {
              items: [{
                id: tool.id,
                label: tool.name,
                description: shortHint,
                icon: tool.kind === 'mcp' ? 'plug' : tool.kind === 'skill' ? 'sparkles' : tool.kind === 'task' ? 'bot' : 'wrench',
                color: tool.isError ? 'danger' : 'muted',
              }],
            },
          });
        }
      }
    }
  }

  return sections;
}

function buildControlsSection(adapter: IAdapter | null, tab: PerTabState | undefined): SectionDescriptor {
  // Layout follows the *selected* CLI even before its process is detected
  // (adapter is null until then), so picking Codex never falls back to Claude's
  // Preset/Drive fields — which don't apply to Codex.
  const kind = adapter?.kind ?? selectedCliKind;
  const mode = adapter?.getMode() ?? null;
  const sessionFile = tab?.sessionFile ?? null;
  const sessionLabel = sessionFile ? `● ${path.basename(sessionFile, '.jsonl').slice(0, 22)}…` : '—';

  // CLI type selector (always shown at top). Locked while a CLI process is
  // running — switching CLI mid-session would desync panel from the live process.
  const running = tab?.status === 'active' || tab?.status === 'active-idle';
  const cliTypeField = {
    id: 'cliType',
    type: 'select',
    label: 'CLI',
    value: adapter ? adapter.kind : selectedCliKind,
    disabled: running,
    options: [
      { label: 'Claude Code', value: 'claude' },
      { label: 'Codex', value: 'codex' },
    ],
  };

  if (kind === 'claude') {
    const ps = adapter ? (adapter as ClaudeAdapter).presetStore : claudePresetStore;
    const presets = ps.list();
    const activePreset = ps.getActive();
    const presetOptions = presets.length
      ? presets.map((p) => ({ label: p.model ? `${p.name} · ${p.model}` : p.name, value: p.id }))
      : [{ label: '(no presets)', value: '' }];

    return {
      id: 'controls',
      template: 'form',
      variant: 'compact',
      data: {
        fields: [
          cliTypeField,
          {
            id: 'preset',
            type: 'select',
            label: 'PRESET',
            value: activePreset?.id ?? '',
            options: presetOptions,
            trailingActions: activePreset
              ? [
                  { id: 'editPreset', icon: 'settings', tooltip: 'Edit preset' },
                  { id: 'createPreset', icon: 'plus', tooltip: 'New preset' },
                ]
              : [{ id: 'createPreset', icon: 'plus', tooltip: 'New preset' }],
          },
          {
            id: 'driveMode',
            type: 'text',
            label: 'DRIVE 模式',
            value: mode ?? 'default',
            disabled: true,
            trailingActions: [{ id: 'cycleDriveMode', icon: 'refresh-cw', tooltip: 'Cycle drive mode' }],
          },
          {
            id: 'session',
            type: 'select',
            label: '会话',
            value: sessionFile ?? '',
            options: sessionFile
              ? [{ label: sessionLabel, value: sessionFile }]
              : [{ label: '—', value: '' }],
          },
        ],
      },
    };
  }

  // Codex controls
  const codexPresets = codexPresetStore.list();
  const activeCodexPreset = codexPresetStore.getActive();
  const codexPresetOptions = codexPresets.length
    ? codexPresets.map((p) => ({ label: p.model ? `${p.name} · ${p.model}` : p.name, value: p.id }))
    : [{ label: '(no presets)', value: '' }];

  return {
    id: 'controls',
    template: 'form',
    variant: 'compact',
    data: {
      fields: [
        cliTypeField,
        {
          id: 'preset',
          type: 'select',
          label: 'PRESET',
          value: activeCodexPreset?.id ?? '',
          options: codexPresetOptions,
          trailingActions: activeCodexPreset
            ? [
                { id: 'editPreset', icon: 'settings', tooltip: 'Edit preset' },
                { id: 'createPreset', icon: 'plus', tooltip: 'New preset' },
              ]
            : [{ id: 'createPreset', icon: 'plus', tooltip: 'New preset' }],
        },
        {
          id: 'approvalMode',
          type: 'text',
          label: '模式',
          value: selectedCodexApproval ?? mode ?? '—',
          disabled: true,
          trailingActions: [{ id: 'cycleApprovalMode', icon: 'refresh-cw', tooltip: '切换 approval_policy（下次启动 codex 生效）' }],
        },
        {
          id: 'session',
          type: 'select',
          label: '会话',
          value: sessionFile ?? '',
          options: sessionFile
            ? [{ label: sessionLabel, value: sessionFile }]
            : [{ label: '—', value: '' }],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Panel push
// ---------------------------------------------------------------------------

const BADGE_BY_STATUS: Record<string, { text: string; color: string }> = {
  idle: { text: '·', color: 'muted' },
  active: { text: '●', color: 'success' },
  'active-idle': { text: '○', color: 'warning' },
  stale: { text: '~', color: 'warning' },
};

function pushPanel(sessionId: string): void {
  const tab = store.getTab(sessionId);
  const adapter = tab?.adapter ?? null;
  const meta = adapter?.getMetadata() ?? null;
  const status = tab?.status ?? 'idle';
  const goto = store.getGoto(sessionId);
  const sections: SectionDescriptor[] = [];

  // 1. Header
  const cwd = meta?.cwd ?? tab?.detectedCwd ?? '';
  const cwdShort = cwd ? cwd.split('/').filter(Boolean).slice(-2).join('/') : '~';
  // Title follows the *selected* CLI even before its process is detected
  // (adapter/meta null until then), matching buildControlsSection's layout.
  const kindLabel = (adapter?.kind ?? selectedCliKind) === 'codex' ? 'Codex' : 'Claude Code';
  sections.push({
    id: 'header',
    template: 'header',
    data: {
      title: `${kindLabel} Power`,
      subtitle: cwdShort,
      icon: 'sparkles',
      badge: BADGE_BY_STATUS[status],
      checkbox: { id: 'capture', label: '请求捕捉', checked: store.getState().proxyEnabled },
      actions: [
        { id: 'launchCli', icon: 'play', tooltip: `Launch ${kindLabel}` },
      ],
    },
  });

  // 2. Controls (always shown)
  sections.push(buildControlsSection(adapter, tab));

  // 3. Stale banner
  if (status === 'stale') {
    sections.push({
      id: 'stale-banner',
      template: 'notification',
      data: {
        items: [{ id: 'stale', type: 'warning', title: '会话已结束 — 显示最近一次 session 内容' }],
      },
    });
  }

  // 3b. Proxy capture hint — the proxy only sees a CLI launched through it. Show
  // the relaunch reminder ONLY until traffic actually arrives: once anything is
  // captured after the proxy was enabled, the CLI is going through it, so dismiss.
  const capturedSinceEnable = proxyEnabledAt != null
    && captureStore.getByTimeRange(proxyEnabledAt, Number.MAX_SAFE_INTEGER).length > 0;
  if (store.getState().proxyEnabled && !capturedSinceEnable
      && (status === 'active' || status === 'active-idle')) {
    sections.push({
      id: 'proxy-hint',
      template: 'notification',
      data: {
        items: [{ id: 'proxy-hint', type: 'info', title: '代理已开，尚未抓到流量 — 点 ▶ 重启 CLI 开始抓包' }],
      },
    });
  }

  // 4. Tabs
  const turns = adapter?.getPromptTurns() ?? [];
  const expandedTurns = store.getExpandedTurns(sessionId);

  sections.push({
    id: 'tabs',
    template: 'tabs',
    fill: true,
    data: {
      activeTab: goto ? 'calldetail' : 'history',
      activeTabNonce: goto?.nonce,
      tabs: [
        {
          id: 'history',
          label: '历史',
          sections: buildHistorySections(turns, expandedTurns),
        },
        {
          id: 'calldetail',
          label: '调用详情',
          sections: [{
            id: 'calldetail-view',
            template: 'msg-viewer',
            fill: true,
            data: {
              blocks: turnsToMsgBlocks(turns),
              autoScroll: true,
              emptyTitle: 'No prompts yet',
              scrollToBlockId: goto?.blockId,
              scrollNonce: goto?.nonce,
            },
          }],
        },
      ],
    },
  });

  try { api.ui.setPanelData(PANEL_ID, sections); } catch { /* ignore */ }
}
