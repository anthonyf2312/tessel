/**
 * @tessel/sdk — the entire surface a module has.
 *
 * This code runs INSIDE the sandbox. There is no discord.js here and no bot token; every
 * capability is a message to core, which checks the module's granted permissions and the guild
 * the call belongs to before doing anything.
 *
 * Note what a handler is never given: a guild id it can choose. `ctx.guildId` is stamped by
 * core, and storage calls are scoped by the call they came from — so a module cannot reach
 * into a server it was not invoked from, even if it tries.
 *
 * A module's whole job is to call `defineModule` once:
 *
 * ```ts
 * import { defineModule } from '@tessel/sdk';
 *
 * export default defineModule({
 *   commands: {
 *     async greet(ctx) {
 *       const count = Number((await ctx.storage.get('count')) ?? '0') + 1;
 *       await ctx.storage.set('count', String(count));
 *       ctx.reply(`Hello! That is greeting number ${count} in this server.`);
 *     },
 *   },
 * });
 * ```
 */

/** Installed by the sandbox bootstrap before any module code runs. */
declare const __tessel: {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: Record<string, unknown>) => void): void;
};

export type OptionValue = string | number | boolean;

export interface Storage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CommandContext {
  /** The server this command was used in. Set by core; a module cannot influence it. */
  readonly guildId: string;
  readonly userId: string;
  readonly options: Readonly<Record<string, OptionValue>>;
  /** Per-server storage for this module. Namespaced and quota-limited by core. */
  readonly storage: Storage;
  /** Answers the person who ran the command. Call once. */
  reply(content: string): void;
}

export type CommandHandler = (ctx: CommandContext) => void | Promise<void>;

export interface ModuleConfig {
  commands: Record<string, CommandHandler>;
}

interface PendingRpc {
  resolve: (value: string | null) => void;
  reject: (error: Error) => void;
}

export function defineModule(config: ModuleConfig): ModuleConfig {
  const pending = new Map<string, PendingRpc>();
  let rpcSequence = 0;

  function callCore(callId: string, op: string, payload: Record<string, unknown>): Promise<string | null> {
    const rpcId = `rpc-${rpcSequence++}`;

    return new Promise<string | null>((resolve, reject) => {
      pending.set(rpcId, { resolve, reject });
      // `callId` is how core knows which guild this belongs to. The module never names a guild.
      __tessel.send({ type: 'rpc', rpcId, callId, op, ...payload });
    });
  }

  function storageFor(callId: string): Storage {
    return {
      async get(key) {
        return callCore(callId, 'storage.get', { key });
      },
      async set(key, value) {
        await callCore(callId, 'storage.set', { key, value });
      },
      async delete(key) {
        await callCore(callId, 'storage.delete', { key });
      },
    };
  }

  __tessel.onMessage((message) => {
    if (message.type === 'ping') {
      __tessel.send({ type: 'pong', id: message.id });
      return;
    }

    if (message.type === 'rpc-result') {
      const waiting = pending.get(String(message.rpcId));
      if (!waiting) return;
      pending.delete(String(message.rpcId));

      if (message.ok) waiting.resolve((message.value as string | null) ?? null);
      else waiting.reject(new Error(String(message.error ?? 'The bot refused that request.')));
      return;
    }

    if (message.type === 'command') {
      void runCommand(message);
    }
  });

  async function runCommand(message: Record<string, unknown>): Promise<void> {
    const callId = String(message.id);
    const commandName = String(message.command);
    const handler = config.commands[commandName];

    if (!handler) {
      __tessel.send({ type: 'response', id: callId, ok: false, content: 'Unknown command.' });
      return;
    }

    let replied = false;
    const ctx: CommandContext = {
      guildId: String(message.guildId),
      userId: String(message.userId),
      options: (message.options as Record<string, OptionValue>) ?? {},
      storage: storageFor(callId),
      reply(content: string) {
        if (replied) return;
        replied = true;
        __tessel.send({ type: 'response', id: callId, ok: true, content });
      },
    };

    try {
      await handler(ctx);
      // A handler that finishes without replying would leave the user staring at a spinner.
      if (!replied) ctx.reply('Done.');
    } catch (error) {
      if (!replied) {
        replied = true;
        __tessel.send({
          type: 'response',
          id: callId,
          ok: false,
          content: `That command failed: ${(error as Error).message}`,
        });
      }
    }
  }

  __tessel.send({ type: 'ready' });

  return config;
}
