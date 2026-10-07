const test = require('node:test');
const assert = require('node:assert');

const ORIGIN = 'https://mlindwal.github.io';
const env = (extra = {}) => ({
  ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8000`,
  CREDENTIAL_TTL: '7200',
  TURN_KEY_ID: 'key-id',
  TURN_KEY_API_TOKEN: 'secret-token',
  ...extra
});
const request = (headers = { Origin: ORIGIN }, method = 'GET') =>
  new Request('https://reversi-turn.example.workers.dev/', { method, headers });

let worker;
let calls;
const realFetch = global.fetch;

test.before(async () => {
  worker = (await import('../worker/src/index.js')).default;
});

test.beforeEach(() => {
  calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        {
          urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
            'turns:turn.cloudflare.com:443?transport=tcp'],
          username: 'user',
          credential: 'pass'
        }
      ]
    }), { status: 201 });
  };
});

test.after(() => {
  global.fetch = realFetch;
});

test('returns credentials from the Cloudflare TURN API', async () => {
  const response = await worker.fetch(request(), env());
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.strictEqual(response.headers.get('Cache-Control'), 'no-store');

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url,
    'https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers');
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer secret-token');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { ttl: 7200 });

  const body = await response.json();
  assert.strictEqual(body.ttl, 7200);
  // Port 53 URLs are dropped; everything else is passed through.
  assert.deepStrictEqual(body.iceServers, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: 'user',
      credential: 'pass'
    }
  ]);
  assert.ok(!JSON.stringify(body).includes('secret-token'));
});

test('refuses origins that are not allowed, and requests without one', async () => {
  for (const headers of [{ Origin: 'https://evil.example' }, {}]) {
    const response = await worker.fetch(request(headers), env());
    assert.strictEqual(response.status, 403);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.strictEqual(calls.length, 0);
});

test('answers CORS preflight and refuses other methods', async () => {
  const preflight = await worker.fetch(request({ Origin: 'http://localhost:8000' }, 'OPTIONS'), env());
  assert.strictEqual(preflight.status, 204);
  assert.strictEqual(preflight.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  const post = await worker.fetch(request({ Origin: ORIGIN }, 'POST'), env());
  assert.strictEqual(post.status, 405);
  assert.strictEqual(calls.length, 0);
});

test('rate limits by IP address', async () => {
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: keys.length <= 1 }; } };
  const headers = { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.7' };
  assert.strictEqual((await worker.fetch(request(headers), env({ RATE_LIMITER: limiter }))).status, 200);
  assert.strictEqual((await worker.fetch(request(headers), env({ RATE_LIMITER: limiter }))).status, 429);
  assert.deepStrictEqual(keys, ['203.0.113.7', '203.0.113.7']);
  assert.strictEqual(calls.length, 1);
});

test('reports missing secrets and API failures without leaking details', async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    const missing = await worker.fetch(request(), env({ TURN_KEY_API_TOKEN: '' }));
    assert.strictEqual(missing.status, 500);

    global.fetch = async () => new Response('bad token secret-token', { status: 401 });
    const failed = await worker.fetch(request(), env());
    assert.strictEqual(failed.status, 502);
    assert.ok(!(await failed.text()).includes('secret-token'));

    global.fetch = async () => { throw new Error('network down'); };
    assert.strictEqual((await worker.fetch(request(), env())).status, 502);
  } finally {
    console.error = errors;
  }
});

test('keeps the credential lifetime within bounds', async () => {
  for (const [value, expected] of [['60', 300], ['999999', 86400], ['abc', 7200], [undefined, 7200]]) {
    calls = [];
    await worker.fetch(request(), env({ CREDENTIAL_TTL: value }));
    assert.strictEqual(JSON.parse(calls[0].init.body).ttl, expected);
  }
});
