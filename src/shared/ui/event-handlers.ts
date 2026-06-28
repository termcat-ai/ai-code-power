import type { PanelEvent, ToggleTurnPayload, SetModePayload, ViewCapturePayload } from './panel-layout';
import type { Store } from '../../core/state';
import type { PtyInjector } from '../actions/pty-inject';
import type { ProxyServer } from '../proxy/proxy-server';
import type { CaptureStore } from '../proxy/capture-store';
import type { IAdapter } from '../../adapters/types';

export interface EventHandlerDeps {
  store: Store;
  injector: PtyInjector;
  proxyServer: ProxyServer;
  captureStore: CaptureStore;
  notifyPanel: (sessionId: string) => void;
}

export async function handlePanelEvent(
  event: PanelEvent,
  sessionId: string,
  deps: EventHandlerDeps,
): Promise<void> {
  const { store, injector, proxyServer, captureStore, notifyPanel } = deps;
  const tabState = store.getTab(sessionId);

  switch (event.name) {
    case 'toggle-turn': {
      const p = event.payload as ToggleTurnPayload;
      store.toggleTurnExpansion(sessionId, p.turnIndex);
      notifyPanel(sessionId);
      break;
    }

    case 'goto-prompt': {
      const p = event.payload as { turnIndex: number };
      store.setGoto(sessionId, `prompt-${p.turnIndex}`);
      notifyPanel(sessionId);
      break;
    }

    case 'toggle-proxy': {
      const adapter: IAdapter | null = tabState?.adapter ?? null;
      if (!adapter) break;
      const currentlyEnabled = store.getState().proxyEnabled;
      if (currentlyEnabled) {
        await adapter.restoreEnv();
        store.setProxyEnabled(false);
      } else {
        const port = proxyServer.getPort();
        if (!port) {
          const p = await proxyServer.start();
          await adapter.writeProxyEnv(`http://127.0.0.1:${p}`);
        } else {
          await adapter.writeProxyEnv(`http://127.0.0.1:${port}`);
        }
        store.setProxyEnabled(true);
      }
      notifyPanel(sessionId);
      break;
    }

    case 'launch-claude': {
      if (!tabState?.adapter || tabState.adapter.kind !== 'claude') break;
      await tabState.adapter.launch(injector, sessionId);
      break;
    }

    case 'launch-codex': {
      if (!tabState?.adapter || tabState.adapter.kind !== 'codex') break;
      await tabState.adapter.launch(injector, sessionId);
      break;
    }

    case 'set-mode': {
      const p = event.payload as SetModePayload;
      if (!tabState?.adapter) break;
      await tabState.adapter.setMode(p.mode, injector, sessionId);
      notifyPanel(sessionId);
      break;
    }

    case 'view-capture': {
      const p = event.payload as ViewCapturePayload;
      const entry = captureStore.getByMessageId(p.messageId);
      if (!entry) break;
      const adapter: IAdapter | null = tabState?.adapter ?? null;
      const strategy = adapter?.getSseStrategy();
      const rawSse = entry.rawResponseSse ?? '';
      const merged = strategy?.mergeSse(rawSse) ?? rawSse;
      // Post back to renderer for display
      store.setPendingCapture(sessionId, {
        messageId: p.messageId,
        requestBody: tryPrettyJson(JSON.stringify(entry.request)),
        responseBody: merged,
      });
      notifyPanel(sessionId);
      break;
    }

    case 'copy-system-prompt': {
      if (!tabState?.adapter) break;
      const sp = tabState.adapter.getSystemPrompt();
      if (sp) store.setPendingClipboard(sessionId, sp);
      notifyPanel(sessionId);
      break;
    }
  }
}

function tryPrettyJson(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}
