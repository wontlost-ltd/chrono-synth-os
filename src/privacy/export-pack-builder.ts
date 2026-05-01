/**
 * 可移植性包构建器 — 将 exportData() 结果转换为 PortabilityPackManifestV1 格式
 * 使用 HMAC-SHA256 作为临时完整性签名（正式 ed25519 密钥管理尚未就绪）
 */

import { createHash, createHmac } from 'node:crypto';
import type { PortabilityPackManifestV1 } from '@chrono/contracts';

/** buildPortabilityPack 的返回值 */
export interface PortabilityPackResult {
  manifest: PortabilityPackManifestV1;
  /** 各表的 NDJSON 内容，key 为 payloads/<table>.ndjson */
  payloads: Record<string, string>;
  /** 已序列化的 manifest JSON 字符串 */
  rawManifestJson: string;
}

/**
 * 核心表集合 — 这些表标记为 required=true，其余为 optional
 */
const CORE_TABLES = new Set([
  'users',
  'identities',
  'persona_core',
  'persona_memories',
  'memory_nodes',
  'core_values',
  'cognitive_model',
  'narrative',
  'decision_style',
]);

/**
 * 将行数组序列化为 NDJSON 字符串（每行一个 JSON 对象）
 */
function rowsToNdjson(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n');
}

/**
 * 计算字符串的 SHA-256 十六进制摘要
 */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 使用平台签名密钥对 manifest JSON 计算 HMAC-SHA256
 */
function hmacSha256Hex(content: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(content, 'utf8').digest('hex');
}

/**
 * 将 exportData() 的结果构建为 PortabilityPackManifestV1 包
 *
 * @param exportResult  - exportData() 的返回值
 * @param signingKey    - config.encryption.masterKey，用于 HMAC 签名
 * @returns 包含 manifest、各表 NDJSON payload 和原始 manifest JSON
 */
export function buildPortabilityPack(
  exportResult: {
    exportId: string;
    tenantId: string;
    exportedAt: number;
    content: {
      persona: unknown;
      tables: Record<string, unknown[]>;
    };
  },
  signingKey: string,
): PortabilityPackResult {
  const { tenantId, exportedAt, content } = exportResult;
  const { tables } = content;

  const payloads: Record<string, string> = {};

  // 将 persona 数据作为一个特殊条目加入
  const personaNdjson = rowsToNdjson([content.persona]);
  payloads['payloads/persona.ndjson'] = personaNdjson;

  // 将各表数据转为 NDJSON
  for (const [tableName, rows] of Object.entries(tables)) {
    const ndjson = rowsToNdjson(rows);
    payloads[`payloads/${tableName}.ndjson`] = ndjson;
  }

  // 构建 PayloadEntry 列表
  const payloadEntries: PortabilityPackManifestV1['payloads'] = [
    {
      logicalName: 'persona',
      format: 'ndjson',
      path: 'payloads/persona.ndjson',
      checksum: sha256Hex(personaNdjson),
      required: true,
    },
    ...Object.entries(tables).map(([tableName, rows]) => {
      const ndjson = rowsToNdjson(rows);
      return {
        logicalName: tableName,
        format: 'ndjson' as const,
        path: `payloads/${tableName}.ndjson`,
        checksum: sha256Hex(ndjson),
        required: CORE_TABLES.has(tableName),
      };
    }),
  ];

  // 构建不含 integrity 的 manifest，先计算 manifestChecksum
  const exportedAtIso = new Date(exportedAt).toISOString();

  const manifestWithoutIntegrity = {
    schemaVersion: 'portability-pack.v1' as const,
    exportedAt: exportedAtIso,
    exportMode: 'personal' as const,
    sourceRuntime: 'node' as const,
    sourceApiMajor: 'v1' as const,
    tenant: {
      tenantId,
      deploymentMode: 'platform_managed' as const,
      encryptionMode: 'platform_managed' as const,
    },
    payloads: payloadEntries,
    compatibility: {
      minImporterVersion: 'v1',
      featureFlagsRequired: [],
    },
    encryption: {
      mode: 'none' as const,
    },
  };

  // 序列化不含 integrity 的 manifest 以计算 checksum
  const tempJson = JSON.stringify(manifestWithoutIntegrity);
  const manifestChecksum = sha256Hex(tempJson);

  // 计算 HMAC 签名（基于 checksum 字符串，确保确定性）
  const signature = hmacSha256Hex(manifestChecksum, signingKey);

  // 组装完整 manifest（含 integrity）
  const manifest: PortabilityPackManifestV1 = {
    ...manifestWithoutIntegrity,
    integrity: {
      algorithm: 'sha256',
      manifestChecksum,
      signatureAlgorithm: 'hmac-sha256',
      signaturePublicKey: signature,
      detachedSignaturePath: 'manifest.sig',
    },
  };

  const rawManifestJson = JSON.stringify(manifest);

  return { manifest, payloads, rawManifestJson };
}
