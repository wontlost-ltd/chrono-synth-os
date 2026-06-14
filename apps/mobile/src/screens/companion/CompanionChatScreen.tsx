/**
 * 移动端 ChronoCompanion ·「跟 TA 聊聊」对话（ADR-0047「跑为你拥有的人格」C 端落地）。
 *
 * **运行时零 LLM**：回应由确定性离线回应器据人格叙事 + 自己沉淀的记忆生成。离线/无云仍能聊；
 * 无相关记忆时诚实告知，不瞎编。是 web ChatView 的 RN 平行实现。
 */

import { useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { companionChat } from '../../companion/companionApi';
import type { CompanionScreenProps } from './CompanionHomeScreen';

const MAX_LEN = 2000;

interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'persona';
  readonly text: string;
  readonly grounded?: boolean;
}

let seq = 0;
const nextId = (): string => `m${seq++}`;

export function CompanionChatScreen(_props: CompanionScreenProps) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [text, setText] = useState('');

  const mutation = useMutation({
    mutationFn: (message: string) => companionChat(message),
    onSuccess: (res) => {
      setMessages((prev) => [...prev, { id: nextId(), role: 'persona', text: res.reply, grounded: res.groundedMemoryCount > 0 }]);
    },
  });

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= MAX_LEN && !mutation.isPending;

  function onSend(): void {
    if (!canSend) return;
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: trimmed }]);
    mutation.mutate(trimmed);
    setText('');
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {messages.length === 0 ? (
          <Text style={styles.empty}>说点什么吧。试试问它你和它聊过、教过的事。</Text>
        ) : (
          messages.map((m) => (
            <View key={m.id} style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubblePersona]}>
              <Text style={m.role === 'user' ? styles.textUser : styles.textPersona}>{m.text}</Text>
              {m.role === 'persona' && (
                <Text style={styles.meta}>{m.grounded ? '据我记得的' : '我还不了解这个'}</Text>
              )}
            </View>
          ))
        )}
        {mutation.isError && <Text style={styles.error}>发送失败，请检查网络后重试。</Text>}
      </ScrollView>

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="跟你的数字人说点什么……"
          placeholderTextColor="#94A3B8"
          multiline
          maxLength={MAX_LEN}
          editable={!mutation.isPending}
          accessibilityLabel="对数字人说的话"
        />
        <Pressable
          style={[styles.send, !canSend && styles.sendDisabled]}
          disabled={!canSend}
          onPress={onSend}
          accessibilityRole="button"
        >
          <Text style={styles.sendText}>{mutation.isPending ? '思考中…' : '发送'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  log: { flex: 1 },
  logContent: { padding: 16, gap: 10 },
  empty: { fontSize: 14, color: '#64748B', textAlign: 'center', marginTop: 32 },
  bubble: { maxWidth: '82%', borderRadius: 14, padding: 12 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#6366F1', borderBottomRightRadius: 4 },
  bubblePersona: { alignSelf: 'flex-start', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0', borderBottomLeftRadius: 4 },
  textUser: { fontSize: 15, color: '#FFFFFF' },
  textPersona: { fontSize: 15, color: '#1E293B' },
  meta: { fontSize: 12, color: '#94A3B8', marginTop: 6 },
  error: { fontSize: 14, color: '#DC2626', textAlign: 'center', marginTop: 8 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: '#E2E8F0', backgroundColor: '#FFFFFF' },
  input: { flex: 1, minHeight: 40, maxHeight: 120, borderWidth: 1, borderColor: '#C7D2FE', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15, color: '#1E293B', backgroundColor: '#F8FAFC' },
  send: { backgroundColor: '#6366F1', borderRadius: 999, paddingVertical: 10, paddingHorizontal: 18 },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
});
