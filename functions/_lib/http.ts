export const parseAllowedOrigins = (value?: string) =>
  (value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

export const resolveAllowedOrigins = (request: Request, allowedOrigin?: string) => {
  // Same-origin (a deployment calling its own functions) is always allowed, so
  // preview deployments keep working without being listed in ALLOWED_ORIGIN.
  // ALLOWED_ORIGIN only adds extra cross-origin embedders on top of that.
  const selfOrigin = new URL(request.url).origin;
  return [...new Set([selfOrigin, ...parseAllowedOrigins(allowedOrigin)])];
};

export const resolveOrigin = (request: Request, allowedOrigins: string[]) => {
  const requestOrigin = request.headers.get('Origin');

  if (allowedOrigins.includes('*')) return '*';
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return allowedOrigins[0];
};

export const isOriginAllowed = (request: Request, allowedOrigins: string[]) => {
  if (allowedOrigins.includes('*')) return true;
  const requestOrigin = request.headers.get('Origin');
  if (!requestOrigin) {
    return allowedOrigins.includes(new URL(request.url).origin);
  }
  return allowedOrigins.includes(requestOrigin);
};

export const corsHeaders = (origin: string) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  Vary: 'Origin',
});

export const json = (body: unknown, status: number, origin: string, cacheControl = 'no-store') =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ...corsHeaders(origin),
    },
  });
