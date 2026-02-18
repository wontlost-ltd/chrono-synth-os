# ChronoSynth OS SPA Implementation Plan (React + Vite)

This document is a step-by-step plan with pseudo-code. It does not modify any files.

## Step 1: Create `web/` directory structure

Exact file tree (proposed):

```
web/
  index.html
  package.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  tailwind.config.ts
  postcss.config.js
  public/
    favicon.svg
  src/
    main.tsx
    app.tsx
    routes.tsx
    api/
      chronoClient.ts
      queryClient.ts
      queries/
        simulations.ts
        visualization.ts
        values.ts
        pos.ts
    components/
      layout/
        AppShell.tsx
        AppHeader.tsx
        AppNav.tsx
      charts/
        TimeSeriesChart.tsx
        SankeyGraph.tsx
        MilestonesTimeline.tsx
      ui/
        Button.tsx
        Card.tsx
        EmptyState.tsx
        LoadingState.tsx
        ErrorState.tsx
    pages/
      Dashboard.tsx
      SimulationWizard.tsx
      PathComparison.tsx
      BranchExplorer.tsx
      StressTest.tsx
      Milestones.tsx
      ValuesManager.tsx
      SystemStatus.tsx
    state/
      sessionStore.ts
    hooks/
      useSimulationId.ts
    styles/
      globals.css
    types/
      visualization.ts
    utils/
      format.ts
```

## Step 2: Vite configuration (dev proxy + build output)

File: `web/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@sdk': path.resolve(__dirname, '../src/sdk'),
    },
  },
});
```

Notes:
- `web/dist` is the build output. A later step copies to `dist/public`.
- The `@sdk` alias allows importing `../src/sdk/chrono-client.ts`.

## Step 3: Tailwind setup + Chinese font stack

File: `web/tailwind.config.ts`

```ts
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Noto Sans SC',
          'PingFang SC',
          'Microsoft YaHei',
          'Source Han Sans SC',
          'WenQuanYi Micro Hei',
          'system-ui',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
} satisfies Config;
```

File: `web/src/styles/globals.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: theme('fontFamily.sans');
}
```

## Step 4: React entry + app shell

File: `web/src/main.tsx`

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { queryClient } from './api/queryClient';
import { router } from './routes';
import './styles/globals.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

File: `web/src/app.tsx`

```tsx
import { Outlet } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';

export function App() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
```

## Step 5: Router definition (SPA at `/`)

File: `web/src/routes.tsx`

```tsx
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { App } from './app';
import { Dashboard } from './pages/Dashboard';
import { SimulationWizard } from './pages/SimulationWizard';
import { PathComparison } from './pages/PathComparison';
import { BranchExplorer } from './pages/BranchExplorer';
import { StressTest } from './pages/StressTest';
import { Milestones } from './pages/Milestones';
import { ValuesManager } from './pages/ValuesManager';
import { SystemStatus } from './pages/SystemStatus';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'simulations/new', element: <SimulationWizard /> },
      { path: 'simulations/:id/paths', element: <PathComparison /> },
      { path: 'simulations/:id/branches', element: <BranchExplorer /> },
      { path: 'simulations/:id/stress', element: <StressTest /> },
      { path: 'simulations/:id/milestones', element: <Milestones /> },
      { path: 'values', element: <ValuesManager /> },
      { path: 'system', element: <SystemStatus /> },
    ],
  },
]);
```

## Step 6: TanStack Query + ChronoClient integration

File: `web/src/state/sessionStore.ts`

```ts
type SessionState = {
  apiKey?: string;
  tenantId?: string;
  mode: 'demo' | 'subscription';
};

// Minimal store for session; can be replaced by Zustand later.
export const sessionStore = {
  get(): SessionState { /* read from localStorage */ },
  set(next: SessionState): void { /* write to localStorage */ },
};
```

File: `web/src/api/chronoClient.ts`

```ts
import { ChronoClient } from '@sdk/chrono-client';
import { sessionStore } from '../state/sessionStore';

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';

export function createChronoClient() {
  const session = sessionStore.get();
  return new ChronoClient({
    baseUrl,
    apiKey: session.apiKey,
  });
}
```

File: `web/src/api/queryClient.ts`

```ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
```

File: `web/src/api/queries/visualization.ts`

```ts
import { useQuery, useMutation } from '@tanstack/react-query';
import { createChronoClient } from '../chronoClient';

export function useOverview(simId: string) {
  return useQuery({
    queryKey: ['overview', simId],
    queryFn: async () => {
      const client = createChronoClient();
      return client.request('GET', `/api/v1/simulations/${simId}/visualization/overview`);
    },
    enabled: !!simId,
  });
}

// Repeat for paths, branches, stress, milestones.
```

Note: `ChronoClient` does not currently expose visualization methods, so either:
- call `client.request` directly (as above), or
- extend SDK with visualization methods in a follow-up.

## Step 7: Component hierarchy per page

Dashboard (`web/src/pages/Dashboard.tsx`)
- `SimulationSummaryCard`
- `RecommendedPathCard`
- `PathScoreTable`
- `RetrospectivePanel`
- `RecentRunsPanel`

PathComparison (`web/src/pages/PathComparison.tsx`)
- `MetricSelector`
- `ResolutionToggle`
- `TimeSeriesChart` (Recharts)
- `PathStatsTable`

BranchExplorer (`web/src/pages/BranchExplorer.tsx`)
- `PathSelector`
- `SankeyGraph` (d3-sankey)
- `BranchDetailsPanel`

StressTest (`web/src/pages/StressTest.tsx`)
- `StressSummaryCard`
- `DeltaComparisonChart`

Milestones (`web/src/pages/Milestones.tsx`)
- `MetricSelector`
- `MilestonesTimeline`
- `SnapshotDrawer`

SimulationWizard (`web/src/pages/SimulationWizard.tsx`)
- `StepNavigator`
- `PathBuilderForm`
- `HorizonAgeForm`
- `SubmitButton`
- `RunStatusPanel`

ValuesManager (`web/src/pages/ValuesManager.tsx`)
- `ValuesTable`
- `ValueForm`

SystemStatus (`web/src/pages/SystemStatus.tsx`)
- `PersonaStateCard`
- `StateSummaryPanel`
- `DecisionStylePanel`

## Step 8: Fastify static hosting + auth exemption

Add `@fastify/static` dependency at root.

File: `src/server/app.ts` (pseudo-code snippet)

```ts
import fastifyStatic from '@fastify/static';
import path from 'node:path';

// After plugins, before routes:
await app.register(fastifyStatic, {
  root: path.resolve(process.cwd(), 'dist/public'),
  prefix: '/',
  list: false,
});

// SPA fallback for non-API routes:
app.setNotFoundHandler((req, reply) => {
  if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
    return reply.sendFile('index.html');
  }
  reply.status(404).send({ error: 'NotFound', message: 'Route not found' });
});
```

File: `src/server/plugins/auth.ts` (pseudo-code snippet)

```ts
function isPublicPath(url: string): boolean {
  if (!url.startsWith('/api') && !url.startsWith('/ws')) return true;
  return url === '/healthz' || url.startsWith('/healthz');
}
```

## Step 9: Build pipeline + copy step

Root `package.json` scripts (pseudo-code)

```json
{
  "scripts": {
    "web:dev": "npm --prefix web run dev",
    "web:build": "npm --prefix web run build",
    "build:all": "npm run build && npm run web:build && node scripts/copy-web-dist.mjs"
  }
}
```

File: `scripts/copy-web-dist.mjs`

```js
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('web/dist');
const dest = path.resolve('dist/public');

fs.mkdirSync(dest, { recursive: true });
// Copy directory recursively; replace with a robust copy if desired.
fs.cpSync(src, dest, { recursive: true });
```

## Step 10: Dockerfile update (builder stage)

Pseudo-code changes:

```
COPY web/ web/
RUN npm --prefix web ci
RUN npm --prefix web run build
RUN node scripts/copy-web-dist.mjs
```

Ensure the final image still copies `/app/dist/` (includes `dist/public`).

## Step 11: Critical data flows

Simulation creation to visualization:

1. Wizard submits `POST /api/v1/simulations/life`.
2. Save `simulationId`, navigate to `/simulations/:id/paths`.
3. Poll `GET /api/v1/simulations/:id` until status is `completed`.
4. Once completed, fan-out queries:
   - `/visualization/overview`
   - `/visualization/paths`
   - `/visualization/branches/:pathId`
   - `/visualization/stress-comparison` (after stress-test)
   - `/visualization/milestones`

Stress test flow:
1. `POST /api/v1/simulations/:id/stress-test`.
2. Poll the variant status if needed.
3. Fetch `/visualization/stress-comparison`.

## Step 12: Testing strategy

Unit and component tests (Vitest + React Testing Library):
- `web/vitest.config.ts` with `environment: 'jsdom'`.
- Use MSW to mock `/api` and `/visualization` endpoints.
- Focus on chart rendering guards and empty/error states.

E2E tests (Playwright):
- `web/playwright.config.ts` with baseURL `http://localhost:3000`.
- Boot server + SPA build (or dev server proxy).
- Scenarios: create simulation, view overview, path charts, branch graph, milestones, values CRUD.

---

End of plan.
