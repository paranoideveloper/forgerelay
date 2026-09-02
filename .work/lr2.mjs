import { createServer } from 'node:http';
import { relayFetch, errorResponse } from '/home/ubuntu/forgerelay/relay.js';
const env = { FORGE_BACKEND: 'http://176.65.151.237:8081' };
createServer(async (req, res) => {
  const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined
    : new ReadableStream({ start(c) {
        req.on('data', d => c.enqueue(new Uint8Array(d)));
        req.on('end', () => c.close());
        req.on('error', e => c.error(e)); } });
  const request = new Request(`http://127.0.0.1:15002${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => v !== undefined),
    body, duplex: 'half',
  });
  let out;
  try { out = await relayFetch(request, env); } catch (e) { out = errorResponse(e); }
  console.log(`\n${req.method} ${req.url}`);
  for (const [k, v] of Object.entries(req.headers)) console.log(`   >${k}: ${String(v).slice(0,90)}`);
  console.log(`   => ${out.status}`);
  for (const [k, v] of out.headers) console.log(`   <${k}: ${String(v).slice(0,90)}`);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (out.body) { const rd = out.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; res.write(Buffer.from(value)); } }
  res.end();
}).listen(15002, '127.0.0.1', () => console.log('up'));
