// ============================================================================
// 📬 Push — 统一推送核心
// 功能：限频+去重（Redis SETNX 5 分钟）→ 查用户设备 → 分派到三通道适配器
//       → 写审计日志 push_logs（成功/失败/通道详情）
// 三通道：wx_subscribe（微信订阅消息）| jpush_apns（极光/APNs）| sse（EventBus 长连接）
//
// 当前适配器实现阶段：
//   ✅ sse     — 已实现（调 eventBus 发布）
//   🔧 jpush   — 骨架+mock（生产填 .env 里极光 masterSecret 即可）
//   🔧 wx_subscribe — 骨架（申请到模板 ID 填 .env 即可）
// ============================================================================
import { getDataSource } from '../db-manager';
import { PushDeviceEntity, PushLogEntity, type PushChannel } from '../entities';
import { log } from '../logger';
import { eventBus } from './event-bus';

// — Redis 客户端（项目已接 ioredis，没有配置就 fallback 内存 Map 做去重）—
let _redis: any = null;
function getRedis() {
  if (_redis !== null) return _redis;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const IORedis = require('ioredis');
    const host = process.env.REDIS_HOST;
    if (host) {
      _redis = new IORedis({ host, port: Number(process.env.REDIS_PORT || 6379) });
      log(`[push] Redis 去重已接入 ${host}`);
    } else {
      _redis = false; // 显式 false 表示跳过
    }
  } catch {
    _redis = false;
  }
  return _redis;
}

// 内存 fallback：Redis 没配时用进程内 Map 做 SETNX（mock 模式也一样）
const _dedupMap = new Map<string, number>();

async function setnxDedup(key: string, ttlSec = 300): Promise<boolean> {
  const redis = getRedis();
  if (redis && redis !== false) {
    const ok = await redis.set(key, '1', 'NX', 'EX', ttlSec);
    return ok === 'OK';
  }
  // 内存 fallback
  const now = Date.now();
  const expiredAt = _dedupMap.get(key);
  if (expiredAt && expiredAt > now) return false;
  _dedupMap.set(key, now + ttlSec * 1000);
  return true;
}

// ============== 类型定义 ==============
export interface PushEvent {
  /** 事件类型：'order_paid' | 'install_master_accept' | 'design_delivered' ... */
  type: string;
  /** 推送标题（前端/平台内部用） */
  title: string;
  /** 推送内容 */
  content: string;
  /** 携带数据（订单号、ID 等，客户端点击后做跳转） */
  data?: Record<string, any>;
  /** 去重键（业务保证唯一，同一事件 5 分钟内只推一次） */
  dedupKey: string;
  /** 过期时间，超过就不推 */
  expireAt?: Date;
}

export interface PushResult {
  channel: PushChannel;
  success: boolean;
  error?: string;
}

// ============== 适配器接口 ==============
export interface PushAdapter {
  channel: PushChannel;
  push(device: PushDeviceEntity, event: PushEvent): Promise<PushResult>;
}

// — SSE 适配器：直接发布到 eventBus（PC Web 工作台 / H5 用）—
const sseAdapter: PushAdapter = {
  channel: 'sse',
  async push(device: PushDeviceEntity, event: PushEvent) {
    if (!device.sseClientId) {
      return { channel: 'sse', success: false, error: 'sseClientId 为空' };
    }
    // eventBus.subscribe 已经在 SSE /api/events 端点注册过
    eventBus.publish(device.sseClientId, {
      event: event.type,
      title: event.title,
      content: event.content,
      data: event.data,
      timestamp: Date.now(),
    });
    log(`[push:sse] → ${device.sseClientId} ${event.type}`);
    return { channel: 'sse', success: true };
  },
};

// — 微信订阅消息适配器 —
const wxSubscribeAdapter: PushAdapter = {
  channel: 'wx_subscribe',
  async push(device: PushDeviceEntity, event: PushEvent) {
    if (!device.openid) {
      return { channel: 'wx_subscribe', success: false, error: 'openid 为空' };
    }
    // 模板 ID 映射：event.type → 微信申请的模板 ID（.env 里配置）
    const templateId = getWxTemplateId(event.type);
    if (!templateId) {
      log(`[push:wx_subscribe] 跳过：event.type=${event.type} 未配置模板 ID`, 'warn');
      return { channel: 'wx_subscribe', success: false, error: '未配置模板 ID' };
    }

    // 真实调用 POST https://api.weixin.qq.com/cgi-bin/message/subscribe/send
    const WX_ACCESS_TOKEN = process.env.WX_ACCESS_TOKEN;
    if (!WX_ACCESS_TOKEN) {
      // 开发 mock：不调微信，只记日志
      log(`[push:wx_subscribe:MOCK] → openid=${device.openid} template=${templateId} event=${event.type}`);
      return { channel: 'wx_subscribe', success: true };
    }
    try {
      const resp = await fetch(
        `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${WX_ACCESS_TOKEN}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: device.openid,
            template_id: templateId,
            page: event.data?.page || 'pages/index/index',
            data: buildWxTemplateData(event),
          }),
        },
      );
      const json: any = await resp.json();
      if (json.errcode) {
        log(`[push:wx_subscribe] 微信返回错误 errcode=${json.errcode}`, 'warn');
        return { channel: 'wx_subscribe', success: false, error: json.errmsg };
      }
      return { channel: 'wx_subscribe', success: true };
    } catch (e: any) {
      return { channel: 'wx_subscribe', success: false, error: e.message };
    }
  },
};

// — 极光推送适配器 —
const jpushAdapter: PushAdapter = {
  channel: 'jpush_apns',
  async push(device: PushDeviceEntity, event: PushEvent) {
    if (!device.registrationId) {
      return { channel: 'jpush_apns', success: false, error: 'registrationId 为空' };
    }
    const JPUSH_APPKEY = process.env.JPUSH_APPKEY;
    const JPUSH_MASTER_SECRET = process.env.JPUSH_MASTER_SECRET;
    if (!JPUSH_APPKEY || !JPUSH_MASTER_SECRET) {
      log(`[push:jpush:MOCK] → registrationId=${device.registrationId} event=${event.type}`);
      return { channel: 'jpush_apns', success: true };
    }
    try {
      const token = Buffer.from(`${JPUSH_APPKEY}:${JPUSH_MASTER_SECRET}`).toString('base64');
      const resp = await fetch('https://api.jpush.cn/v3/push', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${token}`,
        },
        body: JSON.stringify({
          audience: { registration_id: [device.registrationId] },
          platform: 'all',
          message: {
            msg_content: event.content,
            title: event.title,
            extras: event.data || {},
          },
        }),
      });
      const json: any = await resp.json();
      if (json.error) {
        return { channel: 'jpush_apns', success: false, error: json.error.message };
      }
      return { channel: 'jpush_apns', success: true };
    } catch (e: any) {
      return { channel: 'jpush_apns', success: false, error: e.message };
    }
  },
};

// ============== 适配器注册表 ==============
const ADAPTERS: Record<PushChannel, PushAdapter> = {
  wx_subscribe: wxSubscribeAdapter,
  jpush_apns: jpushAdapter,
  sse: sseAdapter,
};

// ============== 主入口：业务层调这个 ==============
export async function push(userId: number, event: PushEvent): Promise<PushResult[]> {
  // 1. 过期检查
  if (event.expireAt && event.expireAt.getTime() < Date.now()) {
    log(`[push] 事件已过期 event=${event.type} dedup=${event.dedupKey}`, 'warn');
    return [];
  }

  // 2. 限频去重（Redis SETNX + 300s TTL）
  const dedupOk = await setnxDedup(`push:dedup:${event.dedupKey}`, 300);
  if (!dedupOk) {
    log(`[push] 跳过：dedup=${event.dedupKey} 5分钟内已推送过`, 'warn');
    return [];
  }

  // 3. 查用户所有活跃设备
  const devices = await getActiveDevicesByUserId(userId);
  if (devices.length === 0) {
    log(`[push] 跳过：userId=${userId} 无活跃设备`);
    return [];
  }

  // 4. 分派到各通道
  const results: PushResult[] = [];
  const channelGroups = new Map<PushChannel, PushDeviceEntity[]>();
  for (const d of devices) {
    const list = channelGroups.get(d.channel) || [];
    list.push(d);
    channelGroups.set(d.channel, list);
  }
  const tasks: Promise<PushResult>[] = [];
  for (const [channel, list] of channelGroups) {
    const adapter = ADAPTERS[channel];
    if (!adapter) continue;
    // 每个设备独立推
    for (const d of list) {
      tasks.push(adapter.push(d, event));
    }
  }
  const settled = await Promise.allSettled(tasks);
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(s.value);
    else results.push({ channel: 'sse', success: false, error: String(s.reason) });
  }

  // 5. 写审计日志
  await writePushLog(userId, event, results, devices);
  return results;
}

// ============== 辅助函数 ==============
async function getActiveDevicesByUserId(userId: number): Promise<PushDeviceEntity[]> {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(PushDeviceEntity).find({
      where: { userId, enabled: 1 },
    });
  }
  // 内存 fallback：db.ts 里还没注册 push_devices → 返回空数组
  return [];
}

async function writePushLog(
  userId: number,
  event: PushEvent,
  results: PushResult[],
  devices: PushDeviceEntity[],
) {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return; // 内存模式不写日志

  const channels = [...new Set(results.map((r) => r.channel))].join(',');
  const successCount = results.filter((r) => r.success).length;
  const failDetail = results.filter((r) => !r.success).map((r) => ({
    channel: r.channel,
    error: r.error,
  }));

  await ds
    .getRepository(PushLogEntity)
    .save({
      userId,
      eventType: event.type,
      dedupKey: event.dedupKey,
      channels,
      successCount,
      failCount: results.length - successCount,
      failDetail: failDetail.length ? failDetail : null,
    })
    .catch((e) => log(`[push] 写日志失败: ${e.message}`, 'warn'));
}

// ============== 微信订阅模板 ID 映射（.env 配置）==============
// 微信开放平台申请模板后，把模板 ID 填进 .env，这里按 event.type 取
function getWxTemplateId(eventType: string): string | null {
  const envMap: Record<string, string | undefined> = {
    order_paid: process.env.WX_TPL_ORDER_PAID,
    order_shipped: process.env.WX_TPL_ORDER_SHIPPED,
    install_master_accept: process.env.WX_TPL_INSTALL_ACCEPT,
    design_delivered: process.env.WX_TPL_DESIGN_DELIVERED,
    dispute_resolved: process.env.WX_TPL_DISPUTE_RESOLVED,
    security_change: process.env.WX_TPL_SECURITY_CHANGE,
  };
  return envMap[eventType] || null;
}

function buildWxTemplateData(event: PushEvent) {
  // 微信订阅模板数据格式：每个字段是 { value: 'xxx' }
  const obj: Record<string, { value: string }> = {};
  obj.thing1 = { value: truncate(event.title, 20) };
  obj.thing2 = { value: truncate(event.content, 20) };
  obj.time3 = { value: new Date().toLocaleString('zh-CN') };
  return obj;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ============== SSE 设备注册（给 index.ts 的 /api/events 端点用）==============
// 客户端建立 SSE 连接时，后端自动把 (userId, 'sse', clientId) 写入 push_devices
export async function registerSseDevice(userId: number, sseClientId: string) {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return;
  await ds.getRepository(PushDeviceEntity).save({
    userId,
    channel: 'sse',
    sseClientId,
    enabled: 1,
    lastActiveAt: new Date(),
  });
}

export async function unregisterSseDevice(sseClientId: string) {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return;
  await ds.getRepository(PushDeviceEntity).delete({ channel: 'sse', sseClientId });
}
