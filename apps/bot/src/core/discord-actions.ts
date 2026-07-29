/**
 * The real implementation of the capabilities modules ask for.
 *
 * The manager has already checked that the module holds the permission and has substituted the
 * guild from the calling context. This layer re-derives everything from that guild anyway:
 * channels, members and roles are fetched *through* the guild, so an id belonging to another
 * server simply does not resolve. Two independent checks, same as the sandbox.
 */
import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type GuildBasedChannel,
} from 'discord.js';
import { checkRawRoute } from './raw-route.ts';
import type {
  ChannelSummary,
  DiscordActions,
  GuildSummary,
  MemberSummary,
  MessageSummary,
  RoleSummary,
} from '@tessel/manager';

/** Discord's own cap on a timeout. */
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const MAX_CONTENT = 2000;
const MAX_FETCH = 100;

/**
 * Module-authored text may mention users — a welcome message pinging the person who joined is
 * the whole point — but never roles and never @everyone. A module that could ping everyone
 * would be a spam vector in every server that installed it.
 */
const ALLOWED_MENTIONS = { parse: ['users'] as const };

function channelSummary(channel: GuildBasedChannel): ChannelSummary {
  return {
    id: channel.id,
    name: channel.name,
    type: ChannelType[channel.type] ?? String(channel.type),
    topic: 'topic' in channel ? ((channel.topic as string | null) ?? null) : null,
    parentId: channel.parentId,
  };
}

export function createDiscordActions(client: Client): DiscordActions {
  async function guildOf(guildId: string): Promise<Guild> {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) throw new Error('This bot is no longer in that server.');
    return guild;
  }

  /** Resolving through the guild is what makes a cross-guild id fail. */
  async function anyChannel(guildId: string, channelId: string): Promise<GuildBasedChannel> {
    const guild = await guildOf(guildId);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error('That channel does not exist in this server.');
    return channel;
  }

  async function textChannel(guildId: string, channelId: string) {
    const channel = await anyChannel(guildId, channelId);
    if (!channel.isTextBased()) throw new Error('That channel cannot hold messages.');
    return channel;
  }

  async function memberOf(guildId: string, userId: string) {
    const guild = await guildOf(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) throw new Error('That member is not in this server.');
    return member;
  }

  async function roleOf(guildId: string, roleId: string) {
    const guild = await guildOf(guildId);
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) throw new Error('That role does not exist in this server.');
    return role;
  }

  function requireContent(content: string): string {
    const trimmed = String(content).slice(0, MAX_CONTENT);
    if (trimmed.trim().length === 0) throw new Error('Refusing to send an empty message.');
    return trimmed;
  }

  return {
    // --- messages -----------------------------------------------------------------------

    async sendMessage(guildId, channelId, content) {
      const channel = await textChannel(guildId, channelId);
      const sent = await channel.send({
        content: requireContent(content),
        allowedMentions: ALLOWED_MENTIONS,
      });
      return sent.id;
    },

    async editMessage(guildId, channelId, messageId, content) {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');

      // Discord only permits editing your own messages; saying so beats a raw API error.
      if (message.author.id !== client.user?.id) {
        throw new Error('I can only edit messages I sent myself.');
      }

      await message.edit({ content: requireContent(content), allowedMentions: ALLOWED_MENTIONS });
    },

    async replyToMessage(guildId, channelId, messageId, content) {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');

      const sent = await message.reply({
        content: requireContent(content),
        allowedMentions: ALLOWED_MENTIONS,
      });
      return sent.id;
    },

    async deleteMessage(guildId, channelId, messageId) {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');
      await message.delete();
    },

    async pinMessage(guildId, channelId, messageId, pinned) {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');
      await (pinned ? message.pin() : message.unpin());
    },

    async fetchMessage(guildId, channelId, messageId): Promise<MessageSummary> {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');

      return {
        id: message.id,
        channelId: message.channelId,
        content: message.content,
        authorId: message.author.id,
        createdAt: message.createdTimestamp,
      };
    },

    async fetchMessages(guildId, channelId, limit): Promise<MessageSummary[]> {
      const channel = await textChannel(guildId, channelId);
      const capped = Math.min(Math.max(Math.floor(limit) || 50, 1), MAX_FETCH);
      const messages = await channel.messages.fetch({ limit: capped });

      return [...messages.values()].map((message) => ({
        id: message.id,
        channelId: message.channelId,
        content: message.content,
        authorId: message.author.id,
        createdAt: message.createdTimestamp,
      }));
    },

    // --- reactions ----------------------------------------------------------------------

    async addReaction(guildId, channelId, messageId, emoji) {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');
      await message.react(emoji);
    },

    async removeReaction(guildId, channelId, messageId, emoji) {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');

      const reaction = message.reactions.cache.find(
        (item) => item.emoji.name === emoji || item.emoji.identifier === emoji,
      );
      if (reaction) await reaction.users.remove(client.user?.id);
    },

    // --- members ------------------------------------------------------------------------

    async fetchMember(guildId, userId): Promise<MemberSummary> {
      const member = await memberOf(guildId, userId);
      return {
        id: member.id,
        username: member.user.username,
        displayName: member.displayName,
        bot: member.user.bot,
        createdAt: member.user.createdTimestamp,
        joinedAt: member.joinedTimestamp,
        roles: [...member.roles.cache.keys()],
      };
    },

    async timeoutMember(guildId, userId, durationMs, reason) {
      const member = await memberOf(guildId, userId);
      const duration = Math.min(Math.max(Math.floor(durationMs), 0), MAX_TIMEOUT_MS);

      // `moderatable` accounts for role hierarchy and the bot's own permissions. Checking it
      // turns an unhandled API error into something the module author can act on.
      if (!member.moderatable) {
        throw new Error('I cannot time out that member — check my role is above theirs.');
      }
      await member.timeout(duration, reason || undefined);
    },

    async kickMember(guildId, userId, reason) {
      const member = await memberOf(guildId, userId);
      if (!member.kickable) {
        throw new Error('I cannot kick that member — check my role is above theirs.');
      }
      await member.kick(reason || undefined);
    },

    async banMember(guildId, userId, reason) {
      const guild = await guildOf(guildId);
      const me = await guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.BanMembers)) {
        throw new Error('I do not have the Ban Members permission in this server.');
      }
      await guild.bans.create(userId, { reason: reason || undefined });
    },

    async unbanMember(guildId, userId, reason) {
      const guild = await guildOf(guildId);
      await guild.bans.remove(userId, reason || undefined);
    },

    async setNickname(guildId, userId, nickname) {
      const member = await memberOf(guildId, userId);
      if (!member.manageable) {
        throw new Error('I cannot rename that member — check my role is above theirs.');
      }
      await member.setNickname(nickname || null);
    },

    async addRole(guildId, userId, roleId) {
      const member = await memberOf(guildId, userId);
      const role = await roleOf(guildId, roleId);
      if (!role.editable) throw new Error('I cannot manage that role — check my role is above it.');
      await member.roles.add(role);
    },

    async removeRole(guildId, userId, roleId) {
      const member = await memberOf(guildId, userId);
      const role = await roleOf(guildId, roleId);
      if (!role.editable) throw new Error('I cannot manage that role — check my role is above it.');
      await member.roles.remove(role);
    },

    // --- channels -----------------------------------------------------------------------

    async listChannels(guildId): Promise<ChannelSummary[]> {
      const guild = await guildOf(guildId);
      const channels = await guild.channels.fetch();
      return [...channels.values()].filter(Boolean).map((c) => channelSummary(c!));
    },

    async fetchChannel(guildId, channelId): Promise<ChannelSummary> {
      return channelSummary(await anyChannel(guildId, channelId));
    },

    async createChannel(guildId, name, type, parentId): Promise<ChannelSummary> {
      const guild = await guildOf(guildId);
      const kind =
        type === 'voice'
          ? ChannelType.GuildVoice
          : type === 'category'
            ? ChannelType.GuildCategory
            : ChannelType.GuildText;

      const created = await guild.channels.create({
        name,
        type: kind,
        parent: parentId || undefined,
      });
      return channelSummary(created);
    },

    async deleteChannel(guildId, channelId, reason) {
      const channel = await anyChannel(guildId, channelId);
      await channel.delete(reason || undefined);
    },

    async setChannelTopic(guildId, channelId, topic) {
      const channel = await anyChannel(guildId, channelId);
      if (!('setTopic' in channel)) throw new Error('That channel has no topic.');
      await (channel as { setTopic: (t: string) => Promise<unknown> }).setTopic(topic);
    },

    async setSlowmode(guildId, channelId, seconds) {
      const channel = await anyChannel(guildId, channelId);
      if (!('setRateLimitPerUser' in channel)) {
        throw new Error('That channel does not support slowmode.');
      }
      const capped = Math.min(Math.max(Math.floor(seconds) || 0, 0), 21600);
      await (channel as { setRateLimitPerUser: (n: number) => Promise<unknown> }).setRateLimitPerUser(capped);
    },

    // --- roles --------------------------------------------------------------------------

    async listRoles(guildId): Promise<RoleSummary[]> {
      const guild = await guildOf(guildId);
      const roles = await guild.roles.fetch();
      return [...roles.values()].map((role) => ({
        id: role.id,
        name: role.name,
        colour: role.color,
        position: role.position,
        managed: role.managed,
      }));
    },

    async createRole(guildId, name, colour): Promise<RoleSummary> {
      const guild = await guildOf(guildId);
      const role = await guild.roles.create({ name, color: colour || undefined });
      return {
        id: role.id,
        name: role.name,
        colour: role.color,
        position: role.position,
        managed: role.managed,
      };
    },

    async deleteRole(guildId, roleId, reason) {
      const role = await roleOf(guildId, roleId);
      if (!role.editable) throw new Error('I cannot delete that role — check my role is above it.');
      await role.delete(reason || undefined);
    },

    // --- guild --------------------------------------------------------------------------

    async fetchGuild(guildId): Promise<GuildSummary> {
      const guild = await guildOf(guildId);
      return {
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount,
        ownerId: guild.ownerId,
        iconUrl: guild.iconURL(),
      };
    },

    // --- the escape hatch ---------------------------------------------------------------

    /**
     * `discord.raw` means "anything within this server", not "anything".
     *
     * The route is checked against the calling guild before the token goes anywhere near it.
     * Guild routes must name this guild; channel and message routes are resolved through the
     * guild first, so an id from another server fails to resolve. Everything else — users,
     * applications, global endpoints — is refused outright, because none of it is guild-scoped
     * and a module has no business there.
     */
    async rawRequest(guildId, method, path, body) {
      const check = checkRawRoute(guildId, method, path);
      if (!check.ok) throw new Error(check.error);

      // A channel route is only allowed once the channel is proven to live in this guild.
      if (check.verifyChannelId) await anyChannel(guildId, check.verifyChannelId);

      const rest = client.rest;
      const options = { body: body ?? undefined } as { body?: unknown };

      switch (method.toUpperCase()) {
        case 'GET':
          return rest.get(check.route);
        case 'POST':
          return rest.post(check.route, options);
        case 'PATCH':
          return rest.patch(check.route, options);
        case 'PUT':
          return rest.put(check.route, options);
        default:
          return rest.delete(check.route);
      }
    },
  };
}
