import {
  corsHeaders,
  isOriginAllowed,
  json,
  resolveAllowedOrigins,
  resolveOrigin,
} from '../_lib/http';

interface Env {
  TRAKT_CLIENT_ID?: string;
  TRAKT_USERNAME?: string;
  TMDB_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

type FunctionContext = {
  request: Request;
  env: Env;
};

type TraktIds = {
  trakt?: number;
  slug?: string;
  tmdb?: number;
};

type TraktMovie = {
  title?: string;
  year?: number;
  overview?: string;
  ids?: TraktIds;
};

type TraktShow = {
  title?: string;
  year?: number;
  overview?: string;
  ids?: TraktIds;
};

type TraktEpisode = {
  season?: number;
  number?: number;
  title?: string;
  overview?: string;
  ids?: TraktIds;
};

type TraktHistoryItem = {
  watched_at?: string;
  // Present instead of `watched_at` on the /watching endpoint.
  started_at?: string;
  expires_at?: string;
  type?: 'movie' | 'episode';
  movie?: TraktMovie;
  show?: TraktShow;
  episode?: TraktEpisode;
};

// Cloudflare's edge replaces 5xx bodies from Pages Functions with a generic
// error page, which hides the real cause. Return failures as HTTP 200 with an
// `ok: false` body so they stay debuggable; the tile treats a missing title as
// an error, so its behaviour is unchanged.
const jsonError = (body: Record<string, unknown>, origin: string) =>
  json({ ok: false, ...body }, 200, origin);

// Workers' fetch sends no User-Agent by default, which trips the Cloudflare
// bot protection in front of the Trakt API (it returns a 403 challenge page).
const USER_AGENT = 'vishy-portfolio/1.0 (+https://vishy.org)';
const TRAKT_API_URL = 'https://api.trakt.tv';
const TMDB_API_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w342';
// Recent history shifts slowly; share one upstream call per visitor wave.
const CACHE_CONTROL = 'public, max-age=600, s-maxage=600';
// A live "currently watching" state changes in real time, so cache it briefly
// to avoid the tile showing a session that has already ended.
const LIVE_CACHE_CONTROL = 'public, max-age=30, s-maxage=30';

const relativeWatched = (watchedAt?: string) => {
  if (!watchedAt) return 'Watched';
  const watchedMs = Date.parse(watchedAt);
  if (Number.isNaN(watchedMs)) return 'Watched';

  const diffSeconds = Math.max(0, Math.round((Date.now() - watchedMs) / 1000));
  if (diffSeconds < 60) return 'Just now';

  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  const diffWeeks = Math.round(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;

  const diffMonths = Math.round(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;

  return `${Math.round(diffDays / 365)}y ago`;
};

const fetchTmdbPoster = async (
  apiKey: string | undefined,
  kind: 'movie' | 'tv',
  tmdbId?: number
) => {
  if (!apiKey || !tmdbId) return '';
  try {
    const response = await fetch(
      `${TMDB_API_URL}/${kind}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
    );
    if (!response.ok) return '';
    const data = (await response.json()) as { poster_path?: string };
    return data.poster_path ? `${TMDB_IMAGE_BASE_URL}${data.poster_path}` : '';
  } catch {
    return '';
  }
};

type TmdbSeason = { season_number?: number; episode_count?: number };

type TmdbShowInfo = {
  posterUrl: string;
  totalEpisodes: number | null;
  seasons: TmdbSeason[];
};

// Pulls the poster plus the season/episode breakdown in one call so the tile can
// show how far into the whole series the current episode sits.
const fetchTmdbShow = async (
  apiKey: string | undefined,
  tmdbId?: number
): Promise<TmdbShowInfo> => {
  const empty: TmdbShowInfo = { posterUrl: '', totalEpisodes: null, seasons: [] };
  if (!apiKey || !tmdbId) return empty;
  try {
    const response = await fetch(
      `${TMDB_API_URL}/tv/${tmdbId}?api_key=${encodeURIComponent(apiKey)}`,
      { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } }
    );
    if (!response.ok) return empty;
    const data = (await response.json()) as {
      poster_path?: string;
      number_of_episodes?: number;
      seasons?: TmdbSeason[];
    };
    return {
      posterUrl: data.poster_path ? `${TMDB_IMAGE_BASE_URL}${data.poster_path}` : '',
      totalEpisodes:
        typeof data.number_of_episodes === 'number' ? data.number_of_episodes : null,
      seasons: Array.isArray(data.seasons) ? data.seasons : [],
    };
  } catch {
    return empty;
  }
};

const traktHeaders = (clientId: string) => ({
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': USER_AGENT,
  'trakt-api-version': '2',
  'trakt-api-key': clientId,
});

type TraktRatingItem = {
  rating?: number;
  movie?: { ids?: TraktIds };
  show?: { ids?: TraktIds };
};

// Trakt ratings are 1–10; the tile renders them out of 5 stars. Returns the raw
// 1–10 value, or null when the item isn't rated / the list can't be read.
const fetchUserRating = async (
  env: Env,
  type: 'movies' | 'shows',
  traktId?: number
): Promise<number | null> => {
  if (!traktId || !env.TRAKT_CLIENT_ID || !env.TRAKT_USERNAME) return null;
  try {
    const response = await fetch(
      `${TRAKT_API_URL}/users/${encodeURIComponent(env.TRAKT_USERNAME)}/ratings/${type}`,
      { headers: traktHeaders(env.TRAKT_CLIENT_ID) }
    );
    if (!response.ok) return null;
    const ratings = (await response.json()) as TraktRatingItem[];
    if (!Array.isArray(ratings)) return null;
    const match = ratings.find((entry) => {
      const ids = type === 'movies' ? entry.movie?.ids : entry.show?.ids;
      return ids?.trakt === traktId;
    });
    return typeof match?.rating === 'number' ? match.rating : null;
  } catch {
    return null;
  }
};

// While a scrobble is in progress, started_at/expires_at bracket the full
// runtime, so the elapsed fraction gives a Spotify-style progress bar.
const watchProgress = (item: TraktHistoryItem) => {
  const startMs = Date.parse(item.started_at ?? '');
  const endMs = Date.parse(item.expires_at ?? '');
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
    return { progressMs: null, durationMs: null };
  }
  const durationMs = endMs - startMs;
  const progressMs = Math.max(0, Math.min(durationMs, Date.now() - startMs));
  return { progressMs, durationMs };
};

const buildPayload = async (item: TraktHistoryItem, env: Env, live = false) => {
  const stateLabel = live ? 'Watching' : relativeWatched(item.watched_at);
  const { progressMs, durationMs } = live
    ? watchProgress(item)
    : { progressMs: null, durationMs: null };

  if (item.type === 'movie' && item.movie) {
    const { movie } = item;
    const year = movie.year ? String(movie.year) : '';
    const slug = movie.ids?.slug;
    const [imageUrl, rating] = await Promise.all([
      fetchTmdbPoster(env.TMDB_API_KEY, 'movie', movie.ids?.tmdb),
      fetchUserRating(env, 'movies', movie.ids?.trakt),
    ]);
    return {
      title: movie.title || 'Unknown title',
      subtitle: ['Movie', year].filter(Boolean).join(' • '),
      overview: movie.overview || '',
      imageUrl,
      rating,
      linkUrl: slug ? `https://trakt.tv/movies/${slug}` : 'https://trakt.tv',
      stateLabel,
      isWatching: live,
      progressMs,
      durationMs,
      watchedAt: item.watched_at || '',
      mediaType: 'movie' as const,
      lastUpdated: new Date().toISOString(),
    };
  }

  if (item.type === 'episode' && item.show && item.episode) {
    const { show, episode } = item;
    const season = episode.season ?? 0;
    const number = episode.number ?? 0;
    const pad = (value: number) => String(value).padStart(2, '0');
    const code = `S${pad(season)}E${pad(number)}`;
    const showSlug = show.ids?.slug;
    const [tv, rating] = await Promise.all([
      fetchTmdbShow(env.TMDB_API_KEY, show.ids?.tmdb),
      fetchUserRating(env, 'shows', show.ids?.trakt),
    ]);

    // Real seasons only (TMDB lists specials as season 0).
    const realSeasons = tv.seasons.filter((s) => (s.season_number ?? 0) >= 1);
    const seasonTotal = realSeasons.length || null;
    // Cumulative position of this episode across the whole run, e.g. S2E5 -> 15.
    let episodeNumber: number | null = null;
    if (tv.totalEpisodes && season > 0 && number > 0) {
      const before = realSeasons
        .filter((s) => (s.season_number ?? 0) < season)
        .reduce((sum, s) => sum + (s.episode_count ?? 0), 0);
      episodeNumber = Math.min(before + number, tv.totalEpisodes);
    }

    return {
      title: show.title || 'Unknown show',
      subtitle: [code, episode.title].filter(Boolean).join(' · '),
      overview: episode.overview || show.overview || '',
      imageUrl: tv.posterUrl,
      rating,
      linkUrl: showSlug
        ? `https://trakt.tv/shows/${showSlug}/seasons/${season}/episodes/${number}`
        : 'https://trakt.tv',
      stateLabel,
      isWatching: live,
      progressMs,
      durationMs,
      seasonNumber: season > 0 ? season : null,
      seasonTotal,
      episodeNumber,
      episodeTotal: tv.totalEpisodes,
      watchedAt: item.watched_at || '',
      mediaType: 'episode' as const,
      lastUpdated: new Date().toISOString(),
    };
  }

  return null;
};

// Trakt exposes the in-progress scrobble at /watching, returning 204 when the
// user isn't watching anything. Any failure falls back to recent history.
const fetchWatching = async (env: Env) => {
  if (!env.TRAKT_CLIENT_ID || !env.TRAKT_USERNAME) return null;
  try {
    const response = await fetch(
      `${TRAKT_API_URL}/users/${encodeURIComponent(env.TRAKT_USERNAME)}/watching?extended=full`,
      { headers: traktHeaders(env.TRAKT_CLIENT_ID) }
    );
    if (response.status === 204 || !response.ok) return null;
    const item = (await response.json()) as TraktHistoryItem;
    if (!item || !item.type) return null;
    return await buildPayload(item, env, true);
  } catch {
    return null;
  }
};

export const onRequest = async (context: FunctionContext) => {
  const { request, env } = context;
  let origin = '*';

  try {
    const allowedOrigins = resolveAllowedOrigins(request, env.ALLOWED_ORIGIN);
    origin = resolveOrigin(request, allowedOrigins);

    if (!isOriginAllowed(request, allowedOrigins)) {
      return json({ error: 'origin_not_allowed' }, 403, origin);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405, origin);
    }

    if (!env.TRAKT_CLIENT_ID || !env.TRAKT_USERNAME) {
      return jsonError(
        {
          error: 'trakt_not_configured',
          hasClientId: Boolean(env.TRAKT_CLIENT_ID),
          hasUsername: Boolean(env.TRAKT_USERNAME),
        },
        origin
      );
    }

    // Prefer the live "currently watching" state; fall back to recent history.
    const watching = await fetchWatching(env);
    if (watching) {
      return json({ ok: true, ...watching }, 200, origin, LIVE_CACHE_CONTROL);
    }

    const response = await fetch(
      `${TRAKT_API_URL}/users/${encodeURIComponent(env.TRAKT_USERNAME)}/history?limit=1&extended=full`,
      { headers: traktHeaders(env.TRAKT_CLIENT_ID) }
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return jsonError(
        { error: 'trakt_request_failed', status: response.status, detail: detail.slice(0, 200) },
        origin
      );
    }

    const history = (await response.json()) as TraktHistoryItem[];
    const item = Array.isArray(history) ? history[0] : undefined;
    const payload = item ? await buildPayload(item, env) : null;

    if (!payload) {
      return jsonError({ error: 'no_recent_history' }, origin);
    }

    return json({ ok: true, ...payload }, 200, origin, CACHE_CONTROL);
  } catch (error) {
    console.error('trakt-recent function failed', error);
    return jsonError(
      { error: 'trakt_unavailable', detail: error instanceof Error ? error.message : String(error) },
      origin
    );
  }
};
