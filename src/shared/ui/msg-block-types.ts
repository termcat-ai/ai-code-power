import type { UnifiedTokenUsage, UnifiedToolCall } from '../../adapters/types';

export type MsgBlockId = string;

/** A renderable panel block for the unified call viewer. */
export type MsgBlock =
  | HeaderBlock
  | TurnSeparatorBlock
  | PromptBlock
  | ApiCallHeaderBlock
  | ToolCallBlock
  | AssistantTextBlock
  | TokenStatsBlock
  | SessionInfoBlock
  | EmptyStateBlock;

export interface HeaderBlock {
  type: 'header';
  id: MsgBlockId;
  kind: 'claude' | 'codex';
  model: string | null;
  cwd: string | null;
  mode: string | null;
  sessionId: string;
  proxyEnabled: boolean;
}

export interface TurnSeparatorBlock {
  type: 'turn-separator';
  id: MsgBlockId;
  turnIndex: number;
  totalTurns: number;
}

export interface PromptBlock {
  type: 'prompt';
  id: MsgBlockId;
  turnIndex: number;
  text: string;
  ts: number;
  totalTokens: UnifiedTokenUsage;
  expanded: boolean;
}

export interface ApiCallHeaderBlock {
  type: 'api-call-header';
  id: MsgBlockId;
  turnIndex: number;
  callIndex: number;
  tokenUsage: UnifiedTokenUsage;
}

export interface ToolCallBlock {
  type: 'tool-call';
  id: MsgBlockId;
  turnIndex: number;
  callIndex: number;
  tool: UnifiedToolCall;
}

export interface AssistantTextBlock {
  type: 'assistant-text';
  id: MsgBlockId;
  turnIndex: number;
  callIndex: number;
  text: string;
}

export interface TokenStatsBlock {
  type: 'token-stats';
  id: MsgBlockId;
  turnIndex: number;
  callIndex: number;
  usage: UnifiedTokenUsage;
}

export interface SessionInfoBlock {
  type: 'session-info';
  id: MsgBlockId;
  kind: 'claude' | 'codex';
  sessionFile: string | null;
  proxyEnabled: boolean;
  captureCount: number;
}

export interface EmptyStateBlock {
  type: 'empty-state';
  id: MsgBlockId;
  kind: 'claude' | 'codex' | null;
  status: string;
}
