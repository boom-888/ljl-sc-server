// ============================================================================
// 🎨 Design Order Routes — Week 2（TypeORM 版）
// 买家↔设计师文件流转：接单后 → 交付物版本链 → 验收/退回 → finalize → DesignFile 桥接
//
// 内部守卫：requireBuyerOfDemand / requireDesignerOfOrder（TypeORM repo 查询）
// ============================================================================
import { Router } from 'express';
import {
  requireAuth,
  ok,
  fail,
  badRequest,
  AuthedRequest,
  log,
} from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { eventBus } from '../services/event-bus';

const router = Router();

// — 动态 import 避免循环依赖 —
// ⚠️ getDataSource() 必须在每次请求时调用（不要模块顶部缓存！）
// 因为数据源初始化可能晚于模块加载，导致 ds 永远是 null
const entitiesPromise = import('../entities');

async function getRepos() {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    throw new Error('数据源未初始化');
  }
  const entities = await entitiesPromise;
  const {
    DesignOrderEntity,
    DesignDeliveryEntity,
    DesignRevisionRequestEntity,
    DesignDemandEntity,
    DesignFileEntity,
    SettleOrderEntity,
    DesignerProfileEntity,
  } = entities;
  return {
    orderRepo: ds.getRepository(DesignOrderEntity),
    deliveryRepo: ds.getRepository(DesignDeliveryEntity),
    revisionRepo: ds.getRepository(DesignRevisionRequestEntity),
    demandRepo: ds.getRepository(DesignDemandEntity),
    designFileRepo: ds.getRepository(DesignFileEntity),
    settleRepo: ds.getRepository(SettleOrderEntity),
    designerProfileRepo: ds.getRepository(DesignerProfileEntity),
  };
}

// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —
// 🛡️ 内部守卫（TypeORM 查询）
// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —

async function requireBuyerOfDemand(req: AuthedRequest, res: any, next: any) {
  const userId = req.userId!;
  const demandId = Number(req.params.id);
  const { demandRepo, orderRepo } = await getRepos();
  const demand = await demandRepo.findOne({ where: { id: demandId } });
  if (!demand) return fail(res, 404, '设计需求不存在', 404);
  if (Number(demand.userId) !== userId) return fail(res, 403, '无权操作', 403);
  (req as any).demand = demand;
  const order = await orderRepo.findOne({ where: { demandId } });
  if (order) (req as any).order = order;
  next();
}

async function requireDesignerOfOrder(req: AuthedRequest, res: any, next: any) {
  const userId = req.userId!;
  const orderId = Number(req.params.id || req.body?.orderId);
  const { orderRepo } = await getRepos();
  const order = await orderRepo.findOne({ where: { id: orderId } });
  if (!order) return fail(res, 404, '设计订单不存在', 404);
  if (Number(order.designerId) !== userId) return fail(res, 403, '非本订单设计师', 403);
  (req as any).order = order;
  next();
}

// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —
// 📖 查询：查 DesignOrder（买家/设计师共用，查 demand 详情时顺带）
// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —

// GET /demand/:id/order
router.get('/demand/:id/order', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const demandId = Number(req.params.id);
  const { demandRepo, orderRepo } = await getRepos();
  const demand = await demandRepo.findOne({ where: { id: demandId } });
  if (!demand) return fail(res, 404, '设计需求不存在', 404);
  if (Number(demand.userId) !== userId && Number(demand.designerId) !== userId) {
    return fail(res, 403, '无权查看', 403);
  }
  const order = (await orderRepo.findOne({ where: { demandId } })) || null;
  ok(res, order);
});

// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —
// 📦 交付物版本链（任意一方都能看）
// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —

// GET /demand/:id/deliveries
router.get('/demand/:id/deliveries', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const demandId = Number(req.params.id);
  const { demandRepo, orderRepo, deliveryRepo, revisionRepo } = await getRepos();
  const demand = await demandRepo.findOne({ where: { id: demandId } });
  if (!demand) return fail(res, 404, '设计需求不存在', 404);
  if (Number(demand.userId) !== userId && Number(demand.designerId) !== userId) {
    return fail(res, 403, '无权查看', 403);
  }
  const order = await orderRepo.findOne({ where: { demandId } });
  if (!order) {
    ok(res, { orderId: null, revisions: [] });
    return;
  }

  const deliveries = await deliveryRepo.find({
    where: { orderId: Number(order.id) },
    order: { revision: 'ASC' },
  });

  const revisionRequests = await revisionRepo.find({
    where: { orderId: Number(order.id) },
  });

  const revisions = deliveries.map((d) => {
    const rejection = revisionRequests.find(
      (r) => Number(r.fromDeliveryId) === Number(d.id),
    );
    return {
      revision: d.revision,
      status: d.status,
      summary: d.summary,
      createdAt:
        d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt,
      files: (d.files || []).map((f: any) => ({
        designFileId: f.designFileId,
        url: f.url,
        filename: f.filename,
        format: f.format,
        fileSize: f.fileSize,
      })),
      isFinal: !!d.isFinal,
      rejection: rejection
        ? {
            issueDesc: rejection.issueDesc,
            attachments: rejection.attachments || [],
            createdAt:
              rejection.createdAt instanceof Date
                ? rejection.createdAt.toISOString()
                : rejection.createdAt,
          }
        : null,
      reviewedAt:
        d.reviewedAt instanceof Date
          ? d.reviewedAt.toISOString()
          : d.reviewedAt || null,
      canAccept: d.status === 'uploaded',
      canRevise: d.status === 'uploaded',
    };
  });

  ok(res, {
    orderId: String(order.id),
    orderNo: order.orderNo,
    currentRevision: deliveries.length
      ? Math.max(...deliveries.map((d) => d.revision))
      : 0,
    status: order.status,
    revisionCount: order.revisionCount,
    revisions,
  });
});

// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —
// 🎨 设计师端：提交交付物 / finalize
// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —

// POST /designer/orders/:id/delivery
router.post(
  '/designer/orders/:id/delivery',
  requireAuth,
  async (req: AuthedRequest, res: any, next: any) => {
    const userId = req.userId!;
    const orderId = Number(req.params.id);
    const { orderRepo } = await getRepos();
    const order = await orderRepo.findOne({ where: { id: orderId } });
    if (!order) return fail(res, 404, '设计订单不存在', 404);
    if (Number(order.designerId) !== userId)
      return fail(res, 403, '非本订单设计师', 403);
    (req as any).order = order;
    next();
  },
  async (req: AuthedRequest, res) => {
    const order: any = (req as any).order!;
    if (!['accepted', 'designing', 'revision_requested'].includes(order.status)) {
      return badRequest(res, `当前状态 ${order.status} 不允许提交交付物`);
    }
    const { deliveryRepo, designFileRepo, orderRepo } = await getRepos();
    const files = req.body.files || [];
    if (!Array.isArray(files) || files.length === 0)
      return badRequest(res, 'files 不能为空');
    const summary = (req.body.summary || '').trim();
    if (!summary) return badRequest(res, 'summary 不能为空');

    // 分配 revision
    const existing = await deliveryRepo.find({
      where: { orderId: Number(order.id) },
    });
    const revision = existing.length
      ? Math.max(...existing.map((d) => d.revision)) + 1
      : 1;

    // 每个 fileId 所有权校验
    for (const f of files) {
      const df = await designFileRepo.findOne({
        where: { id: Number(f.designFileId) },
      });
      if (!df) return fail(res, 400, `文件 ${f.designFileId} 不存在`, 400);
      if (Number(df.userId) !== Number(order.designerId)) {
        return fail(res, 400, '文件所有权不匹配', 400);
      }
    }

    const now = new Date();
    const delivery = deliveryRepo.create({
      orderId: Number(order.id),
      revision,
      authorId: Number(order.designerId),
      summary,
      files: files.map((f: any) => ({
        designFileId: Number(f.designFileId),
        url: f.url || '',
        filename: f.filename || '',
        format: f.format || '',
        fileSize: f.fileSize,
      })),
      status: 'uploaded',
      isFinal: 0,
    });
    await deliveryRepo.save(delivery);

    // 更新订单状态
    if (order.status !== 'designing') {
      order.status = 'designing';
      order.updatedAt = now;
      await orderRepo.update(order.id, {
        status: 'designing',
        updatedAt: now,
      });
    }

    // SSE 推给买家
    try {
      eventBus.emit('design_delivery', 'user', order.buyerId, {
        orderId: String(order.id),
        revision,
        summary: delivery.summary,
        files: delivery.files.map((f: any) => ({
          designFileId: f.designFileId,
          filename: f.filename,
          format: f.format,
        })),
      });
    } catch {
      /* eventBus 未就绪时忽略 */
    }

    ok(res, delivery);
  },
);

// POST /designer/orders/:id/finalize — 设计师标记定稿
router.post(
  '/designer/orders/:id/finalize',
  requireAuth,
  async (req: AuthedRequest, res: any, next: any) => {
    const userId = req.userId!;
    const orderId = Number(req.params.id);
    const { orderRepo } = await getRepos();
    const order = await orderRepo.findOne({ where: { id: orderId } });
    if (!order) return fail(res, 404, '设计订单不存在', 404);
    if (Number(order.designerId) !== userId)
      return fail(res, 403, '非本订单设计师', 403);
    (req as any).order = order;
    next();
  },
  async (req: AuthedRequest, res) => {
    const order: any = (req as any).order!;
    const { deliveryRepo, orderRepo, settleRepo } = await getRepos();
    const deliveryId = Number(req.body.deliveryId);
    if (!deliveryId) return badRequest(res, 'deliveryId 必填');

    const delivery = await deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery || Number(delivery.orderId) !== Number(order.id)) {
      return badRequest(res, '交付物不属于本订单');
    }
    // finalize 允许标记"买家验收过的某一版"或"刚提交待验收的某一版"
    if (!['uploaded', 'accepted'].includes(delivery.status))
      return badRequest(res, '该版本已被退回或无效');
    if ((delivery.files?.length || 0) === 0)
      return badRequest(res, '交付物为空');

    const now = new Date();
    delivery.isFinal = 1;
    await deliveryRepo.save(delivery);

    order.finalDeliveryId = Number(delivery.id);
    order.status = 'completed';
    order.completedAt = now;
    order.updatedAt = now;
    await orderRepo.update(order.id, {
      finalDeliveryId: Number(delivery.id),
      status: 'completed',
      completedAt: now,
      updatedAt: now,
    });

    // 设计订单 finalize → 自动生成冻结 7 天的结算单（走 buildSettle + settle 资金审计链）
    try {
      const { buildSettle, settle } = await import('../services/settle');
      const settleOrder = buildSettle(
        String(order.id),
        'design',
        Number(order.designerId),
        'designer',
        Number(order.price),
      );
      await settle(settleOrder);
      log(
        `[DesignOrder] settle auto-generated settleNo=${settleOrder.settleNo} orderId=${order.id}`,
      );
    } catch (e: any) {
      log(`[DesignOrder] settle generate failed: ${e.message}`, 'warn');
      // 结算单创建失败不影响 finalize 主流程
    }

    // SSE 推给双方
    try {
      eventBus.emit('design_completed', 'user', order.buyerId, {
        orderId: String(order.id),
        finalDeliveryId: String(delivery.id),
        files: delivery.files,
      });
    } catch {}

    ok(res, {
      orderId: String(order.id),
      finalDeliveryId: String(delivery.id),
      status: order.status,
      completedAt: order.completedAt,
    });
  },
);

// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —
// 🧑‍💼 买家端：验收 / 退回 / finalize→DesignFile 桥接
// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —

// POST /demand/:id/acceptance — 买家验收通过
router.post(
  '/demand/:id/acceptance',
  requireAuth,
  requireBuyerOfDemand,
  async (req: AuthedRequest, res) => {
    const demand: any = (req as any).demand!;
    const order: any = (req as any).order;
    if (!order) return badRequest(res, '设计订单不存在或还没创建');
    const { deliveryRepo, orderRepo, designerProfileRepo } = await getRepos();
    const deliveryId = Number(req.body.deliveryId);
    if (!deliveryId) return badRequest(res, 'deliveryId 必填');

    const delivery = await deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) return fail(res, 404, '交付物不存在', 404);
    if (Number(delivery.orderId) !== Number(order.id))
      return badRequest(res, '交付物不属于本订单');
    if (delivery.status !== 'uploaded')
      return badRequest(res, '该版本已被处理');

    const now = new Date();
    delivery.status = 'accepted';
    delivery.reviewedAt = now;
    await deliveryRepo.save(delivery);

    const rated = Number(req.body.rated) || 5;
    await orderRepo.update(order.id, {
      status: 'reviewed',
      updatedAt: now,
    });

    // 更新设计师 profile.rating + completedOrders
    try {
      const dp = await designerProfileRepo.findOne({
        where: { userId: Number(order.designerId) },
      });
      if (dp) {
        dp.completedOrders = (dp.completedOrders || 0) + 1;
        dp.rating = rated;
        dp.ratingCount = (dp.ratingCount || 0) + 1;
        await designerProfileRepo.save(dp);
      }
    } catch (e: any) {
      log(`[DesignOrder] update designer profile failed: ${e.message}`, 'warn');
    }

    // SSE 推给设计师
    try {
      eventBus.emit('acceptance_confirmed', 'designer', order.designerId, {
        orderId: String(order.id),
        rated: req.body.rated,
        comment: req.body.comment || '',
      });
    } catch {}

    ok(res, { accepted: true, orderStatus: 'reviewed' });
  },
);

// POST /demand/:id/revision — 买家退回修改
router.post(
  '/demand/:id/revision',
  requireAuth,
  requireBuyerOfDemand,
  async (req: AuthedRequest, res) => {
    const demand: any = (req as any).demand!;
    const order: any = (req as any).order;
    if (!order) return badRequest(res, '设计订单不存在或还没创建');
    const { deliveryRepo, orderRepo, revisionRepo } = await getRepos();
    const deliveryId = Number(req.body.deliveryId);
    const issueDesc = (req.body.issueDesc || '').trim();
    if (!deliveryId) return badRequest(res, 'deliveryId 必填');
    if (!issueDesc) return badRequest(res, 'issueDesc 必填');

    const delivery = await deliveryRepo.findOne({ where: { id: deliveryId } });
    if (!delivery) return fail(res, 404, '交付物不存在', 404);
    if (Number(delivery.orderId) !== Number(order.id))
      return badRequest(res, '交付物不属于本订单');
    if (delivery.status !== 'uploaded')
      return badRequest(res, '该版本已被处理');
    if ((order.revisionCount || 0) >= 10)
      return badRequest(res, '修改次数超过 10 次，请联系管理员介入');

    const now = new Date();
    delivery.status = 'rejected';
    await deliveryRepo.save(delivery);

    const newRevisionCount = (order.revisionCount || 0) + 1;
    await orderRepo.update(order.id, {
      status: 'revision_requested',
      revisionCount: newRevisionCount,
      updatedAt: now,
    });

    const revReq = revisionRepo.create({
      orderId: Number(order.id),
      fromDeliveryId: Number(delivery.id),
      issueDesc,
      attachments: req.body.attachments || [],
    });
    await revisionRepo.save(revReq);

    // SSE 推给设计师
    try {
      eventBus.emit('revision_requested', 'designer', order.designerId, {
        orderId: String(order.id),
        revisionRequested: newRevisionCount,
        issueDesc,
      });
    } catch {}

    ok(res, { revisionCount: newRevisionCount, orderStatus: 'revision_requested' });
  },
);

// POST /demand/:id/finalize — 买家一键验收 + 桥接 DesignFile（acceptDesignerDelivery 后端版本）
router.post(
  '/demand/:id/finalize',
  requireAuth,
  requireBuyerOfDemand,
  async (req: AuthedRequest, res) => {
    const demand: any = (req as any).demand!;
    const order: any = (req as any).order;
    if (!order) return badRequest(res, '设计订单不存在或还没创建');
    if (order.status !== 'completed') {
      return badRequest(res, '设计订单未定稿，请等待设计师 finalize');
    }
    const { deliveryRepo, designFileRepo } = await getRepos();
    const delivery = await deliveryRepo.findOne({
      where: { id: Number(order.finalDeliveryId) },
    });
    if (!delivery) return fail(res, 404, '定稿交付物不存在', 404);

    // 桥接：把 delivery.files 标记为"设计稿源文件"
    const designFileIds: number[] = [];
    for (const f of delivery.files || []) {
      const df = await designFileRepo.findOne({
        where: { id: Number(f.designFileId) },
      });
      if (df) {
        df.status = 'valid';
        df.updatedAt = new Date();
        await designFileRepo.save(df);
        designFileIds.push(df.id);
      }
    }

    // SSE 推给双方
    try {
      eventBus.emit('design_file_ready', 'user', order.buyerId, {
        designFileIds,
        orderId: String(order.id),
      });
      eventBus.emit('design_file_ready', 'designer', order.designerId, {
        designFileIds,
        orderId: String(order.id),
      });
    } catch {}

    ok(res, {
      success: true,
      designFileIds,
      primaryDesignFileId: designFileIds[0] || null,
    });
  },
);

// GET /demand/:id/revisions — 反馈历史（买卖家都能看）
router.get('/demand/:id/revisions', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const demandId = Number(req.params.id);
  const { demandRepo, orderRepo, revisionRepo } = await getRepos();
  const demand = await demandRepo.findOne({ where: { id: demandId } });
  if (!demand) return fail(res, 404, '设计需求不存在', 404);
  if (Number(demand.userId) !== userId && Number(demand.designerId) !== userId) {
    return fail(res, 403, '无权查看', 403);
  }
  const order = await orderRepo.findOne({ where: { demandId } });
  const revisions = order
    ? (await revisionRepo.find({ where: { orderId: Number(order.id) } })).map(
        (r) => ({
          ...r,
          createdAt:
            r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
        }),
      )
    : [];
  ok(res, { list: revisions });
});

// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —
// 🔗 Gap-1: GET /design-order/detail — C 端设计订单聚合详情（timeline + deliveries + demand）
// 前端 cart-order.ts designOrderService.getDetail() 调用
// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —

function fmtTime(d: any): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fmtFileSize(bytes: any): string {
  const n = Number(bytes);
  if (!n || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

router.get('/design-order/detail', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const orderIdStr = req.query.id as string | undefined;
  if (!orderIdStr) return badRequest(res, 'id 必填');
  const orderId = Number(orderIdStr);
  if (!orderId) return badRequest(res, '非法的订单 ID');

  const { orderRepo, deliveryRepo, revisionRepo, demandRepo, designerProfileRepo } = await getRepos();
  const order = await orderRepo.findOne({ where: { id: orderId } });
  if (!order) return fail(res, 404, '设计订单不存在', 404);
  if (Number(order.buyerId) !== userId && Number(order.designerId) !== userId) {
    return fail(res, 403, '无权查看', 403);
  }

  // 聚合关联数据
  const demand = await demandRepo.findOne({ where: { id: Number(order.demandId) } });
  const deliveries = await deliveryRepo.find({
    where: { orderId: Number(order.id) },
    order: { revision: 'ASC' },
  });
  const revisions = await revisionRepo.find({
    where: { orderId: Number(order.id) },
    order: { createdAt: 'ASC' },
  });
  const designerProfile = await designerProfileRepo.findOne({ where: { userId: Number(order.designerId) } });

  // — 构建 timeline 节点 —
  // 阶段: 需求确认 → 设计中/修改中 → 初稿交付 → 验收/退回 → finalize 完成
  const phases: Array<{ title: string; icon: string; time: string; status: string }> = [];

  // 1. 需求确认（acceptedAt）
  phases.push({
    title: '需求已确认',
    icon: 'check',
    time: fmtTime(order.acceptedAt),
    status: 'done',
  });

  // 2. 设计中（accepted → designing 状态转换时间——用 updatedAt 近似）
  if (['designing', 'revision_requested', 'reviewed', 'completed'].includes(order.status)) {
    const designerStart = deliveries[0]?.createdAt || order.updatedAt;
    phases.push({
      title: order.status === 'revision_requested' ? '修改中' : '设计中',
      icon: 'pen-tool',
      time: fmtTime(designerStart),
      status: order.status === 'designing' ? 'current' : 'done',
    });
  }

  // 3. 初稿交付（第一个 delivery）
  if (deliveries.length > 0) {
    const first = deliveries[0];
    const revisionCount = revisions.length;
    phases.push({
      title: revisionCount > 0 ? `第 1 版初稿交付` : '初稿交付',
      icon: 'file-text',
      time: fmtTime(first.createdAt),
      status: first.status === 'uploaded' ? 'currentOrange' : 'done',
    });

    // 中间每版退回/修改循环（只展示最后 2 次，避免 timeline 过长）
    const showMaxRevisions = 2;
    const recentDeliveries = deliveries.slice(1).slice(-showMaxRevisions);
    for (const d of recentDeliveries) {
      phases.push({
        title: `第 ${d.revision} 版修改交付`,
        icon: 'refresh-cw',
        time: fmtTime(d.createdAt),
        status: d.status === 'uploaded' ? 'currentOrange' : 'done',
      });
    }
  }

  // 4. 验收（reviewed）
  if (['reviewed', 'completed'].includes(order.status)) {
    const reviewedDelivery = deliveries.find((d) => d.status === 'accepted');
    phases.push({
      title: '验收通过',
      icon: 'check-circle',
      time: fmtTime(reviewedDelivery?.reviewedAt || order.updatedAt),
      status: order.status === 'reviewed' ? 'currentPurple' : 'done',
    });
  }

  // 5. finalize 完成（completed）
  if (order.status === 'completed') {
    phases.push({
      title: '设计完成',
      icon: 'check-circle-2',
      time: fmtTime(order.completedAt || order.updatedAt),
      status: 'done',
    });
  } else if (order.status === 'cancelled') {
    phases.push({
      title: '订单已取消',
      icon: 'x-circle',
      time: fmtTime(order.updatedAt),
      status: 'done',
    });
  } else if (order.status === 'disputed') {
    phases.push({
      title: '纠纷处理中',
      icon: 'alert-triangle',
      time: fmtTime(order.updatedAt),
      status: 'currentOrange',
    });
  }

  // 兜底：pending 状态（还没有 delivery）
  if (deliveries.length === 0 && order.status === 'accepted') {
    phases.push({
      title: '等待设计师开始',
      icon: 'clock',
      time: '',
      status: 'pending',
    });
  }

  // — 构建 files（最新交付物的文件列表）—
  let files: any[] = [];
  const latestDelivery = deliveries.length > 0 ? deliveries[deliveries.length - 1] : null;
  if (latestDelivery?.files) {
    files = latestDelivery.files.map((f: any) => {
      const fn = f.filename || f.name || '';
      const ext = fn.split('.').pop()?.toLowerCase() || '';
      let cls = 'filePsd';
      let icon = 'file-image';
      if (['pdf'].includes(ext)) { cls = 'filePdf'; icon = 'file-text'; }
      else if (['ai', 'eps'].includes(ext)) { cls = 'fileAi'; icon = 'file-image'; }
      else if (['zip', 'rar', '7z'].includes(ext)) { cls = 'fileZip'; icon = 'archive'; }
      else if (['psd', 'psb'].includes(ext)) { cls = 'filePsd'; icon = 'file-image'; }
      return {
        name: fn || '未命名文件',
        size: fmtFileSize(f.fileSize),
        cls,
        icon,
        designFileId: f.designFileId,
        url: f.url,
      };
    });
  }

  ok(res, {
    orderId: String(order.id),
    orderNo: order.orderNo,
    status: order.status,
    timeline: phases,
    files,
    demand: demand
      ? {
          id: String(demand.id),
          productName: demand.productName,
          demandText: demand.demandText,
          budget: demand.budget,
          deliveryTime: demand.deliveryTime,
        }
      : null,
    designer: designerProfile
      ? {
          userId: designerProfile.userId,
          realName: designerProfile.realName,
          rating: designerProfile.rating,
          completedOrders: designerProfile.completedOrders,
        }
      : null,
    revisionCount: order.revisionCount,
    price: Number(order.price),
  });
});

export default router;
