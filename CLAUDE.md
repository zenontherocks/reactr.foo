# reactr.foo — Claude Code Context

## What This Is
A pseudonymous, multi-account Nostr client. The frontend (`src/client/`, vanilla TS + Vite, no framework) connects directly from the browser to Nostr relays via `nostr-tools` for everything account-related: following/global feeds, notifications, NIP-04 DMs, search, profiles, composing notes/replies/reposts/reactions, NIP-57 zaps, and a relay-native "reactions leaderboard" (notes ranked by an emoji-weighted score, computed client-side from live kind-7 events). Identity (generated or imported nsec, or a NIP-07 extension) lives entirely in the browser's `localStorage` — the server never generates, receives, or stores any key or user-identifying data.

The backend (`src/worker.ts`) has two jobs: serve the static app, and run its own optional Nostr relay (`wss://reactr.foo`, full NIP-01 over D1) that's backfilled from public relays every 5 minutes by a cron job ("the haunting"). That relay is included by default in the client's relay list (editable per-browser in Settings) so people benefit from the historical backfill, but it's plain relay protocol — the client would work identically pointed at any other relay.

## Stack
- **Frontend**: TypeScript + Vite (`src/client/`), bundled and served via the Worker; talks directly to relays via `nostr-tools` (`pool.ts`)
- **Backend**: Cloudflare Worker (`src/worker.ts`) — serves the static app, a small `/api/*` surface (below), and its own Nostr relay over WebSocket
- **Database**: Cloudflare D1 (`reactr-foo`, id: `debbffbe-0fae-4cdc-aee5-67e8c39ff823`) — backs the Worker's own relay and the emoji-weight config; never stores any user identity/key material
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
- `GET  /api/config` — fetch emoji-weight config (site-wide, used to seed the leaderboard's scoring weights and the cron crawler's relay list)
- `POST /api/config` — save config
- `GET  /api/lnurl?url=` — CORS proxy for LNURL-pay endpoints (zaps)
- `GET  /api/og?url=` — OpenGraph metadata proxy
- WebSocket upgrade on any path — the Worker's own NIP-01 relay (`handleRelay`/`onReq`/`onEvent` in `worker.ts`, backed by D1)

All other non-asset paths return 404. Everything else (feeds, notifications, DMs, search, profiles, zaps, the reactions leaderboard, posting/reacting) happens client-side via direct relay connections — there's no REST API for reading or writing Nostr data.

## Accounts
Multi-account, client-only, implemented in `src/client/auth.ts`:
- On first visit (empty `localStorage`), a pseudonymous keypair is generated automatically and made active — no signup step.
- Users can add more identities: generate another pseudonymous account, import an existing nsec, or connect a NIP-07 browser extension — and switch between them.
- All accounts (npub, method, and — for generated/imported accounts — the plaintext hex private key) live in `localStorage` under `reactr_accounts`. This is never sent to the server. Losing `localStorage` permanently loses any account that wasn't exported via the "Export nsec" affordance in the account switcher.
- Relay selection is also per-browser (`localStorage` key `reactr_relays`, editable in Settings), separate from the site-wide `/api/config` used for emoji weights.

## Claude Workflow

After completing any task, Claude should:
1. Commit changes with a clear message
2. Merge into `main` immediately (via push or PR merge)
3. **Do not leave changes sitting on feature branches**

> Unless explicitly told otherwise, auto-merge to `main` is the preferred workflow.
> Note: merging to `main` triggers a production deploy (see Deployment above).
