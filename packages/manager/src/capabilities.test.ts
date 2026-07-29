/**
 * The capability surface: Discord actions and guild events.
 *
 * Every module here is written with the real SDK and bundled by the real bundler, so what runs
 * is what a module author would ship. Discord itself is a recording fake — the point is to
 * prove core's permission and guild-scoping decisions, not discord.js.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TesselStore } from '@tessel/db';
import { Supervisor } from '@tessel/sandbox-runtime';
import { bundleModule } from '@tessel/installer';
import { ModuleManager } from './manager.ts';
import type { DiscordActions } from './actions.ts';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const MODULE = 'com.github.someone.tools';
const USER = '333333333333333333';

interface Recorded {
  op: string;
  guildId: string;
  args: unknown[];
}

function recordingDiscord(calls: Recorded[]): DiscordActions {
  const record = (op: string) => async (guildId: string, ...args: unknown[]) => {
    calls.push({ op, guildId, args });
  };

  return {
    sendMessage: record('sendMessage'),
    deleteMessage: record('deleteMessage'),
    timeoutMember: record('timeoutMember'),
    kickMember: record('kickMember'),
    banMember: record('banMember'),
    addRole: record('addRole'),
    removeRole: record('removeRole'),
  } as unknown as DiscordActions;
}

const MODULE_SOURCE = `
import { defineModule } from '@tessel/sdk';

export default defineModule({
  commands: {
    async announce(ctx) {
      await ctx.sendMessage('channel-1', 'hello from ' + ctx.guildId);
      ctx.reply('sent');
    },
    async punish(ctx) {
      await ctx.timeoutMember('victim-1', 60000, 'being tiresome');
      ctx.reply('timed out');
    },
    async nuke(ctx) {
      await ctx.banMember('victim-1', 'nope');
      ctx.reply('banned');
    },
  },
  events: {
    async memberJoin(ctx) {
      await ctx.sendMessage('welcome-1', 'welcome ' + ctx.member.username + ' to ' + ctx.guildId);
    },
    async messageCreate(ctx) {
      await ctx.storage.set('lastSeen', ctx.message.content);
    },
  },
});
`;

function manifestFor(permissions: string[]) {
  return {
    id: MODULE,
    name: 'Tools',
    version: '1.0.0',
    apiVersion: '1' as const,
    description: 'Exercises the capability surface.',
    author: 'someone',
    entry: 'src/index.ts',
    permissions,
    network: [],
    commands: [
      { name: 'announce', description: 'Send a message', options: [] },
      { name: 'punish', description: 'Time someone out', options: [] },
      { name: 'nuke', description: 'Ban someone', options: [] },
    ],
    storage: { quotaKb: 512 },
  };
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function setup(permissions: string[]) {
  const sourceDir = await mkdtemp(join(tmpdir(), 'tessel-cap-src-'));
  await mkdir(join(sourceDir, 'src'), { recursive: true });
  await writeFile(join(sourceDir, 'src', 'index.ts'), MODULE_SOURCE, 'utf8');

  const bundle = await bundleModule(sourceDir, 'src/index.ts');
  if (!bundle.ok) throw new Error(`fixture failed to bundle: ${bundle.errors.join('; ')}`);

  const bundleDir = await mkdtemp(join(tmpdir(), 'tessel-cap-run-'));
  const store = new TesselStore(':memory:');
  const supervisor = new Supervisor({ heartbeatIntervalMs: 500, heartbeatTimeoutMs: 2000 });
  const calls: Recorded[] = [];
  const manager = new ModuleManager({
    store,
    supervisor,
    bundleDir,
    rpcTimeoutMs: 8000,
    discord: recordingDiscord(calls),
  });

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

  const enable = async (guildId: string) => {
    await manager.enable({
      guildId,
      moduleId: MODULE,
      version: '1.0.0',
      grantedPermissions: permissions,
      installedBy: USER,
    });
  };

  return { manager, store, calls, enable };
}

const run = (manager: ModuleManager, guildId: string, command: string) =>
  manager.dispatchCommand({ guildId, command, userId: USER, options: {} });

/** Events are fire-and-forget, so tests poll rather than await a response. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Condition was never met.');
}

describe('discord actions', () => {
  test('a module can send a message when granted', async () => {
    const { manager, calls, enable } = await setup(['messages.send']);
    await enable(GUILD_A);

    const result = await run(manager, GUILD_A, 'announce');

    expect(result.ok && result.content).toBe('sent');
    expect(calls[0]?.op).toBe('sendMessage');
  });

  // The guild core acts on comes from the call, never from anything the module said.
  test('the action is performed against the calling guild', async () => {
    const { manager, calls, enable } = await setup(['messages.send']);
    await enable(GUILD_A);
    await enable(GUILD_B);

    await run(manager, GUILD_B, 'announce');

    expect(calls[0]?.guildId).toBe(GUILD_B);
  });

  test('a module can time a member out when granted', async () => {
    const { manager, calls, enable } = await setup(['members.moderate']);
    await enable(GUILD_A);

    await run(manager, GUILD_A, 'punish');

    expect(calls[0]?.op).toBe('timeoutMember');
  });
});

describe('permission enforcement', () => {
  test('refuses to send a message without messages.send', async () => {
    const { manager, calls, enable } = await setup(['storage']);
    await enable(GUILD_A);

    const result = await run(manager, GUILD_A, 'announce');

    expect(calls).toEqual([]);
    expect(result.ok && result.content).toMatch(/failed|not granted/i);
  });

  // Timing out and banning are separate permissions; holding one must not imply the other.
  test('members.moderate does not grant the ability to ban', async () => {
    const { manager, calls, enable } = await setup(['members.moderate']);
    await enable(GUILD_A);

    await run(manager, GUILD_A, 'nuke');

    expect(calls.filter((call) => call.op === 'banMember')).toEqual([]);
  });

  test('records the refusal in the audit log', async () => {
    const { manager, store, enable } = await setup(['storage']);
    await enable(GUILD_A);

    await run(manager, GUILD_A, 'announce');

    expect(store.recentAudit(GUILD_A).some((row) => row.outcome === 'denied')).toBe(true);
  });
});

describe('events', () => {
  test('delivers memberJoin to a module holding events.guild', async () => {
    const { manager, calls, enable } = await setup(['events.guild', 'messages.send']);
    await enable(GUILD_A);

    manager.dispatchEvent(GUILD_A, 'memberJoin', {
      member: { id: 'new-1', username: 'newbie', displayName: 'newbie', bot: false, createdAt: 0 },
      memberCount: 42,
    });

    await waitFor(() => calls.length > 0);
    expect(String(calls[0]?.args[1])).toContain('newbie');
  });

  // Not "receives it and ignores it" — it is never sent the event at all.
  test('does not deliver memberJoin without events.guild', async () => {
    const { manager, calls, enable } = await setup(['messages.send']);
    await enable(GUILD_A);

    manager.dispatchEvent(GUILD_A, 'memberJoin', {
      member: { id: 'new-1', username: 'newbie', displayName: 'newbie', bot: false, createdAt: 0 },
      memberCount: 42,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(calls).toEqual([]);
  });

  test('does not deliver messageCreate without messages.read', async () => {
    const { manager, store, enable } = await setup(['storage']);
    await enable(GUILD_A);

    manager.dispatchEvent(GUILD_A, 'messageCreate', {
      message: { id: 'm1', channelId: 'c1', content: 'secret', author: {} },
    });

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(store.kvGet(GUILD_A, MODULE, 'lastSeen')).toBeNull();
  });

  test('does not deliver an event to a guild where the module is disabled', async () => {
    const { manager, calls, enable } = await setup(['events.guild', 'messages.send']);
    await enable(GUILD_A);

    manager.dispatchEvent(GUILD_B, 'memberJoin', {
      member: { id: 'new-1', username: 'newbie', displayName: 'newbie', bot: false, createdAt: 0 },
      memberCount: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(calls).toEqual([]);
  });

  test('an event action is scoped to the guild the event came from', async () => {
    const { manager, calls, enable } = await setup(['events.guild', 'messages.send']);
    await enable(GUILD_A);
    await enable(GUILD_B);

    manager.dispatchEvent(GUILD_B, 'memberJoin', {
      member: { id: 'new-1', username: 'newbie', displayName: 'newbie', bot: false, createdAt: 0 },
      memberCount: 1,
    });

    await waitFor(() => calls.length > 0);
    expect(calls[0]?.guildId).toBe(GUILD_B);
  });
});
