/**
 * The real implementation of the capabilities modules ask for.
 *
 * The manager has already checked that the module holds the permission and has substituted the
 * guild from the calling context. This layer re-derives everything from that guild anyway:
 * channels are fetched *through* the guild, so a channel id belonging to another server simply
 * does not resolve. Two independent checks, same as the sandbox.
 */
import { PermissionFlagsBits, type Client, type Guild } from 'discord.js';
import type { DiscordActions } from '@tessel/manager';

/** Discord's own cap on a timeout. */
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
const MAX_CONTENT = 2000;

/**
 * Module-authored text may mention users — a welcome message pinging the person who joined is
 * the whole point — but never roles and never @everyone. A module that could ping everyone
 * would be a spam vector in every server that installed it.
 */
const ALLOWED_MENTIONS = { parse: ['users'] as const };

export function createDiscordActions(client: Client): DiscordActions {
  async function guildOf(guildId: string): Promise<Guild> {
    const guild = await client.guilds.fetch(guildId);
    if (!guild) throw new Error('This bot is no longer in that server.');
    return guild;
  }

  /** Resolving through the guild is what makes a cross-guild channel id fail. */
  async function textChannel(guildId: string, channelId: string) {
    const guild = await guildOf(guildId);
    const channel = await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) throw new Error('That channel does not exist in this server.');
    if (!channel.isTextBased()) throw new Error('That channel cannot receive messages.');
    return channel;
  }

  async function memberOf(guildId: string, userId: string) {
    const guild = await guildOf(guildId);
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) throw new Error('That member is not in this server.');
    return member;
  }

  return {
    async sendMessage(guildId, channelId, content) {
      const trimmed = String(content).slice(0, MAX_CONTENT);
      if (trimmed.trim().length === 0) throw new Error('Refusing to send an empty message.');

      const channel = await textChannel(guildId, channelId);
      await channel.send({ content: trimmed, allowedMentions: ALLOWED_MENTIONS });
    },

    async deleteMessage(guildId, channelId, messageId) {
      const channel = await textChannel(guildId, channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (!message) throw new Error('That message no longer exists.');
      await message.delete();
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

    async addRole(guildId, userId, roleId) {
      const member = await memberOf(guildId, userId);
      const guild = member.guild;
      const role = await guild.roles.fetch(roleId).catch(() => null);
      if (!role) throw new Error('That role does not exist in this server.');
      if (!role.editable) throw new Error('I cannot manage that role — check my role is above it.');
      await member.roles.add(role);
    },

    async removeRole(guildId, userId, roleId) {
      const member = await memberOf(guildId, userId);
      const role = await member.guild.roles.fetch(roleId).catch(() => null);
      if (!role) throw new Error('That role does not exist in this server.');
      if (!role.editable) throw new Error('I cannot manage that role — check my role is above it.');
      await member.roles.remove(role);
    },
  };
}
