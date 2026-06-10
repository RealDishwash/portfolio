import {
  corsHeaders,
  isOriginAllowed,
  json,
  resolveAllowedOrigins,
  resolveOrigin,
} from '../_lib/http';

interface Env {
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SPOTIFY_REFRESH_TOKEN: string;
  ALLOWED_ORIGIN?: string;
}

type TokenCache = {
  accessToken: string;
  expiresAtMs: number;
};

type SpotifyTrack = {
  name?: string;
  artists?: Array<{ name?: string }>;
  album?: {
    name?: string;
    images?: Array<{ url?: string }>;
  };
  external_urls?: {
    spotify?: string;
  };
};

type SpotifyNowPlayingPayload = {
  isPlaying: boolean;
  trackName: string;
  artists: string;
  albumName: string;
  albumImageUrl: string;
  trackUrl: string;
  lastUpdated: string;
};

type FunctionContext = {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
};

const SPOTIFY_ACCOUNTS_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_CURRENTLY_PLAYING_URL = 'https://api.spotify.com/v1/me/player/currently-playing';
const SPOTIFY_RECENTLY_PLAYED_URL = 'https://api.spotify.com/v1/me/player/recently-played?limit=1';
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
const CACHE_CONTROL = 'public, max-age=10, s-maxage=10';
// Synthetic URLs used only as caches.default keys; never actually fetched.
const TOKEN_CACHE_KEY = 'https://portfolio-internal/spotify/access-token';
const PAYLOAD_CACHE_KEY = 'https://portfolio-internal/spotify/now-playing';

// Fast path only: isolates are recycled often, so the durable copy lives in caches.default.
let tokenCache: TokenCache | null = null;

const isTokenFresh = (token: TokenCache) =>
  Date.now() < token.expiresAtMs - TOKEN_EXPIRY_BUFFER_MS;

const readPersistedToken = async (): Promise<TokenCache | null> => {
  const cached = await caches.default.match(TOKEN_CACHE_KEY);
  if (!cached) return null;
  try {
    const data = (await cached.json()) as Partial<TokenCache>;
    if (typeof data.accessToken === 'string' && typeof data.expiresAtMs === 'number') {
      return { accessToken: data.accessToken, expiresAtMs: data.expiresAtMs };
    }
  } catch {
    // Corrupt entry; fall through and refresh.
  }
  return null;
};

const persistToken = (token: TokenCache) => {
  const ttlSeconds = Math.floor((token.expiresAtMs - Date.now()) / 1000);
  if (ttlSeconds <= 0) return Promise.resolve();
  return caches.default.put(
    TOKEN_CACHE_KEY,
    new Response(JSON.stringify(token), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${ttlSeconds}`,
      },
    })
  );
};

const getAccessToken = async (env: Env, waitUntil: FunctionContext['waitUntil']) => {
  if (tokenCache && isTokenFresh(tokenCache)) {
    return tokenCache.accessToken;
  }

  const persisted = await readPersistedToken();
  if (persisted && isTokenFresh(persisted)) {
    tokenCache = persisted;
    return persisted.accessToken;
  }

  const basicAuth = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: env.SPOTIFY_REFRESH_TOKEN,
  });

  const response = await fetch(SPOTIFY_ACCOUNTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new Error('spotify token exchange failed');
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('missing spotify access token');

  const expiresInSeconds = Number(data.expires_in);
  const ttlMs = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
    ? expiresInSeconds * 1000
    : 3_600_000;

  tokenCache = {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + ttlMs,
  };
  waitUntil(persistToken(tokenCache));

  return data.access_token;
};

const toPayload = (track: SpotifyTrack, isPlaying: boolean): SpotifyNowPlayingPayload => {
  const artists = (track.artists || [])
    .map((artist) => artist.name)
    .filter((name): name is string => Boolean(name))
    .join(', ');

  const albumImageUrl = (track.album?.images || [])
    .map((image) => image.url)
    .find((url): url is string => Boolean(url));

  return {
    isPlaying,
    trackName: track.name || 'Unknown track',
    artists: artists || 'Unknown artist',
    albumName: track.album?.name || 'Unknown album',
    albumImageUrl: albumImageUrl || '',
    trackUrl: track.external_urls?.spotify || 'https://open.spotify.com',
    lastUpdated: new Date().toISOString(),
  };
};

const getCurrentlyPlaying = async (accessToken: string) => {
  const response = await fetch(SPOTIFY_CURRENTLY_PLAYING_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status === 204) return null;
  if (!response.ok) throw new Error('spotify currently-playing request failed');

  const data = (await response.json()) as {
    is_playing?: boolean;
    item?: SpotifyTrack;
  };

  if (!data.item) return null;
  return toPayload(data.item, Boolean(data.is_playing));
};

const getRecentlyPlayed = async (accessToken: string) => {
  const response = await fetch(SPOTIFY_RECENTLY_PLAYED_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    items?: Array<{ track?: SpotifyTrack }>;
  };

  const track = data.items?.[0]?.track;
  if (!track) return null;
  return toPayload(track, false);
};

const withCors = (cached: Response, origin: string) => {
  const headers = new Headers(cached.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(cached.body, { status: cached.status, headers });
};

// Collapses all visitors onto one Spotify request per cache window.
const respondAndCache = (
  payload: SpotifyNowPlayingPayload,
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

    if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET || !env.SPOTIFY_REFRESH_TOKEN) {
      return json({ error: 'spotify_not_configured' }, 500, origin);
    }

    const cached = await caches.default.match(PAYLOAD_CACHE_KEY);
    if (cached) {
      return withCors(cached, origin);
    }

    const accessToken = await getAccessToken(env, waitUntil);
    const payload =
      (await getCurrentlyPlaying(accessToken)) ??
      (await getRecentlyPlayed(accessToken)) ?? {
        isPlaying: false,
        trackName: 'Nothing playing right now',
        artists: 'Start a Spotify track to update this tile.',
        albumName: '',
        albumImageUrl: '',
        trackUrl: 'https://open.spotify.com',
        lastUpdated: new Date().toISOString(),
      };

    return respondAndCache(payload, origin, waitUntil);
  } catch (error) {
    console.error('spotify-now-playing function failed', error);
    return json({ error: 'spotify_unavailable' }, 502, origin);
  }
};
