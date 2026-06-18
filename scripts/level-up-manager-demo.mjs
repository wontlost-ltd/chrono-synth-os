/**
 * 把已学基础的「职业经理人」数字人**进阶成顶级职业经理人**：
 *   1. 真 LLM 老师追教一批**高管/顶级管理**课程（战略、规模化组织、危机领导、人才密度、
 *      董事会/投资人管理、变革管理、文化塑造、长期主义等）→ 蒸馏为新记忆。
 *   2. 触发**自反思**（POST /companion/me/reflect）——让它从已学的全部记忆里**自己内化成长**
 *      （强化相关价值 / 连接管理概念 / 演进自我叙事），多轮反思逐步深化。
 *   3. 验证记忆增长 + 反思产出成长候选 + 零-LLM 问答仍 grounded。
 *
 * 与 teach-manager-demo.mjs 衔接：复用同一账号（默认 manager@chrono.local），在其基础上加深。
 *
 * 跑法：node scripts/level-up-manager-demo.mjs
 *   DEMO_API_BASE / DEMO_EMAIL / DEMO_PASSWORD / REFLECT_ROUNDS（默认 3）
 */

const API_BASE = process.env.DEMO_API_BASE ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.DEMO_EMAIL ?? 'manager@chrono.local';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'password123';
const REFLECT_ROUNDS = Number(process.env.REFLECT_ROUNDS ?? 3);

const log = (m) => console.log(`[levelup] ${m}`);
const fail = (m) => { console.error(`[levelup][FAIL] ${m}`); process.exit(1); };

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

/** 顶级职业经理人进阶课程（高管视角，纯文字、无反斜杠）。 */
const ADVANCED_LESSONS = [
  {
    feature: '战略思维',
    representation:
      '顶级经理人从战略层面思考：不是把事做对，而是做对的事。战略是有意识地选择不做什么——把有限资源' +
      '压在最有杠杆的少数赌注上。判断战略要看长期护城河：成本结构、网络效应、品牌、转换成本、规模经济。' +
      '优秀的高管定期问三个问题：我们的核心优势是什么、市场和技术在往哪走、我们该如何提前布局。' +
      '战略不是一次性的规划，而是随环境持续校准的假设——边执行边学习，用真实反馈修正方向。',
  },
  {
    feature: '规模化组织',
    representation:
      '把团队从十人带到百人、千人，核心是从「自己做事」到「设计系统让别人把事做好」。规模化靠三件事：' +
      '清晰的组织设计（职责边界、汇报关系、决策权下沉到信息所在处）、可复制的流程与标准（让质量不依赖个别英雄）、' +
      '以及把文化和判断标准写进招聘、晋升、激励里，让组织在没有创始人盯着时也做出一致的决策。' +
      '规模化的最大风险是官僚化——要刻意保留小团队的速度与主人翁意识。',
  },
  {
    feature: '危机领导',
    representation:
      '危机中顶级经理人的价值最凸显。原则：先稳定、再优化。第一时间正视现实、不粉饰，向团队和上级透明同步；' +
      '快速建立指挥结构和信息节奏，避免恐慌和各自为战。决策上接受不完美信息下的果断，宁可做出可调整的决定也不瘫痪。' +
      '对内保持冷静和确定性，给团队心理安全；对外诚实担责。危机也是重塑文化和加速变革的窗口——' +
      '人在压力下会记住领导者怎么做，而非怎么说。',
  },
  {
    feature: '人才密度',
    representation:
      '顶级公司靠人才密度取胜：一个高绩效团队胜过两个平庸团队。高管最重要的工作之一是把招聘标准守在极高水位——' +
      '宁缺毋滥，每个新人都应抬高团队平均水平。同样重要的是果断处理低绩效：留着不合适的人是对优秀者的不公，' +
      '也会拉低整个团队的标准。给 A 级人才足够的自主、挑战和成长空间，他们要的往往不是更多管理，而是更少阻碍。' +
      '人才密度高的组织可以用更少的流程和规则运转，因为可以信任人的判断。',
  },
  {
    feature: '向董事会与投资人管理',
    representation:
      '高管要管理董事会和投资人：把他们当作资源而非汇报对象。核心是建立信任——持续、坦诚、无意外地沟通，' +
      '坏消息早讲、讲清、附带应对方案。董事会会议前要做足功课，聚焦少数关键战略议题，而非事无巨细的运营汇报。' +
      '善用董事的网络、经验和视角解决具体问题。在关键决策上主动寻求 align，但也要有自己的判断和担当——' +
      '董事会信任的是有主见、对结果负责、又愿意听取的领导者。',
  },
  {
    feature: '变革与文化塑造',
    representation:
      '顶级经理人是文化的总设计师。文化不是墙上的标语，而是「在这里什么行为被奖励、什么被容忍、什么被惩罚」的真实总和。' +
      '塑造文化靠的是领导者自己的言行一致（人看你做什么，不是说什么）、招聘和晋升传递的信号、以及对关键时刻的处理。' +
      '推动变革要先讲清为什么（紧迫感和愿景），找到早期支持者，用小胜积累势能，并坦诚面对阻力。' +
      '变革最难的不是方案，而是让人愿意改变——这需要同理、耐心和持续的沟通。',
  },
  {
    feature: '长期主义与复利',
    representation:
      '顶级经理人用复利和长期视角做决策：今天的小投入（培养人、打磨产品、积累信任、建设文化）会在多年后指数级回报。' +
      '抵御短期诱惑——为了季度数字牺牲长期能力是最常见也最致命的错误。长期主义不是不看短期，而是在短期约束下' +
      '不断为长期下注。优秀的高管会刻意保护那些重要但不紧急、回报滞后的投入，并用清晰的优先级和耐心，' +
      '让组织在正确的方向上持续复利。',
  },
];

const QUESTIONS = [
  '怎么做战略决策',
  '怎么把一个小团队规模化',
  '危机里怎么领导团队',
  '怎么打造高人才密度的团队',
  '怎么管理董事会和投资人',
  '怎么塑造组织文化',
  '为什么要长期主义',
];

async function main() {
  log(`后端：${API_BASE}  人格：${EMAIL}`);
  try { await api('/healthz'); } catch (e) { fail(`后端不可达：${e.message}`); }

  const login = await api('/api/v1/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  const token = login?.data?.accessToken;
  if (!token) fail('登录失败（账号需先经 teach-manager-demo.mjs 起好）');
  log('✓ 登录');

  const before = await api('/api/v1/companion/me/memories?page=1&pageSize=200', { token });
  const beforeTotal = before?.data?.pagination?.total ?? 0;
  log(`进阶前记忆：${beforeTotal}`);

  /* 1. 追教高管/顶级管理课程。 */
  log('—— 追教顶级管理课程（真 LLM 老师蒸馏）——');
  let added = 0;
  for (const lesson of ADVANCED_LESSONS) {
    const r = await api('/api/v1/companion/me/perceive', {
      method: 'POST', token, body: { modality: 'audio', representation: lesson.representation },
    });
    if (r?.data?.perceivedBy !== 'teacher') fail(`「${lesson.feature}」非真老师（${r?.data?.perceivedBy}）`);
    const n = r?.data?.perceivedMemories?.length ?? 0;
    added += n;
    log(`  ✓ ${lesson.feature} → +${n} 记忆`);
  }
  log(`✓ 追教完成，新增约 ${added} 条记忆`);

  /* 2. 多轮自反思——让它从全部记忆自己内化成长。 */
  log(`—— 自主反思 ${REFLECT_ROUNDS} 轮（让它自己内化成长）——`);
  let totalGrowth = 0, totalCompiled = 0, totalPending = 0;
  for (let i = 1; i <= REFLECT_ROUNDS; i++) {
    const r = await api('/api/v1/companion/me/reflect', { method: 'POST', token });
    const d = r?.data ?? {};
    const c = d.candidatesIngested ?? 0;
    totalGrowth += c; totalCompiled += d.compiled ?? 0; totalPending += d.pending ?? 0;
    log(`  反思第 ${i} 轮 → 自产 ${c} 个成长候选（自动编译 ${d.compiled ?? 0} / 待审批 ${d.pending ?? 0}）`);
  }
  log(`✓ 自反思累计产 ${totalGrowth} 个成长候选（自动编译 ${totalCompiled} / 待审批 ${totalPending}）`);

  /* 3. 验证记忆增长 + 零-LLM 问答仍 grounded。 */
  const after = await api('/api/v1/companion/me/memories?page=1&pageSize=200', { token });
  const afterTotal = after?.data?.pagination?.total ?? 0;
  log(`✓ 进阶后记忆：${afterTotal}（+${afterTotal - beforeTotal}）`);

  log('—— 零-LLM 验证：问顶级管理问题 ——');
  let grounded = 0;
  for (const q of QUESTIONS) {
    const r = await api('/api/v1/companion/me/chat', { method: 'POST', token, body: { message: q } });
    const d = r?.data ?? {};
    const ok = d.kind === 'knowledge_grounded' && (d.groundedMemoryCount ?? 0) >= 1;
    if (ok) grounded++;
    log(`  Q: ${q}  →  [${d.kind}, 引用 ${d.groundedMemoryCount} 条]`);
  }
  log(`\n✓ 进阶完成：记忆 ${beforeTotal}→${afterTotal}，自反思产 ${totalGrowth} 成长候选（编译 ${totalCompiled}/待审批 ${totalPending}），${grounded}/${QUESTIONS.length} 顶级问题命中已学知识。`);
  log(`  账号 ${EMAIL} / ${PASSWORD} —— 醒来可登录 companion-web 问它顶级管理问题。`);
}

main().catch((e) => fail(e.message));
