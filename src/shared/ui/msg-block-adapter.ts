import type { UnifiedPromptTurn, UnifiedTokenUsage } from '../../adapters/types';

// ---------------------------------------------------------------------------
// Block types understood by TermCat's msg-viewer template
// ---------------------------------------------------------------------------

interface TokenUsageBlock {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costGems: number;
  cacheReadTokens?: number;
  showTokens: boolean;
  showGems: boolean;
}

interface UserTextBlock {
  type: 'user_text';
  id: string;
  timestamp: number;
  content: string;
}

interface AssistantTextBlock {
  type: 'assistant_text';
  id: string;
  timestamp: number;
  content: string;
  status: 'completed' | 'streaming' | 'error';
  tokenUsage?: TokenUsageBlock;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  timestamp: number;
  toolName: string;
  toolLabel: string;
  toolInput?: Record<string, unknown>;
  status: 'completed' | 'error';
  isError?: boolean;
}

export type MsgBlock = UserTextBlock | AssistantTextBlock | ToolUseBlock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toolInputObject(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return undefined;
}

function toolLabel(kind: string, name: string, input: unknown): string {
  if (kind === 'skill') {
    const skill = (input && typeof input === 'object')
      ? (input as Record<string, unknown>).skill as string | undefined
      : undefined;
    return skill ? `Skill · ${skill}` : 'Skill';
  }
  if (kind === 'mcp') {
    const parts = name.split('__');
    const server = parts[1] ?? 'mcp';
    const toolPart = parts.slice(2).join('__') || name;
    return `MCP · ${server} / ${toolPart}`;
  }
  if (kind === 'task') return 'Agent';
  return name;
}

function tokenUsageBlock(u: UnifiedTokenUsage): TokenUsageBlock | undefined {
  const inp = u.freshInputTokens;
  const out = u.outputTokens;
  const cache = u.cacheReadTokens;
  if (inp === 0 && out === 0) return undefined;
  return {
    inputTokens: inp,
    outputTokens: out,
    totalTokens: inp + out + cache,
    costGems: 0,
    cacheReadTokens: cache > 0 ? cache : undefined,
    showTokens: true,
    showGems: false,
  };
}

// ---------------------------------------------------------------------------
// Main converter: UnifiedPromptTurn[] → MsgBlock[]
// ---------------------------------------------------------------------------

export function turnsToMsgBlocks(turns: UnifiedPromptTurn[]): MsgBlock[] {
  const blocks: MsgBlock[] = [];

  for (const turn of turns) {
    blocks.push({
      type: 'user_text',
      id: `user-${turn.index}-${turn._internalId ?? turn.index}`,
      timestamp: turn.ts,
      content: turn.userText,
    });

    for (const call of turn.apiCalls) {
      for (const tool of call.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: `tool-${turn.index}-${call.callIndex}-${tool.id}`,
          timestamp: turn.ts,
          toolName: tool.name,
          toolLabel: toolLabel(tool.kind, tool.name, tool.input),
          toolInput: toolInputObject(tool.input),
          status: tool.isError ? 'error' : 'completed',
          isError: tool.isError,
        });
      }

      // Emit the assistant block when there is text OR token usage to show, so
      // tool-only rounds still surface their up/down/cache tokens per call.
      const usageBlock = tokenUsageBlock(call.tokenUsage);
      if (call.assistantText || usageBlock) {
        blocks.push({
          type: 'assistant_text',
          id: `asst-${turn.index}-${call.callIndex}`,
          timestamp: turn.ts,
          content: call.assistantText,
          status: 'completed',
          tokenUsage: usageBlock,
        });
      }
    }
  }

  return blocks;
}
