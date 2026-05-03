import type { DataPlaneAuthorityMode } from './contracts/authority-mode.js';
import type { DataPlaneWriteCoordinator } from './write-coordinator.js';

export class TablesPrimaryCoordinator implements DataPlaneWriteCoordinator {
  async execute<T>(input: {
    tenantId: string;
    streamId: string;
    commandId: string;
    expectedVersion?: number;
    tableWrite: () => Promise<T>;
    toEvents: (result: T) => readonly { type: string; payload: Record<string, unknown> }[];
  }): Promise<T> {
    return input.tableWrite();
  }

  async currentMode(_tenantId: string): Promise<DataPlaneAuthorityMode> {
    return 'tables_primary';
  }
}
