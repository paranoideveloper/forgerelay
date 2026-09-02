// Netlify entry point. Deno runtime, standards-based Request/Response.
//
// Netlify Edge Functions do NOT terminate WebSockets, so this carries XHTTP and
// ordinary HTTP only — which is the whole reason the panel's ws inbounds should
// point at the panel directly and its xhttp inbounds can point here.
//
// The 50 ms CPU limit is not a problem for a proxy: it counts active script
// time, not time spent waiting for the backend, and this function does almost
// nothing but await. The 40 s response-header timeout is the real one, and it
// applies to time-to-first-byte rather than to the whole stream.
import { relayFetch, errorResponse } from '../../relay.js';

export default async function handler(request) {
  try {
    return await relayFetch(request, Deno.env.toObject());
  } catch (err) {
    return errorResponse(err);
  }
}

export const config = { path: '/*' };
