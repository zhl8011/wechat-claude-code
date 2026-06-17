import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
export const PROMPT_TRUNCATE_LEN = 60;
export const BRIDGE_SESSIONS_FILENAME = 'bridge-sessions.json';

/**
 * Encode a working-directory path the way Claude Code does:
 *   /home/zizi/zesp32  ->  -home-zizi-zesp32
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Resolve the directory where Claude Code stores jsonl sessions for `cwd`.
 *   ~/.claude/projects/-home-zizi-zesp32/
 */
export function getSessionDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd));
}

/**
 * Resolve the path to bridge-sessions.json, the file that records every
 * session UUID the bridge has ever spawned.
 */
export function getBridgeSessionsPath(): string {
  return join(homedir(), '.wechat-claude-code', BRIDGE_SESSIONS_FILENAME);
}

export interface SessionInfo {
  uuid: string;
  mtime: Date;
  firstUserPrompt: string;
  source: 'bridge' | 'unknown';
  isActive: boolean;
}
