/**
 * Tessel's persistence, on Node's built-in SQLite.
 *
 * There is no ORM and no native dependency here on purpose: better-sqlite3 has no prebuilt
 * binary for Node 24, and Node 24 is required by the sandbox, so a native driver would mean
 * every install needs a C++ toolchain. `node:sqlite` ships with the runtime.
 *
 * The guild id is part of the primary key of everything a module can touch. That is the
 * mechanism behind per-guild isolation: there is no query in this file that can return one
 * guild's rows to another, because none of them can be written without a guild id.
 */
import { DatabaseSync } from 'node:sqlite';

export interface ModuleArtifact {
  moduleId: string;
  version: string;
  commitSha: string;
  bundleSha256: string;
  trust: 'signed' | 'unsigned';
  manifestJson: string;
}

export interface GuildModule {
  guildId: string;
  moduleId: string;
  version: string;
  enabled: boolean;
  grantedPermissions: string[];
  installedBy: string;
  /** Who clicked through the "this module is not signed" warning, if it was unsigned. */
  unsignedAckBy: string | null;
}

export interface InstallForGuild {
  guildId: string;
  moduleId: string;
  version: string;
  installedBy: string;
  grantedPermissions: string[];
  unsignedAckBy?: string | null;
}

export interface AuditEntry {
  guildId: string;
  moduleId: string;
  op: string;
  outcome: 'allowed' | 'denied' | 'failed';
  target?: string | null;
  actorUserId?: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  at: number;
}

export interface KvOptions {
  quotaBytes?: number;
}

export type KvResult = { ok: true } | { ok: false; error: string };

const DEFAULT_QUOTA_BYTES = 512 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS module_artifacts (
  module_id     TEXT NOT NULL,
  version       TEXT NOT NULL,
  commit_sha    TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  trust         TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  installed_at  INTEGER NOT NULL,
  PRIMARY KEY (module_id, version)
);

CREATE TABLE IF NOT EXISTS guild_modules (
  guild_id            TEXT NOT NULL,
  module_id           TEXT NOT NULL,
  version             TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 0,
  granted_permissions TEXT NOT NULL,
  installed_by        TEXT NOT NULL,
  unsigned_ack_by     TEXT,
  unsigned_ack_at     INTEGER,
  PRIMARY KEY (guild_id, module_id)
);

CREATE TABLE IF NOT EXISTS module_kv (
  guild_id   TEXT NOT NULL,
  module_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, module_id, key)
);

CREATE TABLE IF NOT EXISTS module_audit (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             INTEGER NOT NULL,
  guild_id       TEXT NOT NULL,
  module_id      TEXT NOT NULL,
  op             TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  target         TEXT,
  actor_user_id  TEXT
);

CREATE INDEX IF NOT EXISTS module_audit_guild_idx ON module_audit (guild_id, id DESC);
`;

export class TesselStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  // --- artifacts ---------------------------------------------------------------------------

  saveArtifact(artifact: ModuleArtifact): void {
    this.#db
      .prepare(
        `INSERT INTO module_artifacts
           (module_id, version, commit_sha, bundle_sha256, trust, manifest_json, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (module_id, version) DO UPDATE SET
           commit_sha = excluded.commit_sha,
           bundle_sha256 = excluded.bundle_sha256,
           trust = excluded.trust,
           manifest_json = excluded.manifest_json`,
      )
      .run(
        artifact.moduleId,
        artifact.version,
        artifact.commitSha,
        artifact.bundleSha256,
        artifact.trust,
        artifact.manifestJson,
        Date.now(),
      );
  }

  getArtifact(moduleId: string, version: string): ModuleArtifact | null {
    const row = this.#db
      .prepare(
        `SELECT module_id, version, commit_sha, bundle_sha256, trust, manifest_json
           FROM module_artifacts WHERE module_id = ? AND version = ?`,
      )
      .get(moduleId, version) as Record<string, string> | undefined;

    if (!row) return null;

    return {
      moduleId: row.module_id!,
      version: row.version!,
      commitSha: row.commit_sha!,
      bundleSha256: row.bundle_sha256!,
      trust: row.trust as 'signed' | 'unsigned',
      manifestJson: row.manifest_json!,
    };
  }

  // --- per-guild installs ------------------------------------------------------------------

  installForGuild(install: InstallForGuild): void {
    this.#db
      .prepare(
        `INSERT INTO guild_modules
           (guild_id, module_id, version, enabled, granted_permissions, installed_by,
            unsigned_ack_by, unsigned_ack_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?)
         ON CONFLICT (guild_id, module_id) DO UPDATE SET
           version = excluded.version,
           granted_permissions = excluded.granted_permissions,
           unsigned_ack_by = excluded.unsigned_ack_by,
           unsigned_ack_at = excluded.unsigned_ack_at`,
      )
      .run(
        install.guildId,
        install.moduleId,
        install.version,
        JSON.stringify(install.grantedPermissions),
        install.installedBy,
        install.unsignedAckBy ?? null,
        install.unsignedAckBy ? Date.now() : null,
      );
  }

  getGuildModule(guildId: string, moduleId: string): GuildModule | null {
    const row = this.#db
      .prepare(`SELECT * FROM guild_modules WHERE guild_id = ? AND module_id = ?`)
      .get(guildId, moduleId) as Record<string, unknown> | undefined;

    return row ? toGuildModule(row) : null;
  }

  listGuildModules(guildId: string): GuildModule[] {
    const rows = this.#db
      .prepare(`SELECT * FROM guild_modules WHERE guild_id = ? ORDER BY module_id`)
      .all(guildId) as Record<string, unknown>[];

    return rows.map(toGuildModule);
  }

  setEnabled(guildId: string, moduleId: string, enabled: boolean): void {
    this.#db
      .prepare(`UPDATE guild_modules SET enabled = ? WHERE guild_id = ? AND module_id = ?`)
      .run(enabled ? 1 : 0, guildId, moduleId);
  }

  uninstallForGuild(guildId: string, moduleId: string): void {
    this.#db
      .prepare(`DELETE FROM guild_modules WHERE guild_id = ? AND module_id = ?`)
      .run(guildId, moduleId);
    this.#db
      .prepare(`DELETE FROM module_kv WHERE guild_id = ? AND module_id = ?`)
      .run(guildId, moduleId);
  }

  /** Which guilds a module process needs to serve. */
  guildsWithModuleEnabled(moduleId: string): string[] {
    const rows = this.#db
      .prepare(`SELECT guild_id FROM guild_modules WHERE module_id = ? AND enabled = 1`)
      .all(moduleId) as Record<string, string>[];

    return rows.map((row) => row.guild_id!);
  }

  /**
   * The authorisation check behind every privileged RPC. Not installed, or not granted in
   * THIS guild, means no.
   */
  hasPermission(guildId: string, moduleId: string, permission: string): boolean {
    const guildModule = this.getGuildModule(guildId, moduleId);
    return guildModule?.grantedPermissions.includes(permission) ?? false;
  }

  // --- module storage ----------------------------------------------------------------------

  kvGet(guildId: string, moduleId: string, key: string): string | null {
    const row = this.#db
      .prepare(`SELECT value FROM module_kv WHERE guild_id = ? AND module_id = ? AND key = ?`)
      .get(guildId, moduleId, key) as Record<string, string> | undefined;

    return row?.value ?? null;
  }

  kvSet(
    guildId: string,
    moduleId: string,
    key: string,
    value: string,
    options: KvOptions = {},
  ): KvResult {
    const quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA_BYTES;

    // Quota is per guild AND per module, so a busy server cannot exhaust another's budget.
    const used = this.#usedBytes(guildId, moduleId);
    const existing = this.kvGet(guildId, moduleId, key);
    const delta = Buffer.byteLength(value, 'utf8') - (existing ? Buffer.byteLength(existing, 'utf8') : 0);

    if (used + delta > quotaBytes) {
      return {
        ok: false,
        error: `Storage quota exceeded: this module may store ${quotaBytes} bytes per server.`,
      };
    }

    this.#db
      .prepare(
        `INSERT INTO module_kv (guild_id, module_id, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (guild_id, module_id, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(guildId, moduleId, key, value, Date.now());

    return { ok: true };
  }

  kvDelete(guildId: string, moduleId: string, key: string): void {
    this.#db
      .prepare(`DELETE FROM module_kv WHERE guild_id = ? AND module_id = ? AND key = ?`)
      .run(guildId, moduleId, key);
  }

  #usedBytes(guildId: string, moduleId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(value)), 0) AS used
           FROM module_kv WHERE guild_id = ? AND module_id = ?`,
      )
      .get(guildId, moduleId) as Record<string, number> | undefined;

    return Number(row?.used ?? 0);
  }

  // --- audit -------------------------------------------------------------------------------

  audit(entry: AuditEntry): void {
    this.#db
      .prepare(
        `INSERT INTO module_audit (at, guild_id, module_id, op, outcome, target, actor_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        entry.guildId,
        entry.moduleId,
        entry.op,
        entry.outcome,
        entry.target ?? null,
        entry.actorUserId ?? null,
      );
  }

  recentAudit(guildId: string, limit = 50): AuditRow[] {
    const rows = this.#db
      .prepare(`SELECT * FROM module_audit WHERE guild_id = ? ORDER BY id DESC LIMIT ?`)
      .all(guildId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id),
      at: Number(row.at),
      guildId: String(row.guild_id),
      moduleId: String(row.module_id),
      op: String(row.op),
      outcome: String(row.outcome) as AuditEntry['outcome'],
      target: (row.target as string | null) ?? null,
      actorUserId: (row.actor_user_id as string | null) ?? null,
    }));
  }
}

function toGuildModule(row: Record<string, unknown>): GuildModule {
  return {
    guildId: String(row.guild_id),
    moduleId: String(row.module_id),
    version: String(row.version),
    enabled: Number(row.enabled) === 1,
    grantedPermissions: JSON.parse(String(row.granted_permissions)) as string[],
    installedBy: String(row.installed_by),
    unsignedAckBy: (row.unsigned_ack_by as string | null) ?? null,
  };
}
