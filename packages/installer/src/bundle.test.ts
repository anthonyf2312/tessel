/**
 * Bundling is the last step before a module becomes an artifact, and it is where two
 * promises are kept: that no untrusted code executes on the host during install (esbuild
 * only parses and rewrites), and that the resulting hash is reproducible — without that,
 * signing means nothing, because the signer and the installer would compute different hashes
 * for identical source.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundleModule } from './bundle.ts';

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Writes a module tree and returns its root. Keys are paths relative to the module root. */
async function makeModule(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tessel-bundle-'));
  tempDirs.push(root);

  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents, 'utf8');
  }

  return root;
}

describe('bundling', () => {
  test('produces a single bundle from a simple module', async () => {
    const root = await makeModule({ 'src/index.ts': 'export default { name: "hello" };' });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok).toBe(true);
  });

  test('inlines relative imports', async () => {
    const root = await makeModule({
      'src/index.ts': 'import { greet } from "./greet.ts";\nexport default greet();',
      'src/greet.ts': 'export const greet = () => "hello from greet";',
    });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok && result.code).toContain('hello from greet');
  });

  test('allows node builtins the sandbox permits', async () => {
    const root = await makeModule({
      'src/index.ts': 'import { join } from "node:path";\nexport default join("a", "b");',
    });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok).toBe(true);
  });
});

describe('reproducibility', () => {
  test('the same source produces the same hash', async () => {
    const source = { 'src/index.ts': 'export default { value: 42 };' };
    const first = await bundleModule(await makeModule(source), 'src/index.ts');
    const second = await bundleModule(await makeModule(source), 'src/index.ts');

    expect(first.ok && second.ok && first.sha256).toBe(second.ok ? second.sha256 : 'mismatch');
  });

  test('different source produces a different hash', async () => {
    const first = await bundleModule(
      await makeModule({ 'src/index.ts': 'export default { value: 42 };' }),
      'src/index.ts',
    );
    const second = await bundleModule(
      await makeModule({ 'src/index.ts': 'export default { value: 43 };' }),
      'src/index.ts',
    );

    expect(first.ok && second.ok && first.sha256 !== second.sha256).toBe(true);
  });

  test('the hash is a sha256 hex digest', async () => {
    const root = await makeModule({ 'src/index.ts': 'export default {};' });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok && result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('rejected imports', () => {
  // Caught at install time so the author gets a clear error, rather than at runtime where the
  // admin would just see a module that mysteriously fails.
  test('refuses an import of a sandbox-denied builtin', async () => {
    const root = await makeModule({
      'src/index.ts': 'import { readFileSync } from "node:fs";\nexport default readFileSync;',
    });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok).toBe(false);
  });

  test('names the denied builtin in the error', async () => {
    const root = await makeModule({
      'src/index.ts': 'import { execSync } from "node:child_process";\nexport default execSync;',
    });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok === false && result.errors.join(' ')).toContain('child_process');
  });

  test('refuses a dependency on an npm package', async () => {
    const root = await makeModule({
      'src/index.ts': 'import dayjs from "dayjs";\nexport default dayjs;',
    });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok).toBe(false);
  });

  test('refuses a relative import that climbs out of the module', async () => {
    const root = await makeModule({
      'src/index.ts': 'import secret from "../../../../secret.ts";\nexport default secret;',
    });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok).toBe(false);
  });
});

describe('broken source', () => {
  test('reports a syntax error instead of throwing', async () => {
    const root = await makeModule({ 'src/index.ts': 'export default { oops' });

    const result = await bundleModule(root, 'src/index.ts');

    expect(result.ok).toBe(false);
  });

  test('reports a missing entry file', async () => {
    const root = await makeModule({ 'src/index.ts': 'export default {};' });

    const result = await bundleModule(root, 'src/does-not-exist.ts');

    expect(result.ok).toBe(false);
  });
});
