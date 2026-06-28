export interface RawCapture {
  requestId: string;
  captureTs: number;
  request: Record<string, unknown>;
  upstreamUrl: string;
  responseMessageId: string | null;
  rawResponseSse: string | null;
  responseTs: number | null;
}

const DEFAULT_MAX = 200;

export class CaptureStore {
  private byId = new Map<string, RawCapture>();
  private byMsgId = new Map<string, string>();
  private readonly maxCaptures: number;

  constructor(max?: number) { this.maxCaptures = max ?? DEFAULT_MAX; }

  add(capture: RawCapture): void {
    this.byId.set(capture.requestId, capture);
    if (capture.responseMessageId) {
      this.byMsgId.set(capture.responseMessageId, capture.requestId);
    }
    if (this.byId.size > this.maxCaptures) {
      const oldest = this.byId.keys().next().value as string | undefined;
      if (oldest) {
        const old = this.byId.get(oldest);
        if (old?.responseMessageId) this.byMsgId.delete(old.responseMessageId);
        this.byId.delete(oldest);
      }
    }
  }

  updateResponse(
    requestId: string,
    update: { rawResponseSse: string; responseMessageId: string | null; responseTs: number },
  ): void {
    const cap = this.byId.get(requestId);
    if (!cap) return;
    cap.rawResponseSse = update.rawResponseSse;
    cap.responseMessageId = update.responseMessageId;
    cap.responseTs = update.responseTs;
    if (update.responseMessageId) {
      this.byMsgId.set(update.responseMessageId, requestId);
    }
  }

  getByRequestId(id: string): RawCapture | null {
    return this.byId.get(id) ?? null;
  }

  getByTimeRange(from: number, to: number): RawCapture[] {
    const out: RawCapture[] = [];
    for (const cap of this.byId.values()) {
      if (cap.captureTs >= from && cap.captureTs <= to) out.push(cap);
    }
    return out;
  }

  getByMessageId(msgId: string): RawCapture | null {
    const id = this.byMsgId.get(msgId);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  clear(): void {
    this.byId.clear();
    this.byMsgId.clear();
  }

  size(): number { return this.byId.size; }
}
