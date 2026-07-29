/**
 * Configuration, validated at boot.
 *
 * A malformed config should stop the bot with a readable message, not surface later as a
 * confusing runtime failure. The token lives here and nowhere else — it is never passed to a
 * module process, which is spawned with an empty environment.
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Load .env from the repository root, not the working directory.
 *
 * `npm run dev` runs the bot with cwd set to apps/bot, so the bare `dotenv/config` import
 * looked for apps/bot/.env and silently found nothing — which surfaced as "DISCORD_TOKEN:
 * Required" even though the file was sitting right there in the root.
 *
 * Real environment variables still win: dotenv does not overwrite what is already set, so
 * systemd `Environment=` or a container's env take precedence over the file.
 */
loadDotenv({ path: fileURLToPath(new URL('../../../../.env', import.meta.url)) });

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN is required — get it from the Developer Portal'),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d{17,20}$/, 'DISCORD_APPLICATION_ID must be a Discord snowflake'),

  /** Bot owners. Only these users can revoke a module across every server. */
  OWNER_IDS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean)),

  DATA_DIR: z.string().default('./data'),

  /** Where the signed catalogue lives. Self-hosters can point this at their own. */
  CATALOGUE_URL: z.string().url().default('https://anthonyf2312.github.io/modules.json'),

  /**
   * base64 SPKI ed25519 public key for the catalogue. Optional: without it nothing can be
   * verified, so every module reads as unsigned — which is the safe direction to fail.
   */
  CATALOGUE_PUBLIC_KEY: z.string().optional(),

  /** Optional PAT. Only raises GitHub's rate limit. */
  GITHUB_TOKEN: z.string().optional(),

  /** When set, module installs from arbitrary URLs are limited to bot owners. */
  RESTRICT_UNLISTED_INSTALLS: z
    .string()
    .default('false')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  console.error(`Tessel cannot start — check your .env file:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
