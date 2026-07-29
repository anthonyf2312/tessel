/**
 * The install pipeline: a URL an admin pasted in, to a verified artifact ready to run.
 *
 *   parse URL → resolve ref to an immutable commit → download → extract → read and validate
 *   module.json → bundle → hash → decide trust state
 *
 * Nothing in here executes module code. esbuild parses and rewrites; it never runs what it
 * reads. That is what makes it safe to install a hostile module and only then decide, with
 * the admin, whether to enable it.
 *
 * Every failure is collected as human-readable text rather than thrown, because the install
 * report shown in Discord has to explain what went wrong and whose problem it is.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest, type Manifest } from '@tessel/protocol';
import { parseGitHubUrl } from './github.ts';
import { extractTarball } from './extract.ts';
import { bundleModule } from './bundle.ts';
import { isRevoked, trustStateFor, type Catalogue, type TrustState } from './signing.ts';
import type { GitHubClient } from './fetch.ts';

export interface InstallRequest {
  url: string;
  github: GitHubClient;
  /** The verified catalogue, or `null` if it was unreachable — which means "nothing is signed". */
  catalogue: Catalogue | null;
  /** Directory to extract into. Caller owns its lifetime. */
  workDir: string;
}

export interface InstalledArtifact {
  moduleId: string;
  version: string;
  commitSha: string;
  bundleSha256: string;
  trust: TrustState;
  manifest: Manifest;
  /** The bundled ESM source. The caller writes this where the sandbox can read it. */
  bundleCode: string;
}

export type InstallResult =
  | { ok: true; artifact: InstalledArtifact }
  | { ok: false; errors: string[] };

export async function installModule(request: InstallRequest): Promise<InstallResult> {
  const parsed = parseGitHubUrl(request.url);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };

  const commit = await request.github.resolveCommit(parsed.source);
  if (!commit.ok) return { ok: false, errors: [commit.error] };

  const download = await request.github.downloadTarball(parsed.source, commit.value);
  if (!download.ok) return { ok: false, errors: [download.error] };

  const extracted = await extractTarball(download.value, request.workDir);
  if (!extracted.ok) return { ok: false, errors: extracted.errors };

  const manifestResult = await readManifest(extracted.root);
  if (!manifestResult.ok) return { ok: false, errors: manifestResult.errors };
  const manifest = manifestResult.manifest;

  // Checked before bundling: a revoked module should not have its code processed at all, and
  // the admin should get the reason rather than a generic failure.
  if (request.catalogue) {
    const identity = {
      moduleId: manifest.id,
      version: manifest.version,
      commitSha: commit.value,
      bundleSha256: '',
    };
    if (isRevoked(request.catalogue, identity)) {
      const reason = request.catalogue.revoked.find((item) => item.moduleId === manifest.id)?.reason;
      return {
        ok: false,
        errors: [
          `'${manifest.name}' has been revoked and cannot be installed.` +
            (reason ? ` Reason: ${reason}` : ''),
        ],
      };
    }
  }

  const bundle = await bundleModule(extracted.root, manifest.entry);
  if (!bundle.ok) return { ok: false, errors: bundle.errors };

  const trust = trustStateFor(request.catalogue, {
    moduleId: manifest.id,
    version: manifest.version,
    commitSha: commit.value,
    bundleSha256: bundle.sha256,
  });

  return {
    ok: true,
    artifact: {
      moduleId: manifest.id,
      version: manifest.version,
      commitSha: commit.value,
      bundleSha256: bundle.sha256,
      trust,
      manifest,
      bundleCode: bundle.code,
    },
  };
}

type ManifestRead = { ok: true; manifest: Manifest } | { ok: false; errors: string[] };

async function readManifest(moduleRoot: string): Promise<ManifestRead> {
  let raw: string;
  try {
    raw = await readFile(join(moduleRoot, 'module.json'), 'utf8');
  } catch {
    return {
      ok: false,
      errors: ['This repository has no module.json at its root, so it is not a Tessel module.'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`module.json is not valid JSON: ${(error as Error).message}`] };
  }

  const result = parseManifest(parsed);
  if (!result.ok) {
    return { ok: false, errors: result.errors.map((issue) => `module.json — ${issue}`) };
  }

  return { ok: true, manifest: result.manifest };
}
