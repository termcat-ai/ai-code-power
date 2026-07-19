import type { CodexEvent } from './jsonl-parser';
import type { UnifiedPromptTurn, ApiCallEntry, UnifiedTokenUsage, UnifiedToolKind } from '../types';

function zeroUsage(): UnifiedTokenUsage {
  return { freshInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

function addUsage(a: UnifiedTokenUsage, b: UnifiedTokenUsage): UnifiedTokenUsage {
  return {
    freshInputTokens: a.freshInputTokens + b.freshInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

// One LLM round-trip within a task (tool loop iteration or final response)
interface PendingCall {
  toolCalls: ApiCallEntry['toolCalls'];
  assistantText: string;
}

interface RawTurn {
  index: number;
  turnId: string;
  prompt: string;
  ts: number;
  apiCalls: ApiCallEntry[];
  pending: PendingCall;
  pendingUsage: UnifiedTokenUsage;
}

function newPending(): PendingCall {
  return { toolCalls: [], assistantText: '' };
}

export class CodexSessionIndex {
  private events: CodexEvent[] = [];
  private turnsCache: UnifiedPromptTurn[] | null = null;
  private lastModel: string | null = null;
  private approvalMode: string | null = null;
  private systemPrompt: string | null = null;

  addEvents(events: CodexEvent[]): void {
    if (!events.length) return;
    this.events.push(...events);
    this.turnsCache = null;
    for (const e of events) {
      if (e.kind === 'meta') {
        if (e.model) this.lastModel = e.model;
        if (e.approvalMode) this.approvalMode = e.approvalMode;
        if (e.systemPrompt) this.systemPrompt = e.systemPrompt;
      }
    }
  }

  getLastModel(): string | null { return this.lastModel; }
  getSystemPrompt(): string | null { return this.systemPrompt; }
  getApprovalMode(): string | null { return this.approvalMode; }
  setApprovalMode(mode: string): void { this.approvalMode = mode; }

  getPromptTurns(): UnifiedPromptTurn[] {
    if (this.turnsCache) return this.turnsCache;
    const turns: RawTurn[] = [];
    let current: RawTurn | null = null;

    const hasUsage = (u: UnifiedTokenUsage) =>
      u.freshInputTokens > 0 || u.cacheReadTokens > 0 || u.outputTokens > 0 || u.reasoningTokens > 0;

    const flushPending = () => {
      if (!current) return;
      // Flush a round-trip if it produced any content OR carried token usage
      // (a reasoning-only round still has real tokens we must not drop).
      if (!current.pending.toolCalls.length && !current.pending.assistantText && !hasUsage(current.pendingUsage)) return;
      current.apiCalls.push({
        callIndex: current.apiCalls.length + 1,
        toolCalls: current.pending.toolCalls,
        assistantText: current.pending.assistantText,
        tokenUsage: current.pendingUsage,
      });
      current.pending = newPending();
      current.pendingUsage = zeroUsage();
    };

    // callId → tool-call object reference for the current turn. Holds the SAME
    // object that gets flushed into apiCalls, so a tool_result arriving after a
    // token_count flush still mutates the right call (Codex commonly emits
    // token_count between function_call and function_call_output).
    const toolCallById = new Map<string, ApiCallEntry['toolCalls'][number]>();

    for (const e of this.events) {
      switch (e.kind) {
        case 'task_started': {
          // Start a new user turn
          if (current) flushPending();
          current = {
            index: turns.length + 1,
            turnId: e.turnId,
            prompt: '',
            ts: e.ts,
            apiCalls: [],
            pending: newPending(),
            pendingUsage: zeroUsage(),
          };
          turns.push(current);
          toolCallById.clear();
          break;
        }

        case 'user_msg': {
          if (!current) {
            // Orphaned user_msg — start a synthetic turn
            current = {
              index: turns.length + 1,
              turnId: e.turnId,
              prompt: e.text,
              ts: e.ts,
              apiCalls: [],
              pending: newPending(),
              pendingUsage: zeroUsage(),
            };
            turns.push(current);
          } else {
            current.prompt = e.text;
            if (!current.ts) current.ts = e.ts;
          }
          break;
        }

        case 'tool_call': {
          if (!current) break;
          const tc = {
            id: e.callId,
            kind: e.kind_ as UnifiedToolKind,
            name: e.name,
            input: e.input,
            output: null as string | null,
            isError: undefined as boolean | undefined,
          };
          current.pending.toolCalls.push(tc);
          toolCallById.set(e.callId, tc);
          break;
        }

        case 'tool_result': {
          // Look up by callId regardless of which round the call landed in —
          // the result may arrive after the call was flushed into apiCalls.
          const tc = toolCallById.get(e.callId);
          if (tc) {
            tc.output = e.output;
            if (e.isError) tc.isError = true;
          }
          break;
        }

        case 'assistant_msg': {
          if (!current) break;
          current.pending.assistantText = e.text;
          break;
        }

        case 'token_count': {
          if (!current) break;
          current.pendingUsage = {
            freshInputTokens: e.inputTokens - e.cachedInputTokens,
            cacheReadTokens: e.cachedInputTokens,
            outputTokens: e.outputTokens,
            reasoningTokens: e.reasoningTokens,
          };
          // Token count marks end of one LLM round-trip → flush this API call
          flushPending();
          break;
        }

        case 'task_complete': {
          if (!current) break;
          flushPending();
          if (e.aborted) {
            // mark last turn as aborted (handled at output)
          }
          break;
        }
      }
    }

    // Flush any incomplete last turn
    if (current) flushPending();

    const out: UnifiedPromptTurn[] = turns
      .filter((rt) => rt.prompt) // skip turns without user text
      .map((rt) => {
        const totalTokens = rt.apiCalls.reduce((acc, c) => addUsage(acc, c.tokenUsage), zeroUsage());
        return {
          index: rt.index,
          userText: rt.prompt,
          ts: rt.ts,
          apiCalls: rt.apiCalls,
          totalTokens,
          skills: [], // Codex has no skill concept
          subagents: [], // Codex has no sub-agent concept
          aborted: false,
          _internalId: `codex-${rt.turnId}`,
        };
      });

    // Re-index after filtering
    out.forEach((t, i) => { t.index = i + 1; });

    this.turnsCache = out;
    return out;
  }
}
