export * from './domain-events.js';
export { MemoryEventBus } from './memory-event-bus.js';
/* 审计 #409：订阅方异常回调的类型 —— 宿主（NodeEventPublisher）注入时需要它。 */
export type { EventListenerErrorHandler } from './memory-event-bus.js';
