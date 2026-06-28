import { EventBus } from './event-bus';
import { initialAppState, type AppState, type PerTabState, type PendingCapture } from './types';

export class Store {
  readonly bus = new EventBus();
  private state: AppState = initialAppState();

  getState(): AppState {
    return this.state;
  }

  setProxyEnabled(enabled: boolean): void {
    if (this.state.proxyEnabled === enabled) return;
    this.state.proxyEnabled = enabled;
    this.bus.emit('state:proxy-change', enabled);
  }

  setActiveTab(sessionId: string | null): void {
    if (this.state.activeTabSessionId === sessionId) return;
    this.state.activeTabSessionId = sessionId;
    this.bus.emit('state:active-change', sessionId);
  }

  upsertTab(state: PerTabState): void {
    this.state.perTabStates.set(state.sessionId, state);
    this.bus.emit('state:tab-change', state.sessionId);
  }

  getTab(sessionId: string): PerTabState | undefined {
    return this.state.perTabStates.get(sessionId);
  }

  removeTab(sessionId: string): void {
    if (!this.state.perTabStates.has(sessionId)) return;
    // Dispose adapter to release resources.
    const tab = this.state.perTabStates.get(sessionId);
    if (tab?.adapter) tab.adapter.stopWatching();
    this.state.perTabStates.delete(sessionId);
    this.state.expandedTurnsByTab.delete(sessionId);
    this.state.gotoByTab.delete(sessionId);
    this.state.pendingCaptures.delete(sessionId);
    this.state.pendingClipboard.delete(sessionId);
    this.bus.emit('state:tab-change', sessionId);
  }

  toggleTurnExpansion(sessionId: string, turnIndex: number): void {
    return this.toggleExpandedTurn(sessionId, turnIndex);
  }

  setGoto(sessionId: string, blockId: string): void {
    return this.requestGoto(sessionId, blockId);
  }

  setPendingCapture(sessionId: string, capture: PendingCapture): void {
    this.state.pendingCaptures.set(sessionId, capture);
    this.bus.emit('state:capture-ready', sessionId);
  }

  consumePendingCapture(sessionId: string): PendingCapture | null {
    const c = this.state.pendingCaptures.get(sessionId) ?? null;
    this.state.pendingCaptures.delete(sessionId);
    return c;
  }

  setPendingClipboard(sessionId: string, text: string): void {
    this.state.pendingClipboard.set(sessionId, text);
    this.bus.emit('state:clipboard-ready', sessionId);
  }

  consumePendingClipboard(sessionId: string): string | null {
    const t = this.state.pendingClipboard.get(sessionId) ?? null;
    this.state.pendingClipboard.delete(sessionId);
    return t;
  }

  toggleExpandedTurn(sessionId: string, turnIndex: number): void {
    let set = this.state.expandedTurnsByTab.get(sessionId);
    if (!set) {
      set = new Set();
      this.state.expandedTurnsByTab.set(sessionId, set);
    }
    if (set.has(turnIndex)) set.delete(turnIndex);
    else set.add(turnIndex);
    this.bus.emit('state:expanded-turns-change', sessionId);
  }

  getExpandedTurns(sessionId: string): Set<number> {
    return this.state.expandedTurnsByTab.get(sessionId) ?? new Set();
  }

  requestGoto(sessionId: string, blockId: string): void {
    this.state.gotoCounter += 1;
    this.state.gotoByTab.set(sessionId, { nonce: this.state.gotoCounter, blockId });
    this.bus.emit('state:goto-change', sessionId);
  }

  getGoto(sessionId: string): { nonce: number; blockId: string } | null {
    return this.state.gotoByTab.get(sessionId) ?? null;
  }
}
