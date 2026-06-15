/**
 * 可复现 demo：起一个数字人 → 用真在线 LLM 老师（gpt-5.5）深度教 Java 21 语法 → 零-LLM 问答。
 *
 * 把「教→记→答」的全链路论证固化成**一条命令可复现**的脚本，不再依赖手工 curl 起的临时进程。
 * 与 apps/companion-web/e2e/demo-live.mjs 的区别：那个用 Playwright 驱浏览器（看 UI 体验）；这个是
 * 纯 API、无浏览器，专证 ADR-0047 核心论点——**老师只在摄取阶段（perceive）被调，运行时（chat）零 LLM**。
 *
 * 全真链路（无 mock）：
 *   1. 真注册 + 真登录（真后端 JWT）。
 *   2. 真 gpt-5.5 老师：经 /perceive 把每段 Java 21 知识蒸馏为语义记忆 + 记忆间语义边（蒸馏期沉淀语义）。
 *   3. 验证记忆真增长（轮询 /memories）。
 *   4. 零-LLM 问答：/chat 用确定性检索（关键词 + 多跳图遍历）+ OfflineConversationResponder 回答——
 *      相同问题相同回答，离线可复现，**运行时不调任何 LLM**。
 *
 * —— 前提（后端必须配好 gpt-5.5 老师）——
 * 后端启动前需设全局 intelligence 老师环境变量（脚本只读 env，绝不硬编码 key）：
 *   export CHRONO_INTELLIGENCE_PROVIDER=openai
 *   export CHRONO_INTELLIGENCE_MODEL=<你的模型，如 gpt-5.5>
 *   export CHRONO_INTELLIGENCE_BASE_URL=<你的 OpenAI 兼容端点>      # ⚠️ 不带 /v1，ModelRouter 自己拼 /v1/chat/completions
 *   export CHRONO_INTELLIGENCE_API_KEY=<你的 key>                   # ⚠️ 仅 env，绝不入库/打印
 * 然后另起后端：npm run dev   （或 node dist/main.js）
 *
 * —— 跑法 ——
 *   node scripts/teach-java21-demo.mjs
 * 环境变量（脚本侧）：
 *   DEMO_API_BASE   后端地址（默认 http://127.0.0.1:3000；⚠️ 用 127.0.0.1 避开 IPv6 localhost 冲突）
 *   DEMO_EMAIL      指定登录邮箱（默认每次新建 java21-demo-<时间戳>@chrono.local，全新人格）
 *   DEMO_PASSWORD   密码（默认 password123）
 *
 * 退出码：0 全链路成功；非 0 某步失败（控制台打出失败步骤）。
 */

const API_BASE = process.env.DEMO_API_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.DEMO_EMAIL ?? `java21-demo-${Date.now()}@chrono.local`;
const PASSWORD = process.env.DEMO_PASSWORD ?? 'password123';

const log = (m) => console.log(`[demo] ${m}`);
const fail = (m) => { console.error(`[demo][FAIL] ${m}`); process.exit(1); };

/** 统一 fetch：带 JSON + 鉴权头，非 2xx 抛错（含响应体便于排查）。 */
async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

/**
 * Java 21 课程：每段是一个特性的**结构化中间表征**（已脱离任何媒体——就是文字描述）。
 * 老师（gpt-5.5）会把每段蒸馏成语义记忆 + 同段事实间的语义边（供运行期多跳图遍历召回）。
 * ⚠️ 刻意不含反斜杠（如 String Templates 的 `\{}`）——反斜杠会破坏 JSON/prompt 解析（实测教训）。
 */
const LESSONS = [
  {
    feature: '虚拟线程 Virtual Threads',
    representation:
      'Java 21 正式引入虚拟线程（JEP 444）。虚拟线程是 JVM 调度的轻量级线程，与平台线程是 M:N 映射：' +
      '大量虚拟线程复用少量平台线程（称为 carrier thread 承载线程）。虚拟线程阻塞时会从承载线程上卸载，' +
      '把承载线程让给其它虚拟线程，因此能用同步阻塞风格写出支持百万级并发的代码，无需异步回调。' +
      '用 Thread.ofVirtual().start(runnable) 或 Executors.newVirtualThreadPerTaskExecutor() 创建。',
  },
  {
    feature: 'switch 模式匹配 Pattern Matching for switch',
    representation:
      'Java 21 的 switch 支持模式匹配（JEP 441）。case 后可以直接写类型模式，如 case Integer i、case String s，' +
      '自动绑定并转型。配合密封类（sealed）可做穷尽匹配，编译器检查所有子类型都被覆盖，遗漏会编译报错。' +
      'case 还支持 when 守卫子句做额外条件判断，以及对 null 的显式 case null 分支。',
  },
  {
    feature: '记录模式 Record Patterns',
    representation:
      'Java 21 引入记录模式（JEP 440）。可以在 switch 或 instanceof 里解构 record，' +
      '如 case Point(int x, int y) 直接把 record 的分量绑定到 x、y。记录模式可嵌套解构，' +
      '如 case Line(Point(var x1, var y1), Point(var x2, var y2))。与 switch 模式匹配组合，' +
      '能对密封类层级做声明式的结构化数据处理。',
  },
  {
    feature: '有序集合 Sequenced Collections',
    representation:
      'Java 21 新增有序集合接口（JEP 431）：SequencedCollection、SequencedSet、SequencedMap。' +
      '它们为有确定遍历顺序的集合提供统一的首尾访问 API：getFirst()、getLast()、addFirst()、addLast()、' +
      'removeFirst()、removeLast()，以及 reversed() 返回逆序视图。List、Deque、LinkedHashSet 等都实现了它们，' +
      '统一了过去各集合首尾操作不一致的混乱。',
  },
  {
    feature: '分代 ZGC Generational ZGC',
    representation:
      'Java 21 让 ZGC 支持分代（JEP 439）。分代 ZGC 把堆分为年轻代和老年代，更频繁地回收年轻代对象，' +
      '利用「大多数对象朝生夕死」的弱分代假说降低 GC 开销。它保持 ZGC 亚毫秒级停顿的特性，同时显著提升吞吐，' +
      '用 -XX:+UseZGC -XX:+ZGenerational 启用。',
  },
];

/** 零-LLM 问答验证集：每问应被确定性检索命中已学知识并落地回答。 */
const QUESTIONS = [
  '虚拟线程的原理是什么',
  'switch 的模式匹配怎么用',
  '记录模式能解构 record 吗',
  '有序集合提供了哪些首尾操作',
  '分代 ZGC 有什么好处',
];

async function main() {
  log(`后端：${API_BASE}`);
  log(`人格账号：${EMAIL}`);

  /* 0. 健康检查——后端没起就早失败，给清晰指引。 */
  try {
    await api('/healthz');
  } catch (e) {
    fail(`后端不可达（${API_BASE}/healthz）。请先按脚本头部说明配好 gpt-5.5 老师环境变量并 npm run dev。\n  ${e.message}`);
  }
  log('✓ 后端健康');

  /* 1. 注册（已存在则忽略 409）+ 登录拿 access token。 */
  try {
    await api('/api/v1/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
    log('✓ 注册新人格');
  } catch (e) {
    if (!e.message.includes('409') && !/exist|已存在|duplicate/i.test(e.message)) throw e;
    log('· 账号已存在，直接登录');
  }
  const login = await api('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  const token = login?.data?.accessToken;
  if (!token) fail('登录未返回 accessToken');
  log('✓ 登录成功');

  /* 2. 真 gpt-5.5 老师逐课教 Java 21（经 /perceive，蒸馏为语义记忆 + 语义边）。
   * ⚠️ 硬校验真老师（perceivedBy==='teacher'）：后端无 LLM key 会回退 MockPerceptionProvider，
   * mock 对长课文也产非零记忆——若不校验来源，会把确定性回退误当真老师，论点造假（Codex 复审 Critical）。 */
  log('—— 开始教学（真 gpt-5.5 老师蒸馏，每课一次 LLM 调用）——');
  let taughtMemories = 0;
  for (const lesson of LESSONS) {
    let r;
    try {
      /* modality 仅 audio|video（representation 是「已脱离媒体的中间表征」——这里把课文当作
       * 老师口述的转写，用 audio）。 */
      r = await api('/api/v1/companion/me/perceive', {
        method: 'POST',
        token,
        body: { modality: 'audio', representation: lesson.representation },
      });
    } catch (e) {
      fail(`教「${lesson.feature}」失败：${e.message}`);
    }
    const perceivedBy = r?.data?.perceivedBy;
    if (perceivedBy !== 'teacher') {
      fail(
        `「${lesson.feature}」由 '${perceivedBy}' 处理，不是真 LLM 老师（teacher）。` +
        `本 demo 要证明真 gpt-5.5 老师——请确认后端配了 CHRONO_INTELLIGENCE_PROVIDER/MODEL/BASE_URL/API_KEY ` +
        `且 base_url 不带 /v1（ModelRouter 自己拼）。绝不把 mock 当真老师。`,
      );
    }
    const n = r?.data?.perceivedMemories?.length ?? 0;
    taughtMemories += n;
    log(`  ✓ ${lesson.feature} → 真老师沉淀 ${n} 条记忆 [perceivedBy=${perceivedBy}]`);
    if (n === 0) fail(`「${lesson.feature}」真老师返回 0 记忆——教学无效，终止。`);
  }
  log(`✓ 教学完成（全部经真 gpt-5.5 老师），累计沉淀 ${taughtMemories} 条记忆`);

  /* 3. 验证记忆真增长（轮询 /memories，确认写真库非 mock）。 */
  const mem = await api('/api/v1/companion/me/memories?page=1&pageSize=100', { token });
  const total = mem?.data?.pagination?.total ?? mem?.data?.items?.length ?? 0;
  log(`✓ 人格当前记忆总数：${total}`);
  if (total < taughtMemories) log(`  ⚠️ 记忆总数（${total}）< 本次教学数（${taughtMemories}）——可能有合并/去重`);

  /* 4. 零-LLM 问答（运行时不调 LLM；确定性检索 + 离线回应器）。
   * ⚠️ 硬校验论点（Codex 复审）：每问必须 (a) knowledge_grounded 且引用 >0 条记忆——证明真答到已学知识，
   * 不是诚实离线/边界拒答的"假成功"；(b) 两次回答逐字一致——证明运行时确定性。任一不满足即失败，
   * 不允许在 recall 失败或确定性被破坏时仍打印"全链路成功"。 */
  log('—— 零-LLM 问答（运行时零 LLM，确定性可复现）——');
  for (const q of QUESTIONS) {
    let r1, r2;
    try {
      r1 = await api('/api/v1/companion/me/chat', { method: 'POST', token, body: { message: q } });
      r2 = await api('/api/v1/companion/me/chat', { method: 'POST', token, body: { message: q } });
    } catch (e) {
      fail(`问「${q}」失败：${e.message}`);
    }
    const a1 = r1?.data?.reply ?? '';
    const a2 = r2?.data?.reply ?? '';
    const kind = r1?.data?.kind ?? '?';
    const grounded = r1?.data?.groundedMemoryCount ?? 0;
    const reproducible = a1 === a2;
    log(`\n  Q: ${q}`);
    log(`  A: [${kind}, 引用 ${grounded} 条记忆, 两次一致=${reproducible}]`);
    console.log(indent(a1));
    if (kind !== 'knowledge_grounded' || grounded < 1) {
      fail(`问「${q}」未命中已学知识（kind=${kind}, grounded=${grounded}）——检索没召回，论点未达成。`);
    }
    if (!reproducible) {
      fail(`问「${q}」两次回答不一致——运行时确定性被破坏（不应发生），论点未达成。`);
    }
  }

  log('\n✓ 全链路成功：真 gpt-5.5 老师教 → 真记忆增长 → 零-LLM 确定性问答（全部 knowledge_grounded + 逐字可复现）。');
  log('  ADR-0047 论点端到端可复现：老师只在摄取阶段，运行时零 LLM。');
}

/** 缩进多行文本，便于控制台阅读回答正文。 */
function indent(text) {
  return String(text).split('\n').map((l) => `      ${l}`).join('\n');
}

main().catch((e) => fail(e.message));
