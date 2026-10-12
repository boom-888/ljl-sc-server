// ============================================================================
// 📝 Design Demand Routes — 用户端 + 设计师大厅
// ⚠️ Express 路由按注册顺序匹配 —— 固定路径(/hall, /list)必须在参数路由(/:id)之前！
// ============================================================================
import { Router } from 'express';
import { requireAuth, requireDesigner, ok, fail, badRequest, AuthedRequest } from '../middleware/auth';
import {
  publishDemandORM,
  listDemandORM,
  getDemandDetailORM,
  cancelDemandORM,
  getDesignDemandHallORM,
  designerAcceptDemandORM,
  findUserByIdORM,
  onSubOrderAcceptedORM,
} from '../db-orm';
import { getDataSource } from '../db-manager';
import { DesignDemandEntity } from '../entities/sprint3';
import { DesignOrderEntity } from '../entities/sprint7';
import { eventBus } from '../services/event-bus';
import { ensureBusinessConv } from '../services/chat-hook';
import { smsGateway } from '../services/sms-gateway';
import { COMMISSION_RATES } from '../services/settle';
import { log } from '../logger';

// — 工具函数：订单号 —
function genDesignOrderNo(): string {
  return 'DO' + Date.now().toString(36).toUpperCase().slice(-8) + Math.floor(Math.random() * 100).toString().padStart(2, '0');
}

const router = Router();

function fmtDemand(d: any) {
  // 📐 Sprint 9：budget 同时返回字符串（向后兼容）和 min/max decimal（前端新代码用）
  let budgetV = d.budget;
  if ((!budgetV || budgetV === '') && (d.budgetMin != null || d.budgetMax != null)) {
    const minStr = d.budgetMin != null ? `¥${d.budgetMin}` : '';
    const maxStr = d.budgetMax != null ? `¥${d.budgetMax}` : '';
    budgetV = minStr && maxStr ? `${minStr}-${maxStr}` : minStr || `${maxStr}+`;
  }
  return {
    id: String(d.id),
    orderNo: d.orderNo || 'SJ' + d.id,
    productId: d.productId ? String(d.productId) : undefined,
    productName: d.productName,
    demandText: d.demandText,
    budget: budgetV, // 向后兼容
    budgetMin: d.budgetMin != null ? Number(d.budgetMin) : null, // 📐 Sprint 9
    budgetMax: d.budgetMax != null ? Number(d.budgetMax) : null, // 📐 Sprint 9
    // 📐 Sprint 9 结构化字段
    designCategory: d.designCategory || null, // 原 Sprint 9 demandType 改名
    demandType: d.demandType || 'design', // 📐 P1：design | fix
    isFixTask: d.demandType === 'fix', // 📐 P1：给前端大厅区分 tag
    styleTags: Array.isArray(d.styleTags) ? d.styleTags : null,
    specSize: d.specSize || null,
    deliverables: d.deliverables || null,
    commercialLicense: d.commercialLicense || null,
    referenceImages: Array.isArray(d.referenceImages) ? d.referenceImages : null,
    contactPhone: d.contactPhone,
    wechat: d.wechat,
    deliveryTime: d.deliveryTime,
    status: d.status,
    statusText: d.statusText,
    designerId: d.designerId ? String(d.designerId) : undefined,
    // 🆕 6 级体系：需求期望的设计师等级范围
    gradeMin: d.gradeMin ?? 1,
    gradeMax: d.gradeMax ?? 6,
    createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt,
    updatedAt: d.updatedAt instanceof Date ? d.updatedAt.toISOString() : d.updatedAt,
    // 🆕 Sprint 13：大厅展示用的 bidders 摘要
    biddersCount: d.bidders?.length || 0,
    biddersPreview: (d.bidders || []).slice(0, 3).map((b: any) => ({
      designerId: b.designerId,
      designerNickname: b.designerNickname,
      quotePrice: b.quotePrice,
    })),
    // 📐 P1：详情页用完整 bidders 列表
    bidders: d.bidders || [],
  };
}

function parseId(p: string | undefined) {
  const n = Number(p);
  if (!p || isNaN(n)) {
    return null;
  }
  return n;
}

// ============================================================
//  固定路径路由（必须在 /:id 之前注册！）
// ============================================================

// — 用户发布 —
router.post('/publish', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const {
    productId,
    productName,
    demandText,
    budget,
    contactPhone,
    wechat,
    deliveryTime, // 旧参数（向后兼容）
    budgetMin,
    budgetMax, // 📐 Sprint 9：结构化预算
    designCategory, // 📐 Sprint 9 设计品类（原 demandType 改名）
    demandType, // 📐 P1：design | fix
    styleTags,
    specSize, // 📐 Sprint 9：结构化设计字段
    deliverables,
    commercialLicense,
    referenceImages,
  } = req.body || {};

  if (!demandText || !demandText.trim()) {
    return badRequest(res, '设计要求 必填');
  }
  if (!deliveryTime) {
    return badRequest(res, '交付时间 必填');
  }

  // 📐 Sprint 9：预算兼容处理——优先 min/max，无则从旧 budget 字符串解析
  let finalBudget = budget || '';
  let finalMin = budgetMin ? Number(budgetMin) : null;
  let finalMax = budgetMax ? Number(budgetMax) : null;

  if (finalMin == null && finalMax == null && finalBudget) {
    // 从 "¥500-¥1000" 或 "¥500+" 格式解析
    const nums = finalBudget.match(/[\d.]+/g)?.map(Number) || [];
    if (nums.length >= 2) {
      finalMin = nums[0];
      finalMax = nums[nums.length - 1];
    } else if (nums.length === 1) {
      finalMin = nums[0];
    }
  }
  // 自动生成 budget varchar（如果只传了 min/max）
  if (!finalBudget && (finalMin != null || finalMax != null)) {
    const minStr = finalMin != null ? `¥${finalMin}` : '';
    const maxStr = finalMax != null ? `¥${finalMax}` : '';
    finalBudget = minStr && maxStr ? `${minStr}-${maxStr}` : minStr ? `${minStr}+` : '';
  }
  if (!finalBudget) {
    return badRequest(res, '预算 必填');
  }

  const demand = await publishDemandORM(userId, {
    productId,
    productName,
    demandText,
    budget: finalBudget, // 自动生成或兼容旧值
    contactPhone,
    wechat,
    deliveryTime,
    // 📐 Sprint 9 新字段
    budgetMin: finalMin,
    budgetMax: finalMax,
    designCategory: designCategory || null, // 📐 Sprint 9 品类
    demandType: demandType === 'fix' ? 'fix' : 'design', // 📐 P1：非法值回默认
    styleTags: Array.isArray(styleTags) ? styleTags : null,
    specSize: specSize || null,
    deliverables: deliverables || null,
    commercialLicense: commercialLicense || null,
    referenceImages: Array.isArray(referenceImages) ? referenceImages : null,
  });

  try {
    eventBus.emit('new_design_demand', 'broadcast', 0, {
      demandId: String(demand.id),
      desc: demandText.slice(0, 60),
      budget: finalBudget,
      deliveryTime,
    });
  } catch (e: any) {
    log('[design-demand] emit publish fail', e?.message);
  }

  ok(res, {
    id: String(demand.id),
    orderNo: demand.orderNo,
    status: demand.status,
    statusText: demand.statusText,
  });
});

// — 用户自己的列表 —
router.get('/list', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const status = req.query.status as string | undefined;
  const list = await listDemandORM(userId, status);
  ok(res, { list: list.map(fmtDemand), total: list.length });
});

// — 设计师大厅（固定路径，必须在 /:id 之前！）—
// 🛡️ P1-2 漏洞修复: 加 requireDesigner 守卫，非 designer 角色不能看大厅
router.get('/hall', requireAuth, requireDesigner, async (req, res) => {
  const userId = (req as any).userId;
  const { keyword, sortBy } = req.query as { keyword?: string; sortBy?: 'latest' | 'budget' };

  // 🆕 6 级体系：查当前登录设计师的 grade
  let designerGrade: number | undefined;
  try {
    const ds = getDataSource();
    if (ds?.isInitialized) {
      const { DesignerProfileEntity } = await import('../entities/sprint5');
      const profile = await ds.getRepository(DesignerProfileEntity).findOne({
        where: { userId },
      });
      if (profile) designerGrade = profile.grade;
    }
  } catch (e) {
    log('查询 designer_profile grade 失败', 'warn');
  }

  const list = await getDesignDemandHallORM({ keyword, sortBy, grade: designerGrade });
  ok(res, { list: list.map(fmtDemand), total: list.length, selfGrade: designerGrade });
});

// ============================================================
//  参数路由（/:id, /:id/cancel, /:id/accept, /:id/confirm）
//  ⚠️ Express 按注册顺序匹配 —— /:id/bid 必须在 /:id 之前！
// ============================================================

// — 🆕 Sprint 13：设计师提交报价 —
// POST /api/design-demand/:id/bid
// 如果 bidders 里已有当前设计师的 bid → 更新 quotePrice + note（不重复加）
router.post('/:id/bid', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = parseId(req.params.id);
  if (id === null) {
    return fail(res, 400, '非法的需求 ID');
  }
  const { quotePrice, note } = req.body || {};

  const price = Number(quotePrice);
  if (isNaN(price) || price <= 0 || price > 10000000) {
    return badRequest(res, '报价金额非法（应在 0.01-1000万 之间）');
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return res.status(503).json({ code: 503, msg: '数据库未就绪' });
  }

  const repo = ds.getRepository(DesignDemandEntity);
  const demand = await repo.findOne({ where: { id } });
  if (!demand) return fail(res, 404, '设计需求不存在', 404);
  if (demand.status !== 'pending') return badRequest(res, '需求已被接单或已完成');

  // 取设计师自己的信息（昵称/头像/等级）
  let designerNickname = '匿名设计师';
  let designerAvatar: string | undefined;
  let designerGrade: number | undefined;
  try {
    const userRepo = ds.getRepository(await (await import('../entities')).UserEntity);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (user) {
      designerNickname = (user as any).nickname || (user as any).name || designerNickname;
      designerAvatar = (user as any).avatarUrl;
    }
    const { DesignerProfileEntity } = await import('../entities/sprint5');
    const profile = await ds.getRepository(DesignerProfileEntity).findOne({ where: { userId } });
    if (profile) designerGrade = profile.grade;
  } catch (e: any) {
    log('[design-demand] bid 查设计师信息失败', 'warn');
  }

  // 更新 bidders 数组（现有 bid 则更新，没有则 push）
  const bidders = demand.bidders || [];
  const existing = bidders.find((b: any) => Number(b.designerId) === Number(userId));
  const newBid: any = {
    designerId: userId,
    designerNickname,
    designerAvatar,
    designerGrade,
    quotePrice: price,
    note: note || '',
    createdAt: new Date().toISOString(),
  };

  if (existing) {
    Object.assign(existing, newBid);
  } else {
    bidders.push(newBid);
  }
  demand.bidders = bidders;
  await repo.save(demand);

  // 事件通知（SSE + SMS）
  try {
    eventBus.emit('new_design_quote', 'designer', userId, {
      demandId: demand.id,
      quotePrice: price,
      biddersCount: bidders.length,
    });
  } catch (e: any) {
    log('[design-demand] bid emit fail', 'warn');
  }

  ok(res, { id: demand.id, biddersCount: bidders.length });
});

// — 详情 —
router.get('/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = parseId(req.params.id);
  if (id === null) {
    return fail(res, 400, '非法的需求 ID');
  }
  const demand = await getDemandDetailORM(userId, id);
  if (!demand) {
    return fail(res, 404, '设计需求不存在', 404);
  }
  ok(res, fmtDemand(demand));
});

// — 用户撤销 —
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = parseId(req.params.id);
  if (id === null) {
    return fail(res, 400, '非法的需求 ID');
  }
  const result = await cancelDemandORM(userId, id);
  if (!result) {
    return fail(res, 404, '设计需求不存在', 404);
  }
  // 类型收窄：cancelDemandORM 返回 DesignDemand | { error: string }
  if ('error' in result) {
    return badRequest(res, result.error);
  }
  ok(res, { id: String(result.id), status: result.status });
});

// — 设计师接单 —
// 🛡️ P1-2 漏洞修复: 加 requireDesigner 守卫
router.post('/:id/accept', requireAuth, requireDesigner, async (req, res) => {
  const userId = (req as any).userId;
  const user = await findUserByIdORM(userId);
  if (user?.role !== 'designer' && user?.role !== 'admin') {
    return fail(res, 403, '需要设计师权限', 403);
  }
  const id = parseId(req.params.id);
  if (id === null) {
    return fail(res, 400, '非法的需求 ID');
  }
  const r = await designerAcceptDemandORM(userId, id);
  if ((r as any).error === 'NOT_FOUND') {
    return fail(res, 404, '需求不存在', 404);
  }
  if ((r as any).error === 'NOT_PENDING') {
    return fail(res, 422, '需求状态不允许接单', 422);
  }

  // — SSE 推给用户（有人接单了）—
  try {
    eventBus.emit('new_design_quote', 'user', (r as any).userId || 0, {
      demandId: String(id),
      designerId: String(userId),
      designerName: user?.nickname || (user as any)?.name || '设计师',
    });
  } catch (e: any) {
    log('[design-demand] emit accept fail', e?.message);
  }

  // — SMS 通知用户 —
  try {
    const detail = await getDemandDetailORM((r as any).userId || 0, id);
    if (detail?.contactPhone) {
      // @ts-ignore — sendTemplateSms 是可选模板方法，主接口没声明
      await smsGateway.sendTemplateSms?.({
        phone: detail.contactPhone,
        templateKey: 'new_design_quote',
        variables: {
          designerName: user?.nickname || '设计师',
          price: detail.budget || '面议',
        },
      });
    }
  } catch (e: any) {
    log('[design-demand] sms fail', e?.message);
  }

  // — 自动创建 chat 会话（买家 ↔ 接单设计师，关联 design_demand#id）—
  try {
    await ensureBusinessConv({
      refType: 'design_demand',
      refId: id,
      partyA: userId,                    // 设计师
      partyB: Number((r as any).userId),  // 买家
      event: 'designer_accept',
    });
  } catch (e: any) {
    log('[design-demand] chat-hook fail', e?.message, 'warn');
  }

  ok(res, { success: true });
});

// — 用户确认某设计师接单 → 自动生成 DesignOrder —
// 询价单前端选设计师后调此接口；后端创建设计订单，状态从 drafting 开始
// 🆕 Sprint 13：body 可选 bidderId → 买家从 bidders[] 里挑一个用其 quotePrice
router.post('/:id/confirm', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const demandId = Number(req.params.id);
  if (!demandId) return fail(res, 400, '非法的需求 ID');

  const { bidderId } = req.body || {};
  const targetBidderId = bidderId != null ? Number(bidderId) : null;

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return res.status(503).json({ code: 503 });

  try {
    const demand = await ds
      .getRepository(DesignDemandEntity)
      .findOne({ where: { id: demandId, userId } });
    if (!demand) return fail(res, 404, '设计需求不存在', 404);
    if (!demand.designerId) return fail(res, 422, '还没有设计师接单', 422);
    // 必须设计师已接单（quoting）才能确认
    if (demand.status !== 'quoting') {
      return fail(res, 422, `需求状态不允许确认（当前: ${demand.status}）`);
    }

    // 🆕 Sprint 13：如果买家指定了 bidderId → 用该 bidder 的 quotePrice
    let finalDesignerId = demand.designerId;
    let finalPrice = Number(demand.budgetMax ?? demand.budgetMin ?? 0);

    if (targetBidderId != null && Array.isArray(demand.bidders)) {
      const picked = demand.bidders.find(
        (b: any) => Number(b.designerId) === targetBidderId,
      );
      if (picked) {
        finalDesignerId = picked.designerId;
        finalPrice = Number(picked.quotePrice);
        // 标记 accepted
        picked.accepted = true;
        demand.designerId = picked.designerId;
      }
    }

    // 创建设计订单（初始状态 accepted = 起草中）
    const order = ds.getRepository(DesignOrderEntity).create({
      orderNo: genDesignOrderNo(),
      demandId: demand.id,
      buyerId: demand.userId,
      designerId: finalDesignerId,
      price: finalPrice,
      commissionRate: COMMISSION_RATES.design.base,
      status: 'accepted', // drafting 起点
      acceptedAt: new Date(), // ✅ 修复: 字段无默认值，必须显式赋值
    });
    await ds.getRepository(DesignOrderEntity).save(order);

    // 🆕 P2-2：子订单被接单后回写 MasterOrder（若有 masterOrderId，即购物车创建的设计子流程）
    if (order.masterOrderId) {
      await onSubOrderAcceptedORM(Number(order.masterOrderId), 'design', order.id, 'designing');
    }

    // 更新 demand 状态
    demand.status = 'confirmed';
    demand.statusText = '已生成设计订单';
    await ds.getRepository(DesignDemandEntity).save(demand);

    (eventBus.emit as any)('design_order_created', 'user', userId, {
      orderId: order.id, orderNo: order.orderNo, demandId: demand.id,
      designerId: finalDesignerId,
    });

    // — 自动创建 chat 会话（买家 ↔ 设计师，关联 design_demand#demand.id）—
    try {
      await ensureBusinessConv({
        refType: 'design_demand',
        refId: demand.id,
        partyA: userId,                    // 买家
        partyB: Number(finalDesignerId),   // 设计师
        event: 'designer_confirm',
      });
    } catch (e: any) {
      log('[design-demand] confirm chat-hook fail', e?.message, 'warn');
    }

    ok(res, {
      orderId: order.id,
      orderNo: order.orderNo,
      price: finalPrice,
    });
  } catch (e: any) {
    log(`[design-demand] confirm error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, msg: e.message });
  }
});

export default router;
