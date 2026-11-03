# Build context is the repo root (see infra/docker-compose.yml), pruned by /.dockerignore.
#
# Node 22, not 20: the v4 bot.db cutover reads SQLite through `node:sqlite`, which does not exist
# on Node 20 — the extractor child died with "bad option: --experimental-sqlite" the first time
# anyone actually uploaded a bot.db. Development and CI already run on 22, so 20 in this image was
# the one runtime nothing had ever tested.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
# The worker DRAWS the Discord match board, and alpine ships no fonts at all — without these the
# board renders every label as nothing. Noto covers the Latin text; DejaVu is the fallback.
RUN apk add --no-cache font-noto ttf-dejavu
# The Cloudflare tunnel runs inside the API (Administration → Online access, apps/api/src/tunnel.ts),
# so cloudflared ships in the image: pinned, and copied out of Cloudflare's own image for this
# machine's architecture. One static binary — it runs on alpine as it is.
COPY --from=cloudflare/cloudflared:2026.10.0 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# MANIFESTS FIRST, SOURCE SECOND — this ordering is the whole point, and the file used to claim it
# while doing the opposite: a single `COPY . .` sat above the install, so every one-line source fix
# invalidated that layer and re-ran `pnpm install` for the entire workspace from scratch. Docker
# keys this layer on the lockfile and the package.json files alone, none of which a code change
# touches, so an edit-only rebuild now reuses the installed node_modules and goes straight to
# `pnpm build`. Each manifest is listed explicitly because COPY globs flatten directory structure,
# and pnpm needs EVERY workspace manifest present to link the internal deps — miss one and its
# node_modules is never created, which surfaces much later as "cannot find module @app/...".
# The list must match pnpm-workspace.yaml exactly; docker-context.test.ts fails the build if it
# drifts, because the first version of this file was generated from apps/* and packages/* alone and
# silently dropped plugins/*.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json                 apps/api/
COPY apps/discord/package.json             apps/discord/
COPY apps/panel/package.json               apps/panel/
COPY apps/workers/package.json             apps/workers/
COPY packages/access/package.json          packages/access/
COPY packages/bus/package.json             packages/bus/
COPY packages/db/package.json              packages/db/
COPY packages/events/package.json          packages/events/
COPY packages/games/package.json           packages/games/
COPY packages/ingest/package.json          packages/ingest/
COPY packages/maps/package.json            packages/maps/
COPY packages/payout/package.json          packages/payout/
COPY packages/plugin-sdk/package.json      packages/plugin-sdk/
COPY packages/rcon-core/package.json       packages/rcon-core/
COPY packages/rules/package.json           packages/rules/
COPY packages/schedule/package.json        packages/schedule/
COPY packages/shared/package.json          packages/shared/
COPY packages/widgets/package.json         packages/widgets/
COPY plugins/example-killfeed/package.json plugins/example-killfeed/
RUN pnpm install --frozen-lockfile

# The commit this build is from, passed in by start.bat / start.sh (the .git directory is
# deliberately not in the build context, so the image cannot read it itself). Declared BEFORE
# `pnpm build` because the panel bakes NEXT_PUBLIC_APP_COMMIT into its bundle — that is what lets
# an already-open tab notice the server moved on and offer a reload. The layer-cache cost is nil:
# any commit that changes the hash changed the source too, so this layer was rebuilding anyway.
# APP_COMMIT is the server side of the same handshake — /api/health/metrics reports it, the
# sidebar shows it, so "which code is this install actually running" is answered on sight.
ARG GIT_COMMIT=
ENV APP_COMMIT=$GIT_COMMIT NEXT_PUBLIC_APP_COMMIT=$GIT_COMMIT

# Now the source. Changing any of it costs a rebuild of this layer down — never the install above.
COPY . .
RUN pnpm build

# Where the code came from, for the panel's "update available" check (apps/api/src/updates.ts):
# the branch the clone follows and the GitHub repository as owner/name, from the start scripts.
# After the build, so following another branch costs no rebuild.
ARG GIT_BRANCH=
ARG GIT_REPO=
ENV APP_BRANCH=$GIT_BRANCH APP_REPO=$GIT_REPO

ENV WEB_ROOT=/app/apps/panel/out
EXPOSE 8080
CMD ["node", "apps/api/dist/index.js"]
