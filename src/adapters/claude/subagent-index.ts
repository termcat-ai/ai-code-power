/**
 * Sub-agent transcript aggregation.
 *
 * Each Task/Agent tool call spawns a sub-agent whose full transcript lands in
 * `<session-uuid>/subagents/agent-<agentId>.jsonl` (all records sidechain),
 * with a sibling `.meta.json` whose `toolUseId` matches the main-chain
 * tool_use id — that's the attribution key.
 *
 * This index only aggregates and answers `byToolUseId`; attribution to a turn
 * happens in ClaudeSessionIndex at assembly time, so ordering races between
 * the two file streams resolve themselves on the next rebuild.
 */

import { normalizeRecord, type RawRecord, type ClaudeEvent } from './jsonl-parser';
import { extractSkillInfos, toUnifiedToolCall } from './session-index';
import type { UnifiedSubagentSummary, UnifiedTokenUsage } from '../types';

export interface SubagentMeta {
  toolUseId?: string;
  agentType?: string;
  description?: string;
}

interface AgentState {
  meta: SubagentMeta | null;
  seenUuids: Set<string>;
  assistantEvents: Array<Extract<ClaudeEvent, { kind: 'assistant-msg' }>>;
  attachments: Array<Extract<ClaudeEvent, { kind: 'attachment' }>>;
  summary: UnifiedSubagentSummary | null; // lazy cache
}

export class SubagentIndex {
  private agents = new Map<string, AgentState>();

  private getOrInit(agentId: string): AgentState {
    let s = this.agents.get(agentId);
    if (!s) {
      s = { meta: null, seenUuids: new Set(), assistantEvents: [], attachments: [], summary: null };
      this.agents.set(agentId, s);
    }
    return s;
  }

  /** Returns true if anything changed (caller should invalidate turn caches). */
  addRecords(agentId: string, records: RawRecord[], meta: SubagentMeta | null): boolean {
    const state = this.getOrInit(agentId);
    let changed = false;
    if (meta && !state.meta) { state.meta = meta; changed = true; }
    for (const rec of records) {
      const e = normalizeRecord(rec, { allowSidechain: true });
      if (!e || state.seenUuids.has(e.uuid)) continue;
      state.seenUuids.add(e.uuid);
      if (e.kind === 'assistant-msg') { state.assistantEvents.push(e); changed = true; }
      else if (e.kind === 'attachment') { state.attachments.push(e); changed = true; }
    }
    if (changed) state.summary = null;
    return changed;
  }

  /** Summary for the sub-agent spawned by the given main-chain tool_use id. */
  byToolUseId(toolUseId: string): UnifiedSubagentSummary | null {
    for (const [agentId, state] of this.agents) {
      if (state.meta?.toolUseId !== toolUseId) continue;
      if (!state.summary) state.summary = buildSummary(agentId, state);
      return state.summary;
    }
    return null;
  }
}

function buildSummary(agentId: string, state: AgentState): UnifiedSubagentSummary {
  const tokenUsage: UnifiedTokenUsage = { freshInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  for (const ae of state.assistantEvents) {
    tokenUsage.freshInputTokens += ae.inputTokens ?? 0;
    tokenUsage.cacheReadTokens += ae.cacheReadTokens ?? 0;
    tokenUsage.outputTokens += ae.outputTokens ?? 0;
  }
  return {
    agentId,
    toolUseId: state.meta?.toolUseId ?? '',
    agentType: state.meta?.agentType,
    description: state.meta?.description,
    toolCalls: state.assistantEvents.flatMap((ae) => ae.toolUses.map(toUnifiedToolCall)),
    tokenUsage,
    skills: extractSkillInfos(state),
  };
}
