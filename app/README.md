# @beepm/app

The BeePM desktop app (Electron + React + MUI). See `../DESIGN.md` for how BeePM works.

```
backend/main.js      Electron main process (ESM): window, beepm:// links, IPC
backend/preload.cjs  window.beepm for the page (sandboxed, so CommonJS)
backend/backend.js   every IPC handler, built on @beepm/core/client (no Electron imports)
backend/handlers/    app, auth, registry, packages, bee2, publish, manage
backend/logger.js    the log file (BeePEE's logger: each change is a step, drawn as a tree)
backend/updateWatcher.js  in the background: the BEE2 check and updates when BEE2 opens
src/                 the React UI
src/devBridge.js     a fake window.beepm with sample data, used in a normal browser
```

## Development

- `npm run dev`: Vite on port 5167 plus Electron. Closing the app stops both.
- `npx vite`, then open http://localhost:5167 in a browser: the UI with the dev bridge's sample
  data (nothing is installed or published). Add `?loggedout`, `?admin`, `?nobee2` (BeePM
  doesn't know where BEE2 is), `?bee2open` or `?clean` (the BEE2 check finds nothing) to the
  URL. `?toast=update`, `close`, `duplicates&count=2` and `adopt&count=1&name=X` draw the
  corner questions (400×150).
- `npm run lint`, `npm run format` (Prettier, using the repo's config), and `npm test`.
- Running in the background is off in development unless it's turned on in Settings; then
  closing the window keeps BeePM in the tray (quit it there), and `npm run dev` keeps going.
- Logs are in `%APPDATA%/beepm/logs` (Settings > About > Open logs folder). In development
  they're also printed in the terminal, with debug lines.

Environment variables (also used by the CLI):

| Variable            | Default                    | Use                                                     |
| ------------------- | -------------------------- | ------------------------------------------------------- |
| `BEEPM_REGISTRY`    | the public registry        | Another registry, e.g. a local `npm run dev:server`     |
| `BEEPM_HOME`        | `%APPDATA%/beepm`          | Where packages and config are kept                      |
| `BEE2_CONFIG_DIR`   | `%APPDATA%/BEEMOD2/config` | BEE2's config folder                                    |
| `BEEPM_NO_PROTOCOL` | unset                      | Don't register the `beepm://` handler (tests, previews) |

To try a built copy (`release/win-unpacked/BeePM.exe`) next to the installed BeePM, also set
`BEEPM_USER_DATA` to an empty folder (Electron's own files, so it isn't the same BeePM as the
installed one, which it would otherwise hand over to) and `BEEPM_NO_LOGIN_ITEM=1` (it would
replace the installed app's "start with Windows" entry).

## Packaging

`npm run build` runs `vite build`, then electron-builder (settings in `electron-builder.js`),
and leaves the installer in `release/` (`BeePM-Setup-<version>.exe`, not code-signed). Last,
`scripts/verify-build.js` checks the packed app against its sources, file by file: a file that
changes while electron-builder packs it shifts every file after it, and the installed BeePM
doesn't start. A build that fails it has its installer deleted; build again without changing
anything meanwhile.

The installer (`build/installer.nsh`) closes BeePM to replace its files, then starts it again in
the tray when it runs in the background (it has its "start with Windows" entry). Uninstalling
removes that entry; updating keeps it. After "Restart to update", BeePM comes back the way it
was: in the tray if its window wasn't open. The page
is bundled by Vite, so the packaged app only needs the main process' dependencies:
`@beepm/core` and what it uses (`semver`, `yauzl`, `yazl`, `lzma1`, `pngjs`, `jpeg-js`), and
`electron-updater`. electron-builder copies `@beepm/core` out of the workspace into the package.
What only the page uses (React, MUI, emotion) is in `devDependencies`, so it isn't packed again:
that kept `app.asar` at a few MB instead of 45 MB in 26,000 files, which Electron indexes at
every start and Windows scans after every install.

Icons, made from BeePM.png: `build/icon.ico` is the app's, the installer's and the
uninstaller's icon, and `build/installerSidebar.bmp` is the side image of the installer and
uninstaller. electron-builder finds both by their names.

## Releasing (BeePM updates itself)

The installed app looks for new versions in the GitHub releases of BeemodTools/BeePM
(`backend/appUpdater.js` with electron-updater; `publish` in `electron-builder.js`): soon after
it starts and every 6 hours. It downloads a new version in the background, then asks in the
corner whether to restart now; otherwise it installs when BeePM quits. To release:

1. Raise `version` in `package.json` (e.g. 1.0.0 to 1.0.1): the updater only takes higher
   versions.
2. `npm run build`. Besides the installer, `release/` gets `latest.yml` (the version, the
   installer's name, size and SHA-512) and the installer's `.blockmap` (so updates only download
   what changed).
3. Make a GitHub release on BeemodTools/BeePM tagged `v<version>` (not a draft or pre-release)
   with those three files: `BeePM-Setup-<version>.exe`, its `.blockmap` and `latest.yml`. Or
   let electron-builder do it: set `GH_TOKEN` (a token that can write the repo's releases) in
   your own terminal and run `npx electron-builder --publish always` after `vite build`.

`BEEPM_NO_UPDATE=1` turns the updater off in the installed app.
