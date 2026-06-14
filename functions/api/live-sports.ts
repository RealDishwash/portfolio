import {
  corsHeaders,
  isOriginAllowed,
  json,
  resolveAllowedOrigins,
  resolveOrigin,
} from '../_lib/http';

interface Env {
  ALLOWED_ORIGIN?: string;
}

type FunctionContext = {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
};

type EventState = 'live' | 'upcoming' | 'final';

type Competitor = {
  name: string;
  abbr: string;
  logo: string;
  score: string;
};

type Leader = {
  pos: number;
  name: string;
};

type SportEvent = {
  league: 'NBA' | 'F1';
  state: EventState;
  title: string;
  subtitle: string;
  statusDetail: string;
  startDate: string;
  home: Competitor | null;
  away: Competitor | null;
  leaders: Leader[];
  detailUrl: string;
};

type LiveSportsPayload = {
  nba: SportEvent | null;
  f1: SportEvent | null;
  lastUpdated: string;
};

// ESPN's public scoreboard endpoints — no key required.
// Exported (along with the mappers below) so the transformation logic can be exercised
// directly in tests; Cloudflare only ever invokes `onRequest`.
export const NBA_URL = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard';
export const F1_URL = 'https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard';
const CACHE_CONTROL = 'public, max-age=30, s-maxage=30';
const PAYLOAD_CACHE_KEY = 'https://portfolio-internal/live-sports/payload';
const NBA_FALLBACK = 'https://www.espn.com/nba/scoreboard';
const F1_FALLBACK = 'https://www.espn.com/f1/schedule';

// ESPN models games and races identically: an `events[]` array whose entries carry
// `competitions[]`. Only the fields we read are typed; everything is optional/defensive.
type EspnStatus = {
  type?: { name?: string; state?: string; completed?: boolean; shortDetail?: string };
};

type EspnCompetitor = {
  homeAway?: string;
  score?: string;
  order?: number;
  team?: { displayName?: string; shortDisplayName?: string; abbreviation?: string; logo?: string };
  athlete?: { displayName?: string; shortName?: string };
};

type EspnCompetition = {
  startDate?: string;
  status?: EspnStatus;
  type?: { abbreviation?: string };
  competitors?: EspnCompetitor[];
};

type EspnEvent = {
  name?: string;
  shortName?: string;
  date?: string;
  status?: EspnStatus;
  competitions?: EspnCompetition[];
  circuit?: { fullName?: string; address?: { city?: string; country?: string } };
  links?: Array<{ href?: string }>;
};

type EspnScoreboard = { events?: EspnEvent[] };

const stateFromStatus = (status?: EspnStatus): EventState => {
  const name = status?.type?.name;
  if (name === 'STATUS_IN_PROGRESS' || status?.type?.state === 'in') return 'live';
  if (name === 'STATUS_FINAL' || status?.type?.completed || status?.type?.state === 'post') {
    return 'final';
  }
  return 'upcoming';
};

// Live first, then the soonest upcoming, then the most recent final.
const pickEvent = <T>(
  candidates: Array<{ state: EventState; startMs: number; value: T }>
): T | null => {
  const live = candidates.filter((c) => c.state === 'live').sort((a, b) => a.startMs - b.startMs);
  if (live.length) return live[0].value;

  const now = Date.now();
  const upcoming = candidates
    .filter((c) => c.state === 'upcoming' && c.startMs >= now)
    .sort((a, b) => a.startMs - b.startMs);
  if (upcoming.length) return upcoming[0].value;

  const finals = candidates
    .filter((c) => c.state === 'final')
    .sort((a, b) => b.startMs - a.startMs);
  if (finals.length) return finals[0].value;

  // Anything left (e.g. an "upcoming" with a stale date) — keep the soonest by absolute time.
  return candidates.sort((a, b) => a.startMs - b.startMs)[0]?.value ?? null;
};

const toMs = (iso?: string) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

const firstLink = (event: EspnEvent, fallback: string) =>
  event.links?.find((link) => Boolean(link.href))?.href || fallback;

export const mapNbaEvent = (event: EspnEvent): SportEvent | null => {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const competitors = competition.competitors || [];
  const homeRaw = competitors.find((c) => c.homeAway === 'home') || competitors[0];
  const awayRaw = competitors.find((c) => c.homeAway === 'away') || competitors[1];
  if (!homeRaw || !awayRaw) return null;

  const toCompetitor = (c: EspnCompetitor): Competitor => ({
    name: c.team?.shortDisplayName || c.team?.displayName || c.team?.abbreviation || 'TBD',
    abbr: c.team?.abbreviation || '',
    logo: c.team?.logo || '',
    score: typeof c.score === 'string' ? c.score : '',
  });

  const status = competition.status || event.status;
  return {
    league: 'NBA',
    state: stateFromStatus(status),
    title: event.shortName || event.name || 'NBA game',
    subtitle: '',
    statusDetail: status?.type?.shortDetail || '',
    startDate: competition.startDate || event.date || '',
    home: toCompetitor(homeRaw),
    away: toCompetitor(awayRaw),
    leaders: [],
    detailUrl: firstLink(event, NBA_FALLBACK),
  };
};

export const mapF1Event = (event: EspnEvent): SportEvent | null => {
  const sessions = event.competitions || [];
  if (!sessions.length && !event.status) return null;

  // Prefer the session that best represents "now"; fall back to the Race session for results.
  const live = sessions.find((s) => stateFromStatus(s.status) === 'live');
  const upcoming = sessions
    .filter((s) => stateFromStatus(s.status) === 'upcoming')
    .sort((a, b) => toMs(a.startDate) - toMs(b.startDate))[0];
  const race = sessions.find((s) => s.type?.abbreviation === 'Race') || sessions[sessions.length - 1];
  const chosen = live || upcoming || race;

  const state = stateFromStatus(chosen?.status ?? event.status);
  const sessionLabel = chosen?.type?.abbreviation ? `${chosen.type.abbreviation}` : '';
  const baseDetail = (chosen?.status ?? event.status)?.type?.shortDetail || '';

  // For a live/finished session, surface the running order (top 3 drivers).
  const resultSource = state === 'upcoming' ? null : chosen;
  const leaders: Leader[] = (resultSource?.competitors || [])
    .slice()
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .slice(0, 3)
    .map((c, index) => ({
      pos: c.order ?? index + 1,
      name: c.athlete?.shortName || c.athlete?.displayName || 'TBD',
    }))
    .filter((leader) => leader.name !== 'TBD');

  const city = event.circuit?.address?.city;
  const subtitle = [event.circuit?.fullName, city].filter(Boolean).join(' · ');

  return {
    league: 'F1',
    state,
    title: event.shortName || event.name || 'Formula 1',
    subtitle,
    statusDetail: [sessionLabel, baseDetail].filter(Boolean).join(' · '),
    startDate: chosen?.startDate || event.date || '',
    home: null,
    away: null,
    leaders,
    detailUrl: firstLink(event, F1_FALLBACK),
  };
};

export const fetchLeague = async <T>(
  url: string,
  map: (event: EspnEvent) => T | null
): Promise<T | null> => {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) return null;
  const data = (await response.json()) as EspnScoreboard;
  const events = data.events || [];

  const candidates = events
    .map((event) => ({ event, value: map(event) }))
    .filter((entry): entry is { event: EspnEvent; value: T } => entry.value !== null)
    .map((entry) => {
      const competition = entry.event.competitions?.[0];
      const startMs = toMs(competition?.startDate || entry.event.date);
      return {
        state: stateFromStatus(competition?.status ?? entry.event.status),
        startMs,
        value: entry.value,
      };
    });

  return pickEvent(candidates);
};

const withCors = (cached: Response, origin: string) => {
  const headers = new Headers(cached.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) {
    headers.set(key, value);
  }
  return new Response(cached.body, { status: cached.status, headers });
};

const respondAndCache = (
  payload: LiveSportsPayload,
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

    const cached = await caches.default.match(PAYLOAD_CACHE_KEY);
    if (cached) {
      return withCors(cached, origin);
    }

    // One outage shouldn't blank the whole tile, so resolve each league independently.
    const [nba, f1] = await Promise.all([
      fetchLeague(NBA_URL, mapNbaEvent).catch(() => null),
      fetchLeague(F1_URL, mapF1Event).catch(() => null),
    ]);

    const payload: LiveSportsPayload = {
      nba,
      f1,
      lastUpdated: new Date().toISOString(),
    };

    return respondAndCache(payload, origin, waitUntil);
  } catch (error) {
    console.error('live-sports function failed', error);
    return json({ error: 'live_sports_unavailable' }, 502, origin);
  }
};
