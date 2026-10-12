// ============================================================================
// 📦 Order Routes — 6 endpoint（全 TypeORM 事务）
// POST   /api/orders             创建订单（事务：扣库存 + 建单 + 清购物车）
// GET    /api/orders             订单列表（按状态过滤）
// GET    /api/orders/:id         订单详情
// POST   /api/orders/:id/pay     模拟支付
// POST   /api/orders/:id/cancel  取消订单
// POST   /api/orders/:id/confirm 确认收货
// ============================================================================
import { Router } from 'express';
import { adapters } from '../adapters';
import { requireAuth, ok, fail, badRequest, log } from '../middleware/auth';
import {
  createOrderORM, listOrdersORM, getOrderDetailORM, updateOrderStatusORM,
  createMasterOrderORM, linkSubOrdersToMasterORM, updateMasterOrderStatusORM,
  autoCreateDesignFlowORM, autoCreateInstallationFlowORM,
} from '../db-orm';
import { eventBus } from '../services/event-bus';
import { ensureBusinessConv } from '../services/chat-hook';
import { getDataSource } from '../db-manager';
import { db } from '../db';

const router = Router();

// — 🆕 P0 工具函数：提前查 cart + product + 地址 —
async function preFetchCartAndAddress(userId: number, itemIds?: number[]) {
  const ds = getDataSource();
  let cartItems: any[];
  if (ds && ds.isInitialized) {
    const { CartEntity, ProductEntity, AddressEntity } = await import('../entities');
    const cartRepo = ds.getRepository(CartEntity);
    const productRepo = ds.getRepository(ProductEntity);
    const addrRepo = ds.getRepository(AddressEntity);

    if (Array.isArray(itemIds) && itemIds.length > 0) {
      cartItems = await cartRepo
        .createQueryBuilder('c')
        .where('c.userId = :uid AND c.id IN (:...ids)', { uid: userId, ids: itemIds })
        .getMany();
    } else {
      cartItems = await cartRepo.find({ where: { userId, selected: 1 } });
    }

    // join product
    const itemsWithProduct: any[] = [];
    for (const c of cartItems) {
      const p = await productRepo.findOne({ where: { id: c.productId } });
      if (p) itemsWithProduct.push({ ...c, product: p });
    }

    // address
    let addr: any = null;
    addr = await addrRepo.findOne({ where: { userId, isDefault: 1 } });
    return { cartItems: itemsWithProduct, address: addr };
  }
  // 内存 fallback
  let carts = db.carts.filter((c: any) => c.userId === userId && c.selected === 1);
  if (Array.isArray(itemIds) && itemIds.length > 0) {
    const set = new Set(itemIds.map(Number));
    carts = db.carts.filter((c: any) => c.userId === userId && set.has(c.id));
  }
  const itemsWithProduct: any[] = [];
  for (const c of carts) {
    const p = db.products.find((p: any) => p.id === c.productId);
    if (p) itemsWithProduct.push({ ...c, product: p });
  }
  const addr = db.addresses.find((a: any) => a.userId === userId && a.isDefault === 1);
  return { cartItems: itemsWithProduct, address: addr || null };
}

// — 4.1 POST /orders —
router.post('/', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const {
    addressId, remark, itemIds, contractSignedAt, couponId,
    validationScore, validationIssues, buyerDesignFileUrl,
    needInstallation, // 🆕 P0：买家勾选了需要安装
  } = req.body || {};
  const discount = Number(req.body?.discount) || 0;

  try {
    // 🆕 P0：提前查 cart + product + 地址（为 MasterOrder 和 productType 分流提供数据）
    const { cartItems, address: preAddr } = await preFetchCartAndAddress(
      userId,
      Array.isArray(itemIds) ? itemIds.map(Number) : undefined,
    );

    if (cartItems.length === 0) {
      return badRequest(res, '购物车为空');
    }
    if (!preAddr) {
      return badRequest(res, '请先添加收货地址');
    }

    // 🆕 P0：查买家昵称（MasterOrder 需要）
    let buyerNickname = '用户';
    try {
      const ds = getDataSource();
      if (ds && ds.isInitialized) {
        const { UserEntity } = await import('../entities');
        const u = await ds.getRepository(UserEntity).findOne({ where: { id: userId } });
        buyerNickname = u?.nickname || u?.phone || `用户#${userId}`;
      } else {
        const u = db.users.find((u: any) => u.id === userId);
        buyerNickname = u?.nickname || u?.phone || `用户#${userId}`;
      }
    } catch {}

    // 🆕 P0：预估商品总额（productTotal）
    let productTotalEstimate = 0;
    for (const ci of cartItems) {
      const price = Number(ci.product?.price ?? ci.product?.productPrice ?? 0);
      const qty = Number(ci.quantity || 1);
      productTotalEstimate += price * qty;
    }

    // 🆕 P0：先创建 MasterOrder（productTotal 预填，designTotal/installTotal 后面按分支加）
    const addressSnapshot = {
      name: preAddr.name || '',
      phone: preAddr.phone || '',
      province: preAddr.province || '',
      city: preAddr.city || '',
      district: preAddr.district || '',
      detail: preAddr.detail || '',
    };
    const masterOrder = await createMasterOrderORM({
      buyerId: userId,
      buyerNickname,
      productTotal: Number(productTotalEstimate.toFixed(2)),
      address: addressSnapshot,
      remark: remark || undefined,
    });
    log(`order/create masterOrderNo=${masterOrder.orderNo}`);

    // 🆕 P0：按 productType 分流创建设计子流程（简化：看第一个 cartItem 的 productType）
    let designOrderId: number | undefined;
    let designTotal = 0;
    const firstProduct = cartItems[0]?.product;
    const productType: string = firstProduct?.productType || 'ready';
    const designFee = Number(firstProduct?.designFee || 0);
    const hasBuyerUpload = !!buyerDesignFileUrl; // 前端上传了设计稿 → 已有可用文件

    switch (productType) {
      case 'custom':
        // 需定制 + 买家没上传设计稿 → 自动走"找设计师"流程
        if (!hasBuyerUpload) {
          const demandMin = Math.max(100, Math.floor(productTotalEstimate * 0.3));
          const demandMax = Math.max(demandMin + 200, Math.floor(productTotalEstimate * 0.8));
          const flow = await autoCreateDesignFlowORM({
            userId,
            productId: firstProduct.id,
            productName: firstProduct.name,
            demandType: 'design',
            designCategory: (firstProduct as any)?.designCategory || undefined,
            budgetMin: demandMin,
            budgetMax: demandMax,
            price: designFee || demandMin,
            masterOrderId: masterOrder.id,
          });
          designOrderId = flow.designOrder.id;
          designTotal = Number((flow.designOrder.price || 0).toFixed(2));
          log(`order/create designFlow(custom) demandId=${flow.demand.id} designOrderId=${designOrderId}`);
        }
        break;

      case 'combo':
        // 商品+设计打包 → 自动走"改稿"流程（fix）
        {
          const budgetMin = designFee ? Math.max(100, Math.floor(designFee * 0.8)) : 100;
          const budgetMax = designFee ? Math.floor(designFee * 1.2) : 500;
          const flow = await autoCreateDesignFlowORM({
            userId,
            productId: firstProduct.id,
            productName: firstProduct.name,
            demandType: 'fix',
            designCategory: (firstProduct as any)?.designCategory || undefined,
            budgetMin,
            budgetMax,
            price: designFee || budgetMin,
            masterOrderId: masterOrder.id,
          });
          designOrderId = flow.designOrder.id;
          designTotal = Number((flow.designOrder.price || 0).toFixed(2));
          log(`order/create designFlow(combo) demandId=${flow.demand.id} designOrderId=${designOrderId}`);
        }
        break;

      case 'ready':
      default:
        // 纯卖 → 不需要设计流程
        break;
    }

    // 🆕 P0：安装子流程（买家勾选 needInstallation 或者商品 craftType 标记需要安装）
    let installationOrderId: number | undefined;
    let installTotal = 0;
    const needInstallFlag = !!needInstallation || (firstProduct as any)?.craftType === 'installation';
    if (needInstallFlag && cartItems.length > 0) {
      // 简化：对第一个 cartItem 创建一个安装子单（多商品场景后续升级为批量）
      const ci = cartItems[0];
      const installFlow = await autoCreateInstallationFlowORM({
        userId,
        productId: ci.productId,
        address: addressSnapshot,
        budgetMin: Math.max(100, Math.floor(productTotalEstimate * 0.1)),
        budgetMax: Math.max(200, Math.floor(productTotalEstimate * 0.3)),
        masterOrderId: masterOrder.id,
      });
      installationOrderId = installFlow.installationOrder.id;
      log(`order/create installationFlow demandId=${installFlow.demand.id} installOrderId=${installationOrderId}`);
    }

    // — 调用核心 createOrderORM（已加 masterOrderId 参数）—
    const result = await createOrderORM(userId, {
      addressId: addressId ? Number(addressId) : undefined,
      remark,
      itemIds: Array.isArray(itemIds) ? itemIds.map(Number) : undefined,
      // @ts-ignore — db-orm 类型签名没声明 contractSignedAt 但运行时支持
      contractSignedAt: contractSignedAt || undefined,
      // 🛠️ Week 5：优惠券
      couponId: couponId ? Number(couponId) : undefined,
      discount,
      // 📐 P1：买家合规校验
      validationScore: validationScore != null ? Number(validationScore) : undefined,
      validationIssues: Array.isArray(validationIssues) ? validationIssues : undefined,
      buyerDesignFileUrl: buyerDesignFileUrl || undefined,
      // 🏗️ P0：主订单关联
      masterOrderId: masterOrder.id,
    });
    const orders = result.orders || [result]; // 兼容旧返回

    // 🆕 P0：回写 MasterOrder 的 productOrderId + 最终金额汇总 + 状态
    const firstProductOrderId = orders.length > 0 ? Number(orders[0].id) : undefined;
    const productOrderActualTotal = orders.reduce((s: number, o: any) => s + Number(o.totalAmount || 0), 0);
    const totalAmountFinal = Number((productOrderActualTotal + designTotal + installTotal).toFixed(2));
    await linkSubOrdersToMasterORM(masterOrder.id, {
      productOrderId: firstProductOrderId,
      designOrderId,
      installationOrderId,
    });
    // 状态：有设计 → designing；有安装 → installing；否则 pending（等支付）
    let masterStatus: any = 'pending';
    if (designOrderId) masterStatus = 'designing';
    else if (installationOrderId) masterStatus = 'installing';
    await updateMasterOrderStatusORM(masterOrder.id, masterStatus);
    // 回写最终金额
    try {
      const ds2 = getDataSource();
      if (ds2 && ds2.isInitialized) {
        const { MasterOrderEntity } = await import('../entities');
        await ds2.getRepository(MasterOrderEntity).update(
          { id: masterOrder.id },
          {
            productTotal: Number(productOrderActualTotal.toFixed(2)),
            designTotal: Number(designTotal.toFixed(2)),
            installTotal: Number(installTotal.toFixed(2)),
            totalAmount: totalAmountFinal,
          },
        );
      } else {
        const mo = db.masterOrders.find((m: any) => m.id === masterOrder.id);
        if (mo) {
          mo.productTotal = Number(productOrderActualTotal.toFixed(2));
          mo.designTotal = Number(designTotal.toFixed(2));
          mo.installTotal = Number(installTotal.toFixed(2));
          mo.totalAmount = totalAmountFinal;
        }
      }
    } catch {}

    // — 以下保持原有逻辑（批量查 detail → adapters.orderToFront）—
    const frontOrders = [];
    for (const order of orders) {
      const detail = await getOrderDetailORM(userId, order.id);
      if (detail) {
        frontOrders.push(adapters.orderToFront(detail as any));
      }
    }
    log(
      `order/create userId=${userId} masterOrderNo=${masterOrder.orderNo} orderCount=${frontOrders.length} orderNos=${frontOrders.map((o) => o.orderNo).join(',')}`,
    );

    // 🆕 P0：返回加 masterOrderNo / masterOrderId / designOrderId / installationOrderId
    ok(res, {
      success: true,
      orderIds: frontOrders.map((o) => String(o.id)),
      orderNos: frontOrders.map((o) => o.orderNo),
      orders: frontOrders,
      count: frontOrders.length,
      masterOrderId: masterOrder.id,
      masterOrderNo: masterOrder.orderNo,
      masterStatus,
      designOrderId,
      installationOrderId,
    });
  } catch (e: any) {
    if (e.message === 'CART_EMPTY') {
      return badRequest(res, '购物车为空');
    }
    if (e.message === 'NO_ADDRESS') {
      return badRequest(res, '请先添加收货地址');
    }
    if (e.message === 'PRODUCT_OFFLINE') {
      return badRequest(res, '购物车商品已下架');
    }
    if (e.message?.startsWith('STOCK_INSUFFICIENT')) {
      return badRequest(res, `库存不足: ${e.message.split(':')[1]}`);
    }
    if (e.message?.startsWith('DELIVERY_NOT_COVERED')) {
      const area = e.message.split(':')[1];
      return badRequest(res, `商家暂不配送「${area}」，请更换地址或商品`);
    }
    log(`order/create error: ${e.message}`);
    badRequest(res, e.message || '创建订单失败');
  }
});

// — 4.2 GET /orders —
router.get('/', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { status } = req.query as any;
  const list = await listOrdersORM(userId, status);
  ok(res, { list: list.map((o) => adapters.orderToFront(o as any)), total: list.length });
});

// — 4.3 GET /orders/:id —
router.get('/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return fail(res, 400, '订单 ID 无效', 400);
  }
  const order = await getOrderDetailORM(userId, id);
  if (!order) {
    return fail(res, 404, '订单不存在', 404);
  }
  ok(res, adapters.orderToFront(order as any));
});

// — 4.4 POST /orders/:id/pay —
router.post('/:id/pay', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return fail(res, 400, '订单 ID 无效', 400);
  }
  const order = await getOrderDetailORM(userId, id);
  if (!order) {
    return fail(res, 404, '订单不存在', 404);
  }
  if (order.status !== 'pending') {
    return fail(res, 422, `订单状态为 ${order.status}，无法支付`, 422);
  }

  await updateOrderStatusORM(userId, id, 'paid', {
    payMethod: (req.body?.payMethod as string) || 'wechat',
    paidAt: new Date(),
  });

  // 🛠️ Week 5：支付成功 → 回写 UserCoupon.status = used
  try {
    const couponId = (order as any).couponId;
    if (couponId) {
      const { UserCouponEntity } = await import('../entities');
      const ds2 = getDataSource();
      if (ds2?.isInitialized) {
        await ds2
          .getRepository(UserCouponEntity)
          .update(couponId, { status: 'used', orderNo: order.orderNo });
        log(`order/pay couponId=${couponId} marked used orderNo=${order.orderNo}`);
      }
    }
  } catch (e: any) {
    log(`order/pay coupon 回写失败: ${e?.message || e}`, 'error');
  }

  log(`order/pay orderNo=${order.orderNo}`);
  // SSE 实时推给对应 vendor（新订单需要发货）
  if ((order as any).vendorId) {
    eventBus.emit('order_paid', 'vendor', (order as any).vendorId, {
      orderId: order.id,
      orderNo: order.orderNo,
      userId,
      amount: order.totalAmount,
    });

    // — 自动创建 chat 会话（买家 ↔ 供应商，关联 goods_order#order.id）—
    try {
      await ensureBusinessConv({
        refType: 'goods_order',
        refId: order.id,
        partyA: userId,                          // 买家
        partyB: Number((order as any).vendorId), // 供应商
        event: 'order_paid',
      });
    } catch (e: any) {
      log('[order] chat-hook fail', e?.message, 'warn');
    }
  }
  ok(res, { success: true });
});

// — 4.5 POST /orders/:id/cancel —
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return fail(res, 400, '订单 ID 无效', 400);
  }
  const order = await getOrderDetailORM(userId, id);
  if (!order) {
    return fail(res, 404, '订单不存在', 404);
  }
  if (!['pending', 'paid'].includes(order.status)) {
    return fail(res, 422, `订单状态为 ${order.status}，无法取消`, 422);
  }
  await updateOrderStatusORM(userId, id, 'cancelled', { cancelledAt: new Date() });

  // Week 6：cancel 时优惠券回滚（已使用的设回 unused）
  if (Number((order as any).couponId)) {
    try {
      const { UserCouponEntity } = await import('../entities');
      const ds2 = getDataSource();
      if (ds2?.isInitialized) {
        await ds2
          .getRepository(UserCouponEntity)
          .update((order as any).couponId, { status: 'unused', orderNo: null });
        log(`order/cancel couponId=${(order as any).couponId} rolled back`);
      }
    } catch (e: any) {
      log(`order/cancel coupon rollback failed: ${e?.message || e}`, 'warn');
    }
  }

  // SSE 实时推给对应 vendor（订单取消，需要回滚库存/处理）
  if ((order as any).vendorId) {
    eventBus.emit('order_cancelled', 'vendor', (order as any).vendorId, {
      orderId: order.id,
      orderNo: order.orderNo,
      userId,
    });
  }
  ok(res, { success: true });
});

// — 4.6 POST /orders/:id/confirm —
router.post('/:id/confirm', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return fail(res, 400, '订单 ID 无效', 400);
  }
  const order = await getOrderDetailORM(userId, id);
  if (!order) {
    return fail(res, 404, '订单不存在', 404);
  }
  if (order.status !== 'shipped') {
    return fail(res, 422, '只有已发货订单可确认收货', 422);
  }
  await updateOrderStatusORM(userId, id, 'completed', { completedAt: new Date() });

  // Week 6：商品订单 completed → 自动生成 SettleOrder（冻结 3 天，抽 10%）
  try {
    const vendorId = Number((order as any).vendorId);
    if (vendorId) {
      const { buildSettle, settle } = await import('../services/settle');
      const settleOrder = buildSettle(
        String(order.id),          // orderId
        'goods',                    // orderType
        vendorId,                   // providerId
        'vendor',                   // providerRole
        Number(order.totalAmount),  // 实付金额
      );
      await settle(settleOrder);
    }
  } catch (e: any) {
    log(`[order] goods settle error: ${e.message}`, 'warn');
    // 结算失败不阻断 confirm 主流程
  }

  // SSE 实时推给对应 vendor（订单完成，可以结算佣金）
  if ((order as any).vendorId) {
    eventBus.emit('order_completed', 'vendor', (order as any).vendorId, {
      orderId: order.id,
      orderNo: order.orderNo,
      userId,
      amount: order.totalAmount,
    });
  }
  ok(res, { success: true });
});

// ============================================================================
// 📦 Sprint 10 新增：物流轨迹查询（3 档 fallback）
// L1 mock：拼快递公司 URL + 生成模拟轨迹（立即可用）
// L2 免费 / L3 付费：接快递100 API（留 env 开关 FEATURE_EXPRESS_API）
// ============================================================================

/** GET /api/logistics/timeline?orderId=X — 物流轨迹 */
router.get('/logistics/timeline', requireAuth, async (req, res) => {
  const orderId = Number((req.query as any).orderId);
  if (!orderId) return badRequest(res, 'orderId 必填');

  const ds = getDataSource();
  if (!ds?.isInitialized) return serverError(res, '数据库未连接');

  try {
    const { OrderEntity, ExpressCompanyEntity } = await import('../entities');
    const repo = ds.getRepository(OrderEntity);
    const order = await repo.findOne({ where: { id: orderId, userId: (req as any).userId } });
    if (!order) return notFound(res, '订单不存在');
    if (!order.shippedAt) return ok(res, { shipped: false, timeline: [], msg: '订单尚未发货' });

    // L0：有缓存轨迹就直接返回
    if (order.logisticsTrail) {
      try {
        const cached = JSON.parse(order.logisticsTrail);
        if (Array.isArray(cached) && cached.length) {
          return ok(res, { shipped: true, source: 'cache', timeline: cached });
        }
      } catch {}
    }

    // 查快递公司（优先 expressCompanyId，其次按 shippingCompany 名字模糊匹配）
    let ec = null;
    if (order.expressCompanyId) {
      ec = await ds.getRepository(ExpressCompanyEntity).findOne({ where: { id: order.expressCompanyId } });
    } else if (order.shippingCompany) {
      ec = await ds.getRepository(ExpressCompanyEntity)
        .createQueryBuilder('e').where('e.name = :n', { n: order.shippingCompany }).getOne();
    }

    // L2/L3：如果配置了 API key，接快递100 真实轨迹
    const expressApiEnabled = process.env.FEATURE_EXPRESS_API === 'true';
    const express100Key = process.env.EXPRESS100_KEY;
    if (expressApiEnabled && express100Key && ec && order.shippingNo) {
      try {
        // 快递100 code 映射（Entity.code → 快递100 的 com 码）
        const codeMap: Record<string, string> = {
          SF: 'sf',
          YT: 'yto',
          ZTO: 'zto',
          ST: 'sto',
          STO: 'sto',
          JD: 'jd',
          JD_EXPRESS: 'jd',
          EMS: 'ems',
          YD: 'yunda',
          YUNDA: 'yunda',
          FREEZE: 'freeze',
        };
        const com = codeMap[ec.code] || ec.code.toLowerCase();

        const resp = await fetch(
          process.env.EXPRESS100_URL || 'https://poll.kuaidi100.com/poll/query.do',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `com=${encodeURIComponent(com)}&num=${encodeURIComponent(order.shippingNo)}&key=${express100Key}`,
            signal: AbortSignal.timeout(5000), // 5s 超时保护
          },
        );

        if (!resp.ok) throw new Error(`快递100 HTTP ${resp.status}`);
        const data: any = await resp.json();

        if (data.message === 'ok' && Array.isArray(data.data) && data.data.length) {
          const trail = data.data.map((d: any) => ({
            time: new Date(d.time).toISOString(),
            status: d.context?.includes('签收')
              ? '已签收'
              : d.context?.includes('已发货') || d.context?.includes('揽收')
                ? '已发货'
                : '运输中',
            desc: d.context || '',
          }));
          // 缓存到 logisticsTrail，下次 L0 直接命中
          await repo.update(order.id, { logisticsTrail: JSON.stringify(trail) });
          return ok(res, { shipped: true, source: 'api', timeline: trail });
        }
        // data.message !== 'ok'（单号不存在/未揽收/无轨迹）→ fallthrough 到 L1 mock
      } catch (e: any) {
        log(`[logistics] express100 failed: ${e.message}`, 'warn');
        // fallthrough 到 L1 mock
      }
    }

    // L1 mock fallback：生成 3-5 条模拟轨迹 + 拼追踪 URL
    const companyName = ec?.name || order.shippingCompany || '物流';
    const trackUrl = ec?.defaultTrackingUrl
      ? ec.defaultTrackingUrl.replace('{no}', order.shippingNo || '').replace('{nu}', order.shippingNo || '')
      : null;

    const trail = [
      { time: order.shippedAt!.toISOString(), status: '已发货', desc: `${companyName} 已揽收 ${order.shippingNo || ''}` },
      { time: new Date(Date.now() - 6 * 3600_000).toISOString(), status: '运输中', desc: '包裹已到达本地中转站' },
      { time: new Date(Date.now() - 12 * 3600_000).toISOString(), status: '运输中', desc: '包裹已发出，预计 48 小时内到达' },
    ];
    await repo.update(orderId, { logisticsTrail: JSON.stringify(trail) });

    ok(res, {
      shipped: true, source: 'mock',
      company: companyName, trackingNo: order.shippingNo,
      trackingUrl: trackUrl,
      timeline: trail,
    });
  } catch (e: any) {
    log(`[logistics] error: ${e.message}`, 'error');
    serverError(res, e.message);
  }
});

export default router;
