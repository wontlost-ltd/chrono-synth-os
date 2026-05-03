import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TablesPrimaryCoordinator } from '../src/tables-primary-coordinator.js';

describe('TablesPrimaryCoordinator', () => {
  it('executes only the table write and returns its result', async () => {
    const coordinator = new TablesPrimaryCoordinator();
    let tableWriteCount = 0;
    let toEventsCount = 0;

    const result = await coordinator.execute({
      tenantId: 'tenant-a',
      streamId: 'persona:1',
      commandId: 'cmd-1',
      expectedVersion: 3,
      tableWrite: async () => {
        tableWriteCount += 1;
        return { id: 'persona-1', version: 4 };
      },
      toEvents: () => {
        toEventsCount += 1;
        return [{ type: 'persona.updated', payload: { id: 'persona-1' } }];
      },
    });

    assert.deepEqual(result, { id: 'persona-1', version: 4 });
    assert.equal(tableWriteCount, 1);
    assert.equal(toEventsCount, 0);
  });

  it('reports tables_primary mode for every tenant', async () => {
    const coordinator = new TablesPrimaryCoordinator();

    assert.equal(await coordinator.currentMode('tenant-a'), 'tables_primary');
    assert.equal(await coordinator.currentMode('tenant-b'), 'tables_primary');
  });
});
