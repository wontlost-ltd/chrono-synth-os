import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readRepoFile(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8');
}

describe('production readiness assets', () => {
  it('production configmap 强制使用 postgres + auth + jwt + encryption', () => {
    const configmap = readRepoFile('k8s', 'production', 'configmap.yml');
    assert.match(configmap, /CHRONO_DB_DRIVER: "postgres"/);
    assert.match(configmap, /CHRONO_AUTH_ENABLED: "true"/);
    assert.match(configmap, /CHRONO_AUTH_REQUIRE_DB_KEYS: "true"/);
    assert.match(configmap, /CHRONO_JWT_ENABLED: "true"/);
    assert.match(configmap, /CHRONO_ENCRYPTION_ENABLED: "true"/);
    assert.match(configmap, /CHRONO_REDIS_ENABLED: "true"/);
  });

  it('production deployment 使用 secretRef 且不再挂载 sqlite PVC', () => {
    const deployment = readRepoFile('k8s', 'production', 'deployment.yml');
    assert.match(deployment, /replicas: 3/);
    assert.match(deployment, /secretRef:/);
    assert.match(deployment, /topologySpreadConstraints:/);
    assert.doesNotMatch(deployment, /chrono\.db/);
    assert.doesNotMatch(deployment, /persistentVolumeClaim:/);
  });

  it('production observability scraping 使用 bearer token secret', () => {
    const serviceMonitor = readRepoFile('k8s', 'production', 'servicemonitor.yml');
    const workerMonitor = readRepoFile('k8s', 'production', 'observability-worker-servicemonitor.yml');
    assert.match(serviceMonitor, /bearerTokenSecret:/);
    assert.match(serviceMonitor, /PROMETHEUS_SCRAPE_BEARER_TOKEN/);
    assert.match(workerMonitor, /bearerTokenSecret:/);
  });

  it('production network policy 同时限制 ingress 与 egress', () => {
    const networkPolicy = readRepoFile('k8s', 'production', 'network-policy.yml');
    assert.match(networkPolicy, /policyTypes:\s*\n\s*- Ingress\s*\n\s*- Egress/);
    assert.match(networkPolicy, /port: 5432/);
    assert.match(networkPolicy, /port: 6379/);
    assert.match(networkPolicy, /port: 9092/);
    assert.match(networkPolicy, /port: 443/);
  });
});
