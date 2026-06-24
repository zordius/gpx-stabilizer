# gpx-stabilizer — Spec

## Target

**Base feature = remove noise lines from a GPX file. Nothing else.**
Everything beyond that is an **optional module** enabled on top of the base.

```
in.gpx ──▶ [ base: remove noise lines ] ──▶ out.gpx     (default; self-contained)
                   └─▶ optional modules (opt-in) ──▶ richer output
```

## Principles

- **Base is self-contained** — pure geometry on the raw points; no labeling, no OSM, no external data. GPX in → cleaner GPX out.
- **Modules are independent & opt-in** — each is a separate toggleable unit. The base never depends on a module.
- **Composable** — modules run as an ordered pipeline over a working copy of the points.

## Optional modules (opt-in)

- segment classification
- lift handling
- track smoothing
- segment bridging
- cluster cleanup
- OSM validation
- eval rendering — outputs SVG + HTML to evaluate results in a browser

## Reference

Original Python prototype: `old_ski_v1` branch (monolith). This rewrite re-derives a minimal base + optional modules.
