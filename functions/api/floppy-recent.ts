import {
  corsHeaders,
  isOriginAllowed,
  json,
  resolveAllowedOrigins,
  resolveOrigin,
} from '../_lib/http';

interface Env {
  FLOPPY_URL?: string;
  FLOPPY_API_TOKEN?: string;
  ALLOWED_ORIGIN?: string;
}

type FunctionContext = {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
};

type FloppyItem = {
  media_type?: string;
  media_id?: string;
  source?: string;
  title?: string;
  season_number?: number;
  episode_number?: number;
};

type FloppyHistoryEntry = {
  media_type?: string;
  item?: FloppyItem | null;
  poster?: string;
  title?: string;
  display_title?: string;
  episode_code?: string | null;
  played_at_local?: string;
  score?: number | null;
};

type FloppyHistoryResponse = {
  results?: Array<{
    entries?: FloppyHistoryEntry[];
  }>;
};

type RecentWatchPayload = {
  title: string;
  subtitle: string;
  imageUrl: string;
  linkUrl: string;
  stateLabel: string;
  rating: number | null;
  isWatching: false;
  progressMs: null;
  durationMs: null;
  watchedAt: string;
  mediaType: 'movie' | 'episode';
  lastUpdated: string;
};

const CACHE_CONTROL = 'public, max-age=60, s-maxage=60';
const PAYLOAD_CACHE_KEY = 'https://portfolio-internal/floppy/recent-watch';

const normalizeBaseUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('unsupported Floppy URL protocol');
  }
  return url.toString().replace(/\/$/, '');
};

const relativeWatched = (watchedAt?: string) => {
  if (!watchedAt) return 'Watched';
  const watchedMs = Date.parse(watchedAt);
  if (Number.isNaN(watchedMs)) return 'Watched';

  const diffMinutes = Math.max(0, Math.floor((Date.now() - watchedMs) / 60_000));
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
};

const selectLatestEntry = (response: FloppyHistoryResponse) => {
  const entries = (response.results || [])
    .flatMap((day) => day.entries || [])
    .filter(
      (entry): entry is FloppyHistoryEntry & { media_type: 'movie' | 'episode' } =>
        entry.media_type === 'movie' || entry.media_type === 'episode'
    );

  return entries.reduce<(typeof entries)[number] | null>((latest, entry) => {
    if (!latest) return entry;
    const latestTime = Date.parse(latest.played_at_local || '');
    const entryTime = Date.parse(entry.played_at_local || '');
    if (Number.isNaN(entryTime)) return latest;
    return Number.isNaN(latestTime) || entryTime > latestTime ? entry : latest;
  }, null);
};

const toPayload = (
  entry: FloppyHistoryEntry & { media_type: 'movie' | 'episode' },
  baseUrl: string
): RecentWatchPayload => {
  const watchedAt = entry.played_at_local || '';
  const imageUrl = entry.poster
    ? new URL(entry.poster, `${baseUrl}/`).toString()
    : '';
  const episodeCode = entry.episode_code || '';
  const title = entry.display_title || entry.title || entry.item?.title || 'Unknown title';

  return {
    title,
    subtitle:
      entry.media_type === 'episode'
        ? [episodeCode, 'TV episode'].filter(Boolean).join(' · ')
        : 'Movie',
    imageUrl,
    linkUrl: `${baseUrl}/history/`,
    stateLabel: relativeWatched(watchedAt),
    rating: typeof entry.score === 'number' ? entry.score : null,
    isWatching: false,
    progressMs: null,
    durationMs: null,
    watchedAt,
    mediaType: entry.media_type,
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
  payload: RecentWatchPayload,
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

const fetchRecentWatch = async (baseUrl: string, apiToken: string) => {
  const url = new URL('/api/v1/history', `${baseUrl}/`);
  url.searchParams.append('types', 'movie');
  url.searchParams.append('types', 'episode');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-API-Key': apiToken,
      'User-Agent': 'vishy-portfolio/1.0 (+https://vishy.org)',
    },
  });
  if (!response.ok) throw new Error(`Floppy request failed with ${response.status}`);
  return (await response.json()) as FloppyHistoryResponse;
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

    if (!env.FLOPPY_URL || !env.FLOPPY_API_TOKEN) {
      return json({ error: 'floppy_not_configured' }, 500, origin);
    }

    const cached = await caches.default.match(PAYLOAD_CACHE_KEY);
    if (cached) return withCors(cached, origin);

    const baseUrl = normalizeBaseUrl(env.FLOPPY_URL);
    const history = await fetchRecentWatch(baseUrl, env.FLOPPY_API_TOKEN);
    const latest = selectLatestEntry(history);
    if (!latest) return json({ error: 'no_recent_history' }, 404, origin);

    return respondAndCache(toPayload(latest, baseUrl), origin, waitUntil);
  } catch (error) {
    console.error('floppy-recent function failed', error);
    return json({ error: 'floppy_unavailable' }, 502, origin);
  }
};
