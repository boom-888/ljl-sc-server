// ============================================================================
// 📱 Device 端点 — 推送设备注册 / 解绑 / 查询
// 小程序 / APP 端每次启动时调 register（传 pushToken/openid/registrationId）
// 用户退出登录时调 unregister（防止登出后还收到推送）
// ============================================================================
import { Router } from 'express';
import { getDataSource } from '../db-manager';
import { PushDeviceEntity, type PushChannel } from '../entities';
import { requireAuth, ok, fail, badRequest, log } from '../middleware/auth';

const router = Router();

// — POST /api/device/register — 注册推送设备 token —
// 鉴权：requireAuth（必须已登录）
// 场景：小程序/APP 启动时调；SSE 在 /api/events 端点自动注册不走这里
router.post('/register', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const body = req.body || {};
    const channel = (body.channel || '') as PushChannel;

    if (!['wx_subscribe', 'jpush_apns'].includes(channel)) {
      return badRequest(res, 'channel 必须是 wx_subscribe | jpush_apns（SSE 在 /api/events 自动注册）');
    }

    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return ok(res, { success: true, hint: '内存模式不写 push_devices' }, '设备注册成功');
    }

    const repo = ds.getRepository(PushDeviceEntity);

    // 构造 patch：根据 channel 取对应字段
    const patch: any = { userId, channel, enabled: 1, lastActiveAt: new Date() };
    if (channel === 'wx_subscribe') {
      if (!body.openid) return badRequest(res, 'wx_subscribe 通道需要 openid');
      patch.openid = body.openid;
      if (body.unionid) patch.unionid = body.unionid;
    } else if (channel === 'jpush_apns') {
      if (!body.registrationId && !body.deviceToken) {
        return badRequest(res, 'jpush_apns 通道需要 registrationId 或 deviceToken');
      }
      if (body.registrationId) patch.registrationId = body.registrationId;
      if (body.deviceToken) patch.deviceToken = body.deviceToken;
      if (body.pushPlatform) patch.pushPlatform = body.pushPlatform;
    }
    if (body.appVersion) patch.appVersion = body.appVersion;
    if (body.deviceModel) patch.deviceModel = body.deviceModel;

    // upsert：同 (userId, channel) 已存在则更新 enabled/lastActiveAt/字段
    const existing = await repo.findOne({ where: { userId, channel, enabled: 1 } });
    if (existing) {
      delete patch.userId; delete patch.channel;
      await repo.update(existing.id, patch);
      log(`[device:register] upsert userId=${userId} channel=${channel}`);
    } else {
      await repo.save(patch);
      log(`[device:register] create userId=${userId} channel=${channel}`);
    }

    ok(res, { success: true }, '设备注册成功');
  } catch (e: any) {
    log(`[device:register] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误');
  }
});

// — POST /api/device/unregister — 解绑推送设备 token —
// 场景：用户退出登录时调（可选传 channel；不传就解绑所有 wx_subscribe / jpush_apns）
router.post('/unregister', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { channel } = req.body || {};
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return ok(res, { success: true }, '已解绑');
    }
    const repo = ds.getRepository(PushDeviceEntity);
    const where: any = { userId, channel };
    if (!channel) delete where.channel;
    await repo.update(where, { enabled: 0 });
    log(`[device:unregister] userId=${userId} channel=${channel || 'all'}`);
    ok(res, { success: true }, '已解绑');
  } catch (e: any) {
    log(`[device:unregister] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误');
  }
});

// — GET /api/device/list — 当前用户活跃设备（调试/管理用）—
router.get('/list', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return ok(res, []);
    }
    const list = await ds
      .getRepository(PushDeviceEntity)
      .find({ where: { userId, enabled: 1 } });
    // 不暴露敏感字段（deviceToken/registrationId 前端自己传的，可能含敏感信息）
    const safe = list.map((d) => ({
      id: d.id,
      channel: d.channel,
      channelDetail: d.channel === 'wx_subscribe' ? { openid: d.openid, unionid: d.unionid } :
                     d.channel === 'jpush_apns' ? { registrationId: d.registrationId, pushPlatform: d.pushPlatform } :
                     { sseClientId: d.sseClientId },
      appVersion: d.appVersion,
      deviceModel: d.deviceModel,
      lastActiveAt: d.lastActiveAt,
    }));
    ok(res, safe);
  } catch (e: any) {
    fail(res, 500, '服务器内部错误');
  }
});

export default router;
