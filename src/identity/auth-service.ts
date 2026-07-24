/**
 * Auth Application Service
 * 封装注册、登录、令牌刷新、登出的数据访问与业务逻辑
 */

import { createHash, randomUUID } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance } from 'fastify';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { AppConfig } from '../config/schema.js';
import type { JwtPayload } from '../types/auth.js';
import { ErrorCode, StateError, AuthenticationError } from '../errors/index.js';
import { createCustomer } from '../billing/stripe-client.js';
import { syncPlanToQuota } from '../billing/plans.js';
import { IdentityWriter } from './identity-service.js';
import { canonicalizeEmail } from './email-canonical.js';
import { TenantIdentityDirectory } from './tenant-identity-directory.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
import {
  authQueryUserById, authQueryRefreshToken,
  authCmdCreateUser, authCmdCreateSubscription,
  authCmdCreateRefreshToken, authCmdRevokeTokenById,
  authCmdRevokeTokenByHash, authCmdRevokeTokensByUser,
  authCmdCleanupExpiredTokens,
  bootQueryByOperation, bootCmdMarkComplete,
  subqQueryActivePlan,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

/** register 候选身份生成器（测试 seam：注确定性 idGen 验 canonical 身份重入）。 */
export interface IdGenerator {
  tenantId(): string;
  userId(): string;
}

/** 生产默认：随机租户/用户 id（candidate；canonical 以目录 reserve 读回为准）。 */
const DEFAULT_ID_GEN: IdGenerator = {
  tenantId: () => `tenant_${randomUUID()}`,
  userId: () => `user_${randomUUID()}`,
};

/**
 * Stripe 客户创建器（测试 seam）。默认委托真实 `createCustomer`。
 *
 * 抽成注入点是为可断言「Stripe 在 shard 事务**外**调用、传 idempotencyKey=operationId、重试不重复调」——
 * 这是 golden 门（`node --test` 无 module-mock 标志）下唯一稳定的 spy 方式，且契合依赖注入优先原则。
 * 返回 stripe customer id。
 */
export type StripeCustomerCreator = (
  config: AppConfig, email: string, tenantId: string, idempotencyKey?: string,
) => Promise<string>;

const DEFAULT_STRIPE_CREATE_CUSTOMER: StripeCustomerCreator = async (config, email, tenantId, idempotencyKey) =>
  (await createCustomer(config, email, tenantId, idempotencyKey)).id;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface RegisterResult {
  userId: string;
  email: string;
  tenantId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResult {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshResult {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export class AuthService {
  /** 协调库身份目录门面：email→tenant 目录 reserve/activate/resolve 全经它（Plan 1c Task 4）。 */
  private readonly directory: TenantIdentityDirectory;

  /** Stripe 客户创建器（可注入；默认真实 createCustomer）。 */
  private readonly stripeCreateCustomer: StripeCustomerCreator;

  constructor(
    private readonly resolver: TenantDbResolver,
    private readonly config: AppConfig,
    /* register 候选身份生成器（测试 seam）：canonical 身份以目录 reserve 读回为准，故重试用不同
     * 随机 id 也不产生第二个租户。生产用默认随机 id。 */
    private readonly idGen: IdGenerator = DEFAULT_ID_GEN,
    /* Stripe 客户创建器注入点（测试 seam；默认真实 createCustomer）。生产 3 参构造不受影响。 */
    deps?: { stripeCreateCustomer?: StripeCustomerCreator },
  ) {
    registerCoreSelfExecutors();
    this.directory = new TenantIdentityDirectory(this.resolver);
    this.stripeCreateCustomer = deps?.stripeCreateCustomer ?? DEFAULT_STRIPE_CREATE_CUSTOMER;
  }

  /**
   * register 状态机（分片 Plan 1c Task 5）。
   *
   * 安全铁律（Codex 8 轮复审逼出，逐条精确）：
   *  1. **register 绝不认证**：开头 resolveByEmail(canon)，若已 ACTIVE → 直接抛 AUTH_EMAIL_EXISTS(409)，
   *     **绝不签发 token**——堵「重复 register 登入既有账号」的账号接管。
   *  2. **客户端幂等键**：operationId 来自客户端 Idempotency-Key（缺则一次性随机），私有属原客户端。
   *  3. **首次 argon2 hash 持久化 + 续做 argon2.verify**：首次 hash 存进 reservation；重试读回它后用
   *     argon2.verify(pendingPasswordHash, password) 证明持有原密码（同密码稳定通过随机盐、他人密码拒），
   *     通过则 shard user 复用同一 hash。
   *  4. **canonical 身份**：一律用 reserve 读回的 canonicalTenantId/canonicalUserId 写 shard、签 token，
   *     绝不用本次候选随机 id——重试复用既存身份不重生。
   *  5. **Stripe 事务外幂等**：在开 shard 事务**前** await createCustomer(..., operationId)（幂等键）；
   *     再开**短同步**事务写 user/subscription/quota + bootstrap COMPLETE。重试若 bootQueryByOperation
   *     已 COMPLETE → 读回既存 customerId，跳过 Stripe 与重建。
   *  6. **CAS 失败不签发 token**：activateTenant 返 false 时，仅当 resolveByEmail 已收敛为本 tenant ACTIVE
   *     才继续；否则抛 AUTH_REGISTRATION_RETRY，不签 token。
   */
  async register(
    app: FastifyInstance,
    email: string,
    password: string,
    opts?: { idempotencyKey?: string },
  ): Promise<RegisterResult> {
    /* email 归一化：与 v124 存储侧 LOWER(TRIM(email)) 对齐，全链路用 canon 值。 */
    const canonEmail = canonicalizeEmail(email);

    /* ①【绝不认证】已 ACTIVE → 409，绝不签 token（堵重复 register 接管既有账号）。 */
    const existing = this.directory.resolveByEmail(canonEmail);
    if (existing?.status === 'ACTIVE') {
      throw new StateError('该邮箱已注册', ErrorCode.AUTH_EMAIL_EXISTS);
    }

    /* ② 客户端幂等键（Idempotency-Key）；缺则一次性随机（属本次一次性请求）。 */
    const operationId = opts?.idempotencyKey ?? `reg:${randomUUID()}`;

    /* ③ 首次 argon2 hash：reservation 持久化它，shard user 复用它（密码所有权凭据）。 */
    const firstHash = await hash(password);

    /* ④ 候选随机身份（canonical 以下方 reserve 读回为准）。 */
    const candidateTenantId = this.idGen.tenantId();
    const candidateUserId = this.idGen.userId();

    const { reservedByUs, canonicalTenantId, canonicalUserId, pendingPasswordHash } =
      this.directory.reserveTenant({
        tenantId: candidateTenantId, userId: candidateUserId, operationId,
        pendingPasswordHash: firstHash, email: canonEmail,
      });

    /* opId 不属本请求（他人 PENDING 占 / 无匹配 key）→ 不签 token。 */
    if (!reservedByUs) {
      const cur = this.directory.resolveByEmail(canonEmail);
      throw cur?.status === 'ACTIVE'
        ? new StateError('该邮箱已注册', ErrorCode.AUTH_EMAIL_EXISTS)
        : new StateError('该邮箱注册进行中', ErrorCode.AUTH_REGISTRATION_IN_PROGRESS);
    }

    /* ③续做密码所有权证明（第 6 轮）：读回行是既存 reservation（重试），须证明持有原密码。
     * argon2.verify 而非重算 hash 比对——同密码稳定通过（随机盐无关），异密码/他人拒。 */
    if (!(await verify(pendingPasswordHash, password))) {
      throw new StateError('该邮箱注册进行中', ErrorCode.AUTH_REGISTRATION_IN_PROGRESS);
    }
    /* shard user 复用 reservation 的 hash（同一稳定值，不重算）。 */
    const shardPasswordHash = pendingPasswordHash;

    /* ⑤ per-operation bootstrap 完成标记：已 COMPLETE 即本次 shard 已落地（重试），跳 Stripe + 重建。 */
    const shardDb = this.resolver.dbForTenant(canonicalTenantId);
    const boot = shardDb.queryOne(bootQueryByOperation(canonicalTenantId, operationId));
    if (boot?.status !== 'COMPLETE') {
      /* ⑤ Stripe 事务外（await）+ 幂等键 = operationId：重试不重复建客户。 */
      let stripeCustomerId: string | null = null;
      if (this.config.stripe.enabled) {
        try {
          stripeCustomerId = await this.stripeCreateCustomer(this.config, canonEmail, canonicalTenantId, operationId);
        } catch (e) {
          app.log.warn(`Stripe 客户创建失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      /* 分片 Plan 1b：身份写经 tenant-bound IdentityWriter(canonicalTenantId, shardDb) seam。
       * IdentityWriter.create 内部自开事务（node:sqlite 平坦 BEGIN 不可嵌套），故在主事务**前**、
       * bootstrap COMPLETE 标记**前**独立写入——一旦 COMPLETE 落地即代表身份已建（重试见 COMPLETE 跳过）。 */
      new IdentityWriter(canonicalTenantId, shardDb).create(canonicalUserId, canonEmail.split('@')[0]);

      /* ⑤ 短同步事务：user/subscription/quota + bootstrap COMPLETE 原子落 shard。
       * COMPLETE 是「本次 operation 已确认落 shard」的权威标记，作为事务最后一步。 */
      const now = Date.now();
      const periodEnd = now + 365 * 24 * 60 * 60 * 1000;
      shardDb.transaction(() => {
        shardDb.execute(authCmdCreateUser({
          id: canonicalUserId, email: canonEmail, passwordHash: shardPasswordHash,
          role: 'admin', tenantId: canonicalTenantId, now,
        }));
        shardDb.execute(authCmdCreateSubscription({
          id: `sub_${randomUUID()}`, tenantId: canonicalTenantId, stripeCustomerId,
          periodStart: now, periodEnd, now,
        }));
        syncPlanToQuota(shardDb, canonicalTenantId, 'free');
        shardDb.execute(bootCmdMarkComplete({ tenantId: canonicalTenantId, operationId, now }));
      });
    }
    /* else：重试且 shard 已 COMPLETE——身份 + user/subscription/quota 已在首次落地，跳过全部重建。 */

    /* ⑥【CAS 失败不签发 token】激活 email 目录项 PENDING→ACTIVE（仅 operationId 命中）。 */
    const activated = this.directory.activateTenant({ email: canonEmail, operationId });
    if (!activated) {
      const row = this.directory.resolveByEmail(canonEmail);
      /* reservedByUs + argon2.verify 前置门已证本请求属本次 reservation，canonicalTenantId 来自读回行，
       * 故 tenantId+ACTIVE 两元即可判定「已收敛为本次注册」——否则不签 token，提示携原 key 重试。 */
      if (!(row && row.tenantId === canonicalTenantId && row.status === 'ACTIVE')) {
        throw new StateError('注册未确认，请携原 Idempotency-Key 重试', ErrorCode.AUTH_REGISTRATION_RETRY);
      }
    }

    /* 仅本次新注册的 canonical 身份签发 token，绝不发既存账号 token。 */
    const tokens = await this.generateTokenPair(app, canonicalUserId, canonicalTenantId, 'admin');
    return { userId: canonicalUserId, email: canonEmail, tenantId: canonicalTenantId, ...tokens };
  }

  /**
   * login 经目录（分片 Plan 1c Task 5）。
   *
   * 别名语义（Codex #3.1/#2）：email 仅作目录定位键——**按 entry.userId 取 shard user（非按 email）**，
   * 且校验 user.id/tenant_id 与目录 entry 一致（防目录/shard 漂移的纵深防御）。绝不比较 shard 当前
   * user.email 与输入，使 changeEmail 崩溃窗口内旧 email alias 仍能定位到已改名 user。
   */
  async login(app: FastifyInstance, email: string, password: string): Promise<LoginResult> {
    const canon = canonicalizeEmail(email);
    const entry = this.directory.resolveByEmail(canon);
    if (!entry || entry.status !== 'ACTIVE' || entry.userId === null) {
      throw new AuthenticationError('邮箱或密码错误', ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const tx = this.resolver.dbForTenant(entry.tenantId);
    const user = tx.queryOne(authQueryUserById(entry.userId));
    if (!user || user.id !== entry.userId || user.tenant_id !== entry.tenantId) {
      throw new AuthenticationError('邮箱或密码错误', ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const valid = await verify(user.password_hash, password);
    if (!valid) {
      throw new AuthenticationError('邮箱或密码错误', ErrorCode.AUTH_INVALID_CREDENTIALS);
    }

    const tokens = await this.generateTokenPair(app, user.id, user.tenant_id, user.role);
    return { userId: user.id, email: user.email, tenantId: user.tenant_id, role: user.role, ...tokens };
  }

  /**
   * refresh（分片 Plan 1c Task 7）——目录=定位器，shard is_revoked=权威。
   *
   * ① `resolveByRefreshTokenHash(tokenHash)` 从协调库目录反查 token 属哪个 tenant（仅定位，不判有效性）；
   *    未命中 → INVALID（不静默兜底其他库，避免跨 shard 误查）。
   * ② `dbForTenant(entry.tenantId)` 取该 tenant 所在 shard，`authQueryRefreshToken` 查 token 行——
   *    该 query SQL 已含 `AND is_revoked = 0`（shard 权威过滤），另显式再校验 `row.is_revoked` 作纵深
   *    防御：**目录多余/过期项只导致「定位到 shard 后被 shard 拒」**，绝不越权。
   * ③ 轮转：shard 内标旧 token revoked（权威撤销）+ 目录 `removeLookup`（清定位项，非原子可接受——
   *    旧 token shard 已 revoked=权威拒，目录清晚不越权）；`generateTokenPair` 落新 token 并记录新目录项。
   */
  async refresh(app: FastifyInstance, refreshToken: string): Promise<RefreshResult> {
    const tokenHash = hashToken(refreshToken);

    /* ① 目录反查 token→tenant（仅定位）。未命中即拒（不兜底其他库）。 */
    const entry = this.directory.resolveByRefreshTokenHash(tokenHash);
    if (!entry) {
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    /* ② shard 权威校验：dbForTenant(entry.tenantId) 查 token 且 is_revoked=0（query 已过滤 + 显式再验）。 */
    const tx = this.resolver.dbForTenant(entry.tenantId);
    const row = tx.queryOne(authQueryRefreshToken(tokenHash));
    if (!row || row.is_revoked || row.expires_at < Date.now()) {
      throw new AuthenticationError('刷新令牌无效或已过期', ErrorCode.AUTH_EXPIRED);
    }

    const user = tx.queryOne(authQueryUserById(row.user_id));
    if (!user) {
      throw new AuthenticationError('用户不存在', ErrorCode.AUTH_INVALID_TOKEN);
    }

    /* ③ 轮转旧 token：shard 内标 revoked（权威）+ 目录清定位项（尽力而为，非原子）。 */
    tx.execute(authCmdRevokeTokenById(row.id));
    this.directory.removeLookup('refresh_token_hash', tokenHash);

    const tokens = await this.generateTokenPair(app, user.id, user.tenant_id, user.role);
    return { userId: user.id, email: user.email, ...tokens };
  }

  /**
   * logout（分片 Plan 1c Task 7）——经目录定位 shard 标 refresh token revoked + 清目录项。
   * jwtUser 分支按 sub（userId）撤销该用户所在 shard 的全部 refresh token。
   */
  logout(refreshToken: string | undefined, jwtUser: JwtPayload | undefined): void {
    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      const entry = this.directory.resolveByRefreshTokenHash(tokenHash);
      if (entry) {
        /* 目录命中：shard 内标 revoked（权威）+ 清目录定位项。 */
        this.resolver.dbForTenant(entry.tenantId).execute(authCmdRevokeTokenByHash(tokenHash));
        this.directory.removeLookup('refresh_token_hash', tokenHash);
      }
    }
    if (jwtUser) {
      /* JWT 已解出 tenantId → 直接定位该用户所在 shard，撤销其全部 refresh token。 */
      this.resolver.dbForTenant(jwtUser.tenantId).execute(authCmdRevokeTokensByUser(jwtUser.sub));
    }
  }

  /**
   * 按 token hash 尽力吊销（分片 Plan 1c Task 7）——经目录定位 shard 标 revoked + 清目录项。
   * 目录未命中即 no-op（token 从未签发 / 已清理），不兜底其他库。
   */
  revokeByTokenHash(tokenHash: string): void {
    const entry = this.directory.resolveByRefreshTokenHash(tokenHash);
    if (!entry) return;
    this.resolver.dbForTenant(entry.tenantId).execute(authCmdRevokeTokenByHash(tokenHash));
    this.directory.removeLookup('refresh_token_hash', tokenHash);
  }

  revokeByRawToken(rawToken: string): void {
    if (typeof rawToken !== 'string' || !rawToken) return;
    this.revokeByTokenHash(hashToken(rawToken));
  }

  async generateTokenPair(
    app: FastifyInstance,
    userId: string,
    tenantId: string,
    role: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    /* 令牌落用户所在 shard（register 用 canonicalTenantId、login 用 entry.tenantId）——单库下=同一 db。 */
    const tx = this.resolver.dbForTenant(tenantId);
    const sub = tx.queryOne(subqQueryActivePlan(tenantId));
    const planId = sub?.plan_id ?? 'free';
    /* iat/exp are injected by @fastify/jwt during sign() but the typed
     * surface still requires them; supply only the application claims
     * and let the runtime backfill timestamps.
     *
     * jti is required for deny-list-based revocation (P0-D #1). Without it,
     * /api/v1/auth/keys/deny-jti could not target tokens issued by this
     * service. We use randomUUID() rather than a sequence to avoid leaking
     * issuance ordering. */
    const signPayload = {
      sub: userId, tenantId, role: role as JwtPayload['role'], planId,
      jti: randomUUID(),
    } as JwtPayload;
    /* GA §8 #1: 优先用 app.jwtSign（KeyRing 动态签名器，支持热轮换）。
     * 仅在 fastify-jwt 仍占主导的旧版部署里回退到 app.jwt.sign。 */
    const accessToken = app.jwtSign ? app.jwtSign(signPayload) : app.jwt.sign(signPayload);

    const refreshToken = randomUUID();
    const tokenHash = hashToken(refreshToken);
    const now = Date.now();
    const expiresAt = now + this.config.jwt.refreshTtlMs;

    tx.execute(authCmdCreateRefreshToken({
      id: `rt_${randomUUID()}`, userId, tokenHash, expiresAt, now,
    }));

    /* 分片 Plan 1c Task 7：记录 refresh_token_hash→tenant 的目录定位项（协调库）。
     * recordActiveLookup 遇他租户已占同 hash 会抛——**不吞**：目录 locator 写失败则整个签发失败
     * （避免发了 token 却定位不到 shard）。随机 UUID token 碰撞概率极低，此门是完整性硬保证。 */
    this.directory.recordActiveLookup({ tenantId, lookupKind: 'refresh_token_hash', lookupValue: tokenHash });

    return {
      accessToken,
      refreshToken,
      expiresIn: Math.floor(this.config.jwt.accessTtlMs / 1000),
    };
  }

  cleanupExpiredTokens(): number {
    // Task 7: 跨 shard fan-out 清理；本 Task 单库兜底走协调库。
    return AuthService.cleanupExpired(this.resolver.coordinatorDb());
  }

  static cleanupExpired(tx: SyncWriteUnitOfWork): number {
    registerCoreSelfExecutors();
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let changes = 0;
    tx.transaction(() => {
      changes = tx.execute(authCmdCleanupExpiredTokens({ cutoff })).rowsAffected;
    });
    return changes;
  }
}
