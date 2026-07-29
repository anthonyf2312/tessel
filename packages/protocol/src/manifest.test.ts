/**
 * Manifest validation is the first gate an untrusted repo passes through, and several of
 * its fields become filesystem paths on the host. Anything that gets past this file is
 * trusted to be structurally safe by the installer, so the traversal and injection cases
 * below matter as much as the schema ones.
 */
import { describe, expect, test } from 'vitest';
import { parseManifest } from './manifest.ts';

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'com.github.someone.moderation',
    name: 'Moderation',
    version: '1.2.0',
    apiVersion: '1',
    description: 'Reports rule breaks to a mod channel.',
    author: 'someone',
    entry: 'src/index.ts',
    permissions: ['messages.read'],
    network: [],
    commands: [{ name: 'warn', description: 'Warn a member' }],
    ...overrides,
  };
}

describe('valid manifests', () => {
  test('accepts a well-formed manifest', () => {
    const result = parseManifest(validManifest());

    expect(result.ok).toBe(true);
  });

  test('defaults the storage quota when omitted', () => {
    const result = parseManifest(validManifest());

    expect(result.ok && result.manifest.storage.quotaKb).toBeGreaterThan(0);
  });
});

describe('rejects unsafe identifiers', () => {
  // `id` becomes a directory name under data/modules/, so traversal here is a host escape.
  test('rejects an id containing path traversal', () => {
    const result = parseManifest(validManifest({ id: '../../../etc/passwd' }));

    expect(result.ok).toBe(false);
  });

  test('rejects an id containing a path separator', () => {
    const result = parseManifest(validManifest({ id: 'com.github/someone' }));

    expect(result.ok).toBe(false);
  });

  test('rejects an id containing a null byte', () => {
    const result = parseManifest(validManifest({ id: 'com.github.someone\u0000evil' }));

    expect(result.ok).toBe(false);
  });
});

describe('rejects unsafe entry paths', () => {
  test('rejects an entry that climbs out of the module root', () => {
    const result = parseManifest(validManifest({ entry: '../../../../etc/passwd' }));

    expect(result.ok).toBe(false);
  });

  test('rejects an absolute entry path', () => {
    const result = parseManifest(validManifest({ entry: '/etc/passwd' }));

    expect(result.ok).toBe(false);
  });

  test('rejects a Windows absolute entry path', () => {
    const result = parseManifest(validManifest({ entry: 'C:\\Windows\\System32\\config\\SAM' }));

    expect(result.ok).toBe(false);
  });
});

describe('rejects unknown or malformed fields', () => {
  test('rejects a permission that is not in the catalogue', () => {
    const result = parseManifest(validManifest({ permissions: ['filesystem.write'] }));

    expect(result.ok).toBe(false);
  });

  test('names the offending permission in the error', () => {
    const result = parseManifest(validManifest({ permissions: ['filesystem.write'] }));

    expect(result.ok === false && result.errors.join(' ')).toContain('filesystem.write');
  });

  test('rejects a non-semver version', () => {
    const result = parseManifest(validManifest({ version: 'v1' }));

    expect(result.ok).toBe(false);
  });

  test('rejects an unsupported apiVersion', () => {
    const result = parseManifest(validManifest({ apiVersion: '999' }));

    expect(result.ok).toBe(false);
  });

  test('rejects a command name Discord would refuse', () => {
    const result = parseManifest(validManifest({ commands: [{ name: 'Warn Member', description: 'x' }] }));

    expect(result.ok).toBe(false);
  });

  test('rejects duplicate command names', () => {
    const result = parseManifest(
      validManifest({
        commands: [
          { name: 'warn', description: 'a' },
          { name: 'warn', description: 'b' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
  });
});

describe('rejects unsafe network declarations', () => {
  // The host allowlist is what core enforces brokered HTTP against, so a wildcard or a
  // full URL here would quietly widen the module's egress beyond what the admin approved.
  test('rejects a wildcard host', () => {
    const result = parseManifest(validManifest({ network: ['*'] }));

    expect(result.ok).toBe(false);
  });

  test('rejects a host given as a full URL', () => {
    const result = parseManifest(validManifest({ network: ['https://example.com/path'] }));

    expect(result.ok).toBe(false);
  });

  test('accepts a plain hostname', () => {
    const result = parseManifest(
      validManifest({ network: ['api.example.com'], permissions: ['http'] }),
    );

    expect(result.ok).toBe(true);
  });

  // Otherwise the consent panel would show hosts the module never got permission to reach,
  // which misleads the admin approving it in the more dangerous direction.
  test("rejects declared hosts without the 'http' permission", () => {
    const result = parseManifest(
      validManifest({ network: ['api.example.com'], permissions: ['messages.read'] }),
    );

    expect(result.ok).toBe(false);
  });
});
