/**
 * The catalogue signing tool.
 *
 *   npm run sign -- keygen              create the signing keypair
 *   npm run sign -- add <github-url>    review helper: prints the catalogue entry for a module
 *   npm run sign -- catalogue <file>    sign modules.json, writing modules.json.sig
 *
 * `add` deliberately runs the *same* install pipeline the bot runs. If it computed the bundle
 * hash any other way, signer and installer would disagree and every signature would be
 * worthless — so there is one implementation, used by both.
 */
import { generateKeyPairSync, sign as cryptoSign, createPrivateKey } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubClient, installModule } from '@tessel/installer';

/**
 * Anchored to the repository, not the working directory — `npm run sign` from the root runs
 * this with cwd set to apps/bot, and a key that lands somewhere different depending on where
 * you invoked it from is a key you will eventually lose.
 */
const PRIVATE_KEY_PATH = fileURLToPath(new URL('../../../signing/private.key', import.meta.url));

function usage(): never {
  console.error(
    [
      'Usage:',
      '  npm run sign -- keygen',
      '  npm run sign -- add <github-url>',
      '  npm run sign -- catalogue <path-to-modules.json>',
    ].join('\n'),
  );
  process.exit(1);
}

async function keygen(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  await mkdir(dirname(PRIVATE_KEY_PATH), { recursive: true });
  await writeFile(
    PRIVATE_KEY_PATH,
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    { mode: 0o600 },
  );

  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  console.log(`Private key written to ${PRIVATE_KEY_PATH}`);
  console.log('  Keep it out of the repository. .gitignore already excludes *.key and signing/private*.');
  console.log('  If it leaks, anyone can vouch for any module. Generate a new one and rotate.\n');
  console.log('Put this in the bot\'s .env:\n');
  console.log(`CATALOGUE_PUBLIC_KEY=${spki}`);
}

async function add(url: string): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'tessel-sign-'));

  try {
    const result = await installModule({
      url,
      github: createGitHubClient({ token: process.env.GITHUB_TOKEN }),
      // No catalogue: the point is to compute the artifact, not to check it against one.
      catalogue: null,
      workDir,
    });

    if (!result.ok) {
      console.error('Could not build that module:');
      for (const error of result.errors) console.error(`  • ${error}`);
      process.exit(1);
    }

    const { artifact } = result;

    console.error('\nRead the source at this exact commit before adding this entry.');
    console.error(`  ${url}/tree/${artifact.commitSha}`);
    console.error(`  Permissions requested: ${artifact.manifest.permissions.join(', ') || 'none'}`);
    console.error(`  Outbound hosts: ${artifact.manifest.network.join(', ') || 'none'}\n`);

    console.log(
      JSON.stringify(
        {
          moduleId: artifact.moduleId,
          version: artifact.version,
          commitSha: artifact.commitSha,
          bundleSha256: artifact.bundleSha256,
          name: artifact.manifest.name,
          description: artifact.manifest.description,
          author: artifact.manifest.author,
          repository: artifact.manifest.repository ?? url,
          permissions: artifact.manifest.permissions,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function signCatalogue(path: string): Promise<void> {
  let privateKeyPem: string;
  try {
    privateKeyPem = await readFile(PRIVATE_KEY_PATH, 'utf8');
  } catch {
    console.error(`No signing key at ${PRIVATE_KEY_PATH}. Run: npm run sign -- keygen`);
    process.exit(1);
  }

  const bytes = await readFile(resolve(path));

  // Parse before signing: signing malformed JSON would produce a valid signature over a file
  // the bot then rejects, which looks like an attack rather than a typo.
  let parsed: { entries?: unknown[]; expiresAt?: string };
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    console.error(`That file is not valid JSON: ${(error as Error).message}`);
    process.exit(1);
  }

  if (parsed.expiresAt && new Date(parsed.expiresAt) < new Date()) {
    console.error(`expiresAt (${parsed.expiresAt}) is in the past — the bot would reject this. Bump it first.`);
    process.exit(1);
  }

  const signature = cryptoSign(null, bytes, createPrivateKey(privateKeyPem));
  const outputPath = `${resolve(path)}.sig`;
  await writeFile(outputPath, signature);

  console.log(`Signed ${parsed.entries?.length ?? 0} entries.`);
  console.log(`Signature written to ${outputPath}`);
  console.log('Commit both files together — a signature without its catalogue verifies nothing.');
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case 'keygen':
    await keygen();
    break;
  case 'add':
    if (!argument) usage();
    await add(argument);
    break;
  case 'catalogue':
    if (!argument) usage();
    await signCatalogue(argument);
    break;
  default:
    usage();
}
