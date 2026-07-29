/**
 * `module.json` — the contract between a module repository and core.
 *
 * Commands are declared here as DATA rather than discovered by running the module. That is
 * deliberate: it lets core register a module's slash commands without ever evaluating a
 * single line of untrusted code.
 */
import { z } from 'zod';
import { isPermissionId, PERMISSION_IDS } from './permissions.ts';

export const MANIFEST_API_VERSION = '1';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** Discord's own constraint for slash command names. */
const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;

/** A bare hostname. No scheme, no path, no port, no wildcard — and at least one dot. */
const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

/**
 * `id` becomes a directory name under data/modules/, so it is restricted to characters that
 * cannot mean anything to a filesystem. Dots are allowed for reverse-domain style, but a
 * literal `..` segment is not.
 */
const moduleId = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9.-]*$/i, 'must contain only letters, numbers, dots and hyphens')
  .refine((value) => !value.includes('..'), "must not contain '..'");

/**
 * `entry` is joined onto the extracted repository root. It must stay inside it.
 */
const entryPath = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => ![...value].some((ch) => ch.charCodeAt(0) === 0), 'must not contain a null byte')
  .refine((value) => !value.startsWith('/') && !value.startsWith('\\'), 'must be a relative path')
  .refine((value) => !/^[a-z]:/i.test(value), 'must be a relative path')
  .refine(
    (value) => !value.split(/[/\\]/).includes('..'),
    "must not climb outside the module with '..'",
  )
  .refine((value) => /\.(ts|mts|js|mjs)$/.test(value), 'must point at a .ts, .mts, .js or .mjs file');

const commandOption = z.object({
  name: z.string().regex(COMMAND_NAME),
  description: z.string().min(1).max(100),
  type: z.enum(['string', 'integer', 'number', 'boolean', 'user', 'channel', 'role']).default('string'),
  required: z.boolean().default(false),
});

/**
 * Who may use a command.
 *
 * Declared per command because a module that manages warnings or channels should not be
 * callable by everyone, and the author is the one who knows which is which. Enforced twice:
 * registered with Discord as `defaultMemberPermissions` (which server admins can override, so
 * it is UX), and re-checked at dispatch time by core (which is the actual enforcement).
 */
const commandAccess = z
  .enum(['everyone', 'manage_messages', 'moderate_members', 'manage_channels', 'manage_guild', 'administrator'])
  .default('everyone');

const command = z.object({
  name: z.string().regex(COMMAND_NAME, 'must be lowercase letters, numbers, hyphens or underscores'),
  description: z.string().min(1).max(100),
  options: z.array(commandOption).max(25).default([]),
  restrictTo: commandAccess,
});

const permissionId = z.string().superRefine((value, ctx) => {
  if (!isPermissionId(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      // The offending value is named so the install report can tell the author exactly
      // which permission to fix.
      message: `Unknown permission '${value}'. Valid permissions are: ${PERMISSION_IDS.join(', ')}.`,
    });
  }
});

export const manifestSchema = z
  .object({
    id: moduleId,
    name: z.string().min(1).max(64),
    version: z.string().regex(SEMVER, 'must be a semantic version such as 1.2.0'),
    apiVersion: z.literal(MANIFEST_API_VERSION, {
      errorMap: () => ({
        message: `unsupported apiVersion — this bot speaks module API version ${MANIFEST_API_VERSION}`,
      }),
    }),
    description: z.string().min(1).max(500),
    author: z.string().min(1).max(100),
    repository: z.string().url().optional(),
    icon: z.string().max(256).optional(),
    entry: entryPath,
    permissions: z.array(permissionId).max(PERMISSION_IDS.length).default([]),
    network: z.array(z.string().regex(HOSTNAME, 'must be a bare hostname such as api.example.com')).max(20).default([]),
    commands: z.array(command).max(50).default([]),
    storage: z.object({ quotaKb: z.number().int().min(1).max(10_240) }).default({ quotaKb: 512 }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const cmd of value.commands) {
      if (seen.has(cmd.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate command name '${cmd.name}'`,
          path: ['commands'],
        });
      }
      seen.add(cmd.name);
    }

    // Declaring hosts without the permission is a manifest bug worth surfacing early;
    // silently ignoring it would mislead the admin reading the consent panel.
    if (value.network.length > 0 && !value.permissions.includes('http')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "declares network hosts but does not request the 'http' permission",
        path: ['network'],
      });
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;

export type ManifestResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: string[] };

/**
 * Validates a parsed `module.json`.
 *
 * Returns a result rather than throwing because every failure here is reported back to the
 * installing admin as a list of things the module author needs to fix.
 */
export function parseManifest(input: unknown): ManifestResult {
  const parsed = manifestSchema.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };

  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const where = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${where}${issue.message}`;
    }),
  };
}
