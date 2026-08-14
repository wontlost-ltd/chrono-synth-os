/**
 * ExportCard 下载链路回归（审计 Warning B6-3 / B6-5 的配套）。
 *
 * 钉死两件事：
 *   ① 下载**始终**指向同源 API 端点，而不是把服务端返回的 downloadUrl 直接当 href。
 *      默认本地对象存储返回的是 `file://<服务器路径>`：浏览器取不到，还会泄露服务端
 *      目录结构；协议白名单又会把它整个拒掉导致按钮消失。同源端点两个问题都没有
 *      （它内部 302 到预签名 URL 或回退内联 manifest）。
 *   ② partial 状态既要能下载已有产物，也要把缺了什么讲清楚；无产物时按钮消失但
 *      warnings 仍渲染。
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExportCard } from './ExportCard';
import type { ExportState } from '../../hooks/usePortability';

let mockState: ExportState;

vi.mock('../../hooks/usePortability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/usePortability')>();
  return {
    ...actual,
    useExportFlow: () => ({ state: mockState, start: vi.fn(), reset: vi.fn() }),
  };
});

beforeEach(() => {
  mockState = {
    phase: 'idle', exportId: null, downloadUrl: null, errorMessage: null, warnings: [],
  };
});

describe('ExportCard 下载链路', () => {
  it('ready：href 指向同源 API 端点，而非服务端返回的 file:// 地址', () => {
    mockState = {
      phase: 'ready',
      exportId: 'exp_abc',
      /* 默认本地对象存储的真实返回值。 */
      downloadUrl: 'file:///var/lib/chrono/exports/exp_abc.json',
      errorMessage: null,
      warnings: [],
    };
    render(<ExportCard />);

    const link = screen.getByRole('link', { name: /download pack/i });
    expect(link.getAttribute('href')).toBe('/api/v1/privacy/export/exp_abc/download');
    /* 服务端路径绝不能出现在页面上。 */
    expect(document.body.innerHTML).not.toContain('file://');
    expect(document.body.innerHTML).not.toContain('/var/lib/chrono');
  });

  it('exportId 含特殊字符时被正确编码（不产生路径注入）', () => {
    mockState = {
      phase: 'ready', exportId: 'exp/../../admin', downloadUrl: 'https://x.test/p.json',
      errorMessage: null, warnings: [],
    };
    render(<ExportCard />);

    const link = screen.getByRole('link', { name: /download pack/i });
    expect(link.getAttribute('href')).toBe('/api/v1/privacy/export/exp%2F..%2F..%2Fadmin/download');
  });

  it('partial：既给下载入口，也列出 warnings', () => {
    mockState = {
      phase: 'partial', exportId: 'exp_p', downloadUrl: 'file:///tmp/p.json',
      errorMessage: null,
      warnings: [{ code: 'MEMORY_PARTIAL', messageId: 'export.warning.memoryPartial' }],
    };
    render(<ExportCard />);

    /* 该 href 必须是服务端**接受 partial 状态**的端点。
     * 此前这条断言只比对了字符串，而端点当时硬拒非 completed——等于用测试把
     * 「点了必得 409」这个 bug 焊死。服务端侧的对应断言见
     * src/test/integration/privacy-business-audit.test.ts「partial 状态可下载」。 */
    expect(screen.getByRole('link', { name: /download partial pack/i }).getAttribute('href'))
      .toBe('/api/v1/privacy/export/exp_p/download');
    expect(screen.getByText('export.warning.memoryPartial')).toBeTruthy();
  });

  it('partial 但无产物：不显示下载按钮，warnings 仍要显示', () => {
    mockState = {
      phase: 'partial', exportId: 'exp_none', downloadUrl: null, errorMessage: null,
      warnings: [{ code: 'ALL_FAILED', messageId: 'export.warning.allFailed' }],
    };
    render(<ExportCard />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('export.warning.allFailed')).toBeTruthy();
  });

  it('ready 但无产物：不显示下载按钮（不产生死链）', () => {
    mockState = {
      phase: 'ready', exportId: 'exp_x', downloadUrl: null, errorMessage: null, warnings: [],
    };
    render(<ExportCard />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
