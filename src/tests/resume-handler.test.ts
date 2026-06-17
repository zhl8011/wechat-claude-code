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