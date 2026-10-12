// ============================================================================
// 📱 WeChat Client — 微信开放平台 / 小程序 API 封装
// 支持 code2session 换 openid+unionid、encryptedData 解密手机号
// 开发态（缺少真实 WX_* 环境变量）自动降级本地 mock，保证端到端可跑
// ============================================================================
import crypto from 'crypto';
import { log } from '../logger';

const WX_MINI_APPID = process.env.WX_MINI_PROGRAM_APPID || process.env.WX_APPID || '';
const WX_MINI_SECRET = process.env.WX_MINI_PROGRAM_SECRET || process.env.WX_APPSECRET || '';

// 🛡️ mock 模式：没有配置真实密钥时自动走本地假数据
const MOCK_MODE = !WX_MINI_APPID || !WX_MINI_SECRET;

/** 微信登录返回结构 */
export interface WechatLoginResult {
  openid: string;
  unionid?: string;
  sessionKey: string;
  mock?: boolean;
}

/** 平台类型：mini=小程序 app=APP h5=公众号 */
export type WechatPlatform = 'mini' | 'app' | 'h5';

/**
 * 用前端传的 code 换 openid + unionid + sessionKey
 * 真实调用：https://api.weixin.qq.com/sns/jscode2session
 * 开发 mock：直接用 code 生成确定性 openid（同 code 永远同结果）
 */
export async function wechatCode2Session(
  platform: WechatPlatform,
  code: string,
): Promise<WechatLoginResult> {
  if (!code) {
    throw new Error('wechatCode2Session: code 不能为空');
  }

  // 🧪 开发 mock 模式
  if (MOCK_MODE) {
    return mockCode2Session(platform, code);
  }

  // ✅ 真实 HTTP 调用（只实现了小程序 jscode2session，APP/H5 走开放平台 OAuth2）
  if (platform === 'mini') {
    return await realMiniCode2Session(code);
  }

  // APP / H5 暂未真实接入开放平台 OAuth2，先走 mock
  log(`[wechat-client] platform=${platform} 暂未真实接入开放平台，走 mock`);
  return mockCode2Session(platform, code);
}

/**
 * 解密微信 encryptedData 里的手机号（前端 wx.getPhoneNumber 拿到的 encryptedData + iv）
 * 算法：AES-128-CBC，key = base64_decode(sessionKey)，padding = PKCS#7
 */
export function decryptWechatPhone(
  sessionKey: string,
  encryptedData: string,
  iv: string,
): string | null {
  if (!sessionKey || !encryptedData || !iv) {
    return null;
  }
  try {
    const sessionKeyBuf = Buffer.from(sessionKey, 'base64');
    const ivBuf = Buffer.from(iv, 'base64');
    const encryptedBuf = Buffer.from(encryptedData, 'base64');

    const decipher = crypto.createDecipheriv('aes-128-cbc', sessionKeyBuf, ivBuf);
    decipher.setAutoPadding(true);
    const decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
    const json = JSON.parse(decrypted.toString('utf8'));

    // 微信手机号字段：purePhoneNumber 去掉国家码
    return json.purePhoneNumber || json.phoneNumber || null;
  } catch (e: any) {
    log(`[wechat-client] 解密手机号失败: ${e.message}`, 'warn');
    return null;
  }
}

// ============== 内部实现 ==============

/** 真实：小程序 jscode2session */
async function realMiniCode2Session(code: string): Promise<WechatLoginResult> {
  const url =
    `https://api.weixin.qq.com/sns/jscode2session` +
    `?appid=${WX_MINI_APPID}&secret=${WX_MINI_SECRET}&js_code=${code}&grant_type=authorization_code`;

  const resp = await fetch(url);
  const json: any = await resp.json();

  if (json.errcode) {
    // 微信错误码常见：40029 code 无效、40013 appid 无效、40125 secret 无效
    throw new Error(`微信 code2session 失败: errcode=${json.errcode} errmsg=${json.errmsg}`);
  }

  if (!json.openid) {
    throw new Error('微信 code2session 返回无 openid');
  }

  return {
    openid: json.openid as string,
    unionid: json.unionid as string | undefined,
    sessionKey: json.session_key as string,
  };
}

/** 开发 mock：用 code 的后 8 位生成确定性 openid，unionid 拼 wx_union 前缀 */
function mockCode2Session(platform: WechatPlatform, code: string): WechatLoginResult {
  const suffix = crypto.createHash('sha256').update(code).digest('hex').slice(-16);
  const openid = `${platform}_${suffix}`;
  const unionid = `wx_union_${suffix}`; // mock 也给 unionid，简化测试流程
  const sessionKey = crypto.createHash('sha256').update(`session_${code}`).digest('base64').slice(0, 24);

  log(`[wechat-client:MOCK] code2session platform=${platform} openid=${openid} unionid=${unionid}`);
  return { openid, unionid, sessionKey, mock: true };
}

/** 状态：当前 wechat-client 是否运行在 mock 模式 */
export function isWechatMockMode(): boolean {
  return MOCK_MODE;
}
