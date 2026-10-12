// ============================================================================
// 🎟️ Admin Coupon Routes — 优惠券模板 CRUD
// Week 5 admin coupon management
// ============================================================================
import { Router } from 'express';
import {
  requireAuth, requireAdmin,
  ok, fail, badRequest, notFound, serverError, log,
} from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { isTypeORMReady } from '../db';

const router = Router();

// — 内存 mock（TypeORM 未就绪时 fallback）—
let mockCoupons: any[] = [
  {
    id: 1, name: '新用户满减券', type: 'amount', value: 10, minAmount: 100,
    description: '满 100 减 10，新用户专享', validDays: 30, total: 1000, remain: 856, active: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: 2, name: '夏季 8 折券', type: 'percent', value: 20, minAmount: 200,
    description: '满 200 享 8 折', validDays: 15, total: 500, remain: 320, active: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    id: 3, name: '大额印刷专属券', type: 'amount', value: 50, minAmount: 500,
    description: '满 500 减 50，印刷类商品可用', validDays: 60, total: 200, remain: 0, active: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
];
let mockCouponNextId = 4;

// — mock 模式 helper —
function mockCpnIndex(id: number) {
  return mockCoupons.findIndex(c => Number(c.id) === id);
}

// ========================================================
// 1️⃣ GET /admin/coupons — 列表
// ========================================================
router.get('/coupons', requireAuth, requireAdmin, async (req, res) => {
  if (!isTypeORMReady()) {
    const { status } = req.query as any;
    let list = [...mockCoupons];
    if (status === 'active') list = list.filter(c => c.active === 1);
    if (status === 'inactive') list = list.filter(c => c.active === 0);
    return ok(res, { list, total: list.length });
  }
  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { CouponEntity } = await import('../entities');
    const { status } = req.query as any; // active / inactive / all
    let where: any = {};
    if (status === 'active') where.active = 1;
    if (status === 'inactive') where.active = 0;
    const repo = ds.getRepository(CouponEntity);
    const list = await repo.find({ where, order: { createdAt: 'DESC' } });
    ok(res, { list, total: list.length });
  } catch (e: any) {
    log(`[Admin] coupons list error: ${e.message}`, 'error');
    serverError(res, '查询失败');
  }
});

// ========================================================
// 2️⃣ GET /admin/coupons/:id — 详情
// ========================================================
router.get('/coupons/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!isTypeORMReady()) {
    const c = mockCoupons.find(x => Number(x.id) === id);
    if (!c) return notFound(res, '券不存在');
    return ok(res, c);
  }
  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { CouponEntity } = await import('../entities');
    const repo = ds.getRepository(CouponEntity);
    const c = await repo.findOne({ where: { id } });
    if (!c) return notFound(res, '券不存在');
    ok(res, c);
  } catch (e: any) {
    log(`[Admin] coupons get error: ${e.message}`, 'error');
    serverError(res, '查询失败');
  }
});

// ========================================================
// 3️⃣ POST /admin/coupons — 新增券
// ========================================================
router.post('/coupons', requireAuth, requireAdmin, async (req: any, res) => {
  const { name, type, value, minAmount, description, validDays, total, active } = req.body || {};
  if (!name?.trim()) return badRequest(res, '券名称必填');
  if (!['amount', 'percent'].includes(type)) return badRequest(res, 'type 必须是 amount 或 percent');
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return badRequest(res, '面值无效');
  if (!Number.isFinite(Number(minAmount)) || Number(minAmount) < 0) return badRequest(res, '门槛金额无效');
  if (type === 'percent' && Number(value) > 100) return badRequest(res, '折扣不能超过 100');

  // — 统一内存 mock（CouponEntity 尚未建表）—
  const entity = {
    id: mockCouponNextId++,
    name: name.trim(), type,
    value: Number(value), minAmount: Number(minAmount),
    description: description?.trim() || '',
    validDays: Number(validDays) || 30,
    total: Number(total) || 0,
    remain: Number(total) || 0,
    active: active !== undefined ? Number(active) : 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mockCoupons.unshift(entity);
  log(`[Admin-coupon] created id=${entity.id} name=${entity.name}`);
  return ok(res, { success: true, coupon: entity });
});

// ========================================================
// 4️⃣ PUT /admin/coupons/:id — 编辑券
// 只允许改非核心字段：name, description, validDays, total, active
// ========================================================
router.put('/coupons/:id', requireAuth, requireAdmin, async (req: any, res) => {
  const id = Number(req.params.id);

  if (!isTypeORMReady()) {
    const idx = mockCpnIndex(id);
    if (idx < 0) return notFound(res, '券不存在');
    const c = mockCoupons[idx];
    if (req.body.name !== undefined) c.name = String(req.body.name).trim();
    if (req.body.description !== undefined) c.description = String(req.body.description).trim();
    if (req.body.validDays !== undefined) c.validDays = Number(req.body.validDays);
    if (req.body.active !== undefined) c.active = Number(req.body.active);
    if (req.body.total !== undefined) {
      const newTotal = Number(req.body.total);
      const diff = newTotal - Number(c.total);
      c.total = newTotal;
      c.remain = Math.max(0, Number(c.remain) + diff);
    }
    c.updatedAt = new Date().toISOString();
    return ok(res, { success: true });
  }

  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { CouponEntity } = await import('../entities');
    const repo = ds.getRepository(CouponEntity);
    const c = await repo.findOne({ where: { id } });
    if (!c) return notFound(res, '券不存在');

    const patch: any = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body.description !== undefined) patch.description = String(req.body.description).trim();
    if (req.body.validDays !== undefined) patch.validDays = Number(req.body.validDays);
    if (req.body.active !== undefined) patch.active = Number(req.body.active);
    if (req.body.total !== undefined) {
      const newTotal = Number(req.body.total);
      const diff = newTotal - c.total;
      patch.total = newTotal;
      patch.remain = Math.max(0, Number(c.remain) + diff);
    }
    Object.assign(c, patch);
    await repo.save(c);
    ok(res, { success: true });
  } catch (e: any) {
    log(`[Admin] coupons update error: ${e.message}`, 'error');
    serverError(res, '更新失败');
  }
});

// ========================================================
// 5️⃣ POST /admin/coupons/:id/toggle — 启停
// ========================================================
router.post('/coupons/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!isTypeORMReady()) {
    const idx = mockCpnIndex(id);
    if (idx < 0) return notFound(res, '券不存在');
    mockCoupons[idx].active = mockCoupons[idx].active ? 0 : 1;
    mockCoupons[idx].updatedAt = new Date().toISOString();
    return ok(res, { success: true, active: mockCoupons[idx].active });
  }

  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { CouponEntity } = await import('../entities');
    const repo = ds.getRepository(CouponEntity);
    const c = await repo.findOne({ where: { id } });
    if (!c) return notFound(res, '券不存在');
    c.active = c.active ? 0 : 1;
    await repo.save(c);
    ok(res, { success: true, active: c.active });
  } catch (e: any) {
    log(`[Admin] coupons toggle error: ${e.message}`, 'error');
    serverError(res, '操作失败');
  }
});

// ========================================================
// 6️⃣ DELETE /admin/coupons/:id — 软删（active→0）
// ========================================================
router.delete('/coupons/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);

  if (!isTypeORMReady()) {
    const idx = mockCpnIndex(id);
    if (idx < 0) return notFound(res, '券不存在');
    mockCoupons[idx].active = 0;
    mockCoupons[idx].updatedAt = new Date().toISOString();
    return ok(res, { success: true });
  }

  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { CouponEntity } = await import('../entities');
    const repo = ds.getRepository(CouponEntity);
    const c = await repo.findOne({ where: { id } });
    if (!c) return notFound(res, '券不存在');
    c.active = 0; // 软删
    await repo.save(c);
    ok(res, { success: true });
  } catch (e: any) {
    log(`[Admin] coupons delete error: ${e.message}`, 'error');
    serverError(res, '删除失败');
  }
});

export default router;
