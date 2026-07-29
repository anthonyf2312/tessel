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
export interface DiscordActions {
  sendMessage(guildId: string, channelId: string, content: string): Promise<void>;
  deleteMessage(guildId: string, channelId: string, messageId: string): Promise<void>;
  timeoutMember(guildId: string, userId: string, durationMs: number, reason?: string): Promise<void>;
  kickMember(guildId: string, userId: string, reason?: string): Promise<void>;
  banMember(guildId: string, userId: string, reason?: string): Promise<void>;
  addRole(guildId: string, userId: string, roleId: string): Promise<void>;
  removeRole(guildId: string, userId: string, roleId: string): Promise<void>;
}

/** Which permission each capability requires. A capability absent here cannot be reached. */
export const OP_PERMISSIONS: Readonly<Record<string, string>> = {
  'storage.get': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'message.send': 'messages.send',
  'message.delete': 'messages.manage',
  'member.timeout': 'members.moderate',
  'member.kick': 'members.moderate',
  'member.ban': 'members.ban',
  'member.addRole': 'members.roles',
  'member.removeRole': 'members.roles',
};

/** Which permission a module must hold to be told about each event. */
export const EVENT_PERMISSIONS: Readonly<Record<string, string>> = {
  memberJoin: 'events.guild',
  memberLeave: 'events.guild',
  messageCreate: 'messages.read',
};

export type ModuleEvent = keyof typeof EVENT_PERMISSIONS | string;
