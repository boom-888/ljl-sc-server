// ============================================================================
// 🚫 Chat Filter Service — 防跳单核心
// 检测：手机号 / 微信 / QQ / 邮箱 / 敏感词 / 二维码提示
// 输出：{ passed: boolean, blocked?: boolean, reason?: string, matched?: string[] }
// ============================================================================

/** 敏感词库（跳单相关 + 违规） */
const SENSITIVE_WORDS = [
  // 联系方式（跳单目标）
  '微信',
  '加微',
  '加我',
  '我加你',
  'wx',
  'WX',
  'vx',
  'VX',
  'VX号',
  '微信号',
  'QQ',
  'qq',
  'QQ号',
  '腾讯',
  '电话',
  '手机号',
  '手机',
  'tel',
  'Tel',
  'call',
  '联系我',
  '私聊',
  '私下',
  '私我',
  '方便聊聊',
  '方便联系',
  '私发',
  // 违规交易
  '跳单',
  '绕开平台',
  '线下交易',
  '私下交易',
  '不走平台',
  '私下付款',
  '转账',
  '支付宝',
  '银行卡',
  '卡号',
  '转我',
  '转给我',
  // 引导性
  '扫描',
  '扫一扫',
  '扫码加',
  '二维码',
  '加个',
  '留下',
  '发一下',
  '发我一下',
  '方便吗',
];

/** 手机号/电话正则 */
const PHONE_REGEX = /(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})/g;
/** 邮箱正则 */
const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
/** QQ 号正则（5-10 位数字） */
const QQ_REGEX = /\b[1-9]\d{4,9}\b/g;
/** 微信号模式（字母+数字下划线，6-20 位） */
const WECHAT_REGEX = /(?:微信|wx|vx)?[:：\s]*[a-zA-Z][a-zA-Z0-9_-]{5,19}/gi;

export interface FilterResult {
  passed: boolean;
  blocked: boolean;
  reason?: string;
  matched?: string[];
  type?: 'phone' | 'email' | 'qq' | 'wechat' | 'word';
}

/** 对单条文本做完整检测 */
export function scanText(text: string): FilterResult {
  if (!text || text.trim().length === 0) {
    return { passed: false, blocked: true, reason: '消息内容不能为空' };
  }

  const matched: string[] = [];

  // 1. 手机号/电话
  const phones = text.match(PHONE_REGEX);
  if (phones && phones.length > 0) {
    matched.push(...phones);
    return {
      passed: false,
      blocked: true,
      reason: '消息中包含手机号，禁止直接联系方式',
      matched,
      type: 'phone',
    };
  }

  // 2. 邮箱
  const emails = text.match(EMAIL_REGEX);
  if (emails && emails.length > 0) {
    matched.push(...emails);
    return {
      passed: false,
      blocked: true,
      reason: '消息中包含邮箱地址，禁止直接联系方式',
      matched,
      type: 'email',
    };
  }

  // 3. 微信号/QQ
  const wechats = text.match(WECHAT_REGEX);
  if (wechats && wechats.length > 0) {
    matched.push(...wechats);
    return {
      passed: false,
      blocked: true,
      reason: '消息中包含微信/QQ，禁止直接联系方式',
      matched,
      type: 'wechat',
    };
  }

  // 4. 敏感词
  for (const word of SENSITIVE_WORDS) {
    if (text.includes(word)) {
      matched.push(word);
    }
  }
  if (matched.length > 0) {
    return {
      passed: false,
      blocked: true,
      reason: `消息包含敏感词：${matched.join('、')}`,
      matched,
      type: 'word',
    };
  }

  return { passed: true, blocked: false };
}

/** 渲染时脱敏（前端展示用）—— 保留内容但遮罩敏感信息 */
export function desensitizeText(text: string): { content: string; hasBlocked: boolean } {
  let out = text;
  let blocked = false;

  out = out.replace(PHONE_REGEX, () => {
    blocked = true;
    return '📱[联系方式已屏蔽]';
  });
  out = out.replace(EMAIL_REGEX, () => {
    blocked = true;
    return '📧[联系方式已屏蔽]';
  });
  out = out.replace(WECHAT_REGEX, () => {
    blocked = true;
    return '💬[联系方式已屏蔽]';
  });

  for (const word of SENSITIVE_WORDS) {
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    if (re.test(out)) {
      blocked = true;
      out = out.replace(re, '*'.repeat(word.length));
    }
  }

  return { content: out, hasBlocked: blocked };
}

/** 脱敏手机号 → 138****0001 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 7) {
    return phone || '';
  }
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

/** 脱敏微信号 */
export function maskWechat(wechat: string): string {
  if (!wechat) {
    return '';
  }
  return `平台内联系（${wechat.slice(0, 2)}***${wechat.slice(-2)}）`;
}
