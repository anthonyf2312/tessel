/**
 * @tessel/sdk — the entire surface a module has.
 *
 * This code runs INSIDE the sandbox. There is no discord.js here and no bot token; every
 * capability is a message to core, which checks the module's granted permissions and the guild
 * the call belongs to before doing anything.
 *
 * Note what a handler is never given: a guild id it can choose. `ctx.guildId` is stamped by
 * core, and every action is scoped by the command or event it came from — so a module cannot
 * reach into a server it was not invoked from, even if it tries.
 *
 * ```ts
 * import { defineModule } from '@tessel/sdk';
 *
 * export default defineModule({
 *   commands: {
 *     async greet(ctx) {
 *       ctx.reply(`Hello, <@${ctx.userId}>!`);
 *     },
 *   },
 *   events: {
 *     async memberJoin(ctx) {
 *       const channelId = await ctx.storage.get('welcomeChannel');
 *       if (channelId) await ctx.sendMessage(channelId, `Welcome, <@${ctx.member.id}>!`);
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

/** What a module can do. Each needs the matching permission, granted per server. */
export interface Actions {
  /** Per-server storage for this module. Namespaced and quota-limited. Needs `storage`. */
  readonly storage: Storage;
  /** Needs `messages.send`. */
  sendMessage(channelId: string, content: string): Promise<void>;
  /** Needs `messages.manage`. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** Needs `members.moderate`. */
  timeoutMember(userId: string, durationMs: number, reason?: string): Promise<void>;
  /** Needs `members.moderate`. */
  kickMember(userId: string, reason?: string): Promise<void>;
  /** Needs `members.ban`. */
  banMember(userId: string, reason?: string): Promise<void>;
  /** Needs `members.roles`. */
  addRole(userId: string, roleId: string): Promise<void>;
  /** Needs `members.roles`. */
  removeRole(userId: string, roleId: string): Promise<void>;
}

export interface CommandContext extends Actions {
  /** The server this command was used in. Set by core; a module cannot influence it. */
  readonly guildId: string;
  /** The server's display name, for use in messages. */
  readonly guildName: string;
  readonly userId: string;
  readonly options: Readonly<Record<string, OptionValue>>;
  /** Answers the person who ran the command. Call once. */
  reply(content: string): void;
}

export interface MemberInfo {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  /** Account creation time, ms since epoch. Useful for spotting fresh throwaway accounts. */
  createdAt: number;
}

export interface MessageInfo {
  id: string;
  channelId: string;
  content: string;
  author: MemberInfo;
}

export interface MemberEventContext extends Actions {
  readonly guildId: string;
  readonly guildName: string;
  readonly member: MemberInfo;
  readonly memberCount: number;
}

export interface MessageEventContext extends Actions {
  readonly guildId: string;
  readonly guildName: string;
  readonly message: MessageInfo;
}

export type CommandHandler = (ctx: CommandContext) => void | Promise<void>;

export interface EventHandlers {
  memberJoin?: (ctx: MemberEventContext) => void | Promise<void>;
  memberLeave?: (ctx: MemberEventContext) => void | Promise<void>;
  messageCreate?: (ctx: MessageEventContext) => void | Promise<void>;
}

export interface ModuleConfig {
  commands?: Record<string, CommandHandler>;
  events?: EventHandlers;
}

interface PendingRpc {
  resolve: (value: string | null) => void;
  reject: (error: Error) => void;
}

export function defineModule(config: ModuleConfig): ModuleConfig {
  const pending = new Map<string, PendingRpc>();
  let rpcSequence = 0;

  function callCore(
    contextId: string,
    op: string,
    payload: Record<string, unknown> = {},
  ): Promise<string | null> {
    const rpcId = `rpc-${rpcSequence++}`;

    return new Promise<string | null>((resolve, reject) => {
      pending.set(rpcId, { resolve, reject });
      // `callId` is how core knows which guild this belongs to. The module never names one.
      __tessel.send({ type: 'rpc', rpcId, callId: contextId, op, ...payload });
    });
  }

  /** The capability set, bound to one command or event. */
  function actionsFor(contextId: string): Actions {
    const call = (op: string, payload?: Record<string, unknown>) => callCore(contextId, op, payload);

    return {
      storage: {
        async get(key) {
          return call('storage.get', { key });
        },
        async set(key, value) {
          await call('storage.set', { key, value });
        },
        async delete(key) {
          await call('storage.delete', { key });
        },
      },
      async sendMessage(channelId, content) {
        await call('message.send', { channelId, content });
      },
      async deleteMessage(channelId, messageId) {
        await call('message.delete', { channelId, messageId });
      },
      async timeoutMember(userId, durationMs, reason) {
        await call('member.timeout', { userId, durationMs, reason: reason ?? '' });
      },
      async kickMember(userId, reason) {
        await call('member.kick', { userId, reason: reason ?? '' });
      },
      async banMember(userId, reason) {
        await call('member.ban', { userId, reason: reason ?? '' });
      },
      async addRole(userId, roleId) {
        await call('member.addRole', { userId, roleId });
      },
      async removeRole(userId, roleId) {
        await call('member.removeRole', { userId, roleId });
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

    if (message.type === 'command') void runCommand(message);
    if (message.type === 'event') void runEvent(message);
  });

  async function runCommand(message: Record<string, unknown>): Promise<void> {
    const contextId = String(message.id);
    const commandName = String(message.command);
    const handler = config.commands?.[commandName];

    if (!handler) {
      __tessel.send({ type: 'response', id: contextId, ok: false, content: 'Unknown command.' });
      return;
    }

    let replied = false;
    const ctx: CommandContext = {
      ...actionsFor(contextId),
      guildId: String(message.guildId),
      guildName: String(message.guildName ?? ''),
      userId: String(message.userId),
      options: (message.options as Record<string, OptionValue>) ?? {},
      reply(content: string) {
        if (replied) return;
        replied = true;
        __tessel.send({ type: 'response', id: contextId, ok: true, content });
      },
    };

    try {
      await handler(ctx);
      // A handler that finishes without replying would leave the user watching a spinner.
      if (!replied) ctx.reply('Done.');
    } catch (error) {
      if (!replied) {
        replied = true;
        __tessel.send({
          type: 'response',
          id: contextId,
          ok: false,
          content: `That command failed: ${(error as Error).message}`,
        });
      }
    }
  }

  async function runEvent(message: Record<string, unknown>): Promise<void> {
    const contextId = String(message.id);
    const eventName = String(message.event);
    const data = (message.data ?? {}) as Record<string, unknown>;
    const base = {
      ...actionsFor(contextId),
      guildId: String(message.guildId),
      guildName: String(message.guildName ?? ''),
    };

    try {
      if (eventName === 'memberJoin' || eventName === 'memberLeave') {
        const handler = config.events?.[eventName];
        if (!handler) return;
        await handler({
          ...base,
          member: data.member as MemberInfo,
          memberCount: Number(data.memberCount ?? 0),
        });
        return;
      }

      if (eventName === 'messageCreate') {
        const handler = config.events?.messageCreate;
        if (!handler) return;
        await handler({ ...base, message: data.message as MessageInfo });
      }
    } catch {
      // Nobody is waiting on an event, so a throw has nowhere to surface. Swallowing it here
      // keeps one bad handler from killing the process and taking every guild's copy with it;
      // repeated crashes are what the supervisor's auto-disable is for.
    }
  }

  __tessel.send({ type: 'ready' });

  return config;
}
