import { useCallback, useEffect, useRef, useState } from 'react';
import {
  pickSpeechRecognitionCtor,
  reduceSpeechResult,
  joinTranscript,
  mapSpeechError,
  EMPTY_TRANSCRIPT,
  type SpeechRecognitionInstance,
  type SpeechRecognitionCtor,
  type TranscriptParts,
} from './speech-recognition.js';

/** 设备端语音识别 hook 的对外状态（PerceiveView 据此渲染麦克风按钮 + 实时文本）。 */
export interface SpeechRecognitionState {
  /** 当前环境是否支持设备端 ASR（不支持则 PerceiveView 隐藏麦克风、只留文字输入）。 */
  readonly supported: boolean;
  /** 是否正在听。 */
  readonly listening: boolean;
  /** 实时合成文本（final + interim），随说话刷新。 */
  readonly transcript: string;
  /** 识别错误的中文文案（null 表示无错）。 */
  readonly error: string | null;
  /** 开始听（请求麦克风 + 启动识别）。 */
  start(): void;
  /** 停止听（定稿当前结果）。 */
  stop(): void;
}

/**
 * 设备端语音识别 hook（深化感知 3/3）。
 *
 * 论点红线（诚实表述）：**Chrono 服务端从不接收音频**——SpeechRecognition 在浏览器侧把语音转文字，
 * 本 hook 只对外暴露 transcript（文本表征），由 PerceiveView 交给 perceive()。⚠️ 不宣称「音频不离开
 * 设备」：Web Speech 不保证端侧识别，部分浏览器把音频送厂商语音服务（见 speech-recognition.ts 模块注释）。
 *
 * 纯决策逻辑（结果合并 / 错误映射 / 能力探测）全在 speech-recognition.ts（已单测）；本 hook
 * 只做浏览器事件接线与 React 状态。卸载/停止时 abort，避免泄漏识别会话。
 *
 * @param lang 识别语言（默认中文）。
 */
export function useSpeechRecognition(lang = 'zh-CN'): SpeechRecognitionState {
  const ctorRef = useRef<SpeechRecognitionCtor | null>(null);
  if (ctorRef.current === null && typeof window !== 'undefined') {
    ctorRef.current = pickSpeechRecognitionCtor(
      window as unknown as Record<'SpeechRecognition' | 'webkitSpeechRecognition', SpeechRecognitionCtor>,
    );
  }
  const supported = ctorRef.current !== null;

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const partsRef = useRef<TranscriptParts>(EMPTY_TRANSCRIPT);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  /* 卸载时中止识别会话（防止泄漏 + 卸载后回调写 state）。 */
  useEffect(() => {
    return () => {
      const rec = recognitionRef.current;
      if (rec) {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.abort();
        recognitionRef.current = null;
      }
    };
  }, []);

  const start = useCallback(() => {
    const Ctor = ctorRef.current;
    if (!Ctor || recognitionRef.current) return;
    partsRef.current = EMPTY_TRANSCRIPT;
    setTranscript('');
    setError(null);

    const rec = new Ctor();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    /* best-effort 表达本地处理偏好（实验性属性，部分浏览器才有；不保证不传音频——见模块注释）。 */
    if ('processLocally' in rec) rec.processLocally = true;
    rec.onresult = (ev) => {
      partsRef.current = reduceSpeechResult(partsRef.current, ev);
      setTranscript(joinTranscript(partsRef.current));
    };
    rec.onerror = (ev) => {
      const msg = mapSpeechError(ev.error);
      if (msg) setError(msg);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      /* start() 同步抛错（如已在识别中、设备不可用）：回滚状态，别卡在 listening。 */
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      recognitionRef.current = null;
      setListening(false);
      setError('无法启动语音识别，请改用文字输入。');
    }
  }, [lang]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  return { supported, listening, transcript, error, start, stop };
}
