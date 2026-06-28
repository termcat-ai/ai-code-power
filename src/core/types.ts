import type { IAdapter } from '../adapters/types';

export type TabStatus = 'idle' | 'active' | 'active-idle' | 'stale';

export interface PerTabState {
  sessionId: string;
  shellPid: number | null;
  /** Kind of AI CLI detected (null = none). */
  kind: 'claude' | 'codex' | null;
  /** PID of the detected AI process. */
  aiPid: number | null;
  detectedCwd: string | null;
  /** JSONL or equivalent file being watched. */
  sessionFile: string | null;
  status: TabStatus;
  lastCheckedAt: number;
  /** Active adapter instance for this tab. */
  adapter: IAdapter | null;
}

export interface PendingCapture {
  messageId: string;
  requestBody: string;
  responseBody: string;
}

export interface AppState {
  activeTabSessionId: string | null;
  proxyEnabled: boolean;
  perTabStates: Map<string, PerTabState>;
  /** terminal sessionId → set of turn indices expanded in the history list. */
  expandedTurnsByTab: Map<string, Set<number>>;
  /** terminal sessionId → pending scroll/goto request. */
  gotoByTab: Map<string, { nonce: number; blockId: string }>;
  gotoCounter: number;
  /** sessionId → capture to display in overlay (consumed by renderer). */
  pendingCaptures: Map<string, PendingCapture>;
  /** sessionId → text to copy to clipboard. */
  pendingClipboard: Map<string, string>;
}

export function initialAppState(): AppState {
  return {
    activeTabSessionId: null,
    proxyEnabled: false,
    perTabStates: new Map(),
    expandedTurnsByTab: new Map(),
    gotoByTab: new Map(),
    gotoCounter: 0,
    pendingCaptures: new Map(),
    pendingClipboard: new Map(),
  };
}
