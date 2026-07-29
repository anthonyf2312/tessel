/**
 * The only part of the installer that talks to the network.
 *
 * `fetch` is injected rather than reached for globally, so the install pipeline can be tested
 * end to end without a network, and so a future self-hosted GitHub Enterprise setup has an
 * obvious seam.
 */
import type { GitHubSource } from './github.ts';

export type FetchResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface GitHubClientOptions {
  fetchImpl?: typeof globalThis.fetch;
  /** Optional PAT. Only raises the rate limit; nothing here needs repository write access. */
  token?: string;
  maxArchiveBytes?: number;
}

export interface GitHubClient {
  resolveCommit(source: GitHubSource): Promise<FetchResult<string>>;
  downloadTarball(source: GitHubSource, commitSha: string): Promise<FetchResult<Buffer>>;
}

const DEFAULT_MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;

  const headers: Record<string, string> = {
    'user-agent': 'tessel-bot',
    accept: 'application/vnd.github+json',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  return {
    async resolveCommit(source) {
      // `ref` was validated by parseGitHubUrl; encode anyway so this function is safe to call
      // with a ref from anywhere.
      const ref = encodeURIComponent(source.ref ?? 'HEAD');
      const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${ref}`;

      let response: Response;
      try {
        response = await doFetch(url, { headers });
      } catch (error) {
        return { ok: false, error: `Could not reach GitHub: ${(error as Error).message}` };
      }

      if (response.status === 404) {
        return {
          ok: false,
          error: `Could not find ${source.owner}/${source.repo}${
            source.ref ? ` at '${source.ref}'` : ''
          }. Check the URL is right and the repository is public.`,
        };
      }

      if (response.status === 403 || response.status === 429) {
        return { ok: false, error: 'GitHub rate limit reached. Try again in a few minutes.' };
      }

      if (!response.ok) {
        return { ok: false, error: `GitHub returned ${response.status} for that repository.` };
      }

      let sha: unknown;
      try {
        sha = ((await response.json()) as { sha?: unknown }).sha;
      } catch {
        return { ok: false, error: 'GitHub returned something that was not a commit.' };
      }

      if (typeof sha !== 'string' || !COMMIT_SHA.test(sha)) {
        return { ok: false, error: 'GitHub returned a commit id that does not look valid.' };
      }

      return { ok: true, value: sha };
    },

    async downloadTarball(source, commitSha) {
      // Refuse to build a URL from anything that is not a real sha — this value is what pins
      // the install to reviewed code.
      if (!COMMIT_SHA.test(commitSha)) {
        return { ok: false, error: 'Refusing to download: that is not a valid commit id.' };
      }

      const url = `https://codeload.github.com/${source.owner}/${source.repo}/tar.gz/${commitSha}`;

      let response: Response;
      try {
        response = await doFetch(url, { headers: { 'user-agent': 'tessel-bot' } });
      } catch (error) {
        return { ok: false, error: `Could not download the module: ${(error as Error).message}` };
      }

      if (!response.ok) {
        return { ok: false, error: `GitHub returned ${response.status} when downloading the module.` };
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxArchiveBytes) {
        return { ok: false, error: `That module is larger than the ${maxArchiveBytes}-byte limit.` };
      }

      return readCapped(response, maxArchiveBytes);
    },
  };
}

/**
 * Reads the body while enforcing the cap.
 *
 * Content-Length is whatever the server chose to say, so the limit is enforced against bytes
 * actually received rather than bytes promised.
 */
async function readCapped(response: Response, maxBytes: number): Promise<FetchResult<Buffer>> {
  const body = response.body;
  if (!body) return { ok: false, error: 'GitHub returned an empty response.' };

  const chunks: Buffer[] = [];
  let total = 0;

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { ok: false, error: `That module is larger than the ${maxBytes}-byte limit.` };
      }

      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    return { ok: false, error: `Download failed: ${(error as Error).message}` };
  }

  return { ok: true, value: Buffer.concat(chunks) };
}
