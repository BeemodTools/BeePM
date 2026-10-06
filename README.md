# BeePM

A package manager for [BEEmod](https://github.com/BEEmod/BEE2.4) packages, modeled on npm:
`@scope/name` packages with immutable versions, published to one registry, installed with
`beepm install` or the desktop app. See [DESIGN.md](DESIGN.md) for how it works.

```
core/     shared logic: package names, manifests, .bee_pack checks, the registry client and installer
server/   the registry API (Node + Postgres + a private bucket), deployed on Railway
cli/      the `beepm` command
app/      the Electron desktop app
```

## Development

Needs Node 22.12 or newer.

```bash
npm install
```

Start a local registry. With no settings it uses a PGlite database and a storage folder in
`server/.data`, and the login page offers "Continue with a test account" instead of Discord/GitHub:

```bash
npm run dev:server
```

Point the CLI at it (in another PowerShell terminal):

```powershell
$env:BEEPM_REGISTRY = "http://localhost:8787"
node cli/bin/beepm.js login
```

Run every test (core, server, and an end-to-end test that drives the CLI against a real server):

```bash
npm test
```

Useful environment variables for the client: `BEEPM_REGISTRY` (registry URL), `BEEPM_HOME`
(instead of `%APPDATA%\beepm`), `BEE2_CONFIG_DIR` (instead of `%APPDATA%\BEEMOD2\config`),
`BEEPM_TOKEN` (a publish token, for CI), `BEEPM_DEBUG=1` (stack traces).

## Using the CLI

```bash
beepm setup                       # pick your BEE2 version, get BEE2's own packages, hook BEE2
beepm login                       # Discord or GitHub, in your browser
beepm search items
beepm install @areng14/arengitems # or just: beepm install arengitems
beepm update
beepm publish ./MyPackage         # a folder or a .bee_pack; --dry-run only checks it,
                                  # --yes agrees to the publishing rules without asking
beepm publish --github Areng14/ArengBeemodPackages
beepm new ./MyPackage             # writes bee-package.json from info.txt
```

`beepm --help` lists everything (yank, deprecate, unpublish, owners, tokens, linking accounts, admin).

## Deploying the registry on Railway

The Railway project **BeePM** has three parts: a **Postgres** database, a bucket called
**Packages**, and the API service **beepm-registry** at
https://beepm-registry-production.up.railway.app.

The service builds with `server/Dockerfile` (set in its settings, along with the `/health`
health check). Its variables are listed in [server/.env.example](server/.env.example). The
database and bucket ones are references like `${{Postgres.DATABASE_URL}}` and
`${{Packages.BUCKET}}`.

To finish the setup:

1. Create the login apps and put their IDs and secrets in the service's variables
   (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`):
   - Discord: https://discord.com/developers/applications → New Application → OAuth2 → add the
     redirect `https://beepm-registry-production.up.railway.app/oauth/discord/callback`
   - GitHub: https://github.com/settings/developers → New OAuth App → callback URL
     `https://beepm-registry-production.up.railway.app/oauth/github/callback`
2. Connect the service to this repository's branch. Migrations run at startup.
3. Log in with an admin handle (`BOOTSTRAP_ADMINS`) and copy the old registry's packages over with
   `beepm admin import-legacy`. It's safe to run again.

The app and CLI use this registry by default (`DEFAULT_REGISTRY` in `core/src/client/api.js`).
