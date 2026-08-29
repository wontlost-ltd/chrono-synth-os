import type { DomainEvent, EventPublisher, EventSubscriber, Unsubscribe } from '@chrono/kernel';
import { MemoryEventBus } from '@chrono/kernel';

/**
 * Node 运行时事件发布适配器
 * 使用 kernel MemoryEventBus，不依赖 node:events，无 as any 类型转换
 */
export class NodeEventPublisher implements EventPublisher, EventSubscriber {
  /**
   * ⚠️ 审计 #409：注入错误回调，让被隔离的订阅方异常**可见**。
   *
   * 隔离本身是必须的（publish 在 COMMIT 之后，抛错会让调用方误以为写失败而
   * 重试已提交的事务），但「隔离」不等于「假装没发生」——投影器坏掉必须留痕，
   * 否则就是本仓反复出现的「静默失败」：功能悄悄不工作、无告警、测试也测不出。
   *
   * 这里用 console.error 而非注入 Logger：本类是最底层的事件适配器，
   * 生产装配处（app.ts:323）不持有 logger；且投递失败属于必须让运维看到的
   * 硬故障，stderr 是最不可能被吞掉的通道。
   */
  private readonly bus = new MemoryEventBus((event, err) => {
    // eslint-disable-next-line no-console
    console.error(
      `[NodeEventPublisher] 订阅方处理事件 "${event.type}" 抛出异常，已隔离（其余订阅方与后续事件照常投递）：`,
      err,
    );
  });

  async publish(events: readonly DomainEvent[]): Promise<void> {
    await this.bus.publish(events);
  }

  subscribe<T extends DomainEvent>(
    type: T['type'],
    listener: (event: T) => void,
  ): Unsubscribe {
    return this.bus.subscribe(type, listener);
  }
}
