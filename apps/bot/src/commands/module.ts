/**
 * `/module` — install, enable, disable and inspect modules.
 *
 * Two confirmation flows live here, and both exist because the sandbox constrains what a
 * module *can* do but not what it *intends* to do:
 *
 *   - an unsigned module is never persisted until someone has read a warning saying plainly
 *     that nobody reviewed it and it could be malware;
 *   - no module runs until an admin has approved its permission list in plain language.
 *
 * Everything an untrusted repository produces is extracted and bundled in a temporary
 * directory. Nothing reaches the module store until the person installing it says yes.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from 'discord.js';
import { PERMISSIONS, permission as permissionDef, type Manifest } from '@tessel/protocol';
import { createGitHubClient, installModule, type InstalledArtifact } from '@tessel/installer';
import type { ModuleManager } from '@tessel/manager';
import type { TesselStore } from '@tessel/db';
import { getCatalogue } from '../core/catalogue.ts';
import { deployGuildCommands } from '../core/deploy.ts';
import { env } from '../core/env.ts';
import { logger } from '../core/logger.ts';
import { ACCENT, DANGER, NEUTRAL, button, buttons, errorPanel, panel, reply, separator } from '../core/ui.ts';

export const moduleCommand = new SlashCommandBuilder()
  .setName('module')
  .setDescription('Add and manage modules for this server')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('install')
      .setDescription('Install a module from GitHub')
      .addStringOption((option) =>
        option.setName('url').setDescription('The module’s GitHub URL').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('load')
      .setDescription('Turn on an installed module in this server')
      .addStringOption((option) =>
        option.setName('module').setDescription('Module name or id').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unload')
      .setDescription('Turn off a module in this server')
      .addStringOption((option) =>
        option.setName('module').setDescription('Module name or id').setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show this server’s modules'))
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show what a module is and what it can do')
      .addStringOption((option) =>
        option.setName('module').setDescription('Module name or id').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('uninstall')
      .setDescription('Remove a module from this server, including its stored data')
      .addStringOption((option) =>
        option.setName('module').setDescription('Module name or id').setRequired(true),
      ),
  );

interface Deps {
  manager: ModuleManager;
  store: TesselStore;
  moduleDir: string;
}

/** Artifacts awaiting a confirmation click. Short-lived and in-memory by design. */
interface PendingInstall {
  artifact: InstalledArtifact;
  userId: string;
  guildId: string;
  expiresAt: number;
}

const pendingInstalls = new Map<string, PendingInstall>();
const PENDING_TTL_MS = 5 * 60_000;

function stashPending(pending: Omit<PendingInstall, 'expiresAt'>): string {
  // Sweep on write; there is no background timer to leak.
  const now = Date.now();
  for (const [key, value] of pendingInstalls) {
    if (value.expiresAt < now) pendingInstalls.delete(key);
  }

  const token = `${pending.artifact.moduleId}@${now.toString(36)}`;
  pendingInstalls.set(token, { ...pending, expiresAt: now + PENDING_TTL_MS });
  return token;
}

function permissionLines(manifest: Manifest): string {
  if (manifest.permissions.length === 0) return '• Asks for no permissions at all.';

  const known = new Set(manifest.permissions);
  const lines = PERMISSIONS.filter((entry) => known.has(entry.id)).map((entry) => {
    const marker = entry.dangerous ? '⚠️' : '•';
    return `${marker} **${entry.label}** — ${entry.consentText}`;
  });

  if (manifest.network.length > 0) {
    lines.push(`⚠️ **Sends data to** — ${manifest.network.map((host) => `\`${host}\``).join(', ')}`);
  }

  return lines.join('\n');
}

function findModule(store: TesselStore, guildId: string, needle: string) {
  const wanted = needle.trim().toLowerCase();

  for (const guildModule of store.listGuildModules(guildId)) {
    const artifact = store.getArtifact(guildModule.moduleId, guildModule.version);
    if (!artifact) continue;

    const manifest = JSON.parse(artifact.manifestJson) as Manifest;
    if (
      guildModule.moduleId.toLowerCase() === wanted ||
      manifest.name.toLowerCase() === wanted ||
      guildModule.moduleId.toLowerCase().endsWith(`.${wanted}`)
    ) {
      return { guildModule, artifact, manifest };
    }
  }

  return null;
}

export async function handleModuleCommand(
  interaction: ChatInputCommandInteraction,
  deps: Deps,
): Promise<void> {
  if (!interaction.inGuild()) {
    await reply(interaction, errorPanel('Modules are per server — use this in a server.'), {
      ephemeral: true,
    });
    return;
  }

  switch (interaction.options.getSubcommand()) {
    case 'install':
      return install(interaction, deps);
    case 'load':
      return load(interaction, deps);
    case 'unload':
      return unload(interaction, deps);
    case 'list':
      return list(interaction, deps);
    case 'info':
      return info(interaction, deps);
    case 'uninstall':
      return uninstall(interaction, deps);
    default:
      await reply(interaction, errorPanel('Unknown subcommand.'), { ephemeral: true });
  }
}

async function install(interaction: ChatInputCommandInteraction, deps: Deps): Promise<void> {
  const url = interaction.options.getString('url', true);
  const guildId = interaction.guildId!;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const catalogue = await getCatalogue();
  const isListed = catalogue?.entries.some((entry) => url.includes(`${entry.moduleId}`)) ?? false;

  if (env.RESTRICT_UNLISTED_INSTALLS && !isListed && !env.OWNER_IDS.includes(interaction.user.id)) {
    await reply(
      interaction,
      errorPanel('This bot only installs modules from its catalogue. Ask the bot owner to review it.'),
      { ephemeral: true },
    );
    return;
  }

  // Untrusted code is unpacked here, never in the module store, and thrown away unless the
  // install is confirmed.
  const workDir = await mkdtemp(join(tmpdir(), 'tessel-install-'));

  try {
    const result = await installModule({
      url,
      github: createGitHubClient({ token: env.GITHUB_TOKEN }),
      catalogue,
      workDir,
    });

    if (!result.ok) {
      await reply(
        interaction,
        panel(
          DANGER,
          '**Could not install that module**',
          result.errors.map((error) => `• ${error}`).join('\n'),
        ),
        { ephemeral: true },
      );
      return;
    }

    const { artifact } = result;

    if (artifact.trust === 'signed') {
      await deps.manager.saveArtifact({ ...artifact, manifest: artifact.manifest });
      await reply(interaction, installedPanel(artifact, true), { ephemeral: true });
      return;
    }

    const token = stashPending({ artifact, userId: interaction.user.id, guildId });

    await reply(
      interaction,
      buttons(
        separator(
          panel(
            DANGER,
            '## ⚠️ This module is not signed',
            'Nobody has reviewed this code. **It could be malware.** It can do anything the ' +
              'permissions below allow — including reading your members’ messages and sending ' +
              'them to a server its author controls.',
            'Only continue if you personally trust whoever wrote it.',
          ),
        )
          .addTextDisplayComponents(
            (text) =>
              text.setContent(
                `**${artifact.manifest.name}** v${artifact.version} by ${artifact.manifest.author}\n` +
                  `${artifact.manifest.description}\n\n` +
                  `**It is asking for:**\n${permissionLines(artifact.manifest)}`,
              ),
          ),
        button(`mod:install-confirm:${interaction.user.id}:${token}`, 'Install anyway', ButtonStyle.Danger),
        button(`mod:install-cancel:${interaction.user.id}:${token}`, 'Cancel', ButtonStyle.Secondary),
      ),
      { ephemeral: true },
    );
  } catch (error) {
    logger.error({ err: error, url }, 'Install failed unexpectedly.');
    await reply(interaction, errorPanel('That install failed. The details are in the bot’s logs.'), {
      ephemeral: true,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function installedPanel(artifact: InstalledArtifact, signed: boolean) {
  return panel(
    signed ? ACCENT : NEUTRAL,
    `## Installed ${artifact.manifest.name}`,
    `v${artifact.version} by ${artifact.manifest.author} — ${signed ? '**Reviewed**' : '**Unreviewed**'}`,
    artifact.manifest.description,
    `Pinned to commit \`${artifact.commitSha.slice(0, 10)}\`.`,
    `Turn it on with \`/module load ${artifact.manifest.name.toLowerCase()}\`.`,
  );
}

async function load(interaction: ChatInputCommandInteraction, deps: Deps): Promise<void> {
  const guildId = interaction.guildId!;
  const found = findModule(deps.store, guildId, interaction.options.getString('module', true));

  if (!found) {
    await reply(
      interaction,
      errorPanel('No module by that name is installed here. Install it first with `/module install`.'),
      { ephemeral: true },
    );
    return;
  }

  if (found.guildModule.enabled) {
    await reply(interaction, panel(NEUTRAL, `**${found.manifest.name}** is already on in this server.`), {
      ephemeral: true,
    });
    return;
  }

  await reply(
    interaction,
    buttons(
      panel(
        ACCENT,
        `## Turn on ${found.manifest.name}?`,
        found.manifest.description,
        `**This will let it:**\n${permissionLines(found.manifest)}`,
        found.artifact.trust === 'signed'
          ? '_This module has been reviewed and signed._'
          : '_⚠️ Nobody has reviewed this module._',
      ),
      button(
        `mod:enable:${interaction.user.id}:${found.guildModule.moduleId}`,
        'Approve and turn on',
        ButtonStyle.Success,
      ),
      button(`mod:cancel:${interaction.user.id}:x`, 'Cancel', ButtonStyle.Secondary),
    ),
    { ephemeral: true },
  );
}

async function unload(interaction: ChatInputCommandInteraction, deps: Deps): Promise<void> {
  const guildId = interaction.guildId!;
  const found = findModule(deps.store, guildId, interaction.options.getString('module', true));

  if (!found?.guildModule.enabled) {
    await reply(interaction, errorPanel('That module is not switched on here.'), { ephemeral: true });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await deps.manager.disable(guildId, found.guildModule.moduleId);
  await deployGuildCommands(deps.manager, guildId);

  await reply(
    interaction,
    panel(NEUTRAL, `**${found.manifest.name}** is off. Its commands are gone from this server.`),
    { ephemeral: true },
  );
}

async function list(interaction: ChatInputCommandInteraction, deps: Deps): Promise<void> {
  const guildId = interaction.guildId!;
  const installed = deps.store.listGuildModules(guildId);

  if (installed.length === 0) {
    await reply(
      interaction,
      panel(
        NEUTRAL,
        '## No modules here yet',
        'Tessel does nothing until you add something. Browse modules at ' +
          'https://anthonyf2312.github.io/modules.html, then install one with `/module install <url>`.',
      ),
      { ephemeral: true },
    );
    return;
  }

  const lines = installed.map((guildModule) => {
    const artifact = deps.store.getArtifact(guildModule.moduleId, guildModule.version);
    const manifest = artifact ? (JSON.parse(artifact.manifestJson) as Manifest) : null;
    const trust = artifact?.trust === 'signed' ? 'Reviewed' : '⚠️ Unreviewed';
    const state = guildModule.enabled ? '**On**' : 'Off';
    return `• ${state} — **${manifest?.name ?? guildModule.moduleId}** v${guildModule.version} · ${trust}`;
  });

  await reply(interaction, panel(ACCENT, '## Modules in this server', lines.join('\n')), {
    ephemeral: true,
  });
}

async function info(interaction: ChatInputCommandInteraction, deps: Deps): Promise<void> {
  const found = findModule(deps.store, interaction.guildId!, interaction.options.getString('module', true));

  if (!found) {
    await reply(interaction, errorPanel('No module by that name is installed here.'), {
      ephemeral: true,
    });
    return;
  }

  const { manifest, artifact, guildModule } = found;
  const commands = manifest.commands.map((command) => `\`/${command.name}\``).join(' ') || '_none_';

  await reply(
    interaction,
    panel(
      artifact.trust === 'signed' ? ACCENT : NEUTRAL,
      `## ${manifest.name}`,
      `v${manifest.version} by ${manifest.author} — ${
        artifact.trust === 'signed' ? '**Reviewed**' : '**⚠️ Unreviewed**'
      }`,
      manifest.description,
      `**Commands:** ${commands}`,
      `**Allowed to:**\n${permissionLines(manifest)}`,
      `**State:** ${guildModule.enabled ? 'on' : 'off'} · pinned to \`${artifact.commitSha.slice(0, 10)}\``,
    ),
    { ephemeral: true },
  );
}

async function uninstall(interaction: ChatInputCommandInteraction, deps: Deps): Promise<void> {
  const guildId = interaction.guildId!;
  const found = findModule(deps.store, guildId, interaction.options.getString('module', true));

  if (!found) {
    await reply(interaction, errorPanel('No module by that name is installed here.'), {
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  await deps.manager.disable(guildId, found.guildModule.moduleId);
  deps.store.uninstallForGuild(guildId, found.guildModule.moduleId);
  await deployGuildCommands(deps.manager, guildId);

  await reply(
    interaction,
    panel(
      NEUTRAL,
      `**${found.manifest.name}** has been removed from this server, along with everything it stored here.`,
      'Other servers using it are unaffected.',
    ),
    { ephemeral: true },
  );
}

/** Button handling for the two confirmation flows. */
export async function handleModuleButton(
  interaction: ButtonInteraction,
  deps: Deps,
): Promise<void> {
  const [, action, ownerId, token] = interaction.customId.split(':');

  // customIds are client-supplied. Anyone can click a button on someone else's panel, so the
  // invoker is pinned into the id and checked rather than trusted.
  if (interaction.user.id !== ownerId) {
    await reply(interaction, errorPanel('That confirmation belongs to someone else.'), {
      ephemeral: true,
    });
    return;
  }

  if (action === 'install-cancel' || action === 'cancel') {
    if (token) pendingInstalls.delete(token);
    await reply(interaction, panel(NEUTRAL, 'Cancelled. Nothing was installed or changed.'), {
      ephemeral: true,
    });
    return;
  }

  if (action === 'install-confirm') {
    const pending = token ? pendingInstalls.get(token) : undefined;
    if (!pending || pending.expiresAt < Date.now()) {
      await reply(
        interaction,
        errorPanel('That confirmation expired. Run `/module install` again.'),
        { ephemeral: true },
      );
      return;
    }

    pendingInstalls.delete(token!);
    await deps.manager.saveArtifact({ ...pending.artifact, manifest: pending.artifact.manifest });

    deps.store.audit({
      guildId: pending.guildId,
      moduleId: pending.artifact.moduleId,
      op: 'module.install-unsigned',
      outcome: 'allowed',
      target: pending.artifact.bundleSha256,
      actorUserId: interaction.user.id,
    });

    await reply(interaction, installedPanel(pending.artifact, false), { ephemeral: true });
    return;
  }

  if (action === 'enable') {
    const moduleId = token!;
    const guildId = interaction.guildId!;
    const guildModule = deps.store.getGuildModule(guildId, moduleId);
    const artifact = guildModule
      ? deps.store.getArtifact(moduleId, guildModule.version)
      : deps.store.getArtifact(moduleId, '');

    if (!artifact) {
      await reply(interaction, errorPanel('That module is no longer installed.'), { ephemeral: true });
      return;
    }

    const manifest = JSON.parse(artifact.manifestJson) as Manifest;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const enabled = await deps.manager.enable({
      guildId,
      moduleId,
      version: artifact.version,
      grantedPermissions: manifest.permissions,
      installedBy: interaction.user.id,
      unsignedAckBy: artifact.trust === 'unsigned' ? interaction.user.id : null,
    });

    if (!enabled.ok) {
      await reply(interaction, errorPanel(enabled.error), { ephemeral: true });
      return;
    }

    const deployed = await deployGuildCommands(deps.manager, guildId);

    await reply(
      interaction,
      panel(
        ACCENT,
        `## ${manifest.name} is on`,
        deployed.ok
          ? `Its commands are live in this server: ${manifest.commands
              .map((command) => `\`/${command.name}\``)
              .join(' ')}`
          : `It is running, but its commands could not be published: ${deployed.error}`,
        'Nothing was restarted.',
      ),
      { ephemeral: true },
    );
  }
}
