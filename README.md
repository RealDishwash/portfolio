# Vishwas Portfolio

Personal portfolio site built with Astro (zero client-side framework) and Cloudflare Pages Functions for Last.fm and Floppy data.

## Highlights

- Bento-style homepage with:
  - Hero with terminal-prompt kicker, social links, and profile image
  - Engineering snapshot with core stack chips
  - Featured project and project cards
  - Latest activity tile (live latest commit from the GitHub events API, with a static fallback)
  - Current conditions panel (Sydney clock + weather)
  - Qobuz listening card backed by Last.fm scrobbles
  - Recently watched movie/TV card
  - Animated terminal-style command tile
- Live Sydney conditions powered by Open-Meteo:
  - Temperature and weather icon
  - Feels-like temperature, humidity, and wind speed
  - "Updated just now / Xm ago" freshness indicator
- Motion and interaction:
  - Staggered tile intro animation
  - Tile hover lift with layered shadows
  - Typewriter terminal command loop
  - `prefers-reduced-motion` safeguards
- Self-hosted fonts (Fontsource) — no render-blocking Google Fonts requests

## Commands

- `bun install`: install dependencies.
- `bun run dev`: start local development server.
- `bun run build`: build production assets into `dist/`.
- `bun run preview`: preview the production build.
- `bun run check`: run Astro diagnostics and type checks.
- `bun run check:functions`: type-check the Cloudflare Pages Functions.
- `bunx wrangler pages dev dist`: serve the production build with the API functions running locally.

CI (`.github/workflows/ci.yml`) runs both checks and the build on every push and pull request.

## Project Structure

- `src/pages/index.astro`: homepage grid, page-level styles, and tile intro animation.
- `src/components/*Tile.astro`: self-contained tiles — markup, scoped styles, and (for live widgets) a plain `<script>` that fetches data and updates the DOM.
- `src/styles/media-card.css`: card styles shared by the listening and recently watched tiles.
- `src/layouts/Layout.astro`: global shell, metadata, typography, and color tokens.
- `functions/api/lastfm-recent.ts`: Cloudflare Pages Function backing the listening tile.
- `functions/api/floppy-recent.ts`: Cloudflare Pages Function backing the recently watched tile.
- `functions/_lib/http.ts`: shared CORS/JSON helpers for the functions.
- `public/`: static assets.

## API Endpoints

The endpoints run on Cloudflare Pages Functions, allow `GET`/`OPTIONS` only, and default to same-origin CORS (override with the `ALLOWED_ORIGIN` secret, a comma-separated allowlist).

### Listening via Last.fm

- Route: `GET /api/lastfm-recent`
- Behavior:
  - Reads the current or most recently scrobbled track from Last.fm.
  - Uses Last.fm's `nowplaying` marker when the Qobuz scrobbler publishes live status.
  - Falls back to the latest completed scrobble.
  - Responses are cached at the edge for 15 seconds.
- Response shape: `isPlaying`, `trackName`, `artists`, `albumName`, `albumImageUrl`, `trackUrl`, `playedAt`, `lastUpdated`

### Recently Watched via Floppy

- Route: `GET /api/floppy-recent`
- Behavior:
  - Reads the latest movie or episode from Floppy's authenticated history API.
  - Returns Floppy's poster and score when available.
  - Responses are cached at the edge for 60 seconds.
  - Floppy does not currently expose its webhook-driven active-playback card through the token-authenticated API, so this tile shows completed history rather than live playback.
- Response shape: `title`, `subtitle`, `imageUrl`, `linkUrl`, `stateLabel`, `rating`, `watchedAt`, `mediaType`, `lastUpdated`

### Required Cloudflare Pages Secrets

- `LASTFM_API_KEY`
- `LASTFM_USERNAME`
- `FLOPPY_URL`
- `FLOPPY_API_TOKEN`

Optional:

- `ALLOWED_ORIGIN` (comma-separated allowlist; defaults to same-origin only)

No public frontend environment variables are required.
