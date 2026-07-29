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
 *
 * Commands and events both create a short-lived *context* holding the guild they belong to.
 * When a module asks to do something, the guild comes from that context — never from the
 * message it sent. A module cannot name a guild, so it cannot reach one it wasn't invoked from.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TesselStore } from '@tessel/db';
import type { Supervisor } from '@tessel/sandbox-runtime';
import type { Manifest } from '@tessel/protocol';
import { EVENT_PERMISSIONS, OP_PERMISSIONS, type DiscordActions } from './actions.ts';

export interface ModuleManagerOptions {
  store: TesselStore;
  supervisor: Supervisor;
  /** Root under which module bundles are written: <bundleDir>/<moduleId>/<version>/bundle.mjs */
  bundleDir: string;
  rpcTimeoutMs?: number;
  /** Omit and modules can still use storage; every Discord capability reports unavailable. */
  discord?: DiscordActions;
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
  guildName?: string;
  command: string;
  userId: string;
  options: Record<string, string | number | boolean>;
}

export type Result = { ok: true } | { ok: false; error: string };

interface CallContext {
  guildId: string;
  moduleId: string;
  expiresAt: number;
}

interface PendingReply {
  resolve: (value: { ok: true; content: string }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** How long a module may keep using the capabilities of an event it was handed. */
const EVENT_CONTEXT_TTL_MS = 60_000;

export class ModuleManager {
  readonly #store: TesselStore;
  readonly #supervisor: Supervisor;
  readonly #bundleDir: string;
  readonly #rpcTimeoutMs: number;
  readonly #discord: DiscordActions | undefined;

  readonly #contexts = new Map<string, CallContext>();
  readonly #pendingReplies = new Map<string, PendingReply>();
  #nextId = 0;

  constructor(options: ModuleManagerOptions) {
    this.#store = options.store;
    this.#supervisor = options.supervisor;
    this.#bundleDir = options.bundleDir;
    this.#rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;
    this.#discord = options.discord;

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

      const manifest = this.#manifestFor(guildModule.moduleId, guildModule.version);
      if (!manifest) continue;

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

  async dispatchCommand(
    input: DispatchInput,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const moduleId = this.moduleForCommand(input.guildId, input.command);
    if (!moduleId) {
      // Covers both "no such command" and "not enabled here" — deliberately the same answer,
      // so a command's existence in another server is not observable from this one.
      return { ok: false, error: 'That command is not available in this server.' };
    }

    const callId = this.#registerContext(moduleId, input.guildId, this.#rpcTimeoutMs * 2);

    const response = new Promise<{ ok: true; content: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingReplies.delete(callId);
        reject(new Error('The module did not respond in time.'));
      }, this.#rpcTimeoutMs);
      timer.unref?.();

      this.#pendingReplies.set(callId, { resolve, reject, timer });
    });

    this.#supervisor.send(moduleId, {
      type: 'command',
      id: callId,
      // Stamped by core, never taken from the module.
      guildId: input.guildId,
      guildName: input.guildName ?? '',
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
   * Hands a guild event to every module entitled to see it.
   *
   * Entitlement is two things: the module is enabled in this guild, and it holds the
   * permission that event requires. A module without `messages.read` is never told a message
   * was sent — it does not receive the event and discard it, it is never sent.
   */
  dispatchEvent(
    guildId: string,
    event: string,
    data: Record<string, unknown>,
    guildName = '',
  ): void {
    const required = EVENT_PERMISSIONS[event];
    if (!required) return;

    for (const guildModule of this.#store.listGuildModules(guildId)) {
      if (!guildModule.enabled) continue;
      if (!this.#store.hasPermission(guildId, guildModule.moduleId, required)) continue;

      const contextId = this.#registerContext(
        guildModule.moduleId,
        guildId,
        EVENT_CONTEXT_TTL_MS,
      );

      this.#supervisor.send(guildModule.moduleId, {
        type: 'event',
        id: contextId,
        event,
        guildId,
        guildName,
        data: data as never,
      });
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

  // --- internals ---------------------------------------------------------------------------

  #registerContext(moduleId: string, guildId: string, ttlMs: number): string {
    // Sweep on write; there is no background timer to leak.
    const now = Date.now();
    for (const [key, value] of this.#contexts) {
      if (value.expiresAt < now) this.#contexts.delete(key);
    }

    const id = `${moduleId}:${this.#nextId++}`;
    this.#contexts.set(id, { guildId, moduleId, expiresAt: now + ttlMs });
    return id;
  }

  #manifestFor(moduleId: string, version: string): Manifest | null {
    const artifact = this.#store.getArtifact(moduleId, version);
    return artifact ? (JSON.parse(artifact.manifestJson) as Manifest) : null;
  }

  #bundlePathFor(moduleId: string, version: string): string {
    // moduleId and version were validated by the manifest schema, which rejects path
    // separators and '..' — see packages/protocol/src/manifest.ts.
    return join(this.#bundleDir, moduleId, version);
  }

  #onModuleMessage(moduleId: string, message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const payload = message as { type?: unknown; id?: unknown; content?: unknown };

    if (payload.type === 'rpc') {
      void this.#handleRpc(moduleId, message as Record<string, unknown>);
      return;
    }

    if (payload.type !== 'response' || typeof payload.id !== 'string') return;

    const pending = this.#pendingReplies.get(payload.id);
    if (!pending) return;

    // A module could quote a response id belonging to another module's call; ids are
    // namespaced by module, so a mismatch means it guessed, and is ignored.
    if (!payload.id.startsWith(`${moduleId}:`)) return;

    this.#pendingReplies.delete(payload.id);
    clearTimeout(pending.timer);
    pending.resolve({ ok: true, content: String(payload.content ?? '') });
  }

  /**
   * Serves a capability request from inside a module.
   *
   * The guild comes from the context the request belongs to. A module that invents a `guildId`
   * field, or quotes a context belonging to another module, gets nothing.
   */
  async #handleRpc(moduleId: string, message: Record<string, unknown>): Promise<void> {
    const rpcId = String(message.rpcId ?? '');
    const contextId = String(message.callId ?? '');
    const op = String(message.op ?? '');

    const reply = (result: Record<string, unknown>) =>
      this.#supervisor.send(moduleId, { type: 'rpc-result', rpcId, ...result });

    const context = this.#contexts.get(contextId);
    if (!context || context.moduleId !== moduleId || context.expiresAt < Date.now()) {
      reply({ ok: false, error: 'That request does not belong to anything you are handling.' });
      return;
    }

    const { guildId } = context;

    const required = OP_PERMISSIONS[op];
    if (!required) {
      reply({ ok: false, error: `Unknown capability '${op}'.` });
      return;
    }

    if (!this.#store.hasPermission(guildId, moduleId, required)) {
      this.#store.audit({ guildId, moduleId, op, outcome: 'denied' });
      reply({ ok: false, error: `This module was not granted '${required}' in this server.` });
      return;
    }

    try {
      const value = await this.#perform(op, guildId, moduleId, message);
      this.#store.audit({ guildId, moduleId, op, outcome: 'allowed' });
      reply({ ok: true, value: value ?? null });
    } catch (error) {
      this.#store.audit({ guildId, moduleId, op, outcome: 'failed' });
      // Discord's own errors are safe to pass back — they tell the author what to fix.
      reply({ ok: false, error: (error as Error).message });
    }
  }

  async #perform(
    op: string,
    guildId: string,
    moduleId: string,
    message: Record<string, unknown>,
  ): Promise<string | null> {
    const str = (key: string) => String(message[key] ?? '');

    switch (op) {
      case 'storage.get':
        return this.#store.kvGet(guildId, moduleId, str('key'));

      case 'storage.set': {
        const quotaBytes = this.#quotaBytesFor(moduleId, guildId);
        const result = this.#store.kvSet(guildId, moduleId, str('key'), str('value'), { quotaBytes });
        if (!result.ok) throw new Error(result.error);
        return null;
      }

      case 'storage.delete':
        this.#store.kvDelete(guildId, moduleId, str('key'));
        return null;
    }

    const discord = this.#discord;
    if (!discord) throw new Error('This bot cannot perform Discord actions right now.');

    switch (op) {
      case 'message.send':
        await discord.sendMessage(guildId, str('channelId'), str('content'));
        return null;
      case 'message.delete':
        await discord.deleteMessage(guildId, str('channelId'), str('messageId'));
        return null;
      case 'member.timeout':
        await discord.timeoutMember(guildId, str('userId'), Number(message.durationMs ?? 0), str('reason'));
        return null;
      case 'member.kick':
        await discord.kickMember(guildId, str('userId'), str('reason'));
        return null;
      case 'member.ban':
        await discord.banMember(guildId, str('userId'), str('reason'));
        return null;
      case 'member.addRole':
        await discord.addRole(guildId, str('userId'), str('roleId'));
        return null;
      case 'member.removeRole':
        await discord.removeRole(guildId, str('userId'), str('roleId'));
        return null;
      default:
        throw new Error(`Unknown capability '${op}'.`);
    }
  }

  #quotaBytesFor(moduleId: string, guildId: string): number {
    const guildModule = this.#store.getGuildModule(guildId, moduleId);
    if (!guildModule) return 0;

    const manifest = this.#manifestFor(moduleId, guildModule.version);
    return manifest ? manifest.storage.quotaKb * 1024 : 0;
  }
}
