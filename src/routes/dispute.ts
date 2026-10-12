// ============================================================================
// Week 10 · C 端纠纷发起路由
// 用户侧：订单完成后 → 挂起退款前主动标记纠纷
// 与 DisputeEntity（sprint13-dispute.ts）配合
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, badRequest, notFound, log, AuthedRequest } from '../middleware/auth';
import { getDataSource } from '../db-manager';

const router = Router();

async function getEntities() {
  const m = await import('../entities');
  return {
    DisputeEntity: m.DisputeEntity,
    SettleOrderEntity: m.SettleOrderEntity,
    OrderEntity: (m as any).OrderEntity,
    DesignOrderEntity: (m as any).DesignOrderEntity,
    InstallationOrderEntity: (m as any).InstallationOrderEntity,
  };
}

// ========================================================
// 1️⃣ POST /api/disputes — 用户发起纠纷
//   body: orderId(必填), orderType(goods|design|install, 必填),
//         reasonType, reason(必填), claimAmount, description, images
// ========================================================
router.post('/disputes', requireAuth, async (req: AuthedRequest, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { id: Date.now(), status: 'pending', mock: true }, 'mock 模式，纠纷已受理');
  const userId = Number(req.userId);
  const body = req.body || {};

  const { orderId, orderType, reasonType, reason, claimAmount, description, images } = body;

  // — 必填校验 —
  if (!orderId || !orderType) return badRequest(res, 'orderId + orderType 必填');
  if (!['goods', 'design', 'install'].includes(orderType)) {
    return badRequest(res, 'orderType 必须是 goods / design / install');
  }
  if (!reason || reason.trim().length < 5) {
    return badRequest(res, '纠纷原因至少 5 个字');
  }

  try {
    const { DisputeEntity, SettleOrderEntity, OrderEntity, DesignOrderEntity, InstallationOrderEntity } = await getEntities();
    const dRepo = ds.getRepository(DisputeEntity);

    // — 订单归属校验：确保发起者是订单所属用户 —
    let belongToUser = false;
    let settleLink: number | undefined;
    let providerIdNum: number | undefined;
    let providerRoleStr: string | undefined;

    if (orderType === 'goods' && OrderEntity) {
      const order = await ds.getRepository(OrderEntity).findOne({ where: { id: Number(orderId) } });
      if (order) {
        if (Number((order as any).userId) === userId) belongToUser = true;
        providerIdNum = Number((order as any).vendorId) || undefined;
        providerRoleStr = 'vendor';
        // 查 settle_orders 有没有关联
        const settle = await ds.getRepository(SettleOrderEntity).findOne({ where: { orderId: String(orderId), orderType: 'goods' } });
        if (settle) settleLink = settle.id;
      }
    } else if (orderType === 'design' && DesignOrderEntity) {
      const order = await ds.getRepository(DesignOrderEntity).findOne({ where: { id: Number(orderId) } });
      if (order) {
        if (Number((order as any).userId) === userId) belongToUser = true;
        providerIdNum = Number((order as any).designerId) || undefined;
        providerRoleStr = 'designer';
        const settle = await ds.getRepository(SettleOrderEntity).findOne({ where: { orderId: String(orderId), orderType: 'design' } });
        if (settle) settleLink = settle.id;
      }
    } else if (orderType === 'install' && InstallationOrderEntity) {
      const order = await ds.getRepository(InstallationOrderEntity).findOne({ where: { id: Number(orderId) } });
      if (order) {
        if (Number((order as any).userId) === userId) belongToUser = true;
        providerIdNum = Number((order as any).installerId) || undefined;
        providerRoleStr = 'installer';
        const settle = await ds.getRepository(SettleOrderEntity).findOne({ where: { orderId: String(orderId), orderType: 'install' } });
        if (settle) settleLink = settle.id;
      }
    }

    if (!belongToUser) return fail(res, 403, '无权对该订单发起纠纷', 403);

    // — 同订单不能重复挂起未处理纠纷 —
    const existing = await dRepo
      .createQueryBuilder('d')
      .where('d.orderId = :oid', { oid: String(orderId) })
      .andWhere('d.orderType = :ot', { ot: orderType })
      .andWhere("d.status != 'resolved'")
      .getOne();
    if (existing) {
      return fail(res, 400, '该订单已有未处理的纠纷，请等待 admin 处理', 400);
    }

    // — 创建纠纷 —
    const d = dRepo.create({
      orderId: String(orderId),
      orderType,
      settleOrderId: settleLink ? String(settleLink) : undefined,
      userId,
      providerId: providerIdNum,
      providerRole: providerRoleStr,
      reasonType: reasonType || 'other',
      reason: reason.trim(),
      description,
      images: Array.isArray(images) ? images : undefined,
      claimAmount: claimAmount ? Math.max(0, Number(claimAmount)) : 0,
      status: 'pending',
    });
    const saved = await dRepo.save(d);

    log(`[dispute] userId=${userId} order=${orderType}:${orderId} → dispute#${saved.id} reason=${reasonType}`);
    ok(res, {
      id: saved.id, orderId: saved.orderId, orderType: saved.orderType,
      status: saved.status, createdAt: saved.createdAt,
    });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 2️⃣ GET /api/disputes/mine — 用户查看自己发起的纠纷
// ========================================================
router.get('/disputes/mine', requireAuth, async (req: AuthedRequest, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, []);
  const userId = Number(req.userId);
  try {
    const { DisputeEntity } = await getEntities();
    const repo = ds.getRepository(DisputeEntity);
    const rows = await repo
      .createQueryBuilder('d')
      .where('d.userId = :uid', { uid: userId })
      .orderBy('d.createdAt', 'DESC')
      .getMany();

    ok(res, rows.map(d => ({
      id: d.id, orderId: d.orderId, orderType: d.orderType,
      status: d.status, action: d.action,
      reasonType: d.reasonType, reason: d.reason,
      refundAmount: Number(d.refundAmount || 0), claimAmount: Number(d.claimAmount || 0),
      reviewRemark: d.reviewRemark,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    })));
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

export default router;
