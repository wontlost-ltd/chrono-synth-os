/**
 * 配置元数据分类
 * 根据配置 key 判定其可见性类别（public/protected/admin/secret）、
 * 是否需要重启以及所属分组
 */

export type ConfigCategory = 'public' | 'protected' | 'admin' | 'secret';

export interface ConfigMetadata {
  readonly key: string;
  readonly category: ConfigCategory;
  readonly requiresRestart: boolean;
  readonly groupKey: string;
}

/** 读取时对 secret 类配置值进行脱敏 */
export const SECRET_MASK = '********';

/** 显式元数据：针对特定 key 的精确匹配 */
const EXPLICIT_METADATA: ReadonlyMap<string, Omit<ConfigMetadata, 'key'>> = new Map([
  ['jwt.secret',          { category: 'secret',    requiresRestart: true,  groupKey: 'auth' }],
  ['stripe.secretKey',    { category: 'secret',    requiresRestart: false, groupKey: 'billing' }],
  ['stripe.webhookSecret',{ category: 'secret',    requiresRestart: false, groupKey: 'billing' }],
  ['encryption.masterKey',{ category: 'secret',    requiresRestart: true,  groupKey: 'security' }],
  ['sso.clientSecret',    { category: 'secret',    requiresRestart: true,  groupKey: 'auth' }],
  ['db.connectionString', { category: 'secret',    requiresRestart: true,  groupKey: 'database' }],
  ['redis.url',           { category: 'admin',     requiresRestart: true,  groupKey: 'infra' }],
  ['intelligence.apiKey', { category: 'secret',    requiresRestart: false, groupKey: 'intelligence' }],
]);

/** 前缀规则：按最长匹配优先 */
interface PrefixRule {
  readonly prefix: string;
  readonly category: ConfigCategory;
  readonly requiresRestart: boolean;
  readonly groupKey: string;
}

const PREFIX_RULES: readonly PrefixRule[] = [
  { prefix: 'db.',           category: 'admin',     requiresRestart: true,  groupKey: 'database' },
  { prefix: 'server.',       category: 'admin',     requiresRestart: true,  groupKey: 'server' },
  { prefix: 'log.',          category: 'admin',     requiresRestart: false, groupKey: 'logging' },
  { prefix: 'jwt.',          category: 'admin',     requiresRestart: true,  groupKey: 'auth' },
  { prefix: 'auth.',         category: 'admin',     requiresRestart: true,  groupKey: 'auth' },
  { prefix: 'sso.',          category: 'admin',     requiresRestart: true,  groupKey: 'auth' },
  { prefix: 'redis.',        category: 'admin',     requiresRestart: true,  groupKey: 'infra' },
  { prefix: 'stripe.',       category: 'admin',     requiresRestart: false, groupKey: 'billing' },
  { prefix: 'encryption.',   category: 'admin',     requiresRestart: true,  groupKey: 'security' },
  { prefix: 'intelligence.', category: 'protected', requiresRestart: false, groupKey: 'intelligence' },
  { prefix: 'cognition.',    category: 'protected', requiresRestart: false, groupKey: 'cognition' },
  { prefix: 'queue.',        category: 'admin',     requiresRestart: true,  groupKey: 'queue' },
  { prefix: 'observability.',category: 'admin',     requiresRestart: true,  groupKey: 'observability' },
  { prefix: 'cors.',         category: 'admin',     requiresRestart: true,  groupKey: 'server' },
  { prefix: 'rateLimit.',    category: 'admin',     requiresRestart: false, groupKey: 'server' },
  { prefix: 'websocket.',    category: 'protected', requiresRestart: false, groupKey: 'server' },
  { prefix: 'onboarding.',   category: 'public',    requiresRestart: false, groupKey: 'onboarding' },
  { prefix: 'integration.',  category: 'protected', requiresRestart: false, groupKey: 'intelligence' },
  { prefix: 'request.',      category: 'admin',     requiresRestart: false, groupKey: 'server' },
  { prefix: 'ruleEngine.',   category: 'admin',     requiresRestart: false, groupKey: 'intelligence' },
];

/**
 * 解析配置 key 的元数据
 * 优先级：显式匹配 > 前缀规则 > 默认（protected, requiresRestart: false, general）
 */
export function resolveConfigMetadata(key: string): ConfigMetadata {
  const explicit = EXPLICIT_METADATA.get(key);
  if (explicit) return { key, ...explicit };

  for (const rule of PREFIX_RULES) {
    if (key.startsWith(rule.prefix)) {
      return {
        key,
        category: rule.category,
        requiresRestart: rule.requiresRestart,
        groupKey: rule.groupKey,
      };
    }
  }

  return { key, category: 'protected', requiresRestart: false, groupKey: 'general' };
}
