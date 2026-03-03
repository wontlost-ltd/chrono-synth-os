/**
 * 移动端模拟向导屏幕
 */

import { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { apiFetch } from '../api/client';

type Step = 'template' | 'values' | 'confirm';

interface Template {
  id: string;
  label: string;
  description: string;
  defaults: Array<{ dimension: string; weight: number }>;
}

const TEMPLATES: Template[] = [
  {
    id: 'career',
    label: 'Career Focus',
    description: 'Optimize for professional growth and financial stability',
    defaults: [
      { dimension: 'career_growth', weight: 0.35 },
      { dimension: 'financial_stability', weight: 0.30 },
      { dimension: 'work_life_balance', weight: 0.20 },
      { dimension: 'personal_fulfillment', weight: 0.15 },
    ],
  },
  {
    id: 'family',
    label: 'Family First',
    description: 'Prioritize relationships and family well-being',
    defaults: [
      { dimension: 'family_wellbeing', weight: 0.35 },
      { dimension: 'financial_stability', weight: 0.25 },
      { dimension: 'work_life_balance', weight: 0.25 },
      { dimension: 'personal_fulfillment', weight: 0.15 },
    ],
  },
  {
    id: 'explorer',
    label: 'Explorer',
    description: 'Maximize new experiences and personal growth',
    defaults: [
      { dimension: 'personal_fulfillment', weight: 0.30 },
      { dimension: 'new_experiences', weight: 0.30 },
      { dimension: 'career_growth', weight: 0.20 },
      { dimension: 'financial_stability', weight: 0.20 },
    ],
  },
];

export function SimulationWizardScreen() {
  const [step, setStep] = useState<Step>('template');
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [values, setValues] = useState<Array<{ dimension: string; weight: number }>>([]);
  const [horizonYears, setHorizonYears] = useState('10');

  const runMutation = useMutation({
    mutationFn: (payload: { horizonYears: number; values: Array<{ dimension: string; weight: number }> }) =>
      apiFetch('/api/v1/decisions/simulate', { method: 'POST', body: JSON.stringify(payload) }),
  });

  const selectTemplate = (t: Template) => {
    setSelectedTemplate(t);
    setValues(t.defaults.map(d => ({ ...d })));
    setStep('values');
  };

  const updateWeight = (index: number, text: string) => {
    const num = parseFloat(text);
    if (Number.isNaN(num)) return;
    setValues(prev => prev.map((v, i) => (i === index ? { ...v, weight: Math.max(0, Math.min(1, num)) } : v)));
  };

  const submit = () => {
    runMutation.mutate({ horizonYears: parseInt(horizonYears, 10) || 10, values });
  };

  if (runMutation.isSuccess) {
    return (
      <View style={styles.center}>
        <Text style={styles.successTitle}>Simulation Complete</Text>
        <Text style={styles.successText}>Your life paths have been generated. Check the dashboard for results.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {step === 'template' && (
        <>
          <Text style={styles.title}>Choose a Template</Text>
          <Text style={styles.subtitle}>Select a starting point for your simulation</Text>
          {TEMPLATES.map(t => (
            <TouchableOpacity key={t.id} style={styles.templateCard} onPress={() => selectTemplate(t)}>
              <Text style={styles.templateName}>{t.label}</Text>
              <Text style={styles.templateDesc}>{t.description}</Text>
            </TouchableOpacity>
          ))}
        </>
      )}

      {step === 'values' && (
        <>
          <Text style={styles.title}>Adjust Weights</Text>
          <Text style={styles.subtitle}>{selectedTemplate?.label} template — fine-tune your priorities</Text>
          {values.map((v, i) => (
            <View key={v.dimension} style={styles.valueRow}>
              <Text style={styles.dimensionLabel}>{v.dimension.replace(/_/g, ' ')}</Text>
              <TextInput
                style={styles.weightInput}
                keyboardType="decimal-pad"
                value={v.weight.toFixed(2)}
                onChangeText={text => updateWeight(i, text)}
              />
            </View>
          ))}
          <View style={styles.horizonRow}>
            <Text style={styles.dimensionLabel}>Horizon (years)</Text>
            <TextInput
              style={styles.weightInput}
              keyboardType="number-pad"
              value={horizonYears}
              onChangeText={setHorizonYears}
            />
          </View>
          <View style={styles.navRow}>
            <TouchableOpacity style={styles.backButton} onPress={() => setStep('template')}>
              <Text style={styles.backButtonText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.nextButton} onPress={() => setStep('confirm')}>
              <Text style={styles.nextButtonText}>Review</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {step === 'confirm' && (
        <>
          <Text style={styles.title}>Confirm Simulation</Text>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>Template: {selectedTemplate?.label}</Text>
            <Text style={styles.summaryLabel}>Horizon: {horizonYears} years</Text>
            {values.map(v => (
              <Text key={v.dimension} style={styles.summaryItem}>
                {v.dimension.replace(/_/g, ' ')}: {v.weight.toFixed(2)}
              </Text>
            ))}
          </View>
          <View style={styles.navRow}>
            <TouchableOpacity style={styles.backButton} onPress={() => setStep('values')}>
              <Text style={styles.backButtonText}>Back</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.submitButton, runMutation.isPending && styles.disabledButton]}
              onPress={submit}
              disabled={runMutation.isPending}
            >
              <Text style={styles.nextButtonText}>{runMutation.isPending ? 'Running...' : 'Run Simulation'}</Text>
            </TouchableOpacity>
          </View>
          {runMutation.isError && (
            <Text style={styles.errorText}>Error: {(runMutation.error as Error).message}</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFC' },
  content: { padding: 16, paddingBottom: 32 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  title: { fontSize: 22, fontWeight: 'bold', color: '#1E293B', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#64748B', marginBottom: 16 },
  templateCard: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: '#E2E8F0' },
  templateName: { fontSize: 16, fontWeight: '600', color: '#1E3A8A' },
  templateDesc: { fontSize: 13, color: '#64748B', marginTop: 4 },
  valueRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  dimensionLabel: { fontSize: 14, color: '#334155', textTransform: 'capitalize', flex: 1 },
  weightInput: { width: 64, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, textAlign: 'center', fontSize: 14, color: '#1E293B' },
  horizonRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, marginTop: 8 },
  navRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  backButton: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10, borderWidth: 1, borderColor: '#CBD5E1' },
  backButtonText: { fontSize: 15, color: '#64748B', fontWeight: '500' },
  nextButton: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10, backgroundColor: '#1E3A8A' },
  nextButtonText: { fontSize: 15, color: '#FFFFFF', fontWeight: '600' },
  submitButton: { paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10, backgroundColor: '#16A34A' },
  disabledButton: { opacity: 0.5 },
  summaryCard: { backgroundColor: '#FFFFFF', borderRadius: 12, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#E2E8F0' },
  summaryLabel: { fontSize: 15, fontWeight: '600', color: '#1E293B', marginBottom: 6 },
  summaryItem: { fontSize: 13, color: '#475569', marginBottom: 4, textTransform: 'capitalize' },
  successTitle: { fontSize: 22, fontWeight: 'bold', color: '#16A34A', marginBottom: 8 },
  successText: { fontSize: 15, color: '#64748B', textAlign: 'center' },
  errorText: { fontSize: 13, color: '#B91C1C', marginTop: 8, textAlign: 'center' },
});
