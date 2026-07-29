/**
 * The whole install pipeline, end to end, with a fake GitHub.
 *
 * Nothing here is mocked below the network seam: real archives are extracted to a real
 * directory, real manifests are validated and real bundles are produced. Only GitHub itself
 * is stubbed, so what these tests exercise is what runs in production.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installModule } from './install.ts';
import { makeModuleArchive, makeTar } from './tar-fixture.ts';
import type { GitHubClient } from './fetch.ts';
import type { Catalogue } from './signing.ts';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessel-install-'));
  tempDirs.push(dir);
  return dir;
}

const SHA = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const URL = 'https://github.com/someone/my-module';

const VALID_MANIFEST = {
  id: 'com.github.someone.my-module',
  name: 'My Module',
  version: '1.0.0',
  apiVersion: '1',
  description: 'A module that does something.',
  author: 'someone',
  entry: 'src/index.ts',
  permissions: ['messages.send'],
  commands: [{ name: 'hello', description: 'Say hello' }],
};

/** A GitHub that always serves the given archive at the given commit. */
function fakeGitHub(archive: Buffer, sha = SHA): GitHubClient {
  return {
    async resolveCommit() {
      return { ok: true, value: sha };
    },
    async downloadTarball() {
      return { ok: true, value: archive };
    },
  };
}

async function install(archive: Buffer, catalogue: Catalogue | null = null) {
  return installModule({
    url: URL,
    github: fakeGitHub(archive),
    catalogue,
    workDir: await workDir(),
  });
}

describe('a valid module', () => {
  test('installs', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST));

    expect(result.ok).toBe(true);
  });

  test('records the module identity from the manifest', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST));

    expect(result.ok && result.artifact.moduleId).toBe('com.github.someone.my-module');
    expect(result.ok && result.artifact.version).toBe('1.0.0');
  });

  // Pinning to a commit is what makes a later signature check meaningful.
  test('pins the resolved commit rather than the ref', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST));

    expect(result.ok && result.artifact.commitSha).toBe(SHA);
  });

  test('produces a bundle hash', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST));

    expect(result.ok && result.artifact.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('carries the declared commands through', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST));

    expect(result.ok && result.artifact.manifest.commands[0]?.name).toBe('hello');
  });
});

describe('trust state', () => {
  async function installWithCatalogue(catalogueFor: (bundleSha256: string) => Catalogue) {
    // Install once to learn the bundle hash, then again with a catalogue that lists it.
    const archive = makeModuleArchive(VALID_MANIFEST);
    const first = await install(archive);
    if (!first.ok) throw new Error('fixture failed to install');

    return install(archive, catalogueFor(first.artifact.bundleSha256));
  }

  test('is unsigned when there is no catalogue', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST));

    expect(result.ok && result.artifact.trust).toBe('unsigned');
  });

  test('is signed when the catalogue lists this exact artifact', async () => {
    const result = await installWithCatalogue((bundleSha256) => ({
      issuedAt: '2026-07-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      entries: [
        {
          moduleId: VALID_MANIFEST.id,
          version: VALID_MANIFEST.version,
          commitSha: SHA,
          bundleSha256,
        },
      ],
      revoked: [],
    }));

    expect(result.ok && result.artifact.trust).toBe('signed');
  });

  test('is unsigned when the catalogue lists a different bundle hash', async () => {
    const result = await installWithCatalogue(() => ({
      issuedAt: '2026-07-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      entries: [
        {
          moduleId: VALID_MANIFEST.id,
          version: VALID_MANIFEST.version,
          commitSha: SHA,
          bundleSha256: 'f'.repeat(64),
        },
      ],
      revoked: [],
    }));

    expect(result.ok && result.artifact.trust).toBe('unsigned');
  });

  test('refuses a revoked module outright', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST), {
      issuedAt: '2026-07-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      entries: [],
      revoked: [{ moduleId: VALID_MANIFEST.id, reason: 'exfiltrated message content' }],
    });

    expect(result.ok).toBe(false);
  });

  test('explains why a revoked module was refused', async () => {
    const result = await install(makeModuleArchive(VALID_MANIFEST), {
      issuedAt: '2026-07-01T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
      entries: [],
      revoked: [{ moduleId: VALID_MANIFEST.id, reason: 'exfiltrated message content' }],
    });

    expect(result.ok === false && result.errors.join(' ')).toMatch(/revoked/i);
  });
});

describe('things that go wrong', () => {
  test('reports a URL that is not a GitHub repository', async () => {
    const result = await installModule({
      url: 'https://evil.example.com/someone/my-module',
      github: fakeGitHub(makeModuleArchive(VALID_MANIFEST)),
      catalogue: null,
      workDir: await workDir(),
    });

    expect(result.ok).toBe(false);
  });

  test('reports a repository with no module.json', async () => {
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/README.md', content: '# no manifest here' },
    ]);

    const result = await install(archive);

    expect(result.ok === false && result.errors.join(' ')).toMatch(/module\.json/i);
  });

  test('reports a module.json that is not valid JSON', async () => {
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/module.json', content: '{ not json' },
    ]);

    const result = await install(archive);

    expect(result.ok).toBe(false);
  });

  test('reports manifest validation errors', async () => {
    const archive = makeModuleArchive({ ...VALID_MANIFEST, permissions: ['filesystem.write'] });

    const result = await install(archive);

    expect(result.ok === false && result.errors.join(' ')).toContain('filesystem.write');
  });

  test('reports an entry file that does not exist', async () => {
    const archive = makeModuleArchive({ ...VALID_MANIFEST, entry: 'src/missing.ts' });

    const result = await install(archive);

    expect(result.ok).toBe(false);
  });

  test('reports a module that imports a denied builtin', async () => {
    const archive = makeModuleArchive(VALID_MANIFEST, {
      'src/index.ts': 'import { readFileSync } from "node:fs";\nexport default readFileSync;',
    });

    const result = await install(archive);

    expect(result.ok === false && result.errors.join(' ')).toContain('node:fs');
  });

  test('reports a hostile archive', async () => {
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/../../evil.txt', content: 'pwned' },
    ]);

    const result = await install(archive);

    expect(result.ok).toBe(false);
  });

  test('surfaces a GitHub failure', async () => {
    const result = await installModule({
      url: URL,
      github: {
        async resolveCommit() {
          return { ok: false, error: 'Could not find someone/my-module.' };
        },
        async downloadTarball() {
          throw new Error('should not be reached');
        },
      },
      catalogue: null,
      workDir: await workDir(),
    });

    expect(result.ok === false && result.errors.join(' ')).toMatch(/could not find/i);
  });
});
