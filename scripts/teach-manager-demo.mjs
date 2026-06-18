/**
 * 可复现 demo：起一个数字人 → 用真在线 LLM 老师深度教「职业经理人」人格 → 零-LLM 问答。
 *
 * 与 teach-java21-demo.mjs 同构（ADR-0047 论点：老师只在摄取阶段被调，运行时 chat 零 LLM），
 * 但教的是**职业经理人的核心能力与心智**——决策、带团队、授权、优先级、冲突处理、反馈、
 * 招聘留人、向上管理。教完后用户可直接 /chat 问这个数字人，运行时确定性、可复现、不调任何 LLM。
 *
 * 全真链路（无 mock）：
 *   1. 真注册 + 真登录（真后端 JWT）。
 *   2. 真 LLM 老师：经 /perceive 把每段经理人知识蒸馏为语义记忆 + 记忆间语义边。
 *      硬校验 perceivedBy==='teacher'（后端无 key 会回退 MockPerceptionProvider，不接受）。
 *   3. 验证记忆真增长（/memories）。
 *   4. 零-LLM 问答：/chat 确定性检索 + OfflineConversationResponder——相同问相同答，运行时零 LLM。
 *
 * —— 前提（后端必须配好 LLM 老师）——
 *   export CHRONO_INTELLIGENCE_PROVIDER=openai
 *   export CHRONO_INTELLIGENCE_MODEL=<模型>
 *   export CHRONO_INTELLIGENCE_BASE_URL=<OpenAI 兼容端点，不带 /v1>
 *   export CHRONO_INTELLIGENCE_API_KEY=<key，仅 env 绝不入库/打印>
 *   然后 npm run dev（或 node dist/main.js）
 *
 * —— 跑法 ——
 *   node scripts/teach-manager-demo.mjs
 *   DEMO_API_BASE  后端地址（默认 http://127.0.0.1:3000）
 *   DEMO_EMAIL     登录邮箱（默认 manager-demo-<时间戳>@chrono.local，全新人格）
 *   DEMO_PASSWORD  密码（默认 password123）
 *
 * 退出码：0 全链路成功；非 0 某步失败。
 */

const API_BASE = process.env.DEMO_API_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.DEMO_EMAIL ?? `manager-demo-${Date.now()}@chrono.local`;
const PASSWORD = process.env.DEMO_PASSWORD ?? 'password123';

const log = (m) => console.log(`[demo] ${m}`);
const fail = (m) => { console.error(`[demo][FAIL] ${m}`); process.exit(1); };

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/**
 * 「职业经理人」课程：每段是一个核心管理能力的结构化中间表征（纯文字，无反斜杠）。
 * 老师会把每段蒸馏成语义记忆 + 同段事实间的语义边（供运行期多跳召回）。
 */
const LESSONS = [
  {
    feature: '决策与判断',
    representation:
      '职业经理人的核心是做决策。优秀的经理人区分可逆决策（two-way door，快速决定、错了再改）和' +
      '不可逆决策（one-way door，慎重收集信息）。对可逆决策追求速度，对不可逆决策追求质量。' +
      '决策时先明确目标和约束，再列选项与权衡，用数据而非直觉拍板，并记录决策理由便于复盘。' +
      '面对信息不全也要在合理时限内决断——不决策本身也是一种代价更高的决策。',
  },
  {
    feature: '带团队与授权',
    representation:
      '经理人的产出是团队的产出，不是自己亲手做的事。最重要的杠杆是授权：把任务连同决策权一起交出去，' +
      '只对齐目标与边界，不微观管理过程。授权要匹配人的能力——对新手给明确步骤，对成熟者给方向和空间。' +
      '建立信任后逐步放权，团队成长，经理人才能腾出手做更高层的事。不授权的经理人会成为团队的瓶颈。',
  },
  {
    feature: '优先级与聚焦',
    representation:
      '经理人每天面对的事永远多于时间。关键是分清重要与紧急：重要不紧急的事（战略、培养人、流程改进）' +
      '最容易被紧急琐事挤掉，却决定长期成败，必须主动留出时间。学会说不——对低价值请求礼貌拒绝，' +
      '保护团队的专注。用少数关键目标（如 OKR）对齐全队，避免资源分散在太多方向上。',
  },
  {
    feature: '反馈与辅导',
    representation:
      '经理人通过反馈帮人成长。好反馈及时、具体、对事不对人：描述观察到的行为和它的影响，而非给人贴标签。' +
      '正面反馈要公开且具体，让好行为被强化；批评性反馈要私下进行，先讲事实再一起找改进办法。' +
      '辅导不是给答案，而是用提问引导对方自己想清楚，培养独立解决问题的能力。定期一对一是反馈的主场。',
  },
  {
    feature: '冲突处理',
    representation:
      '团队里有冲突是正常的，回避冲突才危险。经理人要把冲突从对人转回对事：让各方讲清各自的事实与诉求，' +
      '找到共同目标，再在共同目标下谈分歧。对观点之争鼓励充分辩论后一致执行（disagree and commit）；' +
      '对价值观或行为底线问题则要明确立场、果断处理。拖延冲突会让小问题发酵成团队信任的崩塌。',
  },
  {
    feature: '向上与跨部门管理',
    representation:
      '经理人不只管下面，也要管上面和周围。向上管理是主动同步进展、暴露风险、寻求资源，让老板没有意外——' +
      '把坏消息早说、说清，比掩盖更能赢得信任。跨部门协作靠的是先理解对方的目标与压力，找到双赢的交集，' +
      '用对方关心的语言沟通。把自己定位成连接者而非孤岛，影响力来自可信度而非职位。',
  },
];

/** 零-LLM 问答验证集：每问应被确定性检索命中已学知识并落地回答。 */
const QUESTIONS = [
  '怎么做重要的决策',
  '怎么带好一个团队',
  '事情太多怎么排优先级',
  '怎么给下属反馈',
  '团队有冲突怎么办',
  '怎么跟老板和其他部门打交道',
];

async function main() {
  log(`后端：${API_BASE}`);
  log(`人格账号：${EMAIL}`);

  try {
    await api('/healthz');
  } catch (e) {
    fail(`后端不可达（${API_BASE}/healthz）。请先按脚本头部说明配好 LLM 老师环境变量并 npm run dev。\n  ${e.message}`);
  }
  log('✓ 后端健康');

  try {
    await api('/api/v1/auth/register', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
    log('✓ 注册新人格（一张白纸）');
  } catch (e) {
    if (!e.message.includes('409') && !/exist|已存在|duplicate/i.test(e.message)) throw e;
    log('· 账号已存在，直接登录');
  }
  const login = await api('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  const token = login?.data?.accessToken;
  if (!token) fail('登录未返回 accessToken');
  log('✓ 登录成功');

  log('—— 开始教学：让数字人学习「职业经理人」（真 LLM 老师蒸馏，每课一次 LLM 调用）——');
  let taughtMemories = 0;
  for (const lesson of LESSONS) {
    let r;
    try {
      r = await api('/api/v1/companion/me/perceive', {
        method: 'POST', token,
        body: { modality: 'audio', representation: lesson.representation },
      });
    } catch (e) {
      fail(`教「${lesson.feature}」失败：${e.message}`);
    }
    const perceivedBy = r?.data?.perceivedBy;
    if (perceivedBy !== 'teacher') {
      fail(
        `「${lesson.feature}」由 '${perceivedBy}' 处理，不是真 LLM 老师（teacher）。` +
        `请确认后端配了 CHRONO_INTELLIGENCE_PROVIDER/MODEL/BASE_URL/API_KEY 且 base_url 不带 /v1。`,
      );
    }
    const n = r?.data?.perceivedMemories?.length ?? 0;
    taughtMemories += n;
    log(`  ✓ ${lesson.feature} → 真老师沉淀 ${n} 条记忆 [perceivedBy=${perceivedBy}]`);
    if (n === 0) fail(`「${lesson.feature}」真老师返回 0 记忆——教学无效，终止。`);
  }
  log(`✓ 教学完成（全部经真 LLM 老师），累计沉淀 ${taughtMemories} 条记忆`);

  const mem = await api('/api/v1/companion/me/memories?page=1&pageSize=100', { token });
  const total = mem?.data?.pagination?.total ?? mem?.data?.items?.length ?? 0;
  log(`✓ 这个经理人现在的记忆总数：${total}`);

  log('—— 零-LLM 问答：现在问这个职业经理人（运行时零 LLM，确定性可复现）——');
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
      fail(`问「${q}」未命中已学知识（kind=${kind}, grounded=${grounded}）——检索没召回。`);
    }
    if (!reproducible) {
      fail(`问「${q}」两次回答不一致——运行时确定性被破坏。`);
    }
  }

  log(`\n✓ 全链路成功：真 LLM 老师教「职业经理人」→ 真记忆增长 → 零-LLM 确定性问答。`);
  log(`  这个数字人格账号已就绪，可继续用 /chat 问它：邮箱 ${EMAIL} / 密码 ${PASSWORD}`);
}

function indent(text) {
  return String(text).split('\n').map((l) => `      ${l}`).join('\n');
}

main().catch((e) => fail(e.message));
