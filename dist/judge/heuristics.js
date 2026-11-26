/**
 * 纯函数启发式判定（R1）：不调 LLM，只看任务文本判断"需求是否已经够清楚"。
 *
 * 判定顺序（先命中先返回）：bypass 关键词 → 追问/继续类消息 → 纯询问（问句/只读咨询）→ 文本过短且无动作 →
 * 四个需求维度（目标/范围/约束/验收标准）的覆盖度。
 */
/** 默认跳过关键词（R4）。 */
export const DEFAULT_BYPASS_KEYWORDS = ['直接做', '跳过提问', '不用问', 'skip'];
/** 缺失维度对应的追问提示。 */
export const DIMENSION_HINTS = {
    goal: '目标不明确：最终要交付什么？给谁用？',
    scope: '范围不明确：要动哪些文件/模块，哪些明确不做？',
    constraint: '约束不明确：技术栈、依赖、兼容性、风格或时间上的限制？',
    acceptance: '验收标准缺失：怎样算完成？用什么方式验证？',
};
/** 维度关键词：目标（有动作、有产出）。 */
const GOAL_WORDS = /(做|写|实现|搭建|开发|创建|新增|加个|修复|改|优化|重构|迁移|升级|翻译|整理|分析|生成|设计|部署|发布|测试|排查|调研|对比|总结|转换|导出|导入|接入|对接|编写|画|制作|搞|弄|\b(?:fix|add|implement|build|create|refactor|migrate|write|update|remove|delete|optimi[sz]e|translate|generate|analy[sz]e|design|deploy|publish|rewrite|upgrade|install|configure|support|enable|disable|clean|split|merge|rename|prepare|draft|compile|organi[sz]e|summari[sz]e)\b)/i;
/** 维度关键词：范围（边界、对象）。 */
const SCOPE_WORDS = /(只|仅|只要|只需要|范围|限定|针对|面向|所有|全部|部分|哪些|哪个|模块|页面|文件|目录|接口|字段|表|库|版本|第一步|先做|不含|除外|\b(?:only|all|each|every|field|fields|page|pages|file|files|directory|module|api|endpoint|component|table|schema|version|repo|repository|branch|config|first)\b)/i;
/** 维度关键词：约束（技术栈、限制、风格）。忽略大小写，便于匹配 Python / UTF-8 这类写法。 */
const CONSTRAINT_WORDS = /(用|基于|必须|不能|不要|需要|依赖|兼容|保持|风格|注释|技术栈|框架|语言|不许|禁止|限制|预算|时间|截止|格式|规范|utf-?8|中文|英文|node|python|js|ts|react|vue|java|go|rust|\b(?:must|should|shall|need|needs|require|requires|required|use|using|based\s+on|compatible|compatibility|keep|preserve|avoid|without|existing|format|layout|style|markdown|chinese|english)\b)/i;
/** 维度关键词：验收标准。 */
const ACCEPTANCE_WORDS = /(验收|标准|测试|通过|算完成|完成标准|结果|输出|期望|应该|返回|效果|达到|满足|可运行|跑通|全绿|正确|不报错|可用|验证|检查|示例|样例|截图|对比|\b(?:acceptance|criteria|test|tests|pass|passes|passing|expect|expected|output|verify|verified|green|works|working|screenshot|sample|example)\b)/i;
/** 动作动词（用于"短文本是否已构成一个可执行指令"）。 */
const ACTION_VERB = /(做|写|改|加|删|实现|搭建|开发|修复|优化|翻译|整理|分析|生成|设计|部署|测试|排查|调研|总结|转换|导出|接入|创建|重构|迁移|升级|安装|配置|画|制作)/;
/** 追问/继续类消息的开头。 */
const FOLLOW_UP_LEAD = /^(继续|接着|然后呢|然后|下一步|再来|嗯|好|可以|行|ok|OK|对|是的|收到|谢谢|辛苦)/;
/** 问句收尾：出现即说明用户在提问，而不是在派活。 */
const QUESTION_TAIL = /(吗|呢|么|嘛|是不是|能不能|可不可以|有没有|怎么样|如何|为什么|为啥|啥意思|多少|哪个好)\s*[？?]?$|[？?]\s*$/;
/** 询问式开头：让我查/看/评估/解释，而不是让我动手。 */
const INQUIRY_LEAD = /^(?:please\s+|pls\s+|could you\s+|can you\s+)?(请问|问一下|想问|问下|看看|看一下|检查|查一下|查查|列出|列一下|统计|解释|说明|对比|评估|推荐|你觉得|你认为|这个|那个|现在|目前|为啥|为什么|look|check|see|show|list|tell|explain|describe|review|evaluate|summari[sz]e|search|find|verify|what|why|how|which)/i;
/** 明确的动手信号：一旦出现就不算纯询问（"改一下这个吗"仍然要先澄清）。 */
const WRITE_SIGNAL = /(改|写|删|新建|实现|修复|重构|迁移|生成|替换|安装|部署|发布|合并|提交|制作|画|创建|搭建|开发|添加|增加|移除)|\b(?:fix|add|implement|build|create|refactor|migrate|write|update|remove|delete|change|edit|rename|move|split|merge|install|deploy|publish|upgrade|generate|replace)\b/i;
/** 具体化信号：出现即说明用户给了可落地的细节。 */
const SPECIFIC_PATTERNS = [
    /[A-Za-z0-9_\-./\\]+\.(ts|js|mjs|cjs|tsx|jsx|json|md|py|go|rs|java|c|cc|cpp|h|hpp|yml|yaml|toml|txt|csv|xlsx|png|jpg|jpeg|svg|html|css|vue|sh|ps1)/i,
    /(^|[\s（("'])(\/|\.\/|\.\.\/|[A-Za-z]:\\)/,
    /```/,
    /https?:\/\//,
    /\d+\s*(个|条|字|行|秒|分钟|小时|天|次|元|%|万|k|K|MB|GB)/,
];
/** "把 X 改成/翻译成 Y"这类两端都明确的指令。 */
const TRANSFORM_PATTERN = /(把|将)[^，。；;]{1,60}(翻译|改|换|替换|转|转换|变|格式化成)(成|为)/;
/** 变更类语气词（drift-check 用）。 */
const DRIFT_MARKERS = /(算了|改成|换成|不做了|不做了|换个|推倒重来|重新做|别做了|不搞了|改主意)/;
/** 外发/发送/发邮件/发通知信号。 */
const SEND_SIGNAL = /(?:(?:发送|(?<!研|开)发)[^\s，。；;,！？!?]{0,12}(?:报告|周报|月报|日报|总结|邮件|通知|消息)|邮件发送|外发|\bsend\s+(?:the\s+|this\s+|a\s+)?(?:[\w-]+\s+){0,3}(?:report|email|message|notification)\b|\bemail\s+(?:the\s+|this\s+)?(?:[\w-]+\s+){0,3}(?:report|summary|update)\b)/i;
/** 显式缺失收件人。 */
const EXPLICIT_MISSING_RECIPIENT = /(?:未指定收件人|没(?:有)?(?:说|给|写|指定)收件人|收件人(?:待定|未知|未定|不明|未填)|\bmissing\s+recipient\b|\bno\s+recipient\b|\brecipient\s+(?:tbd|unknown|missing|unspecified)\b)/i;
/** 邮箱地址或具体发送对象。 */
const HAS_RECIPIENT = new RegExp([
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+',
    '(?:发给|发送给|寄给|抄送给?|转给|汇报给|通知给)\\s*(?!(?:谁|哪位|哪里|待定|未知|未定|未指定|无|空))[\\u4e00-\\u9fa5A-Za-z0-9_@#][^\\s，。；;,！？!?]*',
    '(?:发送|(?<!研|开)发)[^\\s，。；;,！？!?]{0,12}(?:报告|周报|月报|日报|总结|邮件|通知|消息)给\\s*(?!(?:谁|哪位|哪里|待定|未知|未定|未指定|无|空))[\\u4e00-\\u9fa5A-Za-z0-9_@#][^\\s，。；;,！？!?]*',
    '给\\s*(?!(?:谁|哪位|哪里|待定|未知|未定|未指定))[\\u4e00-\\u9fa5A-Za-z0-9_@#][^\\s，。；;,！？!?]{0,16}(?:发邮件|发送邮件|发报告|发送报告|发通知|发送通知)',
    '收件人\\s*(?:[：:]|\\s)\\s*(?!(?:待定|未知|未定|未指定|无|空|谁|none|tbd|unknown))[^\\s，。；;,！？!?]+',
    '(?<!发|发送)通知\\s*(?!(?:内容|文案|模板|消息|格式|标题|邮件|一下|一声|谁|哪位|待定|未知|未定|未指定))[\\u4e00-\\u9fa5A-Za-z0-9_@#]+',
    '\\bto\\s+(?!(?:be|do|make|get|use|run|check|verify|test|confirm|ensure|fix|update|complete|finish|avoid|keep|see|show|review|pass|output|send|email|tbd|unknown|unspecified|none)\\b)[A-Za-z0-9_@][A-Za-z0-9_.@+-]*',
].join('|'), 'i');
/** 发布/部署目标信号。 */
const PUBLISH_OR_DEPLOY_SIGNAL = /(?:发布到|公开发布|对外发布|部署到|\bpublish\s+to\b|\bdeploy\s+to\b)/i;
/** 公开发布/对外发布信号（无明确渠道时属阻塞缺口）。 */
const PUBLIC_PUBLISH_SIGNAL = /(?:公开发布|对外发布)/;
/** 显式缺失发布渠道或目标环境。 */
const EXPLICIT_MISSING_PUBLISH_TARGET = /(?:未指定(?:发布|部署|目标|渠道|环境)|没(?:有)?(?:指定|说|写)(?:发布|部署|目标|渠道|环境)|(?:发布|部署|目标)?(?:渠道|环境|平台)(?:待定|未知|未定)|(?:发布到|部署到)\s*(?:哪里|哪儿|哪|待定|未知|未定|$|[，。；;,！？!?])|\b(?:publish|deploy)\s+to\s*(?:where|tbd|unknown|unspecified|$|[,.;!?])|\b(?:target|environment|channel)\s+(?:tbd|unknown|missing|unspecified)\b|\bmissing\s+(?:target|environment|channel)\b)/i;
/** 常见发布平台/渠道/目标环境词。 */
const PUBLISH_CHANNEL_WORDS = /(?:github|gitlab|npm|pypi|docker(?:\s*hub)?|vercel|netlify|cloudflare|aws|gcp|azure|aliyun|阿里云|腾讯云|华为云|官网|博客|公众号|微信公众号|知乎|掘金|小红书|微博|推特|twitter|x\.com|youtube|bilibili|b站|飞书|钉钉|企业微信|slack|discord|telegram|app\s*store|google\s*play|生产环境|正式环境|预发环境|测试环境|线上|内网|外网|\bstaging\b|\bprod(?:uction)?\b|\bdev(?:elopment)?\b|\brelease\b|\bmarketplace\b|商店|论坛|社区|文档站|\bdocs\b|\bpages\b|https?:\/\/)/i;
/** 显式缺失目标文件/路径。 */
const EXPLICIT_MISSING_FILE = /(?:未指定目标文件|目标文件(?:待定|未知|未定)|没(?:有)?指定(?:目标)?文件|\bmissing\s+target\s+file\b|\bno\s+target\s+file\b)/i;
/** 多轮追问合并文本中，检查后续行是否已补齐前面显式标出的缺失事实。 */
function resolvedInLaterLine(text, missingPattern, isResolved) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 2)
        return false;
    let lastMissing = -1;
    let lastResolved = -1;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (missingPattern.test(line))
            lastMissing = i;
        if (isResolved(line) && !missingPattern.test(line))
            lastResolved = i;
    }
    return lastMissing >= 0 && lastResolved > lastMissing;
}
/**
 * 独立检测任务文本中缺失的关键阻塞事实（如外发缺收件人、发布/部署缺渠道环境、显式缺目标文件）。
 * 只针对明显缺失且影响执行安全/正确性的关键事实，避免误伤普通开发任务。
 */
export function detectMissingCriticalFacts(text) {
    const flat = (text ?? '').trim();
    if (flat === '')
        return [];
    const missing = [];
    if (SEND_SIGNAL.test(flat)) {
        const explicitMissing = EXPLICIT_MISSING_RECIPIENT.test(flat) &&
            !resolvedInLaterLine(flat, EXPLICIT_MISSING_RECIPIENT, (line) => HAS_RECIPIENT.test(line));
        if (explicitMissing || !HAS_RECIPIENT.test(flat)) {
            missing.push('关键事实缺失：未指定收件人或发送对象，请先确认发给谁。');
        }
    }
    if (PUBLISH_OR_DEPLOY_SIGNAL.test(flat)) {
        const explicitMissing = EXPLICIT_MISSING_PUBLISH_TARGET.test(flat) &&
            !resolvedInLaterLine(flat, EXPLICIT_MISSING_PUBLISH_TARGET, (line) => PUBLISH_CHANNEL_WORDS.test(line));
        const publicWithoutChannel = PUBLIC_PUBLISH_SIGNAL.test(flat) && !PUBLISH_CHANNEL_WORDS.test(flat);
        if (explicitMissing || publicWithoutChannel) {
            missing.push('关键事实缺失：未指定发布渠道或目标环境，请先确认发布到哪里。');
        }
    }
    if (EXPLICIT_MISSING_FILE.test(flat) &&
        !resolvedInLaterLine(flat, EXPLICIT_MISSING_FILE, (line) => hasSpecifics(line))) {
        missing.push('关键事实缺失：未指定目标文件或对象，请先明确操作目标。');
    }
    return missing;
}
/** 统计文本命中的维度。 */
export function detectDimensions(text) {
    return {
        goal: GOAL_WORDS.test(text),
        scope: SCOPE_WORDS.test(text),
        constraint: CONSTRAINT_WORDS.test(text),
        acceptance: ACCEPTANCE_WORDS.test(text),
    };
}
/** 已命中的维度个数。 */
export function satisfiedCount(hit) {
    return Number(hit.goal) + Number(hit.scope) + Number(hit.constraint) + Number(hit.acceptance);
}
/** 文本是否带具体化细节（路径、代码块、数量等）。 */
export function hasSpecifics(text) {
    return SPECIFIC_PATTERNS.some((pattern) => pattern.test(text));
}
/** 纯 ASCII 关键词（如 skip）的匹配用：把词边界定义成"不是字母/数字/下划线/连字符"。 */
const ASCII_WORD_CHARS = 'a-z0-9_-';
/** 紧贴在关键词之前的否定词：出现即说明用户是在"拒绝跳过"，不是在"要求跳过"。 */
const CN_NEGATION_TAIL = /(?:不要|不用|不需要|不必|不许|不准|不可以|不能|禁止|无需|勿|别)\s*$/;
/** 英文否定：don't skip / do not skip / never skip。 */
const EN_NEGATION_TAIL = /(?:\b(?:do\s+not|don't|dont|never|not|no))\s*$/i;
/** 关键词在 index 处是否被紧邻的否定词修饰（"不要直接做"不是"直接做"指令）。 */
function negatedBefore(lowerText, index) {
    // 只看 8 个字符内的前缀，且要求否定词紧贴关键词；"不用问，直接做"里的逗号会隔断，不会误伤。
    const prefix = lowerText.slice(Math.max(0, index - 8), index);
    return CN_NEGATION_TAIL.test(prefix) || EN_NEGATION_TAIL.test(prefix);
}
/**
 * 单个关键词是否命中：中文按子串，纯英文按词边界（避免 skipList / bypass-keyword 这类标识符误判）。
 *
 * 命中后还要看紧邻前缀：被否定词修饰的出现不算命中，否则"不要直接做，先问清楚"会被当成跳过指令，
 * 与用户的明确授权相反。
 */
function matchKeyword(lowerText, keyword) {
    const kw = keyword.trim().toLowerCase();
    if (kw === '')
        return false;
    // 含非 ASCII（中文等）的关键词：没有词边界概念，直接子串匹配
    // eslint-disable-next-line no-control-regex
    if (!/^[\x20-\x7e]+$/.test(kw)) {
        let from = 0;
        while (true) {
            const index = lowerText.indexOf(kw, from);
            if (index < 0)
                return false;
            if (!negatedBefore(lowerText, index))
                return true;
            from = index + kw.length;
        }
    }
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^${ASCII_WORD_CHARS}])${escaped}($|[^${ASCII_WORD_CHARS}])`, 'g');
    let match;
    while ((match = pattern.exec(lowerText)) !== null) {
        const index = match.index + (match[1]?.length ?? 0);
        if (!negatedBefore(lowerText, index))
            return true;
        pattern.lastIndex = index + kw.length;
    }
    return false;
}
/** 是否命中用户显式跳过词（R4）。被否定词修饰的出现（"不要直接做"）不算命中。 */
export function hasBypassKeyword(text, keywords) {
    const lower = text.toLowerCase();
    return keywords.some((keyword) => matchKeyword(lower, keyword));
}
/** 是否是"继续/追问"类短消息（R1：不触发提问）。 */
export function isFollowUpMessage(text) {
    if (text.length >= 15)
        return false;
    if (!FOLLOW_UP_LEAD.test(text))
        return false;
    // "好，那帮我做个 X" 这类其实带新任务，别误判成追问。
    const withoutLead = text.replace(FOLLOW_UP_LEAD, '');
    return !ACTION_VERB.test(withoutLead);
}
/** 由缺失维度生成追问提示。 */
export function buildFocusHints(hit, extra = [], text = '') {
    const tailored = /爬虫|抓取|采集|scrap/i.test(text)
        ? { scope: '范围不明确：采集哪个来源、哪些字段和多少条数据？', constraint: '约束不明确：访问权限、频率限制和输出格式是什么？', acceptance: '验收标准缺失：用哪份样本核对字段、完整性和去重结果？' }
        : /修复|报错|bug|fix/i.test(text)
            ? { scope: '范围不明确：问题发生在哪个模块，怎样复现？', constraint: '约束不明确：运行环境、版本及兼容限制是什么？', acceptance: '验收标准缺失：预期行为是什么，用哪个复现用例验证修复？' }
            : /报告|周报|文章|文案|写作|ppt|幻灯|write/i.test(text)
                ? { scope: '范围不明确：面向谁、涵盖哪些材料，篇幅和交付格式是什么？', constraint: '约束不明确：语气、引用来源和截止时间有什么要求？', acceptance: '验收标准缺失：读者需要理解什么或做出什么决定？' }
                : /页面|界面|设计|UI|design/i.test(text)
                    ? { scope: '范围不明确：面向哪些用户、页面和关键操作流程？', constraint: '约束不明确：平台、视觉参考和现有组件有哪些限制？', acceptance: '验收标准缺失：哪些操作应可完成，如何核对布局和交互？' }
                    : {};
    const hints = [];
    for (const key of ['goal', 'scope', 'constraint', 'acceptance']) {
        if (!hit[key])
            hints.push(tailored[key] ?? DIMENSION_HINTS[key]);
    }
    return [...extra, ...hints].slice(0, 4);
}
/**
 * 是否是"纯询问"消息：问句或让我查/看/评估，且没有任何动手信号。
 *
 * 这类消息不需要澄清——用户就是要一个回答，继续追问反而是打扰。
 * @param text 用户原文。
 */
export function isInquiry(text) {
    const flat = text.trim();
    if (flat === '')
        return false;
    if (/^(?:请问|想问|解释一下|解释|说明一下|如何|怎样|怎么|为什么|why\b|how\s+(?:to|does|do|can\s+i)\b)/i.test(flat)
        && !/(帮我|替我|请你|然后|并且|顺便).*(实现|改|写|修复|安装|部署)/.test(flat))
        return true;
    if (WRITE_SIGNAL.test(flat))
        return false;
    return QUESTION_TAIL.test(flat) || INQUIRY_LEAD.test(flat);
}
/** 各力度档位的判定阈值：维度下限 + 是否强制覆盖验收标准。 */
const INTENSITY_THRESHOLDS = {
    gentle: { dims: 2, needAcceptance: false },
    standard: { dims: 3, needAcceptance: false },
    grill: { dims: 3, needAcceptance: true },
};
/**
 * 判定任务文本是否需要澄清（纯函数，可单测）。
 * @param input 任务文本 + 模式 + 跳过关键词。
 */
export function judgeTask(input) {
    const text = (input.text ?? '').trim();
    const keywords = input.bypassKeywords ?? DEFAULT_BYPASS_KEYWORDS;
    const dimensions = detectDimensions(text);
    const satisfied = satisfiedCount(dimensions);
    const score = satisfied * 25;
    const intensity = input.intensity ?? 'standard';
    const threshold = INTENSITY_THRESHOLDS[intensity] ?? INTENSITY_THRESHOLDS.standard;
    if (text === '') {
        return {
            verdict: 'needs-clarification',
            score: 0,
            focus_hints: buildFocusHints(dimensions, ['没有收到任务内容：请把用户的原话或任务摘要传进来。']),
            dimensions,
            reason: 'empty-task',
        };
    }
    if (hasBypassKeyword(text, keywords)) {
        return { verdict: 'clear', score: 100, focus_hints: [], dimensions, reason: 'bypass-keyword' };
    }
    if (isFollowUpMessage(text)) {
        return { verdict: 'clear', score: 95, focus_hints: [], dimensions, reason: 'follow-up' };
    }
    if (isInquiry(text)) {
        return { verdict: 'clear', score: 90, focus_hints: [], dimensions, reason: 'inquiry' };
    }
    const missingFacts = detectMissingCriticalFacts(text);
    if (missingFacts.length > 0) {
        return {
            verdict: 'needs-clarification',
            score: Math.min(score, 50),
            focus_hints: buildFocusHints(dimensions, missingFacts, text),
            dimensions,
            reason: 'missing-critical-facts',
        };
    }
    if (input.mode === 'drift-check') {
        const drift = DRIFT_MARKERS.test(text);
        if (satisfied >= threshold.dims && (!threshold.needAcceptance || dimensions.acceptance) && text.length >= 20) {
            return { verdict: 'clear', score, focus_hints: [], dimensions, reason: 'drift-well-specified' };
        }
        return {
            verdict: 'needs-clarification',
            score,
            focus_hints: buildFocusHints(dimensions, drift
                ? ['需求变更未说清：改成什么？原来哪部分不要了？新范围到哪里为止？']
                : ['这看起来是新目标：请确认是否要重新澄清需求。']),
            dimensions,
            reason: drift ? 'drift-vague' : 'drift-underspecified',
        };
    }
    if (text.length < 12 && !ACTION_VERB.test(text)) {
        return {
            verdict: 'needs-clarification',
            score,
            focus_hints: buildFocusHints(dimensions, ['任务描述太短：请把背景与期望结果说清楚。']),
            dimensions,
            reason: 'too-short',
        };
    }
    if (satisfied >= threshold.dims && (!threshold.needAcceptance || dimensions.acceptance)) {
        return { verdict: 'clear', score, focus_hints: [], dimensions, reason: 'dimensions-covered' };
    }
    if (satisfied === 2 && (!threshold.needAcceptance || dimensions.acceptance) && (hasSpecifics(text) || TRANSFORM_PATTERN.test(text))) {
        return { verdict: 'clear', score, focus_hints: [], dimensions, reason: 'small-explicit-task' };
    }
    return {
        verdict: 'needs-clarification',
        score,
        focus_hints: buildFocusHints(dimensions, [], text),
        dimensions,
        reason: 'dimensions-missing',
    };
}
