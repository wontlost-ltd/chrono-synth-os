# ChronoSynth OS — Quickstart

Get a working ChronoSynth OS — with a seeded digital-employee organization — running in a few minutes.

## What is this?

ChronoSynth OS is the **governance layer for production AI agents**: per-tool permissions, immutable audit, and behavioral drift detection — built on a **zero-LLM deterministic kernel** (the persona/decision core runs without calling an LLM at runtime; LLMs are used only as distillable *teachers*, never in the hot path).

> Two products share one kernel — **ChronoSynth** (Enterprise, GA in progress) and **ChronoCompanion** (Consumer, roadmap). See [ADR-0046](docs/adr/0046-dual-product-companion.md).

## Option A — One-command full stack (recommended)

Requires `podman` or `docker`.

```bash
# dev mode: SQLite, fastest to boot
bash deploy/digital-org/deploy.sh

# (or) prod-like mode: PostgreSQL + queue worker
bash deploy/digital-org/deploy.sh prod
```

This builds the image, starts the backend (auto-runs all migrations), and seeds a digital-employee organization. Then verify and drive it over HTTP:

```bash
# 1. health
curl http://localhost:3000/healthz          # -> {"status":"ok",...}

# 2. register an admin (JWT is enabled by default in this stack)
TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"password123"}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')

# 3. create a digital-employee org — the root worker is born with its own
#    per-persona cognitive core (archetype: explorer | guardian | analyst | doer)
curl -s -X POST http://localhost:3000/api/v1/workforce/orgs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"orgId":"my-org","roleCode":"ceo","title":"CEO","displayName":"My CEO","archetype":"explorer"}'

# 4. talk to a companion persona — fully deterministic, zero-LLM at runtime
curl -s -X POST http://localhost:3000/api/v1/companion/me/chat \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"message":"hello, introduce yourself"}'
```

Tear down with `podman compose -f deploy/digital-org/podman-compose.yml down -v`.

## Option B — Build & test from source

Requires **Node.js ≥ 24** (see `.nvmrc`).

```bash
npm ci
npm run build
npm run test:golden    # full quality gate
node dist/main.js      # start the server on :3000 (set CHRONO_* env to configure)
```

> On macOS use `npm ci` (not `npm install`) — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Option C — Embed the kernel (MIT)

The persona/decision kernel is a standalone MIT-licensed library — embed it without the server:

```ts
import { ChronoSynthOS } from '@chrono/kernel';

const os = new ChronoSynthOS();
os.core.addValue('accuracy', 0.8);   // define a core value
// ... add memories, run deterministic decisions/simulations
```

## Where to next

- **API reference** — [`docs/api.md`](docs/api.md)
- **Architecture** (three-layer persona engine, zero-LLM thesis) — [`docs/architecture.md`](docs/architecture.md)
- **Decision records** — [`docs/adr/README.md`](docs/adr/README.md)
- **Production deployment** — the `chrono-synth-deploy` repo (Helm/Kyverno/NetworkPolicy)
- **Contributing** — [`CONTRIBUTING.md`](CONTRIBUTING.md)
