/**
 * Browser Local Replica Store — IndexedDB-backed offline data store
 *
 * 三个对象仓库：
 * - entities   : 实体快照缓存（任意资源类型，按 entityRef 键控）
 * - outbox     : 待同步写命令（SyncEnvelopeV1 格式）
 * - sync_meta  : 同步元数据（游标、上次同步时间等）
 */

export interface ReplicaEntity<T = unknown> {
  entityRef: string;      // "<type>/<id>" e.g. "persona/abc"
  tenantId: string;
  projection?: string;
  data: T;
  serverVersion: number;
  syncedAt: number;
}

export interface OutboxEntry {
  commandId: string;
  tenantId: string;
  entityRef: string;
  envelope: unknown;      // SyncEnvelopeV1
  enqueuedAt: number;
  attempts: number;
}

export interface SyncMeta {
  key: string;
  value: unknown;
}

const DB_NAME = 'chrono-replica';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      let entities: IDBObjectStore | null = null;
      if (!db.objectStoreNames.contains('entities')) {
        entities = db.createObjectStore('entities', { keyPath: 'entityRef' });
        entities.createIndex('by_tenant', 'tenantId', { unique: false });
      } else {
        entities = req.transaction?.objectStore('entities') ?? null;
      }

      if (entities && !entities.indexNames.contains('by_projection')) {
        entities.createIndex('by_projection', ['tenantId', 'projection'], { unique: false });
      }

      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'commandId' });
        outbox.createIndex('by_tenant', 'tenantId', { unique: false });
        outbox.createIndex('by_enqueued', 'enqueuedAt', { unique: false });
      }

      if (!db.objectStoreNames.contains('sync_meta')) {
        db.createObjectStore('sync_meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function idb<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// ── entities ──────────────────────────────────────────────────────────────────

export function putEntity(entity: ReplicaEntity): Promise<void> {
  const projection = entity.projection ?? inferProjection(entity.tenantId, entity.entityRef);
  return idb('entities', 'readwrite', (s) => s.put({ ...entity, projection })).then(() => undefined);
}

export function getEntity(entityRef: string): Promise<ReplicaEntity | undefined> {
  return idb<ReplicaEntity | undefined>('entities', 'readonly', (s) => s.get(entityRef));
}

export function getEntitiesByTenant(tenantId: string): Promise<ReplicaEntity[]> {
  return openDb().then(
    (db) =>
      new Promise<ReplicaEntity[]>((resolve, reject) => {
        const tx = db.transaction('entities', 'readonly');
        const idx = tx.objectStore('entities').index('by_tenant');
        const req = idx.getAll(IDBKeyRange.only(tenantId));
        req.onsuccess = () => resolve(req.result as ReplicaEntity[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function listProjection<T>(
  tenantId: string,
  projection: string,
): Promise<ReplicaEntity<T>[]> {
  return openDb().then(
    (db) =>
      new Promise<ReplicaEntity<T>[]>((resolve, reject) => {
        const tx = db.transaction('entities', 'readonly');
        const idx = tx.objectStore('entities').index('by_projection');
        const req = idx.getAll(IDBKeyRange.only([tenantId, projection]));
        req.onsuccess = () => resolve(req.result as ReplicaEntity<T>[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function deleteEntity(entityRef: string): Promise<void> {
  return idb('entities', 'readwrite', (s) => s.delete(entityRef)).then(() => undefined);
}

function inferProjection(tenantId: string, entityRef: string): string {
  const tenantPrefix = `${tenantId}:`;
  if (entityRef.startsWith(tenantPrefix)) {
    const [, projection] = entityRef.split(':');
    if (projection) return projection;
  }

  return entityRef.split('/')[0] ?? entityRef;
}

// ── outbox ────────────────────────────────────────────────────────────────────

export function enqueueOutbox(entry: OutboxEntry): Promise<void> {
  return idb('outbox', 'readwrite', (s) => s.put(entry)).then(() => undefined);
}

export function getOutboxByTenant(tenantId: string): Promise<OutboxEntry[]> {
  return openDb().then(
    (db) =>
      new Promise<OutboxEntry[]>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readonly');
        const idx = tx.objectStore('outbox').index('by_tenant');
        const req = idx.getAll(IDBKeyRange.only(tenantId));
        req.onsuccess = () => resolve(req.result as OutboxEntry[]);
        req.onerror = () => reject(req.error);
      }),
  );
}

export function dequeueOutbox(commandId: string): Promise<void> {
  return idb('outbox', 'readwrite', (s) => s.delete(commandId)).then(() => undefined);
}

export function incrementOutboxAttempts(commandId: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readwrite');
        const store = tx.objectStore('outbox');
        const getReq = store.get(commandId);
        getReq.onsuccess = () => {
          const entry = getReq.result as OutboxEntry | undefined;
          if (!entry) { resolve(); return; }
          const putReq = store.put({ ...entry, attempts: entry.attempts + 1 });
          putReq.onsuccess = () => resolve();
          putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      }),
  );
}

export function countOutbox(tenantId: string): Promise<number> {
  return openDb().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const tx = db.transaction('outbox', 'readonly');
        const idx = tx.objectStore('outbox').index('by_tenant');
        const req = idx.count(IDBKeyRange.only(tenantId));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

// ── sync_meta ─────────────────────────────────────────────────────────────────

export function getSyncMeta<T>(key: string): Promise<T | undefined> {
  return idb<SyncMeta | undefined>('sync_meta', 'readonly', (s) => s.get(key)).then(
    (row) => row?.value as T | undefined,
  );
}

export function setSyncMeta(key: string, value: unknown): Promise<void> {
  return idb('sync_meta', 'readwrite', (s) => s.put({ key, value })).then(() => undefined);
}

/** 仅供测试使用：关闭并重置 DB 连接，使下次 openDb() 重新初始化 */
export function _resetDbForTest(): void {
  if (dbPromise) {
    dbPromise.then((db) => db.close()).catch(() => {});
    dbPromise = null;
  }
}

export function clearReplicaStore(): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['entities', 'outbox', 'sync_meta'], 'readwrite');
        tx.objectStore('entities').clear();
        tx.objectStore('outbox').clear();
        tx.objectStore('sync_meta').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}
