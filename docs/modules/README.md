# Writing a Tessel module

A module is a GitHub repository. Someone runs `/module install <your-repo-url>` in their
Discord server, approves what your module is allowed to do, and your commands appear — in
their server only, without the bot restarting.

This guide covers everything: the shape of a module, the manifest, the SDK, the permission
system, and how to get yours listed.

**Contents**

1. [Your first module](#1-your-first-module)
2. [The manifest](#2-the-manifest-modulejson)
3. [The SDK](#3-the-sdk)
4. [Permissions](#4-permissions)
5. [Storage](#5-storage)
6. [What you cannot do, and why](#6-what-you-cannot-do-and-why)
7. [Publishing and versioning](#7-publishing-and-versioning)
8. [Getting listed and signed](#8-getting-listed-and-signed)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Your first module

A module needs exactly two things: a `module.json` at the repository root, and the entry file
it points at.

```
my-first-module/
  module.json
  src/
    index.ts
```

**`module.json`**

```json
{
  "id": "com.github.yourname.greeter",
  "name": "Greeter",
  "version": "1.0.0",
  "apiVersion": "1",
  "description": "Greets people, and counts how many times.",
  "author": "yourname",
  "repository": "https://github.com/yourname/greeter",
  "entry": "src/index.ts",
  "permissions": ["storage"],
  "commands": [
    { "name": "greet", "description": "Say hello" }
  ]
}
```

**`src/index.ts`**

```ts
import { defineModule } from '@tessel/sdk';

export default defineModule({
  commands: {
    async greet(ctx) {
      const count = Number((await ctx.storage.get('greetings')) ?? '0') + 1;
      await ctx.storage.set('greetings', String(count));
      ctx.reply(`Hello! That's greeting number ${count} in this server.`);
    },
  },
});
```

Push it to GitHub. That is the whole module.

```
/module install https://github.com/yourname/greeter
/module load greeter
/greet
```

Each command in `commands` must have a handler of the same name in `defineModule`. A command
declared in the manifest with no handler will reply "Unknown command"; a handler with no
manifest entry is never reachable, because Discord only knows about commands the manifest
declared.

---

## 2. The manifest (`module.json`)

| Field | Required | What it is |
| --- | --- | --- |
| `id` | yes | Globally unique. Reverse-domain style, e.g. `com.github.yourname.greeter`. Letters, numbers, dots and hyphens only. |
| `name` | yes | Human-readable name, up to 64 characters. |
| `version` | yes | Semantic version, e.g. `1.2.0`. |
| `apiVersion` | yes | Currently `"1"`. Identifies which SDK contract you were written against. |
| `description` | yes | One or two sentences. Shown when someone installs your module. |
| `author` | yes | Your name or handle. |
| `entry` | yes | Path to your entry file, relative to the repository root. `.ts`, `.mts`, `.js` or `.mjs`. |
| `repository` | no | URL of your repository. |
| `icon` | no | Path to an image in your repository, used on the catalogue site. |
| `permissions` | no | What your module is allowed to do. See [Permissions](#4-permissions). Defaults to none. |
| `network` | no | Bare hostnames your module may contact, e.g. `["api.example.com"]`. Requires the `http` permission. |
| `commands` | no | The slash commands your module provides. Up to 50. |
| `storage` | no | `{ "quotaKb": 512 }`. How much data you may store per server. Max 10240. |

### Commands are data, not code

Your commands are declared in the manifest rather than discovered by running your module.
That is deliberate: it lets the bot register your slash commands **without ever executing your
code**. It also means adding a command requires a version bump and a `/module update`, not just
a code change.

```json
"commands": [
  {
    "name": "warn",
    "description": "Warn a member",
    "options": [
      { "name": "member", "description": "Who to warn", "type": "user", "required": true },
      { "name": "reason", "description": "Why", "type": "string" }
    ]
  }
]
```

Command names must be lowercase, 1–32 characters, letters/numbers/hyphens/underscores — that
is Discord's rule, not ours. Option `type` is one of `string`, `integer`, `number`, `boolean`,
`user`, `channel`, `role`, and defaults to `string`.

---

## 3. The SDK

Everything your module can do comes from `@tessel/sdk`. You do not install it — it is bundled
in for you at install time, from the bot's own copy.

```ts
import { defineModule } from '@tessel/sdk';
```

### The command context

Every handler receives a `ctx`:

```ts
interface CommandContext {
  guildId: string;                              // the server this ran in
  userId: string;                               // who ran it
  options: Record<string, string|number|boolean>; // the options they filled in
  storage: Storage;                             // your per-server storage
  reply(content: string): void;                 // answer them
}
```

`ctx.guildId` is set by the bot, not by you. You cannot act on a different server than the one
you were invoked from — see [What you cannot do](#6-what-you-cannot-do-and-why).

### Replying

Call `ctx.reply()` once. If your handler finishes without replying, the bot replies "Done." so
the person is not left watching a spinner. If your handler throws, they get a short failure
message and the details go to the bot's logs — never to the user.

```ts
async greet(ctx) {
  const who = ctx.options.member ?? ctx.userId;
  ctx.reply(`Hello, <@${who}>!`);
}
```

---

## 4. Permissions

Your module gets nothing by default. Every capability is requested in the manifest and
approved by the server admin, who sees your list in plain language before saying yes.

| Permission | What the admin is told |
| --- | --- |
| `messages.read` | Read the content of messages sent in this server. |
| `messages.send` | Send, edit and delete its own messages. |
| `messages.manage` | Delete other people's messages. |
| `reactions` | Add and remove reactions on messages. |
| `members.read` | See the list of members and their profile details. |
| `members.roles` | Give and take away roles from members. |
| `members.moderate` | Time out or kick members from this server. |
| `members.ban` | Ban and unban members from this server. |
| `channels.read` | See the list of channels and their settings. |
| `channels.manage` | Create, edit and delete channels. |
| `events.guild` | Be notified when members join or leave this server. |
| `voice.read` | See who joins, leaves and moves between voice channels. |
| `storage` | Save its own data for this server. |
| `scheduler` | Run tasks on a timer, even when nobody is using it. |
| `http` | Contact the internet addresses listed in `network`. |
| `discord.raw` | Make any Discord request within this server. |

**Ask for as little as possible.** The permission list is the main thing a cautious admin
reads, and the dangerous ones — `messages.read`, `members.ban`, `http`, `discord.raw` — are
called out separately and more loudly. A module asking for `discord.raw` when it only needed
`messages.send` will be installed by fewer people.

If you request a permission and use a capability you did not request, the call fails at
runtime and the refusal is written to that server's audit log.

---

## 5. Storage

`ctx.storage` is a per-server key/value store, namespaced to your module. Values are strings —
use `JSON.stringify` for anything richer.

```ts
async remember(ctx) {
  const notes = JSON.parse((await ctx.storage.get('notes')) ?? '[]');
  notes.push({ by: ctx.userId, at: Date.now() });
  await ctx.storage.set('notes', JSON.stringify(notes));
  ctx.reply(`Saved. ${notes.length} notes in this server.`);
}
```

Three guarantees:

- **Per server.** The same key in two servers holds two different values. You cannot read one
  server's data from another.
- **Per module.** Another module using the key `notes` does not see yours.
- **Quota'd.** You get `storage.quotaKb` (default 512 KB) *per server*. A write that would
  exceed it is refused and your `set()` call rejects — catch it if it matters.

Requires the `storage` permission.

---

## 6. What you cannot do, and why

Your module runs in a locked-down child process. It has no bot token, no database access, and
no filesystem. This is not a formality — it is enforced by two independent layers, and the bot
has a test suite that tries to break out of it on every build.

**You cannot:**

- `import` `node:fs`, `net`, `http`, `https`, `child_process`, `worker_threads`, `os`, `vm`,
  `process`, or similar. The bundler rejects these at install time with a clear error.
- Use `fetch`, `WebSocket` or `XMLHttpRequest`. They do not exist. Outbound HTTP is a brokered
  SDK call against the hostnames you declared.
- Read `process.env`, the bot token, or the bot's database.
- Depend on npm packages. There is no `node_modules`. If you need a library, vendor its source
  into your repository where a reviewer can see it, and import it relatively.
- Use `eval` or `new Function`.
- Act on a server other than the one that invoked you.

**You can** import `node:path`, `node:url`, `node:util`, `node:buffer`, `node:crypto`,
`node:events`, `node:stream`, `node:zlib`, `node:assert`, `node:timers` and
`node:string_decoder` — everything pure and local.

If a capability you genuinely need is missing, that is a gap in the SDK worth reporting rather
than working around.

---

## 7. Publishing and versioning

Your module is installed from a **specific commit**, resolved at install time. Moving a tag
does not change what anyone already has.

- Bump `version` in `module.json` for every release. Semantic versioning: patch for fixes,
  minor for new commands, major for breaking changes to how your commands behave.
- Tag your releases (`v1.2.0`) so people can install a specific one:
  `/module install https://github.com/you/yours/tree/v1.2.0`
- `/module update` re-resolves the ref, and if your new version asks for **more permissions
  than before**, the admin is asked to approve again. Adding permissions in a patch release is
  a good way to have your update declined.

---

## 8. Getting listed and signed

Anyone can install your module from its URL. Being listed in the catalogue makes it findable,
and being **signed** tells admins a human has reviewed it.

To request a listing, open an issue from the
[module catalogue page](https://anthonyf2312.github.io/modules.html) — it prefills the template.
Include your repository URL, a one-line description, and an icon if you have one.

**What signing means.** A signature covers your module's identity, the exact commit, and the
hash of the built bundle. If you retag, amend, or force-push after review, the hash changes and
your module goes back to unsigned until it is reviewed again. That is the point — it means a
signature cannot be inherited by code nobody looked at.

Unsigned modules still install. The person installing simply sees a warning first, telling them
plainly that nobody has reviewed the code and that it could be malware. Many will continue.
Some will not.

---

## 9. Troubleshooting

**"'node:fs' is not available inside the module sandbox"**
You imported something the sandbox denies. See [section 6](#6-what-you-cannot-do-and-why).

**"modules may not depend on npm packages"**
There is no `node_modules` at runtime. Vendor the source into your repository and import it
relatively.

**"it resolves outside the module directory"**
A relative import climbed above your repository root with `../`. Everything you import must
live inside your module.

**"module.json — permissions.0: Unknown permission 'x'"**
Check the spelling against [section 4](#4-permissions). The error names the value it rejected.

**"This repository has no module.json at its root"**
`module.json` must be at the top level of the repository, not in a subdirectory.

**"declares network hosts but does not request the 'http' permission"**
Add `"http"` to `permissions`, or remove the `network` entry. Listing hosts you cannot reach
would mislead the admin approving your module.

**My command does not appear**
Commands come from the manifest. Bump `version`, push, and have the admin run
`/module update`, then check `/module info <your-module>`.

**My module was auto-disabled**
It crashed or stopped responding three times within five minutes. The person who installed it
is told why. Check for unhandled rejections and for handlers that never return.
