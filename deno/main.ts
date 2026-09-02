// Deno Deploy entry point.
//
// Deno Deploy runs the same runtime as Netlify's edge functions, so relay.js
// needs no changes — only a server around it. That is deliberate: the reason to
// try Deno Deploy at all is that Netlify's FREE tier 429s any request whose
// Referer carries XHTTP's `x_padding`, and the runtime was never the problem.
//
// Deno.serve rather than an export, because Deno Deploy takes a plain HTTP
// server and this way the same file runs locally with `deno run` for testing —
// which is how this was verified before it was ever deployed.
import { errorResponse, relayFetch } from "../relay.js";

Deno.serve(async (request: Request): Promise<Response> => {
  try {
    return await relayFetch(request, Deno.env.toObject());
  } catch (err) {
    return errorResponse(err);
  }
});
