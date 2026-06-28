type TerminalWrite = (sessionId: string, data: string) => Promise<void>;
type TerminalFocus = (sessionId: string) => Promise<void>;

const CTRL_U = '\x15';

/**
 * Injects text into a PTY's input line.
 *
 * The key rule: each logical injection is delivered as a SINGLE write, never as
 * a Ctrl+U / text / Enter sequence of separate writes. Separate writes arrive
 * back-to-back but are consumed by the shell's line editor (ZLE) asynchronously,
 * so a redrawing prompt could drop the leading characters of the command — the
 * head would flash then vanish, leaving a broken `; …` line. Concatenating the
 * whole sequence into one buffer makes the shell read clear → text → Enter in
 * order with no inter-write gap to race, which removes the problem at the source
 * (no settle timers, no bracketed-paste markers).
 */
export class PtyInjector {
  private queues = new Map<string, Promise<void>>();

  constructor(
    private readonly write: TerminalWrite,
    private readonly focus: TerminalFocus,
  ) {}

  /** Clear the line and fill text, without Enter — the user runs it themselves. */
  async fillLine(sessionId: string, text: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.write(sessionId, CTRL_U + (text ?? ''));
      await this.focus(sessionId).catch(() => {});
    });
  }

  /**
   * Clear the line, fill text, and press Enter — explicit "run now" (launch button).
   *
   * On Windows the Ctrl+U is omitted: conhost without PSReadLine echoes the raw
   * `\x15` NAK byte into the buffer, which becomes a parse error. Trade-off: any
   * text typed before launch is appended rather than cleared.
   */
  async sendLine(sessionId: string, text: string): Promise<void> {
    const clear = process.platform === 'win32' ? '' : CTRL_U;
    return this.enqueue(sessionId, async () => {
      await this.write(sessionId, clear + (text ?? '') + '\r');
    });
  }

  /**
   * Send raw bytes (e.g. control / escape sequences) without any Ctrl+U or CR.
   * Used to deliver key presses like Shift+Tab (`\x1b[Z`) to a running claude.
   */
  async sendRaw(sessionId: string, data: string): Promise<void> {
    if (!data) return;
    return this.enqueue(sessionId, async () => {
      await this.write(sessionId, data);
      await this.focus(sessionId).catch(() => {});
    });
  }

  /**
   * Press the same key sequence `times` in a row, with a small gap between
   * presses. Needed because claude's input handler debounces consecutive
   * identical escape sequences when they arrive in a single write — e.g.
   * `'\x1b[Z\x1b[Z'` is often treated as one Shift+Tab, not two.
   */
  async pressKey(sessionId: string, key: string, times: number, gapMs = 250): Promise<void> {
    if (!key || times <= 0) return;
    return this.enqueue(sessionId, async () => {
      for (let i = 0; i < times; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
        await this.write(sessionId, key);
      }
      await this.focus(sessionId).catch(() => {});
    });
  }

  private enqueue(sessionId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.queues.set(sessionId, next.catch(() => {}));
    return next;
  }
}
