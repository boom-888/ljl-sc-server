// ============================================================================
// 📦 Sprint 10 Admin Routes — 快递公司码表 + 供应商县区权限
// 职责：管理员给供应商开通"县区配送权限"（不收费，后期可加年费）
// ============================================================================
import { Router } from 'express';
import { In } from 'typeorm';
import { requireAuth, requireAdmin, ok, fail, badRequest, notFound, log } from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { isTypeORMReady } from '../db';
import { eventBus } from '../services/event-bus';
import { ensureBusinessConv } from '../services/chat-hook';

const router = Router();

async function getEntities() {
  const m = await import('../entities');
  return {
    ExpressCompanyEntity: m.ExpressCompanyEntity,
    VendorZonePermissionEntity: m.VendorZonePermissionEntity,
    UserEntity: m.UserEntity,
  };
}

// ========================================================
// 🪵 内存 mock（TypeORM 未就绪时 fallback）—
// ========================================================
let mockExpressCompanies: any[] = [
  { id: 1, code: 'SF', name: '顺丰速运', apiProvider: null, apiAccount: null, apiKey: null, defaultTrackingUrl: 'https://www.sf-express.com', enabled: 1, sort: 1 },
  { id: 2, code: 'JD', name: '京东物流', apiProvider: null, apiAccount: null, apiKey: null, defaultTrackingUrl: 'https://www.jdl.com', enabled: 1, sort: 2 },
  { id: 3, code: 'ZTO', name: '中通快递', apiProvider: null, apiAccount: null, apiKey: null, defaultTrackingUrl: 'https://www.zto.com', enabled: 0, sort: 3 },
];
let mockExpressCompanyNextId = 4;

// 县区权限 mock（新语义）
let mockZonePermissions: any[] = [
  { id: 1, vendorId: 1, province: '上海市', city: '上海市', district: '浦东新区', source: 'admin_grant', status: 'active', expiresAt: null, enabled: 1 },
  { id: 2, vendorId: 1, province: '广东省', city: '深圳市', district: '南山区', source: 'admin_grant', status: 'active', expiresAt: null, enabled: 1 },
  { id: 3, vendorId: 2, province: '北京市', city: '北京市', district: '朝阳区', source: 'admin_grant', status: 'active', expiresAt: null, enabled: 1 },
];
let mockZonePermissionNextId = 4;

let mockVendors: any[] = [
  { id: 7, nickname: '上海图文社', phone: '13900002001', role: 'vendor' },
  { id: 8, nickname: '深圳彩印厂', phone: '13900002002', role: 'vendor' },
  { id: 9, nickname: '北京朝阳印刷', phone: '13900002003', role: 'vendor' },
];

// ========================================================
// 0️⃣ GET /api/admin/vendors — 已通过的供应商列表
// ========================================================
router.get('/vendors', requireAuth, requireAdmin, async (_req, res) => {
  if (!isTypeORMReady()) {
    const list = mockVendors.filter((u) => u.role === 'vendor').map((u) => ({ id: u.id, name: u.nickname || String(u.id), phone: u.phone || '' }));
    return ok(res, list);
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { UserEntity } = await getEntities();
    const list = await ds
      .getRepository(UserEntity)
      .find({ where: { role: 'vendor' }, order: { id: 'ASC' }, select: { id: true, nickname: true, phone: true, role: true } });
    ok(res, list.map((u: any) => ({ id: u.id, name: u.nickname || String(u.id), phone: u.phone || '' })));
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 1️⃣ 快递公司码表（不变）
// ========================================================

router.get('/express-companies', requireAuth, requireAdmin, async (req, res) => {
  if (!isTypeORMReady()) {
    const { enabled } = req.query as any;
    let list = [...mockExpressCompanies].sort((a, b) => a.sort - b.sort || a.id - b.id);
    if (enabled !== undefined) { const want = enabled === '1' ? 1 : 0; list = list.filter((e) => e.enabled === want); }
    return ok(res, list);
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  const { enabled } = req.query as any;
  try {
    const { ExpressCompanyEntity } = await getEntities();
    const repo = ds.getRepository(ExpressCompanyEntity);
    const qb = repo.createQueryBuilder('e').orderBy('e.sort', 'ASC').addOrderBy('e.id', 'ASC');
    if (enabled !== undefined) qb.where('e.enabled = :e', { e: enabled === '1' ? 1 : 0 });
    ok(res, await qb.getMany());
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

router.get('/express-companies/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!isTypeORMReady()) {
    const ec = mockExpressCompanies.find((e) => Number(e.id) === id);
    return ec ? ok(res, ec) : notFound(res, '快递公司不存在');
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { ExpressCompanyEntity } = await getEntities();
    const repo = ds.getRepository(ExpressCompanyEntity);
    const ec = await repo.findOne({ where: { id } });
    return ec ? ok(res, ec) : notFound(res, '快递公司不存在');
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

router.post('/express-companies', requireAuth, requireAdmin, async (req, res) => {
  const { id, code, name, apiProvider, apiAccount, apiKey, defaultTrackingUrl, enabled = 1, sort = 0 } = req.body || {};
  if (!code || !name) return badRequest(res, 'code 和 name 必填');

  if (!isTypeORMReady()) {
    let ec: any;
    if (id) {
      const idx = mockExpressCompanies.findIndex((e) => Number(e.id) === Number(id));
      if (idx < 0) return notFound(res, '快递公司不存在');
      mockExpressCompanies[idx] = { ...mockExpressCompanies[idx], code: code.trim(), name: name.trim(), apiProvider: apiProvider || null, apiAccount: apiAccount || null, apiKey: apiKey || null, defaultTrackingUrl: defaultTrackingUrl || '', enabled: enabled ? 1 : 0, sort: Number(sort) || 0 };
      ec = mockExpressCompanies[idx];
    } else {
      ec = { id: mockExpressCompanyNextId++, code: code.trim(), name: name.trim(), apiProvider: apiProvider || null, apiAccount: apiAccount || null, apiKey: apiKey || null, defaultTrackingUrl: defaultTrackingUrl || '', enabled: enabled ? 1 : 0, sort: Number(sort) || 0 };
      mockExpressCompanies.push(ec);
    }
    log(`[Admin-mock] express-company ${id ? 'updated' : 'created'} id=${ec.id}`);
    return ok(res, ec);
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { ExpressCompanyEntity } = await getEntities();
    const repo = ds.getRepository(ExpressCompanyEntity);
    let ec;
    if (id) { ec = await repo.findOne({ where: { id } }); if (!ec) return notFound(res, '快递公司不存在'); }
    else { ec = new ExpressCompanyEntity(); }
    ec.code = code.trim(); ec.name = name.trim();
    ec.apiProvider = apiProvider || null; ec.apiAccount = apiAccount || null; ec.apiKey = apiKey || null;
    ec.defaultTrackingUrl = defaultTrackingUrl || ''; ec.enabled = enabled ? 1 : 0; ec.sort = Number(sort) || 0;
    const saved = await repo.save(ec);
    log(`[admin] express-company ${id ? 'updated' : 'created'} id=${saved.id}`);
    ok(res, saved);
  } catch (e: any) {
    // 🛠️ Bug fix: 重复键错误 → 返回 409 + 友好提示，不能漏了 unique 字段约束
    if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062 || String(e?.message || '').includes('Duplicate entry')) {
      return fail(res, 409, `快递公司 code 已存在，请换一个（${code}）`, 409);
    }
    fail(res, e.message, 500, 500);
  }
});

router.post('/express-companies/:id/enable', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { enabled } = req.body || {};
  if (!isTypeORMReady()) {
    const idx = mockExpressCompanies.findIndex((e) => Number(e.id) === id);
    if (idx < 0) return notFound(res, '快递公司不存在');
    mockExpressCompanies[idx].enabled = enabled ? 1 : 0;
    return ok(res, { id, enabled: mockExpressCompanies[idx].enabled });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { ExpressCompanyEntity } = await getEntities();
    const repo = ds.getRepository(ExpressCompanyEntity);
    const ec = await repo.findOne({ where: { id } });
    if (!ec) return notFound(res, '快递公司不存在');
    ec.enabled = enabled ? 1 : 0;
    await repo.save(ec);
    ok(res, { id, enabled: ec.enabled });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

router.delete('/express-companies/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!isTypeORMReady()) {
    const idx = mockExpressCompanies.findIndex((e) => Number(e.id) === id);
    if (idx < 0) return notFound(res, '快递公司不存在');
    mockExpressCompanies[idx].enabled = 0;
    return ok(res, { id });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { ExpressCompanyEntity } = await getEntities();
    const repo = ds.getRepository(ExpressCompanyEntity);
    const ec = await repo.findOne({ where: { id } });
    if (!ec) return notFound(res, '快递公司不存在');
    ec.enabled = 0;
    await repo.save(ec);
    ok(res, { id });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 2️⃣ 供应商县区权限（VendorZonePermissionEntity）
// 管理员给供应商开通县区配送权限，不收费。
// 接口路径保持 /delivery-areas 不变，内部换成县区权限语义。
// ========================================================

/** GET /api/admin/delivery-areas — 县区权限列表（可按 vendorId/城市/县区/状态筛选）*/
router.get('/delivery-areas', requireAuth, requireAdmin, async (req, res) => {
  if (!isTypeORMReady()) {
    const { vendorId, city, district, enabled } = req.query as any;
    let list = [...mockZonePermissions].sort((a, b) => a.vendorId - b.vendorId || a.id - b.id);
    if (vendorId) list = list.filter((d) => Number(d.vendorId) === Number(vendorId));
    if (city) list = list.filter((d) => d.city.includes(city));
    if (district) list = list.filter((d) => d.district.includes(district));
    if (enabled !== undefined) { const want = enabled === '1' ? 1 : 0; list = list.filter((d) => d.enabled === want); }
    return ok(res, list);
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  const { vendorId, city, district, enabled } = req.query as any;
  try {
    const { VendorZonePermissionEntity } = await getEntities();
    const repo = ds.getRepository(VendorZonePermissionEntity);
    const qb = repo.createQueryBuilder('d').orderBy('d.vendorId', 'ASC').addOrderBy('d.province', 'ASC');
    if (vendorId) qb.where('d.vendorId = :v', { v: Number(vendorId) });
    if (city) qb.andWhere('d.city LIKE :c', { c: `%${city}%` });
    if (district) qb.andWhere('d.district LIKE :dt', { dt: `%${district}%` });
    if (enabled !== undefined) qb.andWhere('d.enabled = :e', { e: enabled === '1' ? 1 : 0 });
    ok(res, await qb.getMany());
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

/** GET /api/admin/delivery-areas/:id — 详情 */
router.get('/delivery-areas/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!isTypeORMReady()) {
    const zp = mockZonePermissions.find((d) => Number(d.id) === id);
    return zp ? ok(res, zp) : notFound(res, '县区权限不存在');
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { VendorZonePermissionEntity } = await getEntities();
    const repo = ds.getRepository(VendorZonePermissionEntity);
    const zp = await repo.findOne({ where: { id } });
    return zp ? ok(res, zp) : notFound(res, '县区权限不存在');
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

/** POST /api/admin/delivery-areas — 新增或编辑县区权限（id 存在=编辑）*/
router.post('/delivery-areas', requireAuth, requireAdmin, async (req, res) => {
  const { id, vendorId, province, city, district, source = 'admin_grant', status = 'active', expiresAt = null, enabled = 1 } = req.body || {};
  if (!vendorId || !province || !city || !district) return badRequest(res, 'vendorId / province / city / district 必填');

  if (!isTypeORMReady()) {
    let zp: any;
    if (id) {
      const idx = mockZonePermissions.findIndex((d) => Number(d.id) === Number(id));
      if (idx < 0) return notFound(res, '县区权限不存在');
      mockZonePermissions[idx] = { ...mockZonePermissions[idx], vendorId: Number(vendorId), province: province.trim(), city: city.trim(), district: district.trim(), source, status, expiresAt, enabled: enabled ? 1 : 0 };
      zp = mockZonePermissions[idx];
    } else {
      zp = { id: mockZonePermissionNextId++, vendorId: Number(vendorId), province: province.trim(), city: city.trim(), district: district.trim(), source, status, expiresAt, enabled: enabled ? 1 : 0 };
      mockZonePermissions.push(zp);
    }
    log(`[Admin-mock] zone-permission ${id ? 'updated' : 'created'} id=${zp.id}`);
    return ok(res, zp);
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { VendorZonePermissionEntity } = await getEntities();
    const repo = ds.getRepository(VendorZonePermissionEntity);
    let zp;
    if (id) { zp = await repo.findOne({ where: { id } }); if (!zp) return notFound(res, '县区权限不存在'); }
    else {
      // 同一供应商同一县区不能重复开通
      const dup = await repo.findOne({ where: { vendorId: Number(vendorId), province: province.trim(), city: city.trim(), district: district.trim() } });
      if (dup) return badRequest(res, '该供应商已开通此县区');
      zp = new VendorZonePermissionEntity();
    }
    zp.vendorId = Number(vendorId); zp.province = province.trim(); zp.city = city.trim(); zp.district = district.trim();
    zp.source = source || 'admin_grant'; zp.status = status || 'active';
    zp.expiresAt = expiresAt || null; zp.enabled = enabled ? 1 : 0;
    const saved = await repo.save(zp);
    log(`[admin] zone-permission ${id ? 'updated' : 'created'} id=${saved.id} vendorId=${saved.vendorId} ${saved.province}/${saved.city}/${saved.district}`);
    ok(res, saved);
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

/** POST /api/admin/delivery-areas/batch — 批量给供应商开通县区权限（≤200 条）*/
router.post('/delivery-areas/batch', requireAuth, requireAdmin, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return badRequest(res, 'items 数组不能为空');
  if (items.length > 200) return badRequest(res, '单次最多 200 条');
  // 每条必填：vendorId / province / city / district
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.vendorId || !it.province || !it.city || !it.district) return badRequest(res, `第 ${i + 1} 条缺少 vendorId / province / city / district`);
  }

  if (!isTypeORMReady()) {
    const saved: any[] = [];
    for (const i of items) {
      saved.push({
        id: mockZonePermissionNextId++,
        vendorId: Number(i.vendorId), province: i.province.trim(), city: i.city.trim(), district: i.district.trim(),
        source: i.source || 'admin_grant', status: i.status || 'active', expiresAt: i.expiresAt || null,
        enabled: i.enabled ?? 1,
      });
    }
    mockZonePermissions.push(...saved);
    return ok(res, { count: saved.length });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { VendorZonePermissionEntity } = await getEntities();
    const repo = ds.getRepository(VendorZonePermissionEntity);
    const saved = await repo.save(items.map((i) => Object.assign(new VendorZonePermissionEntity(), {
      vendorId: Number(i.vendorId), province: i.province.trim(), city: i.city.trim(), district: i.district.trim(),
      source: i.source || 'admin_grant', status: i.status || 'active', expiresAt: i.expiresAt || null,
      enabled: i.enabled ?? 1,
    })));
    log(`[admin] zone-permission batch created count=${saved.length}`);
    ok(res, { count: saved.length });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

/** POST /api/admin/delivery-areas/:id/enable — 启用/停用县区权限 */
router.post('/delivery-areas/:id/enable', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { enabled } = req.body || {};
  if (!isTypeORMReady()) {
    const idx = mockZonePermissions.findIndex((d) => Number(d.id) === id);
    if (idx < 0) return notFound(res, '县区权限不存在');
    mockZonePermissions[idx].enabled = enabled ? 1 : 0;
    return ok(res, { id, enabled: mockZonePermissions[idx].enabled });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { VendorZonePermissionEntity } = await getEntities();
    const repo = ds.getRepository(VendorZonePermissionEntity);
    const zp = await repo.findOne({ where: { id } });
    if (!zp) return notFound(res, '县区权限不存在');
    zp.enabled = enabled ? 1 : 0;
    await repo.save(zp);
    ok(res, { id, enabled: zp.enabled });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

/** DELETE /api/admin/delivery-areas/:id — 撤销县区权限（软删 enabled=0）*/
router.delete('/delivery-areas/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!isTypeORMReady()) {
    const idx = mockZonePermissions.findIndex((d) => Number(d.id) === id);
    if (idx < 0) return notFound(res, '县区权限不存在');
    mockZonePermissions[idx].enabled = 0;
    return ok(res, { id });
  }
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { VendorZonePermissionEntity } = await getEntities();
    const repo = ds.getRepository(VendorZonePermissionEntity);
    const zp = await repo.findOne({ where: { id } });
    if (!zp) return notFound(res, '县区权限不存在');
    zp.enabled = 0;
    await repo.save(zp);
    ok(res, { id });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ========================================================
// 🛡️ 2026-10-11 #11 退款审核（admin 端）
// List → Detail → Approve/Reject（含 shippingFeeLiable 运费责任判定）
// ========================================================

async function getRefundEntities() {
  const m = await import('../entities');
  return {
    RefundEntity: m.RefundEntity,
    SystemConfigEntity: m.SystemConfigEntity,
  };
}

const LIABILITY_LABELS: Record<string, string> = {
  merchant: '商家承担',
  user: '买家自担',
  platform: '平台承担',
};
const LIABILITY_REASONS: Record<string, string> = {
  merchant: '质量问题 / 商家责任',
  user: '无理由退货',
  platform: '印刷错误 / 平台责任',
};

/** GET /api/admin/refunds — 退款列表 */
router.get('/refunds', requireAuth, requireAdmin, async (req: any, res) => {
  const { status, orderNo, userId } = req.query;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { RefundEntity } = await getRefundEntities();
    const repo = ds.getRepository(RefundEntity);
    const qb = repo.createQueryBuilder('r').orderBy('r.createdAt', 'DESC');
    if (status) qb.where('r.status = :s', { s: status });
    if (orderNo) qb.andWhere('r.orderNo LIKE :no', { no: `%${orderNo}%` });
    if (userId) qb.andWhere('r.userId = :uid', { uid: Number(userId) });
    const list = await qb.limit(200).getMany();
    ok(res, { list, total: list.length });
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

/** GET /api/admin/refunds/:id — 退款详情 */
router.get('/refunds/:id', requireAuth, requireAdmin, async (req: any, res) => {
  const id = Number(req.params.id);
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
  try {
    const { RefundEntity } = await getRefundEntities();
    const repo = ds.getRepository(RefundEntity);
    const r = await repo.findOne({ where: { id } });
    if (!r) return notFound(res, '退款申请不存在');
    ok(res, r);
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

/** POST /api/admin/refund-reviews/:id — 审核（通过/拒绝 + 运费责任判定）
 *  body: { action: 'approve'|'reject', shippingFeeLiable?, shippingAmount?, reviewRemark? }
 *  2026-10-11 hotfix: 改路径避开 /refunds/:id/review 被未知路由劫持 */
router.post('/refund-reviews/:id', requireAuth, async (req: any, res) => {
  try {
    const id = Number(req.params.id);
    const { action, shippingFeeLiable, shippingAmount, reviewRemark } = req.body || {};
    if (!action || (action !== 'approve' && action !== 'reject')) {
      return badRequest(res, 'action 必须是 approve 或 reject');
    }
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);
    const { RefundEntity } = await getRefundEntities();
    const repo = ds.getRepository(RefundEntity);
    const r = await repo.findOne({ where: { id } });
    if (!r) return notFound(res, '退款申请不存在');
    if (r.status !== 'pending') return badRequest(res, `该退款已处理（status=${r.status}）`);

    let liable = shippingFeeLiable || r.shippingFeeLiable;
    let liableReason = reviewRemark ? String(reviewRemark).slice(0, 500) : LIABILITY_REASONS[liable];
    let shipAmt = Number(shippingAmount) || 0;

    r.status = action === 'approve' ? 'approved' : 'rejected';
    r.reviewedBy = req.userId;
    r.reviewRemark = liableReason;
    r.shippingFeeLiable = liable;
    r.shippingFeeLiableReason = liableReason;
    r.shippingAmount = shipAmt;
    r.reviewedAt = new Date();
    await repo.save(r);

    log(`[Admin] refund#${id} ${action} liable=${liable} shipAmt=${shipAmt} by user#${req.userId}`);
    ok(res, r);
  } catch (e: any) { fail(res, 'REFUND_ERR: ' + e.message, 500, 500); }
});

// ========================================================
// 🛠️ 第四批：admin 手动派单（跳过 quoting，直接生成 InstallationOrder）
// ========================================================

/** POST /api/admin/installation/assign — 管理员手动给师傅派安装单
 *  body: { demandId: number, installerId: number, finalPrice?: number }
 */
router.post('/installation/assign', requireAuth, requireAdmin, async (req: any, res) => {
  const { demandId, installerId, finalPrice } = req.body || {};
  if (!demandId || !installerId) return badRequest(res, 'demandId / installerId 必填');
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return fail(res, 503, '数据库未就绪', 503);

  try {
    const { InstallationDemandEntity, InstallationOrderEntity } =
      await import('../entities/sprint4');
    const { InstallerProfileEntity } = await import('../entities/sprint5');

    // 1. 找需求
    const demand = await ds
      .getRepository(InstallationDemandEntity)
      .findOne({ where: { id: Number(demandId), status: In(['pending', 'quoting']) } });
    if (!demand) return notFound(res, '需求不存在或状态不允许派单');

    // 2. 找师傅（必须已认证）
    const installer = await ds
      .getRepository(InstallerProfileEntity)
      .findOne({ where: { id: Number(installerId), verified: 1 } });
    if (!installer) return badRequest(res, '师傅不存在或未认证');

    // 3. 检查该 demand 是否已有关联订单
    const existing = await ds
      .getRepository(InstallationOrderEntity)
      .findOne({ where: { demandId: demand.id } });
    if (existing) return badRequest(res, '该需求已有安装订单，不能重复派单');

    // 4. 生成订单号
    const orderNo = 'INO' + Date.now().toString().slice(-10) +
      Math.floor(Math.random() * 1000).toString().padStart(3, '0');

    // 5. 创建订单（跳过 quoting，quoteId=0 表示 admin 手动派单）
    const price = Number(finalPrice) ?? Number(demand.budgetMin || demand.budgetMax || 0);
    const order = ds.getRepository(InstallationOrderEntity).create({
      orderNo,
      demandId: demand.id,
      quoteId: 0, // admin 手动派单，无报价
      userId: demand.userId,
      installerId: installer.id,
      finalPrice: price,
      status: 'pending',
      currentStage: 0,
    });
    await ds.getRepository(InstallationOrderEntity).save(order);

    // 6. 更新 demand 状态 → assigned
    demand.status = 'assigned';
    await ds.getRepository(InstallationDemandEntity).save(demand);

    // 7. eventBus → 推给师傅
    eventBus.emit('manual_assign', 'installer', installer.userId, {
      orderId: order.id, orderNo, demandId: demand.id,
    });

    // 8. ensureBusinessConv（买家 ↔ 师傅）
    try {
      await ensureBusinessConv({
        refType: 'installation_order',
        refId: order.id,
        partyA: demand.userId,
        partyB: installer.userId,
        event: 'manual_assign',
      });
    } catch (e: any) {
      log(`[admin-assign] chat-hook fail: ${e.message}`, 'warn');
    }

    // 9. SMS 通知师傅（静默失败）
    try {
      const { smsGateway } = await import('../services/sms-gateway');
      if (installer.phone) {
        await (smsGateway as any).sendTemplateSms!({
          phone: installer.phone,
          templateKey: 'manual_assign',
          variables: { orderNo, address: demand.address?.slice(0, 20) || '', price: String(price) },
        });
      }
    } catch (e: any) {
      log(`[admin-assign] SMS fail: ${e.message}`, 'warn');
    }

    log(`[Admin] manual-assign demand=${demand.id} installer=${installer.id} order=${orderNo} price=${price} by admin#${req.userId}`, 'info');

    ok(res, { orderId: order.id, orderNo, price });
  } catch (e: any) { fail(res, 'ASSIGN_ERR: ' + e.message, 500, 500); }
});

export default router;
