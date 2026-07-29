/**
 * The signed catalogue, and the signed/unsigned trust state derived from it.
 *
 * A signature covers the catalogue bytes, and each catalogue entry binds a module's identity
 * to the exact commit AND the exact bundle hash it was reviewed at. It deliberately does not
 * cover the repository URL: tags move and branches get force-pushed, so a URL signature would
 * vouch for whatever the author pushed last. Binding the artifact hash makes tampering
 * self-evident — anything rebuilt after review simply stops matching.
 */
import { verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { z } from 'zod';

export type TrustState = 'signed' | 'unsigned';

export interface ArtifactIdentity {
  moduleId: string;
  version: string;
  commitSha: string;
  bundleSha256: string;
}

const catalogueEntrySchema = z.object({
  moduleId: z.string().min(1),
  version: z.string().min(1),
  commitSha: z.string().min(7),
  bundleSha256: z.string().length(64),
});

const revocationSchema = z.object({
  moduleId: z.string().min(1),
  /** Absent means every version of this module is revoked. */
  version: z.string().min(1).optional(),
  reason: z.string().optional(),
});

const catalogueSchema = z.object({
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  entries: z.array(catalogueEntrySchema),
  revoked: z.array(revocationSchema).default([]),
});

export type Catalogue = z.infer<typeof catalogueSchema>;

export type VerifyResult = { ok: true; catalogue: Catalogue } | { ok: false; error: string };

/**
 * Verifies a detached ed25519 signature over the catalogue bytes, then checks freshness.
 *
 * Callers treat any failure as "no catalogue", which means every module reads as unsigned.
 * That is the intended direction to fail in: the bot keeps working, it just stops vouching.
 */
export function verifyCatalogue(
  bytes: Buffer,
  signature: Buffer,
  publicKey: KeyObject,
  now: Date = new Date(),
): VerifyResult {
  let signatureValid: boolean;
  try {
    signatureValid = cryptoVerify(null, bytes, publicKey, signature);
  } catch {
    // A malformed signature throws rather than returning false.
    return { ok: false, error: 'The catalogue signature could not be checked.' };
  }

  if (!signatureValid) {
    return { ok: false, error: 'The catalogue signature does not match its contents.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, error: 'The catalogue is not valid JSON.' };
  }

  const catalogue = catalogueSchema.safeParse(parsed);
  if (!catalogue.success) {
    return { ok: false, error: 'The catalogue is not in the expected format.' };
  }

  const issuedAt = new Date(catalogue.data.issuedAt);
  const expiresAt = new Date(catalogue.data.expiresAt);

  if (now > expiresAt) {
    return { ok: false, error: 'The catalogue has expired and is out of date.' };
  }

  if (issuedAt > now) {
    return { ok: false, error: 'The catalogue claims to have been issued in the future.' };
  }

  return { ok: true, catalogue: catalogue.data };
}

/**
 * `null` catalogue means it was unreachable or failed verification — everything is unsigned.
 */
export function trustStateFor(
  catalogue: Catalogue | null,
  artifact: ArtifactIdentity,
): TrustState {
  if (!catalogue) return 'unsigned';
  if (isRevoked(catalogue, artifact)) return 'unsigned';

  const listed = catalogue.entries.some(
    (entry) =>
      entry.moduleId === artifact.moduleId &&
      entry.version === artifact.version &&
      entry.commitSha === artifact.commitSha &&
      entry.bundleSha256 === artifact.bundleSha256,
  );

  return listed ? 'signed' : 'unsigned';
}

export function isRevoked(catalogue: Catalogue, artifact: ArtifactIdentity): boolean {
  return catalogue.revoked.some(
    (entry) =>
      entry.moduleId === artifact.moduleId &&
      (entry.version === undefined || entry.version === artifact.version),
  );
}
