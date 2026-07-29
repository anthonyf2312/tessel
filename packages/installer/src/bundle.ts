/**
 * Turning a module's TypeScript into one reproducible ESM file.
 *
 * esbuild is used because it parses and rewrites without ever executing the code it reads —
 * so installing a hostile module cannot run anything on the host. Its version is pinned
 * exactly in package.json: the bundle hash is what signatures bind to, so the signer and
 * every installer must produce byte-identical output for identical source.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

/**
 * Kept in step with DENIED_BUILTINS in sandbox-runtime/bootstrap.mjs. Importing one of these
 * would fail at runtime anyway; failing here turns a baffling runtime error into a clear
 * install-time message naming the module and the import.
 */
const DENIED_BUILTINS = new Set([
  'fs', 'net', 'http', 'https', 'http2', 'dgram', 'dns', 'tls', 'child_process',
  'worker_threads', 'cluster', 'vm', 'inspector', 'module', 'process', 'os', 'v8', 'repl',
  'readline', 'tty', 'async_hooks', 'diagnostics_channel', 'trace_events', 'perf_hooks',
  'wasi', 'sea', 'sqlite', 'test',
]);

export const SDK_SPECIFIER = '@tessel/sdk';

/** Virtual namespace, so the SDK's real path never appears in the output. */
const SDK_NAMESPACE = 'tessel-sdk';

/** Resolved from this repository so every module bundles the same, reviewed SDK. */
const DEFAULT_SDK_ENTRY = fileURLToPath(new URL('../../sdk/src/index.ts', import.meta.url));

export interface BundleOptions {
  /** Override the SDK source bundled into the module. Tests use this; production does not. */
  sdkEntry?: string;
}

export type BundleResult =
  | { ok: true; code: string; sha256: string }
  | { ok: false; errors: string[] };

function normaliseBuiltin(specifier: string): string {
  const withoutScheme = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return withoutScheme.split('/')[0]!;
}

function isBuiltin(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true;
  return builtinModules.includes(normaliseBuiltin(specifier));
}

/**
 * Enforces the dependency policy: node builtins the sandbox allows, plus files inside the
 * module's own directory. No npm packages — not even vendored ones resolved by node
 * resolution, because a module's dependencies must be readable source in its repository.
 */
function policyPlugin(moduleRoot: string, sdkEntry: string): Plugin {
  const rootWithSep = moduleRoot.endsWith(sep) ? moduleRoot : moduleRoot + sep;

  return {
    name: 'tessel-policy',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        // The SDK is the one thing a module may import from outside itself. It is bundled in
        // from this repository's copy, so a module cannot ship a doctored version of it.
        //
        // Resolved into a virtual namespace rather than to its real path: esbuild writes each
        // input's path into the output as a comment, so a real path would embed wherever the
        // bot happens to be installed. That made the bundle hash machine-dependent — and the
        // hash is exactly what signatures bind to, so a module signed on one machine would
        // never verify on another. See the reproducibility tests.
        if (args.path === SDK_SPECIFIER) {
          return { path: SDK_SPECIFIER, namespace: SDK_NAMESPACE };
        }

        if (isBuiltin(args.path)) {
          const bare = normaliseBuiltin(args.path);
          if (DENIED_BUILTINS.has(bare)) {
            return {
              errors: [
                {
                  text:
                    `'${args.path}' is not available inside the module sandbox. ` +
                    `If your module needs this capability, request it through @tessel/sdk instead.`,
                },
              ],
            };
          }
          return { path: args.path, external: true };
        }

        // Entry point: esbuild resolves it itself.
        if (args.kind === 'entry-point') return null;

        const isRelative = args.path.startsWith('.');
        if (!isRelative && !isAbsolute(args.path)) {
          return {
            errors: [
              {
                text:
                  `Cannot import '${args.path}': modules may not depend on npm packages. ` +
                  `Use @tessel/sdk, an allowed node builtin, or vendor the source into your repository.`,
              },
            ],
          };
        }

        const resolved = resolve(args.resolveDir, args.path);
        if (!resolved.startsWith(rootWithSep)) {
          return {
            errors: [
              {
                text:
                  `Cannot import '${args.path}': it resolves outside the module directory ` +
                  `(${relative(moduleRoot, resolved)}).`,
              },
            ],
          };
        }

        return null;
      });

      pluginBuild.onLoad({ filter: /.*/, namespace: SDK_NAMESPACE }, async () => ({
        contents: await readFile(sdkEntry, 'utf8'),
        loader: 'ts',
        // No resolveDir: the SDK imports nothing, and omitting it means a doctored module
        // cannot cause a relative import to be resolved from the SDK's directory.
      }));
    },
  };
}

export async function bundleModule(
  moduleRoot: string,
  entryRelative: string,
  options: BundleOptions = {},
): Promise<BundleResult> {
  const root = resolve(moduleRoot);
  const sdkEntry = options.sdkEntry ?? DEFAULT_SDK_ENTRY;

  try {
    const result = await build({
      entryPoints: [resolve(root, entryRelative)],
      absWorkingDir: root,
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      target: 'node24',
      // Deterministic output: no minification, no sourcemaps, no banner, no timestamps.
      minify: false,
      sourcemap: false,
      treeShaking: true,
      logLevel: 'silent',
      plugins: [policyPlugin(root, sdkEntry)],
    });

    const output = result.outputFiles?.[0];
    if (!output) return { ok: false, errors: ['esbuild produced no output.'] };

    return {
      ok: true,
      code: output.text,
      sha256: createHash('sha256').update(output.contents).digest('hex'),
    };
  } catch (error) {
    return { ok: false, errors: collectErrors(error) };
  }
}

function collectErrors(error: unknown): string[] {
  const esbuildErrors = (error as { errors?: { text: string; location?: { file: string; line: number } }[] })
    .errors;

  if (Array.isArray(esbuildErrors) && esbuildErrors.length > 0) {
    return esbuildErrors.map((item) =>
      item.location ? `${item.location.file}:${item.location.line}: ${item.text}` : item.text,
    );
  }

  return [(error as Error).message ?? String(error)];
}
