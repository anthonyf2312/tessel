/**
 * The route guard behind `discord.raw`.
 *
 * `discord.raw` is the escape hatch that lets a module reach endpoints the SDK does not cover.
 * It is deliberately **not** unrestricted: it means "anything within this server". This
 * function is what draws that line, kept pure and separate so it can be tested exhaustively —
 * a mistake here would hand a module the bot's whole account.
 *
 * Guild routes must name the calling guild. Channel routes are allowed through, but the caller
 * must then resolve the channel *via the guild*, which fails for a channel elsewhere.
 * Everything else — /users, /applications, global endpoints — is refused, because none of it is
 * guild-scoped and a module has no business there.
 */
export type RouteCheck =
  | { ok: true; route: `/${string}`; verifyChannelId?: string }
  | { ok: false; error: string };

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

export function checkRawRoute(guildId: string, method: string, path: string): RouteCheck {
  const verb = method.toUpperCase();
  if (!ALLOWED_METHODS.has(verb)) {
    return { ok: false, error: `Unsupported method '${method}'.` };
  }

  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'That route is not valid.' };
  }

  const route = path.startsWith('/') ? path : `/${path}`;

  // Traversal, absolute URLs, protocol-relative URLs and backslashes are all attempts to make
  // the request go somewhere other than where the prefix suggests.
  //
  // The decoded form is checked as well as the literal one: %2e%2e is `..` to anything that
  // decodes before routing, and whether the HTTP layer happens to decode it is not a detail
  // this guard should depend on.
  let decoded = route;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    return { ok: false, error: 'That route is not valid.' };
  }

  const suspicious = (value: string) =>
    value.includes('..') ||
    value.includes('://') ||
    value.startsWith('//') ||
    value.includes(String.fromCharCode(92)) ||
    value.includes(' ');

  if (suspicious(route) || suspicious(decoded)) {
    return { ok: false, error: 'That route is not valid.' };
  }

  const guildRoute = route.match(/^\/guilds\/(\d+)(?:\/|$)/);
  if (guildRoute) {
    if (guildRoute[1] !== guildId) {
      return {
        ok: false,
        error: 'You can only make requests scoped to the server you were called from.',
      };
    }
    return { ok: true, route: route as `/${string}` };
  }

  const channelRoute = route.match(/^\/channels\/(\d+)(?:\/|$)/);
  if (channelRoute) {
    // Allowed only on the condition the caller verifies this channel belongs to the guild.
    return { ok: true, route: route as `/${string}`, verifyChannelId: channelRoute[1]! };
  }

  return {
    ok: false,
    error: 'Only /guilds/... and /channels/... routes are allowed, and only for this server.',
  };
}
