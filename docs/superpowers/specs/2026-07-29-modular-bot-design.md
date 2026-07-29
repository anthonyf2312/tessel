# Modular Bot — per-guild sandboxed module system

## Context

You want a Discord bot whose features are **modules** that server admins install from GitHub
and enable per guild, so a module enabled in one server is invisible in every other. Installing,
enabling, updating and removing a module must never restart the bot — only edits to core code may.

The hard constraint driving the whole design: **a module is untrusted third-party code.** If it
runs inside the bot process it can read `process.env.DISCORD_TOKEN`, open the SQLite file and
exfiltrate everything. Node's `vm` module is explicitly not a security boundary, so this has to be
solved architecturally, not by code review.

Your existing `public discordbot/` is already a modular hot-reloading bot (discord.js v14, Drizzle,
registry dispatch, chokidar). Its modules are *trusted local files*; that assumption is baked into
its loader and dispatcher. We build fresh in `Modular Bot/` and reuse the patterns that work, rather
than retrofitting a trust boundary onto a codebase that never had one.

### Decisions taken during design

| Decision | Choice |
| --- | --- |
| Isolation | Hard sandbox: child process + capability-brokered RPC |
| SDK surface | Typed SDK + permission-gated raw-REST escape hatch |
| Dependencies | None. Core bundles module TypeScript with esbuild |
| Install policy | **Open** — any GitHub URL, any admin with Manage Guild |
| Trust signalling | Signed vs unsigned; unsigned installs show an explicit malware warning |
| Starting point | Fresh workspace, borrowing proven patterns |
| Sequencing | Sandbox first, then commands, then SDK, then site |

**Noted risk, accepted by you:** open installs mean a module can still be malicious *within its
granted permissions* — e.g. a "leveling" module declaring `messages.read` plus an outbound host can
ship member messages to its author. Mitigations designed in: **signed vs unsigned trust state** (below),
deny-by-default permissions, an explicit consent panel at enable time, a per-guild audit log of
privileged calls, and an owner kill-switch that revokes a module across every guild.

Verified on this machine: Node **v24.13.0**, npm 11.6.2. `node --permission` is accepted and
`module.registerHooks` is a function — both sandbox primitives are available natively.

---

## Architecture

**One trusted core process. N untrusted module processes.**

Core owns the token and the single discord.js client. Gateway listeners attach exactly once at boot
and route every interaction through a registry looked up *at call time*. Each installed module runs
in its own child process, shared across the guilds that enabled it, spawned lazily on first enable
and killed when the last guild disables it. Module code never imports discord.js and never sees the
token; it talks to core over IPC through a typed SDK.

```
Modular Bot/
  apps/bot/src/
    core/        client, dispatcher, module-manager, supervisor, installer,
                 permissions, command-deploy, ui (CV2 helpers), env, logger
    commands/    /module install|load|unload|list|info|update|uninstall
    index.ts
  packages/protocol/   RPC envelope + zod schemas, manifest schema, apiVersion
  packages/sandbox-runtime/  the --import bootstrap that hardens the child
  packages/sdk/        @modular/sdk — the surface module authors import
  packages/db/         drizzle + better-sqlite3 schema and helpers
  docs/modules/        authoring guide
  examples/            hello-world, moderation-lite
```

Stack: TypeScript, discord.js v14 (Components V2), Drizzle + better-sqlite3, zod, pino, esbuild,
tsx, Vitest, npm workspaces. Mirrors `public discordbot/package.json` conventions.

### The sandbox — defense in depth

Spawned as `node --permission --allow-fs-read=<bundleDir> --max-old-space-size=<cap>
--import @modular/sandbox-runtime/bootstrap <bundle>` with `env: {}` and `stdio: ['ignore','pipe','pipe','ipc']`.

The bootstrap runs **before** module code and:

1. Deletes `globalThis.fetch`, `WebSocket`, `XMLHttpRequest`, `process.env`, `process.binding`
2. `module.registerHooks` resolve hook denying `node:net|http|https|http2|dgram|dns|tls|fs|child_process|worker_threads|vm|inspector|module|process`
3. Captures the IPC channel into a closure, then deletes `process.send`/`process.on`
4. Freezes intrinsics, then imports the bundle

`--permission` independently blocks `child_process`, `worker_threads`, native addons and all
filesystem writes — escaping requires defeating **both** layers. A heartbeat watchdog hard-kills a
hung or spinning module.

Outbound HTTP is not exposed as a global; it is an SDK call brokered by core, which enforces the
manifest's `network` host allowlist. That is why deleting `fetch` matters — it removes the only
un-brokered egress path.

### RPC contract

Correlated request/response over IPC, every message zod-validated on both ends. Core checks four
things before executing any privileged op:

1. The module declared this permission in its manifest **and** the guild granted it
2. The module is currently enabled for the acting guild
3. The target entity (channel, member, role, message) belongs to that guild
4. The module is within its rate-limit and storage quota budget

`discord.raw` is the escape hatch: core injects the token, pins the guild ID into the route, rejects
cross-guild and application-level routes, and surfaces "can make arbitrary Discord API calls" in the
consent panel.

### Manifest

`module.json` declares **commands as data**, so core registers slash commands without ever executing
module code:

```json
{
  "id": "com.github.user.moderation",
  "name": "Moderation",
  "version": "1.2.0",
  "apiVersion": "1",
  "description": "Reports rule breaks to a mod channel.",
  "author": "user",
  "repository": "https://github.com/user/moderation",
  "icon": "icon.png",
  "entry": "src/index.ts",
  "permissions": ["messages.read", "members.moderate"],
  "network": ["api.example.com"],
  "commands": [{ "name": "warn", "description": "Warn a member", "options": [] }],
  "storage": { "quotaKb": 512 }
}
```

### Install and enable flow

`/module install <url>`:
resolve GitHub ref → **immutable commit SHA** → download tarball (size cap, file-count cap,
path-traversal-safe extract) → zod-validate manifest, reject unknown permissions / bad semver /
`apiVersion` mismatch → advisory static scan (`eval`, `Function(`, dynamic import of denied
builtins) → **esbuild bundle** to one ESM file, no plugins → record sha256 → report a Components V2
panel listing what loaded and what failed and why.

esbuild only parses and rewrites; it never executes the module's code. Nothing untrusted runs on the
host at install time.

`/module load <module>`: consent panel showing every permission and outbound host → admin approves →
guild-scoped commands registered via REST → process spawned or attached.

Also `/module list`, `/module info`, `/module update` (re-resolves the tag, diffs the permission set
and re-prompts if it grew), `/module unload`, `/module uninstall`.

### Module signing and trust state

Every module carries a trust state — **signed** or **unsigned** — computed by core at install time.
There is no third state; anything that is not provably signed is unsigned.

**What a signature covers.** An ed25519 detached signature over the catalogue index, where each
entry binds `moduleId + version + commit SHA + bundle sha256`. It deliberately does *not* cover the
repo URL: tags move and branches get force-pushed, so a URL signature guarantees nothing. Because
the signature covers the built artifact's hash, an author who retags or amends after review produces
a different hash, and the module **silently drops back to unsigned** until re-reviewed. That
tamper-evidence is the entire value of the mechanism.

**How it works.** You hold an ed25519 private key offline; the public key is compiled into core (and
overridable by env for self-hosters running their own catalogue). The catalogue is published as
`modules.json` + a detached `modules.json.sig` on the GitHub Pages site. Core fetches and caches it
with a TTL, verifies the signature, then checks the module being installed against it. The index
carries `issuedAt` / `expiresAt` so an attacker cannot serve a stale index that still vouches for a
since-revoked version, and a `revoked[]` array that core honours by disabling matching installs.

**Reproducibility.** The bundle hash must be identical on your machine and the user's, so esbuild is
version-pinned and invoked with fixed, deterministic options. Signing is a repo CLI
(`npm run sign -- <url>`) that runs the *exact same* installer pipeline, so what you sign is
byte-for-byte what users get.

**Fail closed on trust, open on function.** If the catalogue is unreachable or its signature fails to
verify, core does not guess — every module is treated as unsigned and the warning shows. The bot
keeps working; it just stops vouching for anything.

**Unsigned install UX.** `/module install` on an unverifiable artifact returns a red Components V2
warning panel before anything is written to disk:

> **⚠️ This module is not signed.**
> Nobody has reviewed this code. It could be malware. It can do anything the permissions below
> allow — including reading your members' messages and sending them to a server its author controls.
> Only continue if you personally trust whoever wrote it.

The panel lists every requested permission in plain language and every outbound host, and requires a
second explicit confirmation click (a distinct danger-styled button, never the default focus). The
decision, the acting user and the artifact hashes are written to `module_audit`.

Signed modules skip the warning but still show the normal permission consent panel at enable time —
signing means *reviewed*, not *harmless*.

**Where trust state is surfaced.** The install report, `/module info`, `/module list`, the enable
consent panel, and the catalogue site cards. An unsigned module already installed keeps a visible
marker in `/module list` rather than becoming invisible after the fact.

### Data model (Drizzle / SQLite)

`modules` (artifact: id, version, commit sha, bundle sha256, manifest json, **trust state + the
catalogue entry it verified against**) ·
`guild_modules` (guild ↔ module, enabled, granted permissions, installer user id,
**unsigned-warning acknowledgement: who accepted and when**) ·
`module_kv` (namespaced per module+guild, quota-enforced) ·
`module_audit` (every privileged RPC: module, guild, op, target, outcome; plus install decisions) ·
`module_revocations` (owner kill-switch) ·
`catalogue_cache` (last verified index bytes, signature, `issuedAt`/`expiresAt`, fetch time).

Per-guild state lives in the DB, never in process memory, keeping the design sharding-ready.

### Failure handling

Module crash → supervisor restarts with exponential backoff → after 3 failures inside 5 minutes it
auto-disables for that guild and notifies the installer. RPC timeout → hard kill. Errors never leak internals: users
get a generic ephemeral message, details go to pino. Per-module circuit breaker so one bad module
can't degrade the others.

### Why nothing needs a restart

Modules are processes (spawn/kill), commands are guild-scoped REST registrations made on demand, and
the dispatcher resolves handlers from a registry per call. Adding, updating or removing a module
never touches the core process. Only edits under `apps/bot/src/core/**` require a restart — exactly
your rule, and it gets stated in the README the way `public discordbot` states it.

---

## Implementation phases

### Phase 1 — Protocol and sandbox (the security boundary, built and proven first)
- `packages/protocol`: RPC envelope, manifest zod schema, permission catalogue, `apiVersion`
- `packages/sandbox-runtime`: the bootstrap described above
- `core/supervisor.ts`: spawn, heartbeat, backoff, hard kill
- **Escape-test suite** — the gate for this phase. From inside a really-spawned sandbox, assert
  failure for: reading `/etc/passwd` and the SQLite file, any fs write, `require('child_process')`,
  `worker_threads`, dynamic `import('node:net')`, `fetch`, reading `process.env.DISCORD_TOKEN`,
  re-patching frozen intrinsics, and reaching the raw IPC channel.

### Phase 2 — Module manager and `/module` commands
- `core/installer.ts`: GitHub resolve → tarball → validate → scan → esbuild → record
- `core/signing.ts`: ed25519 verification, catalogue fetch + cache + TTL + expiry, revocation handling
- `core/module-manager.ts`, `core/permissions.ts`, `core/command-deploy.ts`, registry + dispatcher
- `packages/db` schema and helpers; the `/module` command group with CV2 panels, the unsigned
  warning panel and the enable consent flow
- `scripts/sign.ts`: the signing CLI that reuses the installer pipeline verbatim
- Tests: path traversal, zip-bomb caps, manifest fuzzing, cross-guild RPC rejection, permission
  gates, and the signing suite — valid signature accepts, tampered bundle rejects, wrong key
  rejects, expired index rejects, revoked entry disables, unreachable catalogue degrades to
  unsigned, and bundle hashes are reproducible across runs

### Phase 3 — SDK and examples
- `packages/sdk`: interactions (reply/edit/defer/followup), messages, embeds and components, members
  (fetch, roles, timeout, kick, ban), channels, guild events, scheduled tasks, KV storage,
  brokered `http` against the manifest allowlist, and `discord.raw`
- `examples/hello-world` and `examples/moderation-lite`, both installed end-to-end as a test

### Phase 4 — Docs and the catalogue site
- `docs/modules/`: getting started, manifest reference, SDK API reference, permission catalogue,
  security model (what the sandbox does and does not protect against), the signing model and how to
  get a module signed, publishing and listing guide
- `githubPages/modules.html` + `modules.js` + `modules.json` + `modules.json.sig`, matching the
  existing hand-written style: Inter + IBM Plex Mono, dark with papaya accent, self-hosted GSAP
  reveals, `?v=N` cache-busting, `.nojekyll`. Cards show image, name, version, author, description,
  a **signed badge**, **declared permission badges** and a copy-to-clipboard install URL. Client-side
  search and tag filter, including a signed-only filter.
  "Request a module" opens a prefilled GitHub issue — no backend, no data collection.
- Add `modules` to the site nav; add an entry to `githubPages/README.md`; bump the `?v=` counters.

---

## Verification

- `npm test` — Vitest, with the Phase 1 escape suite as the non-negotiable gate
- `npm run typecheck` across all workspaces
- Manual end-to-end in a dev guild: `/module install` the hello-world example from a real GitHub
  repo, confirm the report panel, `/module load`, confirm the command appears **only** in that guild,
  invoke it, then `/module unload` and confirm the command disappears — all without restarting
- Confirm zero-restart: run the whole install→load→update→unload cycle against a continuously
  running process and check uptime never resets
- Second guild check: enable in guild A only, confirm guild B sees neither the module nor its commands
- Audit check: after the run, `module_audit` contains one row per privileged call
- Signing end-to-end: install an unsigned module and confirm the warning panel blocks on a second
  explicit confirmation; sign the same artifact with `npm run sign`, publish the index, reinstall and
  confirm it reports signed; then mutate one byte of the module source, rebuild, and confirm it drops
  back to unsigned
- Site: serve `githubPages/` locally, verify cards render from `modules.json`, copy-button works,
  layout holds at mobile widths, and the page degrades without JS
