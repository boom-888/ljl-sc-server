// ============================================================================
// 📦 Sprint 10 / Week 3 Admin Finance Routes — 财务看板 + 冻结池 + 佣金 + 纠纷
// 对应完整方案 10.4 节
// ============================================================================
import { Router } from 'express';
import { requireAuth, requireAdmin, ok, fail, badRequest, notFound, log, AuthedRequest } from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { isTypeORMReady } from '../db';

const router = Router();

// — 动态 import Entity（避免顶层循环依赖）—
async function getEntities() {
  const m = await import('../entities');
  return {
    SettleOrderEntity: m.SettleOrderEntity,
    WithdrawRequestEntity: m.WithdrawRequestEntity,
    DisputeEntity: m.DisputeEntity,
    OrderEntity: (m as any).OrderEntity,
  };
}

// — 辅助：安全的 SUM 结果转 number —
function toNum(v: any): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return isNaN(n) ? 0 : n;
}

// ========================================================
// 🪵 内存 mock（TypeORM 未就绪时 fallback）—
// ========================================================
let mockDisputes: any[] = [
  {
    id: 1, orderId: 'g1001', orderType: 'goods', settleOrderId: 'SO001',
    userId: 11, providerId: 1, providerRole: 'vendor',
    reasonType: 'quality', reason: '印刷颜色偏差严重', description: '客户提供的样张与成品颜色差异超过 30%',
    claimAmount: 320, status: 'pending', reviewedBy: null, action: null,
    refundAmount: 0, reviewRemark: null,
    createdAt: new Date(Date.now() - 86400000).toISOString(), updatedAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 2, orderId: 'd5', orderType: 'design', settleOrderId: null,
    userId: 12, providerId: 3, providerRole: 'designer',
    reasonType: 'delay', reason: '设计稿超期未交付', description: '约定 3 天出稿，已等待 7 天',
    claimAmount: 0, status: 'pending', reviewedBy: null, action: null,
    refundAmount: 0, reviewRemark: null,
    createdAt: new Date(Date.now() - 172800000).toISOString(), updatedAt: new Date(Date.now() - 7200000).toISOString(),
  },
  {
    id: 3, orderId: 'i7', orderType: 'install', settleOrderId: 'SO005',
    userId: 13, providerId: 5, providerRole: 'installer',
    reasonType: 'damage', reason: '安装过程中损坏门头字', description: '师傅用电钻打穿了亚克力板背面',
    claimAmount: 580, status: 'resolved', reviewedBy: 1, action: 'partial_refund',
    refundAmount: 300, reviewRemark: '双方各担一半责任',
    createdAt: new Date(Date.now() - 604800000).toISOString(), updatedAt: new Date(Date.now() - 86400000).toISOString(),
  },
];
let mockDisputeNextId = 4;

let mockSettleFrozen: any[] = [
  { id: 1, settleNo: 'SO20240101001', providerId: 1, providerRole: 'vendor', orderType: 'goods', totalAmount: 1200, providerGet: 1080, commission: 120, commissionRate: 0.1, status: 'frozen', freezeUntil: new Date(Date.now() + 3 * 86400000).toISOString(), createdAt: new Date(Date.now() - 3 * 86400000).toISOString() },
  { id: 2, settleNo: 'SO20240101002', providerId: 3, providerRole: 'designer', orderType: 'design', totalAmount: 2500, providerGet: 2125, commission: 375, commissionRate: 0.15, status: 'frozen', freezeUntil: new Date(Date.now() + 10 * 86400000).toISOString(), createdAt: new Date(Date.now() - 4 * 86400000).toISOString() },
];
let mockSettleAvailable: any[] = [
  { id: 3, settleNo: 'SO20240101003', providerId: 5, providerRole: 'installer', orderType: 'install', totalAmount: 800, providerGet: 704, commission: 96, commissionRate: 0.12, status: 'available', createdAt: new Date(Date.now() - 8 * 86400000).toISOString(), settledAt: new Date(Date.now() - 1 * 86400000).toISOString() },
];
let mockSettleWithdrawn: any[] = [
  { id: 4, settleNo: 'SO20240101004', providerId: 1, providerRole: 'vendor', orderType: 'goods', totalAmount: 3000, providerGet: 2700, commission: 300, commissionRate: 0.1, status: 'withdrawn', createdAt: new Date(Date.now() - 30 * 86400000).toISOString(), settledAt: new Date(Date.now() - 20 * 86400000).toISOString() },
];

function allMockSettles() {
  return [...mockSettleFrozen, ...mockSettleAvailable, ...mockSettleWithdrawn];
}

// ========================================================
// 1️⃣ GET /api/admin/finance/overview — 财务看板总览
// ========================================================
router.get('/finance/overview', requireAuth, requireAdmin, async (_req, res) => {
  if (!isTypeORMReady()) {
    const frozen = mockSettleFrozen;
    const available = mockSettleAvailable;
    const withdrawn = mockSettleWithdrawn;
    const commissionMonth = allMockSettles()
      .filter(s => new Date(s.createdAt) >= new Date(new Date().getFullYear(), new Date().getMonth(), 1))
      .reduce((s, o) => s + Number(o.commission || 0), 0);
    const commissionTotal = allMockSettles().reduce((s, o) => s + Number(o.commission || 0), 0);

    return ok(res, {
      todayOrders: 0, todayGMV: 0,
      frozenCount: frozen.length, frozenAmount: frozen.reduce((s, o) => s + Number(o.totalAmount || 0), 0),
      availableCount: available.length, availableAmount: available.reduce((s, o) => s + Number(o.totalAmount || 0), 0),
      withdrawnCount: withdrawn.length, withdrawnAmount: withdrawn.reduce((s, o) => s + Number(o.totalAmount || 0), 0),
      commissionMonth: Number(commissionMonth.toFixed(2)),
      commissionTotal: Number(commissionTotal.toFixed(2)),
      withdrawPending: 2, // admin.ts withdrawals 路由的 mock 已 pending 2 条
      disputePending: mockDisputes.filter(d => d.status !== 'resolved').length,
    });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { SettleOrderEntity, WithdrawRequestEntity, OrderEntity } = await getEntities();
    const soRepo = ds.getRepository(SettleOrderEntity);

    // — 今日订单 & GMV（从 orders 表，已支付/已完成）—
    let todayOrders = 0, todayGMV = 0;
    if (OrderEntity) {
      const orderRepo = ds.getRepository(OrderEntity);
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);
      const orderAgg: any = await orderRepo
        .createQueryBuilder('o')
        .select('COUNT(o.id)', 'cnt')
        .addSelect('COALESCE(SUM(o.totalAmount), 0)', 'gmv')
        .where('o.createdAt >= :s AND o.createdAt < :e', { s: todayStart, e: todayEnd })
        .andWhere("o.status NOT IN ('pending', 'cancelled')")
        .getRawOne();
      todayOrders = Number(orderAgg?.cnt || 0);
      todayGMV = toNum(orderAgg?.gmv);
    }

    // — 冻结池 —
    const frozenAgg: any = await soRepo
      .createQueryBuilder('s')
      .select('COUNT(s.id)', 'cnt')
      .addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .where("s.status = 'frozen'")
      .getRawOne();
    const frozenCount = Number(frozenAgg?.cnt || 0);
    const frozenAmount = toNum(frozenAgg?.amt);

    // — 已解冻可用 —
    const availAgg: any = await soRepo
      .createQueryBuilder('s')
      .select('COUNT(s.id)', 'cnt')
      .addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .where("s.status = 'available'")
      .getRawOne();
    const availableCount = Number(availAgg?.cnt || 0);
    const availableAmount = toNum(availAgg?.amt);

    // — 已提现 —
    const withdrawnAgg: any = await soRepo
      .createQueryBuilder('s')
      .select('COUNT(s.id)', 'cnt')
      .addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .where("s.status = 'withdrawn'")
      .getRawOne();
    const withdrawnCount = Number(withdrawnAgg?.cnt || 0);
    const withdrawnAmount = toNum(withdrawnAgg?.amt);

    // — 本月佣金 —
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const commissionMonthAgg: any = await soRepo
      .createQueryBuilder('s')
      .select('COALESCE(SUM(s.commission), 0)', 'amt')
      .where('s.createdAt >= :ms', { ms: monthStart })
      .getRawOne();
    const commissionMonth = toNum(commissionMonthAgg?.amt);

    // — 历史累计佣金 —
    const commissionTotalAgg: any = await soRepo
      .createQueryBuilder('s')
      .select('COALESCE(SUM(s.commission), 0)', 'amt')
      .getRawOne();
    const commissionTotal = toNum(commissionTotalAgg?.amt);

    // — 待审核提现数 —
    const wrRepo = ds.getRepository(WithdrawRequestEntity);
    const withdrawPending: any = await wrRepo
      .createQueryBuilder('w')
      .select('COUNT(w.id)', 'cnt')
      .where("w.status = 'pending'")
      .getRawOne();

    // — 待处理纠纷数（Week 9：从独立 disputes 表查）—
    let disputePending = 0;
    try {
      const { DisputeEntity } = await getEntities();
      const drRepo = ds.getRepository(DisputeEntity);
      const p = await drRepo
        .createQueryBuilder('d')
        .select('COUNT(d.id)', 'cnt')
        .where("d.status != 'resolved'")
        .getRawOne();
      disputePending = Number(p?.cnt || 0);
    } catch { /* disputes 表未就绪时回退 */ }

    ok(res, {
      todayOrders, todayGMV,
      frozenCount, frozenAmount,
      availableCount, availableAmount,
      withdrawnCount, withdrawnAmount,
      commissionMonth, commissionTotal,
      withdrawPending: Number(withdrawPending?.cnt || 0),
      disputePending,
    });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 2️⃣ GET /api/admin/finance/frozen-pool — 冻结资金池详情
// ========================================================
router.get('/finance/frozen-pool', requireAuth, requireAdmin, async (_req, res) => {
  if (!isTypeORMReady()) {
    const list = mockSettleFrozen;
    const totalFrozenAmount = list.reduce((s, o) => s + Number(o.totalAmount || 0), 0);
    // 按 orderType 分组
    const byRole: Record<string, { count: number; amount: number }> = {};
    for (const t of ['design', 'install', 'goods']) byRole[t] = { count: 0, amount: 0 };
    for (const s of list) {
      if (!byRole[s.orderType]) byRole[s.orderType] = { count: 0, amount: 0 };
      byRole[s.orderType].count++;
      byRole[s.orderType].amount += Number(s.totalAmount || 0);
    }
    // 按 freezeUntil 时间分段
    const now = Date.now();
    const weekLater = now + 7 * 86400000;
    const twoWeeksLater = now + 14 * 86400000;
    const thisWeekList = list.filter(s => new Date(s.freezeUntil).getTime() <= weekLater);
    const nextWeekList = list.filter(s => {
      const t = new Date(s.freezeUntil).getTime(); return t > weekLater && t <= twoWeeksLater;
    });
    const laterList = list.filter(s => new Date(s.freezeUntil).getTime() > twoWeeksLater);

    const agg = (arr: any[]) => ({ count: arr.length, amount: arr.reduce((s, o) => s + Number(o.totalAmount || 0), 0) });

    return ok(res, {
      totalFrozen: list.length,
      totalFrozenAmount,
      byRole,
      byTime: {
        thisWeek: agg(thisWeekList),
        nextWeek: agg(nextWeekList),
        later: agg(laterList),
      },
      list,
    });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { SettleOrderEntity } = await getEntities();
    const repo = ds.getRepository(SettleOrderEntity);

    const qb = repo.createQueryBuilder('s').where("s.status = 'frozen'");

    // — 汇总 —
    const totalAgg: any = await qb
      .clone()
      .select('COUNT(s.id)', 'cnt')
      .addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .getRawOne();

    // — 按 orderType 分组 —
    const byTypeRows: any[] = await qb
      .clone()
      .select('s.orderType', 'orderType')
      .addSelect('COUNT(s.id)', 'cnt')
      .addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .groupBy('s.orderType')
      .getRawMany();
    const byRole: Record<string, { count: number; amount: number }> = {};
    for (const r of byTypeRows) {
      byRole[r.orderType] = { count: Number(r.cnt || 0), amount: toNum(r.amt) };
    }
    // 确保三种类型都有值
    for (const t of ['design', 'install', 'goods']) {
      if (!byRole[t]) byRole[t] = { count: 0, amount: 0 };
    }

    // — 按 freezeUntil 时间分段 —
    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
    const twoWeeksLater = new Date(now.getTime() + 14 * 24 * 3600 * 1000);

    const thisWeek: any = await qb
      .clone()
      .select('COUNT(s.id)', 'cnt').addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .where('s.freezeUntil <= :w', { w: weekLater })
      .getRawOne();
    const nextWeek: any = await qb
      .clone()
      .select('COUNT(s.id)', 'cnt').addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .where('s.freezeUntil > :w AND s.freezeUntil <= :ww', { w: weekLater, ww: twoWeeksLater })
      .getRawOne();
    const later: any = await qb
      .clone()
      .select('COUNT(s.id)', 'cnt').addSelect('COALESCE(SUM(s.totalAmount), 0)', 'amt')
      .where('s.freezeUntil > :ww', { ww: twoWeeksLater })
      .getRawOne();

    // — 明细列表（limit 50）—
    const list = await qb
      .clone()
      .orderBy('s.freezeUntil', 'ASC')
      .limit(50)
      .getMany();

    ok(res, {
      totalFrozen: Number(totalAgg?.cnt || 0),
      totalFrozenAmount: toNum(totalAgg?.amt),
      byRole,
      byTime: {
        thisWeek: { count: Number(thisWeek?.cnt || 0), amount: toNum(thisWeek?.amt) },
        nextWeek: { count: Number(nextWeek?.cnt || 0), amount: toNum(nextWeek?.amt) },
        later: { count: Number(later?.cnt || 0), amount: toNum(later?.amt) },
      },
      list,
    });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 3️⃣ GET /api/admin/finance/commission — 佣金统计
// ========================================================
router.get('/finance/commission', requireAuth, requireAdmin, async (_req, res) => {
  if (!isTypeORMReady()) {
    const all = allMockSettles();
    const totalCommission = all.reduce((s, o) => s + Number(o.commission || 0), 0);
    const byType: Record<string, number> = { design: 0, install: 0, goods: 0 };
    for (const s of all) {
      if (!byType[s.orderType]) byType[s.orderType] = 0;
      byType[s.orderType] += Number(s.commission || 0);
    }
    // 30 天简化：生成 7 个 mock 点
    const trend30d = [];
    const base = Date.now();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(base - i * 86400000);
      trend30d.push({
        date: d.toISOString().slice(0, 10),
        commission: Number((Math.random() * 500 + 200).toFixed(2)),
      });
    }
    return ok(res, { totalCommission, byType, trend30d });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { SettleOrderEntity } = await getEntities();
    const repo = ds.getRepository(SettleOrderEntity);

    // — 总佣金 —
    const totalAgg: any = await repo.createQueryBuilder('s')
      .select('COALESCE(SUM(s.commission), 0)', 'amt').getRawOne();

    // — 按 orderType 分组 —
    const byTypeRows: any[] = await repo.createQueryBuilder('s')
      .select('s.orderType', 'orderType')
      .addSelect('COALESCE(SUM(s.commission), 0)', 'amt')
      .groupBy('s.orderType')
      .getRawMany();
    const byType: Record<string, number> = {};
    for (const r of byTypeRows) byType[r.orderType] = toNum(r.amt);
    for (const t of ['design', 'install', 'goods']) {
      if (!(t in byType)) byType[t] = 0;
    }

    // — 30 天趋势 —
    const trendStart = new Date();
    trendStart.setDate(trendStart.getDate() - 30);
    trendStart.setHours(0, 0, 0, 0);
    const trendRows: any[] = await repo.createQueryBuilder('s')
      .select("DATE(s.createdAt)", 'date')
      .addSelect('COALESCE(SUM(s.commission), 0)', 'commission')
      .where('s.createdAt >= :ts', { ts: trendStart })
      .groupBy("DATE(s.createdAt)")
      .orderBy('date', 'ASC')
      .getRawMany();
    const trend30d = trendRows.map((r: any) => ({ date: r.date, commission: toNum(r.commission) }));

    ok(res, {
      totalCommission: toNum(totalAgg?.amt),
      byType,
      trend30d,
    });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 4️⃣ POST /api/admin/settlements/:id/release — 手动释放冻结结算单
// ========================================================
router.post('/settlements/:id/release', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '无效的 id');

  if (!isTypeORMReady()) {
    const idx = mockSettleFrozen.findIndex(s => Number(s.id) === id);
    if (idx < 0) return notFound(res, '结算单不存在');
    mockSettleFrozen[idx].status = 'available';
    mockSettleFrozen[idx].settledAt = new Date().toISOString();
    const released = mockSettleFrozen.splice(idx, 1)[0];
    mockSettleAvailable.push(released);
    log(`[Admin-mock] finance-release settleNo=${released.settleNo}`);
    return ok(res, { settleNo: released.settleNo, status: released.status, settledAt: released.settledAt });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { SettleOrderEntity } = await getEntities();
    const repo = ds.getRepository(SettleOrderEntity);
    const settle = await repo.findOne({ where: { id } });
    if (!settle) return notFound(res, '结算单不存在');
    if (settle.status !== 'frozen') {
      return badRequest(res, `当前状态 '${settle.status}' 不可释放，仅 frozen 可手动释放`);
    }
    settle.status = 'available';
    settle.settledAt = new Date();
    const saved = await repo.save(settle);
    log(`[admin] finance-release settleNo=${saved.settleNo} providerId=${saved.providerId} admin=${req.user?.id}`);

    // Week 6：补同步 provider Profile earningsFrozen → earningsAvailable
    try {
      const { InstallerProfileEntity, DesignerProfileEntity } = await import('../entities');
      const providerRole = saved.providerRole as string;
      const roleRepo =
        providerRole === 'designer'
          ? ds.getRepository(DesignerProfileEntity)
          : providerRole === 'installer'
            ? ds.getRepository(InstallerProfileEntity)
            : null;
      if (roleRepo) {
        const profile = await roleRepo.findOne({ where: { userId: Number(saved.providerId) } });
        if (profile) {
          const amount = Number(saved.providerGet);
          const frozenNow = Number((profile as any).earningsFrozen ?? 0);
          const availNow = Number((profile as any).earningsAvailable ?? 0);
          (profile as any).earningsFrozen = Math.max(0, frozenNow - amount);
          (profile as any).earningsAvailable = availNow + amount;
          await roleRepo.save(profile);
          log(
            `[admin] release sync profile role=${providerRole} userId=${saved.providerId} +¥${amount} avail`,
            'info',
          );
        }
      }
      // vendor 无 Profile 实体，跳过即可（只有 settle_orders 表冻结池）
    } catch (e: any) {
      log(`[admin] release sync profile error: ${e.message}`, 'warn');
    }

    ok(res, { settleNo: saved.settleNo, status: saved.status, settledAt: saved.settledAt });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 5️⃣ GET /api/admin/disputes — 纠纷列表（Week 9 独立表）
// ========================================================
router.get('/disputes', requireAuth, requireAdmin, async (req, res) => {
  if (!isTypeORMReady()) {
    const { status, orderType, page, size } = (req.query as any) || {};
    let list = [...mockDisputes];
    if (status) list = list.filter(d => d.status === status);
    if (orderType) list = list.filter(d => d.orderType === orderType);
    list.sort((a, b) => {
      if (status === 'resolved') return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(size) || 50));
    const total = list.length;
    list = list.slice((pageNum - 1) * pageSize, pageNum * pageSize);
    return ok(res, { list, total, page: pageNum, size: pageSize });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { DisputeEntity } = await getEntities();
    const repo = ds.getRepository(DisputeEntity);

    // 支持 ?status=pending / ?orderType=goods / ?page=1&size=20
    const { status, orderType, page, size } = (req.query as any) || {};
    const qb = repo.createQueryBuilder('d');

    if (status) qb.andWhere('d.status = :status', { status });
    if (orderType) qb.andWhere('d.orderType = :orderType', { orderType });

    qb.orderBy(
      status === 'resolved' ? 'd.updatedAt' : 'd.createdAt',
      status === 'resolved' ? 'DESC' : 'ASC'
    );

    const pageNum = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(size) || 50));
    qb.skip((pageNum - 1) * pageSize).take(pageSize);

    const [list, total] = await qb.getManyAndCount();

    ok(res, {
      list: list.map(d => ({
        id: d.id, orderId: d.orderId, orderType: d.orderType,
        settleOrderId: d.settleOrderId,
        userId: d.userId, providerId: d.providerId, providerRole: d.providerRole,
        reasonType: d.reasonType, reason: d.reason, description: d.description,
        claimAmount: Number(d.claimAmount || 0), status: d.status,
        reviewedBy: d.reviewedBy, action: d.action,
        refundAmount: Number(d.refundAmount || 0), reviewRemark: d.reviewRemark,
        createdAt: d.createdAt, updatedAt: d.updatedAt,
      })),
      total, page: pageNum, size: pageSize,
    });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 5b️⃣ POST /api/admin/disputes — admin 发起纠纷（手动标记）
// ========================================================
router.post('/disputes', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const body = req.body || {};
  if (!body.orderId || !body.orderType) return badRequest(res, 'orderId + orderType 必填');

  if (!isTypeORMReady()) {
    const d = {
      id: mockDisputeNextId++,
      orderId: String(body.orderId), orderType: body.orderType,
      settleOrderId: body.settleOrderId ? String(body.settleOrderId) : null,
      userId: Number(body.userId || 0),
      providerId: body.providerId ? Number(body.providerId) : null,
      providerRole: body.providerRole || null,
      reasonType: body.reasonType || 'other',
      reason: body.reason || 'admin 手动标记',
      description: body.description || null,
      claimAmount: Number(body.claimAmount || 0),
      status: 'pending',
      reviewedBy: (req as any).userId,
      action: null, refundAmount: 0, reviewRemark: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    mockDisputes.unshift(d);
    log(`[Admin-mock] dispute created id=${d.id}`);
    return ok(res, d);
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { DisputeEntity } = await getEntities();
    const repo = ds.getRepository(DisputeEntity);
    const d = repo.create({
      orderId: String(body.orderId), orderType: body.orderType,
      settleOrderId: body.settleOrderId ? String(body.settleOrderId) : undefined,
      userId: Number(body.userId || 0),
      providerId: body.providerId ? Number(body.providerId) : undefined,
      providerRole: body.providerRole,
      reasonType: body.reasonType || 'other',
      reason: body.reason || 'admin 手动标记',
      description: body.description,
      claimAmount: Number(body.claimAmount || 0),
      status: 'pending',
      reviewedBy: (req as any).userId,
    });
    const saved = await repo.save(d);
    ok(res, saved);
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 6️⃣ POST /api/admin/disputes/:id/resolve — 处理纠纷（Week 9）
// ========================================================
router.post('/disputes/:id/resolve', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { action, refundAmount, remark } = req.body || {};
  if (!id) return badRequest(res, '无效的 id');
  if (!['dismiss', 'full_refund', 'partial_refund'].includes(action)) {
    return badRequest(res, 'action 必须是 dismiss / full_refund / partial_refund');
  }

  if (!isTypeORMReady()) {
    const idx = mockDisputes.findIndex(d => Number(d.id) === id);
    if (idx < 0) return notFound(res, '纠纷不存在');
    const d = mockDisputes[idx];
    d.status = 'resolved';
    d.reviewedBy = (req as any).userId;
    d.action = action;
    d.reviewRemark = remark || null;
    if (action === 'partial_refund') {
      const r = Number(refundAmount);
      if (!r || r <= 0) return badRequest(res, 'refundAmount 必填且 > 0');
      d.refundAmount = r;
    } else if (action === 'full_refund') {
      d.refundAmount = Number(d.claimAmount || 0);
    } else {
      d.refundAmount = 0;
    }
    d.updatedAt = new Date().toISOString();
    log(`[Admin-mock] dispute ${id} resolved action=${action}`);
    return ok(res, d);
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { DisputeEntity, SettleOrderEntity } = await getEntities();
    const dRepo = ds.getRepository(DisputeEntity);
    const settleRepo = ds.getRepository(SettleOrderEntity);

    const dispute = await dRepo.findOne({ where: { id } });
    if (!dispute) return notFound(res, '纠纷不存在');

    // — DisputeEntity 更新（主）—
    dispute.status = 'resolved';
    dispute.reviewedBy = (req as any).userId;
    dispute.action = action as any;
    dispute.reviewRemark = remark || null;
    if (action === 'partial_refund') {
      const r = Number(refundAmount);
      if (!r || r <= 0) return badRequest(res, 'refundAmount 必填且 > 0');
      dispute.refundAmount = r;
    } else if (action === 'full_refund') {
      // 全额退：优先取结算单 providerGet
      if (dispute.settleOrderId) {
        const so = await settleRepo.findOne({ where: { id: Number(dispute.settleOrderId) } });
        dispute.refundAmount = Number(so?.providerGet || dispute.claimAmount || 0);
      } else {
        dispute.refundAmount = dispute.claimAmount;
      }
    }
    const saved = await dRepo.save(dispute);

    // — settle_orders 同步更新（回退镜像）—
    if (dispute.settleOrderId) {
      const settle = await settleRepo.findOne({ where: { id: Number(dispute.settleOrderId) } });
      if (settle) {
        if (action === 'full_refund') {
          await settleRepo.update(
            { id: settle.id },
            { status: 'cancelled', dispute_status: 'resolved', dispute_remark: remark || null } as any
          );
          log(`[admin] dispute-full_refund settleNo=${settle.settleNo} admin=${(req as any).userId}`);
        } else if (action === 'partial_refund') {
          const refund = Number(refundAmount);
          const originalProviderGet = Number(settle.providerGet || 0);
          if (refund > originalProviderGet) {
            return badRequest(res, `退款金额不能超过 providerGet (${originalProviderGet})`);
          }
          const newProviderGet = +(originalProviderGet - refund).toFixed(2);
          const commissionCut = +((refund * Number(settle.commissionRate || 0)) / 1).toFixed(2);
          await settleRepo.update(
            { id: settle.id },
            {
              providerGet: newProviderGet,
              commission: +(Number(settle.commission || 0) - commissionCut).toFixed(2),
              status: 'available',
              settledAt: new Date(),
              dispute_status: 'resolved',
              dispute_remark: remark || null,
            } as any
          );
          log(`[admin] dispute-partial_refund settleNo=${settle.settleNo} refund=${refund} newProviderGet=${newProviderGet} admin=${(req as any).userId}`);
        } else {
          // dismiss
          await settleRepo.update(
            { id: settle.id },
            { dispute_status: 'resolved', dispute_remark: remark || null } as any
          );
          log(`[admin] dispute-dismiss settleNo=${settle.settleNo} admin=${(req as any).userId}`);
        }
      }
    }

    ok(res, saved);
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

export default router;
