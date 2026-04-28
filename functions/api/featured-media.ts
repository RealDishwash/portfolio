interface Env {
  TMDB_API_KEY?: string;
  FEATURED_MEDIA_TYPE?: string;
  FEATURED_MEDIA_ID?: string;
  ALLOWED_ORIGIN?: string;
}

type FunctionContext = {
  request: Request;
  env: Env;
};

type TmdbMedia = {
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  poster_path?: string;
  backdrop_path?: string;
  vote_average?: number;
};

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w342';
const DEFAULT_MEDIA_TYPE = 'tv';
const DEFAULT_MEDIA_ID = '154385';

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
      'Cache-Control': 'public, max-age=3600',
      ...corsHeaders(origin),
    },
  });

const resolveMediaType = (value?: string) => (value === 'tv' ? 'tv' : DEFAULT_MEDIA_TYPE);

const resolveYear = (media: TmdbMedia) => {
  const date = media.release_date || media.first_air_date || '';
  return date.slice(0, 4);
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

    if (!env.TMDB_API_KEY) {
      return json({ error: 'tmdb_not_configured' }, 500, origin);
    }

    const mediaType = resolveMediaType(env.FEATURED_MEDIA_TYPE);
    const mediaId = env.FEATURED_MEDIA_ID || DEFAULT_MEDIA_ID;
    const response = await fetch(
      `${TMDB_API_URL}/${mediaType}/${encodeURIComponent(mediaId)}?api_key=${encodeURIComponent(env.TMDB_API_KEY)}`,
      { headers: { Accept: 'application/json' } }
    );

    if (!response.ok) {
      return json({ error: 'tmdb_request_failed', status: response.status }, 502, origin);
    }

    const media = (await response.json()) as TmdbMedia;
    const title = media.title || media.name || 'Unknown title';
    const year = resolveYear(media);
    const rating = typeof media.vote_average === 'number' ? media.vote_average.toFixed(1) : '';
    const details = [mediaType === 'tv' ? 'TV show' : 'Movie', year, rating && `${rating}/10`].filter(Boolean);

    return json(
      {
        title,
        subtitle: details.join(' • '),
        overview: media.overview || '',
        mediaType,
        imageUrl: media.poster_path ? `${TMDB_IMAGE_BASE_URL}${media.poster_path}` : '',
        tmdbUrl: `https://www.themoviedb.org/${mediaType}/${encodeURIComponent(mediaId)}`,
        lastUpdated: new Date().toISOString(),
      },
      200,
      origin
    );
  } catch (error) {
    console.error('featured-media function failed', error);
    return json({ error: 'featured_media_unavailable' }, 502, origin);
  }
};
