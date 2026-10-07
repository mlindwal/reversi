// Hands out short-lived Cloudflare TURN credentials to the Reversi page, so
// players whose networks block direct connections can still play. The page
// fetches them before joining a game; this Worker keeps the API token secret.
//
// Secrets (set with `npx wrangler secret put <NAME>`, never committed):
//   TURN_KEY_ID          the TURN key's ID
//   TURN_KEY_API_TOKEN   the TURN key's API token
// Variables (wrangler.toml):
//   ALLOWED_ORIGINS      comma-separated origins that may ask for credentials
//   CREDENTIAL_TTL       credential lifetime in seconds
// Bindings (wrangler.toml):
//   RATE_LIMITER         limits requests per IP address (optional)
//
// The URL of this Worker is public, so anyone can call it. The origin check
// stops other websites from using it through their visitors' browsers (a
// script can fake the Origin header, so it is not a lock), the rate limit
// slows down bulk requests, and the short lifetime makes harvested
// credentials expire quickly.

const API_BASE = 'https://rtc.live.cloudflare.com/v1';
const DEFAULT_TTL = 7200;
const MIN_TTL = 300;
const MAX_TTL = 86400;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (!origin || !allowedOrigins(env).includes(origin)) {
      return json({ error: 'Origin not allowed.' }, 403);
    }
    const cors = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' }
      });
    }
    if (request.method !== 'GET') {
      return json({ error: 'Use GET.' }, 405, { ...cors, Allow: 'GET, OPTIONS' });
    }

    if (env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: 'Too many requests.' }, 429, cors);
    }

    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
      console.error('TURN_KEY_ID and TURN_KEY_API_TOKEN secrets are not set.');
      return json({ error: 'TURN is not configured.' }, 500, cors);
    }

    const ttl = credentialTtl(env);
    let response;
    try {
      response = await fetch(
        `${API_BASE}/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ ttl })
        }
      );
    } catch (error) {
      console.error('Could not reach the Cloudflare TURN API:', error);
      return json({ error: 'Could not create credentials.' }, 502, cors);
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      console.error(`Cloudflare TURN API answered ${response.status}: ${detail}`);
      return json({ error: 'Could not create credentials.' }, 502, cors);
    }

    const data = await response.json();
    return json({ iceServers: usableServers(data.iceServers), ttl }, 200, cors);
  }
};

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function credentialTtl(env) {
  const ttl = Number(env.CREDENTIAL_TTL);
  if (!Number.isFinite(ttl)) return DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, Math.round(ttl)));
}

// Cloudflare also offers its servers on port 53, for networks that only allow
// DNS traffic. Some browsers block that port, and waiting for it to time out
// slows connecting down, so leave those URLs out; the other ports remain.
function usableServers(servers) {
  if (!Array.isArray(servers)) return [];
  return servers
    .map((server) => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
        .filter((url) => typeof url === 'string' && !/:53(\?|$)/.test(url));
      return { ...server, urls };
    })
    .filter((server) => server.urls.length > 0);
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
  });
}
