/**
 * 系统事件总线
 * 全局单例，各层通过它进行松耦合通信
 */

import type { SystemEventMap } from '../types/events.js';
import { TypedEventEmitter } from './typed-event-emitter.js';

export class EventBus extends TypedEventEmitter<SystemEventMap> {}
