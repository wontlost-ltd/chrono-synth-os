import { createMemoryDatabase, runDslSqliteMigrations } from '../storage/index.js';
import { PersonaCoreService } from '../persona-core/persona-core-service.js';
import { PersonaWalletService } from '../persona-core/persona-wallet-service.js';

const db = createMemoryDatabase();
runDslSqliteMigrations(db);
const tenantId = 'tenant_test';
const ownerUserId = 'user_test_owner';
const now = Date.now();
db.prepare<void>(`INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
  .run(ownerUserId,'o@e.com','h','member',tenantId,now,now);
const service = PersonaCoreService.fromUnitOfWork(db);
const persona = service.createPersona({ tenantId, ownerUserId, displayName:'W', profile:{} });
const walletId = persona.wallet.id;
const ws = new PersonaWalletService({ forTenant: () => db, allDbs: () => [db] }, {
  personaExists: (t,o,p) => service.getPersonaDetail(t,o,p) !== null,
});
db.prepare<void>(`UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`).run(1000, now, walletId);

console.log('=== PROBE C: what UNIQUE constraints exist on wallet_transactions / payout table ===');
for (const t of ['wallet_payout_requests','wallet_transactions']) {
  const idx = db.prepare<any>("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?").all(t);
  console.log(t, JSON.stringify(idx.map((r:any)=>({name:r.name,sql:r.sql})), null, 1));
  const ddl = db.prepare<any>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
  console.log('DDL:', ddl?.sql?.slice(0,600));
}

console.log('\n=== PROBE D: cross-tenant same key (should NOT collide) ===');
// second tenant
const t2 = 'tenant_two';
db.prepare<void>(`INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
  .run('u2','o2@e.com','h','member',t2,now,now);
const p2 = service.createPersona({ tenantId: t2, ownerUserId: 'u2', displayName:'W2', profile:{} });
db.prepare<void>(`UPDATE persona_wallets SET balance = ?, updated_at = ? WHERE id = ?`).run(1000, now, p2.wallet.id);
const r1 = ws.requestWalletPayout({ tenantId, ownerUserId, walletId, amountMinor: 1000, idempotencyKey: 'SHARED' });
const r2 = ws.requestWalletPayout({ tenantId: t2, ownerUserId: 'u2', walletId: p2.wallet.id, amountMinor: 1000, idempotencyKey: 'SHARED' });
console.log('tenant1 payout id:', r1?.id, ' tenant2 payout id:', r2?.id, ' distinct?', r1?.id !== r2?.id);
const c = db.prepare<{c:number}>('SELECT COUNT(*) AS c FROM wallet_payout_requests').get();
console.log('total payout rows =', c?.c, '(expect 2)');
