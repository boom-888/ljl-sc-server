// ============================================================================
// ⭐ Review + Refund Routes — Sprint 8 Entity + 双路径
// POST /review/submit          用户提交评价（商品/服务/安装/设计/商家）
// GET  /review/:targetType/:targetId  评价列表
// POST /refund/apply           用户发起退款申请（含订单归属校验）
// GET  /refund/list            我的退款列表
// GET  /refund/:id             退款详情（含归属校验）
// ============================================================================
import { Router, type Response } from 'express';
import { getStore, isTypeORMReady, nextId } from '../db';
import { getDataSource } from '../db-manager';
import { ReviewEntity, RefundEntity } from '../entities/sprint8';
import { requireAuth, ok, fail, badRequest, log, AuthedRequest } from '../middleware/auth';

const router = Router();

// ============================================================================
// ① POST /review/submit — 用户提交评价
// ============================================================================
router.post('/review/submit', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const {
    targetType, // 'product' | 'service' | 'installer' | 'designer' | 'vendor'
    targetId, // 目标实体 id
    orderId, // 关联订单 id（可选但推荐）
    rating, // 1-5
    content, // 评价内容
    images, // 评价图片 url[]
  } = req.body || {};

  if (!['product', 'service', 'installer', 'designer', 'vendor'].includes(targetType)) {
    return badRequest(res, '非法 targetType，允许: product/service/installer/designer/vendor');
  }
  const ratingNum = Number(rating);
  if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return badRequest(res, 'rating 必须为 1-5 的整数');
  }
  if (!content || content.trim().length < 2) {
    return badRequest(res, '评价内容至少 2 个字符');
  }
  if (content.length > 500) {
    return badRequest(res, '评价内容最多 500 字符');
  }

  if (!isTypeORMReady()) {
    const store = getStore();
    const review = {
      id: nextId('reviews'),
      userId,
      targetType,
      targetId: Number(targetId),
      orderId: orderId ? Number(orderId) : null,
      rating: ratingNum,
      content: content.trim(),
      images: Array.isArray(images) ? images : [],
      status: 'published',
      helpful: 0,
      createdAt: new Date().toISOString(),
    };
    store.reviews = store.reviews || [];
    store.reviews.push(review);
    log(
      `[Review-mock] submit id=${review.id} target=${targetType}:${targetId} rating=${ratingNum}`,
    );
    ok(res, { id: review.id, status: 'published' });
    return;
  }

  try {
    const ds = getDataSource()!;
    const repo = ds.getRepository(ReviewEntity);
    const entity = repo.create({
      userId,
      targetType,
      targetId: Number(targetId),
      orderId: orderId ? Number(orderId) : null,
      rating: ratingNum,
      content: content.trim(),
      images: Array.isArray(images) ? images : [],
      status: 'published',
      helpful: 0,
    } as any);
    const saved: any = await repo.save(entity);
    log(`[Review] submit id=${saved.id}`);
    ok(res, { id: saved.id, status: 'published' });
  } catch (e: any) {
    // TypeORM fallback → mock save
    const store = getStore();
    const review = {
      id: nextId('reviews'),
      userId,
      targetType,
      targetId: Number(targetId),
      orderId: orderId ? Number(orderId) : null,
      rating: ratingNum,
      content: content.trim(),
      images: Array.isArray(images) ? images : [],
      status: 'published',
      helpful: 0,
      createdAt: new Date().toISOString(),
    };
    store.reviews = store.reviews || [];
    store.reviews.push(review);
    log(`[Review-fallback] submit id=${review.id}`);
    ok(res, { id: review.id, status: 'published' });
  }
});

// ============================================================================
// ② GET /review/:targetType/:targetId — 评价列表
// ============================================================================
router.get(
  '/review/:targetType/:targetId',
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const { targetType, targetId } = req.params;
    const tid = Number(targetId);
    if (!isTypeORMReady()) {
      const store = getStore();
      const list = (store.reviews || [])
        .filter(
          (r) => r.targetType === targetType && r.targetId === tid && r.status === 'published',
        )
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 50);
      return res.json({ code: 0, data: list });
    }
    try {
      const ds = getDataSource()!;
      const repo = ds.getRepository(ReviewEntity);
      const list = await repo.find({
        where: { targetType, targetId: tid, status: 'published' },
        order: { createdAt: 'DESC' },
        take: 50,
      });
      res.json({ code: 0, data: list });
    } catch {
      const store = getStore();
      const list = (store.reviews || [])
        .filter((r) => r.targetType === targetType && r.targetId === tid)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 50);
      res.json({ code: 0, data: list });
    }
  },
);

// ============================================================================
// ③ POST /refund/apply — 用户发起退款申请
// ============================================================================
router.post('/refund/apply', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { orderId, reason, reasonType, amount, description, images } = req.body || {};

  if (!orderId) {
    return badRequest(res, 'orderId 必填');
  }
  const orderIdNum = Number(orderId);
  if (!reason || reason.trim().length < 2) {
    return badRequest(res, '退款原因至少 2 个字符');
  }

  const amtNum = amount ? Number(amount) : null;

  if (!isTypeORMReady()) {
    const store = getStore();
    // 找到订单 + 校验归属
    const order = store.orders?.find(
      (o: any) => Number(o.id) === orderIdNum && Number(o.userId) === userId,
    );
    if (!order) {
      return fail(res, 404, '订单不存在或无权限', 404);
    }

    const refund = {
      id: nextId('refunds'),
      userId,
      orderId: orderIdNum,
      orderNo: order.orderNo || `ORD${orderIdNum}`,
      reasonType: reasonType || 'other',
      reason: reason.trim(),
      amount: amtNum ?? Number(order.totalAmount || 0),
      description: (description || '').trim(),
      images: Array.isArray(images) ? images : [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.refunds = store.refunds || [];
    store.refunds.push(refund);
    log(`[Refund-mock] apply id=${refund.id} order=${refund.orderNo} amount=${refund.amount}`);
    ok(res, { id: refund.id, status: 'pending' });
    return;
  }

  try {
    const ds = getDataSource();
    // ✅ 修 BUG：之前这里查 store.orders（内存 seed），生产 TypeORM ready 时新订单存 MySQL 里
    const { OrderEntity } = await import('../entities/sprint2');
    const order = await ds.getRepository(OrderEntity).findOne({
      where: { id: orderIdNum, userId },
    });
    if (!order) {
      return fail(res, 404, '订单不存在或无权限', 404);
    }

    const repo = getDataSource()!.getRepository(RefundEntity);
    const entity = repo.create({
      userId,
      orderId: orderIdNum,
      orderNo: order.orderNo || `ORD${orderIdNum}`,
      reasonType: reasonType || 'other',
      reason: reason.trim(),
      amount: amtNum ?? Number(order.totalAmount || 0),
      description: (description || '').trim() || null,
      images: Array.isArray(images) ? images : [],
      status: 'pending',
    });
    const saved = await repo.save(entity);
    log(`[Refund] apply id=${saved.id} order=${saved.orderNo}`);

    // 🛠️ Week 11：refund apply 时如果有 frozen settle → 自动挂纠纷 Dispute
    try {
      const dsNow = getDataSource();
      if (dsNow?.isInitialized) {
        const { SettleOrderEntity, DisputeEntity } = await import('../entities');
        const settleRepo = dsNow.getRepository(SettleOrderEntity);
        const disputeRepo = dsNow.getRepository(DisputeEntity);
        const settle = await settleRepo.findOne({
          where: { orderId: String(orderIdNum), orderType: 'goods', status: 'frozen' },
        });
        if (settle) {
          // 同订单未处理纠纷去重
          const dup = await disputeRepo
            .createQueryBuilder('d')
            .where('d.settleOrderId = :sid', { sid: String(settle.id) })
            .andWhere("d.status != 'resolved'")
            .getOne();
          if (!dup) {
            const d = disputeRepo.create({
              orderId: String(orderIdNum), orderType: 'goods',
              settleOrderId: String(settle.id),
              userId, providerId: Number(settle.providerId), providerRole: settle.providerRole,
              reasonType: 'refund_apply', reason: reason.trim(),
              description: description || `退款申请自动挂起纠纷 refund#${saved.id}`,
              claimAmount: amtNum ?? Number(order.totalAmount || 0),
              status: 'pending',
            });
            await disputeRepo.save(d);
            // 双写镜像
            await settleRepo.update(
              { id: settle.id },
              { dispute_status: 'pending', dispute_remark: `退款申请自动挂起 refund#${saved.id}` } as any,
            );
            log(`[Refund→Dispute] auto dispute#${d.id} linked to settle#${settle.id}`);
          }
        }
      }
    } catch (e: any) {
      log(`[Refund→Dispute] skip: ${e?.message || e}`, 'warn');
    }

    ok(res, { id: saved.id, status: saved.status });
  } catch (e: any) {
    // TypeORM fallback → mock save
    // 订单归属已在 try 块里用 TypeORM 查过了，try 块失败到这里说明 DB 整体挂了
    // 保险起见这里也改 TypeORM 查，查不到才 fallback
    let order: any = null;
    try {
      const { OrderEntity } = await import('../entities/sprint2');
      order = await (getDataSource()?.getRepository(OrderEntity).findOne({ where: { id: orderIdNum, userId } }));
    } catch { /* DB 真挂了就用 fallback */ }
    if (!order) {
      // 最后保险：内存 store（DB 完全不可用时的兜底）
      const store = getStore();
      order = store.orders?.find((o: any) => Number(o.id) === orderIdNum && Number(o.userId) === userId);
    }
    if (!order) {
      return fail(res, 404, '订单不存在或无权限', 404);
    }

    const refund = {
      id: nextId('refunds'),
      userId,
      orderId: orderIdNum,
      orderNo: order.orderNo || `ORD${orderIdNum}`,
      reasonType: reasonType || 'other',
      reason: reason.trim(),
      amount: amtNum ?? Number(order.totalAmount || 0),
      description: (description || '').trim(),
      images: Array.isArray(images) ? images : [],
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.refunds = store.refunds || [];
    store.refunds.push(refund);
    log(`[Refund-fallback] apply id=${refund.id} order=${refund.orderNo}`);
    ok(res, { id: refund.id, status: 'pending' });
  }
});

// ============================================================================
// ④ GET /refund/list — 我的退款列表
// ============================================================================
router.get('/refund/list', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  if (!isTypeORMReady()) {
    const store = getStore();
    const list = (store.refunds || [])
      .filter((r) => r.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return res.json({ code: 0, data: list });
  }
  try {
    const ds = getDataSource()!;
    const list = await ds.getRepository(RefundEntity).find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
    res.json({ code: 0, data: list });
  } catch {
    const store = getStore();
    const list = (store.refunds || [])
      .filter((r) => r.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ code: 0, data: list });
  }
});

// ============================================================================
// ⑤ GET /refund/:id — 退款详情（含归属校验）
// ============================================================================
router.get('/refund/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!isTypeORMReady()) {
    const store = getStore();
    const r = (store.refunds || []).find((x) => x.id === id && x.userId === userId);
    if (!r) {
      return fail(res, 404, '退款申请不存在', 404);
    }
    return ok(res, r);
  }
  try {
    const ds = getDataSource()!;
    const r = await ds.getRepository(RefundEntity).findOne({
      where: { id, userId },
    });
    if (!r) {
      return fail(res, 404, '退款申请不存在或无权限', 404);
    }
    ok(res, r);
  } catch {
    const store = getStore();
    const r = (store.refunds || []).find((x) => x.id === id && x.userId === userId);
    if (!r) {
      return fail(res, 404, '退款申请不存在', 404);
    }
    ok(res, r);
  }
});

// ============================================================================
// ⑥ GET /reviews/mine — 当前角色收到的评价列表 + 聚合统计
// 前端三个角色（vendor/designer/installer）共用同一路由，靠 role query 参数区分
// requireAuth 后加角色守卫：非 admin 只能查自己同角色的评价
// ============================================================================
router.get('/reviews/mine', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { findUserByIdORM } = await import('../db-orm');

  // — 1. 解析 query 参数 —
  const roleParam = String(req.query.role || '').trim();
  const tab = String(req.query.tab || 'all').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const ALLOWED_ROLES = ['vendor', 'designer', 'installer'];
  const ALLOWED_TABS = ['all', 'good', 'mid', 'bad'];

  if (!ALLOWED_ROLES.includes(roleParam)) {
    return badRequest(res, `role 必须是 vendor/designer/installer 之一`);
  }
  if (!ALLOWED_TABS.includes(tab)) {
    return badRequest(res, `tab 必须是 all/good/mid/bad 之一`);
  }

  // — 2. 角色守卫：查当前用户实际角色 —
  let actualRole: string;
  try {
    const user = await findUserByIdORM(userId);
    if (!user) return fail(res, 401, '账号不可用', 401);
    actualRole = user.role;
  } catch (e: any) {
    log(`[reviews/mine] findUserByIdORM error: ${e?.message || e}`, 'error');
    return serverError(res, '鉴权失败');
  }

  // admin 可看任意角色；其他人只能看自己同角色的评价
  if (actualRole !== 'admin' && actualRole !== roleParam) {
    return fail(res, 403, `你是 ${actualRole}，无权查看 ${roleParam} 的评价`, 403);
  }

  // — 3. 构造查询条件 —
  // ReviewEntity 用 targetType/targetId 多态 FK：
  //   role=vendor   → targetType='vendor',   targetId=userId（别人对我这个 vendor 的评价）
  //   role=designer → targetType='designer', targetId=userId
  //   role=installer→ targetType='installer',targetId=userId
  const targetType = roleParam;
  const targetId = userId;

  let ds = getDataSource();
  const isMock = !ds || !ds.isInitialized;

  // — 4. 执行查询 —
  try {
    let allReviews: any[] = [];

    if (isMock) {
      // mock fallback
      const store = getStore();
      allReviews = (store.reviews || []).filter(
        (r) => r.targetType === targetType && r.targetId === targetId,
      );
    } else {
      const repo = ds!.getRepository(ReviewEntity);
      allReviews = await repo.find({
        where: { targetType, targetId, status: 'published' },
        order: { createdAt: 'DESC' },
      });
    }

    // — 5. 聚合统计 —
    const total = allReviews.length;
    let goodCount = 0;   // 4-5 星
    let midCount = 0;    // 3 星
    let badCount = 0;    // 1-2 星
    let sumRating = 0;

    for (const r of allReviews) {
      const rt = Number(r.rating) || 0;
      sumRating += rt;
      if (rt >= 4) goodCount++;
      else if (rt === 3) midCount++;
      else badCount++;
    }
    const avgRating = total > 0 ? Number((sumRating / total).toFixed(2)) : 0;

    // — 6. tab 过滤 + 分页 —
    let filtered = allReviews;
    if (tab === 'good') filtered = allReviews.filter((r) => Number(r.rating) >= 4);
    else if (tab === 'mid') filtered = allReviews.filter((r) => Number(r.rating) === 3);
    else if (tab === 'bad') filtered = allReviews.filter((r) => Number(r.rating) <= 2);

    const list = filtered.slice((page - 1) * pageSize, page * pageSize);

    log(`[reviews/mine] userId=${userId} role=${roleParam} tab=${tab} total=${total}`);

    ok(res, {
      list: list.map((r) => ({
        id: Number(r.id),
        rating: Number(r.rating),
        content: r.content,
        images: r.images || [],
        helpful: Number(r.helpful) || 0,
        createdAt: r.createdAt,
        // 敏感字段不返回
        targetType: r.targetType,
        targetId: Number(r.targetId),
      })),
      pagination: { page, pageSize, total: filtered.length },
      stats: { total, goodCount, midCount, badCount, avgRating },
    });
  } catch (e: any) {
    log(`[reviews/mine] error: ${e?.message || e}`, 'error');
    serverError(res, '评价列表加载失败');
  }
});

export default router;
