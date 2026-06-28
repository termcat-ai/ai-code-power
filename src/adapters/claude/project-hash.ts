import * as os from 'os';
import * as path from 'path';

/** Encode a cwd path the same way Claude Code does: replace non-alnum with '-'. */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Return the ~/.claude/projects/<encoded-cwd>/ directory for a given cwd. */
export function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}
