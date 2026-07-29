/**
 * The SDK and the manager, working together against a real sandboxed process.
 *
 * The module here is written the way a real module author writes one — `defineModule` from
 * @tessel/sdk — and is bundled by the real bundler before being run. So this covers the whole
 * path: author source → esbuild bundle → sandbox → IPC → permission check → SQLite → back.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TesselStore } from '@tessel/db';
import { Supervisor } from '@tessel/sandbox-runtime';
import { bundleModule } from '@tessel/installer';
import { ModuleManager } from './manager.ts';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const MODULE = 'com.github.someone.counter';
const USER = '333333333333333333';

/** A module author's actual source. */
const MODULE_SOURCE = `
import { defineModule } from '@tessel/sdk';

export default defineModule({
  commands: {
    async count(ctx) {
      const current = Number((await ctx.storage.get('count')) ?? '0') + 1;
      await ctx.storage.set('count', String(current));
      ctx.reply('count is ' + current + ' in ' + ctx.guildId);
    },
    async peek(ctx) {
      ctx.reply('stored: ' + ((await ctx.storage.get('count')) ?? 'nothing'));
    },
  },
});
`;

function manifestFor(permissions: string[]) {
  return {
    id: MODULE,
    name: 'Counter',
    version: '1.0.0',
    apiVersion: '1' as const,
    description: 'Counts things per server.',
    author: 'someone',
    entry: 'src/index.ts',
    permissions,
    network: [],
    commands: [
      { name: 'count', description: 'Increment the counter', options: [] },
      { name: 'peek', description: 'Read the counter', options: [] },
    ],
    storage: { quotaKb: 512 },
  };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(permissions = ['storage']) {
  const sourceDir = await mkdtemp(join(tmpdir(), 'tessel-sdk-src-'));
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, 'src', 'index.ts'), MODULE_SOURCE, 'utf8');

  const bundle = await bundleModule(sourceDir, 'src/index.ts');
  if (!bundle.ok) throw new Error(`fixture failed to bundle: ${bundle.errors.join('; ')}`);

  const bundleDir = await mkdtemp(join(tmpdir(), 'tessel-sdk-run-'));
  const store = new TesselStore(':memory:');
  const supervisor = new Supervisor({ heartbeatIntervalMs: 500, heartbeatTimeoutMs: 2000 });
  const manager = new ModuleManager({ store, supervisor, bundleDir, rpcTimeoutMs: 8000 });

  cleanups.push(async () => {
    await supervisor.stopAll();
    store.close();
    await rm(sourceDir, { recursive: true, force: true });
    await rm(bundleDir, { recursive: true, force: true });
  });

  await manager.saveArtifact({
    moduleId: MODULE,
    version: '1.0.0',
    commitSha: 'a'.repeat(40),
    bundleSha256: bundle.sha256,
    trust: 'unsigned',
    manifest: manifestFor(permissions),
    bundleCode: bundle.code,
  });

  async function enable(guildId: string) {
    await manager.enable({
      guildId,
      moduleId: MODULE,
      version: '1.0.0',
      grantedPermissions: permissions,
      installedBy: USER,
    });
  }

  return { manager, store, enable };
}

function run(manager: ModuleManager, guildId: string, command: string) {
  return manager.dispatchCommand({ guildId, command, userId: USER, options: {} });
}

describe('a module written with the SDK', () => {
  test('bundles and runs', async () => {
    const { manager, enable } = await setup();
    await enable(GUILD_A);

    const result = await run(manager, GUILD_A, 'count');

    expect(result.ok && result.content).toBe(`count is 1 in ${GUILD_A}`);
  });

  test('keeps its stored data between calls', async () => {
    const { manager, enable } = await setup();
    await enable(GUILD_A);

    await run(manager, GUILD_A, 'count');
    await run(manager, GUILD_A, 'count');
    const result = await run(manager, GUILD_A, 'peek');

    expect(result.ok && result.content).toBe('stored: 2');
  });

  // The same module, the same process, two servers — and neither can see the other's data.
  test('keeps each server’s data separate', async () => {
    const { manager, enable } = await setup();
    await enable(GUILD_A);
    await enable(GUILD_B);

    await run(manager, GUILD_A, 'count');
    await run(manager, GUILD_A, 'count');
    await run(manager, GUILD_B, 'count');

    const inA = await run(manager, GUILD_A, 'peek');
    const inB = await run(manager, GUILD_B, 'peek');

    expect(inA.ok && inA.content).toBe('stored: 2');
    expect(inB.ok && inB.content).toBe('stored: 1');
  });

  test('is told which guild it is acting for', async () => {
    const { manager, enable } = await setup();
    await enable(GUILD_B);

    const result = await run(manager, GUILD_B, 'count');

    expect(result.ok && result.content).toContain(GUILD_B);
  });
});

describe('permission enforcement', () => {
  test("refuses storage when the 'storage' permission was not granted", async () => {
    const { manager, enable } = await setup(['messages.send']);
    await enable(GUILD_A);

    const result = await run(manager, GUILD_A, 'count');

    expect(result.ok && result.content).toMatch(/failed|not granted/i);
  });

  test('records the refusal in the audit log', async () => {
    const { manager, store, enable } = await setup(['messages.send']);
    await enable(GUILD_A);

    await run(manager, GUILD_A, 'count');

    expect(store.recentAudit(GUILD_A).some((row) => row.outcome === 'denied')).toBe(true);
  });
});
