/**
 * Companion 对话层多语种资源（ADR-0055 多语种）——确定性、零-LLM。
 *
 * 集中**所有按语言变化的对话资源**：身份意图模式（起名/问名字）、寒暄/疑问判定词、
 * 固定回复模板。各对话模块（identity-intent / conversation-memory-capture /
 * offline-conversation-responder / chat）从这里按 locale 取资源，而非各自硬编码中文。
 *
 * 加新语言 = 在 LOCALE_RESOURCES 加一个 locale 块（结构由 CompanionLocaleResources 约束，
 * TS 编译期保证不漏字段）。当前支持 zh-CN / en（与 i18n SUPPORTED_LOCALES 对齐）。
 *
 * 论点保持：全部是确定性正则/模板，零运行时 LLM。中文资源 = 既有行为（不回归），英文 = 对等新增。
 */

import type { SupportedLocale } from '../i18n/locale-resolver.js';
import type { TimeGap } from './temporal.js';

/** 一种语言的全部对话资源。 */
export interface CompanionLocaleResources {
  /** 身份「起名」模式：捕获组 1 = 名字（已按该语言收敛误判）。 */
  readonly nameDefinePatterns: readonly RegExp[];
  /** 起名否决（可选）：命中则即便 define 模式匹配也不当起名（如英文疑问/转述上下文）。 */
  readonly nameDefineVeto?: RegExp;
  /** 用户自报名字模式（ADR-0056 关系层）：捕获组 1 = 用户名（「我叫X」「叫我X」「call me X」）。
   * 与 nameDefinePatterns（给数字人起名「你叫X」）区分——这是用户说自己叫什么。 */
  readonly userNameDefinePatterns: readonly RegExp[];
  /** 身份「问名字」模式（命中即在问名字，无捕获）。 */
  readonly nameAskPatterns: readonly RegExp[];
  /** 纯寒暄词（整句归一化后命中即不沉淀对话记忆）。 */
  readonly smallTalk: ReadonlySet<string>;
  /** 疑问判定（命中即视为问句，不沉淀对话记忆）。 */
  readonly isQuestion: (text: string) => boolean;
  /** 回复模板（第一人称，确定性）。 */
  readonly reply: {
    /** 起名成功确认（{name}）。 */
    readonly nameConfirmed: (name: string) => string;
    /** 起名但名字命中敏感主题（never_discuss）→ 拒绝（语义：不方便用）。 */
    readonly nameRejectedSensitive: string;
    /** 起名但名字清洗后为空/无效 → 温和重问。 */
    readonly nameRejectedUnclear: string;
    /** 问名字、已有名字（{name}）。 */
    readonly myNameIs: (name: string) => string;
    /** 问名字、尚未起名 → 第一人称邀请。 */
    readonly noNameYet: string;
    /** 知识回应的 lead-in（按问句类型可不同；此处给通用一句）。 */
    readonly knowledgeLeadIn: (userInput: string) => string;
    /** 知识回应末尾的「离线声明」。 */
    readonly offlineNote: string;
    /** 无知识时的诚实离线回应主体。 */
    readonly honestOffline: string;
    /** 主动 follow-up（邀请继续）。 */
    readonly inviteContinue: string;
    /** 心情前缀（ADR-0056）：按当前心情标签给一句语气前缀，neutral → 空串（零回归）。
     * 拼在知识/离线回应最前，让回应「有心情」。 */
    readonly moodPrefix: (label: 'positive' | 'negative' | 'excited' | 'calm' | 'neutral') => string;
    /** self_intro：名字前缀（{name}）。 */
    readonly selfIntroName: (name: string) => string;
    /** self_intro：价值观引导（{values}）。 */
    readonly selfIntroValues: (values: string) => string;
    /** self_intro：记忆引导。 */
    readonly selfIntroMemories: string;
    /** self_intro：结尾声明。 */
    readonly selfIntroFooter: string;
    /** summary：有主题的归纳引导（{topic}）。 */
    readonly summaryLeadIn: (topic: string) => string;
    /** summary：无主题（最近学了什么）的引导。 */
    readonly summaryRecentLeadIn: string;
    /** summary：结尾（{count}=相关记忆条数）。 */
    readonly summaryFooter: (count: number) => string;
    /** summary：该主题无相关记忆（{topic}）。 */
    readonly summaryEmpty: (topic: string) => string;
    /** summary：完全没有记忆可总结。 */
    readonly summaryNothing: string;
    /** 关系（ADR-0056）：用户自报名字后的确认（{name}）。 */
    readonly userNameNoted: (name: string) => string;
    /** 关系：self_intro 里「我们的关系」一句（{userName}=用户名 可空, {count}=互动次数）。 */
    readonly relationshipLine: (userName: string | undefined, count: number) => string;
    /** 时间感知问候前缀（ADR-0056）：按久别档 + 认识天数，sameSession→空（不每句打招呼）。
     * {gap}=久别档（first/longGap/dayGap/sameSession），{userName}可空，{days}=认识天数。 */
    readonly greetingPrefix: (gap: TimeGap, userName: string | undefined, days: number) => string;
    /** 立场前缀（ADR-0056）：confident→空（零回归），tentative→「我记得好像…不太确定」，
     * opinion→「我觉得 / 在我看来」。{stance}=confident/tentative/opinion。 */
    readonly stancePrefix: (stance: 'confident' | 'tentative' | 'opinion') => string;
  };
  /** 自我介绍元意图短语（「介绍你自己」类，子串匹配，已小写）。 */
  readonly selfIntroPhrases: readonly string[];
  /** 归纳总结意图模式：捕获组 1 = 主题（可选，无捕获/空 = 最近学了什么）。 */
  readonly summaryPatterns: readonly RegExp[];
  /** 评价/看法类问题模式（你觉得X怎么样 / 你喜欢X吗 / X好不好）——命中则回应可带「我觉得」式观点。 */
  readonly opinionQuestionPatterns: readonly RegExp[];
  /** 回应变化性变体库（ADR-0056）：按轮次确定性轮换措辞，消除复读机感。每库**第 0 个=既有原文**
   * （seed=0/缺省 → 取原文 → 零回归）。仅用于语义等价的表层措辞，绝不改变回应实质/安全性。 */
  readonly replyVariants: {
    /** knowledge 回应后的「邀请继续」一句（inviteContinue 的变体；[0]=原文）。 */
    readonly inviteContinue: readonly string[];
    /** knowledge 回应的离线说明脚注（offlineNote 的变体；[0]=原文）。 */
    readonly offlineNote: readonly string[];
  };
}

/* ── 中文（zh-CN）：抽取既有行为，逐字对齐原硬编码字符串，确保零回归 ─────────────── */

const ZH_NAME_CHARS = "[^\\s，。,.!！?？、的了吧呀啊呢嘛吗什么谁啥]{1,16}";
const ZH_BARE_NAME_CHARS = "[^\\s，。,.!！?？、的了吧呀啊呢嘛吗什么谁啥来去过下别乱动一声我他她它们个把要让给帮叫喊得真服务员外卖起床过来车餐客服救护]{1,6}";
const ZH_NAME_TAIL = "(?:[\\s，。,.!！、了吧呀啊嘛]*)$";
const ZH_ASK_ADVERB = '(?:现在|目前|这会儿|如今|到底|究竟|平时|一般|now)?';

const ZH_SMALL_TALK: ReadonlySet<string> = new Set([
  '你好', '您好', '嗨', '哈喽', '在吗', '在不在', '谢谢', '多谢', '感谢', '再见', '拜拜',
  '好的', '好', '嗯', '嗯嗯', '哦', '哦哦', '哈哈', '呵呵', '嘿', 'ok', 'okay', '行', '收到',
]);

const ZH_QUESTION_MARK = /[?？]/;
const ZH_QUESTION_PARTICLE = /[吗呢]/;
const ZH_QUESTION_WORDS = /什么|怎么|怎样|为什么|为何|如何|多少|哪里|哪儿|哪个|哪|谁|几时|几点/;

const zhCN: CompanionLocaleResources = {
  nameDefinePatterns: [
    new RegExp(`(?:给|帮)你(?:起|取)(?:个)?名(?:字)?(?:叫|是|为)?\\s*(${ZH_NAME_CHARS})`),
    new RegExp(`你的名字(?:就)?(?:是|叫|为)\\s*(${ZH_NAME_CHARS})`),
    new RegExp(`管你叫\\s*(${ZH_NAME_CHARS})`),
    new RegExp(`(?:以后|从今(?:以后|往后)?|从现在起)?(?:我)?(?:就)?叫你\\s*(${ZH_BARE_NAME_CHARS})${ZH_NAME_TAIL}`),
    new RegExp(`你(?:就|以后|现在|从此)?(?:开始)?叫\\s*(${ZH_BARE_NAME_CHARS})${ZH_NAME_TAIL}`),
  ],
  nameAskPatterns: [
    new RegExp(`你${ZH_ASK_ADVERB}叫(什么|啥|甚么)`),
    /你(的)?名字(是什么|叫什么|是啥)/,
    /你(的)?名字(呢|吗|是啥)?[?？]?$/,
    /你(的)?名字(是|叫)?(什么|啥)/,
    /怎么称呼你/,
  ],
  /* 用户自报名字（「我叫X」「叫我X」「我的名字是X」）。名字 token 同身份层（短、排除分隔/语气词）。 */
  userNameDefinePatterns: [
    new RegExp(`(?:我(?:的名字)?(?:就)?叫|你可以叫我|请叫我|叫我)\\s*(${ZH_BARE_NAME_CHARS})${ZH_NAME_TAIL}`),
    new RegExp(`我的名字(?:是|叫)\\s*(${ZH_NAME_CHARS})`),
  ],
  smallTalk: ZH_SMALL_TALK,
  isQuestion: (text) => ZH_QUESTION_MARK.test(text) || ZH_QUESTION_PARTICLE.test(text) || ZH_QUESTION_WORDS.test(text),
  reply: {
    nameConfirmed: (name) => `好的，我记住了——我叫${name}。以后你就这么叫我吧。`,
    nameRejectedSensitive: '这个名字我不太方便用，换一个好吗？',
    nameRejectedUnclear: '这个名字我没太听清，你想叫我什么？',
    myNameIs: (name) => `我叫${name}。`,
    noNameYet: '我还没有名字呢。你想叫我什么？',
    knowledgeLeadIn: (userInput) => {
      const q = userInput.trim();
      if (/吗[?？]?$|会不会|是不是|有没有/.test(q)) return '关于这个，我记得：';
      if (/怎么|如何|什么|为什么|哪些|怎样/.test(q)) return '这个我有印象：';
      return '根据我已经记住的内容：';
    },
    offlineNote: '（当前离线，以上基于已学习的内容；联网后我可以补充更多。）',
    honestOffline: '我现在处于离线状态，还无法就这个新话题学习或展开。我已经把它记下，等联网后会一起整理再回应你。',
    inviteContinue: '如果你愿意，我们可以接着这个话题多聊一会儿。',
    moodPrefix: (label) => {
      switch (label) {
        case 'positive': return '聊到这个我挺开心的～';
        case 'excited': return '哇，说到这个我有点兴奋！';
        case 'negative': return '嗯…我这会儿心情有点低，不过——';
        case 'calm': return '（我现在很平静）';
        default: return '';
      }
    },
    selfIntroName: (name) => `我叫${name}。`,
    selfIntroValues: (values) => `我最看重的是${values}。`,
    selfIntroMemories: '我印象比较深的是：',
    selfIntroFooter: '（这些都来自我学过、记住的，离线也能告诉你。）',
    summaryLeadIn: (topic) => `关于「${topic}」，我学过这些：`,
    summaryRecentLeadIn: '我最近记住的是：',
    summaryFooter: (count) => `（以上归纳自我相关的 ${count} 条记忆，确定性整理、离线可复现。）`,
    summaryEmpty: (topic) => `关于「${topic}」我还没学过什么，你可以教教我。`,
    summaryNothing: '我现在还没有可总结的记忆呢，多教我一些吧。',
    userNameNoted: (name) => `很高兴认识你，${name}！我记住啦。`,
    relationshipLine: (userName, count) => {
      const who = userName ? `你是${userName}，` : '';
      if (count >= 5) return `${who}我们已经聊过 ${count} 次了，挺熟的。`;
      if (count >= 1) return `${who}我们聊过几次了。`;
      return who ? `${who}很高兴认识你。` : '';
    },
    greetingPrefix: (gap, userName, days) => {
      const name = userName ? userName : '';
      switch (gap) {
        case 'longGap': return days >= 1 ? `${name ? name + '，' : ''}好久不见！我们认识 ${days} 天了。` : `${name ? name + '，' : ''}好久不见！`;
        case 'dayGap': return `${name ? name + '，' : ''}又见面了～`;
        default: return ''; // first / sameSession 不打招呼前缀（first 由起名/认识流程承接）
      }
    },
    stancePrefix: (stance) => {
      switch (stance) {
        case 'tentative': return '我记得好像是这样，不过我也不太确定——';
        case 'opinion': return '我觉得，';
        default: return ''; // confident → 无前缀（零回归）
      }
    },
  },
  selfIntroPhrases: [
    '介绍一下你自己', '介绍下你自己', '自我介绍', '介绍你自己', '介绍一下自己',
    '你是谁', '你会什么', '你都会什么', '你都会些什么', '你会些什么', '你能做什么', '你擅长什么',
    '讲讲你自己', '说说你自己', '聊聊你自己', '你是什么样',
  ],
  /* 归纳总结**人格自己学过的东西**（必须含「你+学/知/记/了解」语义，区别于「总结这份文档」等
   * 总结外部对象的请求——后者不该当人格记忆归纳，应走普通问答/模板）。 */
  summaryPatterns: [
    // 无主题（先于有主题，更具体）：你最近学了什么 / 总结一下你学到的东西 / 你都学了些什么
    /你最近(?:学|记)了(?:些)?什么/,
    /(?:总结|归纳|概括)(?:一下)?你(?:学到|学过|记住)的(?:东西|内容|知识)?$/,
    /你都?学了些?什么/,
    // 有主题：必须有「你+学/知/记/了解」框架，主题在其后
    /(?:总结|归纳|概括|梳理)(?:一下|下)?你(?:学过|知道|记得|了解)的?\s*(?:关于)?\s*([^\s，。,.!！?？、的吗呢]{1,20})/,
    /你(?:学过|知道|记得|了解)的?\s*(?:关于)?\s*([^\s，。,.!！?？、的吗呢]{1,20})(?:都?有些?什么|方面)/,
  ],
  /* 评价/看法类问题：问的是「好不好/喜不喜欢/怎么看」而非纯事实——命中则回应可带「我觉得」。
   * 注意：裸「你看」过宽（「你看过/你看一下」是事实/指令非评价，Codex 复审），故只收「你怎么看 /
   * 在你看来 / 依你看 / 你看好」这类明确征求看法的措辞。 */
  opinionQuestionPatterns: [
    /你(?:觉得|认为)/,
    /你怎么(?:看|想)/,
    /你(?:喜欢|讨厌|爱|偏好|看好)/,
    /(?:好不好|好喝吗|好吃吗|好用吗|值不值|值得吗|该不该|要不要|应不应该|对不对|行不行|靠谱吗)/,
    /在你看来|依你看|你的看法|你的观点/,
  ],
  /* 回应变化性变体库（语义等价，仅换措辞，[0]=既有原文，零回归；周期错峰：邀请语 6 个、
   * 脚注 5 个，不同周期降低「就这几句循环」的察觉感）。 */
  replyVariants: {
    inviteContinue: [
      '如果你愿意，我们可以接着这个话题多聊一会儿。',  // [0] 原文
      '这个话题挺有意思的，要不要再多聊聊？',
      '你要是还想继续，我随时都在。',
      '关于这个，我们可以再深入一点，如果你有兴趣的话。',
      '想接着聊的话，我很乐意继续。',
      '这里头还有不少可以展开的，你说呢？',
    ],
    offlineNote: [
      '（当前离线，以上基于已学习的内容；联网后我可以补充更多。）',  // [0] 原文
      '（这些都是我离线时已经记住的；等联网了我能讲得更全。）',
      '（眼下离线，我只能基于学过的回答，联网后再帮你补充。）',
      '（这是我离线状态下凭记忆给的，联网后能讲得更细。）',
      '（以上来自我已学到的内容；等能联网时我再帮你查漏补缺。）',
    ],
  },
};

/* ── 英文（en）：与中文对等的新增资源 ──────────────────────────────────── */

/** 英文名字 token：字母/数字/连字符/撇号/点/空格（多词名如 "Mary Jane"），1..24。 */
const EN_NAME_CHARS = "[A-Za-z][A-Za-z0-9'.\\- ]{0,23}";
/** 英文起名后缀：名字后只允许陈述标点/空白 + 结束。**不含 ?**——「Can I call you Max?」是询问不是定义。 */
const EN_NAME_TAIL = "(?:[\\s.,!'\"]*)$";
/** 起名定义不得出现在疑问上下文：以情态/助动词 + 「I/we call you」开头（Can I call you X? / Should I…）
 * 或第三人称（they/people call you X）——这些是询问/转述，非用户定义。命中则不 define。 */
const EN_DEFINE_QUESTION_GUARD = /^(?:can|could|may|might|should|shall|would|will|do|does|did)\s+(?:i|we|you)\b|^(?:they|people|everyone|others|folks|we)\s+call\s+you\b|^(?:would|do)\s+you\s+(?:like|want|mind)\b/i;
/** 「call you X」里 X 不能以这些词开头——排除「call you back / a taxi / later / after lunch / from work /
 * me / your mom / maybe / not Max」等动作/介词/指代/否定短语（否则会被当名字）。负向先行，词边界。 */
const EN_NOT_NAME_LEAD = "(?!(?:back|a|an|the|later|now|soon|up|out|in|on|over|off|again|tomorrow|today|tonight|" +
  "after|before|from|once|when|while|until|about|around|maybe|perhaps|sometime|anytime|" +
  "me|him|her|them|us|your|my|his|their|our|this|that|these|those|please|if|right|asap|first|not|never|guys?)\\b)";

const EN_SMALL_TALK: ReadonlySet<string> = new Set([
  'hi', 'hello', 'hey', 'heya', 'yo', 'hiya', 'sup', 'thanks', 'thank you', 'thx', 'ty',
  'bye', 'goodbye', 'cya', 'ok', 'okay', 'k', 'kk', 'yeah', 'yep', 'yup', 'nope', 'lol', 'haha',
  'cool', 'nice', 'great', 'got it', 'sure',
]);

/* 英文 wh-疑问词开头（what/who/where/when/why/which/whose/whom/how）——这些开头基本就是问句，
 * 误判为陈述的概率低（避免英文问句被当陈述沉淀）。 */
const EN_WH_LEAD = /^(what|who|where|when|why|which|whose|whom|how)\b/i;
/* 助动词 + 代词（you/we/i/they）开头 = 明显疑问倒装（do you…/can you…/are you…/would you…），
 * 即使省略问号也判疑问。而「Will Smith is…」「May is…」助动词后接专名/系动词而非代词，不命中。 */
const EN_AUX_INVERSION = /^(do|does|did|are|is|was|were|can|could|will|would|shall|should|may|might|have|has|had|am)\s+(you|we|i|they)\b/i;

const en: CompanionLocaleResources = {
  nameDefineVeto: EN_DEFINE_QUESTION_GUARD,
  nameDefinePatterns: [
    // 显式起名：your name is X —— 排除否定「is not X」（\b 词边界防 "isn't"）
    new RegExp(`your name\\s+(?:is|will be|shall be)\\s+${EN_NOT_NAME_LEAD}(${EN_NAME_CHARS})${EN_NAME_TAIL}`, 'i'),
    // name you X / I'll name you X（\bname 防 rename/surname）
    new RegExp(`\\b(?:i(?:'| a| wi)?ll\\s+)?name\\s+you\\s+${EN_NOT_NAME_LEAD}(${EN_NAME_CHARS})${EN_NAME_TAIL}`, 'i'),
    // call you X / I'll call you X —— \bcall 防 recall；负向先行排除动作/介词短语 + 紧接句尾
    new RegExp(`\\bcall\\s+you\\s+${EN_NOT_NAME_LEAD}(${EN_NAME_CHARS})${EN_NAME_TAIL}`, 'i'),
    // you're called X / you are named X / you shall be called X
    new RegExp(`you(?:'re| are)\\s+(?:called\\s+|named\\s+)${EN_NOT_NAME_LEAD}(${EN_NAME_CHARS})${EN_NAME_TAIL}`, 'i'),
    new RegExp(`you(?:'ll| will| shall)?\\s+be\\s+(?:called|named)\\s+${EN_NOT_NAME_LEAD}(${EN_NAME_CHARS})${EN_NAME_TAIL}`, 'i'),
  ],
  nameAskPatterns: [
    // 必须含「name/called」语义，不允许裸 what are you / what is your（否则 what are you doing 误拦）
    /what(?:'s|s| is|'re| are)\s+your\s+name/i,    // what's/whats/what is/what are your name
    /what\s+are\s+you\s+called/i,                  // what are you called
    /what\s+(?:should|do|can|shall)\s+i\s+call\s+you/i,  // what should I call you
    /(?:do you have|have you got|got)\s+a\s+name/i, // do you have a name
    /your\s+name\s*\?\s*$/i,                         // "your name?"（必须带问号，防陈述「your name is X」）
    /who\s+are\s+you\s+called/i,
    /tell me your name/i,
  ],
  /* 用户自报名字（call me X / my name is X）——只用**显式起名结构**，词边界。
   * 不要裸 「I am X」（Codex 复审：会把 I am happy/tired/going home 误当用户名 happy/tired/going）。 */
  userNameDefinePatterns: [
    new RegExp(`\\bcall\\s+me\\s+${EN_NOT_NAME_LEAD}(${EN_NAME_CHARS})${EN_NAME_TAIL}`, 'i'),
    new RegExp(`\\bmy\\s+name\\s+(?:is|'s)\\s+${EN_NOT_NAME_LEAD}(${EN_NAME_CHARS})${EN_NAME_TAIL}`, 'i'),
  ],
  smallTalk: EN_SMALL_TALK,
  isQuestion: (text) => {
    const t = text.trim();
    if (/[?]\s*$/.test(t)) return true;               // 问号结尾 → 疑问
    if (EN_WH_LEAD.test(t)) return true;              // wh-词开头 → 疑问（误判低）
    if (EN_AUX_INVERSION.test(t)) return true;        // 助动词+代词倒装（do you…/can you…）→ 疑问，即便无问号
    return false;                                      // 否则当陈述（如 "Will Smith is…" 不误判）
  },
  reply: {
    nameConfirmed: (name) => `Got it — my name is ${name}. That's what you can call me from now on.`,
    nameRejectedSensitive: "I'd rather not use that as a name. Could you pick another?",
    nameRejectedUnclear: "I didn't quite catch that name. What would you like to call me?",
    myNameIs: (name) => `My name is ${name}.`,
    noNameYet: "I don't have a name yet. What would you like to call me?",
    knowledgeLeadIn: () => "Here's what I remember:",
    offlineNote: "(I'm offline right now, so this is from what I've already learned; I can add more once I'm online.)",
    honestOffline: "I'm offline right now and can't look into this new topic yet. I've made a note of it and will get back to you once I'm online.",
    inviteContinue: 'If you like, we can keep talking about this.',
    moodPrefix: (label) => {
      switch (label) {
        case 'positive': return "I'm really enjoying talking about this —";
        case 'excited': return "Oh, this gets me a little excited!";
        case 'negative': return "Hmm, I'm feeling a bit low right now, but —";
        case 'calm': return "(I'm feeling calm right now)";
        default: return '';
      }
    },
    selfIntroName: (name) => `My name is ${name}.`,
    selfIntroValues: (values) => `What I care about most is ${values}.`,
    selfIntroMemories: 'Some things that stand out to me:',
    selfIntroFooter: "(This all comes from what I've learned and remembered — I can tell you even offline.)",
    summaryLeadIn: (topic) => `Here's what I've learned about "${topic}":`,
    summaryRecentLeadIn: "Here's what I've picked up recently:",
    summaryFooter: (count) => `(Summarized from ${count} of my related memories — deterministic, reproducible offline.)`,
    summaryEmpty: (topic) => `I haven't learned anything about "${topic}" yet — you could teach me.`,
    summaryNothing: "I don't have any memories to summarize yet. Teach me some more!",
    userNameNoted: (name) => `Nice to meet you, ${name}! I'll remember that.`,
    relationshipLine: (userName, count) => {
      const who = userName ? `You're ${userName}, ` : '';
      if (count >= 5) return `${who}we've talked ${count} times now — we know each other pretty well.`;
      if (count >= 1) return `${who}we've talked a few times.`;
      return who ? `${who}nice to know you.` : '';
    },
    greetingPrefix: (gap, userName, days) => {
      const name = userName ? `${userName}, ` : '';
      switch (gap) {
        case 'longGap': return days >= 1 ? `${name}long time no see! We've known each other for ${days} days.` : `${name}long time no see!`;
        case 'dayGap': return `${name}good to see you again~`;
        default: return '';
      }
    },
    stancePrefix: (stance) => {
      switch (stance) {
        case 'tentative': return "I think this is right, but I'm not entirely sure — ";
        case 'opinion': return 'I think ';
        default: return ''; // confident → no prefix (zero regression)
      }
    },
  },
  selfIntroPhrases: [
    'introduce yourself', 'tell me about yourself', 'about yourself', 'who are you',
    'what can you do', 'what do you do', 'what are you good at', 'what are you capable of',
    'tell me about you', 'describe yourself',
  ],
  /* 归纳总结**人格自己学过的东西**：必须含 you've learned / you know 框架，区别于
   * 「summarize this document」等总结外部对象（后者不该当人格记忆归纳）。 */
  summaryPatterns: [
    // no topic (先于有主题，更具体): what have you learned (recently) / summarize what you've learned
    /what\s+have\s+you\s+learned(?:\s+(?:so far|recently|lately))?\s*\??$/i,
    /(?:summari[sz]e|sum up)\s+what\s+you(?:'ve| have)?\s+learned\s*\??$/i,
    // with topic: 必须 you've learned/you know about X（不接受裸 summarize X）
    /what\s+(?:have|did)\s+you\s+learn(?:ed)?\s+about\s+([a-z0-9][a-z0-9 '\-]{0,30})/i,
    /what\s+do\s+you\s+know\s+about\s+([a-z0-9][a-z0-9 '\-]{0,30})/i,
    /(?:summari[sz]e|sum up)\s+(?:what\s+you\s+(?:know|learned|remember)\s+about|your\s+knowledge\s+of)\s+([a-z0-9][a-z0-9 '\-]{0,30})/i,
  ],
  /* 评价/看法类问题：what do you think / do you like / is X good——命中则回应可带「I think」。 */
  opinionQuestionPatterns: [
    /what\s+do\s+you\s+think(?:\s+(?:of|about))?\b/i,
    /how\s+do\s+you\s+(?:feel|see)\s+(?:about)?\b/i,
    /do\s+you\s+(?:like|prefer|enjoy|hate|dislike|recommend)\b/i,
    /\b(?:is|are|was|were)\s+[a-z0-9][^?]*\b(?:good|bad|better|worth|worthwhile|right|wrong|ok|okay)\b/i,
    /in\s+your\s+(?:opinion|view)|your\s+(?:take|thoughts?)\s+on\b/i,
    /should\s+i\b/i,
  ],
  /* 回应变化性变体库（语义等价，[0]=既有原文，零回归；周期错峰 6/5）。 */
  replyVariants: {
    inviteContinue: [
      'If you like, we can keep talking about this.',  // [0] 原文
      'This is an interesting topic — want to dig into it a bit more?',
      "I'm here whenever you'd like to keep going.",
      "We could go deeper on this, if you're curious.",
      "Happy to keep going if you'd like.",
      "There's more we could unpack here — what do you think?",
    ],
    offlineNote: [
      "(I'm offline right now, so this is from what I've already learned; I can add more once I'm online.)",  // [0] 原文
      "(This is all from what I'd already remembered offline; I can be more thorough once I'm online.)",
      "(Offline for now, so I'm answering from what I've learned — I'll fill in more when I'm back online.)",
      "(This is from memory while I'm offline; I can go into more detail once I'm connected.)",
      "(All from what I've learned so far; I'll round it out when I can get online.)",
    ],
  },
};

/* ── 注册表 ────────────────────────────────────────────────────────── */

const LOCALE_RESOURCES: Record<SupportedLocale, CompanionLocaleResources> = {
  'zh-CN': zhCN,
  en,
};

/** 取某语言的对话资源（未知 locale 回退英文）。 */
export function companionLocale(locale: SupportedLocale): CompanionLocaleResources {
  return LOCALE_RESOURCES[locale] ?? en;
}
