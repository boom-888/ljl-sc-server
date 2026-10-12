/**
 * 📨 SMS Gateway — 短信网关统一适配层
 * 支持 provider: mock | aliyun
 *
 * 生产部署：
 *   1. 装阿里云 SDK: npm install @alicloud/dysmsapi20170525
 *   2. .env: SMS_PROVIDER=aliyun + 填 ACCESS_KEY / SECRET_KEY / SIGN / TEMPLATE
 *   3. 代码自动切换，无需改业务逻辑
 *
 * TODO（用户提供后）:
 *   - aliyun 接入：需用真实 AccessKey + 已审核通过的 SignName + TemplateCode
 *   - 支持腾讯云 / 华为云扩展（只需实现 ISmsProvider 接口）
 */

import { log } from '../logger';

interface ISmsProvider {
  sendCode(phone: string, code: string): Promise<{ success: boolean; msg: string }>;
}

// — Provider 1: Mock（开发/测试默认）—
class MockSmsProvider implements ISmsProvider {
  async sendCode(phone: string, code: string) {
    // 日志里打出来方便开发测试
    log(`[SMS Mock] → ${phone} code=${code}`, 'info');
    return { success: true, msg: 'mock ok' };
  }
}

// — Provider 2: 阿里云 Dysmsapi（生产用）—
class AliyunSmsProvider implements ISmsProvider {
  private dysmsapi: any;
  private sign: string;
  private template: string;

  constructor() {
    // 延迟 import（没装 SDK 也不会崩）
    try {
      const Dysmsapi = require('@alicloud/dysmsapi20170525');
      const OpenApi = require('@alicloud/openapi-client');
      const Util = require('@alicloud/tea-util');
      this.dysmsapi = { Dysmsapi, OpenApi, Util };
    } catch {
      log('[SMS] 阿里云 SDK 未安装 → 降级到 mock', 'warn');
    }
    this.sign = process.env.SMS_SIGN_NAME || '';
    this.template = process.env.SMS_TEMPLATE_CODE || '';
  }

  async sendCode(phone: string, code: string) {
    if (!this.dysmsapi) {
      return { success: false, msg: '阿里云 SDK 未安装' };
    }
    if (!process.env.SMS_ACCESS_KEY || !process.env.SMS_SECRET_KEY) {
      return { success: false, msg: '阿里云 AccessKey 未配置' };
    }
    if (!this.sign || !this.template) {
      return { success: false, msg: '阿里云签名/模板未配置' };
    }

    try {
      const { Dysmsapi, OpenApi, Util } = this.dysmsapi;
      const client = new Dysmsapi.default({
        accessKeyId: process.env.SMS_ACCESS_KEY,
        accessKeySecret: process.env.SMS_SECRET_KEY,
        endpoint: 'dysmsapi.aliyuncs.com',
      });

      const req = new Dysmsapi.SendSmsRequest({
        phoneNumbers: phone,
        signName: this.sign,
        templateCode: this.template,
        templateParam: JSON.stringify({ code }),
      });

      const resp = await client.sendSmsWithOptions(req, new Util.RuntimeOptions({}));
      if (resp.body.code === 'OK') {
        log(`[SMS Aliyun] ✅ → ${phone} code=${code}`, 'info');
        return { success: true, msg: 'aliyun ok' };
      } else {
        log(`[SMS Aliyun] ❌ ${phone}: ${resp.body.code} ${resp.body.message}`, 'error');
        return { success: false, msg: resp.body.message };
      }
    } catch (e: any) {
      log(`[SMS Aliyun] ❌ Exception: ${e.message}`, 'error');
      return { success: false, msg: e.message };
    }
  }
}

// — 单例导出 —
let instance: ISmsProvider;

function getProvider(): ISmsProvider {
  if (instance) {
    return instance;
  }
  const provider = (process.env.SMS_PROVIDER || 'mock').toLowerCase();
  switch (provider) {
    case 'aliyun':
      instance = new AliyunSmsProvider();
      break;
    default:
      instance = new MockSmsProvider();
  }
  log(`📨 SMS Provider: ${provider} (${process.env.NODE_ENV || 'dev'})`, 'info');
  return instance;
}

export const smsGateway = {
  sendCode: async (phone: string, code: string) => getProvider().sendCode(phone, code),
  getProviderName: () => (process.env.SMS_PROVIDER || 'mock').toLowerCase(),
  // 方便测试替换
  _setProvider: (p: ISmsProvider) => {
    instance = p;
  },
  // 模板短信 stub（当前没接入真实模板短信服务，先 log 不真发）
  sendTemplateSms: async (opts: any) => {
    log(`[SMS-STUB] sendTemplateSms → ${JSON.stringify(opts).slice(0, 200)}`, 'info');
    return { ok: true, stub: true };
  },
  // 批量发送 stub
  batchSend: async (opts: any) => {
    log(`[SMS-STUB] batchSend phones=${opts?.phones?.length || 0} templateKey=${opts?.templateKey}`, 'info');
    return { ok: true, stub: true };
  },
};

export default smsGateway;
