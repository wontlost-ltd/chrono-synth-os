/**
 * 移动端 ChronoCompanion ·「让 TA 听一段」感知（ADR-0046 Phase 2.3 + ADR-0051 感知层）。
 *
 * 把一段经历（文本表征）交给数字人 → 服务端确定性感知蒸馏器沉淀为记忆 + 经蒸馏门产成长候选 →
 * 第一人称反馈「我记住了什么」。是 #109 web PerceiveView 的 RN 平行实现。
 *
 * 论点红线（ADR-0051）：服务端只收文本表征，不接收原始媒体。移动端当前是**文本输入**——RN 无
 * 浏览器 Web Speech API，语音输入是后续 expo-speech 增量（届时仍只把转写文本交给 perceive）。
 */

import { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PERCEIVE_REPRESENTATION_MAX_LEN, type CompanionPerceiveResultV1 } from '@chrono/contracts';
import { companionPerceive } from '../../companion/companionApi';
import type { CompanionScreenProps } from './CompanionHomeScreen';

export function CompanionPerceiveScreen({ accountKey }: CompanionScreenProps) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [result, setResult] = useState<CompanionPerceiveResultV1 | null>(null);

  const mutation = useMutation({
    mutationFn: (representation: string) => companionPerceive({ modality: 'audio', representation }),
    onSuccess: (data) => {
      setResult(data);
      setText('');
      /* 感知写了新记忆——让「我的数字人」「记忆」页下次进入时重取（缓存按账号隔离）。 */
      void queryClient.invalidateQueries({ queryKey: ['companion', accountKey] });
    },
  });

  const trimmed = text.trim();
  const tooLong = text.length > PERCEIVE_REPRESENTATION_MAX_LEN;
  const canSubmit = trimmed.length > 0 && !tooLong && !mutation.isPending;

  function onSubmit(): void {
    if (!canSubmit) return;
    setResult(null);
    mutation.mutate(trimmed);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>让 TA 听一段</Text>
        <Text style={styles.muted}>
          把一段经历交给你的数字人——它会以自己的视角理解，并把它记住。之后聊天时它能引用这段经历。
        </Text>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="例如：今天开会很累，但我没和别人说……"
          placeholderTextColor="#94A3B8"
          multiline
          maxLength={PERCEIVE_REPRESENTATION_MAX_LEN}
          editable={!mutation.isPending}
          accessibilityLabel="要让数字人感知的经历"
        />
        <View style={styles.actions}>
          <Text style={styles.counter}>{text.length}/{PERCEIVE_REPRESENTATION_MAX_LEN}</Text>
          <Pressable
            style={[styles.submit, !canSubmit && styles.submitDisabled]}
            disabled={!canSubmit}
            onPress={onSubmit}
            accessibilityRole="button"
          >
            <Text style={styles.submitText}>{mutation.isPending ? '我正在听…' : '让 TA 听'}</Text>
          </Pressable>
        </View>
        {tooLong && <Text style={styles.error}>这段太长了，请精简到 {PERCEIVE_REPRESENTATION_MAX_LEN} 字以内。</Text>}
        {mutation.isError && <Text style={styles.error}>感知失败，请检查网络后重试。</Text>}
      </View>

      {result && (
        <View style={styles.card} accessibilityLiveRegion="polite">
          {result.perceivedMemories.length === 0 ? (
            <Text style={styles.muted}>我没有从这段里听出可以记住的事。</Text>
          ) : (
            <>
              <Text style={styles.title}>我记住了</Text>
              {result.perceivedMemories.map((m) => (
                <View key={m.id} style={styles.memoryCard}>
                  <Text style={styles.memoryContent}>{m.content}</Text>
                </View>
              ))}
              {result.pendingApprovalCount > 0 && (
                <Text style={styles.muted}>
                  这段经历可能影响我对你的理解，但我不会自己改变——有 {result.pendingApprovalCount} 处会等你确认。
                </Text>
              )}
            </>
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20, marginBottom: 16, borderWidth: 1, borderColor: '#E2E8F0' },
  title: { fontSize: 18, fontWeight: '700', color: '#1E1B4B', marginBottom: 8 },
  muted: { fontSize: 14, color: '#64748B', lineHeight: 20, marginTop: 6 },
  input: {
    minHeight: 96, marginTop: 14, borderWidth: 1, borderColor: '#C7D2FE', borderRadius: 12,
    padding: 12, fontSize: 15, color: '#1E293B', backgroundColor: '#F8FAFC', textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  counter: { fontSize: 13, color: '#94A3B8' },
  submit: { backgroundColor: '#6366F1', borderRadius: 999, paddingVertical: 10, paddingHorizontal: 20 },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  error: { fontSize: 14, color: '#DC2626', marginTop: 8 },
  memoryCard: { backgroundColor: '#EEF2FF', borderRadius: 12, padding: 14, marginTop: 8, borderWidth: 1, borderColor: '#C7D2FE' },
  memoryContent: { fontSize: 14, color: '#1E293B' },
});
