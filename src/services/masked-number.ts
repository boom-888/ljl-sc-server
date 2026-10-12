// ============================================================================
// 📞 Masked Number Service — 中间号（防跳单终极武器）
// 真实生产对接阿里云互联通/容联云，此处提供 mock 实现
// 模式：买家 ←── AxBxC ──→ 服务商（双方都看不到真实手机号）
// ============================================================================

import { log } from '../logger';

export interface MaskedBinding {
  bindingId: string;
  userId: string; // 🛠️ Sprint 10.10: 绑定创建者 userId（防越权）
  maskNumber: string; // 中间号 170xxxxxx
  realA: string; // 买家真实号
  realB: string; // 服务商真实号
  relation: string; // 业务关系：order_xxx / install_quote_xxx
  expireAt: string; // ISO
  status: 'active' | 'expired' | 'released';
}

const MASK_POOL = [
  '17000000001',
  '17000000002',
  '17000000003',
  '17000000004',
  '17000000005',
  '17000000006',
  '17000000007',
  '17000000008',
  '17000000009',
  '17000000010',
];
let maskIdx = 0;

const bindings: Map<string, MaskedBinding> = new Map();

/** 创建中间号绑定（买家 ↔ 服务商） */
export function createBinding(
  userId: string,
  realA: string,
  realB: string,
  relation: string,
  hours = 72,
): MaskedBinding {
  const mask = MASK_POOL[maskIdx % MASK_POOL.length];
  maskIdx++;

  const binding: MaskedBinding = {
    bindingId: 'MB' + Date.now() + Math.floor(Math.random() * 10000),
    userId,
    maskNumber: mask,
    realA,
    realB,
    relation,
    expireAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
    status: 'active',
  };
  bindings.set(binding.bindingId, binding);
  log(
    `[MASKED] Binding ${binding.bindingId} userId=${userId} mask=${mask} relation=${relation}`,
    'info',
  );
  return binding;
}

/** 查询绑定（带 userId 校验防越权）*/
export function getBinding(bindingId: string, userId?: string): MaskedBinding | null {
  const b = bindings.get(bindingId);
  if (!b) {
    return null;
  }
  // 🛠️ 防越权：如果传了 userId，必须匹配
  if (userId && b.userId !== userId) {
    return null;
  }
  if (b.status === 'active' && new Date(b.expireAt) < new Date()) {
    b.status = 'expired';
  }
  return b;
}

/** 业务方发起 call（记录通话时长 → 账单） */
export function makeCall(bindingId: string, from: string): { toMask: string; duration?: number } {
  const b = getBinding(bindingId);
  if (!b || b.status !== 'active') {
    return { toMask: '', duration: 0 };
  }
  const to = from === b.realA ? b.realB : b.realA;
  log(`[MASKED] Call ${from} → ${b.maskNumber} → ${to}`, 'info');
  return { toMask: b.maskNumber, duration: 0 };
}

/** 释放绑定（带 userId 校验防越权）*/
export function releaseBinding(bindingId: string, userId?: string): boolean {
  const b = bindings.get(bindingId);
  if (!b) {
    return false;
  }
  // 🛠️ 防越权
  if (userId && b.userId !== userId) {
    return false;
  }
  b.status = 'released';
  return true;
}
