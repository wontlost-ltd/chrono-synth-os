/**
 * 第一人称身份意图识别（ADR-0055「自我意识」）——确定性、零-LLM。
 *
 * 两类身份意图：
 *   - 「定义我的身份」：用户在给数字人起名（你叫 X / 以后你叫 X / 我叫你 X / 你的名字是 X / 给你起名叫 X）。
 *     → 提取名字 X（视角转换：用户的第二人称「你」= 数字人自己，内化为第一人称身份）。
 *   - 「询问我的身份」：用户在问数字人是谁/叫什么（你叫什么 / 你的名字 / 你是谁 / 你叫啥）。
 *     → 数字人以第一人称回答「我叫 X」。
 *
 * 纯函数：相同输入 → 相同输出。不做 I/O。提取用确定性正则，不做语义推理。
 */

/** 提取到的名字最大长度（与 store 兜底一致，超长视为非起名）。 */
const MAX_EXTRACTED_NAME = 40;

/** 显式起名结构里的名字 token（语义已明确是起名，名字可稍长）：排除分隔/语气/疑问词。1..16。 */
const NAME_CHARS = "[^\\s，。,.!！?？、的了吧呀啊呢嘛吗什么谁啥]{1,16}";
/**
 * 裸形「你叫X / 我叫你X」的名字 token——**强约束**：
 *   - 长度 1..6（名字短；长 token 多半是动词短语）；
 *   - 排除常见动作/方向/指代字（来去过下别乱动一声我他她它们们个把要让给帮叫喊服务员…）
 *     与常被「叫」的事物名词（车餐客服外卖救护车…，避免「你现在叫车/叫客服」误改名），
 *     把「你叫服务员过来」「我叫你别乱动」「你现在叫车」挡在外面；
 *   - 之后必须紧接句尾（只允许语气词/标点）。 */
const BARE_NAME_CHARS = "[^\\s，。,.!！?？、的了吧呀啊呢嘛吗什么谁啥来去过下别乱动一声我他她它们个把要让给帮叫喊得真服务员外卖起床过来车餐客服救护]{1,6}";
/** 句尾收束：名字后只允许陈述语气词/标点（了吧呀啊嘛）+ 结束。**不含疑问词 吗/呢/?**
 * ——「你叫Max吗」是在问不是在起名，不应 define。 */
const NAME_TAIL = "(?:[\\s，。,.!！、了吧呀啊嘛]*)$";

/**
 * 身份定义模式：捕获组 1 = 名字。两类：
 *   A. **显式起名结构**（起名/取名/名字是/名字叫/管你叫）——语义明确，名字后不强制句尾。
 *   B. **裸「你叫X / 我叫你X」**——歧义大（「你叫服务员过来」「我叫你别乱动」是命令不是起名），
 *      故强约束：X 是**短名字 token（排除动作字）且紧接句尾**，把动作短语挡在外面。
 * 按「越具体越前」排序，逐个尝试。 */
const NAME_DEFINE_PATTERNS: readonly RegExp[] = [
  // A. 显式起名结构（不要求句尾，名字后可接「吧/了」等）
  new RegExp(`(?:给|帮)你(?:起|取)(?:个)?名(?:字)?(?:叫|是|为)?\\s*(${NAME_CHARS})`),  // 给你起名叫X / 帮你取名X
  new RegExp(`你的名字(?:就)?(?:是|叫|为)\\s*(${NAME_CHARS})`),                       // 你的名字是X / 你的名字叫X
  new RegExp(`管你叫\\s*(${NAME_CHARS})`),                                          // 管你叫X
  // B. 裸形——强约束：短名字 token（排除动作字）紧接句尾，避免「你叫+动作短语」误判
  new RegExp(`(?:以后|从今(?:以后|往后)?|从现在起)?(?:我)?(?:就)?叫你\\s*(${BARE_NAME_CHARS})${NAME_TAIL}`),  // 我叫你X（句尾）
  new RegExp(`你(?:就|以后|现在|从此)?(?:开始)?叫\\s*(${BARE_NAME_CHARS})${NAME_TAIL}`),                     // 你叫X / 你现在叫X（句尾）
];

/** 身份询问模式（专问**名字**，不带捕获，命中即「在问我叫什么」）。
 * 只覆盖「问名字」——「你是谁」这类更宽的身份询问交给 self_intro（自我介绍综述）处理，不在此拦截。
 * 注意：define 与 ask 都可能含「你的名字」，故 ask 必须要求**疑问标记**（疑问词/问号/句尾），
 * 避免把「你的名字是X」（定义）误判为询问。检测时 ask 先于 define（见 detectIdentityIntent）。 */
/** 「你」与「叫/名字」之间允许的疑问性副词填充（现在/到底/究竟/这会儿/平时/一般/究竟…），
 * 让「你现在叫什么」「你到底叫啥」也命中（≤4 字，避免吞掉实义短语）。 */
const ASK_ADVERB = '(?:现在|目前|这会儿|如今|到底|究竟|平时|一般|now)?';
const NAME_ASK_PATTERNS: readonly RegExp[] = [
  new RegExp(`你${ASK_ADVERB}叫(什么|啥|甚么)`),            // 你叫什么 / 你现在叫什么 / 你到底叫啥
  /你(的)?名字(是什么|叫什么|是啥)/,        // 必须带疑问后缀
  /你(的)?名字(呢|吗|是啥)?[?？]?$/,          // 「你叫什么名字」「你的名字」「你的名字呢」结句问
  /你(的)?名字(是|叫)?(什么|啥)/,
  /怎么称呼你/,
];

export interface IdentityIntent {
  /** 'define'=在给我起名（含提取的 name）；'ask'=在问我是谁；'none'=非身份意图。 */
  readonly kind: 'define' | 'ask' | 'none';
  /** kind='define' 时的名字（已清洗）。 */
  readonly name?: string;
}

/** 识别一段用户输入的身份意图（确定性）。
 * **ask 先于 define**：「你的名字是什么」既含 define 触发词「你的名字是」又是询问；要求 ask 含疑问标记
 * （疑问词/句尾问），故先判 ask 能正确把「你的名字是X」（定义）与「你的名字是什么」（询问）分开。 */
export function detectIdentityIntent(userInput: string): IdentityIntent {
  const text = userInput.trim();
  if (text.length === 0) return { kind: 'none' };

  /* 先试询问（带疑问标记）。 */
  for (const re of NAME_ASK_PATTERNS) {
    if (re.test(text)) return { kind: 'ask' };
  }

  /* 再试定义（起名）——捕获名字并做基本清洗。 */
  for (const re of NAME_DEFINE_PATTERNS) {
    const m = re.exec(text);
    if (m && m[1]) {
      const name = sanitizeName(m[1]);
      if (name.length > 0) return { kind: 'define', name };
    }
  }

  return { kind: 'none' };
}

/** 清洗提取的名字：去 ASCII 控制字符（含换行/制表）与尖括号（防 markup）与首尾标点空白，截断。
 * 与 store 的 cleanName 一致——意图层即剥空：清洗后为空 → 调用方判 length===0 不 define，
 * 避免「你叫<>」这类清洗后空名走到 setName 抛错触发 route 500（Codex 复审）。 */
function sanitizeName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    /* 跳过 U+0000..U+001F 控制字符与 U+007F（防换行/控制符混入名字）。 */
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === '<' || ch === '>') continue;   // 与 store cleanName 一致：剥尖括号（防 markup）
    out += ch;
  }
  const trimmed = out.replace(/^[\s，。,.!！?？、'"「」]+|[\s，。,.!！?？、'"「」]+$/g, '').trim();
  return trimmed.slice(0, MAX_EXTRACTED_NAME);
}
