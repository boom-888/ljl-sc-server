// ============================================================================
// 🛠️ Admin Routes — 完整 TypeORM 迁移版
// 前端 services/admin.ts 所有 API 调用全覆盖
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, badRequest, notFound, log, AuthedRequest } from '../middleware/auth';
import { getStore, isTypeORMReady } from '../db';
import {
  findUserByIdORM,
  adminStatsORM,
  adminUsersORM,
  adminOrdersORM,
  adminProductsORM,
  adminBannersORM,
  adminAllCategoriesORM,
  adminAddCategoryORM,
  adminUpdateCategoryORM,
  adminDeleteCategoryORM,
  adminReorderCategoriesORM,
  adminToggleUserStatusORM,
  adminResetPasswordORM,
  adminToggleProductORM,
  adminSaveProductDraftORM,
  adminPublishProductORM,
  adminUpdateProductORM,
  adminDeleteProductORM,
  adminAddBannerORM,
  adminUpdateBannerORM,
  adminToggleBannerORM,
  adminDeleteBannerORM,
} from '../db-orm';
import { OrderEntity, OrderItemEntity, UserEntity, ProductEntity, AuditLogEntity } from '../entities';
import { DesignOrderEntity } from '../entities/sprint7';
import { InstallationOrderEntity } from '../entities/sprint4';

const router = Router();

// ---------- 🪵 审计日志 helper ----------
async function writeAudit(ds: any, userId: number | undefined, action: string, targetType: string, targetId: string, req?: any) {
  if (!ds?.isInitialized) return;
  try {
    const repo = ds.getRepository(AuditLogEntity);
    await repo.save(repo.create({
      userId,
      action,
      targetType,
      targetId: String(targetId),
      ip: req?.ip || req?.headers?.['x-forwarded-for'] as string | undefined,
      userAgent: req?.headers?.['user-agent'] as string | undefined,
    }));
  } catch (e) {
    log(`[audit] write failed: ${(e as any).message}`);
  }
}

// ============ Overview (前端 admin 首页) ============
router.get('/overview', requireAuth, requireAdmin, async (_req, res) => {
  const s = await adminStatsORM();
  ok(res, {
    overview: {
      newOrders: String(s.overview?.todayOrders ?? 0),
      tradeAmount: `¥${s.overview?.todayGMV?.toLocaleString() ?? '0'}`,
      newUsers: String(s.overview?.todayNewUsers ?? 0),
      pendingCount: String(
        (s.pending?.installers ?? 0) +
          (s.pending?.designers ?? 0) +
          (s.pending?.vendors ?? 0) +
          (s.pending?.withdrawals ?? 0),
      ),
    },
    todo: {
      withdrawPending: s.pending?.withdrawals ?? 5,
      auditPending:
        (s.pending?.installers ?? 0) + (s.pending?.designers ?? 0) + (s.pending?.vendors ?? 0) || 7,
    },
  });
});

async function requireAdmin(req: AuthedRequest, res: any, next: any) {
  const user = await findUserByIdORM(req.userId!);
  if (!user || user.role !== 'admin') {
    return fail(res, 403, '需要管理员权限', 403);
  }
  next();
}

function buildAdminTree(flat: any[]) {
  const map = new Map<number, any>();
  flat.forEach((c) => map.set(c.id, { ...c, children: [] }));
  const tree: any[] = [];
  map.forEach((node) => {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId).children.push(node);
    } else {
      tree.push(node);
    }
  });
  const sortTree = (arr: any[]) => {
    arr.sort((a, b) => a.sort - b.sort);
    arr.forEach((n) => sortTree(n.children));
  };
  sortTree(tree);
  return tree.map((n) => ({
    id: String(n.id),
    parentId: n.parentId ? String(n.parentId) : 0,
    name: n.name,
    icon: n.icon || '',
    sort: n.sort,
    status: n.status,
    children: n.children.map((c: any) => ({
      id: String(c.id),
      parentId: String(c.parentId),
      name: c.name,
      icon: c.icon || '',
      sort: c.sort,
      status: c.status,
    })),
  }));
}

// ============ Stats ============
router.get('/stats', requireAuth, requireAdmin, async (_req, res) => {
  const s = await adminStatsORM();
  ok(res, {
    ...s,
    revenueTrend: {
      labels: ['12-01', '12-02', '12-03', '12-04', '12-05', '12-06', '12-07'],
      values: [8600, 12000, 9800, 15600, 18200, 11000, Math.round(s.overview.todayGMV)],
    },
  });
});

// ============ Users ============
router.get('/users', requireAuth, requireAdmin, async (_req, res) => {
  const list = await adminUsersORM();
  ok(res, { list, total: list.length });
});

router.post('/user/:userId/status', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  const status = req.body?.status as 'normal' | 'disabled';
  const r = await adminToggleUserStatusORM(userId, status);
  if (!r) {
    return fail(res, 404, '用户不存在', 404);
  }
  ok(res, { success: true, ...r });
});

router.post('/user/:userId/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  const r = await adminResetPasswordORM(userId);
  if (!r) {
    return fail(res, 404, '用户不存在', 404);
  }
  ok(res, { success: true, ...r });
});

// ============ Orders（三种订单合并 + 筛选）============
router.get('/orders', requireAuth, requireAdmin, async (req, res) => {
  const type = String(req.query.type || 'all'); // all | goods | design | install
  const status = String(req.query.status || '');
  const keyword = String(req.query.keyword || '').trim();
  const dateFrom = String(req.query.dateFrom || ''); // YYYY-MM-DD
  const dateTo = String(req.query.dateTo || '');
  const alertedOnly = String(req.query.alerted || '') === 'true';
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));

  // 告警阈值（小时）
  const ALERT_RULES = {
    goods_paid_stuck: 24,      // 商品已付款超 24h 未发货
    goods_pending_stuck: 12,   // 商品未付款超 12h
    install_no_taker: 48,      // 安装需求 48h 无师傅接单
    install_stalled: 72,       // 安装进行中 72h 无进展
    design_overdue: 168,       // 设计接单 7 天未交付
  };
  const now = Date.now();
  function computeAlert(type: string, rawStatus: string, createdAt: Date | undefined, updatedAt?: Date | undefined): null | { level: 'warn' | 'danger'; reason: string; hours: number } {
    if (!createdAt) return null;
    const age = Math.round((now - createdAt.getTime()) / 3600000);
    const upd = updatedAt ? Math.round((now - updatedAt.getTime()) / 3600000) : age;
    if (type === 'goods') {
      if (rawStatus === 'paid' && age >= ALERT_RULES.goods_paid_stuck) return { level: 'danger', reason: `超 ${ALERT_RULES.goods_paid_stuck}h 未发货`, hours: age };
      if (rawStatus === 'pending' && age >= ALERT_RULES.goods_pending_stuck) return { level: 'warn', reason: `超 ${ALERT_RULES.goods_pending_stuck}h 未付款`, hours: age };
    }
    if (type === 'install') {
      const waitStatuses = ['pending', 'starting', 'accepting', 'accepted'];
      if (waitStatuses.includes(rawStatus) && age >= ALERT_RULES.install_no_taker) return { level: 'danger', reason: `超 ${ALERT_RULES.install_no_taker}h 无师傅接单`, hours: age };
      if (rawStatus === 'in_progress' && upd >= ALERT_RULES.install_stalled) return { level: 'warn', reason: `施工停滞 ${ALERT_RULES.install_stalled}h+`, hours: upd };
    }
    if (type === 'design') {
      const active = ['accepted', 'designing', 'revision_requested', 'reviewed'].includes(rawStatus);
      if (active && age >= ALERT_RULES.design_overdue) return { level: 'warn', reason: `超 ${Math.round(ALERT_RULES.design_overdue/24)} 天未交付`, hours: age };
    }
    return null;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [], total: 0, page, size });
  }

  // 状态映射：三种订单状态值不同，前端统一映射
  const GOODS_STATUS_MAP: Record<string, string> = {
    pending: 'pending', paid: 'paid', shipped: 'shipped', completed: 'completed',
    cancelled: 'cancelled', refunding: 'refunding', refunded: 'refunded',
  };
  const DESIGN_STATUS_MAP: Record<string, string> = {
    accepted: 'progress', designing: 'progress', revision_requested: 'progress',
    reviewed: 'progress', completed: 'completed', cancelled: 'cancelled', disputed: 'cancelled',
  };
  const INSTALL_STATUS_MAP: Record<string, string> = {
    pending: 'pending', started: 'pending',
    in_progress: 'progress', accepting: 'progress', accepted: 'progress',
    completed: 'completed', reviewed: 'completed', settled: 'completed',
    cancelled: 'cancelled', rejected_all: 'cancelled',
  };

  const rows: any[] = [];

  try {
    const userRepo = ds.getRepository(UserEntity);
    const users = await userRepo.find();
    const userMap = new Map(users.map(u => [u.id, u]));

    // 1. 商品订单
    if (type === 'all' || type === 'goods') {
      const orderRepo = ds.getRepository(OrderEntity);
      const itemRepo = ds.getRepository(OrderItemEntity);
      const orders = await orderRepo.find({ order: { id: 'DESC' } });
      const oids = orders.map(o => o.id);
      const items = oids.length ? await itemRepo.find({ where: oids.map(id => ({ orderId: id })) }) : [];
      const itemMap = new Map<number, any[]>();
      items.forEach((i: any) => {
        if (!itemMap.has(i.orderId)) itemMap.set(i.orderId, []);
        itemMap.get(i.orderId)!.push(i);
      });
      orders.forEach((o: any) => {
        const u = userMap.get(o.userId);
        const gStatus = GOODS_STATUS_MAP[o.status] || o.status;
        if (status && status !== 'all' && gStatus !== status && o.status !== status) return;
        if (keyword) {
          const hit = (u?.nickname || '').includes(keyword)
            || (u?.phone || '').includes(keyword)
            || o.orderNo.includes(keyword);
          if (!hit) return;
        }
        // 日期筛选
        if (dateFrom) {
          const t = new Date(dateFrom + 'T00:00:00').getTime();
          if (o.createdAt instanceof Date && o.createdAt.getTime() < t) return;
        }
        if (dateTo) {
          const t = new Date(dateTo + 'T23:59:59').getTime();
          if (o.createdAt instanceof Date && o.createdAt.getTime() > t) return;
        }
        const alert = computeAlert('goods', o.status, o.createdAt, o.updatedAt);
        if (alertedOnly && !alert) return;
        rows.push({
          unionKey: `g_${o.id}`,
          id: String(o.id),
          orderNo: o.orderNo,
          customer: u?.nickname || u?.phone?.slice(-4) || '未知',
          customerPhone: u?.phone || '',
          goods: (itemMap.get(o.id) || []).map((i: any) => `${i.productName}×${i.quantity}`).join(', ') || '商品',
          total: Number(o.totalAmount || 0),
          status: gStatus,
          rawStatus: o.status,
          type: 'goods',
          alert,
          time: o.createdAt instanceof Date ? o.createdAt.toISOString().replace('T', ' ').slice(0, 16) : '',
          createdAt: o.createdAt,
        });
      });
    }

    // 2. 设计订单
    if (type === 'all' || type === 'design') {
      const designRepo = ds.getRepository(DesignOrderEntity);
      const dOrders = await designRepo.find({ order: { id: 'DESC' } });
      dOrders.forEach((o: any) => {
        const u = userMap.get(o.buyerId);
        const dStatus = DESIGN_STATUS_MAP[o.status] || o.status;
        if (status && status !== 'all' && dStatus !== status && o.status !== status) return;
        if (keyword) {
          const hit = (u?.nickname || '').includes(keyword)
            || (u?.phone || '').includes(keyword)
            || o.orderNo.includes(keyword);
          if (!hit) return;
        }
        if (dateFrom) { const t = new Date(dateFrom + 'T00:00:00').getTime(); if (o.createdAt?.getTime() < t) return; }
        if (dateTo)   { const t = new Date(dateTo   + 'T23:59:59').getTime(); if (o.createdAt?.getTime() > t) return; }
        {
          const alert = computeAlert('design', o.status, o.createdAt, o.updatedAt);
          if (alertedOnly && !alert) return;
          rows.push({
            unionKey: `d_${o.id}`,
            id: `d${o.id}`,
            orderNo: o.orderNo,
            customer: u?.nickname || u?.phone?.slice(-4) || '未知',
            customerPhone: u?.phone || '',
            goods: '设计服务',
            total: Number(o.price || 0),
            status: dStatus,
            rawStatus: o.status,
            type: 'design',
            alert,
            time: o.acceptedAt instanceof Date ? o.acceptedAt.toISOString().replace('T', ' ').slice(0, 16) : '',
            createdAt: o.createdAt,
          });
        }
      });
    }

    // 3. 安装订单
    if (type === 'all' || type === 'install') {
      const instRepo = ds.getRepository(InstallationOrderEntity);
      const iOrders = await instRepo.find({ order: { id: 'DESC' } });
      iOrders.forEach((o: any) => {
        const u = userMap.get(o.userId);
        const iStatus = INSTALL_STATUS_MAP[o.status] || o.status;
        if (status && status !== 'all' && iStatus !== status && o.status !== status) return;
        if (keyword) {
          const hit = (u?.nickname || '').includes(keyword)
            || (u?.phone || '').includes(keyword)
            || o.orderNo.includes(keyword);
          if (!hit) return;
        }
        if (dateFrom) { const t = new Date(dateFrom + 'T00:00:00').getTime(); if (o.createdAt?.getTime() < t) return; }
        if (dateTo)   { const t = new Date(dateTo   + 'T23:59:59').getTime(); if (o.createdAt?.getTime() > t) return; }
        {
          const alert = computeAlert('install', o.status, o.createdAt, o.updatedAt);
          if (alertedOnly && !alert) return;
          rows.push({
            unionKey: `i_${o.id}`,
            id: `i${o.id}`,
            orderNo: o.orderNo,
            customer: u?.nickname || u?.phone?.slice(-4) || '未知',
            customerPhone: u?.phone || '',
            goods: '安装服务',
            total: Number(o.finalPrice || 0),
            status: iStatus,
            rawStatus: o.status,
            type: 'install',
            alert,
            time: o.createdAt instanceof Date ? o.createdAt.toISOString().replace('T', ' ').slice(0, 16) : '',
            createdAt: o.createdAt,
          });
        }
      });
    }

    // 按创建时间倒序
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = rows.length;
    const start = (page - 1) * size;
    const paged = rows.slice(start, start + size).map(r => {
      const o = { ...r };
      delete o.unionKey; delete o.createdAt;
      return o;
    });

    ok(res, { list: paged, total, page, size });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// GET /admin/orders/stats — Tab + Segmented 的计数（必须在 /orders/:id 之前注册！）
router.get('/orders/stats', requireAuth, requireAdmin, async (_req, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { typeCounts: [], statusCounts: [] });
  try {
    const typeCounts = { all: 0, goods: 0, design: 0, install: 0 };
    const statusCounts = { pending: 0, paid: 0, shipped: 0, progress: 0, completed: 0, cancelled: 0, refunding: 0, refunded: 0 };
    const orders = await ds.getRepository(OrderEntity).createQueryBuilder().getMany();
    typeCounts.goods = orders.length; typeCounts.all += orders.length;
    orders.forEach((o: any) => {
      const s = (o.status === 'pending' || o.status === 'paid') ? o.status : o.status === 'shipped' ? 'shipped' : o.status === 'completed' ? 'completed' : o.status === 'cancelled' ? 'cancelled' : o.status === 'refunding' ? 'refunding' : o.status === 'refunded' ? 'refunded' : 'progress';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const dOrders = await ds.getRepository(DesignOrderEntity).createQueryBuilder().getMany();
    typeCounts.design = dOrders.length; typeCounts.all += dOrders.length;
    dOrders.forEach((o: any) => {
      const s = o.status === 'completed' ? 'completed' : o.status === 'cancelled' || o.status === 'disputed' ? 'cancelled' : 'progress';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const iOrders = await ds.getRepository(InstallationOrderEntity).createQueryBuilder().getMany();
    typeCounts.install = iOrders.length; typeCounts.all += iOrders.length;
    iOrders.forEach((o: any) => {
      const status = o.status || '';
      const s = status === 'pending' || status === 'started' ? 'pending' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'progress';
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    ok(res, { typeCounts, statusCounts });
  } catch (e: any) { serverError(res, e.message); }
});

// — 订单详情（Admin 视角，含 item + vendor + audit trail）—
router.get('/orders/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '订单 ID 无效');
  // — mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    const o = (store.orders || []).find((x: any) => Number(x.id) === id);
    if (!o) return notFound(res, '订单不存在');
    const items = (store.orderItems || []).filter((i: any) => Number(i.orderId) === id);
    return ok(res, {
      id: String(o.id), orderNo: o.orderNo,
      userId: String(o.userId), vendorId: String(o.vendorId || ''),
      status: o.status, totalAmount: Number(o.totalAmount || 0),
      discount: Number(o.discount || 0), shippingFee: Number(o.shippingFee || 0),
      receiverName: o.receiverName, receiverPhone: o.receiverPhone, receiverAddress: o.receiverAddress,
      payMethod: o.payMethod, remark: o.remark,
      paidAt: o.paidAt, shippedAt: o.shippedAt, completedAt: o.completedAt, cancelledAt: o.cancelledAt,
      shippingCompany: null, shippingNo: null, trackingUrl: null,
      createdAt: o.createdAt, updatedAt: o.updatedAt,
      items: items.map((i: any) => ({
        id: String(i.id), productName: i.productName, productImage: i.productCover || '',
        quantity: i.quantity, price: Number(i.price), subtotal: Number((i.price || 0) * (i.quantity || 0)),
      })),
    });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return res.status(503).json({ code: 503 });
  try {
    const repo = ds.getRepository(OrderEntity);
    let o: any = null;
    try { o = await repo.findOne({ where: { id } }); } catch (e: any) { log(`[orders/:id] findOne 异常: ${e.message}`, 'warn'); o = null; }
    // DB 没数据 → 回内存 mock（dev 场景 seed 只写内存）
    if (!o) {
      const store = getStore();
      const mo = (store.orders || []).find((x: any) => Number(x.id) === id);
      if (!mo) return notFound(res, '订单不存在');
      const mitems = (store.orderItems || []).filter((i: any) => Number(i.orderId) === id);
      return ok(res, {
        id: String(mo.id), orderNo: mo.orderNo,
        userId: String(mo.userId), vendorId: String(mo.vendorId || ''),
        status: mo.status, totalAmount: Number(mo.totalAmount || 0),
        discount: Number(mo.discount || 0), shippingFee: Number(mo.shippingFee || 0),
        receiverName: mo.receiverName, receiverPhone: mo.receiverPhone, receiverAddress: mo.receiverAddress,
        payMethod: mo.payMethod, remark: mo.remark,
        paidAt: mo.paidAt, shippedAt: mo.shippedAt, completedAt: mo.completedAt, cancelledAt: mo.cancelledAt,
        shippingCompany: null, shippingNo: null, trackingUrl: null,
        createdAt: mo.createdAt, updatedAt: mo.updatedAt,
        items: mitems.map((i: any) => ({
          id: String(i.id), productName: i.productName, productImage: i.productCover || '',
          quantity: i.quantity, price: Number(i.price), subtotal: Number((i.price || 0) * (i.quantity || 0)),
        })),
        mock: true,
      });
    }
    let items: any[] = [];
    try {
      const itemRepo = ds.getRepository(OrderItemEntity);
      items = await itemRepo.find({ where: { orderId: id } });
    } catch (e: any) {
      log(`[orders/:id] items 查询失败: ${e.message}`, 'warn');
    }
    ok(res, {
      id: String(o.id), orderNo: o.orderNo,
      userId: String(o.userId), vendorId: String(o.vendorId),
      status: o.status, totalAmount: Number(o.totalAmount),
      discount: Number(o.discount || 0), shippingFee: Number(o.shippingFee || 0),
      receiverName: o.receiverName, receiverPhone: o.receiverPhone, receiverAddress: o.receiverAddress,
      payMethod: o.payMethod, remark: o.remark,
      paidAt: o.paidAt, shippedAt: o.shippedAt, completedAt: o.completedAt, cancelledAt: o.cancelledAt,
      shippingCompany: (o as any).shippingCompany, shippingNo: (o as any).shippingNo, trackingUrl: (o as any).trackingUrl,
      createdAt: o.createdAt, updatedAt: o.updatedAt,
      items: items.map(i => ({
        id: String((i as any).id), productName: (i as any).productName, productImage: (i as any).productCover || (i as any).productImage,
        quantity: (i as any).quantity, price: Number((i as any).price), subtotal: Number(((i as any).price || 0) * ((i as any).quantity || 0)),
      })),
    });
  } catch (e: any) { serverError(res, e.message); }
});

// ---------- 订单状态变更（单条 + 批量）----------
// 前端 id 带前缀 g_/d_/i_，这里解析 type
const STATUS_TRANSITIONS: Record<string, string[]> = {
  goods:   ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'refunding', 'refunded'],
  design:  ['accepted', 'designing', 'revision_requested', 'reviewed', 'completed', 'cancelled', 'disputed'],
  install: ['pending', 'started', 'in_progress', 'accepting', 'accepted', 'completed', 'reviewed', 'settled', 'cancelled', 'rejected_all'],
};
function parseOrderId(id: string | number): { type: 'goods' | 'design' | 'install'; realId: number } | null {
  const s = String(id);
  // 完整前缀格式: goods:102 / design:5 / install:7
  if (s.startsWith('goods:'))  return { type: 'goods',   realId: Number(s.slice(6)) };
  if (s.startsWith('design:')) return { type: 'design',  realId: Number(s.slice(7)) };
  if (s.startsWith('install:')) return { type: 'install', realId: Number(s.slice(8)) };
  // 短前缀: g102 / d5 / i7
  if (s.startsWith('g')) return { type: 'goods',   realId: Number(s.slice(1)) };
  if (s.startsWith('d')) return { type: 'design',  realId: Number(s.slice(1)) };
  if (s.startsWith('i')) return { type: 'install',  realId: Number(s.slice(1)) };
  // 纯数字默认 goods
  if (/^\d+$/.test(s)) return { type: 'goods', realId: Number(s) };
  return null;
}

function updateOneOrder(ds: any, type: string, realId: number, newStatus: string): Promise<{ ok: boolean; msg?: string }> {
  return (async () => {
    try {
    if (!STATUS_TRANSITIONS[type]?.includes(newStatus)) {
      return { ok: false, msg: `非法状态 ${newStatus}，允许: ${STATUS_TRANSITIONS[type]?.join(',')}` };
    }
    let repo: any;
    if (type === 'goods')   repo = ds.getRepository(OrderEntity);
    if (type === 'design')  repo = ds.getRepository(DesignOrderEntity);
    if (type === 'install') repo = ds.getRepository(InstallationOrderEntity);
    const entity = await repo.findOne({ where: { id: realId } });
    if (!entity) return { ok: false, msg: '订单不存在' };
    await repo.update(realId, { status: newStatus });
    log(`[Order-Status] admin set ${type}#${realId} → ${newStatus}`);
    return { ok: true };
    } catch (e: any) {
      log(`[updateOneOrder] FATAL: ${e.message}`, 'error');
      return { ok: false, msg: e?.message || 'DB 更新失败' };
    }
  })();
}

// POST /admin/orders/batch-status — 批量改状态
// body: { ids: [{type, id}] | [string, string...], status: string }
router.post('/orders/batch-status', requireAuth, requireAdmin, async (req, res) => {
  try {
  const { ids, status } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0 || !status) {
    return badRequest(res, '参数错误：需要 ids[] 和 status');
  }

  // — 内存 mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    let okCount = 0, failCount = 0;
    const errors: string[] = [];
    for (const item of ids) {
      const typeId = parseOrderId(item);
      if (!typeId) { failCount++; errors.push(`无法解析: ${JSON.stringify(item)}`); continue; }
      const { type, realId } = typeId;
      const arr = type === 'goods' ? store.orders : type === 'design' ? (store.designOrders || []) : null;
      if (!arr) { failCount++; errors.push(`${type} 类型内存无数据`); continue; }
      const idx = arr.findIndex((o: any) => Number(o.id) === realId);
      if (idx < 0) { failCount++; errors.push(`${type}#${realId} 不存在`); continue; }
      arr[idx].status = status;
      okCount++;
    }
    return ok(res, { okCount, failCount, errors }, `成功 ${okCount} / 失败 ${failCount} (内存 mock)`);
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, 'DB 不可用', 503);

  let okCount = 0, failCount = 0;
  const errors: string[] = [];
  const uid = (req as any).userId;
  for (const item of ids) {
    const typeId = parseOrderId(item);
    if (!typeId) { failCount++; errors.push(`无法解析: ${JSON.stringify(item)}`); continue; }
    const r = await updateOneOrder(ds, typeId.type, Number(typeId.realId), status);
    if (r.ok) {
      okCount++;
      await writeAudit(ds, uid, `order.${typeId.type}.status.update`, typeId.type, String(typeId.realId), req);
    } else {
      failCount++; errors.push(`${typeId.type}#${typeId.realId}: ${r.msg}`);
    }
  }
  ok(res, { okCount, failCount, errors }, `成功 ${okCount} / 失败 ${failCount}`);
  } catch (e: any) {
    log(`[batch-status] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误: ' + (e?.message || String(e)), 500);
  }
});

// POST /admin/orders/:id/status — 单条改状态（id 可带 g_/d_/i_ 前缀）
router.post('/orders/:id/status', requireAuth, requireAdmin, async (req, res) => {
  try {
  const id = String(req.params.id);
  const { status } = req.body || {};
  if (!status) return badRequest(res, '缺少 status');
  const parsed = parseOrderId(id);
  if (!parsed) return badRequest(res, '非法订单 id');

  // — 内存 mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    const { type, realId } = parsed;
    const arr = type === 'goods' ? store.orders : type === 'design' ? (store.designOrders || []) : null;
    if (!arr) return fail(res, 400, `${type} 类型内存无数据`);
    const idx = arr.findIndex((o: any) => Number(o.id) === realId);
    if (idx < 0) return fail(res, 404, `订单不存在`, 404);
    arr[idx].status = status;
    log(`[Admin-mock] order-status ${type}#${realId} → ${status}`);
    return ok(res, { type, id: realId, status });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, 'DB 不可用', 503);
  const r = await updateOneOrder(ds, parsed.type, parsed.realId, status);
  if (!r.ok) return fail(res, 400, r.msg || '更新失败');
  await writeAudit(ds, (req as any).userId, `order.${parsed.type}.status.update`, parsed.type, String(parsed.realId), req);
  ok(res, { type: parsed.type, id: parsed.realId, status });
  } catch (e: any) {
    log(`[orders/:id/status] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误: ' + (e?.message || String(e)), 500);
  }
});

// GET /admin/orders/:id/audit-trail — 订单完整轨迹（审计日志 + 订单原始时间字段合并）
router.get('/orders/:id/audit-trail', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const parsed = parseOrderId(id);
    if (!parsed) return badRequest(res, '非法订单 id');
    // — mock fallback —
    if (!isTypeORMReady()) {
      const store = getStore();
      const order = (store.orders || []).find((o: any) => Number(o.id) === parsed.realId);
      if (!order) return notFound(res, '订单不存在');
      const timeline: any[] = [];
      const pick = (dt: any, label: string) => {
        if (dt) timeline.push({ time: typeof dt === 'string' ? dt : dt.toISOString(), label, source: 'order', user: null });
      };
      pick(order.createdAt, '下单');
      pick(order.paidAt, '已付款');
      pick(order.shippedAt, '已发货');
      pick(order.completedAt, '已完成');
      pick(order.cancelledAt, '已取消');
      return ok(res, {
        type: parsed.type, orderId: parsed.realId,
        currentStatus: order.status, timeline,
      });
    }
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) return fail(res, 503, 'DB 不可用', 503);

    let repo: any;
    if (parsed.type === 'goods')   repo = ds.getRepository(OrderEntity);
    if (parsed.type === 'design')  repo = ds.getRepository(DesignOrderEntity);
    if (parsed.type === 'install') repo = ds.getRepository(InstallationOrderEntity);
    const entity = await repo.findOne({ where: { id: parsed.realId } });
    if (!entity) return fail(res, 404, '订单不存在', 404);

    // 1. 订单原始时间字段 → 轨迹项
    const events: any[] = [];
    const pick = (dt: any, label: string) => {
      if (dt instanceof Date) events.push({ time: dt, label, source: 'order' });
    };
    pick(entity.createdAt, '下单');
    pick(entity.paidAt, '已付款');
    pick(entity.acceptedAt, '已接单');
    pick(entity.shippedAt, '已发货');
    pick(entity.completedAt, '已完成');
    pick(entity.cancelledAt, '已取消');

    // 2. audit_logs 里该订单的全部记录
    const auditRepo = ds.getRepository(AuditLogEntity);
    const audits = await auditRepo
      .createQueryBuilder('a')
      .where('a.targetType = :t AND a.targetId = :tid', { t: parsed.type, tid: String(parsed.realId) })
      .leftJoinAndSelect('a.user', 'u')
      .orderBy('a.createdAt', 'ASC')
      .getMany();
    for (const a of audits) {
      const who = a.user?.nickname || (a.userId ? `user#${a.userId}` : 'system');
      const actionMap: Record<string, string> = {
        'status.update': '管理员修改状态',
        'refund': '发起退款',
        'refund.approve': '退款通过',
        'refund.reject': '退款驳回',
        'note.add': '添加备注',
        'assign': '指派处理人',
      };
      const actionLabel = actionMap[a.action.split('.').slice(-2).join('.')] || a.action;
      events.push({
        time: a.createdAt,
        label: `${actionLabel}（${who}）`,
        source: 'audit',
        action: a.action,
        user: who,
      });
    }

    // 3. 按时间排序
    events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    ok(res, {
      type: parsed.type,
      orderId: parsed.realId,
      currentStatus: entity.status,
      timeline: events.map(e => ({
        time: e.time instanceof Date ? e.time.toISOString().replace('T', ' ').slice(0, 19) : '',
        label: e.label,
        source: e.source,
        user: e.user,
      })),
    });
  } catch (e: any) {
    log(`[orders/:id/audit-trail] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误: ' + (e?.message || String(e)), 500);
  }
});

// ============ Products ============
router.get('/products', requireAuth, requireAdmin, async (_req, res) => {
  const list = await adminProductsORM();
  ok(res, { list, total: list.length });
});

router.post('/product/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status as 'on' | 'off';
  const r = await adminToggleProductORM(id, status);
  if (!r) {
    return fail(res, 404, '商品不存在', 404);
  }
  log(`admin/product/toggle id=${id} status=${status}`);
  ok(res, { success: true, ...r });
});

router.post('/product/save-draft', requireAuth, requireAdmin, async (req, res) => {
  const r = await adminSaveProductDraftORM({
    ...req.body,
    createdBy: (req as AuthedRequest).userId,
  });
  ok(res, { success: true, ...r });
});

router.post('/product/publish', requireAuth, requireAdmin, async (req, res) => {
  const r = await adminPublishProductORM({ ...req.body, createdBy: (req as AuthedRequest).userId });
  log(`admin/product/publish id=${r.id}`);
  ok(res, { success: true, ...r });
});

router.post('/product/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await adminUpdateProductORM(id, req.body || {});
  if (!r) {
    return fail(res, 404, '商品不存在', 404);
  }
  log(`admin/product/update id=${id}`);
  ok(res, { success: true, ...r });
});

router.post('/product/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await adminDeleteProductORM(id);
  if (!r) {
    return fail(res, 404, '商品不存在', 404);
  }
  log(`admin/product/delete id=${id}`);
  ok(res, { success: true });
});

// ============ Categories ============
router.get('/categories', requireAuth, requireAdmin, async (_req, res) => {
  const flat = await adminAllCategoriesORM();
  ok(res, buildAdminTree(flat));
});

router.post('/categories', requireAuth, requireAdmin, async (req, res) => {
  const { parentId, name, icon, sort, status } = req.body || {};
  if (!name || !name.trim()) {
    return badRequest(res, '分类名称必填');
  }
  const pid = parentId ? Number(parentId) : undefined;
  const r = await adminAddCategoryORM({ parentId: pid, name, icon, sort, status });
  ok(res, r);
});

router.put('/categories/reorder', requireAuth, requireAdmin, async (req, res) => {
  const { orders } = req.body || {};
  if (!Array.isArray(orders) || orders.length === 0) {
    return badRequest(res, 'orders 必填');
  }
  const r = await adminReorderCategoriesORM(orders);
  log(`admin/category/reorder updated=${r.updated}`);
  ok(res, { success: true, ...r });
});

router.put('/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await adminUpdateCategoryORM(id, req.body || {});
  if (!r) {
    return fail(res, 404, '分类不存在', 404);
  }
  if ((r as any).error === 'SELF_PARENT') {
    return badRequest(res, '不能将父分类设为自身');
  }
  ok(res, r);
});

router.delete('/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await adminDeleteCategoryORM(id);
  if (!r) {
    return fail(res, 404, '分类不存在', 404);
  }
  if ((r as any).error?.startsWith('HAS_PRODUCTS')) {
    return badRequest(res, `该分类下还有 ${(r as any).error.split(':')[1]} 个商品`);
  }
  log(`admin/category/delete id=${id} deleted=${(r as any).deleted}`);
  ok(res, { success: true, deleted: (r as any).deleted });
});

// ============ Category alias routes ============
router.post('/category/add', requireAuth, requireAdmin, async (req, res) => {
  const { parentId, name, icon, sort, status } = req.body || {};
  if (!name || !name.trim()) {
    return badRequest(res, '分类名称必填');
  }
  const pid = parentId ? Number(parentId) : undefined;
  const r = await adminAddCategoryORM({ parentId: pid, name, icon, sort, status });
  ok(res, { success: true, id: r.id });
});

router.post('/category/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  const r = await adminUpdateCategoryORM(id, {
    status: status === 'enabled' || status === 1 ? 1 : 0,
  });
  if (!r || 'error' in r) {
    return fail(res, 404, '分类不存在', 404);
  }
  ok(res, { success: true, id: r.id, status: r.status });
});

router.post('/category/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await adminDeleteCategoryORM(id);
  if (!r) {
    return fail(res, 404, '分类不存在', 404);
  }
  if ((r as any).error?.startsWith('HAS_PRODUCTS')) {
    return badRequest(res, `该分类下还有 ${(r as any).error.split(':')[1]} 个商品`);
  }
  ok(res, { success: true, deleted: (r as any).deleted });
});

// ============ Banners ============
router.get('/banners', requireAuth, requireAdmin, async (_req, res) => {
  const raw = await adminBannersORM();
  ok(res, {
    list: raw.map((b: any) => ({
      id: String(b.id),
      title: b.title,
      image: b.image,
      linkType: b.linkType,
      link: b.link,
      sort: b.sort,
      status: b.status === 1 ? 'enabled' : 'disabled',
    })),
    total: raw.length,
  });
});

router.post('/banner/add', requireAuth, requireAdmin, async (req, res) => {
  const r = await adminAddBannerORM(req.body || {});
  log(`admin/banner/add id=${r.id}`);
  ok(res, { success: true, ...r });
});

router.post('/banner/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await adminUpdateBannerORM(id, req.body || {});
  if (!r) {
    return fail(res, 404, 'Banner不存在', 404);
  }
  ok(res, { success: true, ...r });
});

router.post('/banner/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body?.status as 'enabled' | 'disabled';
  const r = await adminToggleBannerORM(id, status);
  if (!r) {
    return fail(res, 404, 'Banner不存在', 404);
  }
  ok(res, { success: true, ...r });
});

router.post('/banner/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await adminDeleteBannerORM(id);
  if (!r) {
    return fail(res, 404, 'Banner不存在', 404);
  }
  log(`admin/banner/delete id=${id}`);
  ok(res, { success: true });
});

// ============ Installer Verification（师傅入驻审核）============
import { getDataSource } from '../db-manager';
import { InstallerProfileEntity, InstallerSpecialtyEntity } from '../entities/sprint5';
import { smsGateway } from '../services/sms-gateway';
import { eventBus } from '../services/event-bus';

router.get('/installers/pending', requireAuth, requireAdmin, async (_req, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [] });
  }
  try {
    const list = await ds.getRepository(InstallerProfileEntity).find({
      where: { verified: 0 },
      order: { createdAt: 'DESC' },
    });
    ok(res, { list });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

router.post(
  '/installers/:id/approve',
  requireAuth,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!id) {
      return badRequest(res, '参数错误');
    }
    // — 内存 mock fallback —
    if (!isTypeORMReady()) {
      const store = getStore();
      const u = (store.users || []).find((x: any) => Number(x.id) === id);
      if (!u) return fail(res, 404, '师傅不存在', 404);
    if (u.role !== 'pending_installer' && u.role !== 'consumer' && u.role !== 'user') {
      return fail(res, 400, `该用户角色 ${u.role} 不能审批为安装师傅`, 400);
    }
      u.verified = 1;
      u.verifiedAt = new Date().toISOString();
      u.verifiedBy = req.userId!;
      u.role = 'installer';
      log(`[Admin-mock] installer-approve id=${id}`);
      return ok(res, { success: true });
    }
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return fail(res, 503, 'DB unavailable', 503);
    }
    try {
      const repo = ds.getRepository(InstallerProfileEntity);
      let inst;
      try { inst = await repo.findOne({ where: { id } }); } catch { inst = null; }
      if (!inst) {
        // DB 无记录或查询异常 → 内存 mock fallback（dev 场景）
        const store = getStore();
        const u = (store.users || []).find((x: any) => Number(x.id) === id);
        if (!u) return fail(res, 404, '师傅不存在', 404);
        if (u.role !== 'pending_installer' && u.role !== 'consumer' && u.role !== 'user') {
          return fail(res, 400, `该用户角色 ${u.role} 不能审批为安装师傅`, 400);
        }
        u.verified = 1;
        u.role = 'installer';
        u.verifiedAt = new Date().toISOString();
        log(`[Admin-mock-fallback] installer-approve id=${id}`);
        return ok(res, { success: true, mock: true });
      }
      inst.verified = 1;
      inst.verifiedAt = new Date();
      inst.verifiedBy = req.userId!;
      await repo.save(inst);
      // 同步改 users 表 role（防止 user.role 还停留在 consumer）
      try {
        const { UserEntity } = await import('../entities');
        await ds.getRepository(UserEntity).update({ id: inst.userId }, { role: 'installer' });
      } catch {}
      // SMS 网关调用（可选，dev 环境可能未配置）
      try { await (smsGateway as any)?.sendTemplateSms?.({ phone: inst.phone, templateKey: 'installer_approved', variables: {} }); } catch { /* ignore */ }
      // SSE 实时推
      eventBus.emit('installer_approved', 'installer', inst.userId, { installerId: inst.id });
      ok(res, { success: true });
    } catch (e: any) {
      console.error('[installer-approve] FATAL:', e?.message);
      fail(res, 500, e.message, 500);
    }
  },
);

router.post(
  '/installers/:id/reject',
  requireAuth,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const reason = (req.body?.reason || '').slice(0, 255);
    if (!id) {
      return badRequest(res, '参数错误');
    }
    // — 内存 mock fallback —
    if (!isTypeORMReady()) {
      const store = getStore();
      const u = (store.users || []).find((x: any) => Number(x.id) === id);
      if (!u) return fail(res, 404, '师傅不存在', 404);
      u.verified = 2;
      u.verifyNote = reason;
      u.verifiedAt = new Date().toISOString();
      u.verifiedBy = req.userId!;
      log(`[Admin-mock] installer-reject id=${id} reason="${reason}"`);
      return ok(res, { success: true });
    }
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return fail(res, 503, '服务暂不可用', 503);
    }
    try {
      const repo = ds.getRepository(InstallerProfileEntity);
      const inst = await repo.findOne({ where: { id } });
      if (!inst) {
        return fail(res, 404, '师傅不存在', 404);
      }
      inst.verified = 2;
      inst.verifyNote = reason;
      inst.verifiedAt = new Date();
      inst.verifiedBy = req.userId!;
      await repo.save(inst);
      try { await (smsGateway as any)?.sendTemplateSms?.({ phone: inst.phone, templateKey: 'installer_rejected', variables: { reason: reason || '资料不符合要求' } }); } catch { /* ignore */ }
      eventBus.emit('installer_rejected', 'installer', inst.userId, {
        installerId: inst.id,
        reason,
      });
      ok(res, { success: true });
    } catch (e: any) {
      fail(res, 500, e.message, 500);
    }
  },
);

// ===== Designer 审核（基于 users.role: pending_designer → designer）=====
router.get('/designers/pending', requireAuth, requireAdmin, async (_req, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [] });
  }
  try {
    const { UserEntity } = await import('../entities');
    const list = await ds
      .getRepository(UserEntity)
      .find({ where: { role: 'pending_designer' }, order: { createdAt: 'DESC' } });
    ok(res, { list: list.map((u: any) => ({ ...u, id: String(u.id), type: 'designer' })) });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

router.post(
  '/designers/:id/approve',
  requireAuth,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!id) {
      return badRequest(res, '参数错误');
    }
    // — 内存 mock fallback —
    if (!isTypeORMReady()) {
      const store = getStore();
      const u = (store.users || []).find((x: any) => Number(x.id) === id);
      if (!u) return fail(res, 404, '用户不存在', 404);
      u.role = 'designer';
      log(`[Admin-mock] designer-approve id=${id}`);
      return ok(res, { success: true });
    }
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return fail(res, 503, '服务暂不可用', 503);
    }
    try {
      const { UserEntity } = await import('../entities');
      const repo = ds.getRepository(UserEntity);
      await repo.update(id, { role: 'designer' });
      // SSE 实时推给设计师本人
      eventBus.emit('designer_approved', 'designer', id, { designerId: id });
      ok(res, { success: true });
    } catch (e: any) {
      fail(res, 500, e.message, 500);
    }
  },
);

router.post('/designers/:id/reject', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const reason = (req.body?.reason || '').slice(0, 255);
  if (!id) {
    return badRequest(res, '参数错误');
  }
  // — 内存 mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    const u = (store.users || []).find((x: any) => Number(x.id) === id);
    if (!u) return fail(res, 404, '用户不存在', 404);
    u.role = 'user';
    u.rejectReason = reason || null;
    log(`[Admin-mock] designer-reject id=${id} reason="${reason}"`);
    return ok(res, { success: true });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, '服务暂不可用', 503);
  }
  try {
    const { UserEntity } = await import('../entities');
    const repo = ds.getRepository(UserEntity);
    await repo.update(id, { role: 'user' });
    // SSE 实时推给设计师本人
    eventBus.emit('designer_rejected', 'designer', id, { designerId: id, reason });
    ok(res, { success: true });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// ===== Vendor 审核（基于 users.role: pending_vendor → vendor）=====
router.get('/vendors/pending', requireAuth, requireAdmin, async (_req, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [] });
  }
  try {
    const { UserEntity } = await import('../entities');
    const list = await ds
      .getRepository(UserEntity)
      .find({ where: { role: 'pending_vendor' }, order: { createdAt: 'DESC' } });
    ok(res, { list: list.map((u: any) => ({ ...u, id: String(u.id), type: 'vendor' })) });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// 🔨 新增：单个待审核供应商详情（所有入驻字段）
router.get('/vendors/pending/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '参数错误');
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    const store = getStore();
    const u = (store.users || []).find((x: any) => Number(x.id) === id);
    if (!u) return fail(res, 404, '用户不存在', 404);
    if (u.role !== 'pending_vendor') return fail(res, 400, '该用户不是待审核供应商', 400);
    return ok(res, { detail: { ...u, id: String(u.id), type: 'vendor' } });
  }
  try {
    const { UserEntity } = await import('../entities');
    const target = await ds.getRepository(UserEntity).findOne({ where: { id } });
    if (!target) return fail(res, 404, '用户不存在', 404);
    if (target.role !== 'pending_vendor') return fail(res, 400, '该用户不是待审核供应商', 400);
    ok(res, { detail: { ...target, id: String(target.id), type: 'vendor' } });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

router.post('/vendors/:id/approve', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return badRequest(res, '参数错误');
  }
  const { reviewNote } = req.body as any;
  // — 内存 mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    const u = (store.users || []).find((x: any) => Number(x.id) === id);
    if (!u) return fail(res, 404, '用户不存在', 404);
    if (u.role !== 'pending_vendor' && u.role !== 'consumer' && u.role !== 'user') {
      return fail(res, 400, `该用户角色 ${u.role} 不能审批为供应商`, 400);
    }
    u.role = 'vendor';
    if (reviewNote) u.reviewNote = reviewNote;
    log(`[Admin-mock] vendor-approve id=${id}`);
    return ok(res, { success: true, linkedProducts: 0 });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, '服务暂不可用', 503);
  }
  try {
    const { UserEntity, ProductEntity } = await import('../entities');
    const userRepo = ds.getRepository(UserEntity);
    const target = await userRepo.findOne({ where: { id } });
    if (!target) return fail(res, 404, '用户不存在', 404);
    if (target.role !== 'pending_vendor' && target.role !== 'consumer' && target.role !== 'user') {
      return fail(res, 400, `该用户角色 ${target.role} 不能审批为供应商`, 400);
    }
    // role→vendor；nickname 已是工厂名（注册 pending_vendor 时即设好），同步兜底；reviewNote 可选
    const updatePayload: any = { role: 'vendor' };
    if (!target.nickname && (target as any).factoryName) {
      updatePayload.nickname = (target as any).factoryName;
    }
    if (reviewNote) updatePayload.reviewNote = reviewNote;
    await userRepo.update(id, updatePayload);

    // 🛠️ Sprint 10.4: 自动关联 createdBy=id 且 vendorId IS NULL 的商品
    const pRepo = ds.getRepository(ProductEntity);
    const updateResult = await pRepo
      .createQueryBuilder()
      .update(ProductEntity)
      .set({ vendorId: id })
      .where('createdBy = :userId AND vendorId IS NULL', { userId: id })
      .execute();
    const linkedCount = updateResult.affected || 0;
    log(
      `[Vendor-Approve] user ${id} role→vendor, auto-linked products.vendorId=${id}, count=${linkedCount}`,
    );

    ok(res, { success: true, linkedProducts: linkedCount });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

router.post('/vendors/:id/reject', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return badRequest(res, '参数错误');
  }
  const { reviewNote } = req.body as any;
  if (!reviewNote) return badRequest(res, '请填写拒绝原因');
  const clearFields: any = {
    businessLicenseUrl: null,
    idCardFrontUrl: null,
    idCardBackUrl: null,
    serviceAreas: null,
    serviceLng: null,
    serviceLat: null,
    contactName: null,
    officeAddress: null,
    categories: null,
    factoryPhotos: null,
  };
  // — 内存 mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    const u = (store.users || []).find((x: any) => Number(x.id) === id);
    if (!u) return fail(res, 404, '用户不存在', 404);
    u.role = 'consumer';
    Object.assign(u, clearFields, { reviewNote });
    log(`[Admin-mock] vendor-reject id=${id}`);
    return ok(res, { success: true });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, '服务暂不可用', 503);
  }
  try {
    const { UserEntity } = await import('../entities');
    const repo = ds.getRepository(UserEntity);
    const target = await repo.findOne({ where: { id } });
    if (!target) return fail(res, 404, '用户不存在', 404);
    await repo.update(id, { role: 'consumer', ...clearFields, reviewNote });
    log(`[Vendor-Reject] user ${id} role→consumer, cleared vendor profile fields`);
    ok(res, { success: true });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// ===== 统一审核列表（给 admin-audits 页面）=====
router.get('/audits', requireAuth, requireAdmin, async (req, res) => {
  const tab = (req.query.tab as string) || 'pending';
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [] });
  }
  try {
    const { UserEntity } = await import('../entities');
    const all: any[] = [];

    // installer 审核
    const instRepo = ds.getRepository(InstallerProfileEntity);
    const instWhere: any = {};
    if (tab === 'pending') {
      instWhere.verified = 0;
    } else if (tab === 'approved') {
      instWhere.verified = 1;
    } else if (tab === 'rejected') {
      instWhere.verified = 2;
    }
    const instList = await instRepo.find({
      where: tab === 'all' ? {} : instWhere,
      order: { createdAt: 'DESC' },
    });
    for (const i of instList) {
      all.push({
        id: `installer:${i.id}`,
        type: '安装师认证',
        targetName: i.realName || (i as any).name,
        targetSub: `技能: ${(i.specialties || []).join(', ') || '未填写'}`,
        applicantName: i.realName || '师傅',
        applicantAvatar: '',
        status: i.verified === 1 ? 'approved' : i.verified === 2 ? 'rejected' : 'pending',
        statusText: i.verified === 1 ? '已通过' : i.verified === 2 ? '已驳回' : '待审核',
        submitTime: i.createdAt,
        _rawId: i.id,
        _category: 'installer',
      });
    }

    // designer 审核
    const userRepo = ds.getRepository(UserEntity);
    if (tab === 'pending' || tab === 'all') {
      const pDesigners = await userRepo.find({ where: { role: 'pending_designer' } });
      for (const u of pDesigners) {
        all.push({
          id: `designer:${u.id}`,
          type: '设计师认证',
          targetName: u.nickname || '设计师',
          targetSub: `手机: ${u.phone || '未填写'}`,
          applicantName: u.nickname || '设计师',
          applicantAvatar: '',
          status: 'pending',
          statusText: '待审核',
          submitTime: u.createdAt,
          _rawId: u.id,
          _category: 'designer',
        });
      }
      const pVendors = await userRepo.find({ where: { role: 'pending_vendor' } });
      for (const u of pVendors) {
        all.push({
          id: `vendor:${u.id}`,
          type: '供应商入驻',
          targetName: u.nickname || '供应商',
          targetSub: `手机: ${u.phone || '未填写'}`,
          applicantName: u.nickname || '供应商',
          applicantAvatar: '',
          status: 'pending',
          statusText: '待审核',
          submitTime: u.createdAt,
          _rawId: u.id,
          _category: 'vendor',
        });
      }
    }

    // 时间倒序
    all.sort((a, b) => new Date(b.submitTime).getTime() - new Date(a.submitTime).getTime());
    ok(res, { list: all });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// ===== 统一审核操作（给 admin-audits 页面）=====
router.post('/audits/:target/:id/:action', requireAuth, requireAdmin, async (req, res) => {
  const { target, id, action } = req.params; // target: installer|designer|vendor, action: approve|reject
  const realId = Number(id);
  if (!realId || !['approve', 'reject'].includes(action)) {
    return badRequest(res, '参数错误');
  }
  // 🛠️ Sprint 10.12: target 白名单校验（防 role 注入改 admin）
  const ALLOWED_TARGETS = ['installer', 'designer', 'vendor'];
  if (!ALLOWED_TARGETS.includes(target)) {
    return badRequest(res, `非法 target: ${target}`);
  }
  try {
    // — 内存 mock fallback —
    if (!isTypeORMReady()) {
      const store = getStore();
      const u = (store.users || []).find((x: any) => Number(x.id) === realId);
      if (!u) return fail(res, 404, '目标不存在', 404);
      if (target === 'installer') {
        u.verified = action === 'approve' ? 1 : 2;
        u.verifiedAt = new Date().toISOString();
        u.verifiedBy = (req as any).userId!;
        if (action === 'reject') u.verifyNote = (req.body?.reason || '').slice(0, 255);
        if (action === 'approve' && u.role === 'user') u.role = 'installer';
        return ok(res, { success: true, installerId: realId, verified: u.verified });
      } else {
        if (action === 'approve') {
          const pendingRole = `pending_${target}`;
          if (u.role !== pendingRole && u.role !== 'consumer' && u.role !== 'user') {
            return fail(res, 400, `该用户角色 ${u.role} 不能审批为${target}`, 400);
          }
        }
        const newRole = action === 'approve' ? target : 'consumer';
        u.role = newRole;
        if (action === 'reject') u.rejectReason = (req.body?.reason || '').slice(0, 255) || null;
        log(`[Admin-mock] audits ${target}#${realId} ${action}`);
        return ok(res, { success: true, userId: realId, role: newRole, linkedProducts: 0 });
      }
    }

    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return fail(res, 503, '服务暂不可用', 503);
    }
    if (target === 'installer') {
      const repo = ds.getRepository(InstallerProfileEntity);
      const inst = await repo.findOne({ where: { id: realId } });
      if (!inst) {
        return fail(res, 404, '师傅不存在', 404);
      }
      inst.verified = action === 'approve' ? 1 : 2;
      inst.verifiedAt = new Date();
      inst.verifiedBy = (req as any).userId!;
      if (action === 'reject') {
        inst.verifyNote = (req.body?.reason || '').slice(0, 255);
      }
      await repo.save(inst);
      // 🛠️ Bug fix (注册链路 B): 统一 audits installer 分支 approve 必须同步改 UserEntity.role
      // 单独 /admin/installers/:id/approve 路由有这段（L969），但统一 audits 路由漏了
      try {
        const { UserEntity } = await import('../entities');
        const newRole = action === 'approve' ? 'installer' : 'consumer';
        await ds.getRepository(UserEntity).update({ id: inst.userId }, { role: newRole });
      } catch {}
      // 🛠️ Sprint 10.12: 统一入口补独立端点已有的通知逻辑
      if (action === 'approve') {
        try { await (smsGateway as any)?.sendTemplateSms?.({ phone: inst.phone, templateKey: 'installer_approved', variables: {} }); } catch { /* ignore */ }
        eventBus.emit('installer_approved', 'installer', inst.userId, { installerId: inst.id });
      } else {
        try { await (smsGateway as any)?.sendTemplateSms?.({ phone: inst.phone, templateKey: 'installer_rejected', variables: {} }); } catch { /* ignore */ }
        eventBus.emit('installer_rejected', 'installer', inst.userId, { installerId: inst.id });
      }
      ok(res, { success: true, installerId: realId, verified: inst.verified });
    } else {
      const { UserEntity, ProductEntity } = await import('../entities');
      const repo = ds.getRepository(UserEntity);
      // 🛠️ role 白名单：approve 时用合法角色值，reject 回退 consumer（不是 user）
      const newRole = action === 'approve' ? target : 'consumer'; // target 已过白名单校验，这里只会是 designer|vendor
      const updateData: any = { role: newRole };

      // — 🔨 vendor reject 增强：清空所有入驻字段 + 强制 reviewNote —
      if (target === 'vendor') {
        if (action === 'reject') {
          if (!req.body?.reason) {
            return badRequest(res, '请填写拒绝原因');
          }
          updateData.businessLicenseUrl = null;
          updateData.idCardFrontUrl = null;
          updateData.idCardBackUrl = null;
          updateData.serviceAreas = null;
          updateData.serviceLng = null;
          updateData.serviceLat = null;
          updateData.contactName = null;
          updateData.officeAddress = null;
          updateData.categories = null;
          updateData.factoryPhotos = null;
          updateData.reviewNote = String(req.body.reason).slice(0, 500);
        } else if (action === 'approve' && req.body?.reason) {
          updateData.reviewNote = String(req.body.reason).slice(0, 500);
        }
      }

      await repo.update(realId, updateData);

      // SSE 实时推给当事人（designer/vendor 审核结果）
      if (target === 'designer') {
        const evtType = action === 'approve' ? 'designer_approved' : 'designer_rejected';
        eventBus.emit(evtType, 'designer', realId, { designerId: realId });
      } else if (target === 'vendor') {
        const evtType = action === 'approve' ? 'vendor_approved' : 'vendor_rejected';
        eventBus.emit(evtType, 'vendor', realId, { vendorId: realId });
      }

      // 🛠️ Sprint 10.4 + 10.12: vendor approve 时自动关联 products.vendorId + 返回数量
      let linkedProducts = 0;
      if (target === 'vendor' && action === 'approve') {
        const pRepo = ds.getRepository(ProductEntity);
        const updateResult = await pRepo
          .createQueryBuilder()
          .update(ProductEntity)
          .set({ vendorId: realId })
          .where('createdBy = :userId AND vendorId IS NULL', { userId: realId })
          .execute();
        linkedProducts = updateResult.affected || 0;
        log(`[Vendor-Approve-Unified] user ${realId} auto-linked products count=${linkedProducts}`);
      }
      ok(res, { success: true, userId: realId, role: newRole, linkedProducts });
    }
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// ============================================================================
// ✅ Sprint 8：质保索赔仲裁（Admin 后台）
// ============================================================================

import { WarrantyClaimEntity, InstallationOrderEntity } from '../entities/sprint4';
import { WithdrawRequestEntity } from '../entities/sprint6';
import { WARRANTY_CONFIG } from '../services/settle';

// ===== 质保索赔列表 =====
// GET /admin/warranty-claims?status=pending|arbitrated&page=1&size=20
router.get('/warranty-claims', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const status = (req.query?.status as string) || 'all';
  const page = Math.max(1, Number(req.query?.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query?.size) || 20));

  // — mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    let list = [...(store.installerWarrantyClaims || [])];
    if (!list.length) {
      // 若 store 为空则返回几条演示数据
      list = [
        { id: 1, claimNo: 'WC20261001001', orderId: 1, userId: 1, installerId: 9, reason: '门头字脱落', description: '安装 7 天后亚克力字从墙面脱落', claimAmount: 580, status: 'pending', createdAt: new Date().toISOString() },
        { id: 2, claimNo: 'WC20261001002', orderId: 2, userId: 1, installerId: 9, reason: '灯箱不亮', description: 'LED 灯箱安装后第 3 天不亮', claimAmount: 320, status: 'arbitrated', createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
      ];
    }
    if (status !== 'all') list = list.filter((c: any) => c.status === status);
    const total = list.length;
    list = list.slice((page - 1) * size, page * size);
    return ok(res, { list, total, page, size });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, 'DB not ready', 503);
  }

  try {
    const repo = ds.getRepository(WarrantyClaimEntity);
    const where: any = {};
    if (status !== 'all') {
      where.status = status;
    }

    const [list, total] = await repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    });

    ok(res, { list, total, page, size });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// ===== 质保索赔详情 =====
router.get('/warranty-claims/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return badRequest(res, '参数错误');
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, 'DB not ready', 503);
  }

  try {
    const repo = ds.getRepository(WarrantyClaimEntity);
    const claim = await repo.findOne({ where: { id } });
    if (!claim) {
      return fail(res, 404, '索赔不存在', 404);
    }

    // 附带订单信息
    const order = await ds
      .getRepository(InstallationOrderEntity)
      .findOne({ where: { id: claim.orderId } });
    ok(res, { ...(claim as any), order });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// ===== Admin 仲裁：判师傅责 =====
// POST /admin/warranty-claims/:id/rule — { rule: 'installer'|'user', compensationAmount?: number, resolution?: string }
router.post(
  '/warranty-claims/:id/rule',
  requireAuth,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    const adminUserId = req.userId!;
    const id = Number(req.params.id);
    const { rule, compensationAmount, resolution } = req.body as any;
    console.error('[warranty-rule] body=', JSON.stringify(req.body), 'rule=', rule, 'id=', id);
    if (!id || !['installer', 'user'].includes(rule)) {
      console.error('[warranty-rule] BADREQUEST: !id=', !id, ' includes=', ['installer', 'user'].includes(rule));
      return badRequest(res, '参数错误');
    }
    console.error('[warranty-rule] passed validation, isTypeORMReady=', isTypeORMReady());

    // — 内存 mock fallback —
    if (!isTypeORMReady()) {
      const store = getStore();
      const claims = (store as any).installerWarrantyClaims || [];
      const claim = claims.find((c: any) => Number(c.id) === id);
      if (!claim) return fail(res, 404, '索赔不存在', 404);
      if (claim.status !== 'arbitrated') {
        return fail(res, 400, `状态为 ${claim.status}，不在仲裁中`);
      }
      if (rule === 'installer') {
        const amount = compensationAmount ?? 500;
        claim.status = 'settled';
        claim.compensationAmount = Number(amount.toFixed(2));
        claim.resolution = resolution || `Admin 仲裁：师傅承担责任，赔付 ¥${amount}`;
      } else {
        claim.status = 'resolved';
        claim.resolution = resolution || 'Admin 仲裁：用户责任，不在质保范围';
      }
      claim.handlerId = adminUserId;
      log(`[Admin-mock] warranty-rule claim#${id} rule=${rule}`);
      return ok(res, { success: true, status: claim.status, compensationAmount: claim.compensationAmount || 0 });
    }

    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return fail(res, 503, 'DB not ready', 503);
    }

    try {
      const repo = ds.getRepository(WarrantyClaimEntity);
      let claim;
      try { claim = await repo.findOne({ where: { id, status: 'arbitrated' } }); } catch { claim = null; }

      // DB 无记录或查询异常 → 内存 mock fallback（dev 场景）
      if (!claim) {
        const store = getStore();
        const claims = (store as any).installerWarrantyClaims || [];
        const mc = claims.find((c: any) => Number(c.id) === id);
        if (!mc) return fail(res, 404, '索赔不存在', 404);
        if (rule === 'installer') {
          const amt = compensationAmount ?? 500;
          mc.status = 'settled';
          mc.compensationAmount = Number(amt.toFixed(2));
          mc.resolution = resolution || `Admin 仲裁：师傅承担责任，赔付 ¥${amt}`;
        } else {
          mc.status = 'resolved';
          mc.resolution = resolution || 'Admin 仲裁：用户责任';
        }
        mc.handlerId = adminUserId;
        log(`[Admin-mock-fallback] warranty-rule claim#${id}`);
        return ok(res, { success: true, status: mc.status, mock: true });
      }

      const orderRepo = ds.getRepository(InstallationOrderEntity);
      const order = await orderRepo.findOne({ where: { id: claim.orderId } });
      if (!order) {
        return fail(res, 404, '订单不存在', 404);
      }

      if (rule === 'installer') {
        // 判师傅责 → 从质保金扣赔用户
        const amount = compensationAmount ?? Math.min(order.warrantyHoldAmount || 0, 500);
        claim.status = 'settled';
        claim.compensationAmount = Number(amount.toFixed(2));
        claim.resolution = resolution || `Admin 仲裁：师傅承担责任，赔付 ¥${amount}`;
        claim.handlerId = adminUserId;
        await repo.save(claim);

        // 质保关闭 → 释放剩余质保金（如果赔的比 holdAmount 少）
        const remain = (order.warrantyHoldAmount || 0) - amount;
        order.warrantyStatus = 'settled';
        await orderRepo.save(order);

        // —— 真实资金流 ——
        try {
          const { InstallerProfileEntity, MoneyFlowEntity, UserEntity } = await import('../entities');
          // 1. 用户入账 wallet
          const userRepo = ds.getRepository(UserEntity);
          const user = await userRepo.findOne({ where: { id: claim.userId } });
          if (user) {
            const wallet = Number(user.wallet ?? 0);
            user.wallet = Number((wallet + amount).toFixed(2));
            await userRepo.save(user);
          }

          // 2. 师傅 bond 扣减（若无 bond 则从 earningsAvailable 扣）
          const installerRepo = ds.getRepository(InstallerProfileEntity);
          const installerProfile = await installerRepo.findOne({ where: { userId: claim.installerId } });
          if (installerProfile) {
            const bond = Number(installerProfile.bondAmount ?? 0);
            const avail = Number(installerProfile.earningsAvailable ?? 0);
            if (bond >= amount) {
              installerProfile.bondAmount = Number((bond - amount).toFixed(2));
              if (installerProfile.bondAmount === 0) installerProfile.bondStatus = 'none';
              else installerProfile.bondStatus = 'deducted';
            } else if (avail >= amount) {
              installerProfile.earningsAvailable = Number((avail - amount).toFixed(2));
            }
            await installerRepo.save(installerProfile);
          }

          // 3. 审计流水
          const flowRepo = ds.getRepository(MoneyFlowEntity);
          const flow = flowRepo.create({
            flowNo: 'FL' + Date.now() + Math.floor(Math.random() * 10000).toString().padStart(4, '0'),
            type: 'arbitration',
            refNo: claim.claimNo,
            fromUserId: claim.installerId,
            fromRole: 'installer',
            toUserId: claim.userId,
            toRole: 'consumer',
            amount: Number(amount.toFixed(2)),
            remark: `Admin 仲裁 ${claim.claimNo}: 师傅责赔用户 ¥${amount}`,
          });
          await flowRepo.save(flow);
        } catch (fundErr: any) {
          log(`[Warranty] 仲裁资金流失败: ${fundErr.message}`, 'error');
        }

        log(
          `[Warranty] claim ${claim.claimNo} arbitrated installer-responsible, compensation=¥${amount}, remain hold=¥${remain}`,
          'info',
        );

        // 通知用户 + 师傅
        eventBus.emit('warranty_arbitrated', 'user', claim.userId, {
          claimId: claim.id,
          claimNo: claim.claimNo,
          result: 'installer_responsible',
          compensation: amount,
        });
        eventBus.emit('warranty_arbitrated', 'installer', claim.installerId, {
          claimId: claim.id,
          claimNo: claim.claimNo,
          result: 'installer_responsible',
          compensation: amount,
        });
      } else {
        // 判用户责 → 退回 active（质保继续直到 90 天到期）
        claim.status = 'resolved';
        claim.resolution = resolution || 'Admin 仲裁：用户责任，不在质保范围';
        claim.handlerId = adminUserId;
        await repo.save(claim);

        order.warrantyStatus = 'active';
        await orderRepo.save(order);

        log(`[Warranty] claim ${claim.claimNo} arbitrated user-responsible`, 'info');
      }

      ok(res, {
        success: true,
        status: claim.status,
        compensationAmount: claim.compensationAmount,
      });
    } catch (e: any) {
      fail(res, 500, e.message, 500);
    }
  },
);

// ============================================================================
// ✅ Sprint 10.6：提现审批（Admin 后台）
// ============================================================================

// ===== Admin: Vendor 详情（查某个 vendor 的业务概况）=====
router.get('/vendors/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return badRequest(res, '参数错误');
  }
  // — mock fallback —
  if (!isTypeORMReady()) {
    const store = getStore();
    const user = (store.users || []).find((u: any) => Number(u.id) === id);
    if (!user) return notFound(res, '用户不存在');
    const products = (store.products || []).filter((p: any) => Number(p.vendorId) === id);
    const orders = (store.orders || []).filter((o: any) => Number(o.vendorId) === id);
    const wReqs = (store.withdrawRequests || []).filter((w: any) => Number(w.vendorId) === id);
    return ok(res, {
      id: String(user.id), nickname: user.nickname, phone: user.phone, role: user.role,
      createdAt: user.createdAt,
      products: { total: products.length, active: products.filter((p: any) => p.status === 1).length },
      orders: orders.length,
      withdrawals: {
        pending: wReqs.filter((w: any) => w.status === 'pending').reduce((s: number, w: any) => s + Number(w.amount || 0), 0),
        approved: wReqs.filter((w: any) => w.status === 'approved').reduce((s: number, w: any) => s + Number(w.amount || 0), 0),
        paid: wReqs.filter((w: any) => w.status === 'paid').reduce((s: number, w: any) => s + Number(w.amount || 0), 0),
      },
    });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, '服务暂不可用', 503);
  }
  try {
    const { UserEntity, ProductEntity, WithdrawRequestEntity } = await import('../entities');
    const { OrderEntity } = await import('../entities/sprint2');
    const userRepo = ds.getRepository(UserEntity);
    const pRepo = ds.getRepository(ProductEntity);
    const orderRepo = ds.getRepository(OrderEntity);
    const wRepo = ds.getRepository(WithdrawRequestEntity);

    const user = await userRepo.findOne({ where: { id } });
    if (!user) {
      return fail(res, 404, '用户不存在', 404);
    }

    const productCount = await pRepo.count({ where: { vendorId: id } });
    const activeCount = await pRepo.count({ where: { vendorId: id, status: 1 } });
    const orderCount = await orderRepo.count({ where: { vendorId: id } });
    const pendingWithdraw = await wRepo.sum('amount', { vendorId: id, status: 'pending' });
    const approvedWithdraw = await wRepo.sum('amount', { vendorId: id, status: 'approved' });
    const paidWithdraw = await wRepo.sum('amount', { vendorId: id, status: 'paid' });

    ok(res, {
      id: String(user.id),
      nickname: user.nickname,
      phone: user.phone,
      role: user.role,
      createdAt: user.createdAt,
      products: { total: productCount, active: activeCount },
      orders: orderCount,
      withdrawals: {
        pending: Number(pendingWithdraw || 0),
        approved: Number(approvedWithdraw || 0),
        paid: Number(paidWithdraw || 0),
      },
    });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// GET /admin/withdrawals — 全部提现申请
router.get('/withdrawals', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const { status, page = 1, size = 20 } = req.query as any;
  if (!isTypeORMReady()) {
    const store = getStore();
    const all = (store as any).withdrawRequests || [];
    const filtered = status ? all.filter((w: any) => w.status === status) : all;
    const start = (Number(page) - 1) * Number(size);
    const list = filtered.slice(start, start + Number(size));
    ok(res, {
      total: filtered.length,
      page: Number(page),
      size: Number(size),
      list: list.map((r: any) => ({
        id: String(r.id),
        withdrawNo: r.withdrawNo || `WD${r.id}`,
        vendorId: r.vendorId,
        amount: Number(r.amount || 0),
        fee: Number(r.fee || 0),
        actualAmount: Number(r.actualAmount || r.amount || 0),
        bankName: r.bankName || '—',
        cardNo: r.cardNo || '—',
        status: r.status || 'pending',
        rejectReason: r.remark || null,
        reviewedBy: r.reviewedBy || null,
        createdAt: r.createdAt,
        reviewedAt: r.reviewedAt || null,
        paidAt: r.paidAt || null,
      })),
    });
    return;
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, '服务暂不可用', 503);
  }
  try {
    const repo = ds!.getRepository(WithdrawRequestEntity);
    const where: any = {};
    if (status) {
      where.status = status;
    }
    const [list, total] = await repo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (Number(page) - 1) * Number(size),
      take: Number(size),
    });
    ok(res, {
      total,
      page: Number(page),
      size: Number(size),
      list: list.map((r) => ({
        id: String(r.id),
        withdrawNo: r.withdrawNo,
        vendorId: r.vendorId,
        amount: Number(r.amount),
        fee: Number(r.fee),
        actualAmount: Number(r.actualAmount),
        bankName: r.bankName,
        cardNo: r.cardNo,
        status: r.status,
        rejectReason: r.remark || null,
        reviewedBy: r.reviewedBy || null,
        createdAt: r.createdAt?.toISOString(),
        reviewedAt: r.reviewedAt?.toISOString() || null,
        paidAt: r.paidAt?.toISOString() || null,
      })),
    });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// POST /admin/withdrawals/:id/approve — 审批通过
router.post(
  '/withdrawals/:id/approve',
  requireAuth,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!id) {
      return badRequest(res, '参数错误');
    }
    if (!isTypeORMReady()) {
      const store = getStore();
      const w = ((store as any).withdrawRequests || []).find((x: any) => Number(x.id) === id);
      if (!w) {
        return fail(res, 404, '提现申请不存在', 404);
      }
      if (w.status !== 'pending') {
        return fail(res, 422, `状态为 ${w.status}，无法审批`, 422);
      }
      w.status = 'approved';
      w.reviewedBy = req.userId!;
      w.reviewedAt = new Date().toISOString();
      ok(res, { success: true, id: String(id), status: 'approved' });
      return;
    }
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return fail(res, 503, '服务暂不可用', 503);
    }
    try {
      const repo = ds!.getRepository(WithdrawRequestEntity);
      const w = await repo.findOne({ where: { id } });
      if (!w) {
        return fail(res, 404, '提现申请不存在', 404);
      }
      if (w.status !== 'pending') {
        return fail(res, 422, `状态为 ${w.status}，无法审批`, 422);
      }
      await repo.update(id, {
        status: 'approved',
        reviewedBy: req.userId!,
        reviewedAt: new Date(),
      });
      log(`[Withdraw-Approve] admin ${req.userId!} approved WD#${w.withdrawNo}, ¥${w.amount}`);
      ok(res, { success: true, id: String(id), status: 'approved' });
    } catch (e: any) {
      fail(res, 500, e.message, 500);
    }
  },
);

// POST /admin/withdrawals/:id/reject — 审批拒绝
router.post(
  '/withdrawals/:id/reject',
  requireAuth,
  requireAdmin,
  async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const reason = (req.body?.reason || '').trim();
    if (!id) {
      return badRequest(res, '参数错误');
    }
    if (!isTypeORMReady()) {
      const store = getStore();
      const w = ((store as any).withdrawRequests || []).find((x: any) => Number(x.id) === id);
      if (!w) {
        return fail(res, 404, '提现申请不存在', 404);
      }
      if (w.status !== 'pending') {
        return fail(res, 422, `状态为 ${w.status}，无法审批`, 422);
      }
      w.status = 'rejected';
      w.reviewedBy = req.userId!;
      w.reviewedAt = new Date().toISOString();
      w.rejectReason = reason || '管理员拒绝';
      ok(res, { success: true, id: String(id), status: 'rejected' });
      return;
    }
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return fail(res, 503, '服务暂不可用', 503);
    }
    try {
      const repo = ds!.getRepository(WithdrawRequestEntity);
      const w = await repo.findOne({ where: { id } });
      if (!w) {
        return fail(res, 404, '提现申请不存在', 404);
      }
      if (w.status !== 'pending') {
        return fail(res, 422, `状态为 ${w.status}，无法审批`, 422);
      }
      await repo.update(id, {
        status: 'rejected',
        reviewedBy: req.userId!,
        reviewedAt: new Date(),
        remark: reason || '管理员拒绝',
      });
      log(
        `[Withdraw-Reject] admin ${req.userId!} rejected WD#${w.withdrawNo}, reason="${reason || '管理员拒绝'}"`,
      );
      ok(res, { success: true, id: String(id), status: 'rejected' });
    } catch (e: any) {
      fail(res, 500, e.message, 500);
    }
  },
);

// ============= P2: 设计需求 / 安装订单 / 热词 / 审计日志 =============

// GET /admin/design-demands — 设计需求列表
import { DesignDemandEntity } from '../entities/sprint3';
import { SearchKeywordEntity, AuditLogEntity } from '../entities';

router.get('/design-demands', requireAuth, requireAdmin, async (req, res) => {
  const ds = getDataSource();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const status = (req.query.status as string) || 'all';
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [], total: 0, page, size });
  }
  try {
    const qb = ds.getRepository(DesignDemandEntity).createQueryBuilder('d');
    if (status !== 'all') qb.where('d.status = :status', { status });
    const [list, total] = await qb
      .orderBy('d.id', 'DESC')
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();
    ok(res, { list, total, page, size });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// GET /admin/installation-orders — 安装订单列表
router.get('/installation-orders', requireAuth, requireAdmin, async (req, res) => {
  const ds = getDataSource();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  const status = (req.query.status as string) || 'all';
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [], total: 0, page, size });
  }
  try {
    const qb = ds.getRepository(InstallationOrderEntity).createQueryBuilder('o');
    if (status !== 'all') qb.where('o.status = :status', { status });
    const [list, total] = await qb
      .orderBy('o.id', 'DESC')
      .skip((page - 1) * size)
      .take(size)
      .getManyAndCount();
    ok(res, { list, total, page, size });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// GET /admin/search-keywords — 热词列表
router.get('/search-keywords', requireAuth, requireAdmin, async (_req, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [] });
  }
  try {
    const list = await ds.getRepository(SearchKeywordEntity).find({
      order: { sort: 'ASC', id: 'DESC' },
    });
    ok(res, { list });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// GET /admin/audit-logs — 审计日志
router.get('/audit-logs', requireAuth, requireAdmin, async (req, res) => {
  const ds = getDataSource();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));
  if (!ds || !ds.isInitialized) {
    return ok(res, { list: [], total: 0, page, size });
  }
  try {
    const [list, total] = await ds.getRepository(AuditLogEntity).findAndCount({
      order: { id: 'DESC' },
      skip: (page - 1) * size,
      take: size,
    });
    ok(res, { list, total, page, size });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

// GET /admin/product/:id/specs — 商品规格（兼容前端，products 表暂无 specs 字段）
router.get('/product/:id/specs', requireAuth, requireAdmin, async (req, res) => {
  ok(res, { groups: [] });
});

// PUT /admin/product/:id/specs — 更新商品规格（同上）
router.put('/product/:id/specs', requireAuth, requireAdmin, async (req, res) => {
  ok(res, { success: true });
});

// POST /admin/withdrawals/:id/paid — 标记已打款
router.post('/withdrawals/:id/paid', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return badRequest(res, '参数错误');
  }
  if (!isTypeORMReady()) {
    const store = getStore();
    const w = ((store as any).withdrawRequests || []).find((x: any) => Number(x.id) === id);
    if (!w) {
      return fail(res, 404, '提现申请不存在', 404);
    }
    if (w.status !== 'approved') {
      return fail(res, 422, `状态为 ${w.status}，无法标记已打款`, 422);
    }
    w.status = 'paid';
    w.paidAt = new Date().toISOString();
    ok(res, { success: true, id: String(id), status: 'paid' });
    return;
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return fail(res, 503, '服务暂不可用', 503);
  }
  try {
    const repo = ds!.getRepository(WithdrawRequestEntity);
    const w = await repo.findOne({ where: { id } });
    if (!w) {
      return fail(res, 404, '提现申请不存在', 404);
    }
    if (w.status !== 'approved') {
      return fail(res, 422, `状态为 ${w.status}，无法标记已打款`, 422);
    }
    await repo.update(id, { status: 'paid', paidAt: new Date() });
    log(`[Withdraw-Paid] admin ${req.userId!} marked WD#${w.withdrawNo} as paid`);
    ok(res, { success: true, id: String(id), status: 'paid' });
  } catch (e: any) {
    fail(res, 500, e.message, 500);
  }
});

export default router;
