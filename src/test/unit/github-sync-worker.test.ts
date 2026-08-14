/**
 * 单元测试：GithubSyncWorker（组织级驻留的周期驱动）。
 *
 * 断言重点：
 *   1. **默认关闭**——enabled:false 时 start() 不启定时器。这是会自动发出站请求并消耗
 *      LLM 老师额度的后台循环，对现有部署默认开启构成行为突变，必须显式启用。
 *   2. 重入守卫——上一轮未完不叠加（照 LearningWorker 同款手法）。
 *   3. 单轮异常隔离——驱动函数抛错不崩 worker、不向外冒泡（不影响后续周期）。
 *   4. 生命周期：start/stop/isHealthy 契约 + 重复 start 幂等。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GithubSyncWorker } from '../../integrations/github/github-sync-worker.js';
import { SilentLogger } from '../../utils/logger.js';

describe('GithubSyncWorker（组织级驻留周期驱动）', () => {
  it('默认关闭：enabled:false 时 start() 不启动定时器', () => {
    let driven = 0;
    const worker = new GithubSyncWorker(
      async () => { driven += 1; },
      new SilentLogger(),
      { enabled: false, intervalMs: 10 },
    );

    worker.start();

    assert.equal(worker.isHealthy(), false, '未启用 → 未启动');
    assert.equal(driven, 0, '未启用不应驱动');
    worker.stop();
  });

  it('启用后 start() 启动定时器，stop() 停止', () => {
    const worker = new GithubSyncWorker(
      async () => { /* noop */ },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    worker.start();
    assert.equal(worker.isHealthy(), true);

    worker.stop();
    assert.equal(worker.isHealthy(), false, 'stop 后不健康');
  });

  it('driveOnce 直接驱动一轮（运维/测试入口）', async () => {
    let driven = 0;
    const worker = new GithubSyncWorker(
      async () => { driven += 1; },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    await worker.driveOnce();

    assert.equal(driven, 1);
  });

  it('驱动函数抛错被隔离，不向外冒泡（单轮失败不影响后续周期）', async () => {
    const worker = new GithubSyncWorker(
      async () => { throw new Error('GitHub 不可达'); },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    /* 不应抛出——异常在 driveOnce 内部隔离并记日志。 */
    await worker.driveOnce();
    assert.ok(true, '异常已被隔离');
  });

  it('重入守卫：上一轮未完时再次 driveOnce 直接返回（不叠加）', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const worker = new GithubSyncWorker(
      async () => { started += 1; await gate; },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    const first = worker.driveOnce();      /* 卡在 gate 上 */
    await worker.driveOnce();              /* 上一轮未完 → 直接返回 */
    assert.equal(started, 1, '重入守卫：第二次不进入驱动函数');

    release();
    await first;
  });

  it('OS 集成：未注入驱动时 os.start() 不启动组织同步（对现有部署零行为突变）', async () => {
    const { ChronoSynthOS } = await import('../../chrono-synth-os.js');
    const { TestClock } = await import('../../utils/clock.js');
    const os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });

    os.start();
    /* 未 setGithubOrgSyncDriver → worker 默认关闭 → driveOnce 无副作用、不抛错。 */
    await os.driveGithubOrgSync();

    os.close();
    assert.ok(true, 'os 生命周期不因组织同步 worker 改变');
  });

  it('重复 start 幂等（不叠加定时器）', () => {
    const worker = new GithubSyncWorker(
      async () => { /* noop */ },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    worker.start();
    worker.start();
    assert.equal(worker.isHealthy(), true);

    /* 单次 stop 即完全停止（证明只有一个定时器）。 */
    worker.stop();
    assert.equal(worker.isHealthy(), false);
  });
});
