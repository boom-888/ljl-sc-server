// ============================================================================
// 📦 Sprint 11 Admin Routes — 系统配置（admin-settings 前端页面数据源）
// 4 条路由：GET / POST / GET :key / DELETE :key + 启动 seed
// ============================================================================
import { Router } from 'express';
import {
  requireAuth, requireAdmin, ok, badRequest, notFound, serverError, log,
} from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { isTypeORMReady } from '../db';

const router = Router();

// — 内存 mock（TypeORM 未就绪时 fallback）—
// key=value 存储，value 可以是 JSON 字符串
let mockSettings: Record<string, any> = {
  platform_name: '零距离广告商城',
  support_phone: '400-888-8888',
  business_hours: '周一至周日 9:00-21:00',
  auto_confirm_days: 7,
  auto_cancel_minutes: 30,
  refund_review_hours: 24,
  after_sale_days: 7,
  commission_rate_goods: 0.10,
  commission_rate_design: 0.15,
  commission_rate_install: 0.12,
  withdraw_fee_rate: 0.006,
  settle_freeze_days: 7,
  // 🚨 2026-10-11 #11 退货运费规则
  refund_shipping_rule_quality: 'merchant',    // 质量问题 → 商家承担运费
  refund_shipping_rule_noreason: 'user',       // 无理由 → 买家自担运费
  refund_shipping_rule_print_error: 'merchant', // 印刷错误 → 商家全包（含来回）
};
const MOCK_SETTING_META: Record<string, { group: string; remark: string }> = {
  platform_name: { group: 'general', remark: '平台名称' },
  support_phone: { group: 'general', remark: '客服电话' },
  business_hours: { group: 'general', remark: '营业时间' },
  auto_confirm_days: { group: 'order', remark: '自动确认收货（天）' },
  auto_cancel_minutes: { group: 'order', remark: '未支付自动取消（分钟）' },
  refund_review_hours: { group: 'order', remark: '退款审核时限（小时）' },
  after_sale_days: { group: 'order', remark: '售后时限（天）' },
  commission_rate_goods: { group: 'financial', remark: '商品销售抽佣率' },
  commission_rate_design: { group: 'financial', remark: '设计服务抽佣率' },
  commission_rate_install: { group: 'financial', remark: '施工服务抽佣率' },
  withdraw_fee_rate: { group: 'financial', remark: '提现手续费率' },
  settle_freeze_days: { group: 'financial', remark: '结算单冻结期（天）' },
  // 🚨 2026-10-11 #11 退货运费规则
  refund_shipping_rule_quality: { group: 'refund', remark: '质量问题退货运费承担方' },
  refund_shipping_rule_noreason: { group: 'refund', remark: '无理由退货运费承担方' },
  refund_shipping_rule_print_error: { group: 'refund', remark: '印刷错误退货运费承担方' },
};

function mockSettingsToGroups(): Record<string, Record<string, any>> {
  const groups: Record<string, Record<string, any>> = {};
  for (const key of Object.keys(mockSettings)) {
    const meta = MOCK_SETTING_META[key] || { group: 'general', remark: '' };
    if (!groups[meta.group]) groups[meta.group] = {};
    const raw = mockSettings[key];
    let val: any = raw;
    try { val = JSON.parse(raw); } catch { /* 原始值已是 number/string */ }
    groups[meta.group][key] = val;
  }
  return groups;
}

// — 动态 import Entity（避免顶层循环依赖）—
async function getEntities() {
  const m = await import('../entities');
  return { SystemConfigEntity: m.SystemConfigEntity };
}

/** GET /api/admin/settings — 按 group 分组返回所有配置 */
router.get('/settings', requireAuth, requireAdmin, async (_req, res) => {
  if (!isTypeORMReady()) {
    const groups = mockSettingsToGroups();
    const list = Object.keys(mockSettings).map(key => {
      const meta = MOCK_SETTING_META[key] || { group: 'general', remark: '' };
      return { key, value: mockSettings[key], group: meta.group, remark: meta.remark };
    });
    return ok(res, { groups, list });
  }
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { groups: {} });
  try {
    const { SystemConfigEntity } = await getEntities();
    const repo = ds.getRepository(SystemConfigEntity);
    const all = await repo.find();
    const groups: Record<string, Record<string, any>> = {};
    for (const c of all) {
      if (!groups[c.group]) groups[c.group] = {};
      try { groups[c.group][c.key] = JSON.parse(c.value); }
      catch { groups[c.group][c.key] = c.value; }
    }
    ok(res, { groups, list: all });
  } catch (e: any) { log(`[Admin] settings error: ${e.message}`, 'error'); serverError(res, '查询失败'); }
});

/** POST /api/admin/settings — 批量 upsert（前端一次存一组设置）*/
router.post('/settings', requireAuth, requireAdmin, async (req: any, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body];
  if (!items.length) return badRequest(res, 'items 必填');

  if (!isTypeORMReady()) {
    for (const it of items) {
      if (!it?.key) continue;
      mockSettings[it.key] = it.value;
      if (!MOCK_SETTING_META[it.key]) {
        MOCK_SETTING_META[it.key] = { group: it.group || 'general', remark: it.remark || '' };
      }
    }
    log(`[Admin-mock] settings saved count=${items.length}`);
    return ok(res, { success: true, count: items.length });
  }

  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { SystemConfigEntity } = await getEntities();
    const repo = ds.getRepository(SystemConfigEntity);
    for (const it of items) {
      if (!it?.key) continue;
      const existing = await repo.findOne({ where: { key: it.key } });
      const value = typeof it.value === 'string' ? it.value : JSON.stringify(it.value);
      const saved = repo.create({
        key: it.key,
        value,
        group: it.group || 'general',
        remark: it.remark || existing?.remark,
      });
      await repo.save(saved);
    }
    ok(res, { success: true, count: items.length });
  } catch (e: any) { log(`[Admin] settings save error: ${e.message}`, 'error'); serverError(res, '保存失败'); }
});

/** GET /api/admin/settings/:key — 单个配置 */
router.get('/settings/:key', requireAuth, requireAdmin, async (req, res) => {
  const key = req.params.key;

  if (!isTypeORMReady()) {
    if (!(key in mockSettings)) return notFound(res, '配置不存在');
    const meta = MOCK_SETTING_META[key] || { group: 'general', remark: '' };
    let val: any = mockSettings[key];
    try { val = JSON.parse(val); } catch {}
    return ok(res, { key, value: val, group: meta.group, remark: meta.remark, updatedAt: null });
  }

  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { SystemConfigEntity } = await getEntities();
    const repo = ds.getRepository(SystemConfigEntity);
    const c = await repo.findOne({ where: { key: req.params.key } });
    if (!c) return notFound(res, '配置不存在');
    let val: any = c.value;
    try { val = JSON.parse(c.value); } catch {}
    ok(res, { key: c.key, value: val, group: c.group, remark: c.remark, updatedAt: c.updatedAt });
  } catch (e: any) { log(`[Admin] settings get error: ${e.message}`, 'error'); serverError(res, '查询失败'); }
});

/** DELETE /api/admin/settings/:key — 删除单个配置 */
router.delete('/settings/:key', requireAuth, requireAdmin, async (req, res) => {
  const key = req.params.key;

  if (!isTypeORMReady()) {
    if (!(key in mockSettings)) return notFound(res, '配置不存在');
    delete mockSettings[key];
    delete MOCK_SETTING_META[key];
    return ok(res, { success: true });
  }

  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');
  try {
    const { SystemConfigEntity } = await getEntities();
    const repo = ds.getRepository(SystemConfigEntity);
    const c = await repo.findOne({ where: { key: req.params.key } });
    if (!c) return notFound(res, '配置不存在');
    await repo.remove(c);
    ok(res, { success: true });
  } catch (e: any) { log(`[Admin] settings delete error: ${e.message}`, 'error'); serverError(res, '删除失败'); }
});

// — 默认配置 seed（TypeORM 模式下启动时跑一次，幂等）—
async function ensureSeedSettings() {
  const ds = getDataSource();
  if (!ds?.isInitialized) return;
  try {
    const { SystemConfigEntity } = await getEntities();
    const repo = ds.getRepository(SystemConfigEntity);
    const defaults = [
      { key: 'platform_name', value: '零距离广告商城', group: 'general', remark: '平台名称' },
      { key: 'support_phone', value: '400-888-8888', group: 'general', remark: '客服电话' },
      { key: 'business_hours', value: '周一至周日 9:00-21:00', group: 'general', remark: '营业时间' },
      { key: 'auto_confirm_days', value: 7, group: 'order', remark: '自动确认收货（天）' },
      { key: 'auto_cancel_minutes', value: 30, group: 'order', remark: '未支付自动取消（分钟）' },
      { key: 'refund_review_hours', value: 24, group: 'order', remark: '退款审核时限（小时）' },
      { key: 'after_sale_days', value: 7, group: 'order', remark: '售后时限（天）' },
      { key: 'commission_rate_goods', value: 0.10, group: 'financial', remark: '商品销售抽佣率' },
      { key: 'commission_rate_design', value: 0.15, group: 'financial', remark: '设计服务抽佣率' },
      { key: 'commission_rate_install', value: 0.12, group: 'financial', remark: '施工服务抽佣率' },
      { key: 'withdraw_fee_rate', value: 0.006, group: 'financial', remark: '提现手续费率' },
      { key: 'settle_freeze_days', value: 7, group: 'financial', remark: '结算单冻结期（天）' },
    ];
    for (const d of defaults) {
      const exists = await repo.findOne({ where: { key: d.key } });
      if (!exists) {
        await repo.save(repo.create({ key: d.key, value: JSON.stringify(d.value), group: d.group, remark: d.remark }));
      }
    }
  } catch { /* seed 失败不阻断启动 */ }
}
// 启动时执行一次
ensureSeedSettings().then(() => log('[Admin] system_config seed done')).catch(() => {});

export default router;
