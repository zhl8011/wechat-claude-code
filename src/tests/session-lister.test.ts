import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
    contentAsArray?: boolean;
    entrypoint?: 'cli' | 'sdk-py' | 'sdk-cli';
    promptSource?: 'typed' | 'sdk';
    agentName?: string;
    aiTitle?: string;
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
      // Mimic real Claude Code jsonl layout:
      //   line 1: { type: "last-prompt", ... }
      //   line 2: { type: "mode", ... }
      //   line 3: { type: "permission-mode", ... }
      //   line 4..N: { type: "user", message: { content: <string|array> } }
      // message.content is a plain string for normal text prompts and an
      // array of {type, text} parts only for tool_result / image attachments.
      // entrypoint + promptSource mark whether the user actually typed the
      // prompt vs the SDK / a skill injecting it.
      // agent-name + ai-title appear as separate events in the jsonl and
      // win over the first user prompt when present.
      const lines: string[] = [
        JSON.stringify({ type: 'last-prompt' }),
        JSON.stringify({ type: 'mode' }),
        JSON.stringify({ type: 'permission-mode' }),
      ];
      if (s.agentName) {
        lines.push(JSON.stringify({ type: 'agent-name', agentName: s.agentName }));
      }
      if (s.aiTitle) {
        lines.push(JSON.stringify({ type: 'ai-title', aiTitle: s.aiTitle }));
      }
      const userContent = s.contentAsArray
        ? [{ type: 'text', text: s.prompt ?? '' }]
        : (s.prompt ?? '');
      const userLine: Record<string, unknown> = {
        type: s.role === 'system' ? 'system' : 'user',
        message: { role: s.role ?? 'user', content: userContent },
      };
      // Default: real terminal user. Tests covering skill-injected sessions
      // override with `entrypoint: 'sdk-py'`, `promptSource: 'sdk'`, etc.
      userLine.entrypoint = s.entrypoint ?? 'cli';
      userLine.promptSource = s.promptSource ?? 'typed';
      lines.push(JSON.stringify(userLine));
      content = lines.join('\n') + '\n';
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

test('listSessions: marks isActive when uuid is in bridge-sessions.json', async () => {
  // isActive is no longer driven by jsonl mtime (the bridge itself writes to
  // the jsonl on every send, so a fresh mtime does not mean "CLI is using
  // it" — it could just be a session we ourselves just messaged). Instead,
  // isActive = "the bridge owns this uuid" (i.e. it appears in
  // bridge-sessions.json). CLI-only sessions (not in the bridge set) are
  // never active, so /resume from WeChat never blocks on them.
  const cwd = uniqueCwd('active');
  await seedSessions(cwd, [
    { uuid: 'bridge-owned', mtimeAgoMs: 60_000, prompt: 'p' },
    { uuid: 'cli-only', mtimeAgoMs: 60_000, prompt: 'p' },
  ]);
  // Register exactly one of the two uuids in the bridge set.
  try {
    await appendBridgeSessionId('bridge-owned');
    const r = await listSessions(cwd);
    const owned = r.find((s) => s.uuid === 'bridge-owned')!;
    const cliOnly = r.find((s) => s.uuid === 'cli-only')!;
    assert.equal(owned.isActive, true);
    assert.equal(cliOnly.isActive, false);
  } finally {
    await removeSentinel('bridge-owned');
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

test('listSessions: extracts user prompt after metadata prefix lines (real Claude Code layout)', async () => {
  // Real Claude Code jsonl starts with type=last-prompt, mode, permission-mode,
  // attachment entries BEFORE the first type=user row. The lister must skip
  // these and find the actual user message.
  const cwd = uniqueCwd('reallayout');
  const dir = getSessionDir(cwd);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, 'real.jsonl');
  const lines = [
    JSON.stringify({ type: 'last-prompt', sessionId: 'real' }),
    JSON.stringify({ type: 'mode' }),
    JSON.stringify({ type: 'permission-mode' }),
    JSON.stringify({ type: 'attachment' }),
    JSON.stringify({ type: 'attachment' }),
    JSON.stringify({ type: 'attachment' }),
    JSON.stringify({
      type: 'user',
      entrypoint: 'cli',
      promptSource: 'typed',
      message: { role: 'user', content: '现在我们整理几个工作' },
    }),
  ];
  await fs.writeFile(path, lines.join('\n') + '\n');
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 1);
    assert.equal(r[0].firstUserPrompt, '现在我们整理几个工作');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: extracts user prompt from content array (attachment / tool_result shape)', async () => {
  // When the user message carries image attachments or tool_result blocks,
  // message.content is an array of typed parts and we pick the text part.
  const cwd = uniqueCwd('arraycontent');
  await seedSessions(cwd, [
    { uuid: 'arr', mtimeAgoMs: 0, prompt: '看这张图', contentAsArray: true },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r[0].firstUserPrompt, '看这张图');
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

test('listSessions: skips session where every user line is entrypoint=sdk-py', async () => {
  // entrypoint 'sdk-py' is the code-review skill's marker. Sessions that
  // contain ONLY such rows (no user-typed turn at all) should be dropped
  // from the list — the user can't usefully resume a conversation they
  // never spoke in.
  const cwd = uniqueCwd('skillonly');
  await seedSessions(cwd, [
    { uuid: 'autorev', mtimeAgoMs: 0, prompt: 'Review this change for security vulnerabilities.', entrypoint: 'sdk-py', promptSource: 'sdk' },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 0);
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: keeps session with sdk-py row followed by cli user-typed one', async () => {
  // Real sessions often start with a code-review prompt (sdk-py row) and
  // then the user types a follow-up via cc (cli row). The lister should
  // keep the session — it has at least one user-typed turn — and display
  // the first user prompt as a fallback (matches cc /resume behaviour
  // when there's no agentName / aiTitle).
  const cwd = uniqueCwd('mixed');
  const path = join(getSessionDir(cwd), 'mixed.jsonl');
  await fs.mkdir(getSessionDir(cwd), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'last-prompt' }),
    JSON.stringify({ type: 'user', entrypoint: 'sdk-py', promptSource: 'sdk', message: { role: 'user', content: 'Review this change for security vulnerabilities.' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: '...review response...' } }),
    JSON.stringify({ type: 'user', entrypoint: 'cli', promptSource: 'typed', message: { role: 'user', content: '看一下 main.c 第 42 行' } }),
  ];
  await fs.writeFile(path, lines.join('\n') + '\n');
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 1);
    // First user prompt is shown when no title is set, even if that first
    // row was the skill-injected one.
    assert.equal(r[0].firstUserPrompt, 'Review this change for security vulnerabilities.');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: keeps <local-command-caveat> slash-command rows', async () => {
  // When the user runs /exit or /init in cc, the resulting user-typed row
  // starts with <local-command-caveat> or <command-message>. Those are real
  // user input (the user invoked the slash command) and should be listed.
  const cwd = uniqueCwd('slashcmd');
  const path = join(getSessionDir(cwd), 'exit.jsonl');
  await fs.mkdir(getSessionDir(cwd), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'last-prompt' }),
    JSON.stringify({
      type: 'user',
      entrypoint: 'cli',
      message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below were generated by the user while running local commands. DO NOT respond</local-command-caveat>\n<command-name>/exit</command-name>' },
    }),
  ];
  await fs.writeFile(path, lines.join('\n') + '\n');
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 1);
    assert.ok(r[0].firstUserPrompt.startsWith('<local-command-caveat>'));
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: prefers agentName over aiTitle and user prompt', async () => {
  // Mirrors cc's /resume ordering: user's --name wins.
  const cwd = uniqueCwd('agentname');
  await seedSessions(cwd, [
    {
      uuid: 'withall',
      mtimeAgoMs: 0,
      prompt: 'first user prompt text',
      agentName: 'my-named-session',
      aiTitle: 'cc auto title',
    },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r[0].firstUserPrompt, 'my-named-session');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: prefers aiTitle over first user prompt when no agentName', async () => {
  // cc's auto-generated title appears when the user didn't --name the session.
  const cwd = uniqueCwd('aititle');
  await seedSessions(cwd, [
    {
      uuid: 'withtitle',
      mtimeAgoMs: 0,
      prompt: 'first user prompt text',
      aiTitle: 'cc auto generated title',
    },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r[0].firstUserPrompt, 'cc auto generated title');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: falls back to first user prompt when no title is set', async () => {
  // Slash commands like /clear don't get an ai-title; the first user
  // prompt itself is the only label.
  const cwd = uniqueCwd('notitle');
  await seedSessions(cwd, [
    { uuid: 'plain', mtimeAgoMs: 0, prompt: '/clear' },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r[0].firstUserPrompt, '/clear');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: keeps SDK-user session (entrypoint=sdk-cli, promptSource=typed)', async () => {
  // A user typing through the SDK (e.g. claude-code-vscode or another
  // tool that uses the Agent SDK) is still a real user. promptSource='typed'
  // marks it as such, regardless of entrypoint.
  const cwd = uniqueCwd('sdkuser');
  await seedSessions(cwd, [
    { uuid: 'sdktyped', mtimeAgoMs: 0, prompt: 'vscode 编辑器发的消息', entrypoint: 'sdk-cli', promptSource: 'typed' },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 1);
    assert.equal(r[0].firstUserPrompt, 'vscode 编辑器发的消息');
  } finally {
    await cleanupCwd(cwd);
  }
});

test('listSessions: lists jsonl with no user prompt and no title as (empty)', async () => {
  // The lister keeps sessions that have at least one user-typed turn,
  // even when both the title fields and the first text content are empty
  // (e.g. an image-only prompt). The display label falls back to "(empty)".
  const cwd = uniqueCwd('emptycontent');
  await seedSessions(cwd, [
    { uuid: 'empty', mtimeAgoMs: 0, prompt: '' },
  ]);
  try {
    const r = await listSessions(cwd);
    assert.equal(r.length, 1);
    assert.equal(r[0].firstUserPrompt, '(empty)');
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
