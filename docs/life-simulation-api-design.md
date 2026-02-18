# Life Simulation API Design (Frontend-First)

## Analysis

The current API surface provides synchronous decision evaluation and basic persona simulation,
but there is no job-based, progressive-disclosure model for long-running, multi-path life
simulation. The system already has a TaskQueue and an EventBus + WebSocket plugin, which are
the right primitives for async workflows and incremental delivery of partial results. The
design below aligns with tenant isolation (X-Tenant-Id), JSON storage for complex payloads,
and existing event subscription patterns.

## Architecture Decision

- Job-based simulation: POST creates a TaskQueue job and returns 202 with a simulation id.
- Progressive disclosure: summary -> path detail -> branch detail -> retrospective.
- Partial persistence: write summary + per-path partials as they complete, allow polling.
- Streaming: emit WebSocket events per path/year to support incremental UI updates.
- JSON storage: keep nested, evolving result structures in TEXT columns with JSON payloads.

## Implementation Plan

1. Add SQLite tables for life simulations, per-path results, and event history.
2. Add Zod schemas for request/response validation.
3. Add routes:
   - POST /api/v1/simulations/life (async creation, 202)
   - GET /api/v1/simulations/:id (status + summary)
   - GET /api/v1/simulations/:id/paths/:pathId (path timeline + branches)
   - POST /api/v1/simulations/:id/stress-test (variant job)
   - POST /api/v1/simulations/:id/cancel (optional but recommended for long jobs)
4. Add EventBus event types and WebSocket event formats:
   - life:simulation-progress
   - life:path-year-complete
   - life:simulation-completed
   - life:simulation-failed
   - life:simulation-cancelled
5. Document endpoints in docs.ts and add API doc entries.

## Request/Response Schemas (Summary)

### POST /api/v1/simulations/life (202 Accepted)

Request
```json
{
  "personaId": "per_123",
  "paths": [
    { "id": "stable", "label": "Stable", "params": { "riskBias": 0.2 } },
    { "id": "half_startup", "label": "Half Startup", "params": { "riskBias": 0.5 } },
    { "id": "full_startup", "label": "Full Startup", "params": { "riskBias": 0.8 } }
  ],
  "horizonYears": 10,
  "includeRetrospective": true,
  "includeStressTest": false,
  "notes": "optional free-form context"
}
```

Response (202)
```json
{
  "data": {
    "simulationId": "sim_abc",
    "taskId": "task_xyz",
    "status": "pending",
    "createdAt": 1710000000000,
    "links": {
      "self": "/api/v1/simulations/sim_abc",
      "events": "/ws"
    }
  }
}
```

### GET /api/v1/simulations/:id

Response (running, partial summary)
```json
{
  "data": {
    "simulationId": "sim_abc",
    "status": "running",
    "progress": { "percent": 45, "pathsComplete": 1, "yearsComplete": 4 },
    "summary": {
      "recommendedPathId": "stable",
      "paths": [
        {
          "pathId": "stable",
          "label": "Stable",
          "composite": 0.72,
          "wealthDelta": 0.18,
          "creationFulfillment": 0.54,
          "regretProbability": 0.22,
          "familyStability": 0.81
        }
      ]
    },
    "links": {
      "path": "/api/v1/simulations/sim_abc/paths/stable"
    }
  }
}
```

### GET /api/v1/simulations/:id/paths/:pathId

Response (complete)
```json
{
  "data": {
    "simulationId": "sim_abc",
    "pathId": "stable",
    "label": "Stable",
    "timeline": [
      {
        "year": 1,
        "wealth": 320000,
        "creationFulfillment": 0.42,
        "regretProbability": 0.25,
        "emotional": { "valence": 0.3, "stress": 0.6, "confidence": 0.7 },
        "family": {
          "spouseSecurity": 0.8,
          "childCost": 0,
          "healthIndex": 0.9,
          "confidence": 0.6
        },
        "overallScore": 0.68
      }
    ],
    "branches": [
      { "label": "success", "probability": 0.35, "overallScoreRange": [0.7, 0.85] },
      { "label": "neutral", "probability": 0.45, "overallScoreRange": [0.55, 0.7] },
      { "label": "worst", "probability": 0.2, "overallScoreRange": [0.35, 0.55] }
    ],
    "retrospective": {
      "summary": "Narrative text",
      "confidence": 0.62
    }
  }
}
```

### POST /api/v1/simulations/:id/stress-test

Request
```json
{
  "variantLabel": "worst_case",
  "overrides": {
    "healthShock": true,
    "marketDownturn": true,
    "relationshipStress": 0.8
  }
}
```

Response (202)
```json
{
  "data": {
    "simulationId": "sim_abc",
    "variantId": "sim_def",
    "taskId": "task_ghi",
    "status": "pending"
  }
}
```

## Zod Validation Schemas (Pseudo-code)

```ts
export const LifeSimulationPathSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const CreateLifeSimulationSchema = z.object({
  personaId: z.string().min(1),
  paths: z.array(LifeSimulationPathSchema).min(2).max(5),
  horizonYears: z.number().int().min(1).max(60).default(10),
  includeRetrospective: z.boolean().default(true),
  includeStressTest: z.boolean().default(false),
  notes: z.string().optional(),
});

export const StressTestSchema = z.object({
  variantLabel: z.string().min(1),
  overrides: z.record(z.string(), z.unknown()).default({}),
});
```

## Route Handlers (Pseudo-code)

```ts
// POST /api/v1/simulations/life
const body = CreateLifeSimulationSchema.parse(request.body);
const simulationId = generatePrefixedId('sim');
const taskId = queue.enqueue(request.tenantId, 'life_simulation', {
  simulationId,
  tenantId: request.tenantId,
  personaId: body.personaId,
  paths: body.paths,
  horizonYears: body.horizonYears,
  includeRetrospective: body.includeRetrospective,
  includeStressTest: body.includeStressTest,
  notes: body.notes,
});
store.insertSimulation({
  id: simulationId,
  tenantId: request.tenantId,
  status: 'pending',
  taskId,
  configJson: JSON.stringify(body),
});
return reply.code(202).send({ data: { simulationId, taskId, status: 'pending' } });
```

```ts
// GET /api/v1/simulations/:id
const sim = store.getSimulation(request.params.id);
assertTenant(sim, request.tenantId);
return { data: buildSummaryResponse(sim) };
```

```ts
// GET /api/v1/simulations/:id/paths/:pathId
const path = store.getPath(request.params.id, request.params.pathId);
assertTenant(path, request.tenantId);
return { data: buildPathResponse(path) };
```

```ts
// POST /api/v1/simulations/:id/stress-test
const base = store.getSimulation(request.params.id);
assertTenant(base, request.tenantId);
const body = StressTestSchema.parse(request.body);
const variantId = generatePrefixedId('sim');
const taskId = queue.enqueue(request.tenantId, 'life_simulation_stress', {
  baseSimulationId: base.id,
  variantId,
  overrides: body.overrides,
});
store.insertSimulationVariant({ id: variantId, baseId: base.id, status: 'pending', taskId });
return reply.code(202).send({ data: { simulationId: base.id, variantId, taskId, status: 'pending' } });
```

```ts
// POST /api/v1/simulations/:id/cancel
const sim = store.getSimulation(request.params.id);
assertTenant(sim, request.tenantId);
queue.cancel(sim.taskId); // optional helper
store.updateSimulationStatus(sim.id, 'cancelled');
os.bus.emit('life:simulation-cancelled', { simulationId: sim.id });
return { data: { simulationId: sim.id, status: 'cancelled' } };
```

## WebSocket Event Formats

Events are emitted on the EventBus and delivered via /ws with the existing
subscribe/unsubscribe protocol.

```json
{ "type": "event", "event": "life:simulation-progress",
  "data": { "simulationId": "sim_abc", "percent": 35, "stage": "path:stable/year:4" } }
```

```json
{ "type": "event", "event": "life:path-year-complete",
  "data": {
    "simulationId": "sim_abc",
    "pathId": "stable",
    "year": 4,
    "partialSummary": { "overallScore": 0.67, "regretProbability": 0.24 }
  } }
```

```json
{ "type": "event", "event": "life:simulation-completed",
  "data": { "simulationId": "sim_abc", "completedAt": 1710000000000 } }
```

```json
{ "type": "event", "event": "life:simulation-failed",
  "data": { "simulationId": "sim_abc", "error": "message" } }
```

## SQLite Schema (JSON Storage)

```sql
CREATE TABLE IF NOT EXISTS life_simulations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  task_id TEXT NOT NULL,
  base_simulation_id TEXT REFERENCES life_simulations(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL,
  summary_json TEXT,
  progress_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_life_simulations_tenant_created
  ON life_simulations(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS life_simulation_paths (
  id TEXT PRIMARY KEY,
  simulation_id TEXT NOT NULL REFERENCES life_simulations(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  summary_json TEXT,
  timeline_json TEXT,
  branches_json TEXT,
  retrospective_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_life_simulation_paths_sim
  ON life_simulation_paths(simulation_id);

CREATE TABLE IF NOT EXISTS life_simulation_events (
  id TEXT PRIMARY KEY,
  simulation_id TEXT NOT NULL REFERENCES life_simulations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_life_simulation_events_sim
  ON life_simulation_events(simulation_id, created_at);
```

## Considerations

- Progressive disclosure avoids returning heavy timeline payloads on initial polling.
- Partial persistence enables resume/retry and improves debuggability.
- WebSocket events should be idempotent and include simulationId/pathId/year.
- Align response shapes with UI needs (summary cards vs. detail views).
- Keep branch probabilities normalized per path to prevent UI misinterpretation.
