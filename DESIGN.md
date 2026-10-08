# BeePM design

BeePM is a package manager for BEEmod (BEE2) packages, modeled on npm: a central
registry of scoped packages with immutable semver versions, and a client (desktop
app and `beepm` CLI) that installs them into the folder BEE2 loads packages from.

```
core/     @beepm/core    shared logic: names, manifests, .bee_pack checks, registry client, installer
server/   @beepm/server  registry API on Railway (Node + Postgres + a private bucket)
cli/      beepm          the `beepm` command
app/      @beepm/app     Electron desktop app
```

## What changed from the prototype

The unreleased prototype (Electron app + Python CLI + an R2 bucket) enforced every rule
on the user's machine. The real gate was the R2 write keys in `cli/.env`, and identity
came from a local `auth.json` that anyone could edit. In BeePM 1.0 the server is the only
thing that can write to storage, and it decides who can do what.

| | Prototype | BeePM 1.0 |
|---|---|---|
| Storage | Public R2 bucket, clients write with shared keys | Private Railway bucket, only the server writes |
| Registry | One `registry.json` rewritten by every publisher | Postgres rows; versions are immutable |
| Login | GitHub token stored by the client | Discord or GitHub login in the browser; the server issues its own revocable `bpm_` token |
| Identity | GitHub username from `auth.json` | BeePM account with linked Discord/GitHub IDs |
| Names | `author@name`, deps by BEE2 ID | `@scope/name`, scope = BeePM handle |
| Admins | Hardcoded usernames | `role = admin` in the database |

## Accounts and login

- A BeePM **user** has a `handle` (lowercase, GitHub-style, 1-39 chars), which is the
  `@scope` of their packages. It's picked at signup (prefilled from the provider
  username) and is then locked; only an admin can rename it.
- **Identities** link Discord and/or GitHub accounts to the user, keyed by the
  provider's numeric ID. One of each per user; each provider account belongs to one
  BeePM user. You can't unlink your last identity. Accounts are never merged by email or
  username.
- **Tokens** (`bpm_` + 32 chars) are stored as SHA-256 hashes. `session` tokens come
  from a browser login and have full access. `publish` tokens are created by the user
  (for CI) and can only publish and manage packages. Tokens expire after `TOKEN_DAYS`
  (365) and can be listed and revoked.
- **Publishing** requires an account that isn't banned and whose oldest linked provider
  account is at least `MIN_ACCOUNT_AGE_DAYS` (30) old. Admins are exempt. Limits:
  `PUBLISHES_PER_HOUR` (10) and `PUBLISHES_PER_DAY` (30) per user.
- `BOOTSTRAP_ADMINS` (comma-separated handles) are made admins at startup.
- Accounts created by the legacy import have a GitHub identity (looked up by the old
  author name) and no `claimed_at` until their owner first logs in with that GitHub account.

### Browser login (app or CLI)

1. Client: `POST /v1/auth/sessions {clientName}` returns
   `{id, secret, confirmCode, url, interval, expiresAt}`. The client shows the
   confirm code (e.g. `K7QD-4MXP`) and opens `url` in the browser.
2. Browser: `GET /login/:id` binds the session to that browser with a cookie and shows the
   code plus "Continue with Discord / GitHub".
3. The provider redirects to `GET /oauth/:provider/callback`. The server fetches the
   profile, then revokes the provider's token. The provider token is never stored.
   - Known identity: an "Allow <client> to use @handle?" page, then `POST /login/:id/approve`.
   - New identity: a "Pick your handle" page, then `POST /login/:id/claim {handle}`. This
     creates the user and approves in one step.
4. Client: `POST /v1/auth/sessions/:id/poll {secret}` every `interval` seconds returns
   `{status: "pending"}`, then once `{status: "done", token, user}`. After that, or once
   `expiresAt` passes, the session is unusable.

Linking works the same way, but starts from `POST /v1/me/links` (authenticated) and the
browser page is `/link/:id`. The confirm page names the BeePM account the provider account
is being linked to. Only a session token can start a link.

The confirm code and the explicit Allow/Link click protect against someone sending you
their login link. Pages send `frame-ancestors 'none'` and every form has a CSRF token.

## Packages

- Name: `@scope/name`. Name is lowercase `[a-z0-9._-]`, 1-64 chars, alphanumeric at
  both ends. `@beemod/<BEE2_ID>` refers to BEE2's built-in packages: never in the
  registry, satisfied by BEE2's own files.
- Every package has one **BEE2 ID** (`bee_id`) from the top-level `"ID"` in its root
  `info.txt`. It's uppercase `[A-Z0-9_]` and unique across the registry (removed packages
  don't count), because BEE2 can't load two packages with the same ID. Every version of a
  package must have the same ID.
- **Owners** can publish, yank, deprecate and unpublish, and can add or remove owners
  (but can't remove the last one). Creating a package in a scope requires being that
  scope's user (or an admin).
- **Versions** are strict semver and immutable. `latest` is the highest version that
  isn't yanked or unpublished, preferring non-prerelease versions.
  - **Yank** hides a version from range resolution; an exact pin still installs it.
  - **Deprecate** shows a message; it applies to a version or the whole package.
  - **Unpublish** is allowed only within `UNPUBLISH_HOURS` (72) of publishing, and only
    if no other package's current versions depend on it. The number can never be reused.
  - Admins can **remove** a whole package, which hides it from everyone but admins and keeps
    its files. Its name stays taken, but its BEE2 ID is free for another package; restoring
    it is refused while another package has the ID.

### The .bee_pack file (checked by the server on every publish)

- A zip, at most `MAX_UPLOAD_MB` (512).
- Root `info.txt` with a top-level `"ID" "<id>"` (Valve KeyValues; quoted or unquoted,
  `//` comments, a UTF-8 BOM is fine).
- Root `bee-package.json` (UTF-8, BOM allowed):

  | Field | Rule |
  |---|---|
  | `name` (required) | Package name; may be `@scope/name`, otherwise the scope is `author` or the publisher |
  | `version` (required) | Strict semver |
  | `author` | Optional legacy field: the scope to publish under |
  | `display_name`, `description` | Optional strings (≤ 100 / ≤ 2000 chars) |
  | `compatibleWith` | Optional BEE2 version range, see below; missing means any version |
  | `dependencies` | Optional `{"@scope/name": "<semver range>"}`; `@beemod/<ID>` allowed |
  | `id` | Ignored (the ID always comes from info.txt) |

- Only these file types: `.txt .vtf .vmt .mdl .vvd .vtx .phy .ani .3ds .wav .mp3 .vcd .pcf
  .vmf .vmx .cfg .json .png .jpg .jpeg .gif .bmp .tga .webp .nut`. Files with no extension
  are rejected. The client removes other files before uploading (and says which).
- No absolute paths, `..` segments, or more than 50,000 entries.
- `compatibleWith` is a semver range compared against the first three parts of the
  user's BEE2 version (`2.4.46.1` -> `2.4.46`). Old forms are converted when published:
  `>=2.4.40,<2.5` (commas become spaces), `~=2.4.40` -> `~2.4.40`, `==2.4.*` -> `2.4.*`,
  and a list of versions -> `2.4.45 || 2.4.46`.
- Old dependency keys that name a BEE2 ID (`@areng14/ARENGS_PACKAGES`) are rewritten to
  the package that has that ID in that scope.

### Publishing

1. Client checks the file locally (same rules), removes disallowed files, and computes its
   SHA-256 and size. Then `POST /v1/publish/check {manifest, beeId}` runs the registry's
   rules (ownership and scope, the BEE2 ID, the version, the dependencies) without a file,
   so a package that would be refused stops before review and upload.
2. `POST /v1/uploads {size, sha256}` returns `{id, upload: {method, url, headers}, expiresAt}`.
   This step checks the account age and rate limits.
3. Client sends the file to `upload.url` (a presigned PUT straight to the bucket; the
   signature pins the size).
4. `POST /v1/uploads/:id/finalize` makes the server re-hash and check the file, check
   ownership, the BEE2 ID, the version and the dependencies, then move the file to
   `packages/<scope>/<name>/<version>.bee_pack` and create the version.

`POST /v1/imports/github {owner, repo, tag?, asset?, watch?}` makes the server fetch a release
asset and publish it the same way. It requires a linked GitHub identity that owns the
repo, or is a public member of the org that owns it. Disallowed files are stripped. The
file is copied into the bucket, so later changes to the GitHub release don't affect it.

With `watch: true` the repo's new releases are published automatically from then on
(`watch: false` stops it). Every `GITHUB_WATCH_MINUTES` (15) the server checks the latest
release of each watched package and publishes it as the owner who turned it on, with every
normal check: their GitHub account must still own the repo, the version must be new, and the
release's bee-package.json must be for the same package. A release that can't be published is
recorded (owners see why) and isn't tried again until its .bee_pack is replaced; trouble
reaching GitHub is retried next time. Without `GITHUB_API_TOKEN` GitHub allows 60 requests an
hour, so only about a dozen repos are checked each time.

Clients look GitHub up through the registry, which has the token (GitHub allows 60 requests
an hour per network without one): `GET /v1/github/repos` lists the public repos of the
user's linked GitHub account and its public organizations, `GET
/v1/github/repos/:owner/:repo/releases` the releases with a .bee_pack, and `GET
/v1/github/repos/:owner/:repo/asset?tag=&name=` one .bee_pack `{name, size, url}` (always
fresh; the client downloads it from `url` itself). Answers are cached, and each account can
make 120 lookups every 10 minutes.

### Discord logs

With `DISCORD_LOG_WEBHOOK` set, the registry posts its activity to that Discord channel:
publishes, yanks, deprecations, unpublishes, owner changes, bans, removals, new and linked
accounts, publish tokens, failed automatic GitHub releases and server errors (each error at
most every 10 minutes). The old-registry import is one message, not one per version. With
`DISCORD_RELEASES_WEBHOOK` set, new packages and versions are also announced in that
channel. Messages follow BEE Bot's log style (its `logui.py`): a Components V2 container
with BEE Bot's colors, a `## Title`, one bold-name block per field, the actor's avatar, a
`-# ... on | <time>` footer and link buttons, falling back to a classic embed. They're sent
in the background and never ping anyone; Discord being down never affects a request.

## API (JSON; errors are `{"error": {"code", "message"}}`)

Public:

| Method and path | Result |
|---|---|
| `GET /health` | `{ok: true}` |
| `GET /v1` | `{name, version, providers: ["discord", "github"], limits}` |
| `GET /v1/packages?q=&limit=&offset=` | `{total, packages: [summary]}` (admins also get removed ones, with `removed`) |
| `GET /v1/packages/:scope/:name` | packument (below) |
| `GET /v1/packages/:scope/:name/versions/:version/download` | 302 to a presigned URL |
| `GET /v1/lookup?name=<name>` or `?beeId=<ID>` | `{packages: ["@scope/name", ...]}` |
| `GET /v1/users/:handle` | `{handle, displayName, avatarUrl, createdAt, packages: [summary]}` |

Summary: `{name, scope, displayName, description, beeId, latest, compatibleWith,
deprecated, updatedAt, downloads}`.

Packument:
```json
{
  "name": "@areng14/arengitems", "scope": "areng14", "beeId": "ARENGS_PACKAGES",
  "displayName": "Areng's Items", "description": "...", "deprecated": null,
  "owners": ["areng14"], "createdAt": "...", "updatedAt": "...", "latest": "1.0.0",
  "versions": {
    "1.0.0": {
      "version": "1.0.0", "compatibleWith": ">=2.4.41", "dependencies": {},
      "sha256": "...", "size": 123, "publishedAt": "...", "publishedBy": "areng14",
      "yanked": false, "yankReason": null, "deprecated": null, "downloads": 2,
      "source": {"type": "upload"}
    }
  }
}
```

Auth and account (`Authorization: Bearer bpm_...`):

| Method and path | Notes |
|---|---|
| `POST /v1/auth/sessions` | Start a browser login |
| `POST /v1/auth/sessions/:id/poll` | `{secret}`, returns `{status, token?, user?, identity?}` |
| `DELETE /v1/auth/token` | Log out (revokes the token used) |
| `GET /v1/me` | `{user, identities, canPublish, publishBlockedReason}` |
| `GET /v1/me/tokens`, `POST /v1/me/tokens {name, days}`, `DELETE /v1/me/tokens/:id` | Token management (session tokens only) |
| `POST /v1/me/links` | Start linking another provider (session tokens only) |
| `DELETE /v1/me/identities/:provider` | Unlink (not the last one) |

Publishing and management:

| Method and path | Notes |
|---|---|
| `POST /v1/publish/check`, `POST /v1/uploads`, `POST /v1/uploads/:id/finalize` | See Publishing |
| `POST /v1/imports/github` | See Publishing |
| `GET /v1/github/repos`, `.../:owner/:repo/releases`, `.../:owner/:repo/asset?tag=&name=` | GitHub lookups for publishing from releases (see Publishing) |
| `GET`/`DELETE /v1/packages/:scope/:name/github-watch` | Owners: automatic GitHub releases (repo, last release, error), or stop them |
| `POST` / `DELETE /v1/packages/:scope/:name/versions/:version/yank` | `{reason}` / unyank |
| `PUT /v1/packages/:scope/:name/deprecation` | `{message, version?}`; `message: null` clears |
| `DELETE /v1/packages/:scope/:name/versions/:version` | Unpublish (72-hour window) |
| `GET /v1/packages/:scope/:name/owners` | `{owners: [handle]}` |
| `PUT` / `DELETE /v1/packages/:scope/:name/owners/:handle` | Add or remove an owner |

Admin (role `admin`): `DELETE /v1/admin/packages/:scope/:name {reason}`,
`POST /v1/admin/packages/:scope/:name/restore`, `PATCH /v1/admin/users/:handle {role, banned,
banReason, handle}`, `GET /v1/admin/audit`, `POST /v1/admin/import-legacy`.

## Client behavior (core/src/client)

- BeePM installs into BEE2's own packages folder, in a folder of its own:
  `<BEE2>/packages/beepm/<scope>@<name>.bee_pack`. BEE2 looks into folders inside its
  packages folder that aren't packages themselves, so it loads them with everything else, and
  BEE2's settings are never touched. BeePM's other files live in `%APPDATA%/beepm/`:
  `config/` holds `config.json`, `installed.json` and `credentials.json` (the desktop app keeps
  its token in `credentials-app.json`, encrypted with `safeStorage`), `replaced/` keeps the
  user's own copies of packages BeePM replaced, and the desktop app's logs are in `logs/` (the
  10 most recent are kept).
- **BEE2's folder:** the user picks the folder BEE2.exe is in (its packages folder, or one in
  it, will do too; the desktop app suggests the running BEE2's folder). It's kept as
  `bee2.dir` in `config.json`. BEE2's version comes from its log: `logs/bee2.log` starts with
  `Running "bee2", version 2.4.46.1`, and it's read again whenever BEE2's status is asked for,
  since it changes when BEE2 is updated. Until BEE2 has run once the version is unknown, and
  compatibility isn't checked. Nothing installs before BeePM knows where BEE2 is (code
  `bee2_not_set`). Choosing another BEE2 brings BeePM's packages along to its `packages/beepm`.
  BEE2 processes are told apart by their program's folder, so only BeePM's BEE2 is ever closed
  or waited for; another BEE2 can stay open.
- **Install:**
  1. Resolve the spec (`@scope/name[@range]`, a bare name via `/v1/lookup`, or the old
     `author@name`) and its dependencies.
  2. Check that ranges overlap: BEE2 can load only one version of each package.
  3. Check `compatibleWith` against BEE2's version.
  4. `@beemod/*` dependencies only need a package with that BEE2 ID in BEE2's packages folder.
  5. A package the user added to BEE2 themselves with the same BEE2 ID (BEE2 refuses to load
     two) is listed in the plan, and moved to `replaced/` once BeePM's is in place.
  6. Download to a temp file, verify the SHA-256, then move it to `packages/beepm/`.
  7. Record `{version, sha256, beeId, explicit, installedAt, file}` in `installed.json`.
- **Uninstall** removes the file and any dependencies that nothing else needs.
  **Update** reinstalls to the highest version allowed by the original range.
- **Scanning BEE2's packages folder** (`scan.js`) finds packages the way BEE2 does:
  .bee_pack/.zip files and folders with an info.txt, also in folders inside it (4 deep). It
  reads each package's ID and the IDs of the items it defines (both uppercased: BEE2 ignores
  case, and accepts IDs BeePM wouldn't publish), 4 at a time, and caches them by path, size
  and modified time in `cache/packages.json`, so looking again only reads what changed.
- **The BEE2 check** (`check.js`, `duplicates.js`): what BEE2 refuses to load together, the
  same package ID twice or an item ID in two packages, and the user's own packages (outside
  `packages/beepm`) that are on BeePM (`/v1/lookup?beeId=`, 6 at a time), whose BeePM version
  gets updates. Fixing duplicates keeps the newest copy of each (by the file's time) unless the
  user picks another; for an item in two packages it's a whole package that goes.
- Earlier 1.0 builds instead pointed BEE2's `[Directories] package` at `%APPDATA%/beepm/packages`
  ("hooking") and downloaded BEE2's own packages there. `leaveHook` undoes that once BeePM knows
  where BEE2 is and BEE2 is closed (it writes its config back when it exits): the old setting
  is put back, BeePM's packages move into `packages/beepm/`, and the rest that was in the old
  folder goes into BEE2's packages folder if BEE2 doesn't have that package yet (copies of what
  it has go to `replaced/`, BEE2's own downloaded ones are deleted), so BEE2 loads the same
  packages as before. The CLI and the desktop app do it as soon as they can; the app finds
  BEE2's folder from the running BEE2.exe if it isn't chosen yet.
- Installs from the prototype (`installed_packages.json`, files `<author>_<ID>.bee_pack`) are
  adopted by matching BEE2 IDs through `/v1/lookup?beeId=` once BeePM knows where BEE2 is.
- **In the background** (the desktop app; on by default once installed): BeePM starts with
  Windows (`--background`: only the tray), stays in the tray when its window closes, and when
  BEE2 opens it runs the BEE2 check and looks for updates, asking in a small window in the
  corner: Delete duplicates (keeps the newest; to the Recycle Bin) or Choose (BeePM's window,
  per duplicate); Use BeePM's version or Keep mine (not asked again; kept in
  `config/app-settings.json`), with Choose when there are several; and for each update,
  Update, Not now, or Don't ask again. BEE2 has the package files open, so the changes ask
  first: Close BEE2 (closed like its close button does, so it saves; opened again after) or
  When I close it (done once the user closes BEE2). It's never force-closed, and if it doesn't
  close, the changes wait for it. A BEE2 launched from another folder (or before BeePM knows
  one) is asked about first: Use this BEE2 switches BeePM to it; Not now or Don't ask again
  (kept in `config/app-settings.json`) leave it alone: it isn't checked, and never closed.
