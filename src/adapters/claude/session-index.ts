import type { ClaudeEvent, PermissionMode } from './jsonl-parser';
import type { UnifiedPromptTurn, ApiCallEntry, UnifiedTokenUsage, UnifiedSkillInfo, UnifiedSubagentSummary } from '../types';

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
  attachments: Array<Extract<ClaudeEvent, { kind: 'attachment' }>>;
}

/** The event subset skill extraction needs — satisfied by ClaudeTurn and by the SubagentIndex's per-agent state. */
export interface SkillEventSource {
  assistantEvents: Array<Extract<ClaudeEvent, { kind: 'assistant-msg' }>>;
  attachments: Array<Extract<ClaudeEvent, { kind: 'attachment' }>>;
}

/** Map a parsed Claude tool_use to the unified shape (shared with SubagentIndex). */
export function toUnifiedToolCall(tu: Extract<ClaudeEvent, { kind: 'assistant-msg' }>['toolUses'][number]): import('../types').UnifiedToolCall {
  return {
    id: tu.id,
    kind: (tu.kind === 'skill' ? 'skill' : tu.kind === 'mcp' ? 'mcp' : tu.kind === 'task' ? 'task' : 'builtin') as import('../types').UnifiedToolKind,
    name: tu.name,
    input: tu.input,
    output: null,
  };
}

/**
 * Distinct skills invoked in a turn, from two sources (mirrors
 * claude_code_power's computeTurnStats):
 *  - Skill tool_use calls (`input.skill`) → source 'tool'
 *  - Slash-command loads: UserMeta attachments whose content starts with
 *    "Base directory for this skill: /path" followed by the skill markdown —
 *    parsed for name, baseDir, title (first heading) and a description line.
 */
export function extractSkillInfos(rt: SkillEventSource): UnifiedSkillInfo[] {
  const map = new Map<string, UnifiedSkillInfo>();

  for (const ae of rt.assistantEvents) {
    for (const tu of ae.toolUses) {
      if (tu.kind !== 'skill') continue;
      const skill = (tu.input && typeof tu.input === 'object')
        ? (tu.input as { skill?: string }).skill ?? ''
        : '';
      if (skill && !map.has(skill)) map.set(skill, { name: skill, source: 'tool' });
    }
  }

  for (const att of rt.attachments) {
    if (att.hookEvent !== 'UserMeta') continue;
    const m = att.content.match(/Base directory for this skill:\s*(\S+)/);
    if (!m) continue;
    const baseDir = m[1];
    const name = baseDir.split('/').pop() || baseDir;

    const body = att.content.slice(att.content.indexOf(m[0]) + m[0].length).trimStart();
    let title: string | undefined;
    let description: string | undefined;
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (!title && line.startsWith('#')) {
        title = line.replace(/^#+\s*/, '').trim();
        continue;
      }
      if (title && !description) {
        const clean = line.replace(/^\*\*[^*]+\*\*:?\s*/, '').replace(/^\*\s*/, '').trim();
        if (clean.length > 4) {
          description = clean.length > 160 ? clean.slice(0, 157) + '...' : clean;
          break;
        }
      }
    }
    // A Skill tool_use is followed by the skill content loading as a meta
    // record: tool names carry a namespace ('plugin:slug'), meta names are the
    // bare folder slug. Merge the pair into one entry (tool name wins, meta
    // supplies title/description/baseDir) so one invocation isn't counted twice.
    const key = map.has(name)
      ? name
      : [...map.keys()].find((k) => k.endsWith(`:${name}`)) ?? name;
    const prev = map.get(key);
    map.set(key, {
      name: prev?.name ?? name,
      baseDir,
      title: title ?? prev?.title,
      description: description ?? prev?.description,
      source: prev?.source ?? 'slash',
    });
  }

  return [...map.values()];
}

export class ClaudeSessionIndex {
  private events = new Map<string, ClaudeEvent>();
  private order = new Map<string, number>();
  private seq = 0;
  private branchCache: ClaudeEvent[] | null = null;
  private turnsCache: UnifiedPromptTurn[] | null = null;
  private subagentLookup: ((toolUseId: string) => UnifiedSubagentSummary | null) | null = null;

  /** Wire the SubagentIndex query (attribution happens at turn assembly). */
  setSubagentLookup(fn: (toolUseId: string) => UnifiedSubagentSummary | null): void {
    this.subagentLookup = fn;
  }

  /** Drop the turns cache — called when sub-agent data changes. */
  invalidateTurns(): void {
    this.turnsCache = null;
  }

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
        current = { index: rawTurns.length + 1, userUuid: e.uuid, userText: e.text, userTs: e.ts, assistantEvents: [], attachments: [] };
      } else if (current && e.kind === 'assistant-msg') {
        current.assistantEvents.push(e);
      } else if (current && e.kind === 'attachment') {
        current.attachments.push(e);
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
          toolCalls: ae.toolUses.map(toUnifiedToolCall),
          assistantText: ae.text,
          tokenUsage: usage,
        };
      });

      // Attach sub-agents spawned by this turn's Task/Agent calls and fold
      // their tokens/skills into the turn totals (badge = real consumption).
      const subagents: UnifiedSubagentSummary[] = [];
      if (this.subagentLookup) {
        for (const call of apiCalls) {
          for (const tc of call.toolCalls) {
            if (tc.kind !== 'task') continue;
            const sa = this.subagentLookup(tc.id);
            if (sa) subagents.push(sa);
          }
        }
      }

      let totalTokens = apiCalls.reduce((acc, c) => addUsage(acc, c.tokenUsage), zeroUsage());
      for (const sa of subagents) totalTokens = addUsage(totalTokens, sa.tokenUsage);

      const skillMap = new Map<string, UnifiedSkillInfo>();
      for (const s of [...extractSkillInfos(rt), ...subagents.flatMap((sa) => sa.skills)]) {
        if (!skillMap.has(s.name)) skillMap.set(s.name, s);
      }

      return {
        index: rt.index,
        userText: rt.userText,
        ts: rt.userTs,
        apiCalls,
        totalTokens,
        skills: [...skillMap.values()],
        subagents,
        aborted: false,
        _internalId: rt.userUuid,
      };
    });

    this.turnsCache = out;
    return out;
  }
}
