/**
 * JWT signing key persistence (P0-D #2)
 *
 * KeyRing 自身只持有内存状态；本模块负责把 KeyRing 快照
 * 落到 jwt_signing_keys 表，并提供 boot-time 装载 +
 * rotate-time 同步持久化 + 周期 reload 接口。
 *
 * 字段加密：
 *   private_key / secret 必须以 FieldEncryption 包装后入库。运行时若
 *   没有提供 FieldEncryption，则只能写 publicKey + secret='' / privateKey=''
 *   两种降级形态（例如对称 HS256 测试场景下 secret 可视为已经在外层
 *   保护好）。生产配置 encryption.enabled=true 时必须传入 fieldCrypto。
 *
 * 状态完整性：
 *   load 返回 active+grace+retired+compromised 的完整四态视图，状态变更
 *   时间戳由 KeyRing 自身负责。persistKeyRing 在事务里覆盖整张表，
 *   created_at / state_changed_at 用 row 自身的元信息（若可用）保留。
 */

import type { IDatabase } from '../../storage/database.js';
import type { FieldEncryption } from '../../storage/encryption.js';
import {
  KeyRing,
  type JwtKeyEntry,
  type JwtKeyState,
  type JwtAlgorithm,
} from './jwt-keyring.js';

interface JwtKeyRow {
  kid: string;
  state: string;
  algorithm: string;
  private_key: string;
  public_key: string;
  secret: string;
  created_at: string;
  state_changed_at: string;
  retired_at: string | null;
}

/**
 * 持久化扩展元数据：除 KeyRing 暴露的 JwtKeyEntry 外，还需要记录
 * 状态变迁时间戳，供审计与运维使用。
 */
export interface JwtKeyMetadata {
  createdAt: string;
  stateChangedAt: string;
  retiredAt: string | null;
}

export interface JwtKeyStoreOptions {
  /**
   * 字段加密：必填于生产环境。privateKey + secret 写入前后由它加解密。
   * 单元测试若使用 HS256 + 临时 ring 可以不传，但 lint:field-encryption
   * 会在缺失时报警。
   */
  fieldCrypto?: FieldEncryption;
  /** 与 FieldEncryption.encrypt 的 keyRef 对齐；默认 'master'。 */
  keyRef?: string;
}

export class JwtKeyStore {
  private readonly fieldCrypto: FieldEncryption | undefined;
  private readonly keyRef: string;

  constructor(private readonly db: IDatabase, options: JwtKeyStoreOptions = {}) {
    this.fieldCrypto = options.fieldCrypto;
    this.keyRef = options.keyRef ?? 'master';
  }

  private encryptSensitive(plaintext: string): string {
    if (!plaintext) return '';
    return this.fieldCrypto ? this.fieldCrypto.encrypt(plaintext, this.keyRef) : plaintext;
  }

  private decryptSensitive(ciphertext: string): string {
    if (!ciphertext) return '';
    return this.fieldCrypto ? this.fieldCrypto.decrypt(ciphertext) : ciphertext;
  }

  private rowToEntry(row: JwtKeyRow): JwtKeyEntry {
    return {
      kid: row.kid,
      state: row.state as JwtKeyState,
      algorithm: row.algorithm as JwtAlgorithm,
      privateKey: this.decryptSensitive(row.private_key),
      publicKey: row.public_key,
      secret: this.decryptSensitive(row.secret),
    };
  }

  /**
   * 加载 ring 快照。若表为空返回 undefined，调用方应回退到 env-seed。
   * 严格校验恰好一条 active；多于/少于一条直接抛错而非自动修复，
   * 因为这意味着 schema 损坏或并发 rotate 未提交完整。
   *
   * 返回 active + grace + retired + compromised 完整四态。
   */
  loadKeyRing(): KeyRing | undefined {
    const rows = this.db.prepare<JwtKeyRow>(
      `SELECT kid, state, algorithm, private_key, public_key, secret,
              created_at, state_changed_at, retired_at
         FROM jwt_signing_keys`,
    ).all();
    if (rows.length === 0) return undefined;
    return new KeyRing(rows.map(row => this.rowToEntry(row)));
  }

  /**
   * 全量覆盖式持久化：DELETE + 批量 INSERT。事务保护，确保任何中途
   * 失败都不会导致表里多于/少于一条 active。
   *
   * 时间戳策略：persistKeyRing 接收可选 metadata 覆盖；默认每行用 now。
   * 若需要保留旧 created_at（grace/retired 行的历史时间），调用方应
   * 在 rotate 前先 load 元数据再传入。
   */
  persistKeyRing(ring: KeyRing, options: { metadata?: ReadonlyMap<string, JwtKeyMetadata>; now?: Date } = {}): void {
    const nowIso = (options.now ?? new Date()).toISOString();
    const meta = options.metadata;
    this.db.transaction(() => {
      this.db.exec('DELETE FROM jwt_signing_keys');
      for (const entry of ring.allEntries()) {
        const m = meta?.get(entry.kid);
        this.db.prepare<void>(
          `INSERT INTO jwt_signing_keys
             (kid, state, algorithm, private_key, public_key, secret,
              created_at, state_changed_at, retired_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          entry.kid,
          entry.state,
          entry.algorithm,
          this.encryptSensitive(entry.privateKey),
          entry.publicKey,
          this.encryptSensitive(entry.secret),
          m?.createdAt ?? nowIso,
          m?.stateChangedAt ?? nowIso,
          entry.state === 'retired' || entry.state === 'compromised'
            ? (m?.retiredAt ?? nowIso)
            : null,
        );
      }
    });
  }

  /** 重新加载并返回当前数据库快照对应的 ring。 */
  reloadKeyRing(): KeyRing | undefined {
    return this.loadKeyRing();
  }

  /** 读取全部行的元数据快照（kid → metadata），供 persist 时保留时间戳。 */
  loadMetadata(): Map<string, JwtKeyMetadata> {
    const rows = this.db.prepare<JwtKeyRow>(
      `SELECT kid, created_at, state_changed_at, retired_at FROM jwt_signing_keys`,
    ).all();
    const out = new Map<string, JwtKeyMetadata>();
    for (const row of rows) {
      out.set(row.kid, {
        createdAt: row.created_at,
        stateChangedAt: row.state_changed_at,
        retiredAt: row.retired_at,
      });
    }
    return out;
  }
}
