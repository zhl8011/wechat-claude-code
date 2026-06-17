import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVE_THRESHOLD_MS,
  appendBridgeSessionId,
  encodeCwd,
  formatSessionList,
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
