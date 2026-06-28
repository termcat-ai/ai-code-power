import type { SseStrategy, UnifiedTokenUsage } from '../types';

export class ClaudeSseStrategy implements SseStrategy {
  readonly captureEndpointPath = '/v1/messages';

  parseMessageId(buf: string): string | null {
    for (const block of buf.split('\n\n')) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (d.type === 'message_start') {
            const msg = d.message as Record<string, unknown> | undefined;
            if (typeof msg?.id === 'string') return msg.id;
          }
        } catch { /* skip */ }
      }
    }
    return null;
  }

  parseUsage(buf: string): UnifiedTokenUsage | null {
    let input = 0, output = 0, cacheRead = 0, found = false;
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const d = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (d.type === 'message_start') {
          const u = (d.message as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
          if (u) {
            input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            cacheRead = u.cache_read_input_tokens ?? 0;
            found = true;
          }
        }
        if (d.type === 'message_delta') {
          const u = d.usage as Record<string, number> | undefined;
          if (u?.output_tokens) output = u.output_tokens;
        }
      } catch { /* skip */ }
    }
    if (!found) return null;
    return { freshInputTokens: input, cacheReadTokens: cacheRead, outputTokens: output, reasoningTokens: 0 };
  }

  mergeSse(buf: string): string {
    type Block = { type: 'text'; text: string } | { type: 'tool_use'; name: string; input: string };
    const blocks = new Map<number, Block>();
    let model = '', inputTokens = 0, outputTokens = 0, cacheRead = 0, stopReason = '';

    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(line.slice(6)) as Record<string, unknown>; } catch { continue; }

      if (d.type === 'message_start') {
        const msg = d.message as Record<string, unknown> | undefined;
        model = (msg?.model as string) ?? '';
        const u = msg?.usage as Record<string, number> | undefined;
        if (u) { inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0); cacheRead = u.cache_read_input_tokens ?? 0; }
      }
      if (d.type === 'content_block_start') {
        const idx = d.index as number;
        const cb = d.content_block as Record<string, unknown> | undefined;
        if (cb?.type === 'text') blocks.set(idx, { type: 'text', text: '' });
        else if (cb?.type === 'tool_use') blocks.set(idx, { type: 'tool_use', name: (cb.name as string) ?? '', input: '' });
      }
      if (d.type === 'content_block_delta') {
        const idx = d.index as number;
        const blk = blocks.get(idx);
        const delta = d.delta as Record<string, unknown> | undefined;
        if (blk?.type === 'text' && delta?.type === 'text_delta') blk.text += (delta.text as string) ?? '';
        if (blk?.type === 'tool_use' && delta?.type === 'input_json_delta') blk.input += (delta.partial_json as string) ?? '';
      }
      if (d.type === 'message_delta') {
        stopReason = ((d.delta as Record<string, unknown> | undefined)?.stop_reason as string) ?? '';
        const u = d.usage as Record<string, number> | undefined;
        if (u?.output_tokens) outputTokens = u.output_tokens;
      }
    }

    const fmtN = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
    const meta: string[] = [];
    if (model) meta.push(`model: ${model}`);
    if (inputTokens) meta.push(`in: ${fmtN(inputTokens)}`);
    if (outputTokens) meta.push(`out: ${fmtN(outputTokens)}`);
    if (cacheRead) meta.push(`cache: ${fmtN(cacheRead)}`);
    if (stopReason) meta.push(`stop: ${stopReason}`);
    const SEP = '─'.repeat(60);
    const out: string[] = [`# ${meta.join('  |  ')}`];
    for (const [, blk] of [...blocks.entries()].sort(([a], [b]) => a - b)) {
      out.push('');
      if (blk.type === 'text') out.push(blk.text || '(empty text block)');
      else {
        out.push(SEP);
        out.push(`[TOOL USE: ${blk.name}]`);
        try { out.push(JSON.stringify(JSON.parse(blk.input), null, 2)); } catch { out.push(blk.input || '{}'); }
        out.push(SEP);
      }
    }
    return out.join('\n');
  }
}
