# AGENTS.md

Conventions and boundaries for anyone, human or AI agent, working in this repo.
Claude Code reads this through `CLAUDE.md`; Cursor reads it directly. Keep it current.

## What this repo is

CandyHouse is a microservices e-commerce app in a single repo. Four deployable units:

- `user-service` (Express, port 4000 locally) — auth, users, JWT. Owns the `candyhouse-users` database.
- `product-service` (Express, port 4001 locally) — product catalog, inventory, image upload. Owns `candyhouse-products`. Uses Redis for caching.
- `order-service` (Express, port 4002 locally) — cart checkout, orders, payments. Owns `candyhouse-orders`. Talks to Stripe.
- `store-ui` (Next.js, port 3000 locally) — the frontend.

Services communicate by Kafka events (topics `user`, `candy`, `quantity`) and HTTP. Deployment is Helm onto Kubernetes, with per-service Docker images.

## Hard boundaries (do not cross)

1. **Each service owns its own database.** A service never reads or writes another service's MongoDB collections. The copies you see (for example `order-service` has a `Candy` model) are local read replicas kept in sync over Kafka, not a license to reach into another service's data.
2. **Cross-service data flows only through Kafka events or HTTP calls.** Do not add a direct database connection from one service to another's database.
3. **Money and stock changes go through a transaction plus the outbox.** Order creation and stock changes must be atomic within the service and must not depend on a fire-and-forget `producer.send` after the fact. If you are changing checkout, preserve this. (See the hardening guide for the reasoning.)
4. **Never commit secrets.** Real keys live in `.env` files, which are gitignored. Do not inline keys, and do not un-ignore env files.

## How to run it locally

Fastest: the whole stack in containers, one command (infra, Kafka topics, and the four services):

```bash
docker compose -f development/docker-compose.full.yml up --build
```

Host ports 3000 and 6379 are often taken; override with `UI_PORT=3001 REDIS_PORT=6380`. Stripe and Cloudinary
values are optional (see the header of `development/docker-compose.full.yml`). The compose file creates the Kafka
topics (`user`, `candy`, `quantity`) itself; if you start infra another way, create them before the services boot.

To run services natively instead:

Infrastructure (MongoDB, Redis, Kafka) runs in Docker; the services run natively.

```bash
docker-compose -f development/docker-compose.dev.yml up -d
cd <service> && yarn install && yarn dev
```

Ports the frontend expects: user `4000`, product `4001`, order `4002`, ui `3000`. Set each service's `PORT` to match.

Env files, by service (note they differ):

- `user-service` loads a plain `.env` (needs `PORT`, `MONGO_URI`, `JWT_SECRET`, `KAFKA_URL`).
- `product-service` and `order-service` load `.env.development.local`.
- `store-ui` uses `.env.local` (Next.js).

`order-service` uses multi-document transactions, so `MONGO_URI` must point at a replica set (the dev compose runs a single-node `rs0`; use `?replicaSet=rs0`). A standalone Mongo fails with "Transaction numbers are only allowed on a replica set member".

Known rough edges: the Kafka broker address is hardcoded to `candyhouse-kafka:9092` in each backend service's `lib/kafka.ts`, so native local runs need that mapped to localhost (or the string changed). `order-service` and the others connect to Kafka at boot in `server.ts`.

## Testing

- `product-service` and `order-service` use Jest (`yarn test`).
- For anything involving transactions, use `mongodb-memory-server` started as a replica set (`MongoMemoryReplSet`); a standalone Mongo cannot run transactions.
- Mock Stripe in tests; never hit the network.
- Test controllers and routes with `supertest`. Do **not** import `server.ts` in a test, because it connects to Kafka at boot and will hang.

## Tooling and quality gates

- TypeScript everywhere. `yarn tsc --noEmit` must pass in any service you touch.
- `product-service`, `order-service`, `store-ui` have lint; run `yarn lint`.
- CI runs type-check, lint, and test on the changed service(s) for every PR. Keep it green.

## How to work (branch and PR, always)

- **Never commit to `main`.** Create a branch: `fix/...`, `feat/...`, or `chore/...`.
- Make one logical change per branch. Small PRs review faster and revert cleanly.
- When the change is ready, open a pull request and stop. A human reviews and merges. Do not merge your own PR.
- Before calling a task done, run `yarn tsc --noEmit`, `yarn lint`, and `yarn test` in each service you changed, and show the output.
- Explain what changed and why in the PR description. Do not ship code the author cannot explain.
