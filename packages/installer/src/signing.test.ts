/**
 * Signing is what separates "reviewed" from "a stranger's code". The property that matters
 * most is tamper-evidence: a signature binds the built artifact's hash, so an author who
 * retags or amends after review produces something that no longer verifies and drops back to
 * unsigned. Several tests below exist specifically to pin that behaviour.
 */
import { describe, expect, test } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { trustStateFor, verifyCatalogue, isRevoked, type Catalogue } from './signing.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const otherKeyPair = generateKeyPairSync('ed25519');

const NOW = new Date('2026-07-29T12:00:00Z');

const ARTIFACT = {
  moduleId: 'com.github.someone.moderation',
  version: '1.2.0',
  commitSha: 'a'.repeat(40),
  bundleSha256: 'b'.repeat(64),
};

function makeCatalogue(overrides: Partial<Catalogue> = {}): Catalogue {
  return {
    issuedAt: '2026-07-28T12:00:00Z',
    expiresAt: '2026-08-28T12:00:00Z',
    entries: [{ ...ARTIFACT }],
    revoked: [],
    ...overrides,
  };
}

function signCatalogue(catalogue: Catalogue, key = privateKey): { bytes: Buffer; signature: Buffer } {
  const bytes = Buffer.from(JSON.stringify(catalogue), 'utf8');
  return { bytes, signature: cryptoSign(null, bytes, key) };
}

describe('signature verification', () => {
  test('accepts a correctly signed catalogue', () => {
    const { bytes, signature } = signCatalogue(makeCatalogue());

    const result = verifyCatalogue(bytes, signature, publicKey, NOW);

    expect(result.ok).toBe(true);
  });

  test('rejects a catalogue whose bytes were altered after signing', () => {
    const { bytes, signature } = signCatalogue(makeCatalogue());
    const tampered = Buffer.from(bytes.toString('utf8').replace('1.2.0', '9.9.9'), 'utf8');

    const result = verifyCatalogue(tampered, signature, publicKey, NOW);

    expect(result.ok).toBe(false);
  });

  test('rejects a catalogue signed with the wrong key', () => {
    const { bytes, signature } = signCatalogue(makeCatalogue(), otherKeyPair.privateKey);

    const result = verifyCatalogue(bytes, signature, publicKey, NOW);

    expect(result.ok).toBe(false);
  });

  test('rejects a garbage signature', () => {
    const { bytes } = signCatalogue(makeCatalogue());

    const result = verifyCatalogue(bytes, Buffer.alloc(64, 7), publicKey, NOW);

    expect(result.ok).toBe(false);
  });

  test('rejects malformed JSON even when the signature matches', () => {
    const bytes = Buffer.from('{not json', 'utf8');
    const signature = cryptoSign(null, bytes, privateKey);

    const result = verifyCatalogue(bytes, signature, publicKey, NOW);

    expect(result.ok).toBe(false);
  });
});

describe('freshness', () => {
  // Without expiry, an attacker who can serve a stale file could keep vouching for a version
  // that has since been revoked.
  test('rejects an expired catalogue', () => {
    const { bytes, signature } = signCatalogue(
      makeCatalogue({ expiresAt: '2026-07-01T00:00:00Z' }),
    );

    const result = verifyCatalogue(bytes, signature, publicKey, NOW);

    expect(result.ok).toBe(false);
  });

  test('rejects a catalogue issued in the future', () => {
    const { bytes, signature } = signCatalogue(
      makeCatalogue({ issuedAt: '2027-01-01T00:00:00Z', expiresAt: '2027-02-01T00:00:00Z' }),
    );

    const result = verifyCatalogue(bytes, signature, publicKey, NOW);

    expect(result.ok).toBe(false);
  });

  test('explains that the catalogue was out of date', () => {
    const { bytes, signature } = signCatalogue(
      makeCatalogue({ expiresAt: '2026-07-01T00:00:00Z' }),
    );

    const result = verifyCatalogue(bytes, signature, publicKey, NOW);

    expect(result.ok === false && result.error).toMatch(/expired|out of date/i);
  });
});

describe('trust state', () => {
  test('reports a listed artifact as signed', () => {
    expect(trustStateFor(makeCatalogue(), ARTIFACT)).toBe('signed');
  });

  // The whole point: re-tagging changes the bundle, and the old signature no longer covers it.
  test('reports a different bundle hash as unsigned', () => {
    const state = trustStateFor(makeCatalogue(), { ...ARTIFACT, bundleSha256: 'c'.repeat(64) });

    expect(state).toBe('unsigned');
  });

  test('reports a different commit as unsigned', () => {
    const state = trustStateFor(makeCatalogue(), { ...ARTIFACT, commitSha: 'd'.repeat(40) });

    expect(state).toBe('unsigned');
  });

  test('reports a different version as unsigned', () => {
    expect(trustStateFor(makeCatalogue(), { ...ARTIFACT, version: '1.2.1' })).toBe('unsigned');
  });

  test('reports an unlisted module as unsigned', () => {
    const state = trustStateFor(makeCatalogue(), { ...ARTIFACT, moduleId: 'com.other.thing' });

    expect(state).toBe('unsigned');
  });

  // Fail closed on trust: an unreachable catalogue must never mean "assume signed".
  test('reports everything as unsigned when there is no catalogue', () => {
    expect(trustStateFor(null, ARTIFACT)).toBe('unsigned');
  });
});

describe('revocation', () => {
  test('detects a revoked exact version', () => {
    const catalogue = makeCatalogue({
      revoked: [{ moduleId: ARTIFACT.moduleId, version: ARTIFACT.version }],
    });

    expect(isRevoked(catalogue, ARTIFACT)).toBe(true);
  });

  test('detects a module revoked at every version', () => {
    const catalogue = makeCatalogue({ revoked: [{ moduleId: ARTIFACT.moduleId }] });

    expect(isRevoked(catalogue, { ...ARTIFACT, version: '5.0.0' })).toBe(true);
  });

  test('leaves other versions alone when one version is revoked', () => {
    const catalogue = makeCatalogue({
      revoked: [{ moduleId: ARTIFACT.moduleId, version: '0.9.0' }],
    });

    expect(isRevoked(catalogue, ARTIFACT)).toBe(false);
  });

  test('a revoked artifact is never reported as signed', () => {
    const catalogue = makeCatalogue({
      revoked: [{ moduleId: ARTIFACT.moduleId, version: ARTIFACT.version }],
    });

    expect(trustStateFor(catalogue, ARTIFACT)).toBe('unsigned');
  });
});
