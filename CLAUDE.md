# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Uses Bun as the package manager/runner.

- `bun install` — install dependencies
- `bun run dev` — local dev server with hot reload
- `bun run build` — production build into `dist/`
- `bun run preview` — serve the production build
- `bun run check` — Astro diagnostics and type checks (src)
- `bun run check:functions` — `tsc` over the Cloudflare Pages Functions
- `bunx wrangler pages dev dist` — serve the built site with the API functions running locally

There is no test framework, formatter, or linter. Both check commands plus `bun run build` are the required validation (CI runs exactly these); verify pages manually in `dev`/`preview`.

Note: `functions/` is not part of the Astro build — the API routes do not run under `bun run dev` or `preview`. Use `wrangler pages dev dist` to exercise them locally; they are deployed by Cloudflare Pages.

## Architecture

Astro 5 single-page portfolio site (one route: `src/pages/index.astro`) deployed to Cloudflare Pages. No client-side framework: live widgets are plain TypeScript `<script>` tags inside their tile components.

### Tiles

The homepage is a bento grid of self-contained `src/components/*Tile.astro` components. Each tile holds its own markup, scoped `<style>`, and — for live widgets (CurrentConditions, Listening, RecentlyWatched, Terminal) — a `<script>` that polls a data source and mutates the tile's DOM by element ID. `index.astro` holds only the grid layout, page-level/shared styles (`.tile` base, `.cards` grid areas, typography), and the staggered intro animation.

The Listening and Recently Watched tiles share one card layout via `src/styles/media-card.css` (a plain global stylesheet imported by both — kept out of scoped styles because the two tiles use identical class names).

Gotchas:
- Runtime-injected markup (e.g. the weather icon SVG) doesn't receive Astro's scope class — style it with `:global()`.
- All animation logic must respect `prefers-reduced-motion` (every script and the relevant CSS check it).

### API functions (`functions/`)

File-based routes served by Cloudflare Pages Functions at `/api/<name>`: `lastfm-recent` (current/recent Last.fm scrobble) and `floppy-recent` (latest movie/episode from Floppy history). Shared CORS/origin-allowlist and JSON helpers live in `functions/_lib/http.ts` (underscore-prefixed paths are not routed) — new endpoints should use them and keep the same posture: same-origin only by default, optional comma-separated `ALLOWED_ORIGIN` override, `no-store` on error responses.

The Last.fm and Floppy functions use `caches.default` (Cloudflare Cache API) to share their payloads across visitors for 15 and 60 seconds respectively. `wrangler pages dev` supports this locally.

`functions/` has its own `tsconfig.json` (Cloudflare worker types, no DOM lib) and is excluded from the root tsconfig.

Secrets (`LASTFM_API_KEY`, `LASTFM_USERNAME`, `FLOPPY_URL`, `FLOPPY_API_TOKEN`, optional `ALLOWED_ORIGIN`) live in Cloudflare Pages project settings, not in a local `.env`. No public frontend environment variables exist.

### Layout

`src/layouts/Layout.astro` is the global shell: metadata, typography, and the CSS custom-property color tokens used by all tiles.

## Conventions

- Create a new branch per change (e.g. `feat/homelab-uptime-tile`); use Conventional Commits (`feat:`, `fix:`).
- Components/layouts are PascalCase; route files lowercase.
- `src/` files use tabs; `functions/` uses 2 spaces.
- Keep CSS scoped inside components; extract only when reuse is clear.
- TypeScript is `strict` (extends `astro/tsconfigs/strict`).
