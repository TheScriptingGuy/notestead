# Notestead overlay assets

Files that `overlay.json` installs into the built upstream web bundle (ADR-0010). They are this project's own work,
part of this repository and licensed like it (AGPL-3.0-or-later). Nothing here is derived from upstream Joplin files.

| File | Installed as | Notes |
|---|---|---|
| `environment.js` | `environment.js` | React Native dev mode off on every origin; keeps the two globals the bundle expects. |
| `icons/*` | `icons/*` (the whole directory is replaced) | **PLACEHOLDER icon set**, see below. File names match the ones the upstream pages link. |
| `notestead-overlay.css` | `notestead-overlay.css` | Style of the "Source" link (AGPL-3.0 §13 offer). |

`source.html` is generated at overlay time (`src/sourceOffer.ts`).

## Placeholder icons
The icon set is a **placeholder** until a final Notestead icon is designed (follow-up before the first public
release, M5). It was authored for this project as `icons/icon-vector-large.svg` (a simple house with note lines).
The PNG sizes 64, 192, 256 and 512 were rasterized from that SVG with headless Chromium (Playwright 1.59.1,
chromium_headless_shell-1223) on 2026-10-04: each size renders the SVG in an `<img>` at that size on a transparent
page and takes a clipped screenshot (`omitBackground: true`). To regenerate after editing the SVG, render it the
same way at each size and replace the PNGs; no upstream file is involved.
