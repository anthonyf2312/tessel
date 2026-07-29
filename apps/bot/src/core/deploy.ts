/**
 * Registering slash commands per guild.
 *
 * This is the mechanism behind both headline guarantees. Commands are registered **per guild**,
 * so a module enabled in one server is not merely hidden elsewhere — Discord never told the
 * other servers it exists. And registration happens on demand over REST, so enabling a module
 * publishes its commands without the bot restarting or re-registering globally.
 */
import {
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type APIApplicationCommand,
} from 'discord.js';
import type { ModuleManager } from '@tessel/manager';
import { env } from './env.ts';
import { logger } from './logger.ts';
import { moduleCommand } from '../commands/module.ts';

const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

/**
 * A module's declared access level, as a Discord permission bit.
 *
 * Registering this is UX only — a server admin can override command permissions in Discord's
 * settings — which is exactly why the dispatcher re-checks it at call time.
 */
export const ACCESS_BITS: Record<string, bigint | null> = {
  everyone: null,
  manage_messages: PermissionFlagsBits.ManageMessages,
  moderate_members: PermissionFlagsBits.ModerateMembers,
  manage_channels: PermissionFlagsBits.ManageChannels,
  manage_guild: PermissionFlagsBits.ManageGuild,
  administrator: PermissionFlagsBits.Administrator,
};

/**
 * Publishes the command list for one guild: `/module` plus whatever that guild has enabled.
 *
 * Sent as a bulk overwrite so removing a module removes its commands in the same call —
 * a per-command diff would leave orphans behind whenever an update failed halfway.
 */
export async function deployGuildCommands(
  manager: ModuleManager,
  guildId: string,
): Promise<{ ok: boolean; count: number; error?: string }> {
  const commands = [moduleCommand.toJSON()];
  const seen = new Set<string>(['module']);

  for (const declaration of manager.commandsForGuild(guildId)) {
    // `/module` is core's. A module trying to claim it, or a name another enabled module
    // already took, is skipped rather than allowed to shadow anything.
    if (seen.has(declaration.name)) {
      logger.warn(
        { guildId, command: declaration.name, moduleId: declaration.moduleId },
        'Skipping duplicate command name.',
      );
      continue;
    }
    seen.add(declaration.name);

    const builder = new SlashCommandBuilder()
      .setName(declaration.name)
      .setDescription(declaration.description);

    const required = ACCESS_BITS[declaration.restrictTo] ?? null;
    if (required !== null) builder.setDefaultMemberPermissions(required);

    commands.push(builder.toJSON());
  }

  try {
    const result = (await rest.put(
      Routes.applicationGuildCommands(env.DISCORD_APPLICATION_ID, guildId),
      { body: commands },
    )) as APIApplicationCommand[];

    logger.info({ guildId, count: result.length }, 'Guild commands deployed.');
    return { ok: true, count: result.length };
  } catch (error) {
    logger.error({ err: error, guildId }, 'Failed to deploy guild commands.');
    return {
      ok: false,
      count: 0,
      error: 'Discord refused the command update. Check the bot has the applications.commands scope.',
    };
  }
}
