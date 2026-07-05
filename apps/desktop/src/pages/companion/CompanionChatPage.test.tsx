import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/* mock 对话数据层——验 UI 行为（发送/渲染回应/来源标签/错误），不打真后端。 */
const chatMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/companion/chat-data', () => ({
  chatWithCompanion: chatMock.fn,
  CHAT_MESSAGE_MAX_LEN: 2000,
}));

import { CompanionChatPage } from './CompanionChatPage';
import { ApiHttpError, ApiNotConfiguredError } from '@/bridge/http-client';

beforeEach(() => {
  chatMock.fn.mockReset();
});

function typeAndSend(msg: string): void {
  fireEvent.change(screen.getByLabelText('消息输入'), { target: { value: msg } });
  fireEvent.click(screen.getByText('发送'));
}

describe('CompanionChatPage（零-LLM 对话 UI）', () => {
  it('发送 → 渲染用户消息 + 数字人回应 + 来源标签', async () => {
    chatMock.fn.mockResolvedValue({ reply: '我叫小明。', kind: 'self_identity', confidence: 0.9, groundedMemoryCount: 0 });
    render(<CompanionChatPage />);
    typeAndSend('你叫什么名字');
    expect(await screen.findByText('你叫什么名字')).toBeInTheDocument();
    expect(await screen.findByText('我叫小明。')).toBeInTheDocument();
    expect(screen.getByText('这是我自己')).toBeInTheDocument(); // self_identity 来源标签
    expect(chatMock.fn).toHaveBeenCalledWith('你叫什么名字');
  });

  it('knowledge_grounded → 来源标「据我记得的」', async () => {
    chatMock.fn.mockResolvedValue({ reply: '据记忆答', kind: 'knowledge_grounded', confidence: 0.7, groundedMemoryCount: 2 });
    render(<CompanionChatPage />);
    typeAndSend('讲讲那件事');
    expect(await screen.findByText('据我记得的')).toBeInTheDocument();
  });

  it('honest_offline 无据 → 来源标「我还不了解这个」', async () => {
    chatMock.fn.mockResolvedValue({ reply: '不了解', kind: 'honest_offline', confidence: 0.3, groundedMemoryCount: 0 });
    render(<CompanionChatPage />);
    typeAndSend('随便问');
    expect(await screen.findByText('我还不了解这个')).toBeInTheDocument();
  });

  it('空白/仅空格不发送', () => {
    render(<CompanionChatPage />);
    fireEvent.change(screen.getByLabelText('消息输入'), { target: { value: '   ' } });
    expect((screen.getByText('发送') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('发送'));
    expect(chatMock.fn).not.toHaveBeenCalled();
  });

  it('403 → 提示对话面向个人版', async () => {
    chatMock.fn.mockRejectedValue(new ApiHttpError(403, 'X', 'HTTP 403'));
    render(<CompanionChatPage />);
    typeAndSend('hi');
    expect(await screen.findByRole('alert')).toHaveTextContent('对话面向个人版');
  });

  it('未配置 → 提示本地引擎未就绪', async () => {
    chatMock.fn.mockRejectedValue(new ApiNotConfiguredError());
    render(<CompanionChatPage />);
    typeAndSend('hi');
    expect(await screen.findByRole('alert')).toHaveTextContent('本地引擎尚未就绪');
  });
});
