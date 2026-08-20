# astound-invoice-bot

This one-shot Bun CLI signs in to Astound Broadband, finds invoice PDFs, and emails
new ones through SMTP. SQLite records the Astound PDF paths that were accepted by
SMTP so later runs do not resend them.

The process exits after each check. Run it manually, from cron, in Docker, or as a
tool invoked by a personal automation agent.

## How it works

1. Fetch the Astound login form and CSRF token.
2. Submit the configured username and password through a cookie-aware HTTP session.
3. Verify that Astound returned a recognized authenticated bills page.
4. Download unseen `/billing/pdf/…` links and verify their PDF signatures.
5. Send bounded email batches and mark each accepted batch in SQLite.

The scraper fails loudly on a login page, unrecognized bills page, cross-origin
redirect, or non-PDF response. It does not use browser automation and assumes the
account has password-only login.

## Local setup

Install [mise](https://mise.jdx.dev/) or Bun 1.3.14, then:

```sh
cp .env.example .env
# Edit .env with real Astound and SMTP values.
mise install
bun install --frozen-lockfile
bun run smoke
bun run dry-run
bun start
```

`smoke` only authenticates and parses the bills page. It does not download PDFs,
open SQLite, or contact SMTP. `dry-run` also checks SQLite and reports how many
invoices a normal run would send, without downloading, emailing, or marking them.

On a new database, every invoice still visible in Astound is considered new.
Always run `dry-run` first, and preserve an existing `db.sqlite` when migrating.

## Configuration

See [`.env.example`](.env.example) for all settings. Required values are:

- `ASTOUND_USERNAME`, `ASTOUND_PASSWORD`
- `SQLITE_DB_PATH`
- `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`
- `EMAIL_FROM`, `EMAIL_TO`

`EMAIL_TO` must be one email address so a partially rejected recipient list cannot
be mistaken for a successful delivery.

For STARTTLS, use `SMTP_PORT=587`, `SMTP_SECURE=false`, and
`SMTP_REQUIRE_TLS=true`. For implicit TLS, use port 465 and
`SMTP_SECURE=true`. Boolean values accept `true`/`false`, `1`/`0`, and
`yes`/`no`.

Resource limits default to 10 MiB per downloaded PDF, 10 attachments per email,
and 20 MiB of estimated base64/MIME attachment data per email. HTTP response
headers and stalled body reads have bounded timeouts; SMTP operations also have an
absolute deadline. Adjust the corresponding values in `.env` only if needed.

Do not commit `.env`; it contains account and SMTP credentials.

## Docker

The published image runs as a non-root user and stores state at `/data/db.sqlite`.
A persistent volume is required:

```yaml
services:
  astound-invoice-bot:
    image: ghcr.io/sargunv/astound-invoice-bot:main
    env_file: .env
    environment:
      SQLITE_DB_PATH: /data/db.sqlite
    volumes:
      - astound-invoice-data:/data

volumes:
  astound-invoice-data:
```

Test before the first delivery:

```sh
docker compose run --rm astound-invoice-bot --dry-run
docker compose run --rm --entrypoint bun astound-invoice-bot run ./src/smoke.ts
```

Schedule the one-shot container from the host instead of mounting the Docker socket
into a scheduler. Example daily crontab entry:

```cron
15 8 * * * cd /path/to/deployment && docker compose run --rm astound-invoice-bot
```

An AI assistant can invoke the same `bun run dry-run` and `bun start` commands, or
the equivalent one-shot container commands. Do not expose the credentials in its
prompt or logs.

GitHub-hosted scheduled Actions are not the default deployment: their filesystems
are ephemeral, so safely preserving SQLite state requires an additional durable
store. CI does build and publish multi-architecture images after tests pass.

## State and recovery

- Back up the file configured by `SQLITE_DB_PATH`. Deleting it causes all visible
  invoices to be eligible for delivery again.
- A SQLite run lock prevents overlapping cron, Docker, or agent invocations. A
  crashed run can be retried after `RUN_LOCK_TTL_SECONDS` (one hour by default).
- Paths are recorded only after SMTP accepts their email batch. A network failure
  after SMTP acceptance but before the SQLite write can still produce a duplicate;
  deterministic message IDs make that case easier for mail systems to deduplicate.
- The deterministic message-ID namespace is stored in SQLite. Recreating the
  database creates a new namespace, allowing an intentional replay to be delivered.
- If a run reports an unrecognized Astound page, use `bun run smoke`. Update the
  parser fixtures and selectors rather than treating the page as an empty account.

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun audit
docker build -t astound-invoice-bot:local .
```

Tests use sanitized HTML/PDF fixtures, a local fake portal, and a local SMTP sink;
they do not contact Astound or an external mail server. `bun run smoke` is the only
opt-in live portal check.
