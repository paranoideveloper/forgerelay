// Hugging Face Space entry point.
//
// The same relay.js the Vercel and Deno Deploy entry points use. A Space is a
// long-lived container rather than an edge function, which changes two things
// worth knowing: there is no per-request time limit, so XHTTP's stream-up mode
// is available here and nowhere else; and a free Space SLEEPS after inactivity,
// so the first request after a quiet period pays a cold start that a proxy
// client will not wait through.
import { errorResponse, relayFetch } from "./relay.js";

const port = Number(Deno.env.get("PORT") ?? "7860");

Deno.serve({ port, hostname: "0.0.0.0" }, async (request: Request): Promise<Response> => {
  try {
    return await relayFetch(request, Deno.env.toObject());
  } catch (err) {
    return errorResponse(err);
  }
});
