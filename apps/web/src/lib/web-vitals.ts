/**
 * Core Web Vitals 采集与上报
 * 将 LCP / CLS / INP / FCP / TTFB 指标发送到 Sentry 作为自定义度量
 */

import type { Metric } from 'web-vitals';
import * as Sentry from '@sentry/react';

function sendToSentry(metric: Metric): void {
  if (metric.name === 'CLS') {
    Sentry.setMeasurement(metric.name, metric.value, 'none');
  } else {
    Sentry.setMeasurement(metric.name, metric.value, 'millisecond');
  }
}

export function reportWebVitals(): void {
  if (import.meta.env.DEV) return;

  import('web-vitals')
    .then(({ onCLS, onINP, onLCP, onFCP, onTTFB }) => {
      onCLS(sendToSentry);
      onINP(sendToSentry);
      onLCP(sendToSentry);
      onFCP(sendToSentry);
      onTTFB(sendToSentry);
    })
    .catch(() => { /* 加载失败时静默忽略 */ });
}
