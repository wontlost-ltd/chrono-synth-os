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

console.log('=== PROBE A: same key, DIFFERENT amount ===');
const a1 = ws.requestWalletPayout({ tenantId, ownerUserId, walletId, amountMinor: 1000, idempotencyKey: 'K1' });
console.log('first  amountMinor=1000 ->', a1 && { id:a1.id, amount:a1.amountMinor });
const a2 = ws.requestWalletPayout({ tenantId, ownerUserId, walletId, amountMinor: 50000, idempotencyKey: 'K1' });
console.log('second amountMinor=50000 ->', a2 && { id:a2.id, amount:a2.amountMinor });
console.log('SAME OBJECT RETURNED?', a1?.id === a2?.id, '  <-- caller asked 50000, got', a2?.amountMinor);
const bal = db.prepare<{balance:number}>('SELECT balance FROM persona_wallets WHERE id = ?').get(walletId);
console.log('balance now =', bal?.balance, '(started 1000, minus 10)');

console.log('\n=== PROBE B: index existence + partial semantics on SQLite ===');
const idx = db.prepare<any>("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='uq_wallet_payout_idempotency'").all();
console.log(JSON.stringify(idx, null, 2));
