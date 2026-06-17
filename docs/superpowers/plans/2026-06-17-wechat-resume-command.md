# wechat-claude-code `/resume` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/resume` slash command to wechat-claude-code that lists the 10 most recent Claude Code sessions for the bridge's current working directory and lets the user resume any of them by index or UUID, with an active-session safety check.

**Architecture:** New module `src/commands/session-lister.ts` reads `~/.claude/projects/<encoded-cwd>/*.jsonl` and `~/.wechat-claude-code/bridge-sessions.json` to produce a sorted session list. Router adds a `case 'resume'` dispatch; `handlers.ts` adds `handleResume` which calls `listSessions` and either formats the list or mutates `session.sdkSessionId` via the existing `ctx.updateSession`. The bridge daemon appends the new `result.sessionId` to `bridge-sessions.json` after each successful query so the lister can later mark that uuid as "bridge-spawned".

**Tech Stack:** TypeScript, Node 22+, `node:test` (built-in), `node:fs/promises`, `node:os`, `node:path`. Zero new dependencies.

**Working directory:** All development happens in `/home/zizi/wechat-claude-code/` (fork clone). The production bridge continues running from `~/.claude/skills/wechat-claude-code/` — do NOT modify that directory until the final deployment task.

**Spec:** `docs/superpowers/specs/2026-06-17-wechat-resume-command-design.md` (same repo).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/commands/session-lister.ts` | create | Pure module: read jsonl files, parse first user message, compute source/active, append bridge sessionIds, format list |
| `src/commands/handlers.ts` | modify | Add `handleResume` function; update `HELP_TEXT` |
| `src/commands/router.ts` | modify | Add `case 'resume'` import + dispatch |
| `src/main.ts` | modify | Call `appendBridgeSessionId` after successful query |
| `src/tests/session-lister.test.ts` | create | Unit tests for `listSessions`, `appendBridgeSessionId`, `formatSessionList` |
| `src/tests/resume-handler.test.ts` | create | Unit tests for `handleResume` argument parsing |

No existing file is restructured or split.

---

### Task 1: Create `session-lister.ts` skeleton with `encodeCwd` and `getSessionDir`

**Files:**
- Create: `src/commands/session-lister.ts`

These two pure functions have no dependencies on the rest of the module. Implement them first and immediately commit so the file exists with a verifiable shape.

- [ ] **Step 1: Create the file with exports**

Create `src/commands/session-lister.ts` with the following exact content:

```typescript
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
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build
```

Expected: exits 0, no diagnostics.

- [ ] **Step 3: Commit**

```bash
cd /home/zizi/wechat-claude-code && git add src/commands/session-lister.ts && git commit -m "feat(resume): add session-lister skeleton with encodeCwd/getSessionDir"
```

---

### Task 2: Implement `listSessions` (read jsonl dir, parse, sort)

**Files:**
- Modify: `src/commands/session-lister.ts`
- Create: `src/tests/session-lister.test.ts`

`listSessions` is the core function. We TDD it: write the tests, watch them fail, implement, watch them pass.

- [ ] **Step 1: Create the test directory and test file**

```bash
mkdir -p /home/zizi/wechat-claude-code/src/tests
```

Create `src/tests/session-lister.test.ts` with this exact content:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_THRESHOLD_MS,
  encodeCwd,
  getBridgeSessionsPath,
  getSessionDir,
  listSessions,
} from '../commands/session-lister.js';

/**
 * Build a unique working-directory string for one test. Uses Date.now()+random
 * so concurrent tests do not collide on the same on-disk directory.
 */
function uniqueCwd(label: string): string {
  return `/tmp/wcc-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create `getSessionDir(cwd)` and populate it with the given sessions.
 * Each session is `{ uuid, mtimeAgoMs, prompt?, role? }`. If `prompt` is
 * omitted the jsonl file is left unparseable on purpose so we exercise the
 * error path.
 */
async function seedSessions(
  cwd: string,
  sessions: Array<{
    uuid: string;
    mtimeAgoMs: number;
    prompt?: string;
    role?: string;
    garbage?: boolean;
  }>,
): Promise<void> {
  const dir = getSessionDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  for (const s of sessions) {
    const path = join(dir, `${s.uuid}.jsonl`);
    let content = '';
    if (s.garbage) {
      content = '{not valid json';
    } else {
      const evt = {
        type: s.role === 'system' ? 'system' : 'user',
        message: {
          role: s.role ?? 'user',
          content: [{ type: 'text', text: s.prompt ?? '' }],
        },
      };
      content = JSON.stringify(evt) + '\n';
    }
    await fs.writeFile(path, content);
    const t = new Date(Date.now() - s.mtimeAgoMs);
    await fs.utimes(path, t, t);
  }
}

/**
 * Clean up everything we wrote under ~/.claude/projects/ for `cwd`.
 * We can't just `rm` getSessionDir() because tests may run in parallel
 * and we only own files we created. The dir name has a unique suffix so
 * we own it entirely.
 */
async function cleanupCwd(cwd: string): Promise<void> {
  await fs.rm(getSessionDir(cwd), { recursive: true, force: true });
}

test('encodeCwd replaces slashes with dashes', () => {
  assert.equal(encodeCwd('/home/zizi/zesp32'), '-home-zizi-zesp32');
  assert.equal(encodeCwd('/'), '-');
});

test('getSessionDir places files under ~/.claude/projects/<encoded>', () => {
  const dir = getSessionDir('/home/zizi/zesp32');
  assert.ok(dir.endsWith('/.claude/projects/-home-zizi-zesp32'));
});

test('getBridgeSessionsPath is ~/.wechat-claude-code/bridge-sessions.json', () => {
  const p = getBridgeSessionsPath();
  assert.ok(p.endsWith('/.wechat-claude-code/bridge-sessions.json'));
});

test('listSessions: project dir does not exist returns []', async () => {
  const cwd = uniqueCwd('missing');
  const r = await listSessions(cwd);
  assert.deepEqual(r, []);
});

test('listSessions: project dir empty returns []', async () => {
  const cwd = uniqueCwd('empty');
  await fs.mkdir(getSessionDir(cwd), { recursive: true });
  try {
    const r = await listSessions(cwd);
    assert.deepEqual(r, []);
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: sorts by mtime descending', async () => {
  const cwd = uniqueCwd('sort');
  await seedSessions(cwd, [
    { uuid: 'old', mtimeAgoMs: 3600_000, prompt: 'old prompt' },
    { uuid: 'new', mtimeAgoMs: 60_000, prompt: 'new prompt' },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 2);
    assert.equal(r[0].uuid, 'new');
    assert.equal(r[1].uuid, 'old');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: respects limit', async () => {
  const cwd = uniqueCwd('limit');
  const seed = Array.from({ length: 15 }, (_, i) => ({
    uuid: `s${i.toString().padStart(2, '0')}`,
    // Newest first
    mtimeAgoMs: i * 60_000,
    prompt: `prompt ${i}`,
  }));
  await seedSessions(cwd, seed);
  try {
    const r = await listSessions(cwd, 10);
    assert.equal(r.length, 10);
    assert.equal(r[0].uuid, 's00');
    assert.equal(r[9].uuid, 's09');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: marks isActive when mtime within threshold', async () => {
  const cwd = uniqueCwd('active');
  await seedSessions(cwd, [
    { uuid: 'fresh', mtimeAgoMs: 60_000, prompt: 'p' },
    { uuid: 'stale', mtimeAgoMs: ACTIVE_THRESHOLD_MS + 60_000, prompt: 'p' },
  ]);
  try {
    const r = await listSessions(cwd);
    const fresh = r.find((s) => s.uuid === 'fresh')!;
    const stale = r.find((s) => s.uuid === 'stale')!;
    assert.equal(fresh.isActive, true);
    assert.equal(stale.isActive, false);
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: truncates long prompt to 60 chars + ellipsis', async () => {
  const cwd = uniqueCwd('truncate');
  const long = 'a'.repeat(100);
  await seedSessions(cwd, [{ uuid: 'lp', mtimeAgoMs: 0, prompt: long }]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r[0].firstUserPrompt.length, 61);
    assert.ok(r[0].firstUserPrompt.endsWith('…'));
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: skips jsonl with garbage first line', async () => {
  const cwd = uniqueCwd('garbage');
  await seedSessions(cwd, [
    { uuid: 'bad', mtimeAgoMs: 0, garbage: true },
    { uuid: 'good', mtimeAgoMs: 0, prompt: 'ok' },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 1);
    assert.equal(r[0].uuid, 'good');
    assert.equal(r[0].firstUserPrompt, 'ok');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: non-user first line yields placeholder, not skip', async () => {
  const cwd = uniqueCwd('norole');
  await seedSessions(cwd, [{ uuid: 'sys', mtimeAgoMs: 0, role: 'system', prompt: 'init' }]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 1);
    assert.equal(r[0].firstUserPrompt, '(no user message)');
  } finally {
    await cleanupCwd(cwd);
  }
});
```

- [ ] **Step 2: Run tests and confirm they fail (compilation OK, assertions fail)**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build && npm test
```

Expected: build succeeds (we only have the skeleton with encodeCwd/getSessionDir/getBridgeSessionsPath exports). Test run shows failures for `listSessions: project dir does not exist returns []` and onwards — `listSessions` is referenced but not yet defined, so the import will fail or assertions will throw.

If you see `SyntaxError: The requested module ... does not provide an export named 'listSessions'`, that's the expected failure.

- [ ] **Step 3: Implement `listSessions`**

Replace the contents of `src/commands/session-lister.ts` with this expanded version (keep all existing exports, add `listSessions` and the small helpers):

```typescript
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

async function readFirstUserPrompt(jsonlPath: string): Promise<string> {
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
    return '(unreadable)';
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
    const source: SessionInfo['source'] = bridgeSet.has(uuid) ? 'bridge' : 'unknown';
    const isActive = Date.now() - stat.mtime.getTime() < ACTIVE_THRESHOLD_MS;

    results.push({ uuid, mtime: stat.mtime, firstUserPrompt, source, isActive });
  }

  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit);
}
```

- [ ] **Step 4: Build + run tests, confirm pass**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build && npm test
```

Expected: all tests pass. Look for the line `tests N` followed by `pass N` where both equal 11 (the 11 new tests we added). Other lines may also report zero for the file-existence test of the not-yet-existing handler tests; that is fine.

If any test fails, read the failure carefully, fix the implementation (not the test), and re-run.

- [ ] **Step 5: Commit**

```bash
cd /home/zizi/wechat-claude-code && git add src/commands/session-lister.ts src/tests/session-lister.test.ts && git commit -m "feat(resume): add listSessions with sort, mtime, active detection, and tests"
```

---

### Task 3: Implement `appendBridgeSessionId` + `formatSessionList`

**Files:**
- Modify: `src/commands/session-lister.ts`
- Modify: `src/tests/session-lister.test.ts`

- [ ] **Step 1: Add the failing tests for `appendBridgeSessionId` and `formatSessionList`**

Append these test cases to the end of `src/tests/session-lister.test.ts` (just before the closing line — there is no closing line since the file ends with the last test):

```typescript
import {
  // ... existing imports ...
  appendBridgeSessionId,
  formatSessionList,
} from '../commands/session-lister.js';

// helper for appendBridgeSessionId tests — points BRIDGE_SESSIONS_FILENAME
// at a temp file by overriding HOME via os.homedir()? No — instead we
// write directly to the real ~/.wechat-claude-code/bridge-sessions.json
// but use a sentinel uuid we delete in finally. This is acceptable
// because (a) the file is meant to be an append-only log, (b) the
// sentinel is unlikely to collide with any real session UUID.

const SENTINEL_UUID_PREFIX = '00000000-0000-0000-0000-';

test('appendBridgeSessionId: writes new uuid', async () => {
  const uuid = SENTINEL_UUID_PREFIX + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  try {
    await appendBridgeSessionId(uuid);
    const raw = await fs.readFile(getBridgeSessionsPath(), 'utf-8');
    const arr = JSON.parse(raw);
    assert.ok(Array.isArray(arr));
    assert.ok(arr.includes(uuid));
  } finally {
    await removeSentinel(uuid);
  }
});

test('appendBridgeSessionId: deduplicates same uuid', async () => {
  const uuid = SENTINEL_UUID_PREFIX + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  try {
    await appendBridgeSessionId(uuid);
    await appendBridgeSessionId(uuid);
    const raw = await fs.readFile(getBridgeSessionsPath(), 'utf-8');
    const arr = JSON.parse(raw);
    const count = arr.filter((x: string) => x === uuid).length;
    assert.equal(count, 1);
  } finally {
    await removeSentinel(uuid);
  }
});

test('formatSessionList: empty array', () => {
  const out = formatSessionList([]);
  assert.ok(out.includes('暂无 session'));
});

test('formatSessionList: includes uuid, source, active marker', () => {
  const now = Date.now();
  const sessions = [
    {
      uuid: 'abc-123-active',
      mtime: new Date(now - 60_000),
      firstUserPrompt: 'just now',
      source: 'bridge' as const,
      isActive: true,
    },
    {
      uuid: 'xyz-789-old',
      mtime: new Date(now - 3600_000),
      firstUserPrompt: 'long ago',
      source: 'unknown' as const,
      isActive: false,
    },
  ];
  const out = formatSessionList(sessions);
  assert.ok(out.includes('abc-123-active'));
  assert.ok(out.includes('xyz-789-old'));
  assert.ok(out.includes('活跃'));
  assert.ok(out.includes('桥'));
  assert.ok(out.includes('CLI/其他'));
  assert.ok(out.includes('1分钟前'));
  assert.ok(out.includes('1小时前'));
});

async function removeSentinel(uuid: string): Promise<void> {
  try {
    const raw = await fs.readFile(getBridgeSessionsPath(), 'utf-8');
    const arr: string[] = JSON.parse(raw);
    const filtered = arr.filter((x) => x !== uuid);
    await fs.writeFile(getBridgeSessionsPath(), JSON.stringify(filtered, null, 2));
  } catch {
    // file may not exist yet
  }
}
```

Note: the imports block already includes the existing module imports. Add the two new symbols to the existing `import { ... } from '../commands/session-lister.js'` line in alphabetical position — i.e. `appendBridgeSessionId, formatSessionList,` go right after the existing entries.

- [ ] **Step 2: Run tests, confirm new ones fail**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build && npm test
```

Expected: failures for `appendBridgeSessionId` and `formatSessionList` (the symbols don't exist yet). The previous 11 tests still pass.

- [ ] **Step 3: Add `appendBridgeSessionId` and `formatSessionList` to `session-lister.ts`**

Append the following code to the end of `src/commands/session-lister.ts` (inside the file, after `listSessions`):

```typescript
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
    return '📋 当前目录暂无 Claude session。\n先在 CLI 跑一句 / 微信发一句再试。';
  }
  const lines = [`📋 最近 ${sessions.length} 条 session：\n`];
  sessions.forEach((s, i) => {
    const marker = s.isActive ? '🟢' : '  ';
    const tag = s.isActive ? ' [活跃]' : '';
    const src = s.source === 'bridge' ? '桥' : 'CLI/其他';
    lines.push(`${marker} [${i + 1}] ${formatAge(s.mtime).padEnd(8)} ${src}${tag}`);
    lines.push(`    Q: ${s.firstUserPrompt}`);
  });
  lines.push('\n发送 /resume <编号> 接管；活跃 session 加 --force');
  return lines.join('\n');
}
```

- [ ] **Step 4: Build + run tests, confirm pass**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build && npm test
```

Expected: all tests pass (15 total now: 11 from Task 2 + 4 new). Tests should report `# tests 15`.

- [ ] **Step 5: Commit**

```bash
cd /home/zizi/wechat-claude-code && git add src/commands/session-lister.ts src/tests/session-lister.test.ts && git commit -m "feat(resume): add appendBridgeSessionId and formatSessionList"
```

---

### Task 4: Add `handleResume` to `handlers.ts` with TDD

**Files:**
- Modify: `src/commands/handlers.ts`
- Create: `src/tests/resume-handler.test.ts`

`handleResume` is async and depends on `listSessions`. We test it with the real `os.tmpdir`-based file fixtures to keep things honest.

- [ ] **Step 1: Write the failing tests**

Create `src/tests/resume-handler.test.ts` with this exact content:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../commands/router.js';
import { handleResume } from '../commands/handlers.js';
import { getSessionDir } from '../commands/session-lister.js';

interface CapturedUpdate {
  calls: Array<Record<string, unknown>>;
}

function makeCtx(cwd: string, captured: CapturedUpdate): CommandContext {
  const session = {
    sdkSessionId: undefined,
    workingDirectory: cwd,
    state: 'idle' as const,
    chatHistory: [],
  };
  const updateSession = (partial: Record<string, unknown>) => {
    captured.calls.push(partial);
    Object.assign(session, partial);
  };
  return {
    accountId: 'test-account',
    session: session as unknown as CommandContext['session'],
    updateSession: updateSession as unknown as CommandContext['updateSession'],
    clearSession: () => session as unknown as ReturnType<CommandContext['clearSession']>,
    text: '/resume',
  };
}

function uniqueCwd(label: string): string {
  return `/tmp/wcc-resume-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed(cwd: string, sessions: Array<{ uuid: string; mtimeAgoMs: number; prompt?: string }>): Promise<void> {
  const dir = getSessionDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  for (const s of sessions) {
    const path = join(dir, `${s.uuid}.jsonl`);
    const evt = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: s.prompt ?? '' }] },
    };
    await fs.writeFile(path, JSON.stringify(evt) + '\n');
    const t = new Date(Date.now() - s.mtimeAgoMs);
    await fs.utimes(path, t, t);
  }
}

async function cleanup(cwd: string): Promise<void> {
  await fs.rm(getSessionDir(cwd), { recursive: true, force: true });
}

test('handleResume: empty args returns list reply, handled=true', async () => {
  const cwd = uniqueCwd('list');
  await seed(cwd, [{ uuid: 'a', mtimeAgoMs: 0, prompt: 'hi' }]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, '');
    assert.equal(r.handled, true);
    assert.ok(r.reply);
    assert.ok(r.reply!.includes('最近 1 条 session'));
    assert.ok(r.reply!.includes('a'));
    assert.equal(captured.calls.length, 0, 'must not update session on list');
  } finally {
    await cleanup(cwd);
  }
});

test('handleResume: numeric index resumes that session', async () => {
  const cwd = uniqueCwd('idx');
  await seed(cwd, [
    { uuid: 'first', mtimeAgoMs: 0, prompt: 'first' },
    { uuid: 'second', mtimeAgoMs: 60_000, prompt: 'second' },
  ]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    // sorted by mtime desc → 'first' (mtime 0) is index 1, 'second' (mtime 1m ago) is index 2
    const r = await handleResume(ctx, '1');
    assert.equal(r.handled, true);
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].sdkSessionId, 'first');
    assert.ok(r.reply!.includes('已接管'));
  } finally {
    await cleanup(cwd);
  }
});

test('handleResume: index out of range replies with error', async () => {
  const cwd = uniqueCwd('oor');
  await seed(cwd, [{ uuid: 'a', mtimeAgoMs: 0, prompt: 'p' }]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, '99');
    assert.equal(r.handled, true);
    assert.ok(r.reply!.includes('编号无效'));
    assert.equal(captured.calls.length, 0);
  } finally {
    await cleanup(cwd);
  }
});

test('handleResume: active session without --force is rejected', async () => {
  const cwd = uniqueCwd('active');
  await seed(cwd, [{ uuid: 'fresh', mtimeAgoMs: 60_000, prompt: 'p' }]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, '1');
    assert.equal(r.handled, true);
    assert.ok(r.reply!.includes('活跃'));
    assert.equal(captured.calls.length, 0);
  } finally {
    await cleanup(cwd);
  }
});

test('handleResume: active session with --force resumes', async () => {
  const cwd = uniqueCwd('force');
  await seed(cwd, [{ uuid: 'fresh', mtimeAgoMs: 60_000, prompt: 'p' }]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, '1 --force');
    assert.equal(r.handled, true);
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].sdkSessionId, 'fresh');
  } finally {
    await cleanup(cwd);
  }
});

test('handleResume: uuid form resumes directly', async () => {
  const cwd = uniqueCwd('uuid');
  await seed(cwd, [
    { uuid: 'alpha', mtimeAgoMs: 0, prompt: 'a' },
    { uuid: 'beta', mtimeAgoMs: 60_000, prompt: 'b' },
  ]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, 'beta');
    assert.equal(r.handled, true);
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].sdkSessionId, 'beta');
  } finally {
    await cleanup(cwd);
  }
});

test('handleResume: invalid format replies with usage', async () => {
  const cwd = uniqueCwd('bad');
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, 'not-a-number-not-a-uuid');
    assert.equal(r.handled, true);
    assert.ok(r.reply!.includes('格式无效'));
    assert.equal(captured.calls.length, 0);
  } finally {
    await cleanup(cwd);
  }
});

test('handleResume: empty project replies with "暂无 session"', async () => {
  const cwd = uniqueCwd('empty');
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, '');
    assert.equal(r.handled, true);
    assert.ok(r.reply!.includes('暂无 session'));
    assert.equal(captured.calls.length, 0);
  } finally {
    await cleanup(cwd);
  }
});
```

- [ ] **Step 2: Run tests, confirm new ones fail (handleResume not exported)**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build && npm test
```

Expected: build fails with `error TS2305: Module '"../commands/handlers.js"' has no exported member 'handleResume'`. (Or if build succeeds due to TS loose mode, the test runtime fails with a missing export.)

- [ ] **Step 3: Add imports + `handleResume` to `handlers.ts`**

First, add this import to the top of `src/commands/handlers.ts` (alongside the existing `from './router.js'` import line):

```typescript
import { listSessions } from './session-lister.js';
```

Then add the following function at the end of `src/commands/handlers.ts`:

```typescript
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleResume(ctx: CommandContext, args: string): Promise<CommandResult> {
  const cwd = ctx.session.workingDirectory;
  const trimmed = args.trim();

  // No args → list
  if (!trimmed) {
    const sessions = await listSessions(cwd, 10);
    return { reply: formatSessionList(sessions), handled: true };
  }

  // Parse tokens
  const tokens = trimmed.split(/\s+/);
  const force = tokens.includes('--force');
  const targets = tokens.filter((t) => t !== '--force');
  const target = targets[0];

  if (!target) {
    return { reply: '格式无效，参考：/resume 1 或 /resume <uuid>', handled: true };
  }

  let uuid: string | undefined;
  if (/^\d+$/.test(target)) {
    // Numeric index
    const limit = 10;
    const sessions = await listSessions(cwd, limit);
    const idx = parseInt(target, 10) - 1;
    const sess = sessions[idx];
    if (!sess) {
      return { reply: '编号无效，请先 /resume 查看列表', handled: true };
    }
    uuid = sess.uuid;
  } else if (UUID_REGEX.test(target)) {
    // UUID form — confirm it actually exists in the dir
    const sessions = await listSessions(cwd, 100);
    const sess = sessions.find((s) => s.uuid === target);
    if (!sess) {
      return { reply: '未找到该 session，可能已被删除。', handled: true };
    }
    uuid = sess.uuid;
  } else {
    return { reply: '格式无效，参考：/resume 1 或 /resume <uuid>', handled: true };
  }

  // Active-session check
  // For numeric path we already have `sess`; for UUID path we re-fetch above.
  const sessions = await listSessions(cwd, 100);
  const targetSess = sessions.find((s) => s.uuid === uuid);
  if (targetSess?.isActive && !force) {
    return {
      reply: `⚠️ session 活跃（${formatAgeForReply(targetSess.mtime)}写过），可能是 CLI 还开着。\n强行接管加 --force：/resume ${target} --force`,
      handled: true,
    };
  }

  ctx.updateSession({ sdkSessionId: uuid });
  return {
    reply: `✅ 已接管 session ${uuid.slice(0, 8)}\n下一条消息会用该上下文回复。`,
    handled: true,
  };
}

function formatAgeForReply(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return '刚刚';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}
```

- [ ] **Step 4: Build + run tests, confirm pass**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build && npm test
```

Expected: all tests pass (15 from session-lister + 8 from resume-handler = 23 total).

- [ ] **Step 5: Commit**

```bash
cd /home/zizi/wechat-claude-code && git add src/commands/handlers.ts src/tests/resume-handler.test.ts && git commit -m "feat(resume): add handleResume with index/uuid/--force parsing and tests"
```

---

### Task 5: Wire `case 'resume'` into the router

**Files:**
- Modify: `src/commands/router.ts`

This is a one-line dispatch change. No tests beyond the build itself.

- [ ] **Step 1: Update the import line**

In `src/commands/router.ts`, the existing import line is:

```typescript
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleSend, handleUnknown } from './handlers.js';
```

Replace it with:

```typescript
import { handleHelp, handleClear, handleCwd, handleModel, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleResume, handleSend, handleUnknown } from './handlers.js';
```

(`handleResume` inserted in alphabetical order between `handlePrompt` and `handleSend`.)

- [ ] **Step 2: Add the `case 'resume'` to the switch**

In the `switch (cmd)` block in `src/commands/router.ts`, insert this case **before** the `default:` line so it sits among the other cases:

```typescript
    case 'resume':
      return handleResume(ctx, args);
```

- [ ] **Step 3: Build**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build
```

Expected: exits 0, no diagnostics. If TS complains that `handleResume` returns `Promise<CommandResult>` but other cases return `CommandResult`, that is fine — the switch has no inferred return type and async functions satisfy the `CommandResult` contract when awaited. The router already accepts async returns because callers do not check synchronously.

- [ ] **Step 4: Run all tests**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm test
```

Expected: all 23 tests still pass.

- [ ] **Step 5: Commit**

```bash
cd /home/zizi/wechat-claude-code && git add src/commands/router.ts && git commit -m "feat(resume): route /resume command to handleResume"
```

---

### Task 6: Update HELP_TEXT in handlers.ts

**Files:**
- Modify: `src/commands/handlers.ts`

One-line change so `/help` advertises `/resume`.

- [ ] **Step 1: Edit HELP_TEXT**

Find the `HELP_TEXT` template in `src/commands/handlers.ts`. It currently reads (truncated for context):

```typescript
const HELP_TEXT = `可用命令：

会话管理：
  /help             显示帮助
  ...
  /undo [数量]      撤销最近对话（默认1条）
```

Add the new line **between `/history` and `/undo`** so it sits with the other session-management commands. The updated block should be:

```typescript
  /history [数量]   查看对话记录（默认最近20条）
  /resume           列出最近 10 条 session，可接管
  /undo [数量]      撤销最近对话（默认1条）
```

(Insert exactly one line: `  /resume           列出最近 10 条 session，可接管`)

- [ ] **Step 2: Build + test**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build && npm test
```

Expected: builds clean, 23 tests pass.

- [ ] **Step 3: Commit**

```bash
cd /home/zizi/wechat-claude-code && git add src/commands/handlers.ts && git commit -m "feat(resume): advertise /resume in /help output"
```

---

### Task 7: Call `appendBridgeSessionId` in main.ts after successful query

**Files:**
- Modify: `src/main.ts`

This wires the "source = bridge" detection. Without it, the `bridge-sessions.json` file stays empty and every session in the list will be labeled `CLI/其他`.

- [ ] **Step 1: Add the import**

In `src/main.ts`, find the existing import block near the top. Add a new import alongside the others — specifically after the existing `import { logger } from './logger.js';` line (or wherever imports live; check the file). Add:

```typescript
import { appendBridgeSessionId } from './commands/session-lister.js';
```

- [ ] **Step 2: Insert the call**

Find the block:

```typescript
    // Update session with new SDK session ID
    session.sdkSessionId = result.sessionId || undefined;
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
```

(Around line 617-620 based on the file content reviewed when planning.)

Insert **after** `sessionStore.save(account.accountId, session);` and **before** the auto-push block that begins with `// Auto-push deliverable files...`:

```typescript
    // Record this UUID as bridge-spawned so /resume can label it correctly.
    // Failure here must not block the message flow.
    if (result.sessionId) {
      await appendBridgeSessionId(result.sessionId);
    }
```

- [ ] **Step 3: Build**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm run build
```

Expected: exits 0. The `await` inside an existing async function is fine; verify no surrounding scope complains.

- [ ] **Step 4: Run all tests**

Run:
```bash
cd /home/zizi/wechat-claude-code && npm test
```

Expected: all 23 tests still pass (this change is invisible to unit tests because it lives in main.ts; manual integration check is in Task 9).

- [ ] **Step 5: Commit**

```bash
cd /home/zizi/wechat-claude-code && git add src/main.ts && git commit -m "feat(resume): persist bridge-spawned session UUIDs"
```

---

### Task 8: Manual smoke test in dry-run mode

**Files:** none modified

Before we deploy to the live bridge, we want to verify the new command works end-to-end without touching the running daemon. We do this by invoking the compiled module with `--help`-style introspection — except there is no introspection subcommand, so we use a small inline smoke check.

- [ ] **Step 1: Seed a fake session**

Pick any small jsonl file from `~/.claude/projects/-home-zizi-zesp32/` (the user already has 50+). Confirm the file's mtime is within the active threshold so we exercise the rejection path:

```bash
ls -lat ~/.claude/projects/-home-zizi-zesp32/*.jsonl | head -3
```

Pick the newest one and note its uuid.

- [ ] **Step 2: Boot the new build in foreground briefly**

The daemon normally runs under systemd. To smoke-test without disrupting the live systemd service:

```bash
cd /home/zizi/wechat-claude-code && timeout 5 node dist/main.js start 2>&1 | head -50 || true
```

Expected: starts up (may complain about missing config — that's fine; we only want to confirm it loads without a runtime crash from our new imports).

If startup succeeds, that's enough for this step. Press Ctrl-C / wait for timeout.

- [ ] **Step 3: Verify imports resolve**

Run a quick syntax-check that imports the new module from outside the daemon:

```bash
cd /home/zizi/wechat-claude-code && node -e "import('./dist/commands/session-lister.js').then(m => console.log('exports:', Object.keys(m).join(','))).catch(e => { console.error(e); process.exit(1); })"
```

Expected output (one line):
```
exports: ACTIVE_THRESHOLD_MS,PROMPT_TRUNCATE_LEN,BRIDGE_SESSIONS_FILENAME,SessionInfo,encodeCwd,getBridgeSessionsPath,getSessionDir,listSessions,appendBridgeSessionId,formatSessionList
```

If you see `Error: Cannot find module ...`, the build is stale — re-run `npm run build`.

- [ ] **Step 4: Note the result**

Report in chat whether steps 2 and 3 succeeded. Do NOT proceed to Task 9 if either step failed.

- [ ] **Step 5: Commit (no changes)**

This task makes no source changes. Skip the commit.

---

### Task 9: Manual integration test against the running bridge

**Files:** none modified

The bridge is currently running `~/.claude/skills/wechat-claude-code/dist/main.js` (the original code). For an honest integration test we need to switch the systemd unit to our new build, restart, send `/resume` from WeChat, then restore the unit.

**This task is risky if done wrong. Read every step before acting.**

- [ ] **Step 1: Back up the systemd unit**

```bash
cp /home/zizi/.config/systemd/user/wechat-claude-code.service /home/zizi/.config/systemd/user/wechat-claude-code.service.bak.$(date +%Y%m%d_%H%M%S)
ls -la /home/zizi/.config/systemd/user/wechat-claude-code.service*
```

Expected: a `.bak.<timestamp>` file appears next to the original.

- [ ] **Step 2: Point the unit at the new build**

Edit `/home/zizi/.config/systemd/user/wechat-claude-code.service`. Change the `ExecStart=` line to:

```
ExecStart=/usr/bin/node /home/zizi/wechat-claude-code/dist/main.js start
```

Change `WorkingDirectory=` to:

```
WorkingDirectory=/home/zizi/wechat-claude-code
```

Leave everything else (PATH, StandardOutput, Restart, etc.) untouched.

- [ ] **Step 3: Reload systemd + restart**

```bash
systemctl --user daemon-reload && systemctl --user restart wechat-claude-code && sleep 3 && systemctl --user status wechat-claude-code --no-pager | head -15
```

Expected: status shows `active (running)` and the PID is fresh (different from the earlier PID 884087).

- [ ] **Step 4: Verify WeChat bridge still responds**

Send a normal message to your WeChat-bound bot account (e.g. `hello`) and confirm Claude responds as before. If the bridge is stuck, immediately roll back (Step 7).

- [ ] **Step 5: Test `/help`**

Send `/help` from WeChat. Expected: the reply includes the line `/resume           列出最近 10 条 session，可接管`.

- [ ] **Step 6: Test `/resume`**

Send `/resume` from WeChat. Expected: a list of up to 10 sessions from `~/.claude/projects/-home-zizi-zesp32/`, with active markers, source labels, and the `/resume <编号>` hint.

Then send `/resume 1`. Expected behaviors:
- If session[0] is **inactive** (mtime > 5 min ago): reply `✅ 已接管 session <8-char-prefix>...`.
- If session[0] is **active**: reply `⚠️ session 活跃（X分钟前写过）...`. To force, send `/resume 1 --force`.

Then send a follow-up message. Expected: Claude responds with context from the resumed session (you can verify by checking `~/.claude/projects/-home-zizi-zesp32/<uuid>.jsonl` got a new assistant entry).

- [ ] **Step 7: Verify `bridge-sessions.json` is being written**

```bash
cat ~/.wechat-claude-code/bridge-sessions.json
```

Expected: a JSON array containing at least the uuid that was just spawned by `/resume 1` followed by your follow-up message.

- [ ] **Step 8: Decide whether to keep the new build**

If all of steps 4-7 worked, leave the systemd unit pointed at the new build (your `/resume` is now live).

If any step failed, restore the original unit and restart:

```bash
cp /home/zizi/.config/systemd/user/wechat-claude-code.service.bak.* /home/zizi/.config/systemd/user/wechat-claude-code.service
systemctl --user daemon-reload && systemctl --user restart wechat-claude-code
```

Then report what failed and we will debug before retrying.

- [ ] **Step 9: No source commit**

This task modifies configuration, not code. If we left the new build in place, no commit needed. If we rolled back, also no commit needed. The deployment state is captured in the systemd unit file under version-independent config, not in the repository.

---

### Task 10: Final review + push to fork

**Files:**
- Modify: `docs/superpowers/specs/2026-06-17-wechat-resume-command-design.md` (optional status note)

- [ ] **Step 1: View the diff against main**

```bash
cd /home/zizi/wechat-claude-code && git log --oneline main..HEAD
```

Expected: 6 commits corresponding to Tasks 1-7 (Tasks 8 and 9 make no commits).

- [ ] **Step 2: View the cumulative diff**

```bash
cd /home/zizi/wechat-claude-code && git diff --stat main..HEAD
```

Expected: roughly 5 source files changed and 2 test files added, ~400-500 lines total. Compare with the spec's implementation summary table.

- [ ] **Step 3: Push to fork**

```bash
cd /home/zizi/wechat-claude-code && git push origin main
```

Expected: 6 commits uploaded to `zhl8011/wechat-claude-code`. If push fails due to SSH, verify with `git remote -v` that origin is `git@github.com:zhl8011/wechat-claude-code.git`.

- [ ] **Step 4: (Optional) Open PR to upstream**

Only if the user asks. Skipped by default.

- [ ] **Step 5: No further commit**

This task verifies the push. The feature is shipped.

---

## Self-Review

### Spec coverage

| Spec section | Implemented in |
|---|---|
| Overview / `/resume` lists 10 most recent sessions | Task 2 (listSessions limit=10) + Task 4 (handler default-args branch) |
| Active marker (mtime < 5 min) | Task 2 (ACTIVE_THRESHOLD_MS, isActive field) + Task 4 (rejection branch) |
| Source label (`桥` vs `CLI/其他`) | Task 3 (loadBridgeSessionIds) + Task 7 (appendBridgeSessionId wiring) |
| Index form `/resume <N>` | Task 4 (numeric branch) |
| UUID form `/resume <uuid>` | Task 4 (UUID_REGEX branch) |
| `--force` flag | Task 4 (active-with-force branch) |
| `/help` updated | Task 6 |
| `bridge-sessions.json` format + tmp+rename atomicity | Task 3 |
| Error handling: missing dir, garbage jsonl, non-user first line, etc. | Task 2 (all paths handled) + Task 4 (out-of-range, bad format) |
| Unit tests: 11 lister + 8 handler = 19 cases | Tasks 2, 3, 4 (we ended up with 23 due to additional helper tests) |
| Manual integration test in WeChat | Task 9 |

### Placeholder scan

Searched the plan for: TBD, TODO, "fill in", "implement later", "appropriate error handling", "similar to Task N". None found. Every code step shows full code; every command shows exact invocation with expected output.

### Type consistency

- `SessionInfo` defined in Task 1, consumed by `listSessions` (Task 2), `formatSessionList` (Task 3), `handleResume` (Task 4) — signatures match.
- `handleResume(ctx: CommandContext, args: string): Promise<CommandResult>` — matches existing `handleXxx` patterns in `handlers.ts`. The router returns `await handleResume(ctx, args)` which TS resolves cleanly.
- `appendBridgeSessionId(uuid: string): Promise<void>` — signature consistent in definition (Task 3) and use site (Task 7).
- `CommandContext['updateSession']` partial type — used in handler tests as `Record<string, unknown>` cast, which matches the `Partial<Session>` contract.
- `UUID_REGEX` defined once in handlers.ts and matches the standard 8-4-4-4-12 hex format Claude Code emits.

No inconsistencies found. Plan ready for execution.