/**
 * The complete set of capabilities a module can request.
 *
 * This catalogue is the contract behind the consent panel a server admin approves, so every
 * entry carries plain-language text written for someone who is not a developer. If a
 * capability is not listed here, no module can perform it — core has no code path for it.
 *
 * `dangerous: true` marks permissions that can move data off the server or take destructive
 * action; the consent panel renders those separately and more loudly.
 */
export interface PermissionDefinition {
  readonly id: string;
  readonly label: string;
  /** Shown verbatim to the approving admin. Say what the module can do, not how. */
  readonly consentText: string;
  readonly dangerous: boolean;
}

export const PERMISSIONS = [
  {
    id: 'messages.read',
    label: 'Read messages',
    consentText: 'Read the content of messages sent in this server.',
    dangerous: true,
  },
  {
    id: 'messages.send',
    label: 'Send messages',
    consentText: 'Send, edit and delete its own messages.',
    dangerous: false,
  },
  {
    id: 'messages.manage',
    label: 'Delete other messages',
    consentText: "Delete other people's messages.",
    dangerous: true,
  },
  {
    id: 'reactions',
    label: 'Use reactions',
    consentText: 'Add and remove reactions on messages.',
    dangerous: false,
  },
  {
    id: 'members.read',
    label: 'View members',
    consentText: 'See the list of members and their profile details.',
    dangerous: false,
  },
  {
    id: 'members.roles',
    label: 'Manage roles',
    consentText: 'Give and take away roles from members.',
    dangerous: true,
  },
  {
    id: 'members.moderate',
    label: 'Time out and kick',
    consentText: 'Time out or kick members from this server.',
    dangerous: true,
  },
  {
    id: 'members.ban',
    label: 'Ban members',
    consentText: 'Ban and unban members from this server.',
    dangerous: true,
  },
  {
    id: 'channels.read',
    label: 'View channels',
    consentText: 'See the list of channels and their settings.',
    dangerous: false,
  },
  {
    id: 'channels.manage',
    label: 'Manage channels',
    consentText: 'Create, edit and delete channels.',
    dangerous: true,
  },
  {
    id: 'events.guild',
    label: 'See joins and leaves',
    consentText: 'Be notified when members join or leave this server.',
    dangerous: false,
  },
  {
    id: 'voice.read',
    label: 'See voice activity',
    consentText: 'See who joins, leaves and moves between voice channels.',
    dangerous: false,
  },
  {
    id: 'storage',
    label: 'Store data',
    consentText: 'Save its own data for this server (kept separate from every other module).',
    dangerous: false,
  },
  {
    id: 'scheduler',
    label: 'Run scheduled tasks',
    consentText: 'Run tasks on a timer, even when nobody is using it.',
    dangerous: false,
  },
  {
    id: 'http',
    label: 'Contact outside servers',
    consentText:
      'Send and receive data from the internet addresses listed below. Anything it knows about ' +
      'this server can be sent to those addresses.',
    dangerous: true,
  },
  {
    id: 'discord.raw',
    label: 'Full Discord API access',
    consentText:
      'Make any Discord request it likes within this server, including things not covered by the ' +
      'permissions above. Only grant this to modules you trust.',
    dangerous: true,
  },
] as const satisfies readonly PermissionDefinition[];

export type PermissionId = (typeof PERMISSIONS)[number]['id'];

const BY_ID = new Map<string, PermissionDefinition>(PERMISSIONS.map((p) => [p.id, p]));

export function isPermissionId(value: string): value is PermissionId {
  return BY_ID.has(value);
}

export function permission(id: PermissionId): PermissionDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown permission '${id}'.`);
  return found;
}

export const PERMISSION_IDS: readonly string[] = PERMISSIONS.map((p) => p.id);
