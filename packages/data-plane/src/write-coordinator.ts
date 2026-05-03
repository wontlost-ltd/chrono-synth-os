import type { DataPlaneAuthorityMode } from './contracts/authority-mode.js';

export interface DataPlaneWriteCoordinator {
  execute<T>(input: {
    tenantId: string;
    streamId: string;
    commandId: string;
    expectedVersion?: number;
    tableWrite: () => Promise<T>;
    toEvents: (result: T) => readonly { type: string; payload: Record<string, unknown> }[];
  }): Promise<T>;
  currentMode(tenantId: string): Promise<DataPlaneAuthorityMode>;
}
