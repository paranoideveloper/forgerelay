---
title: Static Docs
emoji: 📄
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---

Static documentation host.

Set `FORGE_BACKEND` as a Space secret (Settings → Variables and secrets), for
example `http://origin.example.com:8081`. Optionally set `FORGE_RELAY_KEY` to
require an `x-forge-relay-key` header on every request.
