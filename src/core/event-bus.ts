type Listener = (...args: unknown[]) => void;

export class EventBus {
  private listeners = new Map<string, Listener[]>();

  on(event: string, cb: Listener): { dispose: () => void } {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
    return {
      dispose: () => {
        const l = this.listeners.get(event);
        if (l) this.listeners.set(event, l.filter((c) => c !== cb));
      },
    };
  }

  emit(event: string, ...args: unknown[]): void {
    const list = this.listeners.get(event);
    if (!list) return;
    for (const cb of list) {
      try { cb(...args); } catch { /* swallow */ }
    }
  }
}
