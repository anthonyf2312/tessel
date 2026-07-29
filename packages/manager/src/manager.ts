/**
 * The module manager: store + supervisor + routing.
 *
 * This is where the two headline guarantees live.
 *
 * **Per guild.** Every lookup starts from a guild id. A module's commands are listed from that
 * guild's install row, dispatch refuses anything not enabled for the calling guild, and the
 * guild id is stamped into every message a module receives. One process serves all the guilds
 * that enabled a module; isolation is enforced per call rather than by running a copy per
 * server, which is what keeps a popular module from costing one process per guild.
 *
 * **No restarts.** Enabling writes a row, writes a bundle and spawns a process. Disabling
 * reverses it. Neither touches core, so modules come and go while the bot stays up.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TesselStore } from '@tessel/db';
import type { Supervisor } from '@tessel/sandbox-runtime';
import type { Manifest } from '@tessel/protocol';

export interface ModuleManagerOptions {
  store: TesselStore;
  supervisor: Supervisor;
  /** Root under which module bundles are written: <bundleDir>/<moduleId>/<version>/bundle.mjs */
  bundleDir: string;
  rpcTimeoutMs?: number;
}

export interface SaveArtifactInput {
  moduleId: string;
  version: string;
  commitSha: string;
  bundleSha256: string;
  trust: 'signed' | 'unsigned';
  manifest: Manifest;
  bundleCode: string;
}

export interface EnableInput {
  guildId: string;
  moduleId: string;
  version: string;
  grantedPermissions: string[];
  installedBy: string;
  /** Set when the admin clicked through the unsigned-module warning. */
  unsignedAckBy?: string | null;
}

export interface CommandDeclaration {
  name: string;
  description: string;
  moduleId: string;
}

export interface DispatchInput {
  guildId: string;
  command: string;
  userId: string;
  options: Record<string, string | number | boolean>;
}

export type Result = { ok: true } | { ok: false; error: string };

interface PendingCall {
  resolve: (value: { ok: true; content: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  /** The guild this call belongs to. Every capability the module uses is scoped to it. */
  guildId: string;
  moduleId: string;
}

export class ModuleManager {
  readonly #store: TesselStore;
  readonly #supervisor: Supervisor;
  readonly #bundleDir: string;
  readonly #rpcTimeoutMs: number;

  readonly #pending = new Map<string, PendingCall>();
  #nextCallId = 0;

  constructor(options: ModuleManagerOptions) {
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#bundleDir = options.bundleDir;
    this.#rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;

    this.#supervisor.onMessage((moduleId, message) => this.#onModuleMessage(moduleId, message));
    this.#supervisor.onAutoDisabled((moduleId, reason) => {
      void this.handleAutoDisabled(moduleId, reason);
    });
  }

  /** Persists a freshly installed artifact and writes its bundle where the sandbox can read it. */
  async saveArtifact(input: SaveArtifactInput): Promise<void> {
    const dir = this.#bundlePathFor(input.moduleId, input.version);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bundle.mjs'), input.bundleCode, 'utf8');

    this.#store.saveArtifact({
      moduleId: input.moduleId,
      version: input.version,
      commitSha: input.commitSha,
      bundleSha256: input.bundleSha256,
      trust: input.trust,
      manifestJson: JSON.stringify(input.manifest),
    });
  }

  async enable(input: EnableInput): Promise<Result> {
    const artifact = this.#store.getArtifact(input.moduleId, input.version);
    if (!artifact) {
      return { ok: false, error: `'${input.moduleId}' is not installed on this bot.` };
    }

    this.#store.installForGuild({
      guildId: input.guildId,
      moduleId: input.moduleId,
      version: input.version,
      installedBy: input.installedBy,
      grantedPermissions: input.grantedPermissions,
      unsignedAckBy: input.unsignedAckBy ?? null,
    });
    this.#store.setEnabled(input.guildId, input.moduleId, true);

    await this.#supervisor.start({
      moduleId: input.moduleId,
      bundlePath: join(this.#bundlePathFor(input.moduleId, input.version), 'bundle.mjs'),
    });

    this.#store.audit({
      guildId: input.guildId,
      moduleId: input.moduleId,
      op: 'module.enable',
      outcome: 'allowed',
      actorUserId: input.installedBy,
    });

    return { ok: true };
  }

  async disable(guildId: string, moduleId: string): Promise<void> {
    this.#store.setEnabled(guildId, moduleId, false);

    // The process is shared, so it only stops once nobody is using it.
    if (this.#store.guildsWithModuleEnabled(moduleId).length === 0) {
      await this.#supervisor.stop(moduleId);
    }

    this.#store.audit({ guildId, moduleId, op: 'module.disable', outcome: 'allowed' });
  }

  /** The commands Discord should have registered for this guild, and only this guild. */
  commandsForGuild(guildId: string): CommandDeclaration[] {
    const declarations: CommandDeclaration[] = [];

    for (const guildModule of this.#store.listGuildModules(guildId)) {
      if (!guildModule.enabled) continue;

      const artifact = this.#store.getArtifact(guildModule.moduleId, guildModule.version);
      if (!artifact) continue;

      const manifest = JSON.parse(artifact.manifestJson) as Manifest;
      for (const command of manifest.commands) {
        declarations.push({
          name: command.name,
          description: command.description,
          moduleId: guildModule.moduleId,
        });
      }
    }

    return declarations;
  }

  moduleForCommand(guildId: string, commandName: string): string | null {
    const match = this.commandsForGuild(guildId).find((c) => c.name === commandName);
    return match?.moduleId ?? null;
  }

  async dispatchCommand(input: DispatchInput): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const moduleId = this.moduleForCommand(input.guildId, input.command);
    if (!moduleId) {
      // Covers both "no such command" and "not enabled here" — deliberately the same answer,
      // so a command's existence in another server is not observable from this one.
      return { ok: false, error: 'That command is not available in this server.' };
    }

    const callId = `${moduleId}:${this.#nextCallId++}`;

    const response = new Promise<{ ok: true; content: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(callId);
        reject(new Error('The module did not respond in time.'));
      }, this.#rpcTimeoutMs);
      timer.unref?.();

      this.#pending.set(callId, { resolve, reject, timer, guildId: input.guildId, moduleId });
    });

    this.#supervisor.send(moduleId, {
      type: 'command',
      id: callId,
      // Stamped by core, never taken from the module: this is what every permission check for
      // this call is scoped against.
      guildId: input.guildId,
      command: input.command,
      userId: input.userId,
      options: input.options,
    });

    try {
      const result = await response;
      this.#store.audit({
        guildId: input.guildId,
        moduleId,
        op: `command.${input.command}`,
        outcome: 'allowed',
        actorUserId: input.userId,
      });
      return result;
    } catch (error) {
      this.#store.audit({
        guildId: input.guildId,
        moduleId,
        op: `command.${input.command}`,
        outcome: 'failed',
        actorUserId: input.userId,
      });
      return { ok: false, error: (error as Error).message };
    }
  }

  /**
   * Called when the supervisor gives up on a module. Disabling it in every guild keeps the
   * store honest about what is actually running, so commands are not offered for a module
   * that cannot start.
   */
  async handleAutoDisabled(moduleId: string, reason: string): Promise<void> {
    for (const guildId of this.#store.guildsWithModuleEnabled(moduleId)) {
      this.#store.setEnabled(guildId, moduleId, false);
      this.#store.audit({
        guildId,
        moduleId,
        op: 'module.auto-disable',
        outcome: 'failed',
        target: reason,
      });
    }

    await this.#supervisor.stop(moduleId);
  }

  #bundlePathFor(moduleId: string, version: string): string {
    // moduleId and version were validated by the manifest schema, which rejects path
    // separators and '..' — see packages/protocol/src/manifest.ts.
    return join(this.#bundleDir, moduleId, version);
  }

  #onModuleMessage(moduleId: string, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const payload = message as { type?: unknown; id?: unknown; ok?: unknown; content?: unknown };

    if (payload.type === 'rpc') {
      this.#handleRpc(moduleId, message as Record<string, unknown>);
      return;
    }

    if (payload.type !== 'response' || typeof payload.id !== 'string') return;

    const pending = this.#pending.get(payload.id);
    if (!pending) return;

    // A module could send a response id belonging to another module's call; the id is
    // namespaced by module so a mismatch here means it guessed, and is ignored.
    if (!payload.id.startsWith(`${moduleId}:`)) return;

    this.#pending.delete(payload.id);
    clearTimeout(pending.timer);

    pending.resolve({ ok: true, content: String(payload.content ?? '') });
  }

  /**
   * Serves a capability request from inside a module.
   *
   * The guild is taken from the call the request belongs to — never from the message. A module
   * that invents a `guildId` field, or quotes a `callId` belonging to another module, gets
   * nothing: the lookup is keyed by call, and the call is checked to belong to the sender.
   */
  #handleRpc(moduleId: string, message: Record<string, unknown>): void {
    const rpcId = String(message.rpcId ?? '');
    const callId = String(message.callId ?? '');
    const op = String(message.op ?? '');

    const reply = (result: Record<string, unknown>) =>
      this.#supervisor.send(moduleId, { type: 'rpc-result', rpcId, ...result });

    const call = this.#pending.get(callId);
    if (!call || call.moduleId !== moduleId) {
      reply({ ok: false, error: 'That request does not belong to a call you are handling.' });
      return;
    }

    const { guildId } = call;

    if (!op.startsWith('storage.')) {
      reply({ ok: false, error: `Unknown capability '${op}'.` });
      return;
    }

    if (!this.#store.hasPermission(guildId, moduleId, 'storage')) {
      this.#store.audit({ guildId, moduleId, op, outcome: 'denied' });
      reply({ ok: false, error: "This module was not granted the 'storage' permission here." });
      return;
    }

    const key = String(message.key ?? '');
    const quotaBytes = this.#quotaBytesFor(moduleId, guildId);

    switch (op) {
      case 'storage.get': {
        reply({ ok: true, value: this.#store.kvGet(guildId, moduleId, key) });
        return;
      }
      case 'storage.set': {
        const result = this.#store.kvSet(guildId, moduleId, key, String(message.value ?? ''), {
          quotaBytes,
        });
        this.#store.audit({ guildId, moduleId, op, outcome: result.ok ? 'allowed' : 'denied' });
        reply(result.ok ? { ok: true, value: null } : { ok: false, error: result.error });
        return;
      }
      case 'storage.delete': {
        this.#store.kvDelete(guildId, moduleId, key);
        reply({ ok: true, value: null });
        return;
      }
      default: {
        reply({ ok: false, error: `Unknown capability '${op}'.` });
      }
    }
  }

  #quotaBytesFor(moduleId: string, guildId: string): number {
    const guildModule = this.#store.getGuildModule(guildId, moduleId);
    if (!guildModule) return 0;

    const artifact = this.#store.getArtifact(moduleId, guildModule.version);
    if (!artifact) return 0;

    const manifest = JSON.parse(artifact.manifestJson) as Manifest;
    return manifest.storage.quotaKb * 1024;
  }
}
