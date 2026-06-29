/**
 * 设备稳定标识（ADR-0054 P6 push 注册用）。
 *
 * 后端 `POST /api/v1/devices`（RegisterDeviceSchema）按 (tenantId, userId, deviceUid) upsert 设备并落
 * pushToken；故移动端注册前需要一个**跨重启稳定**的 deviceUid。RN 无现成硬件 id（未引入 expo-device），
 * 这里在 expo-secure-store 里持久化一个一次性生成的 UUID：首次取无 → 生成并存 → 后续恒返回同值。
 *
 * 不引入 uuid/expo-crypto 依赖：用 RN 全局 crypto.getRandomValues（Expo 52 运行时提供）拼 RFC-4122 v4；
 * 极端无 crypto 环境降级到时间+随机串（deviceUid 只需稳定唯一，非安全敏感）。
 */
import * as SecureStore from 'expo-secure-store';

const DEVICE_UID_KEY = 'chrono.deviceUid';

/** 生成 RFC-4122 v4 UUID（优先 crypto.getRandomValues；降级到非加密随机——deviceUid 不需密码学强度）。 */
function generateUuid(): string {
  const bytes = new Uint8Array(16);
  const g = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (g?.getRandomValues) {
    g.getRandomValues(bytes);
  } else {
    /* 降级：非加密随机填充（仅极端无 crypto 的 RN 环境；deviceUid 只求稳定唯一）。 */
    for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/** 取（或首次生成并持久化）本设备稳定 deviceUid。 */
export async function getOrCreateDeviceUid(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DEVICE_UID_KEY);
  if (existing) return existing;
  const uid = generateUuid();
  await SecureStore.setItemAsync(DEVICE_UID_KEY, uid);
  return uid;
}
