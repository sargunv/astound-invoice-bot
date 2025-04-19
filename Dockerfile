FROM oven/bun:latest

RUN mkdir -p /data
VOLUME ["/data"]
ENV SQLITE_DB_PATH="/data/db.sqlite"

COPY package.json ./package.json
COPY bun.lock ./bun.lock
COPY src ./src

RUN bun install

ENTRYPOINT bun run ./src/main.ts
