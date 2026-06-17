import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

export const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
export const PROMPT_TRUNCATE_LEN = 60;
export const BRIDGE_SESSIONS_FILENAME = 'bridge-sessions.json';

export interface SessionInfo {
  uuid: string;
  mtime: Date;
  firstUserPrompt: string;
  source: 'bridge' | 'unknown';
  isActive: boolean;
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

export function getSessionDir(cwd: string): string {
  return join(homedir(), '.claude', 'projects', encodeCwd(cwd));
}

export function getBridgeSessionsPath(): string {
  return join(homedir(), '.wechat-claude-code', BRIDGE_SESSIONS_FILENAME);
}

async function loadBridgeSessionIds(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(getBridgeSessionsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

async function readFirstUserPrompt(jsonlPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(jsonlPath, 'utf-8');
    const firstLine = content.split('\n', 2)[0];
    const evt = JSON.parse(firstLine) as { message?: { role?: string; content?: Array<{ type: string; text?: string }> } };
    const msg = evt?.message;
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) {
      return '(no user message)';
    }
    const textPart = msg.content.find((c) => c.type === 'text');
    return truncate(textPart?.text ?? '', PROMPT_TRUNCATE_LEN);
  } catch (err) {
    logger.warn('session-lister: failed to parse first user prompt', {
      path: jsonlPath,
      error: (err as Error).message,
    });
    return null;
  }
}

export async function listSessions(cwd: string, limit = 10): Promise<SessionInfo[]> {
  const dir = getSessionDir(cwd);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const bridgeSet = await loadBridgeSessionIds();

  const results: SessionInfo[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const uuid = name.slice(0, -'.jsonl'.length);
    const full = join(dir, name);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch (err) {
      logger.warn('session-lister: stat failed', { path: full, error: (err as Error).message });
      continue;
    }

    const firstUserPrompt = await readFirstUserPrompt(full);
    if (firstUserPrompt === null) continue;
    const source: SessionInfo['source'] = bridgeSet.has(uuid) ? 'bridge' : 'unknown';
    const isActive = Date.now() - stat.mtime.getTime() < ACTIVE_THRESHOLD_MS;

    results.push({ uuid, mtime: stat.mtime, firstUserPrompt, source, isActive });
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}
