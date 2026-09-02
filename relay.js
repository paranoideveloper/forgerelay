// The relay itself. One implementation, both platforms.
//
// Netlify Edge Functions and Vercel Edge Functions are both standards-based
// runtimes — Request in, Response out, fetch to reach the backend — so the
// forwarding logic has no reason to exist twice. The platform entry points are
// thin files that hand a Request to relayFetch and return what comes back.
//
// WHAT THIS CAN AND CANNOT CARRY, and why it is not a limitation of this code:
//
//   XHTTP        yes. It is ordinary HTTP — POSTs going up, a streamed GET
//                coming down — so a serverless runtime can forward it. In
//                packet-up mode it is many short requests, which is the shape
//                these platforms are built for.
//   ws           only where the runtime terminates WebSockets, and then only
//                for as long as it allows a function to live. Vercel does, up
//                to 300 s. Netlify Edge does not.
//   httpupgrade  no, anywhere. It sends Connection: Upgrade with no
//                Sec-WebSocket-Key, so it is not a WebSocket handshake at all;
//                an edge that implements WebSocket answers 101 and then relays
//                nothing, because there is no socket to relay. Measured against
//                Cloudflare, which behaves exactly this way.
//   brook        no, anywhere. It completes a valid handshake and then writes
//                RAW bytes rather than frames — the first byte after the 101 is
//                an invalid opcode — so any edge that parses WebSocket frames
//                drops it. Only a plain TCP proxy carries brook.
//
// Refusing to pretend otherwise is the point: an inbound that is configured,
// enabled and silently carries nothing is worse than one that was never offered.

/** Headers that belong to a single hop and must never be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers the platform's own edge added on the way in. Forwarding them makes
 * the backend believe a second proxy is in front of it — ForgePanel decides
 * which transports it can serve from exactly these — so they are dropped and
 * replaced with this relay's own.
 */
const EDGE_STAMPS = new Set([
  'cf-ray',
  'cf-connecting-ip',
  'cf-visitor',
  'cf-ipcountry',
  'x-vercel-id',
  'x-vercel-ip-country',
  'x-nf-request-id',
  'x-nf-client-connection-ip',
]);

/**
 * Response headers that name the backend, dropped on the way out.
 *
 * Found by deploying it: a relay fronting a Render-hosted panel answered with
 * `x-render-origin-server: Render`, so anyone who probed the relay hostname
 * learned where the real panel lives — which is the one thing a second front
 * door exists to avoid. The relay is supposed to be the only thing visible.
 */
const ORIGIN_STAMPS = new Set([
  'x-render-origin-server',
  'x-powered-by',
  'via',
  'x-served-by',
  'x-backend-server',
  'x-railway-request-id',
  'fly-request-id',
  'server',
]);

export class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Read configuration from whichever env object the runtime provides. */
export function readConfig(env) {
  const backend = (env.FORGE_BACKEND || '').trim().replace(/\/+$/, '');
  if (!backend) {
    throw new RelayError(
      500,
      'FORGE_BACKEND is not set. Point it at the panel this relay fronts, ' +
        'for example https://panel.example.com',
    );
  }
  if (!/^https?:\/\//i.test(backend)) {
    throw new RelayError(500, `FORGE_BACKEND must be an http(s) URL, got ${backend}`);
  }
  return {
    backend,
    // A shared secret the panel never sees but this relay requires, so the
    // deployment is not an open proxy for anyone who finds the hostname.
    // Optional, because a relay whose only paths are unguessable inbound paths
    // is already hard to abuse, and requiring a header the client cannot send
    // would make it useless for the very traffic it exists to carry.
    key: (env.FORGE_RELAY_KEY || '').trim(),
    // Sent to the backend as Host. Empty keeps the relay's own hostname, which
    // is what a panel behind a CDN expects; set it when the backend routes by a
    // different name.
    host: (env.FORGE_BACKEND_HOST || '').trim(),
    timeoutMs: clampInt(env.FORGE_TIMEOUT_MS, 1000, 300000, 240000),
    // A marker on relayed requests, so the panel's logs can tell them from
    // direct ones. Off unless asked for: it is a label identifying what this
    // deployment does, and the traffic works perfectly well unlabelled.
    tag: (env.FORGE_TAG || '').trim(),
    // '' | 'accel' | 'sse' — see the response block below.
    streamHint: (env.FORGE_STREAM_HINT || '').trim(),
  };
}

function clampInt(raw, lo, hi, fallback) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Forward one request to the backend and return its response.
 *
 * The body is passed through, never buffered. XHTTP's download leg is a
 * long-lived streaming response, and reading it into memory first would hold
 * the tunnel's data in this function until it completed — which for a stream
 * that never completes means forever.
 */
export async function relayFetch(request, env, fetchImpl = fetch) {
  const cfg = readConfig(env);

  if (cfg.key && request.headers.get('x-forge-relay-key') !== cfg.key) {
    throw new RelayError(403, 'forbidden');
  }

  const inUrl = new URL(request.url);
  // Path and query verbatim. XHTTP appends a session id and a packet sequence
  // to the configured path, so rewriting or normalising the path routes the
  // first request and drops every one after it.
  const target = cfg.backend + inUrl.pathname + inUrl.search;

  const headers = new Headers();
  for (const [k, v] of request.headers) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || EDGE_STAMPS.has(lk) || lk === 'host') continue;
    headers.set(k, v);
  }
  if (cfg.host) headers.set('host', cfg.host);
  // Ask the backend for the bytes as they are.
  //
  // A tunnel's payload is already compressed and encrypted; negotiating an
  // encoding on it gains nothing and gives the CDN in between something to
  // re-encode. Netlify answers a forwarded Accept-Encoding with
  // `vary: Accept-Encoding`, which is a CDN telling you it is in the business
  // of transforming this response.
  headers.set('accept-encoding', 'identity');
  // Opt-in, and off by default. It is useful for telling relayed traffic from
  // direct traffic in the panel's logs, and it is also a name that says what
  // this deployment is to anything that reads it. Nothing should have to be
  // named in order to work.
  if (cfg.tag) headers.set('x-forwarded-by', cfg.tag);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);

  try {
    const init = {
      method: request.method,
      headers,
      signal: ac.signal,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // Streamed, not buffered.
      //
      // I briefly read the body first, guessing that a Deno edge might not
      // accept a streaming request body. That was wrong and it was a
      // regression: buffering rules out XHTTP's stream-up mode, whose upload
      // leg is one request that never ends, and the runtimes accept the stream
      // fine — bomusk/Vercel-XHTTP does exactly this in production.
      init.body = request.body;
      // Required by the Fetch standard whenever body is a stream.
      init.duplex = 'half';
    }
    const upstream = await fetchImpl(target, init);

    const out = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk) || ORIGIN_STAMPS.has(lk)) continue;
      out.set(k, v);
    }
    // A tunnel's bytes are not a web page. Any cache between here and the
    // client that decided to store them would serve one session's data to
    // another.
    // no-transform is the standing instruction to every intermediary NOT to
    // recompress, re-chunk or otherwise touch the body. On a tunnel that is not
    // an optimisation to decline, it is a correctness requirement: the stream
    // means nothing if something in the middle reframes it.
    out.set('cache-control', 'no-store, no-transform');
    // Anti-buffering hints, switchable so they can be measured rather than
    // assumed. A CDN that holds a streaming body until it ends turns a tunnel
    // into nothing, and the usual levers are: the nginx-family
    // X-Accel-Buffering, and a content type platforms special-case for
    // server-sent events.
    if (cfg.streamHint) {
      out.set('x-accel-buffering', 'no');
      if (cfg.streamHint === 'sse') {
        out.set('content-type', 'text/event-stream');
      }
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new RelayError(504, 'the panel did not answer in time');
    }
    throw new RelayError(502, `could not reach the panel: ${err && err.message ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Turn any failure into a response that says which side failed. */
export function errorResponse(err) {
  const status = err instanceof RelayError ? err.status : 502;
  // Plain text and no detail beyond the sentence: this endpoint is reachable by
  // anyone who finds the hostname, and a stack trace would describe the backend
  // to them.
  return new Response(`forgerelay: ${err.message}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
