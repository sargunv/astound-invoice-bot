FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app

RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]
ENV SQLITE_DB_PATH="/data/db.sqlite"

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src

USER bun
ENTRYPOINT ["bun", "run", "./src/main.ts"]
