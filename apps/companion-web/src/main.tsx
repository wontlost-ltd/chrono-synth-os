import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App.js';
import './styles.css';

/* 注册 Service Worker（PWA 离线 + 自动更新）。vite-plugin-pwa 在 dev 默认不启用，生产构建生效。 */
registerSW({ immediate: true });

const container = document.getElementById('root');
if (!container) throw new Error('#root 容器缺失');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
