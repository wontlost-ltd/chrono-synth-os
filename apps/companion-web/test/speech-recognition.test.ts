/**
 * 单元测试：companion-web 设备端语音识别的纯逻辑（speech-recognition.ts）。
 *
 * 覆盖最易回归的三处：① onresult 增量合并（final 累加 / interim 整体替换）；② 错误码→中文映射
 * （含 aborted 不弹错）；③ 能力探测（标准名优先、回退 webkit、都无→不支持）。
 * 用 node:test + 原生 TS（Node type-strip）；构造假 onresult 事件，不依赖浏览器/jsdom。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickSpeechRecognitionCtor,
  isSpeechRecognitionSupported,
  reduceSpeechResult,
  joinTranscript,
  mapSpeechError,
  EMPTY_TRANSCRIPT,
  type SpeechRecognitionResultEvent,
  type SpeechRecognitionCtor,
} from '../src/speech-recognition.ts';

/** 造一个 onresult 事件：results[i] = { isFinal, transcript }。 */
function makeEvent(resultIndex: number, results: Array<{ isFinal: boolean; transcript: string }>): SpeechRecognitionResultEvent {
  const list = {
    length: results.length,
    item: (i: number) => buildResult(results[i]),
  } as SpeechRecognitionResultEvent['results'];
  /* 数字索引访问也要可用（reduceSpeechResult 用 item()，但保持形状完整）。 */
  results.forEach((r, i) => { (list as unknown as Record<number, unknown>)[i] = buildResult(r); });
  return { resultIndex, results: list };
}

function buildResult(r: { isFinal: boolean; transcript: string }): ReturnType<SpeechRecognitionResultEvent['results']['item']> {
  const alt = { transcript: r.transcript };
  return {
    isFinal: r.isFinal,
    length: 1,
    item: () => alt,
    0: alt,
  } as ReturnType<SpeechRecognitionResultEvent['results']['item']>;
}

const FakeCtor = function (this: unknown) {} as unknown as SpeechRecognitionCtor;

test('reduceSpeechResult：interim 整体替换（说话过程中假设不断刷新）', () => {
  let parts = EMPTY_TRANSCRIPT;
  parts = reduceSpeechResult(parts, makeEvent(0, [{ isFinal: false, transcript: '今天' }]));
  assert.deepEqual(parts, { final: '', interim: '今天' });
  /* 下一帧 interim 刷新——不是追加，是替换。 */
  parts = reduceSpeechResult(parts, makeEvent(0, [{ isFinal: false, transcript: '今天开会' }]));
  assert.deepEqual(parts, { final: '', interim: '今天开会' });
});

test('reduceSpeechResult：isFinal 片段累加进 final，interim 清空', () => {
  let parts = reduceSpeechResult(EMPTY_TRANSCRIPT, makeEvent(0, [{ isFinal: false, transcript: '今天开会' }]));
  parts = reduceSpeechResult(parts, makeEvent(0, [{ isFinal: true, transcript: '今天开会很累。' }]));
  assert.deepEqual(parts, { final: '今天开会很累。', interim: '' });
});

test('reduceSpeechResult：定稿后继续说，final 累加而非覆盖', () => {
  let parts = reduceSpeechResult(EMPTY_TRANSCRIPT, makeEvent(0, [{ isFinal: true, transcript: '今天开会很累。' }]));
  /* 真实 onresult：results 是累计列表，resultIndex 指向本次新增的尾部（索引 1）。
   * 已定稿的索引 0 仍在列表里，但从 resultIndex=1 起遍历，不会重复累加它。 */
  parts = reduceSpeechResult(parts, makeEvent(1, [
    { isFinal: true, transcript: '今天开会很累。' },
    { isFinal: true, transcript: '回家想安静。' },
  ]));
  assert.equal(parts.final, '今天开会很累。回家想安静。');
});

test('joinTranscript：合并 final + interim 并去首尾空白', () => {
  assert.equal(joinTranscript({ final: '今天开会很累。', interim: '回家' }), '今天开会很累。回家');
  assert.equal(joinTranscript(EMPTY_TRANSCRIPT), '');
});

test('mapSpeechError：aborted 不算错（用户主动停）→ null', () => {
  assert.equal(mapSpeechError('aborted'), null);
});

test('mapSpeechError：权限/无麦/无语音/网络/未知 都有中文文案', () => {
  assert.match(mapSpeechError('not-allowed') ?? '', /权限/);
  assert.match(mapSpeechError('service-not-allowed') ?? '', /权限/);
  assert.match(mapSpeechError('audio-capture') ?? '', /麦克风/);
  assert.match(mapSpeechError('no-speech') ?? '', /没有听到/);
  assert.match(mapSpeechError('network') ?? '', /网络/);
  assert.match(mapSpeechError('something-weird') ?? '', /文字输入/);
});

test('pickSpeechRecognitionCtor：标准名优先于 webkit 前缀', () => {
  const std = FakeCtor;
  const webkit = (function () {} as unknown) as SpeechRecognitionCtor;
  assert.equal(pickSpeechRecognitionCtor({ SpeechRecognition: std, webkitSpeechRecognition: webkit }), std);
  assert.equal(pickSpeechRecognitionCtor({ webkitSpeechRecognition: webkit }), webkit);
  assert.equal(pickSpeechRecognitionCtor({}), null);
});

test('isSpeechRecognitionSupported：有任一构造器即支持，都无则不支持', () => {
  assert.equal(isSpeechRecognitionSupported({ SpeechRecognition: FakeCtor }), true);
  assert.equal(isSpeechRecognitionSupported({ webkitSpeechRecognition: FakeCtor }), true);
  assert.equal(isSpeechRecognitionSupported({}), false);
});
