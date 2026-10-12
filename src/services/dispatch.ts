// ============================================================================
// 🎯 Dispatch Service — 派单权重算法
// 综合评分 × 完成订单 × 距离 × 活跃度 × 新手保护 加权排序
// 用于：师傅抢单大厅排序 / 需求发布后匹配师傅排序
// ============================================================================

export interface Candidate {
  id: number;
  rating: number; // 评分 0-5
  ratingCount?: number; // 评分次数
  completedOrders?: number; // 累计完成订单数
  distance?: number; // km
  matchScore?: number; // 分类匹配 1=match 0=nomatch
  onlineScore?: number; // 在线活跃度 0-1
  isNewbie?: boolean; // 新手保护期（前5单）
}

/** 权重配置（可按业务调节） */
const WEIGHT = {
  rating: 0.3, // 评分 30%
  orders: 0.2, // 完成订单数 20%
  distance: 0.2, // 距离近 20%
  match: 0.2, // 分类匹配 20%
  online: 0.1, // 活跃度 10%
  newbieBias: 0.05, // 新手保护加分
};

/** 计算综合匹配分 0-100 */
export function calcDispatchScore(c: Candidate): number {
  let score = 0;

  // 1. 评分（归一化到 0-1）
  const rating = Math.max(0, Math.min(5, c.rating || 0));
  score += (rating / 5) * WEIGHT.rating * 100;

  // 2. 完成订单数（对数归一化，避免大户碾压新手）
  const orders = Math.max(0, c.completedOrders || 0);
  const ordersNorm = Math.min(1, Math.log10(orders + 1) / Math.log10(1000)); // 1000 单 = 满分
  score += ordersNorm * WEIGHT.orders * 100;

  // 3. 距离（越近越好，30km 外归零）
  const dist = Math.max(0, c.distance || 0);
  const distNorm = Math.max(0, 1 - dist / 30);
  score += distNorm * WEIGHT.distance * 100;

  // 4. 分类匹配（二元）
  const matchNorm = c.matchScore ? 1 : 0;
  score += matchNorm * WEIGHT.match * 100;

  // 5. 活跃度
  const online = Math.max(0, Math.min(1, c.onlineScore || 0.5));
  score += online * WEIGHT.online * 100;

  // 6. 新手保护（前 5 单额外加分，帮助新手破局）
  if (c.isNewbie) {
    score += WEIGHT.newbieBias * 100;
  }

  return Math.round(score * 100) / 100;
}

/** 批量加权排序 + 返回带 score 的结果 */
export function rankCandidates<T extends Candidate>(
  candidates: T[],
  opts: { topN?: number } = {},
): (T & { dispatchScore: number; rank: number })[] {
  const withScore = candidates.map((c) => ({
    ...c,
    dispatchScore: calcDispatchScore(c),
  }));
  withScore.sort((a, b) => b.dispatchScore - a.dispatchScore);

  const top = opts.topN ? withScore.slice(0, opts.topN) : withScore;
  return top.map((c, i) => ({ ...c, rank: i + 1 }));
}

/** 计算 VIP 等级（基于完成订单数 + 评分） */
export function calcVipLevel(
  completedOrders: number,
  rating: number,
): {
  level: 'none' | 'silver' | 'gold' | 'diamond';
  name: string;
  monthlyDiscount: number; // 阶梯单价额外折扣
  matchBonus: number; // 派单权重加分 %
} {
  if (completedOrders >= 100 && rating >= 4.8) {
    return { level: 'diamond', name: '钻石师傅', monthlyDiscount: 0.04, matchBonus: 15 };
  }
  if (completedOrders >= 30 && rating >= 4.5) {
    return { level: 'gold', name: '金牌师傅', monthlyDiscount: 0.03, matchBonus: 10 };
  }
  if (completedOrders >= 10 && rating >= 4.0) {
    return { level: 'silver', name: '银牌师傅', monthlyDiscount: 0.02, matchBonus: 5 };
  }
  return { level: 'none', name: '普通师傅', monthlyDiscount: 0, matchBonus: 0 };
}
