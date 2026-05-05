/**
 * 工具注册中心
 *
 * 启动期把所有 ToolAdapter 注册进来；ToolInvocationPipeline 按 toolId 路由。
 * 注册中心是不可变的（启动后冻结），避免运行时被恶意修改。
 */

import type { ToolAdapter } from './tool-adapter.js';

export class ToolRegistry {
  private readonly adapters = new Map<string, ToolAdapter>();
  private frozen = false;

  register(adapter: ToolAdapter): void {
    if (this.frozen) {
      throw new Error(`ToolRegistry 已冻结，无法注册 ${adapter.metadata.id}`);
    }
    if (this.adapters.has(adapter.metadata.id)) {
      throw new Error(`工具 ${adapter.metadata.id} 已注册`);
    }
    this.adapters.set(adapter.metadata.id, adapter);
  }

  freeze(): void {
    this.frozen = true;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  get(toolId: string): ToolAdapter | undefined {
    return this.adapters.get(toolId);
  }

  list(): ToolAdapter[] {
    return [...this.adapters.values()];
  }

  has(toolId: string): boolean {
    return this.adapters.has(toolId);
  }
}
