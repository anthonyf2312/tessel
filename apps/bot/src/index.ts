/**
 * Tessel — core.
 *
 * This process holds the token, the database and the only discord.js client. Module code runs
 * in separate, locked-down child processes and reaches none of it.
 *
 * Gateway listeners are attached exactly once, here, at boot. Every interaction is resolved
 * through the registry at call time, which is why installing, enabling, updating or removing a
 * module never requires a restart. **Only changes to files under src/core require one.**
 */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Client, Events, GatewayIntentBits, MessageFlags, type Interaction } from 'discord.js';
import { TesselStore } from '@tessel/db';
import { Supervisor } from '@tessel/sandbox-runtime';
import { ModuleManager } from '@tessel/manager';
import { env } from './core/env.ts';
import { logger } from './core/logger.ts';
import { ACCESS_BITS, deployGuildCommands } from './core/deploy.ts';
import { getCatalogue } from './core/catalogue.ts';
import { createDiscordActions } from './core/discord-actions.ts';
import { handleModuleButton, handleModuleCommand } from './commands/module.ts';
import { errorPanel, reply } from './core/ui.ts';

const dataDir = resolve(env.DATA_DIR);
const moduleDir = join(dataDir, 'modules');

await mkdir(moduleDir, { recursive: true });

/**
 * Intents start minimal — `Guilds` is all core needs for interactions — and widen only when
 * an operator opts in, because Discord refuses the login entirely if a privileged intent is
 * requested but not enabled in the Developer Portal.
 *
 * Modules never widen this. A module declaring `messages.read` gets nothing unless the bot
 * was started with the intent that makes those events exist at all.
 */
function intentsFromConfig(): GatewayIntentBits[] {
  const intents = [GatewayIntentBits.Guilds];

  if (env.PRIVILEGED_INTENTS.includes('members')) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  if (env.PRIVILEGED_INTENTS.includes('voice')) {
    intents.push(GatewayIntentBits.GuildVoiceStates);
  }

  if (env.PRIVILEGED_INTENTS.includes('messageContent')) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  }

  return intents;
}

const client = new Client({ intents: intentsFromConfig() });

const store = new TesselStore(join(dataDir, 'tessel.db'));
const supervisor = new Supervisor();
const manager = new ModuleManager({
  store,
  supervisor,
  bundleDir: moduleDir,
  discord: createDiscordActions(client),
});
const deps = { manager, store, moduleDir };

supervisor.onAutoDisabled((moduleId, reason) => {
  logger.error({ moduleId, reason }, 'Module auto-disabled after repeated failures.');
});

client.once(Events.ClientReady, async (ready) => {
  logger.info({ user: ready.user.tag, guilds: ready.guilds.cache.size }, 'Tessel is up.');

  // Warm the catalogue so the first install does not pay for it.
  await getCatalogue();

  // Restart is only for core changes — so on boot, bring back everything that was on.
  for (const [guildId] of ready.guilds.cache) {
    for (const guildModule of store.listGuildModules(guildId)) {
      if (!guildModule.enabled) continue;

      const started = await manager.enable({
        guildId,
        moduleId: guildModule.moduleId,
        version: guildModule.version,
        grantedPermissions: guildModule.grantedPermissions,
        installedBy: guildModule.installedBy,
        unsignedAckBy: guildModule.unsignedAckBy,
      });

      if (!started.ok) {
        logger.error({ guildId, moduleId: guildModule.moduleId, reason: started.error }, 'Could not restore module.');
      }
    }

    await deployGuildCommands(manager, guildId);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  logger.info({ guildId: guild.id }, 'Joined a server; publishing /module.');
  await deployGuildCommands(manager, guild.id);
});

/**
 * Guild events, fanned out to the modules entitled to see them.
 *
 * `dispatchEvent` decides entitlement: enabled in this guild, and holding the permission that
 * event requires. Core does no filtering of its own beyond ignoring its own messages — a
 * module without `messages.read` is never sent a message event at all.
 */
client.on(Events.GuildMemberAdd, (member) => {
  manager.dispatchEvent(member.guild.id, 'memberJoin', {
    member: {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName,
      bot: member.user.bot,
      createdAt: member.user.createdTimestamp,
    },
    memberCount: member.guild.memberCount,
  }, member.guild.name);
});

client.on(Events.GuildMemberRemove, (member) => {
  manager.dispatchEvent(member.guild.id, 'memberLeave', {
    member: {
      id: member.id,
      username: member.user.username,
      displayName: member.displayName ?? member.user.username,
      bot: member.user.bot,
      createdAt: member.user.createdTimestamp,
    },
    memberCount: member.guild.memberCount,
  }, member.guild.name);
});

client.on(Events.MessageCreate, (message) => {
  if (!message.inGuild()) return;
  // Never hand a module the bot's own output — a moderation module reacting to its own alerts
  // is an obvious way to build an infinite loop.
  if (message.author.id === client.user?.id) return;

  manager.dispatchEvent(message.guild.id, 'messageCreate', {
    message: {
      id: message.id,
      channelId: message.channelId,
      content: message.content,
      author: {
        id: message.author.id,
        username: message.author.username,
        displayName: message.member?.displayName ?? message.author.username,
        bot: message.author.bot,
        createdAt: message.author.createdTimestamp,
      },
    },
  }, message.guild.name);
});

client.on(Events.MessageDelete, (message) => {
  if (!message.inGuild()) return;
  if (message.author?.id === client.user?.id) return;

  manager.dispatchEvent(message.guild.id, 'messageDelete', {
    message: {
      id: message.id,
      channelId: message.channelId,
      content: message.content ?? '',
      author: {
        id: message.author?.id ?? '',
        username: message.author?.username ?? 'unknown',
        displayName: message.author?.username ?? 'unknown',
        bot: message.author?.bot ?? false,
        createdAt: message.author?.createdTimestamp ?? 0,
      },
    },
  }, message.guild.name);
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  const guild = after.guild ?? before.guild;
  const member = after.member ?? before.member;
  if (!guild || !member) return;

  manager.dispatchEvent(guild.id, 'voiceStateUpdate', {
    voice: {
      member: {
        id: member.id,
        username: member.user.username,
        displayName: member.displayName,
        bot: member.user.bot,
        createdAt: member.user.createdTimestamp,
      },
      channelId: after.channelId,
      previousChannelId: before.channelId,
    },
  }, guild.name);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {
    if (interaction.isButton() && interaction.customId.startsWith('mod:')) {
      await handleModuleButton(interaction, deps);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'module') {
      await handleModuleCommand(interaction, deps);
      return;
    }

    if (!interaction.inGuild()) return;

    // Anything else belongs to a module. The registry decides which one — and refuses if this
    // server has not enabled it, so a command in one server is unreachable from another.

    // Discord's defaultMemberPermissions is UX: a server admin can override it in settings,
    // so a module command that manages warnings or channels must be re-checked here. Without
    // this, any member could run a module's admin commands.
    const declaration = manager
      .commandsForGuild(interaction.guildId)
      .find((command) => command.name === interaction.commandName);

    const required = declaration ? (ACCESS_BITS[declaration.restrictTo] ?? null) : null;
    if (required !== null) {
      const permissions = interaction.memberPermissions;
      if (!permissions?.has(required)) {
        store.audit({
          guildId: interaction.guildId,
          moduleId: declaration!.moduleId,
          op: `command.${interaction.commandName}`,
          outcome: 'denied',
          actorUserId: interaction.user.id,
        });

        await interaction.reply({
          content: 'You do not have permission to use that command in this server.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    await interaction.deferReply();

    const options: Record<string, string | number | boolean> = {};
    for (const option of interaction.options.data) {
      if (option.value !== undefined) options[option.name] = option.value as string | number | boolean;
    }

    const result = await manager.dispatchCommand({
      guildId: interaction.guildId,
      guildName: interaction.guild?.name ?? '',
      command: interaction.commandName,
      userId: interaction.user.id,
      options,
    });

    await interaction.editReply({
      content: result.ok ? result.content : `That didn't work: ${result.error}`,
      // Module authors write this text. It must never be able to ping anyone.
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    // The error boundary. Details go to the logs; the user gets nothing internal.
    logger.error({ err: error, interaction: interaction.type }, 'Interaction failed.');

    if (interaction.isRepliable() && !interaction.replied) {
      await reply(interaction as never, errorPanel('Something went wrong. It has been logged.'), {
        ephemeral: true,
      }).catch(() => {});
    }
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down.');
  await supervisor.stopAll();
  await client.destroy();
  store.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await client.login(env.DISCORD_TOKEN);
