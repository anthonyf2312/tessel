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
import { Client, Events, GatewayIntentBits, type Interaction } from 'discord.js';
import { TesselStore } from '@tessel/db';
import { Supervisor } from '@tessel/sandbox-runtime';
import { ModuleManager } from '@tessel/manager';
import { env } from './core/env.ts';
import { logger } from './core/logger.ts';
import { deployGuildCommands } from './core/deploy.ts';
import { getCatalogue } from './core/catalogue.ts';
import { handleModuleButton, handleModuleCommand } from './commands/module.ts';
import { errorPanel, reply } from './core/ui.ts';

const dataDir = resolve(env.DATA_DIR);
const moduleDir = join(dataDir, 'modules');

await mkdir(moduleDir, { recursive: true });

const store = new TesselStore(join(dataDir, 'tessel.db'));
const supervisor = new Supervisor();
const manager = new ModuleManager({ store, supervisor, bundleDir: moduleDir });
const deps = { manager, store, moduleDir };

/**
 * Intents are deliberately minimal: `Guilds` is all core needs to receive interactions. A
 * module wanting message content does not widen this — it goes through the SDK, which core
 * serves from what it already has. Widening intents is a core change, reviewed as one.
 */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
    await interaction.deferReply();

    const options: Record<string, string | number | boolean> = {};
    for (const option of interaction.options.data) {
      if (option.value !== undefined) options[option.name] = option.value as string | number | boolean;
    }

    const result = await manager.dispatchCommand({
      guildId: interaction.guildId,
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
