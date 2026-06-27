# Monorepo layout & rationale

This repo publishes **two npm packages from one git repo** (the split is done — see commit `6f8f672`):

- `gpx-stabilizer` (core, `packages/core`) — bin `gpx-stabilize`, **zero runtime dependencies**.
- `gpx-from-gopro` (`packages/gopro`) — bin `gpx-from-gopro`, depends on core + the GoPro libraries.

Both npm names were unclaimed at planning time (404 on the registry, 2026-06-27) → published unscoped.

## Why two packages (not one with `optionalDependencies`)

The core must stay zero-runtime-dependency so `npx gpx-stabilize` is light. `optionalDependencies`
does **not** achieve that — npm/npx install them by DEFAULT (they're "optional" only on install
*failure*), so the heavy GoPro libs would still be dragged into a core-only install. Separate packages
give each an isolated dependency tree:

- `npm i gpx-stabilizer` → no runtime deps.
- `npm i gpx-from-gopro` → the GoPro libraries (+ core as a dependency).

Where the core wants to *optionally* call gopro, use a lazy `import()` with a friendly "install it"
error — the pattern `packages/core/src/png.js` already uses for `@resvg/resvg-js`.

## Layout (npm workspaces, npm v7+)

```
gpx-stabilizer/                 # repo root: private, { "workspaces": ["packages/*"] }
├─ biome.json                   # shared lint/format, lives at root
└─ packages/
   ├─ core/    name "gpx-stabilizer"   dependencies: {}    bin gpx-stabilize
   └─ gopro/   name "gpx-from-gopro"   bin gpx-from-gopro
              dependencies: { gpx-stabilizer, gopro-telemetry, gpmf-extract, mp4box, tz-lookup }
```

Root `npm install` symlinks gopro's `gpx-stabilizer` dependency to the local `packages/core` workspace,
so the two develop together without publishing first. Publish each with `npm publish -w <name>`.
