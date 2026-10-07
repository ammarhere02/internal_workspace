# Management service: folder map

Each domain folder follows the same four-file pattern: `*.module.ts` (wiring/exports), `*.controller.ts` (HTTP routes), `*.service.ts` (rules + transactions + events), `*.repository.ts` (Mongo queries + indexes). `dto/` holds validated request shapes.

| Folder | Collections owned | Depends on |
| --- | --- | --- |
| identity/ | workspaces, users | — (global) |
| teams/ | teams, team_memberships | identity |
| projects/ | projects, boards | teams, identity |
| boards/ | work_items, issue_sequences | projects, teams, identity |
| messaging/ | outbox; NATS connection, TEAM_EVENTS bootstrap | — (global) |
| infra/mongo/ | MongoClient, transactions, validators | — (global) |
| common/ | ids, request context, errors, pagination | — |
| health/ | /health/live, /health/ready | mongo, messaging |

Request path for a command: controller (DTO validated) → service (rules, `withTransaction`) → repository (conditional update on `version`) + `OutboxService.append` → commit → response. The relay (phase 4) later publishes outbox rows.
