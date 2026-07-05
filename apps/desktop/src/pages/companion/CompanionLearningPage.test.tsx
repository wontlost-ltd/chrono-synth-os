import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({
  getLlmSettings: vi.fn(),
  putLlmSettings: vi.fn(),
  resetLlmSettings: vi.fn(),
  reflect: vi.fn(),
  perceive: vi.fn(),
}));
vi.mock('@/companion/learning-data', () => ({
  getLlmSettings: api.getLlmSettings,
  putLlmSettings: api.putLlmSettings,
  resetLlmSettings: api.resetLlmSettings,
  reflect: api.reflect,
  perceive: api.perceive,
  PERCEIVE_MAX_LEN: 4000,
}));

import { CompanionLearningPage } from './CompanionLearningPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CompanionLearningPage />
    </QueryClientProvider>,
  );
}

const BASE_SETTINGS = {
  activeProvider: 'ollama', model: null, baseUrl: null,
  hasApiKey: false, canStoreApiKey: true, globalProvider: 'mock',
};

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getLlmSettings.mockResolvedValue(BASE_SETTINGS);
  api.putLlmSettings.mockResolvedValue(undefined);
  api.resetLlmSettings.mockResolvedValue(undefined);
  api.reflect.mockResolvedValue({ candidatesIngested: 0, reason: 'no_material' });
  api.perceive.mockResolvedValue({ perceivedMemories: [], perceivedBy: 'deterministic' });
});

describe('CompanionLearningPage（LLM 老师学习）', () => {
  it('载入已存配置 + 保存调 putLlmSettings', async () => {
    api.getLlmSettings.mockResolvedValue({ ...BASE_SETTINGS, activeProvider: 'openai', baseUrl: 'https://gw.x/v1', canStoreApiKey: true });
    renderPage();
    /* 等 useEffect 把已存配置灌进表单（「当前生效：openai」仅在 settings 载入后出现，且 baseUrl 也已同步）。 */
    await waitFor(() => expect(screen.getByText(/当前生效：openai/)).toBeInTheDocument());
    await waitFor(() => expect((screen.getByDisplayValue('https://gw.x/v1'))).toBeInTheDocument());
    fireEvent.click(screen.getByText('保存老师配置'));
    await waitFor(() => expect(api.putLlmSettings).toHaveBeenCalledTimes(1));
    expect(api.putLlmSettings.mock.calls[0][0]).toMatchObject({ provider: 'openai', baseUrl: 'https://gw.x/v1' });
  });

  it('canStoreApiKey=false → key 输入禁用 + 提示改用 ollama/自定义端点', async () => {
    api.getLlmSettings.mockResolvedValue({ ...BASE_SETTINGS, activeProvider: 'openai', canStoreApiKey: false });
    renderPage();
    await waitFor(() => expect(screen.getByText(/无法保存 API key|未启用凭据加密/)).toBeInTheDocument());
  });

  it('反思 → 调 reflect + 渲染结果', async () => {
    api.reflect.mockResolvedValue({ candidatesIngested: 3, compiled: 2, pending: 1 });
    renderPage();
    await waitFor(() => screen.getByText('让它反思一次'));
    fireEvent.click(screen.getByText('让它反思一次'));
    await waitFor(() => expect(api.reflect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/产出 3 条成长候选/)).toBeInTheDocument();
  });

  it('喂料 → 调 perceive + 区分真老师/确定性回退', async () => {
    api.perceive.mockResolvedValue({
      perceivedMemories: [{ id: 'm1', content: '我听到：今天很累', valence: -0.2, salience: 0.6 }],
      perceivedBy: 'teacher',
    });
    renderPage();
    await waitFor(() => screen.getByLabelText('喂料输入'));
    fireEvent.change(screen.getByLabelText('喂料输入'), { target: { value: '今天开会很累' } });
    fireEvent.click(screen.getByText('喂给它'));
    await waitFor(() => expect(api.perceive).toHaveBeenCalledWith('audio', '今天开会很累'));
    expect(await screen.findByText(/真 LLM 老师解读/)).toBeInTheDocument();
    expect(screen.getByText('我听到：今天很累')).toBeInTheDocument();
  });

  it('已配 key → 显示撤销按钮，点击调 putLlmSettings apiKey=\'\'', async () => {
    api.getLlmSettings.mockResolvedValue({ ...BASE_SETTINGS, activeProvider: 'openai', hasApiKey: true, canStoreApiKey: true });
    renderPage();
    /* 等 useEffect 把 provider 灌进表单（「当前生效：openai」仅在 settings 载入后出现）再点撤销——
     * 否则表单 provider 仍是默认 ollama，撤销会带错 provider。 */
    await waitFor(() => expect(screen.getByText(/当前生效：openai/)).toBeInTheDocument());
    fireEvent.click(await screen.findByText('撤销已存 key'));
    await waitFor(() => expect(api.putLlmSettings).toHaveBeenCalledTimes(1));
    expect(api.putLlmSettings.mock.calls[0][0]).toMatchObject({ provider: 'openai', apiKey: '' });
  });

  it('未配 key → 不显示撤销按钮', async () => {
    api.getLlmSettings.mockResolvedValue({ ...BASE_SETTINGS, activeProvider: 'openai', hasApiKey: false, canStoreApiKey: true });
    renderPage();
    await waitFor(() => screen.getByText('保存老师配置'));
    expect(screen.queryByText('撤销已存 key')).not.toBeInTheDocument();
  });

  it('空材料不喂', async () => {
    renderPage();
    await waitFor(() => screen.getByLabelText('喂料输入'));
    fireEvent.change(screen.getByLabelText('喂料输入'), { target: { value: '   ' } });
    expect((screen.getByText('喂给它') as HTMLButtonElement).disabled).toBe(true);
  });
});
