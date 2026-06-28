/** Raw JSONL record after JSON.parse. */
export type RawRecord = Record<string, unknown>;

export function parseJsonlLine(line: string): RawRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    return obj && typeof obj === 'object' ? (obj as RawRecord) : null;
  } catch { return null; }
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asTimestamp(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

export type ClaudeToolKind = 'builtin' | 'skill' | 'mcp' | 'task';

export interface ClaudeToolUse {
  id: string;
  name: string;
  input: unknown;
  kind: ClaudeToolKind;
}

function classifyTool(name: string): ClaudeToolKind {
  if (name === 'Skill') return 'skill';
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'Task') return 'task';
  return 'builtin';
}

function extractToolUses(message: unknown): ClaudeToolUse[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const result: ClaudeToolUse[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (b.type !== 'tool_use') continue;
    const name = asString(b.name);
    if (!name) continue;
    result.push({ id: asString(b.id, `anon-${result.length}`), name, input: b.input, kind: classifyTool(name) });
  }
  return result;
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => asString((b as { text?: unknown }).text))
    .join('\n\n');
}

function extractUserText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const m = message as { content?: unknown };
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
      .map((b) => asString((b as { text?: unknown }).text))
      .join('\n\n');
  }
  return '';
}

function isToolResultRecord(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result');
}

function cleanCommandWrappers(text: string): string {
  const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
  const argsMatch = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
  if (nameMatch) {
    const name = nameMatch[1].trim();
    const args = argsMatch ? argsMatch[1].trim() : '';
    return args ? `${name} ${args}` : name;
  }
  return text.replace(/<(local-)?command-(?:name|message|args|stdout|stderr|status)>[\s\S]*?<\/(local-)?command-[^>]+>/g, '').trim();
}

function extractUsage(message: unknown): { inputTokens: number; outputTokens: number; cacheReadTokens: number } {
  const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  if (!message || typeof message !== 'object') return none;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return none;
  const u = usage as Record<string, unknown>;
  const num = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return {
    inputTokens: num('input_tokens') + num('cache_creation_input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
  };
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

function extractPermissionMode(rec: RawRecord): PermissionMode | null {
  const v = rec.permissionMode;
  if (v === 'default' || v === 'acceptEdits' || v === 'plan' || v === 'auto' || v === 'bypassPermissions') return v;
  return null;
}

export type ClaudeEvent =
  | { kind: 'user-prompt'; uuid: string; parentUuid: string | null; ts: number; permissionMode: PermissionMode | null; text: string }
  | { kind: 'assistant-msg'; uuid: string; parentUuid: string | null; ts: number; text: string; toolUses: ClaudeToolUse[]; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
  | { kind: 'attachment'; uuid: string; parentUuid: string | null; ts: number; hookEvent: string; content: string }
  | { kind: 'chain-link'; uuid: string; parentUuid: string | null; ts: number };

export function normalizeRecord(rec: RawRecord): ClaudeEvent | null {
  const uuid = asString(rec.uuid);
  if (!uuid) return null;
  const parentUuid = typeof rec.parentUuid === 'string' ? rec.parentUuid : null;
  const ts = asTimestamp(rec.timestamp);
  const topType = rec.type;
  if (rec.isSidechain === true) return null;

  if (topType === 'user') {
    if (rec.isMeta === true) {
      return { kind: 'attachment', uuid, parentUuid, ts, hookEvent: 'UserMeta', content: extractUserText(rec.message) || '' };
    }
    if (isToolResultRecord(rec.message)) return { kind: 'chain-link', uuid, parentUuid, ts };
    const text = cleanCommandWrappers(extractUserText(rec.message));
    if (!text) return { kind: 'chain-link', uuid, parentUuid, ts };
    return { kind: 'user-prompt', uuid, parentUuid, ts, permissionMode: extractPermissionMode(rec), text };
  }

  if (topType === 'permission-mode') {
    const mode = extractPermissionMode(rec);
    if (!mode) return null;
    return { kind: 'attachment', uuid, parentUuid, ts, hookEvent: 'PermissionMode', content: mode };
  }

  if (topType === 'assistant') {
    const usage = extractUsage(rec.message);
    return {
      kind: 'assistant-msg', uuid, parentUuid, ts,
      text: extractAssistantText(rec.message),
      toolUses: extractToolUses(rec.message),
      inputTokens: usage.inputTokens || undefined,
      outputTokens: usage.outputTokens || undefined,
      cacheReadTokens: usage.cacheReadTokens || undefined,
    };
  }

  if (topType === 'attachment') {
    const att = rec.attachment as { hookEvent?: unknown; content?: unknown; stdout?: unknown } | undefined;
    if (!att) return null;
    let content = '';
    if (typeof att.content === 'string') content = att.content;
    else if (Array.isArray(att.content)) content = att.content.filter((v) => typeof v === 'string').join('\n\n');
    if (!content && typeof att.stdout === 'string') {
      try {
        const parsed = JSON.parse(att.stdout);
        const ac = parsed?.hookSpecificOutput?.additionalContext;
        content = typeof ac === 'string' ? ac : Array.isArray(ac) ? ac.filter((v) => typeof v === 'string').join('\n\n') : att.stdout;
      } catch { content = att.stdout; }
    }
    return { kind: 'attachment', uuid, parentUuid, ts, hookEvent: asString(att.hookEvent), content };
  }

  if (parentUuid) return { kind: 'chain-link', uuid, parentUuid, ts };
  return null;
}

export function normalizeEvents(records: RawRecord[]): ClaudeEvent[] {
  const out: ClaudeEvent[] = [];
  for (const r of records) {
    const n = normalizeRecord(r);
    if (n) out.push(n);
  }
  return out;
}
