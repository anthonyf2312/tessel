import { resolve, sep } from 'node:path';

/**
 * Resolves an archive entry name against the extraction root, or returns `null` if the entry
 * would land anywhere else.
 *
 * Backslashes are treated as separators on every platform, not just Windows: a tarball built
 * on Linux can legally contain `a\..\..\evil`, which is one path component there and three on
 * Windows. Normalising first means the check does not depend on where the bot is running.
 *
 * The final containment check is belt-and-braces — the `..` rejection above should already
 * cover it, but this is the last line before an untrusted name becomes a write path.
 */
export function resolveEntryPath(root: string, entryName: string): string | null {
  if (entryName.length === 0) return null;
  if ([...entryName].some((char) => char.charCodeAt(0) === 0)) return null;

  const unified = entryName.replace(/\\/g, '/');

  if (unified.startsWith('/')) return null;
  if (/^[a-z]:/i.test(unified)) return null;
  if (unified.split('/').includes('..')) return null;

  const resolved = resolve(root, unified);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  return resolved.startsWith(rootWithSep) ? resolved : null;
}
