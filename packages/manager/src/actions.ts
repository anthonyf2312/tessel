/**
 * What core can do in Discord on a module's behalf.
 *
 * The manager depends on this interface rather than on discord.js, which keeps every
 * permission and guild-scoping decision testable without a gateway connection. apps/bot
 * provides the real implementation; tests provide a recording fake.
 *
 * Every method takes `guildId` first, and the manager always passes the guild from the
 * calling context — never a value the module supplied. That is what stops a module acting on
 * a server it was not invoked from.
 */

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

export interface DiscordActions {
  // messages
  sendMessage(guildId: string, channelId: string, content: string): Promise<string>;
  editMessage(guildId: string, channelId: string, messageId: string, content: string): Promise<void>;
  replyToMessage(guildId: string, channelId: string, messageId: string, content: string): Promise<string>;
  deleteMessage(guildId: string, channelId: string, messageId: string): Promise<void>;
  fetchMessage(guildId: string, channelId: string, messageId: string): Promise<MessageSummary>;
  fetchMessages(guildId: string, channelId: string, limit: number): Promise<MessageSummary[]>;
  pinMessage(guildId: string, channelId: string, messageId: string, pinned: boolean): Promise<void>;

  // reactions
  addReaction(guildId: string, channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(guildId: string, channelId: string, messageId: string, emoji: string): Promise<void>;

  // members
  fetchMember(guildId: string, userId: string): Promise<MemberSummary>;
  timeoutMember(guildId: string, userId: string, durationMs: number, reason?: string): Promise<void>;
  kickMember(guildId: string, userId: string, reason?: string): Promise<void>;
  banMember(guildId: string, userId: string, reason?: string): Promise<void>;
  unbanMember(guildId: string, userId: string, reason?: string): Promise<void>;
  setNickname(guildId: string, userId: string, nickname: string): Promise<void>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<void>;

  // channels
  listChannels(guildId: string): Promise<ChannelSummary[]>;
  fetchChannel(guildId: string, channelId: string): Promise<ChannelSummary>;
  createChannel(guildId: string, name: string, type: string, parentId?: string): Promise<ChannelSummary>;
  deleteChannel(guildId: string, channelId: string, reason?: string): Promise<void>;
  setChannelTopic(guildId: string, channelId: string, topic: string): Promise<void>;
  setSlowmode(guildId: string, channelId: string, seconds: number): Promise<void>;

  // roles
  listRoles(guildId: string): Promise<RoleSummary[]>;
  createRole(guildId: string, name: string, colour?: number): Promise<RoleSummary>;
  deleteRole(guildId: string, roleId: string, reason?: string): Promise<void>;

  // guild
  fetchGuild(guildId: string): Promise<GuildSummary>;

  /**
   * The escape hatch. Core injects the token and refuses any route that is not scoped to this
   * guild, so `discord.raw` is "anything within this server", not "anything".
   */
  rawRequest(
    guildId: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<unknown>;
}

/**
 * Which permission each capability requires. A capability absent from this table cannot be
 * reached at all — the manager refuses unknown ops rather than defaulting to allowed.
 */
export const OP_PERMISSIONS: Readonly<Record<string, string>> = {
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',

  'message.send': 'messages.send',
  'message.edit': 'messages.send',
  'message.reply': 'messages.send',
  'message.delete': 'messages.manage',
  'message.pin': 'messages.manage',
  'message.fetch': 'messages.read',
  'message.fetchMany': 'messages.read',

  'reaction.add': 'reactions',
  'reaction.remove': 'reactions',

  'member.fetch': 'members.read',
  'member.timeout': 'members.moderate',
  'member.kick': 'members.moderate',
  'member.ban': 'members.ban',
  'member.unban': 'members.ban',
  'member.setNickname': 'members.roles',
  'member.addRole': 'members.roles',
  'member.removeRole': 'members.roles',

  'channel.list': 'channels.read',
  'channel.fetch': 'channels.read',
  'channel.create': 'channels.manage',
  'channel.delete': 'channels.manage',
  'channel.setTopic': 'channels.manage',
  'channel.setSlowmode': 'channels.manage',

  'role.list': 'members.read',
  'role.create': 'members.roles',
  'role.delete': 'members.roles',

  'guild.fetch': 'channels.read',

  'http.fetch': 'http',
  'discord.raw': 'discord.raw',
};

/** Which permission a module must hold to be told about each event. */
export const EVENT_PERMISSIONS: Readonly<Record<string, string>> = {
  memberJoin: 'events.guild',
  memberLeave: 'events.guild',
  messageCreate: 'messages.read',
  messageDelete: 'messages.read',
  voiceStateUpdate: 'voice.read',
};

export type ModuleEvent = keyof typeof EVENT_PERMISSIONS | string;
