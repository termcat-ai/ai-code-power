/**
 * Codex JSONL parser.
 *
 * Actual record shape:
 *   { timestamp: "ISO", type: "event_msg"|"response_item"|"session_meta"|"turn_context", payload: {...} }
 *
 * Relevant events:
 *   event_msg / task_started      → new user turn
 *   event_msg / user_message      → user text
 *   event_msg / agent_message     → assistant text (final summary per turn, used as fallback)
 *   event_msg / token_count       → token usage after each LLM call
 *   event_msg / task_complete     → turn done
 *   event_msg / turn_aborted      → turn aborted
 *   response_item / function_call → tool call (OpenAI function calling)
 *   response_item / function_call_output → tool result
 *   response_item / custom_tool_call     → tool call (Codex built-in tools like apply_patch)
 *   response_item / custom_tool_call_output → tool result
 *   response_item / message       → assistant text block (role=assistant)
 */

export type CodexRawRecord = Record<string, unknown>;

export function parseJsonlLine(line: string): CodexRawRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === 'object' ? (obj as CodexRawRecord) : null;
  } catch { return null; }
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : fallback;
}

function asTimestamp(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// Tool outputs are normally strings, but newer Codex may wrap them as
// { output: "...", metadata: {...} }. Extract a readable string either way.
function asOutputString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.output === 'string') return o.output;
    try { return JSON.stringify(v); } catch { return ''; }
  }
  return '';
}

// Tool kind classification
export type CodexToolKind = 'shell' | 'patch' | 'search' | 'builtin';

function classifyCodexTool(name: string): CodexToolKind {
  if (/^(shell|bash|exec|run_command|exec_command)$/.test(name)) return 'shell';
  if (/^(apply_patch|write_file|edit_file|create_file)$/.test(name)) return 'patch';
  if (/^(search|read_file|list_dir|glob|grep)$/.test(name)) return 'search';
  return 'builtin';
}

// ---------------------------------------------------------------------------
// Normalized event types
// ---------------------------------------------------------------------------

export type CodexEvent =
  | { kind: 'task_started'; ts: number; turnId: string }
  | { kind: 'user_msg'; ts: number; turnId: string; text: string }
  | { kind: 'tool_call'; ts: number; callId: string; name: string; kind_: CodexToolKind; input: unknown }
  | { kind: 'tool_result'; ts: number; callId: string; output: string; isError: boolean }
  | { kind: 'assistant_msg'; ts: number; text: string }
  | { kind: 'token_count'; ts: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number }
  | { kind: 'meta'; ts: number; model?: string; approvalMode?: string; systemPrompt?: string }
  | { kind: 'task_complete'; ts: number; aborted?: boolean };

// ---------------------------------------------------------------------------
// Extractor helpers
// ---------------------------------------------------------------------------

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object')
    .map((b) => {
      const block = b as Record<string, unknown>;
      const type = block.type as string | undefined;
      if (type === 'input_text' || type === 'output_text' || type === 'text') {
        return asString(block.text);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

export function normalizeRecord(rec: CodexRawRecord): CodexEvent | null {
  const type = asString(rec.type);
  const ts = asTimestamp(rec.timestamp ?? rec.ts ?? 0);
  const payload = (rec.payload && typeof rec.payload === 'object' && !Array.isArray(rec.payload))
    ? rec.payload as Record<string, unknown>
    : null;
  const payloadType = payload ? asString(payload.type) : '';

  // ── session_meta records (carry the base system prompt) ───────────────────
  if (type === 'session_meta' && payload) {
    const bi = payload.base_instructions;
    const systemPrompt = (bi && typeof bi === 'object' && typeof (bi as Record<string, unknown>).text === 'string')
      ? (bi as Record<string, unknown>).text as string
      : (typeof bi === 'string' ? bi : undefined);
    return systemPrompt ? { kind: 'meta', ts, systemPrompt } : null;
  }

  // ── turn_context records (carry model + approval mode per turn) ───────────
  if (type === 'turn_context' && payload) {
    const model = asString(payload.model) || undefined;
    const approvalMode = asString(payload.approval_policy) || undefined;
    return (model || approvalMode) ? { kind: 'meta', ts, model, approvalMode } : null;
  }

  // ── event_msg records ────────────────────────────────────────────────────
  if (type === 'event_msg' && payload) {
    if (payloadType === 'task_started') {
      const turnId = asString(payload.turn_id ?? rec.turn_id, `auto-${ts}`);
      return { kind: 'task_started', ts, turnId };
    }

    if (payloadType === 'user_message' || payloadType === 'user_turn_started') {
      const turnId = asString(payload.turn_id ?? rec.turn_id, `auto-${ts}`);
      const text = asString(payload.message ?? payload.input ?? payload.text);
      return { kind: 'user_msg', ts, turnId, text };
    }

    if (payloadType === 'agent_message') {
      const text = extractTextFromContent(payload.message) || asString(payload.text);
      if (!text) return null;
      return { kind: 'assistant_msg', ts, text };
    }

    if (payloadType === 'token_count') {
      const info = (payload.info && typeof payload.info === 'object')
        ? payload.info as Record<string, unknown>
        : null;
      const usage = info
        ? ((info.last_token_usage ?? info.total_token_usage) as Record<string, number> | undefined)
        : null;
      return {
        kind: 'token_count',
        ts,
        inputTokens: asNumber(usage?.input_tokens),
        cachedInputTokens: asNumber(usage?.cached_input_tokens ?? usage?.cache_read_input_tokens),
        outputTokens: asNumber(usage?.output_tokens),
        reasoningTokens: asNumber(usage?.reasoning_output_tokens ?? usage?.reasoning_tokens),
      };
    }

    if (payloadType === 'task_complete') {
      return { kind: 'task_complete', ts };
    }

    if (payloadType === 'turn_aborted') {
      return { kind: 'task_complete', ts, aborted: true };
    }

    return null;
  }

  // ── response_item records ────────────────────────────────────────────────
  if (type === 'response_item' && payload) {
    // Tool calls: function_call style (OpenAI format)
    if (payloadType === 'function_call') {
      const name = asString(payload.name);
      if (!name) return null;
      const callId = asString(payload.call_id ?? payload.id, `call-${ts}`);
      const rawArgs = payload.arguments;
      const input = typeof rawArgs === 'string' ? tryParseJson(rawArgs) : rawArgs;
      return { kind: 'tool_call', ts, callId, name, kind_: classifyCodexTool(name), input };
    }

    // Tool results: function_call_output style
    if (payloadType === 'function_call_output') {
      const callId = asString(payload.call_id ?? payload.id, `result-${ts}`);
      return {
        kind: 'tool_result',
        ts,
        callId,
        output: asOutputString(payload.output),
        isError: payload.error === true || asString(payload.status) === 'error',
      };
    }

    // Web search: server-side tool, no separate output event (result is not
    // logged). Surface the query/queries so the search shows up as a tool call.
    if (payloadType === 'web_search_call') {
      const callId = asString(payload.call_id ?? payload.id, `ws-${ts}`);
      const action = (payload.action && typeof payload.action === 'object')
        ? payload.action as Record<string, unknown>
        : {};
      const query = asString(action.query);
      const queries = Array.isArray(action.queries) ? action.queries as unknown[] : [];
      const input = { query: query || (typeof queries[0] === 'string' ? queries[0] : ''), queries };
      return { kind: 'tool_call', ts, callId, name: 'web_search', kind_: 'search', input };
    }

    // Tool calls: custom_tool_call style (Codex built-ins like apply_patch)
    if (payloadType === 'custom_tool_call') {
      const name = asString(payload.name);
      if (!name) return null;
      const callId = asString(payload.call_id ?? payload.id, `call-${ts}`);
      const rawInput = payload.input;
      const input = typeof rawInput === 'string' ? tryParseJson(rawInput) : rawInput;
      const isError = asString(payload.status) === 'error';
      // custom_tool_call may already include output (status=completed with embedded result)
      return { kind: 'tool_call', ts, callId, name, kind_: classifyCodexTool(name), input };
      void isError;
    }

    // Tool results: custom_tool_call_output style
    if (payloadType === 'custom_tool_call_output') {
      const callId = asString(payload.call_id ?? payload.id, `result-${ts}`);
      return {
        kind: 'tool_result',
        ts,
        callId,
        output: asOutputString(payload.output),
        isError: asString(payload.status) === 'error',
      };
    }

    // Assistant message
    if (payloadType === 'message') {
      const role = asString(payload.role);
      if (role === 'assistant') {
        const text = extractTextFromContent(payload.content);
        return text ? { kind: 'assistant_msg', ts, text } : null;
      }
      return null;
    }

    return null;
  }

  // ── Legacy flat records (older Codex versions / future format changes) ──
  const role = asString(rec.role ?? rec.type ?? rec.event);
  if (role === 'user') {
    const text = extractTextFromContent(rec.content) || asString(rec.input ?? rec.message);
    const turnId = asString(rec.turn_id ?? rec.id, `auto-${ts}`);
    return text ? { kind: 'user_msg', ts, turnId, text } : null;
  }
  if (role === 'assistant') {
    const text = extractTextFromContent(rec.content) || asString(rec.message);
    return text ? { kind: 'assistant_msg', ts, text } : null;
  }

  return null;
}

export function normalizeRecords(records: CodexRawRecord[]): CodexEvent[] {
  const out: CodexEvent[] = [];
  for (const r of records) {
    const n = normalizeRecord(r);
    if (n) out.push(n);
  }
  return out;
}
