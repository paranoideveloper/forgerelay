# Hugging Face Space, Docker SDK.
#
# Deno rather than Node because the relay is written to Web standards and Deno
# runs it with no build step and no dependency tree — the whole image is the
# runtime plus two files.
FROM denoland/deno:alpine-2.7.14

# Spaces run as a non-root user with UID 1000, and this image already ships one
# — `deno`, at exactly that uid. Creating another fails the build with a bare
# "adduser: exit code 1", which reads as a permissions problem rather than a
# collision. Anything the process reads must be owned by it, or the container
# starts and cannot open its own source.
WORKDIR /app
COPY --chown=deno:deno relay.js ./relay.js
COPY --chown=deno:deno huggingface/server.ts ./server.ts
USER deno

# Spaces route to 7860 unless app_port says otherwise. Deno.serve reads PORT,
# so this stays correct if the Space is reconfigured.
ENV PORT=7860
EXPOSE 7860

# Cached at build time so a cold start is not also a download.
RUN deno cache server.ts

CMD ["deno", "run", "--allow-net", "--allow-env", "server.ts"]
