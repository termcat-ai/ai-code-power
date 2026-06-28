import type { ClaudeEvent, PermissionMode } from './jsonl-parser';
import type { UnifiedPromptTurn, ApiCallEntry, UnifiedTokenUsage } from '../types';

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

interface ClaudeTurn {
  index: number;
  userUuid: string;
  userText: string;
  userTs: number;
  assistantEvents: Array<Extract<ClaudeEvent, { kind: 'assistant-msg' }>>;
}

export class ClaudeSessionIndex {
  private events = new Map<string, ClaudeEvent>();
  private order = new Map<string, number>();
  private seq = 0;
  private branchCache: ClaudeEvent[] | null = null;
  private turnsCache: UnifiedPromptTurn[] | null = null;

  addEvents(events: ClaudeEvent[]): void {
    let added = false;
    for (const e of events) {
      if (this.events.has(e.uuid)) continue;
      this.events.set(e.uuid, e);
      this.order.set(e.uuid, this.seq++);
      added = true;
    }
    if (added) { this.branchCache = null; this.turnsCache = null; }
  }

  getMainBranch(): ClaudeEvent[] {
    if (this.branchCache) return this.branchCache;
    if (this.events.size === 0) { this.branchCache = []; return this.branchCache; }

    const referenced = new Set<string>();
    for (const e of this.events.values()) { if (e.parentUuid) referenced.add(e.parentUuid); }

    let leafUuid: string | null = null;
    let leafKey = -Infinity;
    for (const e of this.events.values()) {
      if (referenced.has(e.uuid)) continue;
      const ord = this.order.get(e.uuid) ?? 0;
      const key = e.ts * 1e6 + ord;
      if (key > leafKey) { leafKey = key; leafUuid = e.uuid; }
    }

    const branch: ClaudeEvent[] = [];
    const visited = new Set<string>();
    let cursor: string | null | undefined = leafUuid;
    while (cursor) {
      if (visited.has(cursor)) break;
      visited.add(cursor);
      const e = this.events.get(cursor);
      if (!e) break;
      branch.push(e);
      cursor = e.parentUuid;
    }
    branch.reverse();
    this.branchCache = branch;
    return branch;
  }

  getLatestPermissionMode(): PermissionMode | null {
    const branch = this.getMainBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.kind === 'attachment' && e.hookEvent === 'PermissionMode') return e.content as PermissionMode;
      if (e.kind === 'user-prompt' && e.permissionMode) return e.permissionMode;
    }
    return null;
  }

  getPromptTurns(): UnifiedPromptTurn[] {
    if (this.turnsCache) return this.turnsCache;
    const branch = this.getMainBranch();
    const rawTurns: ClaudeTurn[] = [];
    let current: ClaudeTurn | null = null;

    for (const e of branch) {
      if (e.kind === 'chain-link') continue;
      if (e.kind === 'user-prompt') {
        if (current) rawTurns.push(current);
        current = { index: rawTurns.length + 1, userUuid: e.uuid, userText: e.text, userTs: e.ts, assistantEvents: [] };
      } else if (current && e.kind === 'assistant-msg') {
        current.assistantEvents.push(e);
      }
    }
    if (current) rawTurns.push(current);

    const out: UnifiedPromptTurn[] = rawTurns.map((rt) => {
      const apiCalls: ApiCallEntry[] = rt.assistantEvents.map((ae, i) => {
        const usage: UnifiedTokenUsage = {
          freshInputTokens: ae.inputTokens ?? 0,
          cacheReadTokens: ae.cacheReadTokens ?? 0,
          outputTokens: ae.outputTokens ?? 0,
          reasoningTokens: 0,
        };
        return {
          callIndex: i + 1,
          toolCalls: ae.toolUses.map((tu) => ({
            id: tu.id,
            kind: (tu.kind === 'skill' ? 'skill' : tu.kind === 'mcp' ? 'mcp' : tu.kind === 'task' ? 'task' : 'builtin') as import('../types').UnifiedToolKind,
            name: tu.name,
            input: tu.input,
            output: null,
          })),
          assistantText: ae.text,
          tokenUsage: usage,
        };
      });
      const totalTokens = apiCalls.reduce((acc, c) => addUsage(acc, c.tokenUsage), zeroUsage());
      return {
        index: rt.index,
        userText: rt.userText,
        ts: rt.userTs,
        apiCalls,
        totalTokens,
        aborted: false,
        _internalId: rt.userUuid,
      };
    });

    this.turnsCache = out;
    return out;
  }
}
