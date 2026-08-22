import { createMemoryDatabase, runDslSqliteMigrations } from '../storage/index.js';
import { PersonaCoreService } from '../persona-core/persona-core-service.js';

const db = createMemoryDatabase();
runDslSqliteMigrations(db);
const now = Date.now();
db.prepare<void>(`INSERT INTO users (id,email,password_hash,role,tenant_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
  .run('u1','o@e.com','h','member','t1',now,now);
const svc = PersonaCoreService.fromUnitOfWork(db);
const p = svc.createPersona({ tenantId:'t1', ownerUserId:'u1', displayName:'W', profile:{} });
const w = p.wallet.id;

const ins = (id:string, key:string|null) => db.prepare<void>(
  `INSERT INTO wallet_payout_requests (id,tenant_id,wallet_id,amount_minor,currency,status,requested_by_user_id,created_at,completed_at,idempotency_key) VALUES (?,?,?,?,?,'completed',?,?,?,?)`
).run(id,'t1',w,10,'CRED','u1',now,now,key);

console.log('=== PARTIAL UNIQUE INDEX enforcement on SQLite ===');
ins('a','K'); console.log('insert a key=K  -> ok');
try { ins('b','K'); console.log('insert b key=K  -> NO ERROR (BAD!)'); }
catch(e:any){ console.log('insert b key=K  -> rejected:', e.message); }
ins('c',null); ins('d',null);
console.log('two NULL-key rows inserted -> ok (partial index excludes NULLs)');

console.log('\n=== FALSE POSITIVE: PRIMARY KEY collision message ===');
try { ins('a','OTHER'); } catch(e:any){
  console.log('duplicate PK id="a" error:', JSON.stringify(e.message));
  const isUV = /uq_wallet_payout_idempotency/i.test(e.message) || /UNIQUE constraint failed/i.test(e.message) || /duplicate key value violates unique constraint/i.test(e.message);
  console.log('isUniqueViolation() matches?', isUV, ' <-- true = PK collision misclassified');
}

console.log('\n=== FK violation message (control) ===');
try { db.prepare<void>(`INSERT INTO wallet_payout_requests (id,tenant_id,wallet_id,amount_minor,currency,status,requested_by_user_id,created_at,completed_at,idempotency_key) VALUES (?,?,?,?,?,'completed',?,?,?,?)`).run('z','t1','NOSUCH',10,'CRED','u1',now,now,'Z'); }
catch(e:any){ console.log('FK err:', e.message); }
