/**
 * The module manager: where per-guild isolation and the no-restart guarantee become
 * observable behaviour rather than architecture.
 *
 * These tests run real sandboxed child processes against a real SQLite store. A module that
 * "responds to a command" here genuinely receives IPC in a locked-down process and answers.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TesselStore } from '@tessel/db';
import { Supervisor } from '@tessel/sandbox-runtime';
import { ModuleManager } from './manager.ts';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const MODULE = 'com.github.someone.greeter';
const USER = '333333333333333333';

/** A module that answers heartbeats and echoes back which guild a command ran for. */
const GREETER_BUNDLE = `
  __tessel.onMessage((message) => {
    if (message.type === 'ping') {
      __tessel.send({ type: 'pong', id: message.id });
      return;
    }
    if (message.type === 'command') {
      __tessel.send({
        type: 'response',
        id: message.id,
        ok: true,
        content: 'ran ' + message.command + ' for ' + message.guildId,
      });
    }
  });
  __tessel.send({ type: 'ready' });
`;

const MANIFEST = {
  id: MODULE,
  name: 'Greeter',
  version: '1.0.0',
  apiVersion: '1' as const,
  description: 'Says hello.',
  author: 'someone',
  entry: 'src/index.ts',
  permissions: ['messages.send'],
  network: [],
  commands: [{ name: 'greet', description: 'Say hello', options: [] }],
  storage: { quotaKb: 512 },
};

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function makeManager() {
  const dir = await mkdtemp(join(tmpdir(), 'tessel-manager-'));
  const store = new TesselStore(':memory:');
  const supervisor = new Supervisor({
    heartbeatIntervalMs: 500,
    heartbeatTimeoutMs: 2000,
    backoffBaseMs: 20,
  });
  const manager = new ModuleManager({ store, supervisor, bundleDir: dir, rpcTimeoutMs: 8000 });

  cleanups.push(async () => {
    await supervisor.stopAll();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  await manager.saveArtifact({
    moduleId: MODULE,
    version: '1.0.0',
    commitSha: 'a'.repeat(40),
    bundleSha256: 'b'.repeat(64),
    trust: 'unsigned',
    manifest: MANIFEST,
    bundleCode: GREETER_BUNDLE,
  });

  return { manager, store, supervisor };
}

async function enableIn(manager: ModuleManager, guildId: string) {
  return manager.enable({
    guildId,
    moduleId: MODULE,
    version: '1.0.0',
    grantedPermissions: ['messages.send'],
    installedBy: USER,
  });
}

describe('enabling and disabling', () => {
  test('enabling a module starts it', async () => {
    const { manager, supervisor } = await makeManager();

    await enableIn(manager, GUILD_A);

    expect(supervisor.isRunning(MODULE)).toBe(true);
  });

  test('enabling records it as enabled for that guild', async () => {
    const { manager, store } = await makeManager();

    await enableIn(manager, GUILD_A);

    expect(store.getGuildModule(GUILD_A, MODULE)?.enabled).toBe(true);
  });

  // One process serves every guild that enabled the module; guild scoping is enforced per
  // call, not by running a copy per server.
  test('enabling in a second guild reuses the same process', async () => {
    const { manager, supervisor } = await makeManager();
    await enableIn(manager, GUILD_A);
    const pidAfterFirst = supervisor.isRunning(MODULE);

    await enableIn(manager, GUILD_B);

    expect(pidAfterFirst).toBe(true);
    expect(supervisor.restartCount(MODULE)).toBe(0);
  });

  test('disabling one of two guilds keeps the module running for the other', async () => {
    const { manager, supervisor } = await makeManager();
    await enableIn(manager, GUILD_A);
    await enableIn(manager, GUILD_B);

    await manager.disable(GUILD_A, MODULE);

    expect(supervisor.isRunning(MODULE)).toBe(true);
  });

  test('disabling the last guild stops the process', async () => {
    const { manager, supervisor } = await makeManager();
    await enableIn(manager, GUILD_A);

    await manager.disable(GUILD_A, MODULE);

    expect(supervisor.isRunning(MODULE)).toBe(false);
  });

  test('refuses to enable a module that was never installed', async () => {
    const { manager } = await makeManager();

    const result = await manager.enable({
      guildId: GUILD_A,
      moduleId: 'com.nobody.nothing',
      version: '1.0.0',
      grantedPermissions: [],
      installedBy: USER,
    });

    expect(result.ok).toBe(false);
  });
});

describe('per-guild command visibility', () => {
  test('lists a module’s commands for the guild that enabled it', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    expect(manager.commandsForGuild(GUILD_A).map((c) => c.name)).toEqual(['greet']);
  });

  // The heart of the requirement: another server sees nothing at all.
  test('lists nothing for a guild that did not enable it', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    expect(manager.commandsForGuild(GUILD_B)).toEqual([]);
  });

  test('stops listing the command once disabled', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    await manager.disable(GUILD_A, MODULE);

    expect(manager.commandsForGuild(GUILD_A)).toEqual([]);
  });

  test('routes a command name to the module that declared it', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    expect(manager.moduleForCommand(GUILD_A, 'greet')).toBe(MODULE);
  });

  test('does not route a command for a guild where it is not enabled', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    expect(manager.moduleForCommand(GUILD_B, 'greet')).toBeNull();
  });
});

describe('dispatching to a module', () => {
  test('delivers a command and returns the response', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    const result = await manager.dispatchCommand({
      guildId: GUILD_A,
      command: 'greet',
      userId: USER,
      options: {},
    });

    expect(result.ok && result.content).toBe(`ran greet for ${GUILD_A}`);
  });

  test('tells the module which guild it is acting for', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);
    await enableIn(manager, GUILD_B);

    const result = await manager.dispatchCommand({
      guildId: GUILD_B,
      command: 'greet',
      userId: USER,
      options: {},
    });

    expect(result.ok && result.content).toContain(GUILD_B);
  });

  // A module cannot be reached from a server that never enabled it, even by name.
  test('refuses a command from a guild where the module is not enabled', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    const result = await manager.dispatchCommand({
      guildId: GUILD_B,
      command: 'greet',
      userId: USER,
      options: {},
    });

    expect(result.ok).toBe(false);
  });

  test('refuses an unknown command', async () => {
    const { manager } = await makeManager();
    await enableIn(manager, GUILD_A);

    const result = await manager.dispatchCommand({
      guildId: GUILD_A,
      command: 'nonexistent',
      userId: USER,
      options: {},
    });

    expect(result.ok).toBe(false);
  });
});

describe('auto-disable', () => {
  test('marks a module disabled in the store when the supervisor gives up on it', async () => {
    const { manager, store, supervisor } = await makeManager();
    await enableIn(manager, GUILD_A);

    // Simulate the supervisor exhausting its restart budget.
    await manager.handleAutoDisabled(MODULE, 'Module crashed 4 times within 300s.');

    expect(store.getGuildModule(GUILD_A, MODULE)?.enabled).toBe(false);
    expect(supervisor.isRunning(MODULE)).toBe(false);
  });
});
