/**
 * 💳 WeChat Pay Adapter — 微信支付统一适配层
 * 支持 mock（开发/测试）+ wechatpay-node-v3（生产）
 *
 * 生产部署：
 *   1. 装 SDK: npm install wechatpay-node-v3
 *   2. .env: WX_PAY_ENABLED=true + 填 APPID / MCHID / API3_KEY
 *   3. 放商户证书到 /opt/ljl-sc/certs/
 *      - apiclient_cert.pem（商户 API 证书）
 *      - apiclient_key.pem（商户 API 证书私钥）
 *   4. 服务器 Nginx 暴露回调地址: /api/pay/wechat/callback
 *
 * TODO（用户提供后）:
 *   - 真实回调 URL: https://你的域名/api/pay/wechat/callback
 *   - 真实证书文件（从微信商户平台下载）
 *   - V3 密钥（32 位随机，商户平台设置）
 */

import { log } from '../logger';

interface IPayProvider {
  /** 创建支付订单 → 返回 prepayId 或 mock token */
  createOrder(params: {
    outTradeNo: string; // 商户订单号
    description: string; // 商品描述
    amount: number; // 金额（分）
    openid?: string; // 用户 openid（JSAPI 支付必须）
  }): Promise<{ success: boolean; prepayId?: string; payParams?: any; msg?: string }>;

  /** 验证支付回调签名 */
  verifyCallback(
    headers: any,
    body: string,
  ): Promise<{ valid: boolean; data?: any; error?: string }>;

  /** 查询订单状态 */
  queryOrder(
    outTradeNo: string,
  ): Promise<{ paid: boolean; payTime?: Date; transactionId?: string }>;
}

// — Provider 1: Mock（开发/测试默认）—
class MockPayProvider implements IPayProvider {
  private paidOrders = new Map<string, { payTime: Date; transactionId: string }>();

  async createOrder(params: any) {
    const prepayId = `wx_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // mock: 500ms 后自动标记为已支付（模拟异步回调）
    setTimeout(() => {
      this.paidOrders.set(params.outTradeNo, {
        payTime: new Date(),
        transactionId: `MOCK_${params.outTradeNo}`,
      });
      log(`[Pay Mock] ✅ ${params.outTradeNo} 已支付 (mock auto-confirm)`, 'info');
    }, 500);

    log(`[Pay Mock] → outTradeNo=${params.outTradeNo} amount=${params.amount}fen`, 'info');
    return { success: true, prepayId };
  }

  async verifyCallback(headers: any, body: string) {
    try {
      const data = JSON.parse(body);
      return { valid: true, data };
    } catch {
      return { valid: false, error: 'bad body' };
    }
  }

  async queryOrder(outTradeNo: string) {
    const paid = this.paidOrders.get(outTradeNo);
    if (paid) {
      return { paid: true, payTime: paid.payTime, transactionId: paid.transactionId };
    }
    return { paid: false };
  }
}

// — Provider 2: 微信支付 V3（生产）—
class WeChatV3PayProvider implements IPayProvider {
  private wxpay: any;

  constructor() {
    if (!process.env.WX_PAY_ENABLED || process.env.WX_PAY_ENABLED !== 'true') {
      return;
    }

    try {
      const WxPay = require('wechatpay-node-v3');
      this.wxpay = new WxPay({
        appid: process.env.WX_APPID,
        mchid: process.env.WX_MCHID,
        publicKey: process.env.WX_CERT_PATH, // 平台证书
        privateKey: process.env.WX_KEY_PATH, // 商户私钥
      });
      log('💳 WeChat Pay V3 已就绪', 'info');
    } catch (e: any) {
      log(`[Pay] wechatpay-node-v3 加载失败 → mock: ${e.message}`, 'warn');
    }
  }

  async createOrder(params: any) {
    if (!this.wxpay) {
      return { success: false, msg: 'WxPay SDK 未加载' };
    }

    try {
      const result = await this.wxpay.transactions_jsapi({
        description: params.description,
        out_trade_no: params.outTradeNo,
        notify_url: `${process.env.DOMAIN_NAME || 'http://localhost:3001'}/api/pay/wechat/callback`,
        amount: { total: params.amount },
        payer: { openid: params.openid },
      });
      log(`[Pay WX] ✅ prepayId=${result.prepay_id}`, 'info');
      return { success: true, prepayId: result.prepay_id, payParams: result };
    } catch (e: any) {
      log(`[Pay WX] ❌ ${e.message}`, 'error');
      return { success: false, msg: e.message };
    }
  }

  async verifyCallback(headers: any, body: string) {
    if (!this.wxpay) {
      return { valid: false, error: 'SDK 未加载' };
    }
    try {
      const valid = this.wxpay.verifySign(headers, body);
      return { valid, data: JSON.parse(body) };
    } catch (e: any) {
      return { valid: false, error: e.message };
    }
  }

  async queryOrder(outTradeNo: string) {
    if (!this.wxpay) {
      return { paid: false };
    }
    try {
      const r = await this.wxpay.queryByOutTradeNo(outTradeNo);
      return { paid: r.trade_state === 'SUCCESS', transactionId: r.transaction_id };
    } catch {
      return { paid: false };
    }
  }
}

// — 单例 —
let instance: IPayProvider;

function getProvider(): IPayProvider {
  if (instance) {
    return instance;
  }
  instance =
    process.env.WX_PAY_ENABLED === 'true' ? new WeChatV3PayProvider() : new MockPayProvider();
  log(`💳 Pay Provider: ${instance.constructor.name}`, 'info');
  return instance;
}

export const payAdapter = {
  createOrder: (p: any) => getProvider().createOrder(p),
  verifyCallback: (h: any, b: string) => getProvider().verifyCallback(h, b),
  queryOrder: (no: string) => getProvider().queryOrder(no),
  isMock: () => getProvider() instanceof MockPayProvider,
};

export default payAdapter;
