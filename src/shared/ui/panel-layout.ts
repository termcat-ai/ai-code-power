import type { MsgBlock } from './msg-block-types';

/**
 * Serializes the blocks array for IPC transport.
 * Strips undefined values so JSON.stringify produces clean output.
 */
export function serializeBlocks(blocks: MsgBlock[]): string {
  return JSON.stringify(blocks);
}

/**
 * Panel event names sent from the renderer to the plugin.
 */
export type PanelEventName =
  | 'toggle-turn'           // expand/collapse a turn
  | 'goto-prompt'           // scroll to a specific prompt block
  | 'toggle-proxy'          // enable/disable proxy
  | 'launch-claude'         // start claude in current tab
  | 'launch-codex'          // start codex in current tab
  | 'set-mode'              // change permission/approval mode
  | 'view-capture'          // open raw request/response viewer for a call
  | 'copy-system-prompt';   // copy system prompt to clipboard

export interface PanelEvent {
  name: PanelEventName;
  payload?: unknown;
}

export interface ToggleTurnPayload { turnIndex: number; }
export interface GotoPromptPayload { turnIndex: number; }
export interface SetModePayload { mode: string; }
export interface ViewCapturePayload { messageId: string; }
