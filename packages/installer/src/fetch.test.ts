/**
 * Fetching from GitHub. `fetch` is injected so these tests never touch the network.
 *
 * The property worth guarding hardest is that the download uses the RESOLVED COMMIT, not the
 * ref the admin typed. A tag can be moved between the moment it is resolved and the moment
 * the archive is fetched, which would mean reviewing one commit and installing another.
 */
import { describe, expect, test } from 'vitest';
import { createGitHubClient } from './fetch.ts';
import type { GitHubSource } from './github.ts';

const SOURCE: GitHubSource = { owner: 'someone', repo: 'my-module', ref: 'v1.2.0' };
const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';

/** Records every URL requested, so tests can assert on what was actually asked for. */
function stubFetch(handler: (url: string) => Response) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    return handler(url);
  }) as unknown as typeof globalThis.fetch;

  return { impl, urls };
}

function commitResponse(sha = SHA): Response {
  return new Response(JSON.stringify({ sha }), { status: 200 });
}

describe('resolving a commit', () => {
  test('resolves a ref to its commit sha', async () => {
    const { impl } = stubFetch(() => commitResponse());
    const client = createGitHubClient({ fetchImpl: impl });

    const result = await client.resolveCommit(SOURCE);

    expect(result.ok && result.value).toBe(SHA);
  });

  test('asks for the default branch when no ref was given', async () => {
    const { impl, urls } = stubFetch(() => commitResponse());
    const client = createGitHubClient({ fetchImpl: impl });

    await client.resolveCommit({ ...SOURCE, ref: null });

    expect(urls[0]).toContain('/commits/HEAD');
  });

  test('reports a repository that does not exist', async () => {
    const { impl } = stubFetch(() => new Response('Not Found', { status: 404 }));
    const client = createGitHubClient({ fetchImpl: impl });

    const result = await client.resolveCommit(SOURCE);

    expect(result.ok === false && result.error).toMatch(/not find|does not exist|404/i);
  });

  test('reports rate limiting distinctly from a missing repository', async () => {
    const { impl } = stubFetch(() => new Response('rate limited', { status: 403 }));
    const client = createGitHubClient({ fetchImpl: impl });

    const result = await client.resolveCommit(SOURCE);

    expect(result.ok === false && result.error).toMatch(/rate limit/i);
  });

  // A response that is not a real commit sha must not be pasted into a download URL.
  test('rejects a malformed sha in the response', async () => {
    const { impl } = stubFetch(() => commitResponse('../../etc/passwd'));
    const client = createGitHubClient({ fetchImpl: impl });

    const result = await client.resolveCommit(SOURCE);

    expect(result.ok).toBe(false);
  });

  test('rejects a response that is not JSON', async () => {
    const { impl } = stubFetch(() => new Response('<html>nope</html>', { status: 200 }));
    const client = createGitHubClient({ fetchImpl: impl });

    const result = await client.resolveCommit(SOURCE);

    expect(result.ok).toBe(false);
  });
});

describe('downloading the archive', () => {
  test('downloads the archive', async () => {
    const { impl } = stubFetch(() => new Response(Buffer.from('tarball-bytes')));
    const client = createGitHubClient({ fetchImpl: impl });

    const result = await client.downloadTarball(SOURCE, SHA);

    expect(result.ok && result.value.toString()).toBe('tarball-bytes');
  });

  // The whole point of resolving a commit first.
  test('downloads by commit sha, not by the ref that was typed', async () => {
    const { impl, urls } = stubFetch(() => new Response(Buffer.from('tarball-bytes')));
    const client = createGitHubClient({ fetchImpl: impl });

    await client.downloadTarball(SOURCE, SHA);

    expect(urls[0]).toContain(SHA);
    expect(urls[0]).not.toContain('v1.2.0');
  });

  test('reports a failed download', async () => {
    const { impl } = stubFetch(() => new Response('gone', { status: 404 }));
    const client = createGitHubClient({ fetchImpl: impl });

    const result = await client.downloadTarball(SOURCE, SHA);

    expect(result.ok).toBe(false);
  });

  test('refuses an archive larger than the cap', async () => {
    const { impl } = stubFetch(() => new Response(Buffer.alloc(5000)));
    const client = createGitHubClient({ fetchImpl: impl, maxArchiveBytes: 1000 });

    const result = await client.downloadTarball(SOURCE, SHA);

    expect(result.ok).toBe(false);
  });

  // Content-Length is attacker-controlled, so the cap has to hold while reading too.
  test('refuses an oversized archive that lies about its length', async () => {
    const { impl } = stubFetch(
      () =>
        new Response(Buffer.alloc(5000), {
          headers: { 'content-length': '10' },
        }),
    );
    const client = createGitHubClient({ fetchImpl: impl, maxArchiveBytes: 1000 });

    const result = await client.downloadTarball(SOURCE, SHA);

    expect(result.ok).toBe(false);
  });
});
