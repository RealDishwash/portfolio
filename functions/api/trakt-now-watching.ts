interface Env {
  TRAKT_CLIENT_ID: string;
  TRAKT_USERNAME: string;
  TRAKT_ACCESS_TOKEN?: string;
  TMDB_API_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

type TraktIds = {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
};

type TraktMovie = {
  title?: string;
  year?: number;
  ids?: TraktIds;
};

type TraktShow = {
  title?: string;
  year?: number;
  ids?: TraktIds;
};

type TraktEpisode = {
  title?: string;
  season?: number;
  number?: number;
  ids?: TraktIds;
};

type TraktMedia = {
  type?: 'movie' | 'episode';
  movie?: TraktMovie;
  show?: TraktShow;
  episode?: TraktEpisode;
};

type TraktHistoryItem = TraktMedia & {
  watched_at?: string;
};

type TraktPayload = {
  isWatching: boolean;
  title: string;
  subtitle: string;
  mediaType: 'movie' | 'episode';
  imageUrl: string;
  traktUrl: string;
  lastUpdated: string;
};

type FunctionContext = {
  request: Request;
  env: Env;
};

const TRAKT_API_URL = 'https://api.trakt.tv';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w342';

const parseAllowedOrigins = (value?: string) =>
  (value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const resolveAllowedOrigins = (request: Request, allowedOrigin?: string) => {
  const allowedOrigins = parseAllowedOrigins(allowedOrigin);
  if (allowedOrigins.length > 0) return allowedOrigins;
  return [new URL(request.url).origin];
};

const resolveOrigin = (request: Request, allowedOrigins: string[]) => {
  const requestOrigin = request.headers.get('Origin');

  if (allowedOrigins.includes('*')) return '*';
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return allowedOrigins[0];
};

const isOriginAllowed = (request: Request, allowedOrigins: string[]) => {
  if (allowedOrigins.includes('*')) return true;
  const requestOrigin = request.headers.get('Origin');
  if (!requestOrigin) {
    return allowedOrigins.includes(new URL(request.url).origin);
  }
  return allowedOrigins.includes(requestOrigin);
};

const corsHeaders = (origin: string) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
});

const json = (body: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      ...corsHeaders(origin),
    },
  });

const traktHeaders = (env: Env) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': env.TRAKT_CLIENT_ID,
  };

  if (env.TRAKT_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${env.TRAKT_ACCESS_TOKEN}`;
  }

  return headers;
};

const fetchTrakt = async <T>(path: string, env: Env) => {
  const response = await fetch(`${TRAKT_API_URL}${path}`, {
    headers: traktHeaders(env),
  });

  if (response.status === 204 || response.status === 404) return null;
  if (!response.ok) throw new Error(`trakt request failed: ${response.status}`);
  return (await response.json()) as T;
};

const formatEpisodeCode = (episode?: TraktEpisode) => {
  if (episode?.season == null || episode?.number == null) return '';
  return `S${String(episode.season).padStart(2, '0')}E${String(episode.number).padStart(2, '0')}`;
};

const buildTraktUrl = (media: TraktMedia) => {
  if (media.type === 'movie') {
    const movie = media.movie;
    const id = movie?.ids?.slug || movie?.ids?.trakt || movie?.title;
    return id ? `https://trakt.tv/movies/${encodeURIComponent(String(id))}` : 'https://trakt.tv';
  }

  const show = media.show;
  const episode = media.episode;
  const showId = show?.ids?.slug || show?.ids?.trakt || show?.title;
  if (!showId) return 'https://trakt.tv';
  if (episode?.season == null || episode?.number == null) {
    return `https://trakt.tv/shows/${encodeURIComponent(String(showId))}`;
  }
  return `https://trakt.tv/shows/${encodeURIComponent(String(showId))}/seasons/${episode.season}/episodes/${episode.number}`;
};

const fetchTmdbPoster = async (media: TraktMedia, env: Env) => {
  if (!env.TMDB_API_KEY) return '';

  const tmdbId = media.type === 'movie' ? media.movie?.ids?.tmdb : media.show?.ids?.tmdb;
  if (!tmdbId) return '';

  const mediaType = media.type === 'movie' ? 'movie' : 'tv';
  const response = await fetch(
    `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`,
    { headers: { Accept: 'application/json' } }
  );

  if (!response.ok) return '';
  const data = (await response.json()) as { poster_path?: string };
  return data.poster_path ? `${TMDB_IMAGE_BASE_URL}${data.poster_path}` : '';
};

const toPayload = async (media: TraktMedia, isWatching: boolean, env: Env): Promise<TraktPayload | null> => {
  if (media.type === 'movie' && media.movie) {
    const year = media.movie.year ? ` (${media.movie.year})` : '';
    return {
      isWatching,
      title: media.movie.title || 'Unknown movie',
      subtitle: `${isWatching ? 'Watching' : 'Last watched'} movie${year}`,
      mediaType: 'movie',
      imageUrl: await fetchTmdbPoster(media, env),
      traktUrl: buildTraktUrl(media),
      lastUpdated: new Date().toISOString(),
    };
  }

  if (media.type === 'episode' && media.show) {
    const episodeCode = formatEpisodeCode(media.episode);
    const episodeTitle = media.episode?.title ? ` • ${media.episode.title}` : '';
    return {
      isWatching,
      title: media.show.title || 'Unknown show',
      subtitle: `${isWatching ? 'Watching' : 'Last watched'} ${episodeCode}${episodeTitle}`.trim(),
      mediaType: 'episode',
      imageUrl: await fetchTmdbPoster(media, env),
      traktUrl: buildTraktUrl(media),
      lastUpdated: new Date().toISOString(),
    };
  }

  return null;
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
      return json({ error: 'trakt_not_configured' }, 500, origin);
    }

    const username = encodeURIComponent(env.TRAKT_USERNAME);
    let watching: TraktMedia | null = null;
    try {
      watching = await fetchTrakt<TraktMedia>(`/users/${username}/watching`, env);
    } catch {
      watching = null;
    }

    if (watching) {
      const payload = await toPayload(watching, true, env);
      if (payload) return json(payload, 200, origin);
    }

    const history = await fetchTrakt<TraktHistoryItem[]>(`/users/${username}/history?limit=1`, env);
    const lastWatched = history?.[0];
    if (lastWatched) {
      const payload = await toPayload(lastWatched, false, env);
      if (payload) return json(payload, 200, origin);
    }

    return json(
      {
        isWatching: false,
        title: 'Nothing watched yet',
        subtitle: 'Start watching something to update this tile.',
        mediaType: 'movie',
        imageUrl: '',
        traktUrl: `https://trakt.tv/users/${username}`,
        lastUpdated: new Date().toISOString(),
      },
      200,
      origin
    );
  } catch (error) {
    console.error('trakt-now-watching function failed', error);
    return json({ error: 'trakt_unavailable' }, 502, origin);
  }
};
