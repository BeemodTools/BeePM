# @beepm/app

The BeePM desktop app (Electron + React + MUI). See `../DESIGN.md` for how BeePM works.

```
backend/main.js      Electron main process (ESM): window, beepm:// links, IPC
backend/preload.cjs  window.beepm for the page (sandboxed, so CommonJS)
backend/backend.js   every IPC handler, built on @beepm/core/client (no Electron imports)
backend/handlers/    app, auth, registry, packages, bee2, publish, manage
backend/logger.js    the log file (BeePEE's logger: each change is a step, drawn as a tree)
backend/updateWatcher.js  in the background: asks about updates when BEE2 opens
src/                 the React UI
src/devBridge.js     a fake window.beepm with sample data, used in a normal browser
```

## Development

- `npm run dev`: Vite on port 5167 plus Electron. Closing the app stops both.
- `npx vite`, then open http://localhost:5167 in a browser: the UI with the dev bridge's sample
  data (nothing is installed or published). Add `?loggedout` or `?admin` to the URL.
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

## Packaging

`npm run build` runs `vite build`, then electron-builder (settings in `electron-builder.js`),
and leaves the installer in `release/` (`BeePM Setup <version>.exe`, not code-signed). The page
is bundled by Vite, so the packaged app only needs the main process' dependencies:
`@beepm/core` and what it uses (`semver`, `yauzl`, `yazl`, `lzma1`). electron-builder copies
`@beepm/core` out of the workspace into the package. React and MUI get packed too, since
they're `dependencies`; moving them to `devDependencies` would make the package smaller.

Icons, made from BeePM.png: `build/icon.ico` is the app's, the installer's and the
uninstaller's icon, and `build/installerSidebar.bmp` is the side image of the installer and
uninstaller. electron-builder finds both by their names.
