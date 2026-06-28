import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chokidar, { type FSWatcher } from 'chokidar';

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

function isPermissionMode(v: unknown): v is PermissionMode {
  return v === 'default' || v === 'acceptEdits' || v === 'plan' || v === 'auto' || v === 'bypassPermissions';
}

export class SettingsReader {
  private watcher: FSWatcher | null = null;
  private changeListeners: Array<() => void> = [];

  async readDefaultPermissionMode(): Promise<PermissionMode> {
    try {
      const raw = await fs.promises.readFile(SETTINGS_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as { permissions?: { defaultMode?: unknown } };
      const mode = parsed.permissions?.defaultMode;
      if (isPermissionMode(mode)) return mode;
    } catch { /* file may not exist */ }
    return 'default';
  }

  async writeDefaultPermissionMode(mode: PermissionMode): Promise<void> {
    let current: Record<string, unknown> = {};
    try { current = JSON.parse(await fs.promises.readFile(SETTINGS_PATH, 'utf-8')) as Record<string, unknown>; } catch { /* ok */ }
    const permissions = (current.permissions ?? {}) as Record<string, unknown>;
    permissions.defaultMode = mode;
    current.permissions = permissions;
    const dir = path.dirname(SETTINGS_PATH);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = SETTINGS_PATH + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    await fs.promises.rename(tmp, SETTINGS_PATH);
  }

  watch(onChange: () => void): { dispose: () => void } {
    this.changeListeners.push(onChange);
    if (!this.watcher) {
      this.watcher = chokidar.watch(SETTINGS_PATH, { persistent: true, ignoreInitial: true });
      this.watcher.on('change', () => { for (const cb of this.changeListeners) cb(); });
    }
    return {
      dispose: () => {
        this.changeListeners = this.changeListeners.filter((c) => c !== onChange);
        if (this.changeListeners.length === 0) {
          this.watcher?.close().catch(() => {});
          this.watcher = null;
        }
      },
    };
  }
}
