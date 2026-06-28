import type { SseStrategy, UnifiedTokenUsage } from '../types';

/** OpenAI Responses API SSE format (used by Codex CLI v0.141.0+). */
export class CodexSseStrategy implements SseStrategy {
  // Codex uses the Responses API. We point openai_base_url at the proxy root,
  // so the incoming path is `/responses` (also matches `/v1/responses`).
  readonly captureEndpointPath = '/responses';

  parseMessageId(buf: string): string | null {
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (d.type === 'response.created') {
          const resp = d.response as Record<string, unknown> | undefined;
          if (typeof resp?.id === 'string') return resp.id;
        }
      } catch { /* skip */ }
    }
    return null;
  }

  parseUsage(buf: string): UnifiedTokenUsage | null {
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (d.type === 'response.completed') {
          const resp = d.response as Record<string, unknown> | undefined;
          const u = resp?.usage as Record<string, unknown> | undefined;
          if (!u) continue;
          const inputTokens = (u.input_tokens as number) ?? 0;
          const outputTokens = (u.output_tokens as number) ?? 0;
          const cachedTokens = ((u.input_token_details as Record<string, number> | undefined)?.cached_tokens) ?? 0;
          const reasoningTokens = ((u.output_token_details as Record<string, number> | undefined)?.reasoning_tokens) ?? 0;
          return {
            freshInputTokens: inputTokens - cachedTokens,
            cacheReadTokens: cachedTokens,
            outputTokens,
            reasoningTokens,
          };
        }
      } catch { /* skip */ }
    }
    return null;
  }

  mergeSse(buf: string): string {
    type ToolCall = { outputIndex: number; name: string; args: string };
    let text = '';
    let reasoningText = '';
    const toolCallMap = new Map<string, ToolCall>(); // keyed by item_id
    let model = '';
    let inputTokens = 0, outputTokens = 0, cachedTokens = 0, reasoningTokens = 0;

    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }

      const type = d.type as string | undefined;

      if (type === 'response.created') {
        const resp = d.response as Record<string, unknown> | undefined;
        if (resp?.model) model = resp.model as string;
      }

      if (type === 'response.output_item.added') {
        const item = d.item as Record<string, unknown> | undefined;
        const outIdx = (d.output_index as number) ?? 0;
        if (item?.type === 'function_call') {
          const itemId = (item.id as string) ?? String(outIdx);
          toolCallMap.set(itemId, {
            outputIndex: outIdx,
            name: (item.name as string) ?? '(unknown)',
            args: (item.arguments as string) ?? '',
          });
        }
      }

      if (type === 'response.output_text.delta') {
        text += (d.delta as string) ?? '';
      }

      if (type === 'response.reasoning_summary_text.delta') {
        reasoningText += (d.delta as string) ?? '';
      }

      if (type === 'response.function_call_arguments.delta') {
        const itemId = d.item_id as string | undefined;
        if (itemId && toolCallMap.has(itemId)) {
          toolCallMap.get(itemId)!.args += (d.delta as string) ?? '';
        }
      }

      if (type === 'response.function_call_arguments.done') {
        const itemId = d.item_id as string | undefined;
        if (itemId && toolCallMap.has(itemId)) {
          // Use the final assembled arguments rather than accumulated deltas.
          const finalArgs = d.arguments as string | undefined;
          if (finalArgs != null) toolCallMap.get(itemId)!.args = finalArgs;
        }
      }

      if (type === 'response.completed') {
        const resp = d.response as Record<string, unknown> | undefined;
        if (!model && resp?.model) model = resp.model as string;
        const u = resp?.usage as Record<string, unknown> | undefined;
        if (u) {
          inputTokens = (u.input_tokens as number) ?? 0;
          outputTokens = (u.output_tokens as number) ?? 0;
          cachedTokens = ((u.input_token_details as Record<string, number> | undefined)?.cached_tokens) ?? 0;
          reasoningTokens = ((u.output_token_details as Record<string, number> | undefined)?.reasoning_tokens) ?? 0;
        }
      }
    }

    const fmtN = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
    const freshIn = inputTokens - cachedTokens;
    const meta: string[] = [];
    if (model) meta.push(`model: ${model}`);
    if (freshIn > 0) meta.push(`in: ${fmtN(freshIn)}`);
    if (cachedTokens > 0) meta.push(`cache: ${fmtN(cachedTokens)}`);
    if (outputTokens > 0) meta.push(`out: ${fmtN(outputTokens)}`);
    if (reasoningTokens > 0) meta.push(`reasoning: ${fmtN(reasoningTokens)}`);

    const SEP = '─'.repeat(60);
    const out: string[] = [`# ${meta.join('  |  ')}`];

    if (reasoningText) {
      out.push('');
      out.push('[REASONING]');
      out.push(reasoningText);
    }

    if (text) {
      out.push('');
      out.push(text);
    }

    for (const [, tc] of [...toolCallMap.entries()].sort(([, a], [, b]) => a.outputIndex - b.outputIndex)) {
      out.push('');
      out.push(SEP);
      out.push(`[TOOL CALL: ${tc.name}]`);
      try { out.push(JSON.stringify(JSON.parse(tc.args), null, 2)); } catch { out.push(tc.args || '{}'); }
      out.push(SEP);
    }

    return out.join('\n');
  }
}
