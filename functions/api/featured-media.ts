import {
  corsHeaders,
  isOriginAllowed,
  json,
  resolveAllowedOrigins,
  resolveOrigin,
} from '../_lib/http';

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
const DEFAULT_MEDIA_ID = '154385';
const CACHE_CONTROL = 'public, max-age=3600';

const resolveMediaType = (value?: string) => (value === 'movie' ? 'movie' : 'tv');

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
      origin,
      CACHE_CONTROL
    );
  } catch (error) {
    console.error('featured-media function failed', error);
    return json({ error: 'featured_media_unavailable' }, 502, origin);
  }
};
