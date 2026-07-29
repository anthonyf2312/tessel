/**
 * Fetching and verifying the signed catalogue.
 *
 * Everything here fails closed on trust and open on function: if the catalogue is missing,
 * unreachable, unverifiable, expired or malformed, the result is `null`, which means every
 * module reads as unsigned. The bot keeps working — it just stops vouching for anything.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { verifyCatalogue, type Catalogue } from '@tessel/installer';
import { env } from './env.ts';
import { logger } from './logger.ts';

const REFRESH_MS = 15 * 60_000;

let cached: Catalogue | null = null;
let cachedAt = 0;
let publicKey: KeyObject | null | undefined;

function loadPublicKey(): KeyObject | null {
  if (publicKey !== undefined) return publicKey;

  if (!env.CATALOGUE_PUBLIC_KEY) {
    logger.warn(
      'No CATALOGUE_PUBLIC_KEY set — every module will be treated as unsigned and installs will warn.',
    );
    publicKey = null;
    return publicKey;
  }

  try {
    publicKey = createPublicKey({
      key: Buffer.from(env.CATALOGUE_PUBLIC_KEY, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (error) {
    logger.error({ err: error }, 'CATALOGUE_PUBLIC_KEY is not a valid ed25519 public key.');
    publicKey = null;
  }

  return publicKey;
}

/**
 * Returns the verified catalogue, refreshing at most every 15 minutes.
 *
 * A stale-but-verified catalogue is preferred to no catalogue when a refresh fails, because
 * the signature still holds and the `expiresAt` check inside `verifyCatalogue` puts an upper
 * bound on how stale it can get.
 */
export async function getCatalogue(): Promise<Catalogue | null> {
  const key = loadPublicKey();
  if (!key) return null;

  if (cached && Date.now() - cachedAt < REFRESH_MS) return cached;

  try {
    const [bodyResponse, signatureResponse] = await Promise.all([
      fetch(env.CATALOGUE_URL, { headers: { 'cache-control': 'no-cache' } }),
      fetch(`${env.CATALOGUE_URL}.sig`, { headers: { 'cache-control': 'no-cache' } }),
    ]);

    if (!bodyResponse.ok || !signatureResponse.ok) {
      logger.warn(
        { body: bodyResponse.status, signature: signatureResponse.status },
        'Could not fetch the catalogue; treating all modules as unsigned.',
      );
      return cached;
    }

    const bytes = Buffer.from(await bodyResponse.arrayBuffer());
    const signature = Buffer.from(await signatureResponse.arrayBuffer());

    const result = verifyCatalogue(bytes, signature, key);
    if (!result.ok) {
      logger.error({ reason: result.error }, 'Catalogue failed verification; ignoring it.');
      return null;
    }

    cached = result.catalogue;
    cachedAt = Date.now();
    logger.info({ modules: cached.entries.length }, 'Catalogue verified.');
    return cached;
  } catch (error) {
    logger.warn({ err: error }, 'Catalogue refresh failed; using the last verified copy.');
    return cached;
  }
}
