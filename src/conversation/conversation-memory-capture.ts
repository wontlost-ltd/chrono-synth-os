/**
 * 对话经历沉淀（ADR-0055「对话即经历」）——确定性、零-LLM。
 *
 * 论点保持：这不是「理解」用户的话（那需要 LLM 推理，走 reflect/perceive），而是把「跟你聊过这件事」
 * **确定性地记下来**——经历即记忆，记忆可被后续联想检索召回。所以离线也能「学习」：下次它记得你说过的话。
 *
 * 纯函数：相同输入 → 相同输出。决定「这轮对话该不该沉淀、沉淀成什么内容」，不做 I/O（写库由调用方）。
 *
 * **首版保守捕获**：判定刻意偏安全侧——宁可漏沉淀一条有价值的自我陈述（如「我最近在研究怎么带团队」
 * 含疑问词「怎么」会被误判不沉淀），也绝不误沉淀一句疑问（疑问会自回声污染检索 + 破坏可复现）。
 * 因此本层不宣称稳定捕获所有成长素材；更丰富的偏好/身份抽取留给联网 reflect。
 *
 * 安全约束（写库前调用方仍须过 never_discuss 输出自检；本模块只做内容/够格判定）：
 *   - 空 / 过短 / 纯寒暄 → 不沉淀（避免垃圾记忆污染人格知识核）。
 *   - 沉淀的记忆 **低显著（salience）**：远低于老师蒸馏的语义记忆，检索时不喧宾夺主，
 *     reflect 的 trust-tier 也把它当最低可信内部来源。
 *   - kind='episodic'：与老师教的 'semantic' 知识区分。
 *   - 内容带确定性前缀标注来源（「（来自对话）」），运行期可识别、可检索。
 */

/** 沉淀的对话记忆 salience（低——经历不应盖过老师教的知识；范围 0..1）。 */
export const CONVERSATION_MEMORY_SALIENCE = 0.25;
/** 沉淀的对话记忆 valence（中性——不臆断情感极性）。 */
export const CONVERSATION_MEMORY_VALENCE = 0;
/** 够格沉淀的用户输入最小长度（字符）：太短（如「嗯」「好」「哈哈」）不值得记。 */
const MIN_CAPTURE_LENGTH = 4;
/** 沉淀内容前缀（来源标注，确定性、可检索）。 */
const CONVERSATION_PREFIX = '（来自对话）';
/** 用户输入截断长度（防超长输入撑爆单条记忆；与知识片段上限同量级）。 */
const CAPTURE_CONTENT_CAP = 280;

/** 纯寒暄 / 无实质内容词集（确定性判定，命中且整句即此类 → 不沉淀）。 */
const SMALL_TALK: ReadonlySet<string> = new Set([
  '你好', '您好', '嗨', '哈喽', '在吗', '在不在', '谢谢', '多谢', '感谢', '再见', '拜拜',
  '好的', '好', '嗯', '嗯嗯', '哦', '哦哦', '哈哈', '呵呵', '嘿', 'ok', 'okay', '行', '收到',
]);

/**
 * 疑问句判定（确定性，按**整句是否含疑问标记**判断）：用户在**问**而非**陈述**。只沉淀「用户告诉我的事」
 * （如「我叫你张三」），不沉淀「用户问我的事」（如「你喜欢跑步吗」「你叫什么名字」「我起的名字叫什么」）——
 * 后者无内化价值，且文本会在下一轮检索命中自身回声、污染 grounding，并破坏「相同问句→相同回应」可复现。
 *
 * 规则（保守：宁可漏沉淀一条陈述，也不要误沉淀一句疑问——后者会自回声污染检索+破坏可复现，
 * 危害远大于「少记一条」）：整句**含**问号、疑问语气助词（吗/呢），或疑问词（什么/谁/哪/几/
 * 多少/怎么/怎样/为什么/如何/吗）→ 视为疑问，不沉淀。少量「含疑问词的陈述句」会被误判不沉淀，
 * 这是有意的安全侧取舍（假阴性低危，假阳性高危）。 */
const QUESTION_MARK = /[?？]/;
const QUESTION_PARTICLE = /[吗呢]/;
const QUESTION_WORDS = /什么|怎么|怎样|为什么|为何|如何|多少|哪里|哪儿|哪个|哪|谁|几时|几点/;
function isQuestion(text: string): boolean {
  return QUESTION_MARK.test(text) || QUESTION_PARTICLE.test(text) || QUESTION_WORDS.test(text);
}

/** 沉淀决策结果。capture=false 时 content 无意义。 */
export interface ConversationCaptureDecision {
  /** 是否值得沉淀为经历记忆。 */
  readonly capture: boolean;
  /** 沉淀的记忆正文（capture=true 时有效，已加来源前缀、已截断）。 */
  readonly content: string;
}

/** 归一化：去首尾空白、压缩内部空白、转小写（仅用于寒暄判定，不改沉淀正文大小写）。 */
function normalizeForSmallTalk(text: string): string {
  return text.trim().replace(/\s+/g, '').toLowerCase();
}

/**
 * 判定一段用户输入是否够格沉淀，以及沉淀成什么内容。纯确定性。
 *
 * @param userInput 已脱敏的用户输入（调用方保证非敏感——never_discuss 命中的输入不应进来）。
 */
export function decideConversationCapture(userInput: string): ConversationCaptureDecision {
  const trimmed = userInput.trim();
  if (trimmed.length < MIN_CAPTURE_LENGTH) return { capture: false, content: '' };

  /* 纯寒暄（整句归一化后命中寒暄集）→ 不沉淀。 */
  const norm = normalizeForSmallTalk(trimmed);
  if (SMALL_TALK.has(norm)) return { capture: false, content: '' };

  /* 疑问句（用户在问而非陈述）→ 不沉淀。这既去掉无价值的问句噪声，也保住「相同问句→相同回应」
   * 可复现（问句不写记忆，状态不变）。 */
  if (isQuestion(trimmed)) {
    return { capture: false, content: '' };
  }

  const body = trimmed.length > CAPTURE_CONTENT_CAP ? trimmed.slice(0, CAPTURE_CONTENT_CAP) : trimmed;
  return { capture: true, content: `${CONVERSATION_PREFIX}${body}` };
}
