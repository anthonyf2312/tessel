/**
 * Unpacking an untrusted repository tarball.
 *
 * Parsing is delegated to `tar` because real GitHub archives use pax headers and long-name
 * extensions that a hand-rolled reader gets subtly wrong. Policy is emphatically not
 * delegated: every entry is judged here, against raw pre-strip paths, so that a traversing
 * name is seen as written rather than after a library has quietly normalised it.
 */
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readdir, mkdir } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import { resolveEntryPath } from './paths.ts';

export interface ExtractLimits {
  maxFiles: number;
  maxTotalBytes: number;
}

export type ExtractResult =
  | { ok: true; root: string; fileCount: number; totalBytes: number }
  | { ok: false; errors: string[] };

const DEFAULT_LIMITS: ExtractLimits = {
  maxFiles: 2_000,
  maxTotalBytes: 25 * 1024 * 1024,
};

/** Entry kinds that may be written. Links of any sort are refused. */
const ALLOWED_TYPES = new Set(['File', 'Directory']);

export async function extractTarball(
  archive: Buffer,
  destDir: string,
  limits: Partial<ExtractLimits> = {},
): Promise<ExtractResult> {
  const { maxFiles, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const errors: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  await mkdir(destDir, { recursive: true });

  // tar shares this callback type with its create path, so the entry can in principle be a
  // Stats. An entry without a `type` is not something we are willing to guess about.
  const filter = (path: string, entry: tar.ReadEntry | Stats): boolean => {
    const entryType = 'type' in entry ? String(entry.type) : 'unknown';

    if (!ALLOWED_TYPES.has(entryType)) {
      errors.push(
        `Refused '${path}': archives may only contain files and directories, not ${entryType}.`,
      );
      return false;
    }

    // Judged against the raw path, before any strip, so '../..' is visible as written.
    if (resolveEntryPath(destDir, path) === null) {
      errors.push(`Refused '${path}': entry would be written outside the module directory.`);
      return false;
    }

    if (entryType === 'Directory') return true;

    fileCount += 1;
    if (fileCount > maxFiles) {
      errors.push(`Archive contains more than the ${maxFiles}-file limit.`);
      return false;
    }

    totalBytes += entry.size ?? 0;
    if (totalBytes > maxTotalBytes) {
      errors.push(`Archive is larger than the ${maxTotalBytes}-byte unpacked size limit.`);
      return false;
    }

    return true;
  };

  try {
    await pipeline(
      Readable.from(archive),
      tar.x({
        cwd: destDir,
        // Our own filter is the boundary; these keep tar from being helpful in the meantime.
        preservePaths: false,
        strip: 0,
        filter,
        onwarn: (_code: string, message: string) => {
          errors.push(message);
        },
      }),
    );
  } catch (error) {
    errors.push(`Could not read the archive: ${(error as Error).message}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, root: await findRoot(destDir), fileCount, totalBytes };
}

/**
 * GitHub wraps everything in a single `<repo>-<ref>` directory. Strip it if that is exactly
 * what we got; otherwise the extraction directory is already the module root.
 */
async function findRoot(destDir: string): Promise<string> {
  const entries = await readdir(destDir, { withFileTypes: true });
  const [only] = entries;

  if (entries.length === 1 && only?.isDirectory()) {
    return join(destDir, only.name);
  }

  return destDir;
}
