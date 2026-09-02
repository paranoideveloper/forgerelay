# ForgeRelay

**A second front door for a ForgePanel that lives somewhere else.**

Deploy this to Vercel, Deno Deploy or a Hugging Face Space and you get another
hostname — another TLS certificate, another IP range, another CDN — pointing at
a panel you already run. The panel stays where it is. Nothing about it changes.

It exists because a blocked hostname is easier to replace than a blocked server.

```
client ──▶ your-relay.vercel.app ──▶ panel.example.com ──▶ internet
           (the relay, anywhere)        (the real ForgePanel)
```

---

## What it can carry, and what it cannot

This is the part to read before deploying. **Neither platform can host a proxy
panel** — that is not what this is. They can forward HTTP, and only some proxy
transports are HTTP.

| Transport | Netlify free | Vercel | Deno Deploy | HF Space | why |
|---|---|---|---|---|---|
| **XHTTP** | ❌ | ✅ **deployed** | ✅ **deployed** | 💳 needs PRO | ordinary HTTP, so a serverless runtime can forward it |
| **ws** | ❌ | ⚠️ 300 s | ⚠️ | ✅ | Netlify Edge does not terminate WebSockets; the function-based hosts drop the connection at their time limit and it reconnects |
| **httpupgrade** | ❌ | ❌ | ❌ | ❌ | not a WebSocket at all — see below |
| **brook** | ❌ | ❌ | ❌ | ❌ | a real handshake, then raw bytes — see below |
| Reality, Hysteria2, TUIC, WireGuard | ❌ | ❌ | ❌ | ❌ | need raw TCP or UDP; all four route HTTP only |

**✅ deployed** means measured through the platform's own edge. **💳 needs PRO**
means the code is built and works but the platform will not host it for free.

Measured through each platform's live edge, same backend, same hour:

```
Deno Deploy   XHTTP 200 in 1.16 s, 3 MB at 1.78 MB/s, 10 s stream held open
Vercel        XHTTP 200 in 1.51 s, 3 MB at 4.52 MB/s
HF Space      built and measured through the image locally: 200 in 0.24 s,
              3 MB at 9.59 MB/s — but see below, it cannot be hosted for free
```

The 10-second hold is the one that matters on a new platform: it is the same
drip that exposed Netlify's buffering, and Deno Deploy delivered it in 10.1 s
rather than all at the end.

### Netlify's FREE TIER blocks XHTTP

Free Netlify sites return **429** to any request whose `Referer` contains the
string `x_padding` — the query parameter Xray's XHTTP client puts there on every
request:

```
referer: https://example.com/                 -> 400   (reaches the backend)
referer: https://example.com/somepath/        -> 400
referer: https://example.com/?q=1             -> 400
referer: https://example.com/?x_padding=XXXX  -> 429   BLOCKED
```

It is the literal parameter name, not the length, not the host, not
self-reference. `x_padding` is XHTTP's signature, so this is a deliberate
anti-proxy rule rather than a rate limit that happened to fire.

The 429 comes from Netlify's edge **before the function runs** — its responses
carry none of the headers this relay sets — so no forwarding logic works around
it. Xray emits the parameter unconditionally too: `xPaddingBytes` of `0`, `0-0`
or unset all still send it, on 26.2.6 and 26.3.27 alike.

**Measured across nine sites and two accounts:**

```
free sites — ALL 429 on x_padding
  two of our own, on DIFFERENT accounts and different emails
  michael-kyle-lee.netlify.app, mg-portfolioweb.netlify.app,
  jayanthportfolia22.netlify.app, devmistryprojects.netlify.app  (strangers')

large paid sites — 200, unaffected
  docs.netlify.com, www.netlify.com, vuejs.org
```

The four third-party sites are the ones that settle it: this is not an abuse flag
on one account, and a second account does not escape it. What separates the two
groups is the plan, though the exact discriminator is not proven — it may be the
tier, or reputation, or something else that large sites happen to have.

**So: Netlify free does not carry XHTTP, and a new account does not fix it.** Assume any account that gets flagged is finished for this purpose, which
is the strongest argument in this README for keeping the traffic small.

### Netlify also buffers responses, which had to be solved first

Measured against a live deploy, relaying `httpbin.org/drip?duration=8&numbytes=8`
— eight bytes dribbled out over eight seconds:

```
direct at httpbin     starttransfer=0.43s   total=7.56s
through the relay     starttransfer=8.93s   total=8.93s
```

Direct, the first byte arrives in 0.43 s and the rest trickle. Through a Netlify
Edge Function the first byte arrives at 8.93 s — **the moment the response
finishes**. The edge holds the whole body and then releases it.

XHTTP's download leg is a long-lived response that never completes while the
tunnel is up, so a buffering edge delivers nothing, ever. That is why every
short request through this relay works — the panel UI, a login, creating an
inbound — and why no proxy traffic does.

It is a property of the platform, not of this code. Verified by elimination
first: the path forwards verbatim with the session id intact, direct and relayed
responses are header-for-header identical including X-Padding, non-standard
backend ports are reachable, and neither Host preservation nor disabling
compression changed anything.

Solved by giving the response `content-type: text/event-stream`, which the
platform special-cases: first byte moved from 8.93 s to 1.86 s on the same
8-second drip. Xray's own download leg already uses that content type, so this
turned out not to be the blocker — but it would have been the next one.

**Vercel does not carry the `x_padding` rule** — it was the first thing checked
there, and the relay has since run XHTTP through it end to end. On any new
platform check that rule first: one curl with `?x_padding=X` in the Referer
answers in a second what cost a day here.

### Why httpupgrade and brook cannot work through any CDN

Both were measured, not assumed.

**httpupgrade never performs a WebSocket handshake.** Captured off the wire,
Xray sends:

```
GET /path HTTP/1.1
Connection: Upgrade
Upgrade: websocket          ← and no Sec-WebSocket-Key
```

An edge that implements WebSocket has nothing to reject, so it answers `101` and
then relays nothing. Side by side against the same host: `ws` comes back with
`Sec-WebSocket-Accept` and carries traffic; `httpupgrade` comes back without one
and carries none.

**brook completes a valid handshake and then stops speaking WebSocket.** First
bytes after its `101`:

```
2c a8 84 33 c4 4b ...     byte0 = 0x2c → opcode 12, not a frame
```

A plain TCP proxy passes that through, which is why brook works through a direct
connection and through a TLS terminator. Anything that parses WebSocket frames
drops it.

So these two are not "unsupported here" — they cannot cross a CDN anywhere, and
a relay that offered them would hand you an endpoint that looks configured and
moves nothing.

---

## Deploy

Both platforms read their own manifest from the repository root. Set one
variable and deploy.

| Variable | Required | What it does |
|---|---|---|
| `FORGE_BACKEND` | **yes** | the panel this fronts, e.g. `https://panel.example.com` |
| `FORGE_RELAY_KEY` | no | require `x-forge-relay-key` on every request, so the deployment is not an open proxy |
| `FORGE_BACKEND_HOST` | no | `Host` sent upstream, when the backend routes by a different name |
| `FORGE_TIMEOUT_MS` | no | upstream deadline, default 240000 |
| `FORGE_TAG` | no | mark relayed requests in the panel's logs. Off by default — it is a label saying what this is |

### Vercel — the one that works

```bash
vercel env add FORGE_BACKEND production   # http://origin.example.com:8081
vercel deploy --prod
```

Two things will stop you, and neither is obvious from the error:

**The backend must be a HOSTNAME, never an IP.** Vercel Edge refuses a raw
address outright — `Direct IP access is not allowed in Vercel's Edge environment`
— so give the origin a DNS record. Note the trade this forces: the origin's
address is then in public DNS, which is some of what a relay exists to hide. Use
a dull, throwaway subdomain.

**Deployment protection is on by default** and covers every `*.vercel.app` URL,
answering a 302 to Vercel's SSO. Turn it off for the project, or attach a custom
domain — those are exempt (`all_except_custom_domains`).

### Netlify

```bash
netlify env:set FORGE_BACKEND https://panel.example.com
netlify deploy --prod
```

Included for completeness. It deploys and the panel UI works through it; XHTTP
does not, for the reason above.

### Deno Deploy — verified

```bash
export DENO_DEPLOY_TOKEN=...          # a ddo_ token, from console.deno.com
deno deploy create --json --non-interactive \
  --org <org> --app <name> --region us \
  --source local --runtime-mode dynamic --entrypoint deno/main.ts \
  --do-not-use-detected-build-config --ignore public .
deno deploy env add FORGE_BACKEND http://origin.example.com:8081 --org <org> --app <name>
```

Four things will cost you an hour each if you skip them:

**Use `deno deploy`, not `deployctl`.** They are different products.
`deployctl` targets classic Deno Deploy and only accepts a `ddp_` token; a
`ddo_` token from console.deno.com fails there with "the bearer token is
invalid", which reads like a bad token rather than the wrong tool. `api.deno.com`
rejects it for the same reason.

**`--do-not-use-detected-build-config` is not optional here.** This repository
has a `public/` directory holding the placeholder page, and framework detection
sees it, decides the app is a static site, and serves that file for every
request — overriding `--runtime-mode dynamic`. The relay never runs, and the
symptom is a cheerful `200` with `server: deployd` and the placeholder's exact
content-length. `--ignore public` removes the ambiguity as well.

**A redeploy re-detects.** Creating the app with the right flags and then running
a bare `deno deploy .` puts it straight back to static.

**Netlify Edge Functions run on this exact runtime**, so nothing the relay needs
from Deno was ever in question — what stopped Netlify was a rule in its edge.
Deno Deploy does not have that rule: a Referer carrying `x_padding` returns 200.

### Hugging Face Space — built, but not free

**A Docker Space requires a PRO subscription.** Measured against the live API:

```
POST /api/repos/create {"type":"space","sdk":"docker"}  -> 402
  "Static Spaces are free for everyone, but hosting Gradio and Docker
   Spaces on free cpu-basic requires a PRO subscription."
POST /api/repos/create {"type":"space","sdk":"static"}  -> 200
```

The token and account were fine; the SDK is the gate. A static Space runs no
server-side code, so it cannot relay — which leaves nothing free to fall back
to here.

There is a second problem waiting even with PRO: a **private** Space needs
authentication to reach, so it cannot serve proxy clients, and a public one
publishes the Dockerfile and the build logs.

The image below is finished and verified, so this is a subscription away rather
than a rewrite. A Space is a container rather than an edge function, which is
the interesting part: no per-request time limit, so XHTTP's **stream-up mode** —
an upload leg that is a single request which never ends — would be available
here and on none of the others.

```bash
# Space settings: SDK = Docker, then push this repo. app_port is in the README
# front matter, so nothing needs configuring in the UI.
git remote add space https://huggingface.co/spaces/<user>/<name>
git push space main
```

Set `FORGE_BACKEND` under Settings → Variables and secrets, as a **secret**, not
a variable — variables are visible to anyone who can see the Space, and this one
names your origin.

Two properties to weigh against the missing time limit:

- **A free Space sleeps** after ~48 h idle and cold-starts on the next request.
  A browser waits; a proxy client times out and reports the tunnel as down.
- **Spaces are public by default**, including the build logs and the Dockerfile.
  A private Space costs nothing extra and is the right setting here.

### Then, in the panel

Create an **XHTTP** inbound as usual, and hand out a link that names the relay
hostname instead of the panel's:

```
vless://<uuid>@your-relay.vercel.app:443?type=xhttp&security=tls
       &sni=your-relay.vercel.app&host=your-relay.vercel.app&path=/<the inbound path>
```

Everything else — the uuid, the path — stays exactly as the panel generated it.
Only the address, sni and host change. The panel does not need to know this
relay exists.

---

## What it does to a request

- **Path and query, verbatim.** XHTTP appends a session id and a packet sequence
  to the configured path (`/path/<uuid>/7`), so normalising any of it routes the
  first request and drops every one after.
- **Nothing is buffered.** The download leg never completes while the tunnel is
  up; reading it to the end before answering would hold every byte here and
  deliver nothing, which looks exactly like a dead backend.
- **Edge stamps are stripped.** `CF-Ray`, `X-Vercel-Id` and friends are removed
  before the request reaches the panel. ForgePanel decides which transports it
  can serve from exactly those headers, so forwarding them would make a panel
  with no CDN in front refuse transports because of a CDN in front of *the
  relay*.
- **It does not name itself.** No header identifies this as a relay unless you
  set `FORGE_TAG`. The traffic works unlabelled, and a label is something that
  reads back to whoever looks.
- **`Cache-Control: no-store`,** in both directions. A tunnel's bytes are not a
  web page, and a cache that stored them would serve one session's data to
  another.
- **Failures name a side.** `502` the panel could not be reached, `504` it did
  not answer in time, `403` the relay key was wrong — never a stack trace, which
  would describe your backend to anyone who found the hostname.

---

## Keeping the account

**Both platforms' terms forbid this.** Netlify's AUP prohibits using the service
as a proxy or to disguise the origin of traffic; Vercel's is comparable. That is
not a technicality to route around — it is the actual risk, and it is the
account that pays it, not the deployment.

What follows is about not being flagged for the obvious reasons, and it does not
make the use permitted.

**Bandwidth is what gets noticed.** Free tiers watch it and it is the one signal
no cleverness hides. Netlify free is 100 GB/month, Vercel's is similar. A relay
carrying one person's browsing sits far under that; a relay carrying a group's
video does not, and the sustained egress on a "static site" is what a review
looks at. Put bulk traffic on a VPS and keep this for what it is good at — a
spare route that is trivial to redeploy under a fresh hostname.

**Do not advertise it.** This repository is private for that reason. A public
repo whose README says proxy, tunnel, VLESS or Xray is indexed, and both
platforms scan what they build. The deployed site serves a placeholder page and
identifies itself as nothing.

**Set `FORGE_RELAY_KEY`.** Without it the hostname is an open forwarder to your
panel for anyone who finds it, and an open proxy attracts exactly the traffic
and the complaints that end an account fastest.

**One relay is a spare route, ten are a pattern.** Accounts get closed for the
shape of the usage as much as its content — many projects, all placeholder
sites, all pointed at one backend. If you need many front doors, many small
providers beat many deployments on one.

**Assume it is disposable.** Keep the panel and its data somewhere you control,
put nothing here that matters, and expect any given hostname to stop working
without warning. That is the design: the panel does not know this relay exists,
so losing one costs you a link and nothing else.

---

## Tests

```bash
npm test
```

Nine tests, each against a real HTTP backend rather than a mock, asserting on
what arrives upstream and what comes back. Three of them cover failures that
would otherwise be silent — a buffered stream, a forwarded edge stamp, a
normalised path — and each was confirmed to fail when the line it guards is
removed.

---

## Scope

A relay, not a panel. It holds no state, has no database, terminates no
protocol, and cannot be a ForgePanel. If you want the panel itself on a
third-party host, that is [ForgePanel — 3rdP](https://github.com/paranoideveloper/forgepanel-3rdp),
and the same limits apply to it: Netlify and Vercel cannot run it.

MIT.
