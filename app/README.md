# @beepm/app

The BeePM desktop app (Electron + React + MUI). See `../DESIGN.md` for how BeePM works.

```
backend/main.js      Electron main process (ESM): window, beepm:// links, IPC
backend/preload.cjs  window.beepm for the page (sandboxed, so CommonJS)
backend/backend.js   every IPC handler, built on @beepm/core/client (no Electron imports)
backend/handlers/    app, auth, registry, packages, bee2, publish, manage
backend/logger.js    the log file (BeePEE's logger: each change is a step, drawn as a tree)
src/                 the React UI
src/devBridge.js     a fake window.beepm with sample data, used in a normal browser
```

## Development

- `npm run dev`: Vite on port 5167 plus Electron. Closing the app stops both.
- `npx vite`, then open http://localhost:5167 in a browser: the UI with the dev bridge's sample
  data (nothing is installed or published). Add `?loggedout` or `?admin` to the URL.
- `npm run lint`, and `npm run format` (Prettier, using the repo's config).
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

`npm run build` runs `vite build`, then electron-builder. The page is bundled by Vite, so the
packaged app only needs the main process' dependencies: `@beepm/core` and what it uses
(`semver`, `yauzl`, `yazl`).

This hasn't been tried with npm workspaces yet: the dependencies are hoisted to the repo's root
`node_modules`, and `@beepm/core` is a symlink to `../core`. If the package ends up without
them, bundle `backend/` into one file (e.g. with esbuild, `@beepm/core` included) and package
that, or install the app outside the workspace with core packed by `npm pack`.

There are no app icons yet: add `build/icon.ico` and `build/icon.png` (electron-builder looks in
`build/`).
