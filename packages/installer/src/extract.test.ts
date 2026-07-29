/**
 * Extraction takes a tarball built by a stranger and writes it to disk on the host. These
 * tests build genuinely hostile archives byte by byte — the tar library's own `create` would
 * normalise away exactly the entries worth testing.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarball } from './extract.ts';
import { makeTar, type TarEntry } from './tar-fixture.ts';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = 'tessel-extract-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** The shape GitHub actually produces: everything under one <repo>-<ref> directory. */
function githubStyleArchive(): Buffer {
  return makeTar([
    { name: 'my-module-abc123/', type: '5' },
    { name: 'my-module-abc123/module.json', content: '{"id":"com.example.test"}' },
    { name: 'my-module-abc123/src/', type: '5' },
    { name: 'my-module-abc123/src/index.ts', content: 'export default {};' },
  ]);
}

describe('well-formed archives', () => {
  test('extracts the files', async () => {
    const dest = await makeTempDir();

    const result = await extractTarball(githubStyleArchive(), dest);

    expect(result.ok).toBe(true);
  });

  test('strips the GitHub top-level directory', async () => {
    const dest = await makeTempDir();

    const result = await extractTarball(githubStyleArchive(), dest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const manifest = await readFile(join(result.root, 'module.json'), 'utf8');
    expect(manifest).toContain('com.example.test');
  });

  test('preserves nested files', async () => {
    const dest = await makeTempDir();

    const result = await extractTarball(githubStyleArchive(), dest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(stat(join(result.root, 'src', 'index.ts'))).resolves.toBeTruthy();
  });
});

describe('path traversal', () => {
  test('refuses an archive containing a traversing entry', async () => {
    const dest = await makeTempDir();
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/../../evil.txt', content: 'pwned' },
    ]);

    const result = await extractTarball(archive, dest);

    expect(result.ok).toBe(false);
  });

  test('writes nothing outside the destination', async () => {
    const parent = await makeTempDir();
    const dest = join(parent, 'inner');
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/../../evil.txt', content: 'pwned' },
    ]);

    await extractTarball(archive, dest);

    await expect(stat(join(parent, 'evil.txt'))).rejects.toThrow();
  });

  test('refuses an absolute entry', async () => {
    const dest = await makeTempDir();
    const archive = makeTar([{ name: '/tmp/tessel-absolute-escape.txt', content: 'pwned' }]);

    const result = await extractTarball(archive, dest);

    expect(result.ok).toBe(false);
  });
});

describe('link entries', () => {
  // A symlink pointing at the bot's data directory would turn a later write into a write
  // wherever the attacker chose, so links are refused outright rather than resolved.
  test('refuses a symlink entry', async () => {
    const dest = await makeTempDir();
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/escape', type: '2', linkname: '/etc/passwd' },
    ]);

    const result = await extractTarball(archive, dest);

    expect(result.ok).toBe(false);
  });

  test('refuses a hardlink entry', async () => {
    const dest = await makeTempDir();
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/escape', type: '1', linkname: '/etc/passwd' },
    ]);

    const result = await extractTarball(archive, dest);

    expect(result.ok).toBe(false);
  });
});

describe('resource limits', () => {
  test('refuses an archive with too many files', async () => {
    const dest = await makeTempDir();
    const entries: TarEntry[] = [{ name: 'my-module-abc123/', type: '5' }];
    for (let i = 0; i < 20; i++) {
      entries.push({ name: `my-module-abc123/file${i}.txt`, content: 'x' });
    }

    const result = await extractTarball(makeTar(entries), dest, { maxFiles: 5 });

    expect(result.ok).toBe(false);
  });

  test('refuses an archive that is too large unpacked', async () => {
    const dest = await makeTempDir();
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/big.txt', content: 'x'.repeat(50_000) },
    ]);

    const result = await extractTarball(archive, dest, { maxTotalBytes: 1000 });

    expect(result.ok).toBe(false);
  });

  test('explains which limit was hit', async () => {
    const dest = await makeTempDir();
    const archive = makeTar([
      { name: 'my-module-abc123/', type: '5' },
      { name: 'my-module-abc123/big.txt', content: 'x'.repeat(50_000) },
    ]);

    const result = await extractTarball(archive, dest, { maxTotalBytes: 1000 });

    expect(result.ok === false && result.errors.join(' ')).toMatch(/large|size|limit/i);
  });
});
