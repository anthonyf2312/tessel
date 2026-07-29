# Running Tessel on your home server

Tessel is **outbound only**. It opens a websocket to Discord and fetches from GitHub; it
listens on no ports and needs no reverse proxy, no domain and no port forwarding. Your router
does not need to know it exists.

That means Tailscale here is for *you* — SSH access to administer the box — not for the bot to
work. If Tailscale is down, the bot keeps running; you just can't reach the server as easily.

---

## 1. Prepare the server

Node 24 or newer is required. The sandbox depends on `--permission` and `module.registerHooks`,
neither of which exists in older releases.

```sh
# Debian / Ubuntu
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
node --version    # must be v24 or newer
```

Create a user that owns nothing else. The bot holds a token; it should not run as you or as
root.

```sh
sudo useradd --system --create-home --home-dir /opt/tessel --shell /usr/sbin/nologin tessel
```

## 2. Get the code onto it

```sh
sudo -u tessel git clone https://github.com/anthonyf2312/tessel.git /opt/tessel
cd /opt/tessel
sudo -u tessel npm install --omit=dev
```

`npm install` is needed on the server — `node_modules` is not committed, and Tessel runs
TypeScript directly through `tsx` rather than building to `dist/`.

## 3. Configure it

```sh
sudo -u tessel cp .env.example .env
sudo -u tessel nano .env
sudo chmod 600 /opt/tessel/.env
```

Fill in `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`.

**The `.env` file is the one thing on this server worth stealing.** It is gitignored, so it
will never be committed, but check its permissions are `600` and that it is owned by `tessel`.

### About the signing key

Generate the catalogue signing key **on your own machine, not on the server**:

```sh
npm run sign -- keygen
```

The server only ever needs the *public* half, which goes in `.env` as `CATALOGUE_PUBLIC_KEY`.
Keep `signing/private.key` off the server entirely — nothing running there needs it, and a
server that can be compromised should not be able to mark a module as reviewed.

If you leave `CATALOGUE_PUBLIC_KEY` blank, nothing can be verified and every module is treated
as unsigned. The bot still works; every install just shows the warning.

## 4. Run it

```sh
sudo cp /opt/tessel/deploy/tessel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tessel

systemctl status tessel
journalctl -u tessel -f
```

The unit restarts the bot on failure, and gives up after 5 failures in 5 minutes so a crash
loop is visible rather than silently retried forever.

> **Don't add `MemoryDenyWriteExecute=true`.** It is usually good hardening, but V8 needs
> writable-executable pages for JIT and Node will refuse to start. The unit file says so too,
> in case someone tightens it later.

## 5. Administering it over Tailscale

```sh
# on the server
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

Then from anywhere on your tailnet:

```sh
ssh youruser@tessel            # MagicDNS name
journalctl -u tessel -f        # watch it
```

With `--ssh`, Tailscale handles authentication and you can close port 22 to the internet
entirely. If you would rather use plain SSH over the tailnet, that works too — just bind
sshd to the Tailscale interface.

Nothing about Tessel needs to be exposed on the tailnet either. There is no web UI and no
API; `journalctl` and `systemctl` are the whole admin surface.

---

## Updating

**Only core changes need a restart.** Installing, enabling, updating and removing *modules* all
happen live — that is the point of the architecture. Restart only when you pull new bot code.

```sh
cd /opt/tessel
sudo -u tessel git pull
sudo -u tessel npm install --omit=dev
sudo systemctl restart tessel
```

Enabled modules are restored automatically on boot, so a restart does not lose state.

## Backups

Everything that matters is in `/opt/tessel/data`:

- `tessel.db` — which servers have which modules, granted permissions, module storage, audit log
- `modules/` — the extracted bundles, re-downloadable from GitHub

Back up the database. The bundles can be rebuilt from their pinned commits.

```sh
sudo -u tessel sqlite3 /opt/tessel/data/tessel.db ".backup '/opt/tessel/data/backup.db'"
```

Use SQLite's `.backup` rather than copying the file — the database runs in WAL mode, and a
plain `cp` of a live WAL database can capture a torn state.

## Troubleshooting

**`Tessel cannot start — check your .env file`**
Config validation failed at boot and the message names the field. This is deliberate: a
malformed config should stop the bot loudly rather than fail confusingly later.

**Commands don't appear in a server**
The bot needs the `applications.commands` scope. Re-invite it with both `bot` and
`applications.commands`, then run `/module load` again.

**`ERR_DLOPEN_DISABLED` or sandbox spawn failures**
Almost always Node being older than 24 on the server. Check `node --version` — systemd may be
using a different Node than your login shell.

**A module keeps getting auto-disabled**
It crashed or stopped responding three times inside five minutes. `journalctl -u tessel` will
show the reason, and the person who installed it is notified in Discord.
