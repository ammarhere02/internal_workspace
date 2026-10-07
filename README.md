# Team Management Platform — event-driven microservices

NestJS (commands, REST/BFF, AdminLTE) + Python 3.12 (activity & workload projections) + NATS JetStream + MongoDB Atlas.

Status: **phases 1–7 complete** (architecture, contracts, infrastructure, NestJS domain + HTTP API, outbox relay → JetStream → Python inbox/projections, insight/activity queries over NATS request/reply, replay, AdminLTE UI). API reference: `docs/api.md`; UI guide: `docs/ui.md`. See `phases.md` for progress and `docs/verification-report.md` for what was actually run.

## Layout

```
contracts/            shared JSON Schemas (envelope, per-event payloads, query contracts) + example fixtures
services/management/  NestJS Management Service (owns management_db, outbox, TEAM_EVENTS bootstrap)
services/insights/    Python Activity & Insights Service (owns insights_db, durable consumer, insight queries)
docker-compose.yml    NATS with JetStream (file storage, persistent volume) + both services
docs/                 assignment, checklist, architecture, decisions, event catalogue, verification report
```

## Prerequisites

- Node.js 22, Python 3.12, Docker Desktop
- A MongoDB Atlas **Free (M0)** cluster. Verified: MongoDB 8.0 replica set, multi-document transactions work.

## Atlas setup (one time)

1. Create the free cluster.
2. **Database Access → Database Users.** Recommended two users, one per service, each with `readWrite` on its own database only:
   - `management_user` → `readWrite@management_db`
   - `insights_user` → `readWrite@insights_db`
   Development today uses one auto-generated user; the service code still never touches the other database (see decisions.md D-07).
3. **Network Access → IP Access List.** Add your current public IP only. Docker containers on the same machine share that IP. Update it when your IP changes; do not use `0.0.0.0/0`.
4. TLS is enforced by `mongodb+srv://` automatically.
5. Databases `management_db` and `insights_db` are created on first write. Indexes are created by each service at startup (phase 3/5).

## Configure

```bash
cp services/management/.env.example services/management/.env
cp services/insights/.env.example   services/insights/.env
# edit MONGODB_URI in both (never commit .env; it is git-ignored)
```

## Run locally

```bash
docker compose up -d nats                       # NATS 2.15 with JetStream, data in volume nats-data
cd services/management && npm ci && npm run build && npm run start:dev    # http://localhost:3100
cd services/insights && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python -m app.main   # http://localhost:8001
```

Or everything in Docker: `docker compose up --build` (services read `.env` files; Compose overrides `NATS_URL`).

UI: open `http://localhost:3100/` (AdminLTE dashboard, teams, projects, Kanban, activity, insights). See `docs/ui.md`.

Sign-in: by default (`AUTH_MODE=dev`) the header's "act as" switcher picks a seeded user. With `AUTH_MODE=google` users sign in with Google (Passport); admins (`ADMIN_EMAILS`) land on the dashboard, everyone else on My Work with the boards of their teams. Setup in `docs/auth.md`.

Health:

| Service | Liveness | Readiness | Consumer state |
| --- | --- | --- | --- |
| management | `GET :3100/health/live` | `GET :3100/health/ready` (Atlas + NATS) | `GET :3100/health/relay` (outbox backlog, exhausted rows, leader) |
| insights | `GET :8001/health/live` | `GET :8001/health/ready` (Atlas + NATS) | `GET :8001/health/consumer` |

NATS monitoring: `http://localhost:8222/jsz?streams=true&consumers=true&config=true`.

## Tests

```bash
npm --prefix services/management test            # unit: contracts, rank algorithm, relay, insights mapping, UI freshness rules
npm --prefix services/management run test:e2e    # request tests against REAL Atlas in an isolated per-run workspace (self-cleaning)
cd services/insights && .venv/bin/python -m pytest -q    # unit + REAL-NATS integration (needs nats up and management built)
```

Integration tests use their own stream `TEAM_EVENTS_INTEROP` and delete it afterwards; they never touch `TEAM_EVENTS` or Atlas.

Run the NestJS request tests with the dev server **stopped**: a running relay would publish the test workspace's outbox rows and the relay/insights suites would see a foreign leader or a live responder.

Live end-to-end acceptance run (Compose stack up, management started locally in dev-identity mode so the script can act as an admin):

```bash
docker compose stop management && cd services/management && npm run build
AUTH_MODE=dev PORT=3101 node dist/main.js > /tmp/mgmt.log 2>&1 &
BASE=http://localhost:3101 MGMT_LOG=/tmp/mgmt.log PY_DIR=$PWD/../insights node scripts/e2e-acceptance.mjs   # stops/starts the Python container, replays, traces one correlation id
```

Rejection-condition audit (secrets, collection ownership, durable publish, ack-after-commit, API-backed Kanban, runnable docs): `./scripts/audit.sh`.

Browser walkthrough (optional, needs Chromium via Playwright): `services/management/scripts/ui-walkthrough.mjs` drives every mandatory journey and failure path against the live stack; see its header.

## Resetting demo data

`services/management/scripts/prune-demo-data.mjs` removes generated demo/test data and keeps a curated set; `services/insights` has the matching `python -m app.prune`. Both are dry runs unless `--apply` is given, and the apply step writes a jsonl backup of every document it deletes.

```bash
docker compose stop management insights
cd services/management && node scripts/prune-demo-data.mjs --keep-projects PAY,PH5,SH --out /tmp/prune            # dry run: counts only
node scripts/prune-demo-data.mjs --keep-projects PAY,PH5,SH --out /tmp/prune --apply                              # backs up, then deletes
cd ../insights && .venv/bin/python -m app.prune --keep /tmp/prune/keep.json --apply --backup /tmp/prune/backup    # projections of the same entities
docker compose up -d management insights
```

The event stream keeps its events until retention (7 days, D-08), so a later full replay would recreate deleted entities; repair kept projects with `python -m app.replay --set _fix` then `--adopt <projectIds>` then `--drop`. Request tests now clean up after themselves: every test file gets its own workspace and `test/global-teardown.ts` removes only the run's workspaces.

## Rebuilding the projection (replay)

```bash
cd services/insights
.venv/bin/python -m app.replay --set _rebuild_$(date +%Y%m%d) --compare   # builds a clean set next to the live one, prints a report
# activate: restart with PROJECTION_SET=_rebuild_YYYYMMDD CONSUMER_NAME=activity-insights_rebuild_YYYYMMDD
```
Details, limits and rollback: `docs/replay.md`.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `MongoServerSelectionError … tlsv1 alert internal error` at startup | your public IP is not on the Atlas IP Access List (it changes daily on many ISPs) | Atlas → Network Access → Add Current IP Address, wait for Active |
| `TimeoutError: timeout` from `@nats-io` at startup | NATS not running (Docker Desktop paused or stopped) | unpause Docker, `docker compose up -d nats` |
| `EADDRINUSE :::3100` | another process on the port | change `PORT` in `.env` |

## Documents

- `docs/architecture.md` — ownership, topology, trust boundaries, one request traced end to end
- `docs/decisions.md` — decision record (D-01…)
- `docs/events.md` — event catalogue
- `docs/verification-report.md` — commands run and results
- `docs/assignment-checklist.md` — requirement tracker
- `docs/deploy-railway.md` — deploying the three services (NATS, NestJS, Python) to Railway
- `docs/auth.md` — Google sign-in (Passport), ADMIN/EMPLOYEE roles, redirection and scoping
- `docs/ui.md` — AdminLTE UI: screens, Kanban rules, freshness states, a move through success/conflict/failure/delay
- `docs/screenshots/phase6/` — headless-browser screenshots from the walkthrough
