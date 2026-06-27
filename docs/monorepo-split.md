# Monorepo split: publish two npm packages from this one repo

**Goal:** keep ONE git repo but publish TWO npm packages with isolated dependency trees, so the core
stabilizer stays **zero-runtime-dependency** while the GoPro feature carries its heavy deps.

- `gpx-stabilizer` (core) — bin `gpx-stabilize`, `dependencies: {}` (only `node:` builtins).
- `gpx-from-gopro` (GoPro→GPX) — bin `gpx-from-gopro`, depends on `gpx-stabilizer` + the GoPro libs.

**npm names verified AVAILABLE (404 on registry, 2026-06-27):** both `gpx-stabilizer` and
`gpx-from-gopro` are unpublished/unclaimed → publish unscoped, no `@scope` needed.

**Why this (not `optionalDependencies`):** npm/npx install `optionalDependencies` by DEFAULT (they're
only "optional" on install *failure*), so listing the GoPro libs as optional would still drag them into
`npx gpx-stabilize`. Separate packages + (where core wants to call gopro) a lazy `import()` is the only
thing that keeps `npx gpx-stabilize` light. The repo already uses the lazy pattern in `src/png.js`
(`@resvg/resvg-js` is a devDep, dynamically imported, with a friendly "install it" error) — mirror it.

## Mechanism — npm workspaces (npm v7+)

```
gpx-stabilizer/                     # git repo root
├─ package.json                     # PRIVATE root: { "private": true, "workspaces": ["packages/*"] }, no publish
├─ biome.json                       # shared lint/format (keep at root)
└─ packages/
   ├─ core/
   │  ├─ package.json   name "gpx-stabilizer"   dependencies: {}   bin: { "gpx-stabilize": "src/cli.js" }
   │  └─ src/ …
   └─ gopro/
      ├─ package.json   name "gpx-from-gopro"   bin: { "gpx-from-gopro": "src/gopro-cli.js" }
      │     dependencies: { "gpx-stabilizer": "^0.1.0", "gopro-telemetry", "gpmf-extract",
      │                     "mp4box", "tz-lookup", "egm96-universal" }
      └─ src/ …
```

- Root `npm install` symlinks `gpx-from-gopro`'s `gpx-stabilizer` dependency to the local `packages/core`
  workspace — gopro can `import { readGpx } from "gpx-stabilizer"` in dev without publishing first.
- Publish independently: `npm publish -w gpx-stabilizer` / `npm publish -w gpx-from-gopro`.
- Result: `npm i gpx-stabilizer` → zero deps; `npm i gpx-from-gopro` → heavy tree (+ core as a dep).

## File assignment (current flat `src/`)

**core (`packages/core/src/`)** — all import only `node:` builtins (png.js lazily imports `@resvg`):
`gpx.js · measure.js · profile.js · analyze.js · stabilize.js · view.js · html.js · png.js · modes.js ·
cli.js · index.js · mods/{index,dequantizeTime,noTime,oversample,outlier,activity,drift,despike,kink}.js`

**gopro (`packages/gopro/src/`)**:
`gopro.js · telemetry.js · gopro-cache.js · gopro-cli.js`

## Steps for the splitting session

1. Create the root private `package.json` (`workspaces`) and `packages/core` + `packages/gopro` dirs;
   move the files per the assignment above.
2. **core/package.json**: name `gpx-stabilizer`, `dependencies: {}`, bin `gpx-stabilize`, `exports`
   pointing at `src/index.js`. Move `@biomejs/biome` + `@resvg/resvg-js` to root or core `devDependencies`.
3. **gopro/package.json**: name `gpx-from-gopro`, the deps listed above (NOTE: `mp4box` is imported by
   `gopro.js` but is currently MISSING from the root `dependencies` — add it here), bin `gpx-from-gopro`.
4. **Rewrite gopro's cross-imports**: `gopro.js`/`telemetry.js`/`gopro-cache.js`/`gopro-cli.js` import core
   via relative paths today (`./gpx.js` etc.) → change to `from "gpx-stabilizer"`. Ensure core's
   `index.js` re-exports everything gopro needs (`readGpx`, `saveGpx`/`writeGpx`, `TrackPoint`, …).
5. **Split `index.js`**: core entry exports only core API; gopro gets its own entry if it exposes a library
   surface (else just the bin).
6. Fix `test/` + `biome` so `node --test` and `biome check` run per workspace (root `npm test` can use
   `--workspaces`). The TODO note "run biome from repo root" still applies — keep `biome.json` at root.
7. Verify: `npm install` at root links the workspaces; `node packages/core/src/cli.js x.gpx` and
   `node packages/gopro/src/gopro-cli.js …` both run; `npm pack -w gpx-stabilizer` produces a tarball with
   NO runtime deps.

## Coordination

Steps 1/3/4/5 move and edit the **GoPro files** (`gopro.js`, `telemetry.js`, `gopro-cli.js`,
`gopro-cache.js`) and the root `package.json`/`package-lock.json`, which the GoPro session has
uncommitted work on. **Do this split AFTER the GoPro feature is committed / from a clean tree**, or
coordinate so the moves don't collide. Core's own code (everything in the file list above) is already
committed and on `origin/main`.
