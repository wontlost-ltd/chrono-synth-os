/**
 * 浏览器 Web Speech API（语音转写）的纯逻辑与最小类型声明（深化感知 3/3）。
 *
 * 论点红线（ADR-0051）：**ASR 在设备端做**，服务端只收已脱离音频的 transcript（文本表征）。
 * 原始音频从不离开浏览器——SpeechRecognition 直接在端侧把语音转成文字，我们只把文字交给 perceive。
 *
 * 本文件刻意把所有「可单测的决策逻辑」抽成纯函数（结果合并、错误映射、能力探测），
 * React hook（useSpeechRecognition）只做事件接线。Web Speech 的类型不在标准 DOM lib 里，
 * 这里补最小声明（只声明我们真正用到的面），不引第三方 @types。
 */

/* ── 最小 Web Speech 类型声明（只覆盖用到的字段） ───────────────────────────── */

/** 单条识别候选。 */
export interface SpeechAlternative {
  readonly transcript: string;
}

/** 一段识别结果（isFinal 区分「定稿」与「临时假设」）。 */
export interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  item(index: number): SpeechAlternative;
  readonly [index: number]: SpeechAlternative;
}

/** 结果列表（onresult 事件携带）。 */
export interface SpeechResultList {
  readonly length: number;
  item(index: number): SpeechResult;
  readonly [index: number]: SpeechResult;
}

/** onresult 事件：resultIndex 起到 results.length 是本次新增/更新的结果。 */
export interface SpeechRecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}

/** onerror 事件：error 是错误码字符串（'no-speech' | 'not-allowed' | …）。 */
export interface SpeechRecognitionErrorEvent {
  readonly error: string;
}

/** SpeechRecognition 实例面（只声明我们接的事件与方法）。 */
export interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

/** 构造器面。 */
export type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

/* ── 纯逻辑 ──────────────────────────────────────────────────────────────── */

/** 从 window 取 SpeechRecognition 构造器（标准名优先，回退 webkit 前缀）；不支持返回 null。 */
export function pickSpeechRecognitionCtor(
  win: Partial<Record<'SpeechRecognition' | 'webkitSpeechRecognition', SpeechRecognitionCtor>>,
): SpeechRecognitionCtor | null {
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

/** 当前环境是否支持设备端语音识别。 */
export function isSpeechRecognitionSupported(
  win: Partial<Record<'SpeechRecognition' | 'webkitSpeechRecognition', SpeechRecognitionCtor>>,
): boolean {
  return pickSpeechRecognitionCtor(win) !== null;
}

/** transcript 的两段构成：已定稿（final，累加不变）+ 临时（interim，随说话刷新）。 */
export interface TranscriptParts {
  /** 已定稿文本（onresult 里 isFinal 的片段累加）。 */
  readonly final: string;
  /** 当前临时假设（下一次 onresult 会被覆盖；停说话定稿后清空）。 */
  readonly interim: string;
}

export const EMPTY_TRANSCRIPT: TranscriptParts = { final: '', interim: '' };

/**
 * 把一次 onresult 事件归并进既有 transcript：
 *   - 从 resultIndex 起遍历本批结果；
 *   - isFinal 的片段**追加**到 final（定稿后不再变）；
 *   - 非 final 的片段拼成新的 interim（整体替换旧 interim——它是「当前假设」）。
 * 纯函数：给定旧状态 + 事件 → 新状态，便于单测覆盖增量合并这一最易回归处。
 */
export function reduceSpeechResult(prev: TranscriptParts, ev: SpeechRecognitionResultEvent): TranscriptParts {
  let appendedFinal = '';
  let interim = '';
  for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
    const result = ev.results.item(i);
    const text = result.item(0).transcript;
    if (result.isFinal) appendedFinal += text;
    else interim += text;
  }
  return { final: prev.final + appendedFinal, interim };
}

/** 合成可提交文本：final + 当前 interim（拼成用户所见的完整一段）。 */
export function joinTranscript(parts: TranscriptParts): string {
  return (parts.final + parts.interim).trim();
}

/**
 * Web Speech 错误码 → 中文用户文案。
 *   - not-allowed / service-not-allowed：用户拒了麦克风权限。
 *   - no-speech：没听到说话。
 *   - audio-capture：没有可用麦克风。
 *   - network：识别服务网络问题（部分实现走云端识别）。
 *   - aborted：用户主动停止——不算错误，返回 null（不弹错）。
 */
export function mapSpeechError(code: string): string | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限被拒绝，请在浏览器允许后重试。';
    case 'no-speech':
      return '没有听到说话，请再试一次。';
    case 'audio-capture':
      return '找不到可用的麦克风。';
    case 'network':
      return '语音识别网络异常，请稍后重试。';
    default:
      return '语音识别出错了，请改用文字输入。';
  }
}
