// The relay is a proxy, so the tests assert on what reaches the BACKEND and
// what comes back — not on the shape of the code that moves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { relayFetch, errorResponse, RelayError } from '../relay.js';

/** A backend that records what it received and answers however the test wants. */
function backend(handler) {
  const seen = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString(),
      });
      handler(req, res);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () =>
      resolve({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }),
    );
  });
}

test('forwards path and query verbatim, because XHTTP appends its own', async () => {
  const be = await backend((_, res) => res.end('ok'));
  try {
    // The shape XHTTP actually produces: the configured path, then a session
    // id, then a packet sequence number. Normalising any of it routes the first
    // request and drops every one after.
    const path = '/f986ca07/9a4f2c1e-0d3b-4f7a-9c2e-5b1d8e6a3f42/7';
    const res = await relayFetch(
      new Request(`https://relay.example${path}?x=1`),
      { FORGE_BACKEND: be.url },
    );
    assert.equal(res.status, 200);
    assert.equal(be.seen[0].url, `${path}?x=1`);
  } finally {
    be.close();
  }
});

test('strips the edge stamps that would mislead the panel', async () => {
  const be = await backend((_, res) => res.end('ok'));
  try {
    await relayFetch(
      new Request('https://relay.example/p', {
        headers: {
          // ForgePanel decides which transports it can serve from exactly this
          // header. Passing it through would make a panel with no CDN in front
          // refuse httpupgrade and brook because of a CDN in front of the RELAY.
          'cf-ray': 'a3340da85b6bd0a8-CDG',
          'x-vercel-id': 'cdg1::abc',
          'user-agent': 'keep-me',
        },
      }),
      { FORGE_BACKEND: be.url },
    );
    const h = be.seen[0].headers;
    assert.equal(h['cf-ray'], undefined, 'cf-ray reached the panel');
    assert.equal(h['x-vercel-id'], undefined, 'x-vercel-id reached the panel');
    assert.equal(h['user-agent'], 'keep-me', 'an ordinary header was dropped');
    // No marker by default. It would be a label naming what this deployment
    // is, on every request, for no functional gain.
    assert.equal(h['x-forwarded-by'], undefined, 'the relay named itself unasked');
  } finally {
    be.close();
  }
});

test('streams the download leg instead of buffering it', async () => {
  // XHTTP's download leg never completes while the tunnel is up. A relay that
  // read it to the end before answering would hold every byte in memory and
  // deliver nothing, which looks exactly like a dead backend.
  let push;
  const be = await backend((_, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write('first');
    push = (s) => res.write(s);
  });
  try {
    const res = await relayFetch(new Request('https://relay.example/s'), {
      FORGE_BACKEND: be.url,
    });
    const reader = res.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'first',
      'the first chunk did not arrive before the response ended');
    push('second');
    const second = await reader.read();
    assert.equal(new TextDecoder().decode(second.value), 'second');
    await reader.cancel();
  } finally {
    be.close();
  }
});

test('passes the upload body through without collecting it', async () => {
  const be = await backend((_, res) => res.end('ok'));
  try {
    await relayFetch(
      new Request('https://relay.example/u', { method: 'POST', body: 'payload-bytes' }),
      { FORGE_BACKEND: be.url },
    );
    assert.equal(be.seen[0].method, 'POST');
    assert.equal(be.seen[0].body, 'payload-bytes');
  } finally {
    be.close();
  }
});

test('refuses to start with no backend, and says what to set', async () => {
  await assert.rejects(
    () => relayFetch(new Request('https://relay.example/'), {}),
    (e) => e instanceof RelayError && e.status === 500 && /FORGE_BACKEND/.test(e.message),
  );
});

test('an optional key keeps it from being an open proxy', async () => {
  const be = await backend((_, res) => res.end('ok'));
  try {
    await assert.rejects(
      () => relayFetch(new Request('https://relay.example/p'), {
        FORGE_BACKEND: be.url, FORGE_RELAY_KEY: 'secret',
      }),
      (e) => e.status === 403,
    );
    const ok = await relayFetch(
      new Request('https://relay.example/p', { headers: { 'x-forge-relay-key': 'secret' } }),
      { FORGE_BACKEND: be.url, FORGE_RELAY_KEY: 'secret' },
    );
    assert.equal(ok.status, 200);
  } finally {
    be.close();
  }
});

test('the marker is opt-in and only appears when asked for', async () => {
  const be = await backend((_, res) => res.end('ok'));
  try {
    await relayFetch(new Request('https://relay.example/p'), {
      FORGE_BACKEND: be.url, FORGE_TAG: 'edge-1',
    });
    assert.equal(be.seen[0].headers['x-forwarded-by'], 'edge-1');
  } finally {
    be.close();
  }
});

test('does not tell the client where the backend lives', async () => {
  // Found in production, not in a test: a relay fronting a Render panel
  // answered with x-render-origin-server, so probing the relay hostname
  // revealed the real one. A second front door whose responses name the first
  // is not a second front door.
  const be = await backend((_, res) => {
    res.setHeader('x-render-origin-server', 'Render');
    res.setHeader('server', 'gunicorn/20.1');
    res.setHeader('x-powered-by', 'Express');
    res.setHeader('content-type', 'text/html');
    res.end('<html>');
  });
  try {
    const res = await relayFetch(new Request('https://relay.example/p'), {
      FORGE_BACKEND: be.url,
    });
    for (const h of ['x-render-origin-server', 'server', 'x-powered-by']) {
      assert.equal(res.headers.get(h), null, `${h} named the backend to the client`);
    }
    // The headers that make the response usable must survive.
    assert.equal(res.headers.get('content-type'), 'text/html');
  } finally {
    be.close();
  }
});

test('a dead backend is 502 and a slow one is 504, not a stack trace', async () => {
  const dead = await relayFetch(
    new Request('https://relay.example/p'),
    { FORGE_BACKEND: 'http://127.0.0.1:1' },
  ).catch((e) => e);
  assert.equal(dead.status, 502);
  const res = errorResponse(dead);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /^forgerelay: /);

  const be = await backend(() => { /* never answers */ });
  try {
    const slow = await relayFetch(new Request('https://relay.example/p'), {
      FORGE_BACKEND: be.url, FORGE_TIMEOUT_MS: '1000',
    }).catch((e) => e);
    assert.equal(slow.status, 504);
  } finally {
    be.close();
  }
});
