import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.json');
const ENV_PATH = path.join(os.homedir(), '.codex', '.env');

export interface CodexConfig {
  model?: string;
  baseUrl?: string;
  approvalMode?: string;
}

export class CodexConfigReader {
  async read(): Promise<CodexConfig> {
    const out: CodexConfig = {};
    try {
      const raw = await fs.promises.readFile(CONFIG_PATH, 'utf-8');
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (typeof j.model === 'string') out.model = j.model;
      if (typeof j.baseUrl === 'string') out.baseUrl = j.baseUrl;
      if (typeof j.approvalMode === 'string') out.approvalMode = j.approvalMode;
    } catch { /* file may not exist */ }
    return out;
  }

  async readApiKeyMasked(): Promise<string | null> {
    for (const envSource of [ENV_PATH, path.join(os.homedir(), '.env')]) {
      try {
        const text = await fs.promises.readFile(envSource, 'utf-8');
        for (const line of text.split('\n')) {
          const m = line.match(/^OPENAI_API_KEY=(.+)$/);
          if (m) {
            const key = m[1].trim().replace(/^["']|["']$/g, '');
            return maskSecret(key);
          }
        }
      } catch { /* skip */ }
    }
    const fromEnv = process.env.OPENAI_API_KEY ?? process.env.OPENAI_AUTH_TOKEN;
    return fromEnv ? maskSecret(fromEnv) : null;
  }

}

function maskSecret(s: string): string {
  if (s.length <= 10) return '***';
  return s.slice(0, 6) + '...' + s.slice(-4);
}
