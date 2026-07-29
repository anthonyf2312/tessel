/**
 * Per-guild state. These tests are where "a module enabled in one server is invisible in
 * every other" stops being a claim and becomes a property.
 *
 * Every test runs against a real in-memory SQLite database — same schema, same SQL, same
 * constraints as production, just not on disk.
 */
import { describe, expect, test } from 'vitest';
import { TesselStore } from './store.ts';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const MODULE = 'com.github.someone.moderation';
const USER = '333333333333333333';

const ARTIFACT = {
  moduleId: MODULE,
  version: '1.0.0',
  commitSha: 'a'.repeat(40),
  bundleSha256: 'b'.repeat(64),
  trust: 'unsigned' as const,
  manifestJson: JSON.stringify({ id: MODULE, name: 'Moderation' }),
};

function freshStore(): TesselStore {
  const store = new TesselStore(':memory:');
  store.saveArtifact(ARTIFACT);
  return store;
}

function installIn(store: TesselStore, guildId: string, permissions = ['messages.read']) {
  store.installForGuild({
    guildId,
    moduleId: MODULE,
    version: '1.0.0',
    installedBy: USER,
    grantedPermissions: permissions,
  });
}

describe('artifacts', () => {
  test('stores and reads back an artifact', () => {
    const store = freshStore();

    expect(store.getArtifact(MODULE, '1.0.0')?.bundleSha256).toBe(ARTIFACT.bundleSha256);
  });

  test('keeps versions separate', () => {
    const store = freshStore();
    store.saveArtifact({ ...ARTIFACT, version: '2.0.0', bundleSha256: 'c'.repeat(64) });

    expect(store.getArtifact(MODULE, '1.0.0')?.bundleSha256).toBe('b'.repeat(64));
    expect(store.getArtifact(MODULE, '2.0.0')?.bundleSha256).toBe('c'.repeat(64));
  });

  test('returns null for an artifact that was never installed', () => {
    expect(freshStore().getArtifact('com.nobody.nothing', '1.0.0')).toBeNull();
  });
});

describe('per-guild isolation', () => {
  test('installing in one guild does not install it in another', () => {
    const store = freshStore();

    installIn(store, GUILD_A);

    expect(store.getGuildModule(GUILD_A, MODULE)).not.toBeNull();
    expect(store.getGuildModule(GUILD_B, MODULE)).toBeNull();
  });

  test('listing a guild returns only that guild', () => {
    const store = freshStore();
    installIn(store, GUILD_A);

    expect(store.listGuildModules(GUILD_B)).toEqual([]);
  });

  test('enabling in one guild leaves the other disabled', () => {
    const store = freshStore();
    installIn(store, GUILD_A);
    installIn(store, GUILD_B);

    store.setEnabled(GUILD_A, MODULE, true);

    expect(store.getGuildModule(GUILD_A, MODULE)?.enabled).toBe(true);
    expect(store.getGuildModule(GUILD_B, MODULE)?.enabled).toBe(false);
  });

  test('reports only the guilds where a module is enabled', () => {
    const store = freshStore();
    installIn(store, GUILD_A);
    installIn(store, GUILD_B);
    store.setEnabled(GUILD_A, MODULE, true);

    expect(store.guildsWithModuleEnabled(MODULE)).toEqual([GUILD_A]);
  });

  test('uninstalling from one guild leaves the other untouched', () => {
    const store = freshStore();
    installIn(store, GUILD_A);
    installIn(store, GUILD_B);

    store.uninstallForGuild(GUILD_A, MODULE);

    expect(store.getGuildModule(GUILD_A, MODULE)).toBeNull();
    expect(store.getGuildModule(GUILD_B, MODULE)).not.toBeNull();
  });

  test('modules are disabled until explicitly enabled', () => {
    const store = freshStore();

    installIn(store, GUILD_A);

    expect(store.getGuildModule(GUILD_A, MODULE)?.enabled).toBe(false);
  });
});

describe('granted permissions', () => {
  test('records what the admin approved', () => {
    const store = freshStore();

    installIn(store, GUILD_A, ['messages.read', 'members.ban']);

    expect(store.getGuildModule(GUILD_A, MODULE)?.grantedPermissions).toEqual([
      'messages.read',
      'members.ban',
    ]);
  });

  test('grants a permission that was approved', () => {
    const store = freshStore();
    installIn(store, GUILD_A, ['messages.read']);

    expect(store.hasPermission(GUILD_A, MODULE, 'messages.read')).toBe(true);
  });

  test('refuses a permission that was not approved', () => {
    const store = freshStore();
    installIn(store, GUILD_A, ['messages.read']);

    expect(store.hasPermission(GUILD_A, MODULE, 'members.ban')).toBe(false);
  });

  // A grant in one server must never authorise anything in another.
  test('refuses a permission granted only in a different guild', () => {
    const store = freshStore();
    installIn(store, GUILD_A, ['members.ban']);
    installIn(store, GUILD_B, ['messages.read']);

    expect(store.hasPermission(GUILD_B, MODULE, 'members.ban')).toBe(false);
  });

  test('refuses every permission for a module that is not installed', () => {
    expect(freshStore().hasPermission(GUILD_A, MODULE, 'messages.read')).toBe(false);
  });
});

describe('module storage', () => {
  test('stores and reads a value', () => {
    const store = freshStore();

    store.kvSet(GUILD_A, MODULE, 'greeting', 'hello');

    expect(store.kvGet(GUILD_A, MODULE, 'greeting')).toBe('hello');
  });

  // Namespacing is what stops one module reading another's data, and one guild's data
  // leaking into another.
  test('keeps the same key separate between guilds', () => {
    const store = freshStore();

    store.kvSet(GUILD_A, MODULE, 'greeting', 'from A');
    store.kvSet(GUILD_B, MODULE, 'greeting', 'from B');

    expect(store.kvGet(GUILD_A, MODULE, 'greeting')).toBe('from A');
  });

  test('keeps the same key separate between modules', () => {
    const store = freshStore();

    store.kvSet(GUILD_A, MODULE, 'greeting', 'from moderation');
    store.kvSet(GUILD_A, 'com.other.module', 'greeting', 'from other');

    expect(store.kvGet(GUILD_A, MODULE, 'greeting')).toBe('from moderation');
  });

  test('returns null for a key that was never set', () => {
    expect(freshStore().kvGet(GUILD_A, MODULE, 'nothing')).toBeNull();
  });

  test('overwrites an existing key', () => {
    const store = freshStore();
    store.kvSet(GUILD_A, MODULE, 'greeting', 'first');

    store.kvSet(GUILD_A, MODULE, 'greeting', 'second');

    expect(store.kvGet(GUILD_A, MODULE, 'greeting')).toBe('second');
  });

  test('deletes a key', () => {
    const store = freshStore();
    store.kvSet(GUILD_A, MODULE, 'greeting', 'hello');

    store.kvDelete(GUILD_A, MODULE, 'greeting');

    expect(store.kvGet(GUILD_A, MODULE, 'greeting')).toBeNull();
  });

  test('refuses a write that would exceed the quota', () => {
    const store = freshStore();

    const result = store.kvSet(GUILD_A, MODULE, 'big', 'x'.repeat(5000), { quotaBytes: 1000 });

    expect(result.ok).toBe(false);
  });

  test('does not store a value that was refused', () => {
    const store = freshStore();

    store.kvSet(GUILD_A, MODULE, 'big', 'x'.repeat(5000), { quotaBytes: 1000 });

    expect(store.kvGet(GUILD_A, MODULE, 'big')).toBeNull();
  });

  test("one guild's usage does not consume another's quota", () => {
    const store = freshStore();
    store.kvSet(GUILD_A, MODULE, 'data', 'x'.repeat(800), { quotaBytes: 1000 });

    const result = store.kvSet(GUILD_B, MODULE, 'data', 'x'.repeat(800), { quotaBytes: 1000 });

    expect(result.ok).toBe(true);
  });
});

describe('audit log', () => {
  test('records a privileged call', () => {
    const store = freshStore();

    store.audit({ guildId: GUILD_A, moduleId: MODULE, op: 'members.ban', outcome: 'allowed' });

    expect(store.recentAudit(GUILD_A).length).toBe(1);
  });

  test('records refusals as well as successes', () => {
    const store = freshStore();

    store.audit({ guildId: GUILD_A, moduleId: MODULE, op: 'members.ban', outcome: 'denied' });

    expect(store.recentAudit(GUILD_A)[0]?.outcome).toBe('denied');
  });

  test('keeps each guild’s audit separate', () => {
    const store = freshStore();
    store.audit({ guildId: GUILD_A, moduleId: MODULE, op: 'members.ban', outcome: 'allowed' });

    expect(store.recentAudit(GUILD_B)).toEqual([]);
  });

  test('returns the most recent entries first', () => {
    const store = freshStore();
    store.audit({ guildId: GUILD_A, moduleId: MODULE, op: 'first', outcome: 'allowed' });
    store.audit({ guildId: GUILD_A, moduleId: MODULE, op: 'second', outcome: 'allowed' });

    expect(store.recentAudit(GUILD_A)[0]?.op).toBe('second');
  });
});
