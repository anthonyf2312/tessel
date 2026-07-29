/**
 * Parsing the URL an admin pasted into `/module install`.
 *
 * Deliberately strict: only https, only github.com, and owner/repo/ref each have to look like
 * what GitHub actually allows. Everything downstream builds an API path and a filesystem
 * directory out of these values, so a permissive parser here would undo checks made later.
 */
export interface GitHubSource {
  owner: string;
  repo: string;
  /** A branch, tag or commit-ish. `null` means "whatever the default branch is". */
  ref: string | null;
}

export type GitHubUrlResult = { ok: true; source: GitHubSource } | { ok: false; error: string };

const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com']);

/** GitHub's own constraint on owner and repository names. */
const NAME = /^[A-Za-z0-9._-]+$/;

function fail(error: string): GitHubUrlResult {
  return { ok: false, error };
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function isValidRef(ref: string): boolean {
  const parts = ref.split('/');
  return parts.length > 0 && parts.every((part) => part !== '..' && NAME.test(part));
}

export function parseGitHubUrl(input: string): GitHubUrlResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return fail('That does not look like a URL.');
  }

  if (url.protocol !== 'https:') {
    return fail('Module URLs must use https.');
  }

  // A populated username/password would mean the visible "github.com" is userinfo and the
  // real host is something else. The hostname check below already catches it; this rejects
  // the shape outright so the error explains what was wrong.
  if (url.username !== '' || url.password !== '') {
    return fail('Module URLs must not contain credentials.');
  }

  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    return fail('Modules can only be installed from github.com.');
  }

  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return fail('That URL does not point at a repository. Expected https://github.com/owner/repo.');
  }

  const owner = decode(segments[0]!);
  const rawRepo = decode(segments[1]!);
  if (owner === null || rawRepo === null) return fail('That URL is malformed.');

  const repo = rawRepo.replace(/\.git$/, '');

  if (!NAME.test(owner)) return fail('That owner name is not a valid GitHub owner.');
  if (!NAME.test(repo)) return fail('That repository name is not a valid GitHub repository.');

  if (segments.length === 2) {
    return { ok: true, source: { owner, repo, ref: null } };
  }

  if (segments[2] !== 'tree') {
    return fail('Expected either https://github.com/owner/repo or .../tree/<branch-or-tag>.');
  }

  const rawRef = decode(segments.slice(3).join('/'));
  if (rawRef === null || rawRef.length === 0) return fail('That URL is missing a branch or tag.');
  if (!isValidRef(rawRef)) return fail('That branch or tag name is not valid.');

  return { ok: true, source: { owner, repo, ref: rawRef } };
}
