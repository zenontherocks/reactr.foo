# reactr.foo — Claude Code Context

## What This Is
A Cloudflare Worker + D1 database app that tracks Nostr reactions (kind-7 events) in real time. The frontend is a vanilla TS client bundled with Vite; the backend is a Worker serving a JSON API. Everything is hosted on Cloudflare.

## Stack
- **Frontend**: TypeScript + Vite (`src/client/`), bundled and served via the Worker
- **Backend**: Cloudflare Worker (`src/worker.ts`), handles `/api/*` routes
- **Database**: Cloudflare D1 (`reactr-foo`, id: `debbffbe-0fae-4cdc-aee5-67e8c39ff823`)
- **Domain**: `reactr.foo`, active zone on Cloudflare

## Deployment
Merging to `main` triggers the GitHub Actions workflow (`.github/workflows/deploy.yml`), which:
1. Builds with Vite
2. Deploys the Worker via `wrangler deploy`
3. Applies D1 migrations via `wrangler d1 migrations apply reactr-foo --remote`

### Required GitHub Secrets
- `CLOUDFLARE_API_TOKEN` — a **user-level** API token (Profile → API Tokens, NOT Manage Account → Account API Tokens)

### Required API Token Permissions
The token must have all of the following:
- `Workers Scripts: Edit`
- `Workers Routes: Edit`
- `D1: Edit` ← easy to miss; the "Edit Cloudflare Workers" template does NOT include this

### Account ID
`bfa7ab5ab9d8079599d35435e885f010` — hardcoded in the workflow.

## DNS Setup
`reactr.foo` has one DNS record:
- Type: `A`, Name: `@`, Value: `192.0.2.1`, **Proxied (orange cloud ON)**

The IP is a dummy placeholder. The Worker intercepts all requests at the Cloudflare edge before they reach any origin, so the actual IP doesn't matter. The orange cloud (proxy) is essential — without it the Worker route won't work.

## Local Development
```bash
npm install
npm run dev          # Vite dev server with local Worker
npm run db:migrate:local  # Apply migrations to local D1
```

## Database Migrations
Migrations live in `migrations/`. To apply to production manually:
```bash
npx wrangler d1 migrations apply reactr-foo --remote
```

## Worker Routes
The Worker handles:
- `GET  /api/config` — fetch relay + emoji config
- `POST /api/config` — save relay + emoji config
- `GET  /api/reactions` — all logged reactions (newest first, limit 5000)
- `POST /api/reactions` — log a single reaction
- `GET  /api/reactions/by-note` — reaction counts aggregated by note + emoji

All other paths return 404.
