import {
  corsHeaders,
  isOriginAllowed,
  json,
  resolveAllowedOrigins,
  resolveOrigin,
} from '../_lib/http';

interface Env {
  LASTFM_API_KEY?: string;
  LASTFM_USERNAME?: string;
  ALLOWED_ORIGIN?: string;
}

type FunctionContext = {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
};

type LastFmTrack = {
  name?: string;
  artist?: { '#text'?: string };
  album?: { '#text'?: string };
  image?: Array<{ '#text'?: string; size?: string }>;
  url?: string;
  date?: { uts?: string };
  '@attr'?: { nowplaying?: string };
};

type LastFmResponse = {
  recenttracks?: {
    track?: LastFmTrack[] | LastFmTrack;
  };
  error?: number;
  message?: string;
};

type ListeningPayload = {
  isPlaying: boolean;
  trackName: string;
  artists: string;
  albumName: string;
  albumImageUrl: string;
  trackUrl: string;
  playedAt: string | null;
  lastUpdated: string;
};

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const CACHE_CONTROL = 'public, max-age=15, s-maxage=15';
const PAYLOAD_CACHE_KEY = 'https://portfolio-internal/lastfm/recent-track';


const selectImage = (images?: LastFmTrack['image']) => {
  if (!images?.length) return '';
  const preferredSizes = ['extralarge', 'large', 'medium', 'small'];
  for (const size of preferredSizes) {
    const url = images.find((image) => image.size === size)?.['#text'];
    if (url) return url;
  }
  return images.find((image) => image['#text'])?.['#text'] || '';
};

const toPayload = (track: LastFmTrack, username: string): ListeningPayload => {
  const playedAtSeconds = Number(track.date?.uts);
  return {
    isPlaying: track['@attr']?.nowplaying === 'true',
    trackName: track.name || 'Unknown track',
    artists: track.artist?.['#text'] || 'Unknown artist',
    albumName: track.album?.['#text'] || '',
    albumImageUrl: selectImage(track.image),
    trackUrl:
      track.url || `https://www.last.fm/user/${encodeURIComponent(username)}`,
    playedAt:
      Number.isFinite(playedAtSeconds) && playedAtSeconds > 0
        ? new Date(playedAtSeconds * 1000).toISOString()
        : null,
    lastUpdated: new Date().toISOString(),
  };
};

const withCors = (cached: Response, origin: string) => {
  const headers = new Headers(cached.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(cached.body, { status: cached.status, headers });
};

const respondAndCache = (
  payload: ListeningPayload,
  origin: string,
  waitUntil: FunctionContext['waitUntil']
) => {
  const body = JSON.stringify(payload);
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': CACHE_CONTROL,
  };
  waitUntil(caches.default.put(PAYLOAD_CACHE_KEY, new Response(body, { headers: baseHeaders })));
  return new Response(body, {
    status: 200,
    headers: { ...baseHeaders, ...corsHeaders(origin) },
  });
};

const fetchRecentTrack = async (env: Env) => {
  const params = new URLSearchParams({
    method: 'user.getRecentTracks',
    user: env.LASTFM_USERNAME!,
    api_key: env.LASTFM_API_KEY!,
    limit: '1',
    format: 'json',
  });
  const response = await fetch(`${LASTFM_API_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'vishy-portfolio/1.0 (+https://vishy.org)',
    },
  });
  if (!response.ok) throw new Error('last.fm request failed');

  const data = (await response.json()) as LastFmResponse;
  if (data.error) throw new Error(data.message || 'last.fm returned an error');

  const tracks = data.recenttracks?.track;
  return Array.isArray(tracks) ? tracks[0] : tracks;
};

export const onRequest = async (context: FunctionContext) => {
  const { request, env, waitUntil } = context;
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

    if (!env.LASTFM_API_KEY || !env.LASTFM_USERNAME) {
      return json({ error: 'lastfm_not_configured' }, 500, origin);
    }

    const cached = await caches.default.match(PAYLOAD_CACHE_KEY);
    if (cached) return withCors(cached, origin);

    const track = await fetchRecentTrack(env);
    const payload = track
      ? toPayload(track, env.LASTFM_USERNAME)
      : {
          isPlaying: false,
          trackName: 'Nothing scrobbled yet',
          artists: 'Play something in Qobuz to update this tile.',
          albumName: '',
          albumImageUrl: '',
          trackUrl: `https://www.last.fm/user/${encodeURIComponent(env.LASTFM_USERNAME)}`,
          playedAt: null,
          lastUpdated: new Date().toISOString(),
        };

    return respondAndCache(payload, origin, waitUntil);
  } catch (error) {
    console.error('lastfm-recent function failed', error);
    return json({ error: 'lastfm_unavailable' }, 502, origin);
  }
};
