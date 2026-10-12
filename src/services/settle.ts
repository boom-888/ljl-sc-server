// ============================================================================
// 💰 Settle Service — 抽佣结算核心
// 订单完成时触发：计算抽佣 → 记账 → 服务商入冻结 → 7 天解冻 → 可提现
// 安装订单额外：5% 质保金扣留 → 90 天到期释放 → 质保期内可从质保金/保证金扣赔
// ============================================================================

import { log } from '../logger';

// — 🚨 2026-10-11 #13 统一从 system_config 表读配置（admin-settings 管理）—
// 这两个模块级常量**只作为 fallback 默认值**，实际运行时优先读 DB
export const COMMISSION_RATES = {
  goods: { base: 0.10, vipDiscount: 0.02 },
  design: { base: 0.15, vipDiscount: 0.03 },
  install: { base: 0.12, vipDiscount: 0.03 },
};

export const FREEZE_DAYS: Record<string, number> = {
  goods: 3,
  design: 7,
  install: 7,
};

/** 通用：从 system_config 表读配置（DB 未就绪/key 不存在时返回 defaultVal）*/
export async function getSystemConfig<T>(key: string, defaultVal: T): Promise<T> {
  try {
    const { getDataSource } = await import('../db-manager');
    const ds = getDataSource();
    if (!ds?.isInitialized) return defaultVal;
    const { SystemConfigEntity } = await import('../entities');
    const row = await ds.getRepository(SystemConfigEntity).findOne({ where: { key } });
    if (!row) return defaultVal;
    // 尝试 parse JSON，失败则原样返回 string
    try { return JSON.parse(row.value) as T; } catch { return row.value as unknown as T; }
  } catch { return defaultVal; }
}

/** 从 system_config 读抽佣 base rate（覆盖 COMMISSION_RATES 常量）*/
async function getCommissionRate(type: 'goods' | 'design' | 'install'): Promise<number> {
  const key = `commission_rate_${type}`;
  const defaultBase = COMMISSION_RATES[type].base;
  const val = await getSystemConfig<number>(key, defaultBase);
  return Number(val) || defaultBase;
}

/** 从 system_config 读冻结天数（覆盖 FREEZE_DAYS 常量）*/
async function getFreezeDays(type: 'goods' | 'design' | 'install'): Promise<number> {
  // 简化：所有类型统一读 settle_freeze_days（3 还是 7 由 admin 配一个值就行）
  const val = await getSystemConfig<number>('settle_freeze_days', FREEZE_DAYS[type] ?? 7);
  return Number(val) || 7;
}

/** 质保配置（仅安装订单）
 * ⚠️ 2026-10-11 简化：早期不扣质保金（holdRate=0），先跑通基础结算链路
 *   理由：① 5% 比例太低（行业一般 10-20%）师傅不在意；② 90 天统一太长（简单安装 7 天够）
 *   后期跑量纠纷多了再加：区分"复杂安装 LED/发光字"启用 10% 30 天，简单安装保持 0
 *   arbitration 仲裁规则也要等 admin-settings 配置中心建好后一起上 */
export const WARRANTY_CONFIG = {
  holdRate: 0, // 早期不扣；启用时改成 0.10（10%）
  holdRateMax: 0.15, // 预留上限
  days: 30, // 到期释放（holdRate=0 时无实际作用，仅结构保留）
  respondHours: 24,
  resolutionHours: 72,
};

/** 阶梯单价（按服务商月完成订单数降佣） */
export function tierDiscount(monthlyOrders: number): number {
  if (monthlyOrders >= 30) {
    return 0.06;
  } // 降 6%
  if (monthlyOrders >= 20) {
    return 0.04;
  } // 降 4%
  if (monthlyOrders >= 10) {
    return 0.02;
  } // 降 2%
  return 0;
}

/** 计算最终抽佣（从 system_config 读 base rate，admin 可随时改）*/
export async function calcCommission(
  amount: number,
  type: 'goods' | 'design' | 'install',
  vipLevel: 'none' | 'silver' | 'gold' | 'diamond' = 'none',
  monthlyOrders = 0,
): Promise<{ rate: number; amount: number; providerGet: number }> {
  const baseRate = await getCommissionRate(type);
  let rate = baseRate;
  // VIP 折扣（暂时保留硬编码的 vipDiscount，后期也可以移到 system_config）
  const vipDiscount = COMMISSION_RATES[type].vipDiscount;
  if (vipLevel !== 'none') {
    rate -= vipDiscount;
  }
  // 阶梯折扣
  rate -= tierDiscount(monthlyOrders);
  // 下限保护（4% 是行业最低下限，避免平台免费做苦力）
  rate = Math.max(0.04, Math.min(baseRate, rate));

  const commission = Number((amount * rate).toFixed(2));
  const providerGet = Number((amount - commission).toFixed(2));
  return { rate, amount: commission, providerGet };
}

/** 结算单（实际落地时存 DB，此处返回数据结构） */
export interface SettleOrder {
  settleNo: string;
  orderId: string;
  orderType: 'goods' | 'design' | 'install';
  providerId: number;
  providerRole: 'vendor' | 'designer' | 'installer';
  totalAmount: number;
  commissionRate: number;
  commission: number;
  providerGet: number;
  platformRevenue: number;
  status: 'frozen' | 'available' | 'withdrawn';
  freezeUntil: string; // ISO datetime：7 天后
  createdAt: string;
  // — 安装订单质保扩展 —
  warrantyHoldAmount?: number; // 扣留质保金
  warrantyExpireAt?: string; // 90 天后释放
  providerGetAfterHold?: number; // providerGet - warrantyHoldAmount（实际可提现净额）
}

/** buildSettle 可选覆盖项（方案 10.2 对齐） */
export interface BuildSettleOptions {
  commissionRate?: number; // 强制覆盖佣金比例（0~1），跳过 calcCommission
  freezeDays?: number;     // 强制覆盖冻结天数
  orderNo?: string;        // 预留
}

/** 生成结算单（async — 从 system_config 读抽佣率和冻结期）*/
export async function buildSettle(
  orderId: string,
  orderType: 'goods' | 'design' | 'install',
  providerId: number,
  providerRole: 'vendor' | 'designer' | 'installer',
  totalAmount: number,
  vipLevel: 'none' | 'silver' | 'gold' | 'diamond' = 'none',
  monthlyOrders = 0,
  options?: BuildSettleOptions,
): Promise<SettleOrder> {
  const now = new Date();

  // 冻结期：options 优先 → system_config → FREEZE_DAYS 兜底
  const days = options?.freezeDays ?? (await getFreezeDays(orderType)) ?? 7;
  const freezeUntil = new Date(now.getTime() + days * 24 * 3600 * 1000);

  // 佣金：options 给 commissionRate 则直接用，否则走 calcCommission（读 system_config）
  let rate: number;
  let commission: number;
  let providerGet: number;
  if (options?.commissionRate != null) {
    rate = options.commissionRate;
    commission = Number((totalAmount * rate).toFixed(2));
    providerGet = Number((totalAmount - commission).toFixed(2));
  } else {
    const r = await calcCommission(totalAmount, orderType, vipLevel, monthlyOrders);
    rate = r.rate;
    commission = r.amount;
    providerGet = r.providerGet;
  }

  // — 安装订单：额外扣留 5% 作为质保金 —
  let warrantyHoldAmount: number | undefined;
  let warrantyExpireAt: string | undefined;
  let providerGetAfterHold: number | undefined;

  if (orderType === 'install') {
    warrantyHoldAmount = Number((providerGet * WARRANTY_CONFIG.holdRate).toFixed(2));
    providerGetAfterHold = Number((providerGet - warrantyHoldAmount).toFixed(2));
    const expire = new Date(now.getTime() + WARRANTY_CONFIG.days * 24 * 3600 * 1000);
    warrantyExpireAt = expire.toISOString();
  }

  return {
    settleNo:
      'ST' +
      now.getTime() +
      Math.floor(Math.random() * 10000)
        .toString()
        .padStart(4, '0'),
    orderId,
    orderType,
    providerId,
    providerRole,
    totalAmount: Number(totalAmount.toFixed(2)),
    commissionRate: rate,
    commission,
    providerGet,
    platformRevenue: commission,
    status: 'frozen',
    freezeUntil: freezeUntil.toISOString(),
    createdAt: now.toISOString(),
    // 质保扩展
    warrantyHoldAmount,
    warrantyExpireAt,
    providerGetAfterHold,
  };
}

/** 90 天质保到期检测 — 批量扫描已过期但仍 active 的订单，自动释放质保金 */
export function checkWarrantyExpired(
  orders: { id: number; warrantyExpireAt?: string; warrantyStatus: string }[],
): number[] {
  const now = new Date();
  const expired: number[] = [];
  for (const o of orders) {
    if (
      o.warrantyStatus === 'active' &&
      o.warrantyExpireAt &&
      new Date(o.warrantyExpireAt) <= now
    ) {
      expired.push(o.id);
    }
  }
  return expired;
}

// NOTE: 使用动态 import('../entities') 以避免循环依赖（entities/index.ts 间接引用了本文件的 WARRANTY_CONFIG）

/** 真实结算：存 SettleOrderEntity + 更新 provider earningsFrozen + 记 money_flow */
export async function settle(order: SettleOrder): Promise<SettleOrder> {
  const { getDataSource } = await import('../db-manager');
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    log(`[SETTLE] DB not ready, settle ${order.settleNo} skipped`, 'warn');
    return order;
  }

  // Lazily import entities (avoid circular deps with index.ts)
  const {
    SettleOrderEntity,
    MoneyFlowEntity,
    InstallerProfileEntity,
    DesignerProfileEntity,
  } = await import('../entities');

  const settleRepo = ds.getRepository(SettleOrderEntity);
  const flowRepo = ds.getRepository(MoneyFlowEntity);

  // Check if already settled (idempotent)
  const existing = await settleRepo.findOne({ where: { settleNo: order.settleNo } });
  if (existing) {
    log(`[SETTLE] ${order.settleNo} already exists, skip`, 'info');
    return order;
  }

  // 1. Persist settle order
  const entity = settleRepo.create({
    settleNo: order.settleNo,
    orderId: String(order.orderId),
    orderType: order.orderType,
    providerId: order.providerId,
    providerRole: order.providerRole,
    totalAmount: order.totalAmount,
    commissionRate: order.commissionRate,
    commission: order.commission,
    providerGet: order.providerGet,
    warrantyHoldAmount: order.warrantyHoldAmount ?? 0,
    status: order.status,
    freezeUntil: new Date(order.freezeUntil),
  });
  await settleRepo.save(entity);

  // 2. Update provider earnings (frozen — 7 天后解冻)
  // goods orders: no installer/designer profile — just record settle
  if (order.providerRole === 'installer') {
    const installerRepo = ds.getRepository(InstallerProfileEntity);
    const profile = await installerRepo.findOne({ where: { userId: order.providerId } });
    if (profile) {
      const addFrozen = Number((order.providerGetAfterHold ?? order.providerGet).toFixed(2));
      const frozenNow = Number(profile.earningsFrozen ?? 0);
      const totalNow = Number(profile.totalEarnings ?? 0);
      profile.earningsFrozen = Number((frozenNow + addFrozen).toFixed(2));
      profile.totalEarnings = Number((totalNow + addFrozen).toFixed(2));
      await installerRepo.save(profile);
    }
  } else if (order.providerRole === 'designer') {
    const designerRepo = ds.getRepository(DesignerProfileEntity);
    const profile = await designerRepo.findOne({ where: { userId: order.providerId } });
    if (profile) {
      const addFrozen = Number(order.providerGet.toFixed(2));
      const frozenNow = Number(profile.earningsFrozen ?? 0);
      const totalNow = Number(profile.totalEarnings ?? 0);
      profile.earningsFrozen = Number((frozenNow + addFrozen).toFixed(2));
      profile.totalEarnings = Number((totalNow + addFrozen).toFixed(2));
      await designerRepo.save(profile);
    }
  }

  // 3. Money flow audit trail
  const flow = flowRepo.create({
    flowNo: 'FL' + Date.now() + Math.floor(Math.random() * 10000).toString().padStart(4, '0'),
    type: 'settle',
    refNo: order.settleNo,
    toUserId: order.providerId,
    toRole: order.providerRole,
    amount: Number(order.providerGet.toFixed(2)),
    remark: `${order.orderType} order ${order.orderId} settle`,
  });
  await flowRepo.save(flow);

  // 4. 🆕 PlatformTransaction 双写（抽佣流水）
  try {
    const { createPlatformTransactionORM } = await import('../db-orm');
    await createPlatformTransactionORM({
      type: 'commission',
      source: order.orderType as any, // goods / design / install 对齐 PlatformTxSource
      sourceId: Number(order.orderId) || 0,
      baseAmount: order.totalAmount,
      rate: order.commissionRate,
      targetRole: order.providerRole as any,
      targetUserId: order.providerId,
      settleNo: order.settleNo,
      remark: `${order.orderType} settle ${order.orderNo ?? order.orderId}`,
    });
  } catch (ptErr: any) {
    log(`[SETTLE] PlatformTransaction dual-write skipped: ${ptErr.message}`, 'warn');
  }

  const holdInfo = order.warrantyHoldAmount
    ? ` 质保扣留 ¥${order.warrantyHoldAmount} → 到期 ${order.warrantyExpireAt?.slice(0, 10)}`
    : '';
  log(
    `[SETTLE] ✅ ${order.settleNo} provider=${order.providerId} ¥${order.totalAmount} → 平台 ¥${order.commission} 服务商 ¥${order.providerGet}${holdInfo} [${order.status}]`,
    'info',
  );
  return order;
}

/** 每日解冻：扫描冻结到期的 settle 单 → 对应 installer/designer earningsFrozen → earningsAvailable */
export async function unfreezeSettles(): Promise<number> {
  const { getDataSource } = await import('../db-manager');
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return 0;

  const {
    SettleOrderEntity,
    InstallerProfileEntity,
    DesignerProfileEntity,
  } = await import('../entities');

  const now = new Date();
  const repo = ds.getRepository(SettleOrderEntity);
  const frozen = await repo.find({ where: { status: 'frozen' } });
  let count = 0;

  for (const s of frozen) {
    if (s.freezeUntil <= now) {
      s.status = 'available';
      s.settledAt = now;
      await repo.save(s);

      // Move from frozen → available
      const amount = Number(s.providerGet.toFixed(2));
      if (s.providerRole === 'installer') {
        const profRepo = ds.getRepository(InstallerProfileEntity);
        const p = await profRepo.findOne({ where: { userId: s.providerId } });
        if (p) {
          const frozen = Number(p.earningsFrozen ?? 0);
          const avail = Number(p.earningsAvailable ?? 0);
          p.earningsFrozen = Number((frozen - amount).toFixed(2));
          p.earningsAvailable = Number((avail + amount).toFixed(2));
          await profRepo.save(p);
        }
      } else if (s.providerRole === 'designer') {
        const profRepo = ds.getRepository(DesignerProfileEntity);
        const p = await profRepo.findOne({ where: { userId: s.providerId } });
        if (p) {
          const frozen = Number(p.earningsFrozen ?? 0);
          const avail = Number(p.earningsAvailable ?? 0);
          p.earningsFrozen = Number((frozen - amount).toFixed(2));
          p.earningsAvailable = Number((p.earningsAvailable + amount).toFixed(2));
          await profRepo.save(p);
        }
      }
      count++;
    }
  }
  if (count > 0) log(`[SETTLE] 🔓 unfreeze ${count} settle orders`, 'info');
  return count;
}
