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
    // Mimic real Claude Code: last-prompt metadata prefix + user-typed
    // entrypoint=cli, promptSource=typed so the lister picks this row.
    const lines = [
      JSON.stringify({ type: 'last-prompt' }),
      JSON.stringify({
        type: 'user',
        entrypoint: 'cli',
        promptSource: 'typed',
        message: { role: 'user', content: s.prompt ?? '' },
      }),
    ];
    await fs.writeFile(path, lines.join('\n') + '\n');
    const t = new Date(Date.now() - s.mtimeAgoMs);
    await fs.utimes(path, t, t);
  }
}

async function cleanup(cwd: string): Promise<void> {
  await fs.rm(getSessionDir(cwd), { recursive: true, force: true });
}

test('handleResume: empty args returns list reply, handled=true', async () => {
  const cwd = uniqueCwd('list');
  await seed(cwd, [{ uuid: 'a', mtimeAgoMs: 10 * 60_000, prompt: 'hi' }]); // 10 min ago → inactive
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

test('handleResume: numeric index resumes inactive session', async () => {
  const cwd = uniqueCwd('idx');
  await seed(cwd, [
    { uuid: 'first', mtimeAgoMs: 10 * 60_000, prompt: 'first' },   // 10 min ago → index 1
    { uuid: 'second', mtimeAgoMs: 20 * 60_000, prompt: 'second' }, // 20 min ago → index 2
  ]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
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
  await seed(cwd, [{ uuid: 'a', mtimeAgoMs: 10 * 60_000, prompt: 'p' }]);
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

test('handleResume: full UUID form resumes inactive session', async () => {
  const cwd = uniqueCwd('uuid');
  // Use a real-looking UUID format so it passes UUID_REGEX
  const realUuid = '12345678-1234-1234-1234-123456789abc';
  await seed(cwd, [
    { uuid: realUuid, mtimeAgoMs: 10 * 60_000, prompt: 'real' },
  ]);
  const captured: CapturedUpdate = { calls: [] };
  const ctx = makeCtx(cwd, captured);
  try {
    const r = await handleResume(ctx, realUuid);
    assert.equal(r.handled, true);
    assert.equal(captured.calls.length, 1);
    assert.equal(captured.calls[0].sdkSessionId, realUuid);
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
