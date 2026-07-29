/**
 * `npm run review -- <github-url | local path>`
 *
 * Everything a machine can tell you about a module, so the part only a human can do is the
 * part you actually spend time on.
 *
 * Two audiences, one tool:
 *   - **Authors**, before publishing: does it validate, does it bundle, is it asking for more
 *     than it needs?
 *   - **Reviewers**, before signing: what does it want, what does it reach for in the code, and
 *     what is the exact catalogue entry for this commit?
 *
 * It never runs the module. esbuild parses and rewrites; nothing here executes what it reads,
 * which is what makes it safe to point at a stranger's repository.
 *
 * What it CANNOT tell you is whether the code is honest. A module can pass every check here and
 * still quietly forward messages to its author. The findings below are prompts for reading, not
 * a verdict.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseManifest, PERMISSIONS, type Manifest } from '@tessel/protocol';
import { bundleModule, createGitHubClient, installModule } from '@tessel/installer';

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const YELLOW = '[33m';
const GREEN = '[32m';
const RESET = '[0m';

function heading(text: string): void {
  console.log(`\n${BOLD}${text}${RESET}`);
}

/**
 * Patterns worth a human looking at.
 *
 * Each is tied to the permission that would make it possible. That matters more than it looks:
 * the bundle contains the whole SDK, so a naive scan matches `banMember` in every module ever
 * built. Filtering by declared permission removes that noise — and a call the module has no
 * permission for would be refused at runtime anyway.
 *
 * None of these are proof of anything. `fetch` in a module that declared `http` is exactly what
 * you would expect. They exist so a reviewer reads the right twenty lines instead of all four
 * hundred.
 */
const SIGNALS: { pattern: RegExp; note: string; loud: boolean; requires?: string }[] = [
  { pattern: /\.raw\s*\(/, note: 'uses the raw Discord API escape hatch', loud: true, requires: 'discord.raw' },
  { pattern: /\.fetch\s*\(/, note: 'makes outbound HTTP requests', loud: true, requires: 'http' },
  { pattern: /\.content\b/, note: 'reads message content', loud: true, requires: 'messages.read' },
  { pattern: /banMember\s*\(/, note: 'bans members', loud: true, requires: 'members.ban' },
  { pattern: /kickMember\s*\(/, note: 'kicks members', loud: false, requires: 'members.moderate' },
  { pattern: /timeoutMember\s*\(/, note: 'times members out', loud: false, requires: 'members.moderate' },
  { pattern: /deleteChannel\s*\(/, note: 'deletes channels', loud: true, requires: 'channels.manage' },
  { pattern: /createRole\s*\(|deleteRole\s*\(/, note: 'creates or deletes roles', loud: false, requires: 'members.roles' },
  { pattern: /deleteMessage\s*\(/, note: "deletes other people's messages", loud: false, requires: 'messages.manage' },

  // These need no permission to be worth a second look, so they are always reported.
  { pattern: /atob\s*\(|Buffer\.from\s*\([^)]*base64/i, note: 'decodes base64 — check what', loud: true },
  { pattern: /[A-Za-z0-9+/]{200,}={0,2}/, note: 'contains a very long opaque string literal', loud: true },
  { pattern: /\beval\s*\(|new\s+Function\s*\(/, note: 'references eval or Function', loud: true },
  { pattern: /setInterval\s*\(/, note: 'runs work on a timer', loud: false },
];

export interface Reviewed {
  manifest: Manifest;
  code: string;
  sha256: string;
  commitSha: string | null;
  source: string;
}

export async function reviewFromGitHub(url: string): Promise<Reviewed> {
  const workDir = await mkdtemp(join(tmpdir(), 'tessel-review-'));

  try {
    const result = await installModule({
      url,
      github: createGitHubClient({ token: process.env.GITHUB_TOKEN }),
      // No catalogue: the job is to look at the artifact, not to check it against one.
      catalogue: null,
      workDir,
    });

    if (!result.ok) {
      console.error(`${RED}This module does not install.${RESET}`);
      for (const error of result.errors) console.error(`  • ${error}`);
      process.exit(1);
    }

    return {
      manifest: result.artifact.manifest,
      code: result.artifact.bundleCode,
      sha256: result.artifact.bundleSha256,
      commitSha: result.artifact.commitSha,
      source: url,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function reviewFromDisk(path: string): Promise<Reviewed> {
  const root = resolve(path);

  let raw: string;
  try {
    raw = await readFile(join(root, 'module.json'), 'utf8');
  } catch {
    console.error(`${RED}No module.json at ${root}.${RESET}`);
    process.exit(1);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    console.error(`${RED}module.json is not valid JSON: ${(error as Error).message}${RESET}`);
    process.exit(1);
  }

  const manifest = parseManifest(parsedJson);
  if (!manifest.ok) {
    console.error(`${RED}module.json is not valid:${RESET}`);
    for (const issue of manifest.errors) console.error(`  • ${issue}`);
    process.exit(1);
  }

  const bundle = await bundleModule(root, manifest.manifest.entry);
  if (!bundle.ok) {
    console.error(`${RED}This module does not build:${RESET}`);
    for (const error of bundle.errors) console.error(`  • ${error}`);
    process.exit(1);
  }

  return {
    manifest: manifest.manifest,
    code: bundle.code,
    sha256: bundle.sha256,
    commitSha: null,
    source: root,
  };
}

function reportManifest({ manifest, source, commitSha, sha256, code }: Reviewed): void {
  heading('Module');
  console.log(`  ${manifest.name} v${manifest.version} — ${manifest.id}`);
  console.log(`  by ${manifest.author}`);
  console.log(`  ${DIM}${manifest.description}${RESET}`);
  console.log(`  ${DIM}source: ${source}${RESET}`);
  if (commitSha) console.log(`  ${DIM}commit: ${commitSha}${RESET}`);
  console.log(`  ${DIM}bundle: ${(code.length / 1024).toFixed(1)} KB · sha256 ${sha256}${RESET}`);
}

function reportPermissions({ manifest }: Reviewed): void {
  heading('What it is asking for');

  if (manifest.permissions.length === 0) {
    console.log(`  ${GREEN}Nothing. It can only reply to its own commands.${RESET}`);
  } else {
    const known = new Set(manifest.permissions);
    for (const entry of PERMISSIONS) {
      if (!known.has(entry.id)) continue;
      const marker = entry.dangerous ? `${YELLOW}!${RESET}` : ' ';
      console.log(`  ${marker} ${entry.id.padEnd(18)} ${DIM}${entry.consentText}${RESET}`);
    }
  }

  if (manifest.network.length > 0) {
    console.log(`\n  ${YELLOW}!${RESET} Sends data to: ${manifest.network.join(', ')}`);
  }

  // The combination that lets a module move your members' conversations off the server.
  if (manifest.permissions.includes('messages.read') && manifest.permissions.includes('http')) {
    console.log(
      `\n  ${RED}${BOLD}This module can read messages AND contact the internet.${RESET}\n` +
        `  ${RED}Anything said in the server can be sent to ${manifest.network.join(', ') || 'its declared hosts'}.${RESET}\n` +
        `  ${RED}Read every use of fetch() before trusting this.${RESET}`,
    );
  }

  if (manifest.permissions.includes('discord.raw')) {
    console.log(
      `\n  ${YELLOW}It asks for discord.raw — it can make any Discord request within a server.${RESET}\n` +
        `  ${DIM}Ask whether a specific capability would have done instead.${RESET}`,
    );
  }
}

function reportCommands({ manifest }: Reviewed): void {
  heading('Commands it adds');
  if (manifest.commands.length === 0) {
    console.log(`  ${DIM}none — it is events-only${RESET}`);
    return;
  }
  for (const command of manifest.commands) {
    const options = command.options.map((o) => `${o.name}:${o.type}`).join(' ');
    console.log(
      `  /${command.name.padEnd(20)} ${DIM}${command.description}${options ? ` (${options})` : ''}${RESET}`,
    );
  }
}

function reportSignals({ code, manifest }: Reviewed): void {
  heading('Worth reading in the source');

  const declared = new Set(manifest.permissions);
  const found = SIGNALS.filter(
    (signal) => (!signal.requires || declared.has(signal.requires)) && signal.pattern.test(code),
  );

  if (found.length === 0) {
    console.log(`  ${DIM}nothing stood out${RESET}`);
    return;
  }

  for (const signal of found) {
    const marker = signal.loud ? `${YELLOW}!${RESET}` : ' ';
    console.log(`  ${marker} ${signal.note}`);
  }
  console.log(`\n  ${DIM}None of these are wrong on their own. They are where to look.${RESET}`);
}

export function catalogueEntryFor({
  manifest,
  commitSha,
  sha256,
}: Reviewed): Record<string, unknown> {
  return {
    moduleId: manifest.id,
    version: manifest.version,
    commitSha,
    bundleSha256: sha256,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    repository: manifest.repository ?? '',
    permissions: manifest.permissions,
  };
}

function reportChecklist(reviewed: Reviewed): void {
  const { manifest, commitSha } = reviewed;

  heading('What only you can check');
  console.log('  1. Does the code do what the description says, and nothing else?');
  console.log('  2. Is every permission it asks for actually used?');

  let step = 3;
  if (manifest.permissions.includes('http')) {
    console.log(
      `  ${step++}. What exactly is sent to ${manifest.network.join(', ')} — and is it necessary?`,
    );
  }
  console.log(`  ${step}. Would you run this in your own server?`);

  if (!commitSha) {
    console.log(`\n  ${DIM}Reviewed from disk, so there is no commit to sign. Point this at the${RESET}`);
    console.log(`  ${DIM}GitHub URL when you are ready to add it to the catalogue.${RESET}`);
    return;
  }

  heading('If you are satisfied, the catalogue entry is');
  console.log(
    JSON.stringify(catalogueEntryFor(reviewed), null, 2)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  );
  console.log(
    `\n  ${DIM}Paste into "entries" in modules.json, remove it from "listings",${RESET}\n` +
      `  ${DIM}then: npm run sign -- catalogue <path-to-modules.json>${RESET}`,
  );
  console.log(
    `\n  ${YELLOW}Signing says a person read this code at this exact commit.${RESET}\n` +
      `  ${DIM}If the author pushes again, the hash changes and it drops back to unreviewed.${RESET}`,
  );
}

const target = process.argv[2];

if (!target) {
  console.error('Usage: npm run review -- <github-url | path/to/module>');
  process.exit(1);
}

const isUrl = /^https?:\/\//i.test(target);
const reviewed = isUrl
  ? await reviewFromGitHub(target)
  : await reviewFromDisk(isAbsolute(target) ? target : resolve(target));

console.log(`${BOLD}Tessel module review${RESET}`);
reportManifest(reviewed);
reportPermissions(reviewed);
reportCommands(reviewed);
reportSignals(reviewed);
reportChecklist(reviewed);
console.log('');
