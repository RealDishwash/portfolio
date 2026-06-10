# Vishwas Portfolio

Personal portfolio site built with Astro (zero client-side framework) and Cloudflare Pages Functions for Spotify and TMDB data.

## Highlights

- Bento-style homepage with:
  - Hero with terminal-prompt kicker, social links, and profile image
  - Engineering snapshot with core stack chips
  - Featured project and project cards
  - Latest activity tile (live latest commit from the GitHub events API, with a static fallback)
  - Current conditions panel (Sydney clock + weather)
  - Spotify now playing card
  - Featured media card (TMDB movie/TV pick)
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
- `src/styles/media-card.css`: card styles shared by the Spotify and Featured Media tiles.
- `src/layouts/Layout.astro`: global shell, metadata, typography, and color tokens.
- `functions/api/spotify-now-playing.ts`: Cloudflare Pages Function backing the Spotify tile.
- `functions/api/featured-media.ts`: Cloudflare Pages Function backing the featured media tile.
- `functions/_lib/http.ts`: shared CORS/JSON helpers for the functions.
- `public/`: static assets.

## API Endpoints

Both endpoints run on Cloudflare Pages Functions, allow `GET`/`OPTIONS` only, and default to same-origin CORS (override with the `ALLOWED_ORIGIN` secret, a comma-separated allowlist).

### Spotify

- Route: `GET /api/spotify-now-playing`
- Behavior:
  - Returns currently playing track when available.
  - Falls back to the most recently played track.
  - Returns a friendly idle payload when no recent track exists.
  - Responses are cached at the edge for 10 seconds (`caches.default`), so all visitors share one Spotify request per window; access tokens are also cached durably across isolates.
- Response shape: `isPlaying`, `trackName`, `artists`, `albumName`, `albumImageUrl`, `trackUrl`, `progressMs`, `durationMs`, `lastUpdated`

### Featured Media

- Route: `GET /api/featured-media`
- Behavior:
  - Fetches the configured movie/TV item from TMDB and returns a trimmed payload, cached for one hour.
- Response shape: `title`, `subtitle`, `overview`, `mediaType`, `imageUrl`, `tmdbUrl`, `lastUpdated`

### Required Cloudflare Pages Secrets

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REFRESH_TOKEN`
- `TMDB_API_KEY`

Optional:

- `ALLOWED_ORIGIN` (comma-separated allowlist; defaults to same-origin only)
- `FEATURED_MEDIA_TYPE` (`tv` or `movie`; defaults to `tv`)
- `FEATURED_MEDIA_ID` (TMDB id; defaults to `154385`)

No public frontend environment variables are required.
