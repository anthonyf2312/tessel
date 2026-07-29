/**
 * Components V2 helpers.
 *
 * Every reply goes through here for one reason beyond consistency: `allowedMentions` is forced
 * to parse nothing. CV2 text displays will happily ping @everyone and any role they mention,
 * and module authors write the text — so the mention suppression cannot be left to a caller
 * remembering it.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
} from 'discord.js';

/** Papaya, matching the site. */
export const ACCENT = 0xff6b2b;
export const DANGER = 0xff3b30;
export const NEUTRAL = 0x8f8d88;

export function panel(accentColor: number, ...text: string[]): ContainerBuilder {
  const container = new ContainerBuilder().setAccentColor(accentColor);
  for (const line of text) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(line));
  }
  return container;
}

export function separator(container: ContainerBuilder): ContainerBuilder {
  return container.addSeparatorComponents(new SeparatorBuilder());
}

export function buttons(container: ContainerBuilder, ...items: ButtonBuilder[]): ContainerBuilder {
  return container.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(...items),
  );
}

export function button(
  customId: string,
  label: string,
  style: ButtonStyle = ButtonStyle.Secondary,
): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

type Repliable = ChatInputCommandInteraction | MessageComponentInteraction;

export async function reply(
  interaction: Repliable,
  container: ContainerBuilder,
  options: { ephemeral?: boolean } = {},
): Promise<void> {
  const payload = {
    components: [container],
    flags: options.ephemeral
      ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      : MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] as never[] },
  };

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 });
    return;
  }

  await interaction.reply(payload);
}

/** Plain text is never sent to users on failure — this keeps the wording consistent. */
export function errorPanel(message: string): ContainerBuilder {
  return panel(DANGER, `**Something went wrong**\n${message}`);
}
