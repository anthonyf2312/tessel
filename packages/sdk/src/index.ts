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

// --- shapes returned by the read capabilities -------------------------------------------------

export interface ChannelSummary {
  id: string;
  name: string;
  type: string;
  topic: string | null;
  parentId: string | null;
}

export interface RoleSummary {
  id: string;
  name: string;
  colour: number;
  position: number;
  managed: boolean;
}

export interface MemberSummary {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
  createdAt: number;
  joinedAt: number | null;
  roles: string[];
}

export interface MessageSummary {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  createdAt: number;
}

export interface GuildSummary {
  id: string;
  name: string;
  memberCount: number;
  ownerId: string;
  iconUrl: string | null;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  body: string;
}

/**
 * What a module can do.
 *
 * Each call needs the permission named in its doc comment, granted per server, and is scoped
 * to the guild the command or event came from.
 */
export interface Actions {
  /** Per-server storage, namespaced and quota-limited. Needs `storage`. */
  readonly storage: Storage;

  // --- messages ---
  /** Returns the new message's id. Needs `messages.send`. */
  sendMessage(channelId: string, content: string): Promise<string>;
  /** Edits a message this module sent. Needs `messages.send`. */
  editMessage(channelId: string, messageId: string, content: string): Promise<void>;
  /** Replies to a specific message. Needs `messages.send`. */
  replyToMessage(channelId: string, messageId: string, content: string): Promise<string>;
  /** Needs `messages.manage`. */
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  /** Needs `messages.manage`. */
  pinMessage(channelId: string, messageId: string, pinned?: boolean): Promise<void>;
  /** Needs `messages.read`. */
  fetchMessage(channelId: string, messageId: string): Promise<MessageSummary>;
  /** Most recent first, up to 100. Needs `messages.read`. */
  fetchMessages(channelId: string, limit?: number): Promise<MessageSummary[]>;

  // --- reactions ---
  /** A unicode emoji, or `name:id` for a custom one. Needs `reactions`. */
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Needs `reactions`. */
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;

  // --- members ---
  /** Needs `members.read`. */
  fetchMember(userId: string): Promise<MemberSummary>;
  /** Needs `members.moderate`. */
  timeoutMember(userId: string, durationMs: number, reason?: string): Promise<void>;
  /** Needs `members.moderate`. */
  kickMember(userId: string, reason?: string): Promise<void>;
  /** Needs `members.ban`. */
  banMember(userId: string, reason?: string): Promise<void>;
  /** Needs `members.ban`. */
  unbanMember(userId: string, reason?: string): Promise<void>;
  /** An empty string clears the nickname. Needs `members.roles`. */
  setNickname(userId: string, nickname: string): Promise<void>;
  /** Needs `members.roles`. */
  addRole(userId: string, roleId: string): Promise<void>;
  /** Needs `members.roles`. */
  removeRole(userId: string, roleId: string): Promise<void>;

  // --- channels ---
  /** Needs `channels.read`. */
  listChannels(): Promise<ChannelSummary[]>;
  /** Needs `channels.read`. */
  fetchChannel(channelId: string): Promise<ChannelSummary>;
  /** `type` is 'text', 'voice' or 'category'. Needs `channels.manage`. */
  createChannel(name: string, type?: string, parentId?: string): Promise<ChannelSummary>;
  /** Needs `channels.manage`. */
  deleteChannel(channelId: string, reason?: string): Promise<void>;
  /** Needs `channels.manage`. */
  setChannelTopic(channelId: string, topic: string): Promise<void>;
  /** Seconds between messages; 0 disables it. Needs `channels.manage`. */
  setSlowmode(channelId: string, seconds: number): Promise<void>;

  // --- roles ---
  /** Needs `members.read`. */
  listRoles(): Promise<RoleSummary[]>;
  /** Needs `members.roles`. */
  createRole(name: string, colour?: number): Promise<RoleSummary>;
  /** Needs `members.roles`. */
  deleteRole(roleId: string, reason?: string): Promise<void>;

  // --- guild ---
  /** Needs `channels.read`. */
  fetchGuild(): Promise<GuildSummary>;

  // --- outside Discord ---
  /**
   * Fetches from one of the hostnames declared in your module.json.
   *
   * https only, redirects refused, 10 second timeout, response capped at 100KB. The host list
   * comes from your manifest, so you cannot widen it at runtime. Needs `http`.
   */
  fetch(url: string, init?: { method?: string; body?: string }): Promise<HttpResponse>;

  /**
   * The escape hatch: a raw Discord API request, for anything the SDK does not cover.
   *
   * Core injects the token and refuses any route not scoped to this server, so this is
   * "anything within this guild", not "anything". Needs `discord.raw`, which the consent
   * screen calls out loudly — expect fewer installs if you ask for it.
   */
  raw(method: string, path: string, body?: unknown): Promise<unknown>;
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

export interface VoiceInfo {
  member: MemberInfo;
  /** Null when they left voice entirely. */
  channelId: string | null;
  previousChannelId: string | null;
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

export interface VoiceEventContext extends Actions {
  readonly guildId: string;
  readonly guildName: string;
  readonly voice: VoiceInfo;
}

export type CommandHandler = (ctx: CommandContext) => void | Promise<void>;

export interface EventHandlers {
  /** Needs `events.guild`, and the bot running with the members intent. */
  memberJoin?: (ctx: MemberEventContext) => void | Promise<void>;
  /** Needs `events.guild`, and the bot running with the members intent. */
  memberLeave?: (ctx: MemberEventContext) => void | Promise<void>;
  /** Needs `messages.read`, and the bot running with the message content intent. */
  messageCreate?: (ctx: MessageEventContext) => void | Promise<void>;
  /** Needs `messages.read`. */
  messageDelete?: (ctx: MessageEventContext) => void | Promise<void>;
  /** Needs `voice.read`. */
  voiceStateUpdate?: (ctx: VoiceEventContext) => void | Promise<void>;
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

    /** Read capabilities come back as JSON strings; this is the one place they are parsed. */
    async function callJson<T>(op: string, payload?: Record<string, unknown>): Promise<T> {
      const raw = await call(op, payload);
      if (raw === null) throw new Error(`'${op}' returned nothing.`);
      return JSON.parse(raw) as T;
    }

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
        return (await callJson<{ id: string }>('message.send', { channelId, content })).id;
      },
      async editMessage(channelId, messageId, content) {
        await call('message.edit', { channelId, messageId, content });
      },
      async replyToMessage(channelId, messageId, content) {
        const sent = await callJson<{ id: string }>('message.reply', { channelId, messageId, content });
        return sent.id;
      },
      async deleteMessage(channelId, messageId) {
        await call('message.delete', { channelId, messageId });
      },
      async pinMessage(channelId, messageId, pinned = true) {
        await call('message.pin', { channelId, messageId, pinned });
      },
      async fetchMessage(channelId, messageId) {
        return callJson<MessageSummary>('message.fetch', { channelId, messageId });
      },
      async fetchMessages(channelId, limit = 50) {
        return callJson<MessageSummary[]>('message.fetchMany', { channelId, limit });
      },

      async addReaction(channelId, messageId, emoji) {
        await call('reaction.add', { channelId, messageId, emoji });
      },
      async removeReaction(channelId, messageId, emoji) {
        await call('reaction.remove', { channelId, messageId, emoji });
      },

      async fetchMember(userId) {
        return callJson<MemberSummary>('member.fetch', { userId });
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
      async unbanMember(userId, reason) {
        await call('member.unban', { userId, reason: reason ?? '' });
      },
      async setNickname(userId, nickname) {
        await call('member.setNickname', { userId, nickname });
      },
      async addRole(userId, roleId) {
        await call('member.addRole', { userId, roleId });
      },
      async removeRole(userId, roleId) {
        await call('member.removeRole', { userId, roleId });
      },

      async listChannels() {
        return callJson<ChannelSummary[]>('channel.list');
      },
      async fetchChannel(channelId) {
        return callJson<ChannelSummary>('channel.fetch', { channelId });
      },
      async createChannel(name, type = 'text', parentId) {
        return callJson<ChannelSummary>('channel.create', {
          name,
          channelType: type,
          parentId: parentId ?? '',
        });
      },
      async deleteChannel(channelId, reason) {
        await call('channel.delete', { channelId, reason: reason ?? '' });
      },
      async setChannelTopic(channelId, topic) {
        await call('channel.setTopic', { channelId, topic });
      },
      async setSlowmode(channelId, seconds) {
        await call('channel.setSlowmode', { channelId, seconds });
      },

      async listRoles() {
        return callJson<RoleSummary[]>('role.list');
      },
      async createRole(name, colour = 0) {
        return callJson<RoleSummary>('role.create', { name, colour });
      },
      async deleteRole(roleId, reason) {
        await call('role.delete', { roleId, reason: reason ?? '' });
      },

      async fetchGuild() {
        return callJson<GuildSummary>('guild.fetch');
      },

      async fetch(url, init = {}) {
        return callJson<HttpResponse>('http.fetch', {
          url,
          method: init.method ?? 'GET',
          body: init.body ?? null,
        });
      },

      async raw(method, path, body) {
        return callJson<unknown>('discord.raw', { method, path, body: body ?? null });
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

      if (eventName === 'messageCreate' || eventName === 'messageDelete') {
        const handler = config.events?.[eventName];
        if (!handler) return;
        await handler({ ...base, message: data.message as MessageInfo });
        return;
      }

      if (eventName === 'voiceStateUpdate') {
        const handler = config.events?.voiceStateUpdate;
        if (!handler) return;
        await handler({ ...base, voice: data.voice as VoiceInfo });
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
