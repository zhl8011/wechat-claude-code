import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

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

interface ParsedSession {
  agentName: string | null;        // user `--name` (highest priority)
  aiTitle: string | null;          // cc-generated title
  firstUserText: string | null;    // first text-content user line
  hasCliTyped: boolean;            // at least one user line entrypoint=cli/sdk-cli
}

/**
 * Read the jsonl once and pull out everything we need for the list row:
 *   - the user's `--name` (if any)
 *   - cc's auto-generated title (if any)
 *   - the first text content from a user line
 *   - whether the session has at least one user line from a real CLI / SDK
 *     typing entrypoint (entrypoint 'cli' or 'sdk-cli')
 *
 * Returns null when the file is unreadable or contains a non-JSON line
 * (corrupted session — skip it from the list).
 */
async function readSessionMetadata(jsonlPath: string): Promise<ParsedSession | null> {
  let content: string;
  try {
    content = await fs.readFile(jsonlPath, 'utf-8');
  } catch (err) {
    logger.warn('session-lister: read failed', { path: jsonlPath, error: (err as Error).message });
    return null;
  }
  const out: ParsedSession = {
    agentName: null,
    aiTitle: null,
    firstUserText: null,
    hasCliTyped: false,
  };
  for (const line of content.split('\n')) {
    if (!line) continue;
    let evt: {
      type?: string;
      agentName?: string;
      aiTitle?: string;
      entrypoint?: string;
      message?: { content?: unknown };
    };
    try {
      evt = JSON.parse(line);
    } catch (parseErr) {
      logger.warn('session-lister: skipping file with unparseable line', {
        path: jsonlPath,
        error: (parseErr as Error).message,
      });
      return null;
    }
    if (evt.type === 'agent-name' && typeof evt.agentName === 'string' && !out.agentName) {
      out.agentName = evt.agentName;
      continue;
    }
    if (evt.type === 'ai-title' && typeof evt.aiTitle === 'string' && !out.aiTitle) {
      out.aiTitle = evt.aiTitle;
      continue;
    }
    if (evt.type === 'user') {
      // Track whether this session ever has a user-typed turn. entrypoint
      // 'sdk-py' is the code-review skill's marker; we exclude sessions
      // that consist solely of such turns. entrypoint 'cli' and 'sdk-cli'
      // are real user input — including `<local-command-caveat>` rows
      // (the user invoked /init, /exit, /resume, etc.).
      if (evt.entrypoint === 'cli' || evt.entrypoint === 'sdk-cli') {
        out.hasCliTyped = true;
      }
      if (out.firstUserText === null) {
        const raw = evt.message?.content;
        if (typeof raw === 'string' && raw.length > 0) {
          out.firstUserText = raw;
        } else if (Array.isArray(raw)) {
          const textPart = (raw as Array<{ type?: string; text?: string }>).find((c) => c.type === 'text');
          if (textPart?.text) out.firstUserText = textPart.text;
        }
      }
    }
  }
  return out;
}

/**
 * Display label for a session, mirroring Claude Code's `/resume` order:
 *   1. user `--name` agentName          (highest priority)
 *   2. cc's auto-generated aiTitle
 *   3. first text user prompt          (fallback, e.g. "/clear")
 *   4. `(empty)`                        (last resort)
 */
function displayTitle(meta: ParsedSession): string {
  if (meta.agentName) return meta.agentName;
  if (meta.aiTitle) return meta.aiTitle;
  if (meta.firstUserText) return truncate(meta.firstUserText, PROMPT_TRUNCATE_LEN);
  return '(empty)';
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

    let firstUserPrompt: string;
    let meta: ParsedSession;
    try {
      const m = await readSessionMetadata(full);
      if (m === null) continue; // unreadable / corrupted
      if (!m.hasCliTyped) continue; // purely skill-driven (e.g. code-review) — skip
      meta = m;
      firstUserPrompt = displayTitle(m);
    } catch (err) {
      logger.warn('session-lister: failed to read user prompts', {
        path: full,
        error: (err as Error).message,
      });
      continue;
    }
    // isActive is no longer driven by jsonl mtime. The bridge itself writes
    // to the jsonl on every send (stream-json events are appended as the
    // agent runs), so a fresh mtime does not mean "CLI is using it" — it
    // could just be a session we ourselves just messaged. Use bridge
    // ownership as the signal instead: a session is "active" iff the
    // bridge itself owns it (i.e. it appears in bridge-sessions.json).
    // CLI-only sessions (not in the bridge set) are never flagged active,
    // so /resume from WeChat never blocks on them with a false "CLI may
    // be open" warning.
    const isBridgeOwned = bridgeSet.has(uuid);
    const source: SessionInfo['source'] = isBridgeOwned ? 'bridge' : 'unknown';

    results.push({ uuid, mtime: stat.mtime, firstUserPrompt, source, isActive: isBridgeOwned });
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
 *
 * WeChat folds a long single TEXT item into a grey "long message" card that
 * wraps awkwardly. For this output the natural row/line boundaries are
 * important — each session should be its own chat bubble. Use
 * `formatSessionListBubbles` instead of this when posting to WeChat.
 * This function is kept for callers that need one string (logs, tests).
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

/**
 * Render a session list as one short WeChat message per row, so the bridge
 * can fire a separate `sendText()` for each. Each row is a single line:
 *   `[N] <age>  <src>[tag]  <uuid8>  Q: <prompt>`
 * with a header bubble first ("📋 最近 N 条 session:") and a footer bubble
 * last ("发送 /resume <编号> ..."). Total: N + 2 bubbles.
 *
 * UUIDs are truncated to the first 8 hex chars (the collision risk for
 * 10-session listings on a single project is negligible and this halves
 * the line length, keeping each bubble well below WeChat's long-message
 * threshold). Full UUIDs can still be passed to `/resume <uuid>` — the
 * handler accepts the short form as a prefix match would be unsafe, so
 * pass the full UUID; we keep the short form for display only.
 */
export function formatSessionListBubbles(sessions: SessionInfo[]): string[] {
  if (sessions.length === 0) {
    return ['📋 当前目录暂无 session。\n先在 CLI 跑一句 / 微信发一句再试。'];
  }
  const out: string[] = [];
  out.push(`📋 最近 ${sessions.length} 条 session：`);
  sessions.forEach((s, i) => {
    const marker = s.isActive ? '🟢' : '⚪';
    const tag = s.isActive ? ' [活跃]' : '';
    const src = s.source === 'bridge' ? '桥' : 'CLI/其他';
    const uuidShort = s.uuid.slice(0, 8);
    out.push(
      `${marker} [${i + 1}] ${formatAge(s.mtime).padEnd(8)} ${src}${tag}  ${uuidShort}\nQ: ${s.firstUserPrompt}`,
    );
  });
  out.push('发送 /resume <编号> 接管；活跃 session 加 --force');
  return out;
}
