/**
 * email — Gmail 发件工具（仅 send，绝不读邮箱）
 *
 * 安全约束：
 *  - highRisk=true，pipeline 强制二次确认
 *  - 仅支持发送，不实现读取（避免 LLM 接触收件箱内容）
 *  - 收件人通过 ToolPermission.constraints.allowList 白名单严格限制
 *  - dryRun 模式：返回 base64-encoded RFC822 报文不真发，便于审查
 *  - 附件大小总和 <= maxAttachmentBytes（默认 25MB）
 */

import { Buffer } from 'node:buffer';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from '../tool-adapter.js';
import { getGoogleAccessToken } from './google-auth.js';
import type { Logger } from '../../utils/logger.js';
import { ValidationError, StateError, ErrorCode } from '../../errors/index.js';

export interface EmailOptions {
  readonly provider: 'gmail' | 'mock';
  readonly serviceAccountJson?: string;
  readonly oauthAccessToken?: string;
  readonly dryRun: boolean;
  readonly maxAttachmentBytes: number;
}

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const SEND_TIMEOUT_MS = 30_000;
/** RFC 5321 SMTP 行长度限制 */
const RFC5321_MAX_LINE = 998;

export class EmailTool implements ToolAdapter {
  readonly metadata = {
    id: 'email.send',
    displayName: 'Send Email (Gmail)',
    description: '通过 Gmail 发送邮件；仅 send 操作，不支持读取收件箱',
    highRisk: true,
    defaultTimeoutMs: SEND_TIMEOUT_MS,
    defaultMaxPerDay: 50,
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: '收件人邮箱（必须在 allowList 中）' },
        subject: { type: 'string', minLength: 1, maxLength: 998 },
        bodyText: { type: 'string', maxLength: 1_000_000 },
        bodyHtml: { type: 'string', maxLength: 1_000_000 },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        attachments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string', maxLength: 256 },
              mimeType: { type: 'string', maxLength: 128 },
              dataBase64: { type: 'string' },
            },
            required: ['filename', 'mimeType', 'dataBase64'],
          },
        },
      },
      required: ['to', 'subject'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly options: EmailOptions,
    logger: Logger,
  ) {
    if (options.provider === 'gmail' && !options.dryRun
        && !options.serviceAccountJson && !options.oauthAccessToken) {
      logger.warn('EmailTool', 'provider=gmail 且 dryRun=false 但未配置认证；调用时将抛错');
    }
  }

  async invoke(ctx: ToolInvocationContext): Promise<ToolInvocationResult> {
    const to = requireEmail(ctx.arguments, 'to');
    const subject = requireString(ctx.arguments, 'subject');
    if (subject.length > 998) {
      throw new ValidationError('subject 长度不可超过 998', ErrorCode.VALIDATION_FORMAT);
    }
    const bodyText = (ctx.arguments['bodyText'] as string | undefined) ?? '';
    const bodyHtml = (ctx.arguments['bodyHtml'] as string | undefined) ?? '';
    if (!bodyText && !bodyHtml) {
      throw new ValidationError('bodyText 或 bodyHtml 必须提供其一', ErrorCode.VALIDATION_REQUIRED);
    }

    const cc = ensureEmailArray(ctx.arguments['cc'], 'cc');
    const bcc = ensureEmailArray(ctx.arguments['bcc'], 'bcc');
    const attachments = ensureAttachments(ctx.arguments['attachments']);
    this.assertAttachmentSize(attachments);

    const rfc822 = buildRfc822({
      from: 'persona-agent@chrono-synth.local',
      to, cc, bcc, subject, bodyText, bodyHtml, attachments,
    });

    if (this.options.dryRun || this.options.provider === 'mock') {
      const result = {
        dryRun: true,
        to, subject,
        sizeBytes: Buffer.byteLength(rfc822, 'utf8'),
        rfc822Base64: Buffer.from(rfc822, 'utf8').toString('base64').slice(0, 200) + '…',
      };
      return wrapJson(result);
    }

    const accessToken = await getGoogleAccessToken({
      scope: SCOPE,
      serviceAccountJson: this.options.serviceAccountJson,
      oauthAccessToken: this.options.oauthAccessToken,
    });

    const remaining = ctx.deadline - Date.now();
    if (remaining <= 0) throw new StateError('email send 截止时间已过', ErrorCode.STATE_INVALID_TRANSITION);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining, SEND_TIMEOUT_MS));
    try {
      const raw = Buffer.from(rfc822, 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ raw }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new StateError(`Gmail send 失败 HTTP ${res.status}: ${errBody.slice(0, 200)}`, ErrorCode.STATE_INVALID_TRANSITION);
      }
      const json = await res.json() as { id?: string; threadId?: string };
      return wrapJson({ messageId: json.id ?? null, threadId: json.threadId ?? null, to });
    } finally {
      clearTimeout(timer);
    }
  }

  private assertAttachmentSize(attachments: Attachment[]): void {
    const total = attachments.reduce((sum, a) => sum + Buffer.byteLength(a.dataBase64, 'base64'), 0);
    if (total > this.options.maxAttachmentBytes) {
      throw new ValidationError(
        `附件总大小 ${total} bytes 超过限制 ${this.options.maxAttachmentBytes}`,
        ErrorCode.VALIDATION_FORMAT,
      );
    }
  }
}

interface Attachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly dataBase64: string;
}

function buildRfc822(input: {
  from: string;
  to: string;
  cc: readonly string[];
  bcc: readonly string[];
  subject: string;
  bodyText: string;
  bodyHtml: string;
  attachments: readonly Attachment[];
}): string {
  const boundary = `chrono-${Math.random().toString(36).slice(2, 10)}`;
  const lines: string[] = [];
  lines.push(`From: ${input.from}`);
  lines.push(`To: ${input.to}`);
  if (input.cc.length > 0) lines.push(`Cc: ${input.cc.join(', ')}`);
  if (input.bcc.length > 0) lines.push(`Bcc: ${input.bcc.join(', ')}`);
  lines.push(`Subject: ${encodeRfc2047(input.subject)}`);
  lines.push('MIME-Version: 1.0');
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push('');

  if (input.bodyText) {
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(input.bodyText);
    lines.push('');
  }
  if (input.bodyHtml) {
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(input.bodyHtml);
    lines.push('');
  }
  for (const att of input.attachments) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${att.filename}"`);
    lines.push('');
    /* base64 必须按 76 字符换行（RFC 2045） */
    lines.push(att.dataBase64.replace(/.{76}/g, (m) => `${m}\r\n`));
    lines.push('');
  }
  lines.push(`--${boundary}--`);
  return lines.join('\r\n');
}

function encodeRfc2047(value: string): string {
  /* 对 ASCII 安全字符直接返回；含非 ASCII 用 RFC 2047 base64 编码 */
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `=?utf-8?B?${encoded}?=`;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`参数 ${key} 必须为非空字符串`, ErrorCode.VALIDATION_REQUIRED);
  }
  if (value.length > RFC5321_MAX_LINE) {
    throw new ValidationError(`参数 ${key} 长度超过 RFC 5321 限制`, ErrorCode.VALIDATION_FORMAT);
  }
  return value;
}

function requireEmail(args: Record<string, unknown>, key: string): string {
  const value = requireString(args, key);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ValidationError(`参数 ${key} 不是合法邮箱格式`, ErrorCode.VALIDATION_FORMAT);
  }
  return value;
}

function ensureEmailArray(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`参数 ${key} 必须是字符串数组`, ErrorCode.VALIDATION_FORMAT);
  }
  for (const v of value) {
    if (typeof v !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      throw new ValidationError(`${key} 包含非法邮箱: ${String(v)}`, ErrorCode.VALIDATION_FORMAT);
    }
  }
  return value as string[];
}

function ensureAttachments(value: unknown): Attachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError('attachments 必须是数组', ErrorCode.VALIDATION_FORMAT);
  }
  return value.map((item, idx) => {
    if (!item || typeof item !== 'object') {
      throw new ValidationError(`attachments[${idx}] 必须是对象`, ErrorCode.VALIDATION_FORMAT);
    }
    const obj = item as Record<string, unknown>;
    const filename = typeof obj.filename === 'string' ? obj.filename : '';
    const mimeType = typeof obj.mimeType === 'string' ? obj.mimeType : '';
    const dataBase64 = typeof obj.dataBase64 === 'string' ? obj.dataBase64 : '';
    if (!filename || !mimeType || !dataBase64) {
      throw new ValidationError(`attachments[${idx}] 缺少 filename/mimeType/dataBase64`, ErrorCode.VALIDATION_REQUIRED);
    }
    return { filename, mimeType, dataBase64 };
  });
}

function wrapJson(json: unknown): ToolInvocationResult {
  const text = JSON.stringify(json);
  return {
    content: [{ type: 'json', json }],
    costCents: 0,
    outputSizeBytes: Buffer.byteLength(text, 'utf8'),
  };
}
