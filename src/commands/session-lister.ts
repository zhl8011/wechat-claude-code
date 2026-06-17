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

/**
 * Record that the bridge spawned a session with this UUID. Idempotent:
 * adding the same UUID twice leaves only one entry. Atomic via tmp+rename.
 * Never throws — log+swallow on failure so message flow is not interrupted.
 */
export async function appendBridgeSessionId(uuid: string): Promise<void> {
  const path = getBridgeSessionsPath();
  const dir = join(homedir(), '.wechat-claude-code');
  let list: string[] = [];
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // file missing or unreadable — start empty
  }
  if (list.includes(uuid)) return;

  list.push(uuid);
  const tmp = path + '.tmp';
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(list, null, 2));
    await fs.rename(tmp, path);
  } catch (err) {
    logger.warn('session-lister: failed to persist bridge session id', {
      uuid,
      error: (err as Error).message,
    });
    // Best-effort cleanup
    try { await fs.unlink(tmp); } catch { /* ignore */ }
  }
}

function formatAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return '刚刚';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

/**
 * Render a session list for the WeChat reply.
 */
export function formatSessionList(sessions: SessionInfo[]): string {
  if (sessions.length === 0) {
    return '📋 当前目录暂无 session。\n先在 CLI 跑一句 / 微信发一句再试。';
  }
  const lines = [`📋 最近 ${sessions.length} 条 session：\n`];
  sessions.forEach((s, i) => {
    const marker = s.isActive ? '🟢' : '  ';
    const tag = s.isActive ? ' [活跃]' : '';
    const src = s.source === 'bridge' ? '桥' : 'CLI/其他';
    lines.push(`${marker} [${i + 1}] ${formatAge(s.mtime).padEnd(8)} ${src}${tag} ${s.uuid}`);
    lines.push(`    Q: ${s.firstUserPrompt}`);
  });
  lines.push('\n发送 /resume <编号> 接管；活跃 session 加 --force');
  return lines.join('\n');
}
