// Vercel entry point. Edge runtime.
//
// Vercel terminates WebSockets natively now, but a relayed WebSocket still dies
// at the function's duration limit — 300 s — so ws through here reconnects
// every five minutes. XHTTP does not care: it is already many short requests.
import { relayFetch, errorResponse } from '../relay.js';

export const config = { runtime: 'edge' };

export default async function handler(request) {
  try {
    return await relayFetch(request, process.env);
  } catch (err) {
    return errorResponse(err);
  }
}
