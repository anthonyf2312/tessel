/**
 * `discord.raw` is the widest permission a module can hold, so the line it draws matters more
 * than most. A mistake here hands a module the bot's entire account rather than one server.
 */
import { describe, expect, test } from 'vitest';
import { checkRawRoute } from './raw-route.ts';

const GUILD = '111111111111111111';
const OTHER = '999999999999999999';

describe('guild-scoped routes', () => {
  test('allows a route naming the calling guild', () => {
    expect(checkRawRoute(GUILD, 'GET', `/guilds/${GUILD}/members`).ok).toBe(true);
  });

  test('allows the bare guild route', () => {
    expect(checkRawRoute(GUILD, 'GET', `/guilds/${GUILD}`).ok).toBe(true);
  });

  // The entire point of the permission's scoping.
  test('refuses a route naming a different guild', () => {
    expect(checkRawRoute(GUILD, 'GET', `/guilds/${OTHER}/members`).ok).toBe(false);
  });

  test('refuses a guild id that merely starts with the calling guild', () => {
    expect(checkRawRoute(GUILD, 'GET', `/guilds/${GUILD}0/members`).ok).toBe(false);
  });
});

describe('channel routes', () => {
  test('allows a channel route but demands the channel be verified', () => {
    const result = checkRawRoute(GUILD, 'GET', '/channels/123456789012345678/messages');

    expect(result.ok && result.verifyChannelId).toBe('123456789012345678');
  });
});

describe('everything else is refused', () => {
  test.each([
    ['/users/@me', 'the bot account itself'],
    ['/users/123/channels', 'opening a DM'],
    ['/applications/123/commands', 'global command registration'],
    ['/gateway/bot', 'gateway details'],
    ['/invites/abc', 'arbitrary invites'],
    ['/', 'the API root'],
  ])('refuses %s (%s)', (route) => {
    expect(checkRawRoute(GUILD, 'GET', route).ok).toBe(false);
  });
});

describe('route trickery', () => {
  test.each([
    [`/guilds/${GUILD}/../../users/@me`, 'traversal'],
    [`/guilds/${GUILD}/%2e%2e/users`, 'encoded traversal is not decoded into a bypass'],
    ['https://evil.example.com/guilds/x', 'an absolute URL'],
    ['//evil.example.com/guilds/x', 'a protocol-relative URL'],
    [`/guilds\\${GUILD}/members`, 'backslashes'],
    [`/guilds/${GUILD}/members?x= /users/@me`, 'a space smuggling a second path'],
  ])('refuses %s (%s)', (route) => {
    expect(checkRawRoute(GUILD, 'GET', route).ok).toBe(false);
  });

  test('normalises a route missing its leading slash', () => {
    expect(checkRawRoute(GUILD, 'GET', `guilds/${GUILD}/members`).ok).toBe(true);
  });
});

describe('methods', () => {
  test.each(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'get', 'post'])('allows %s', (method) => {
    expect(checkRawRoute(GUILD, method, `/guilds/${GUILD}`).ok).toBe(true);
  });

  test.each(['TRACE', 'CONNECT', 'OPTIONS', 'HEAD'])('refuses %s', (method) => {
    expect(checkRawRoute(GUILD, method, `/guilds/${GUILD}`).ok).toBe(false);
  });
});

describe('malformed input', () => {
  test('refuses an empty path', () => {
    expect(checkRawRoute(GUILD, 'GET', '').ok).toBe(false);
  });
});
