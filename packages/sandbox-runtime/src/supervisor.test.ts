/**
 * The supervisor keeps a badly-behaved module from taking the bot down with it.
 *
 * Like the sandbox tests, these run real child processes: a module that "crashes" here
 * actually exits, and a module that "hangs" actually stops answering. Timings are injected
 * so the suite stays fast without pretending time passes.
 */
import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Supervisor } from './supervisor.ts';

const tempDirs: string[] = [];
const supervisors: Supervisor[] = [];

/** A module that answers heartbeats and otherwise sits there quietly. */
const HEALTHY = `
  __tessel.onMessage((message) => {
    if (message && message.type === 'ping') __tessel.send({ type: 'pong', id: message.id });
  });
  __tessel.send({ type: 'ready' });
`;

/** A module that dies immediately after starting. */
const CRASHES = `
  __tessel.send({ type: 'ready' });
  process.exit(1);
`;

/** A module that starts fine and then stops answering heartbeats forever. */
const HANGS = `
  __tessel.send({ type: 'ready' });
  setInterval(() => {}, 1000);
`;

const FAST_TIMINGS = {
  heartbeatIntervalMs: 80,
  heartbeatTimeoutMs: 200,
  backoffBaseMs: 10,
  maxRestarts: 3,
  restartWindowMs: 10_000,
};

async function writeBundle(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessel-supervised-'));
  tempDirs.push(dir);
  const bundlePath = join(dir, 'bundle.mjs');
  await writeFile(bundlePath, source, 'utf8');
  return bundlePath;
}

function makeSupervisor(overrides: Partial<typeof FAST_TIMINGS> = {}): Supervisor {
  const supervisor = new Supervisor({ ...FAST_TIMINGS, ...overrides });
  supervisors.push(supervisor);
  return supervisor;
}

/** Polls until `predicate` holds, so tests never depend on a fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Condition was never met within the timeout.');
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stopAll()));
});

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('running modules', () => {
  test('reports a started module as running', async () => {
    const supervisor = makeSupervisor();

    await supervisor.start({ moduleId: 'healthy', bundlePath: await writeBundle(HEALTHY) });

    expect(supervisor.isRunning('healthy')).toBe(true);
  });

  test('leaves a healthy module alone', async () => {
    const supervisor = makeSupervisor();
    await supervisor.start({ moduleId: 'healthy', bundlePath: await writeBundle(HEALTHY) });

    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(supervisor.restartCount('healthy')).toBe(0);
    expect(supervisor.isRunning('healthy')).toBe(true);
  });
});

describe('crash recovery', () => {
  test('restarts a module that exits unexpectedly', async () => {
    const supervisor = makeSupervisor();

    await supervisor.start({ moduleId: 'crasher', bundlePath: await writeBundle(CRASHES) });

    await waitFor(() => supervisor.restartCount('crasher') >= 1);
  });

  test('auto-disables a module that keeps crashing', async () => {
    const supervisor = makeSupervisor();
    const disabled: string[] = [];
    supervisor.onAutoDisabled((moduleId) => disabled.push(moduleId));

    await supervisor.start({ moduleId: 'crasher', bundlePath: await writeBundle(CRASHES) });

    await waitFor(() => disabled.includes('crasher'));
    expect(supervisor.isRunning('crasher')).toBe(false);
  });

  test('stops restarting once a module is auto-disabled', async () => {
    const supervisor = makeSupervisor();
    const disabled: string[] = [];
    supervisor.onAutoDisabled((moduleId) => disabled.push(moduleId));
    await supervisor.start({ moduleId: 'crasher', bundlePath: await writeBundle(CRASHES) });
    await waitFor(() => disabled.includes('crasher'));

    const settled = supervisor.restartCount('crasher');
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(supervisor.restartCount('crasher')).toBe(settled);
  });

  test('reports why a module was auto-disabled', async () => {
    const supervisor = makeSupervisor();
    const reasons: string[] = [];
    supervisor.onAutoDisabled((_moduleId, reason) => reasons.push(reason));

    await supervisor.start({ moduleId: 'crasher', bundlePath: await writeBundle(CRASHES) });

    await waitFor(() => reasons.length > 0);
    expect(reasons[0]).toMatch(/crash/i);
  });
});

describe('heartbeat', () => {
  test('restarts a module that stops answering heartbeats', async () => {
    const supervisor = makeSupervisor();

    await supervisor.start({ moduleId: 'hanger', bundlePath: await writeBundle(HANGS) });

    await waitFor(() => supervisor.restartCount('hanger') >= 1);
  });
});

describe('explicit stop', () => {
  test('does not restart a module that was deliberately stopped', async () => {
    const supervisor = makeSupervisor();
    await supervisor.start({ moduleId: 'healthy', bundlePath: await writeBundle(HEALTHY) });

    await supervisor.stop('healthy');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(supervisor.isRunning('healthy')).toBe(false);
    expect(supervisor.restartCount('healthy')).toBe(0);
  });
});
