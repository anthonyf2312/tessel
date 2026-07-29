/**
 * `/module install <url>` takes a URL from whoever runs it. Everything downstream — the
 * network request, the extraction directory, the trust lookup — is built from what this
 * parser returns, so anything it lets through it vouches for.
 */
import { describe, expect, test } from 'vitest';
import { parseGitHubUrl } from './github.ts';

describe('accepted forms', () => {
  test('parses a plain repository URL', () => {
    const result = parseGitHubUrl('https://github.com/someone/my-module');

    expect(result.ok && result.source).toEqual({ owner: 'someone', repo: 'my-module', ref: null });
  });

  test('parses a URL with a trailing slash', () => {
    const result = parseGitHubUrl('https://github.com/someone/my-module/');

    expect(result.ok && result.source.repo).toBe('my-module');
  });

  test('parses a .git suffix', () => {
    const result = parseGitHubUrl('https://github.com/someone/my-module.git');

    expect(result.ok && result.source.repo).toBe('my-module');
  });

  test('parses a tree URL and keeps the ref', () => {
    const result = parseGitHubUrl('https://github.com/someone/my-module/tree/v1.2.0');

    expect(result.ok && result.source.ref).toBe('v1.2.0');
  });
});

describe('rejected forms', () => {
  // Anything that is not GitHub is refused outright rather than fetched and inspected.
  test('rejects a non-GitHub host', () => {
    const result = parseGitHubUrl('https://evil.example.com/someone/my-module');

    expect(result.ok).toBe(false);
  });

  test('rejects a lookalike host', () => {
    const result = parseGitHubUrl('https://github.com.evil.example.com/someone/my-module');

    expect(result.ok).toBe(false);
  });

  test('rejects userinfo smuggling the real host', () => {
    const result = parseGitHubUrl('https://github.com@evil.example.com/someone/my-module');

    expect(result.ok).toBe(false);
  });

  test('rejects plain http', () => {
    const result = parseGitHubUrl('http://github.com/someone/my-module');

    expect(result.ok).toBe(false);
  });

  test('rejects a URL with no repository', () => {
    const result = parseGitHubUrl('https://github.com/someone');

    expect(result.ok).toBe(false);
  });

  test('rejects a file URL', () => {
    const result = parseGitHubUrl('file:///etc/passwd');

    expect(result.ok).toBe(false);
  });

  test('rejects text that is not a URL', () => {
    const result = parseGitHubUrl('not a url at all');

    expect(result.ok).toBe(false);
  });

  // Owner and repo are interpolated into an API path, so shell/path metacharacters are out.
  test('rejects path traversal in the owner', () => {
    const result = parseGitHubUrl('https://github.com/..%2F..%2Fetc/my-module');

    expect(result.ok).toBe(false);
  });

  test('rejects a ref containing a path separator', () => {
    const result = parseGitHubUrl('https://github.com/someone/my-module/tree/..%2F..%2Fmain');

    expect(result.ok).toBe(false);
  });
});
