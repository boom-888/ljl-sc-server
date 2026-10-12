// ============================================================================
// 🛒 Vendor Routes — 供应商工作台（16 endpoint）
// 已实现: products列表 / orders列表 / orders详情 / ship发货 / profile
// 新增:   products详情/新增/更新/上下架/删除 / profile更新
//         refunds列表/详情/处理 / earnings收入 / withdraw提现
// ============================================================================
import { Router, Response } from 'express';
import { requireAuth, requireVendor, ok, fail, badRequest, notFound, serverError, log, AuthedRequest } from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { db } from '../db';
import { UserEntity } from '../entities';

const router = Router();

// ============================================================================
// 🛠️ Week 1 补：POST /api/vendor/register — 商家入驻（抄 designer register 同构）
// ============================================================================

router.post('/register', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const body = req.body || {};
  const {
    shopName, phone,
    factoryName, contactName, contactPhone,
    province, city, district, detail,
    serviceLng, serviceLat,
    serviceAreas,
    categories,
    businessLicenseUrl, idCardFrontUrl, idCardBackUrl, factoryPhotos,
  } = body;

  // — 基础校验 —
  const finalShopName = (factoryName || shopName || '').trim();
  const finalPhone = (contactPhone || phone || '').trim();
  if (!finalShopName) return badRequest(res, '工厂名称必填');
  if (!finalPhone || finalPhone.length !== 11) return badRequest(res, '请输入正确的 11 位手机号');

  // — 营业执照强制 —
  if (!businessLicenseUrl || !String(businessLicenseUrl).trim()) {
    return badRequest(res, '营业执照必须上传');
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return res.status(503).json({ code: 503, msg: '数据库不可用' });

  try {
    const userRepo = ds.getRepository(UserEntity);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user) return fail(res, 404, '账号不存在', 404);
    if (user.role === 'pending_vendor') return fail(res, 400, '已提交入驻申请，请等待 admin 审核');
    if (user.role === 'vendor') return fail(res, 400, '你已是供应商');
    if (['admin', 'installer', 'designer'].includes(user.role)) {
      return fail(res, 400, '当前角色不允许申请供应商入驻');
    }

    // — 组装 serviceAreas：没传则用 [当前省市区] 兜底 —
    let finalAreas: any[] | null = null;
    if (Array.isArray(serviceAreas) && serviceAreas.length > 0) {
      finalAreas = serviceAreas;
    } else if (province && city) {
      finalAreas = [{ province, city, district: district || null }];
    }

    // — 组装办公地址 —
    const officeAddress = [province, city, district, detail].filter(Boolean).join(' ');

    // — 更新用户 —
    const updateData: any = {
      nickname: finalShopName,
      phone: finalPhone,
      role: 'pending_vendor',
      contactName: (contactName || '').trim() || null,
      officeAddress: officeAddress || null,
      serviceAreas: finalAreas,
      serviceLng: serviceLng != null ? Number(serviceLng) : null,
      serviceLat: serviceLat != null ? Number(serviceLat) : null,
      categories: Array.isArray(categories) ? categories : null,
      businessLicenseUrl: String(businessLicenseUrl).trim(),
      idCardFrontUrl: idCardFrontUrl ? String(idCardFrontUrl).trim() : null,
      idCardBackUrl: idCardBackUrl ? String(idCardBackUrl).trim() : null,
      factoryPhotos: Array.isArray(factoryPhotos) ? factoryPhotos : null,
    };
    await userRepo.update(userId, updateData);

    log(`[Vendor] register userId=${userId} shop=${finalShopName} role→pending_vendor areas=${JSON.stringify(finalAreas)}`);
    ok(res, {
      id: String(userId),
      role: 'pending_vendor',
      verified: 'pending',
      message: '入驻申请已提交，待 admin 审核',
    });
  } catch (e: any) {
    log(`[Vendor] register error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
});

// — 商品列表：只返回 vendorId = 当前用户的商品 —
router.get('/products', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const keyword = String(req.query.keyword || '').trim();
  const status = String(req.query.status || ''); // on / off / draft
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { list: [], total: 0, page, size });

  try {
    const { ProductEntity } = await import('../entities/index');
    const repo = ds.getRepository(ProductEntity);
    const qb = repo.createQueryBuilder('p').where('p.vendorId = :vid', { vid: userId });

    // DB tinyint: 1=on(在售), 0=off(下架/draft)
    if (status === 'on' || status === '1') qb.andWhere('p.status = 1');
    else if (status === 'off' || status === '0' || status === 'draft') qb.andWhere('p.status = 0');

    if (keyword) qb.andWhere('(p.name LIKE :kw OR p.description LIKE :kw)', { kw: `%${keyword}%` });

    qb.orderBy('p.id', 'DESC').skip((page - 1) * size).take(size);
    const [list, total] = await qb.getManyAndCount();

    ok(res, {
      list: list.map((p: any) => ({
        id: String(p.id),
        name: p.name,
        price: p.price,
        stock: p.stock ?? 0,
        soldCount: p.soldCount ?? 0,
        status: p.status === 1 ? 'on' : 'off',
        cover: p.cover || p.images?.[0] || '',
        categoryId: p.categoryId,
        createdAt: p.createdAt,
      })),
      total, page, size,
    });
  } catch (e: any) {
    log(`[vendor/products] error: ${e.message}`, 'error');
    serverError(res, '商品列表加载失败');
  }
});

// — 订单列表：只返回 type=goods + vendorId=当前用户的订单 —
router.get('/orders', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const status = String(req.query.status || ''); // pending / paid / shipped / completed / cancelled
  const keyword = String(req.query.keyword || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { list: [], total: 0, page, size });

  try {
    const { OrderEntity } = await import('../entities/index');
    const repo = ds.getRepository(OrderEntity);
    const qb = repo.createQueryBuilder('o').where('o.vendorId = :vid', { vid: userId });

    if (status) qb.andWhere('o.status = :status', { status });
    if (keyword) {
      qb.andWhere('(o.orderNo LIKE :kw OR o.receiverName LIKE :kw)', { kw: `%${keyword}%` });
    }

    qb.orderBy('o.id', 'DESC').skip((page - 1) * size).take(size);
    const [list, total] = await qb.getManyAndCount();

    const statusMap: Record<string, string> = {
      pending: '待付款', paid: '待发货', shipped: '待收货', completed: '已完成',
      cancelled: '已取消', refunding: '退款中', refunded: '已退款',
    };

    ok(res, {
      list: list.map((o: any) => ({
        id: String(o.id),
        orderNo: o.orderNo || 'PO' + o.id,
        status: o.status,
        statusText: statusMap[o.status] || o.status,
        totalAmount: o.totalAmount != null ? Number(o.totalAmount) : 0,
        paidAmount: o.paidAmount != null ? Number(o.paidAmount) : 0,
        receiverName: o.receiverName || '',
        receiverPhone: o.receiverPhone || '',
        address: o.receiverAddress || o.address || '',
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        shippedAt: o.shippedAt,
      })),
      total, page, size,
    });
  } catch (e: any) {
    log(`[vendor/orders] error: ${e.message}`, 'error');
    serverError(res, '订单列表加载失败');
  }
});

// — 订单详情：含 orderItems —
router.get('/orders/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);

  if (!id) return badRequest(res, '订单 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, null);

  try {
    const { OrderEntity, OrderItemEntity } = await import('../entities/index');
    const order = await ds.getRepository(OrderEntity).findOne({ where: { id, vendorId: userId } });
    if (!order) return fail(res, 404, '订单不存在', 404);

    const items = await ds.getRepository(OrderItemEntity).find({ where: { orderId: id } });

    ok(res, {
      ...order,
      id: String(order.id),
      items: items.map((it: any) => ({
        id: String(it.id),
        productId: String(it.productId),
        productName: it.productName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        subtotal: it.subtotal,
        cover: it.cover || '',
      })),
    });
  } catch (e: any) {
    log(`[vendor/orders/:id] error: ${e.message}`, 'error');
    serverError(res, '订单详情加载失败');
  }
});

// — 📦 发货页信息：返回订单 + 已填物流字段（ship 页预填）—
router.get('/ship-info/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '订单 ID 无效');
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, null);
  try {
    const repo = ds.getRepository(OrderEntity);
    const o = await repo.findOne({ where: { id, vendorId: userId } });
    if (!o) return notFound(res, '订单不存在或无权限');
    ok(res, {
      orderId: String(o.id),
      orderNo: o.orderNo,
      receiverName: o.receiverName,
      receiverPhone: o.receiverPhone,
      receiverAddress: o.receiverAddress,
      shippingCompany: o.shippingCompany,
      shippingNo: o.shippingNo,
      shippingType: o.shippingType,
      trackingUrl: o.trackingUrl,
      status: o.status,
    });
  } catch (e: any) {
    log(`[vendor/ship-info] error: ${e.message}`, 'error');
    serverError(res, '发货信息加载失败');
  }
});

// — 🛒 发货：填物流号 → status=shipped —
router.post('/orders/:id/ship', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { shippingType, shippingCompany, shippingNo, trackingUrl, remark, expressCompanyId } = req.body as any;

  if (!id) return badRequest(res, '订单 ID 无效');
  if (!shippingNo) return badRequest(res, '请填写物流单号');
  if (!shippingCompany && !expressCompanyId) return badRequest(res, '请选择或填写物流公司');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), status: 'shipped', shippedAt: new Date().toISOString() }, '发货成功');

  try {
    const { OrderEntity, ExpressCompanyEntity } = await import('../entities/index');
    const repo = ds.getRepository(OrderEntity);
    const order = await repo.findOne({ where: { id, vendorId: userId } });
    if (!order) return fail(res, 404, '订单不存在', 404);

    if (order.status !== 'paid') {
      return fail(res, 422, `当前订单状态 ${order.status} 不可发货（需 paid）`, 422);
    }

    // 🛠️ Sprint 10：expressCompanyId 优先 → 自动填 shippingCompany + 生成 trackingUrl
    let finalCompany = shippingCompany;
    let finalTrackingUrl = trackingUrl || null;
    if (expressCompanyId) {
      const ec = await ds.getRepository(ExpressCompanyEntity).findOne({
        where: { id: Number(expressCompanyId), enabled: 1 },
      });
      if (!ec) return badRequest(res, '所选快递公司不存在或已停用');
      finalCompany = ec.name; // 覆盖前端传入的自由文本
      if (!finalTrackingUrl && ec.defaultTrackingUrl) {
        finalTrackingUrl = ec.defaultTrackingUrl.replace('{no}', shippingNo).replace('{nu}', shippingNo);
      }
    }

    await repo.update(id, {
      status: 'shipped',
      shippedAt: new Date(),
      shippingType: shippingType || 'express',
      shippingCompany: finalCompany,
      shippingNo,
      trackingUrl: finalTrackingUrl,
      expressCompanyId: expressCompanyId ? Number(expressCompanyId) : null,
    });

    // 审计日志
    try {
      const { AuditLogEntity } = await import('../entities/index');
      await ds.getRepository(AuditLogEntity).save({
        action: 'vendor.order.ship',
        targetType: 'goods',
        targetId: String(id),
        userId,
        detail: { shippingCompany, shippingNo },
      });
    } catch {}

    log(`[vendor] 订单 ${order.orderNo || id} 已发货 ${shippingCompany}#${shippingNo}`);
    ok(res, { id: String(id), status: 'shipped', shippedAt: new Date().toISOString() }, '发货成功');
  } catch (e: any) {
    log(`[vendor/ship] error: ${e.message}`, 'error');
    serverError(res, '发货失败');
  }
});

// — 标记已完成：shipped → completed —
router.post('/orders/:id/complete', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '订单 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), status: 'completed', completedAt: new Date().toISOString() }, '已标记完成');

  try {
    const { OrderEntity } = await import('../entities/index');
    const repo = ds.getRepository(OrderEntity);
    const order = await repo.findOne({ where: { id, vendorId: userId } });
    if (!order) return fail(res, 404, '订单不存在', 404);

    if (order.status !== 'shipped') {
      return fail(res, 422, `当前订单状态 ${order.status} 不可标记完成（需 shipped）`, 422);
    }

    await repo.update(id, {
      status: 'completed',
      completedAt: new Date(),
    });

    log(`[vendor] 订单 ${order.orderNo || id} 已标记完成`);
    ok(res, { id: String(id), status: 'completed', completedAt: new Date().toISOString() }, '已标记完成');
  } catch (e: any) {
    log(`[vendor/complete] error: ${e.message}`, 'error');
    serverError(res, '操作失败');
  }
});

// — 商家资料 —
router.get('/profile', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) {
    const u = (db as any).users?.find?.((x: any) => String(x.id) === String(userId));
    return ok(res, {
      id: String(userId),
      nickname: u?.nickname || '',
      phone: u?.phone || '',
      avatar: u?.avatar || '',
      status: u?.status ?? 1,
      serviceAreas: u?.serviceAreas || [],
      serviceLng: u?.serviceLng ?? null,
      serviceLat: u?.serviceLat ?? null,
      stats: { totalOrders: 0, pendingOrders: 0, totalProducts: 0 },
    });
  }

  try {
    const { UserEntity } = await import('../entities/index');
    const user = await ds.getRepository(UserEntity).findOne({ where: { id: userId, role: 'vendor' } });
    if (!user) return fail(res, 404, '商家账号不存在', 404);

    // 统计数据
    const { OrderEntity, ProductEntity } = await import('../entities/index');
    const ordersRepo = ds.getRepository(OrderEntity);
    const productsRepo = ds.getRepository(ProductEntity);

    const [totalOrders, totalProducts] = await Promise.all([
      ordersRepo.createQueryBuilder('o').where('o.vendorId = :vid', { vid: userId }).getCount(),
      productsRepo.createQueryBuilder('p').where('p.vendorId = :vid', { vid: userId }).getCount(),
    ]);

    const pendingOrders = await ordersRepo
      .createQueryBuilder('o')
      .where('o.vendorId = :vid AND o.status = :st', { vid: userId, st: 'paid' })
      .getCount();

    ok(res, {
      id: String(user.id),
      nickname: user.nickname,
      phone: user.phone,
      avatar: (user as any).avatar || '',
      status: user.status,
      serviceAreas: (user as any).serviceAreas || [],
      serviceLng: (user as any).serviceLng ?? null,
      serviceLat: (user as any).serviceLat ?? null,
      stats: {
        totalOrders,
        pendingOrders,
        totalProducts,
      },
    });
  } catch (e: any) {
    log(`[vendor/profile] error: ${e.message}`, 'error');
    serverError(res, '资料加载失败');
  }
});

// ============================================================================
// 🆕 商品详情 — GET /products/:id
// ============================================================================
router.get('/products/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '商品 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, null);

  try {
    const { ProductEntity } = await import('../entities/index');
    const p = await ds.getRepository(ProductEntity).findOne({ where: { id, vendorId: userId } });
    if (!p) return fail(res, 404, '商品不存在', 404);
    ok(res, {
      id: String(p.id), name: p.name, cover: p.cover || '', images: p.images || [],
      price: p.price, stock: p.stock ?? 0, sales: p.sales ?? 0, status: p.status === 1 ? 'on' : 'off',
      categoryId: p.categoryId, tags: p.tags || [], detail: p.detail || '',
      createdAt: p.createdAt, updatedAt: p.updatedAt,
    });
  } catch (e: any) {
    log(`[vendor/products/:id] ${e.message}`, 'error');
    serverError(res, '商品详情加载失败');
  }
});

// ============================================================================
// 🆕 新增商品 — POST /products
// ============================================================================
router.post('/products', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { name, cover, images, price, stock, categoryId, tags, detail, status,
    productType, designFee, printFee, needsDesignUpload,
    materials, crafts, comboPrices } = req.body as any;

  if (!name?.trim()) return badRequest(res, '商品名称必填');
  if (price == null || price < 0) return badRequest(res, '价格无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: '' }, '商品已创建');

  try {
    const { ProductEntity } = await import('../entities/index');
    const repo = ds.getRepository(ProductEntity);
    const validType = productType === 'custom' || productType === 'combo' ? productType : 'ready';
    const product = repo.create({
      name: name.trim(), cover: cover || '', images: images || [],
      price: Number(price), stock: stock ?? 0,
      categoryId: categoryId || null, tags: tags || [],
      detail: detail || '', status: (status === 'on' ? 1 : 0),
      vendorId: userId, createdBy: userId,
      sales: 0, rating: 0,
      productType: validType,
      designFee: validType === 'combo' ? (designFee != null ? Number(designFee) : null) : null,
      printFee: printFee != null ? Number(printFee) : null,
      needsDesignUpload: validType === 'custom'
        ? 1
        : (needsDesignUpload ? 1 : 0),
      // 多材质/多工艺/组合定价（全可选，数组要校验格式）
      materials: Array.isArray(materials) && materials.every((m: any) => m.key && m.name && typeof m.surcharge === 'number')
        ? materials : null,
      crafts: Array.isArray(crafts) && crafts.every((c: any) => c.key && c.name && typeof c.surcharge === 'number')
        ? crafts : null,
      comboPrices: Array.isArray(comboPrices) && comboPrices.every((c: any) => c.material && c.craft && typeof c.price === 'number')
        ? comboPrices : null,
    });
    const saved = await repo.save(product);
    ok(res, { id: String(saved.id) }, '商品已创建');
  } catch (e: any) {
    log(`[vendor/products POST] ${e.message}`, 'error');
    serverError(res, '创建商品失败');
  }
});

// ============================================================================
// 🆕 更新商品 — PUT /products/:id
// ============================================================================
router.put('/products/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '商品 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id) }, '商品已更新');

  try {
    const { ProductEntity } = await import('../entities/index');
    const repo = ds.getRepository(ProductEntity);
    const p = await repo.findOne({ where: { id, vendorId: userId } });
    if (!p) return fail(res, 404, '商品不存在', 404);

    const upd: any = {};
    const f = req.body as any;
    if (f.name !== undefined) upd.name = f.name.trim();
    if (f.cover !== undefined) upd.cover = f.cover;
    if (f.images !== undefined) upd.images = f.images;
    if (f.price !== undefined) upd.price = Number(f.price);
    if (f.stock !== undefined) upd.stock = Number(f.stock);
    if (f.categoryId !== undefined) upd.categoryId = f.categoryId || null;
    if (f.tags !== undefined) upd.tags = f.tags;
    if (f.detail !== undefined) upd.detail = f.detail;
    // 🆕 productType / designFee / printFee / needsDesignUpload
    if (f.productType !== undefined) {
      upd.productType = f.productType === 'custom' || f.productType === 'combo' ? f.productType : 'ready';
      // 切换到 combo 才允许写 designFee；非 combo 清掉
      if (upd.productType !== 'combo') {
        upd.designFee = null;
      }
    }
    if (f.designFee !== undefined) upd.designFee = f.designFee != null ? Number(f.designFee) : null;
    if (f.printFee !== undefined) upd.printFee = f.printFee != null ? Number(f.printFee) : null;
    if (f.needsDesignUpload !== undefined) {
      // custom 强制 needsDesignUpload=1，其他类型按请求值
      const effectiveType = upd.productType || p.productType;
      upd.needsDesignUpload = effectiveType === 'custom' ? 1 : (f.needsDesignUpload ? 1 : 0);
    }
    if (upd.name === '') return badRequest(res, '商品名称不能为空');

    await repo.update(id, upd);
    ok(res, { id: String(id) }, '商品已更新');
  } catch (e: any) {
    log(`[vendor/products PUT] ${e.message}`, 'error');
    serverError(res, '更新商品失败');
  }
});

// ============================================================================
// 🆕 商品上架/下架 — PATCH /products/:id/toggle
// ============================================================================
router.patch('/products/:id/toggle', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { status } = req.body as any; // 'on' | 'off'

  if (!id) return badRequest(res, '商品 ID 无效');
  if (!['on', 'off'].includes(status)) return badRequest(res, 'status 必须是 on 或 off');
  const statusNum = status === 'on' ? 1 : 0;

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), status }, status === 'on' ? '已上架' : '已下架');

  try {
    const { ProductEntity } = await import('../entities/index');
    const repo = ds.getRepository(ProductEntity);
    const p = await repo.findOne({ where: { id, vendorId: userId } });
    if (!p) return fail(res, 404, '商品不存在', 404);

    await repo.update(id, { status: statusNum });
    log(`[vendor] 商品 ${id} status → ${status}`);
    ok(res, { id: String(id), status }, status === 'on' ? '已上架' : '已下架');
  } catch (e: any) {
    log(`[vendor/toggle] ${e.message}`, 'error');
    serverError(res, '操作失败');
  }
});

// ============================================================================
// 🆕 删除商品 — DELETE /products/:id
// ============================================================================
router.delete('/products/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '商品 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id) }, '商品已删除');

  try {
    const { ProductEntity } = await import('../entities/index');
    const repo = ds.getRepository(ProductEntity);
    const p = await repo.findOne({ where: { id, vendorId: userId } });
    if (!p) return fail(res, 404, '商品不存在', 404);
    // 已有订单的商品不允许硬删除，改为下架
    if ((p.sales ?? 0) > 0) {
      await repo.update(id, { status: 'off' });
      return ok(res, { id: String(id) }, '已有销量的商品已下架（不可删除）');
    }
    await repo.delete(id);
    ok(res, { id: String(id) }, '商品已删除');
  } catch (e: any) {
    log(`[vendor/products DELETE] ${e.message}`, 'error');
    serverError(res, '删除失败');
  }
});

// ============================================================================
// 🆕 更新资料 — PUT /profile
// 支持 nickname / avatar / phone / serviceAreas / serviceLng / serviceLat
// ============================================================================
router.put('/profile', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { nickname, avatar, phone, serviceAreas, serviceLng, serviceLat } = req.body as any;

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(userId) }, '资料已更新');

  try {
    const { UserEntity } = await import('../entities/index');
    const repo = ds.getRepository(UserEntity);
    const u = await repo.findOne({ where: { id: userId, role: 'vendor' } });
    if (!u) return fail(res, 404, '商家账号不存在', 404);

    const upd: any = {};
    if (nickname !== undefined) upd.nickname = nickname;
    if (avatar !== undefined) upd.avatar = avatar;
    if (phone !== undefined) upd.phone = phone;

    // 🆕 serviceAreas：白名单校验 — province / city 必填，district 可选
    if (serviceAreas !== undefined) {
      if (!Array.isArray(serviceAreas)) return badRequest(res, 'serviceAreas 必须是数组');
      const cleaned: Array<{ province: string; city: string; district?: string | null }> = [];
      for (const item of serviceAreas) {
        if (!item || typeof item !== 'object') continue;
        const province = String(item.province || '').trim();
        const city = String(item.city || '').trim();
        if (!province || !city) return badRequest(res, 'serviceAreas 每项 province 和 city 必填');
        const district = item.district == null || item.district === '' ? null : String(item.district).trim();
        cleaned.push({ province, city, district });
      }
      upd.serviceAreas = cleaned.length > 0 ? cleaned : null;
    }

    if (serviceLng !== undefined) {
      const v = serviceLng == null ? null : Number(serviceLng);
      upd.serviceLng = v === null || Number.isFinite(v) ? v : null;
    }
    if (serviceLat !== undefined) {
      const v = serviceLat == null ? null : Number(serviceLat);
      upd.serviceLat = v === null || Number.isFinite(v) ? v : null;
    }

    await repo.update(userId, upd);
    ok(res, { id: String(userId) }, '资料已更新');
  } catch (e: any) {
    log(`[vendor/profile PUT] ${e.message}`, 'error');
    serverError(res, '更新失败');
  }
});

// ============================================================================
// 🆕 售后列表 — GET /refunds
// 通过 refunds.orderId → orders.vendorId 关联当前商家
// ============================================================================
router.get('/refunds', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const status = String(req.query.status || '');
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { list: [], total: 0, page, size });

  try {
    const { RefundEntity, OrderEntity } = await import('../entities/index');
    // 先查当前商家的所有 orderId
    const orderRepo = ds.getRepository(OrderEntity);
    const myOrderIds = (await orderRepo
      .createQueryBuilder('o')
      .select('o.id')
      .where('o.vendorId = :vid', { vid: userId })
      .getMany()).map((o: any) => o.id);

    if (myOrderIds.length === 0) return ok(res, { list: [], total: 0, page, size });

    const repo = ds.getRepository(RefundEntity);
    const qb = repo.createQueryBuilder('r').where('r.orderId IN (:...oids)', { oids: myOrderIds });
    if (status) qb.andWhere('r.status = :st', { st: status });

    qb.orderBy('r.id', 'DESC').skip((page - 1) * size).take(size);
    const [list, total] = await qb.getManyAndCount();

    const map: Record<string, string> = { pending: '待处理', approved: '已同意', rejected: '已拒绝', completed: '已完成' };
    ok(res, {
      list: list.map((r: any) => ({
        id: String(r.id), orderId: String(r.orderId), orderNo: r.orderNo,
        reasonType: r.reasonType, reason: r.reason,
        amount: Number(r.amount), status: r.status, statusText: map[r.status] || r.status,
        createdAt: r.createdAt,
      })),
      total, page, size,
    });
  } catch (e: any) {
    log(`[vendor/refunds] ${e.message}`, 'error');
    serverError(res, '售后列表加载失败');
  }
});

// ============================================================================
// 🆕 售后详情 — GET /refunds/:id
// ============================================================================
router.get('/refunds/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '售后 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, null);

  try {
    const { RefundEntity, OrderEntity, OrderItemEntity } = await import('../entities/index');
    const r = await ds.getRepository(RefundEntity).findOne({ where: { id } });
    if (!r) return fail(res, 404, '售后单不存在', 404);

    const order = await ds.getRepository(OrderEntity).findOne({ where: { id: r.orderId, vendorId: userId } });
    if (!order) return fail(res, 403, '无权查看该售后', 403);

    const items = await ds.getRepository(OrderItemEntity).find({ where: { orderId: r.orderId } });
    ok(res, {
      id: String(r.id), orderId: String(r.orderId), orderNo: r.orderNo,
      reasonType: r.reasonType, reason: r.reason, description: r.description,
      images: r.images || [], amount: Number(r.amount),
      status: r.status, reviewRemark: r.reviewRemark,
      order: {
        id: String(order.id), orderNo: order.orderNo,
        receiverName: order.receiverName, receiverPhone: order.receiverPhone,
        receiverAddress: order.receiverAddress,
        items: items.map((it: any) => ({
          id: String(it.id), productName: it.productName,
          quantity: it.quantity, price: it.price,
        })),
      },
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    });
  } catch (e: any) {
    log(`[vendor/refunds/:id] ${e.message}`, 'error');
    serverError(res, '售后详情加载失败');
  }
});

// ============================================================================
// 🆕 售后处理 — POST /refunds/:id/reply
// action: 'approve' | 'reject'
// ============================================================================
router.post('/refunds/:id/reply', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { action, remark } = req.body as any;

  if (!id) return badRequest(res, '售后 ID 无效');
  if (!['approve', 'reject'].includes(action)) return badRequest(res, 'action 必须是 approve 或 reject');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), status: action === 'approve' ? 'approved' : 'rejected' }, action === 'approve' ? '已同意退款' : '已拒绝');

  try {
    const { RefundEntity, OrderEntity } = await import('../entities/index');
    const refundRepo = ds.getRepository(RefundEntity);
    const orderRepo = ds.getRepository(OrderEntity);

    const r = await refundRepo.findOne({ where: { id } });
    if (!r) return fail(res, 404, '售后单不存在', 404);

    const order = await orderRepo.findOne({ where: { id: r.orderId, vendorId: userId } });
    if (!order) return fail(res, 403, '无权处理该售后', 403);
    if (r.status !== 'pending') return fail(res, 422, `当前状态 ${r.status} 不可处理`, 422);

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    await refundRepo.update(id, {
      status: newStatus,
      reviewedBy: userId,
      reviewRemark: remark || null,
      updatedAt: new Date(),
    });

    // 审计日志
    try {
      const { AuditLogEntity } = await import('../entities/index');
      await ds.getRepository(AuditLogEntity).save({
        action: `vendor.refund.${action}`, targetType: 'refund', targetId: String(id), userId,
      });
    } catch {}

    log(`[vendor] 售后 ${id} → ${newStatus}`);
    ok(res, { id: String(id), status: newStatus }, action === 'approve' ? '已同意退款' : '已拒绝');
  } catch (e: any) {
    log(`[vendor/refund reply] ${e.message}`, 'error');
    serverError(res, '处理失败');
  }
});

// ============================================================================
// 🆕 收入统计 — GET /earnings
// settle_orders (providerRole=vendor, providerId=me) + money_flows
// ============================================================================
router.get('/earnings', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { summary: {}, list: [] });

  try {
    const { SettleOrderEntity, MoneyFlowEntity } = await import('../entities/index');
    const settleRepo = ds.getRepository(SettleOrderEntity);
    const flowRepo = ds.getRepository(MoneyFlowEntity);

    // 可用 / 冻结中 / 累计
    const [available, frozen, totalEarned, totalCommission, totalWithdrawn] = await Promise.all([
      settleRepo.createQueryBuilder('s').where('s.providerId=:vid AND s.providerRole=:role AND s.status=:st',
        { vid: userId, role: 'vendor', st: 'available' }).select('SUM(s.providerGet)', 'sum').getRawOne(),
      settleRepo.createQueryBuilder('s').where('s.providerId=:vid AND s.providerRole=:role AND s.status IN (:...sts)',
        { vid: userId, role: 'vendor', sts: ['frozen', 'released'] }).select('SUM(s.providerGet)', 'sum').getRawOne(),
      settleRepo.createQueryBuilder('s').where('s.providerId=:vid AND s.providerRole=:role',
        { vid: userId, role: 'vendor' }).select('SUM(s.providerGet)', 'sum').getRawOne(),
      settleRepo.createQueryBuilder('s').where('s.providerId=:vid AND s.providerRole=:role',
        { vid: userId, role: 'vendor' }).select('SUM(s.commission)', 'sum').getRawOne(),
      flowRepo.createQueryBuilder('m').where('m.fromUserId=:vid AND m.type=:t', { vid: userId, t: 'withdraw' }).select('SUM(m.amount)', 'sum').getRawOne(),
    ]);

    // 本月收入
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEarned = await settleRepo
      .createQueryBuilder('s')
      .where('s.providerId=:vid AND s.providerRole=:role AND s.status != :st AND s.createdAt >= :from',
        { vid: userId, role: 'vendor', st: 'frozen', from: firstDay })
      .select('SUM(s.providerGet)', 'sum')
      .getRawOne();

    // 流水（recent 30 条）
    const flows = await flowRepo
      .createQueryBuilder('m')
      .where('m.toUserId=:vid OR m.fromUserId=:vid', { vid: userId })
      .orderBy('m.id', 'DESC').limit(30).getMany();

    const summary = {
      available: Number(available?.sum || 0),
      frozen: Number(frozen?.sum || 0),
      totalEarned: Number(totalEarned?.sum || 0),
      totalCommission: Number(totalCommission?.sum || 0),
      totalWithdrawn: Number(totalWithdrawn?.sum || 0),
      monthEarned: Number(monthEarned?.sum || 0),
    };

    ok(res, {
      summary,
      list: flows.map((f: any) => ({
        id: String(f.id), flowNo: f.flowNo, type: f.type,
        amount: Number(f.amount), remark: f.remark, status: f.status,
        createdAt: f.createdAt,
      })),
    });
  } catch (e: any) {
    log(`[vendor/earnings] ${e.message}`, 'error');
    serverError(res, '收入加载失败');
  }
});

// ============================================================================
// 🆕 提现申请 — POST /withdraw
// ============================================================================
router.post('/withdraw', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { amount, bankName, cardNo, fee } = req.body as any;

  const amt = Number(amount);
  if (!amt || amt <= 0) return badRequest(res, '提现金额无效');
  if (!bankName?.trim() || !cardNo?.trim()) return badRequest(res, '请填写银行卡信息');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: '', amount: amt, fee: amt * 0.006, actualAmount: amt * 0.994, status: 'pending' }, '提现申请已提交，等待审核');

  try {
    // 1. 查可用余额
    const { SettleOrderEntity, WithdrawRequestEntity, MoneyFlowEntity } = await import('../entities/index');
    const availableRow = await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .where('s.providerId=:vid AND s.providerRole=:role AND s.status=:st',
        { vid: userId, role: 'vendor', st: 'available' })
      .select('SUM(s.providerGet)', 'sum').getRawOne();
    const available = Number(availableRow?.sum || 0);
    if (amt > available) return fail(res, 422, `可用余额不足（可提现 ${available.toFixed(2)}）`, 422);

    // 2. 创建提现单
    const feeAmt = Number(fee || (amt * 0.006).toFixed(2)); // 默认 0.6% 手续费
    const actual = Number((amt - feeAmt).toFixed(2));
    const withdrawNo = 'WD' + Date.now() + Math.floor(Math.random() * 1000);

    const wRepo = ds.getRepository(WithdrawRequestEntity);
    const saved = await wRepo.save({
      withdrawNo, vendorId: userId, providerRole: 'vendor',
      amount: amt, fee: feeAmt, actualAmount: actual,
      bankName: bankName.trim(), cardNo: cardNo.trim(), status: 'pending',
    });

    // 3. 冻结对应结算单（status → withdrawn）
    await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .update(SettleOrderEntity)
      .set({ status: 'withdrawn' })
      .where('s.providerId=:vid AND s.providerRole=:role AND s.status=:st',
        { vid: userId, role: 'vendor', st: 'available' })
      .execute();

    // 4. 记流水
    const flowNo = 'FL' + Date.now() + Math.floor(Math.random() * 1000);
    await ds.getRepository(MoneyFlowEntity).save({
      flowNo, type: 'withdraw', refNo: withdrawNo,
      fromUserId: userId, fromRole: 'vendor', toUserId: 0, toRole: 'platform',
      amount: amt, status: 'pending', remark: `提现到 ${bankName} ${cardNo.slice(-4)}`,
    });

    log(`[vendor] 提现 ${withdrawNo} 金额 ${amt} 已提交`);
    ok(res, {
      id: String(saved.id), withdrawNo, amount: amt, fee: feeAmt, actualAmount: actual,
      status: 'pending',
    }, '提现申请已提交，等待审核');
  } catch (e: any) {
    log(`[vendor/withdraw] ${e.message}`, 'error');
    serverError(res, '提现失败');
  }
});


// GET /vendor/withdraw-info — 提现页信息（当前可用 + 最近提现记录）
router.get('/withdraw-info', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const ds = getDataSource();
  if (!ds) return ok(res, { available: 0, recent: [] });
  try {
    const { SettleOrderEntity, WithdrawRequestEntity } = await import('../entities/index');
    // 可用余额：settle_orders 里 providerId=me providerRole=vendor status=available
    const settleRepo = ds.getRepository(SettleOrderEntity);
    const availRow = await settleRepo
      .createQueryBuilder('s')
      .where('s.providerId=:vid AND s.providerRole=:role AND s.status=:st',
        { vid: req.userId, role: 'vendor', st: 'available' })
      .select('SUM(s.providerGet)', 'sum').getRawOne();
    const available = Number(availRow?.sum || 0);

    // 最近提现记录（从 WithdrawRequestEntity.vendorId 查）
    const wrRepo = ds.getRepository(WithdrawRequestEntity);
    const recent = await wrRepo.find({
      where: { vendorId: req.userId },
      order: { createdAt: 'DESC' },
      take: 5,
    });

    ok(res, {
      available,
      recent: recent.map(w => ({
        id: (w as any).id, withdrawNo: (w as any).withdrawNo,
        amount: (w as any).amount, bankName: (w as any).bankName,
        status: (w as any).status, createdAt: (w as any).createdAt,
      })),
    });
  } catch (e: any) {
    log(`[vendor/withdraw-info] error: ${e.message}`, 'error');
    serverError(res, '提现信息加载失败');
  }
});

// ============================================================================
// Sprint 10 — Vendor 配送区域只读（查看 admin 给我配了什么区域）
// ============================================================================

/** GET /api/vendor/delivery-areas — 供应商查看自己的已开通县区权限（只读，admin 开通）*/
router.get('/delivery-areas', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, []);
  try {
    const { VendorZonePermissionEntity } = await import('../entities');
    const repo = ds.getRepository(VendorZonePermissionEntity);
    const list = await repo.createQueryBuilder('d')
      .where('d.vendorId = :v AND d.enabled = 1 AND d.status = :s', { v: req.userId, s: 'active' })
      .orderBy('d.province', 'ASC').addOrderBy('d.city', 'ASC')
      .getMany();
    ok(res, list);
  } catch (e: any) { fail(res, e.message, 500, 500); }
});

// ============================================================================
// Sprint 10 — bank-cards 三项后端：列表 / 新增 / 解绑 / 设默认
// ============================================================================

// — GET /bank-cards — 列表 —
router.get('/bank-cards', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { list: [] });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const list = await repo.find({ where: { userId: req.userId!, role: 'vendor', status: 'active' }, order: { isDefault: 'DESC', createdAt: 'DESC' } });
    ok(res, { list });
  } catch (e: any) { log(`[Vendor] bank-cards error: ${e.message}`, 'error'); serverError(res, '查询失败'); }
});

// — POST /bank-cards — 新增 —
router.post('/bank-cards', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const { bankName, cardNo, accountName, branchName } = req.body || {};
  if (!bankName?.trim() || !cardNo?.trim() || !accountName?.trim()) return badRequest(res, '银行/卡号/持卡人必填');
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { success: true, card: null });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const count = await repo.count({ where: { userId: req.userId!, role: 'vendor', status: 'active' } });
    if (count >= 5) return fail(res, 400, '最多绑定 5 张银行卡');
    // 脱敏：**** + 后 4 位
    const masked = '****' + cardNo.trim().slice(-4);
    // 如果是第一张，自动设默认
    let isDefault = count === 0 ? 1 : 0;
    // 如果新增时选了默认，先清掉旧默认
    if (req.body.isDefault) {
      await repo.createQueryBuilder().update().set({ isDefault: 0 }).where('userId=:uid AND role=:role AND isDefault=1', { uid: req.userId!, role: 'vendor' }).execute();
      isDefault = 1;
    }
    const entity = repo.create({
      userId: req.userId!, role: 'vendor',
      bankName: bankName.trim(), cardNo: cardNo.trim(), cardNoMasked: masked,
      accountName: accountName.trim(), branchName: branchName?.trim() || '',
      isDefault, status: 'active',
    });
    const saved = await repo.save(entity);
    ok(res, { success: true, card: saved });
  } catch (e: any) { log(`[Vendor] bank-cards add error: ${e.message}`, 'error'); serverError(res, '绑卡失败'); }
});

// — DELETE /bank-cards/:id — 解绑 —
router.delete('/bank-cards/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { success: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const card = await repo.findOne({ where: { id, userId: req.userId!, role: 'vendor' } });
    if (!card) return notFound(res, '银行卡不存在');
    card.status = 'disabled';
    await repo.save(card);
    ok(res, { success: true });
  } catch (e: any) { log(`[Vendor] bank-cards delete error: ${e.message}`, 'error'); serverError(res, '解绑失败'); }
});

// — POST /bank-cards/:id/default — 设为默认 —
router.post('/bank-cards/:id/default', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { success: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const card = await repo.findOne({ where: { id, userId: req.userId!, role: 'vendor', status: 'active' } });
    if (!card) return notFound(res, '银行卡不存在');
    await repo.createQueryBuilder().update().set({ isDefault: 0 }).where('userId=:uid AND role=:role', { uid: req.userId!, role: 'vendor' }).execute();
    card.isDefault = 1;
    await repo.save(card);
    ok(res, { success: true });
  } catch (e: any) { log(`[Vendor] bank-cards default error: ${e.message}`, 'error'); serverError(res, '设置失败'); }
});

// — POST /bank-cards/:id — 更新 branchName / accountName / isDefault（cardNo 安全字段不允许改）—
router.post('/bank-cards/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { branchName, accountName, isDefault } = req.body || {};
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { success: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const role = 'vendor';
    const card = await repo.findOne({ where: { id, userId: req.userId!, role, status: 'active' } });
    if (!card) return notFound(res, '银行卡不存在');
    if (accountName !== undefined) card.accountName = String(accountName).trim();
    if (branchName !== undefined) card.branchName = String(branchName).trim();
    if (isDefault) {
      await repo.createQueryBuilder().update().set({ isDefault: 0 }).where('userId=:uid AND role=:role', { uid: req.userId!, role }).execute();
      card.isDefault = 1;
    }
    await repo.save(card);
    ok(res, { success: true });
  } catch (e: any) { log(`[vendor] bank-cards update error: ${e.message}`, 'error'); serverError(res, '更新失败'); }
});

// ============================================================================
// 🆕 GET /api/vendor/dashboard — 工作台聚合数据
// ============================================================================
router.get('/dashboard', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, {
    todayOrders: 0, pendingShipment: 0, totalSalesAmount: 0,
    totalProducts: 0, soldOutProducts: 0,
    withdrawInfo: { available: 0, frozen: 0, totalWithdrawn: 0 },
    pendingDisputes: 0,
    todos: [
      { type: 'pending_shipment', count: 0, label: '待发货' },
      { type: 'pending_refund', count: 0, label: '待处理退款' },
      { type: 'pending_dispute', count: 0, label: '待响应纠纷' },
    ],
  });

  try {
    const { OrderEntity, ProductEntity, SettleOrderEntity, MoneyFlowEntity, DisputeEntity, RefundEntity } = await import('../entities');
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // — 订单聚合 —
    const orderRepo = ds.getRepository(OrderEntity);
    const [todayOrders, pendingShipment, totalSalesAmountRaw] = await Promise.all([
      orderRepo.createQueryBuilder('o')
        .where('o.vendorId = :vid AND o.createdAt >= :from', { vid: userId, from: startOfToday })
        .getCount().catch(() => 0),
      orderRepo.createQueryBuilder('o')
        .where('o.vendorId = :vid AND o.status = :st', { vid: userId, st: 'paid' })
        .getCount().catch(() => 0),
      orderRepo.createQueryBuilder('o')
        .where('o.vendorId = :vid AND o.status = :st', { vid: userId, st: 'completed' })
        .select('COALESCE(SUM(o.totalAmount), 0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
    ]);

    // — 商品聚合 —
    const productRepo = ds.getRepository(ProductEntity);
    const [totalProducts, soldOutProducts] = await Promise.all([
      productRepo.createQueryBuilder('p')
        .where('p.vendorId = :vid AND p.status = 1', { vid: userId }).getCount().catch(() => 0),
      productRepo.createQueryBuilder('p')
        .where('p.vendorId = :vid AND p.status = 1 AND p.stock = 0', { vid: userId }).getCount().catch(() => 0),
    ]);

    // — 财务聚合（复用 withdraw-info 逻辑 + 累计已提现）—
    const settleRepo = ds.getRepository(SettleOrderEntity);
    const flowRepo = ds.getRepository(MoneyFlowEntity);
    const [availableRow, frozenRow, totalWithdrawnRow] = await Promise.all([
      settleRepo.createQueryBuilder('s')
        .where('s.providerId=:vid AND s.providerRole=:role AND s.status=:st', { vid: userId, role: 'vendor', st: 'available' })
        .select('COALESCE(SUM(s.providerGet),0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
      settleRepo.createQueryBuilder('s')
        .where('s.providerId=:vid AND s.providerRole=:role AND s.status IN (:...sts)', { vid: userId, role: 'vendor', sts: ['frozen', 'released'] })
        .select('COALESCE(SUM(s.providerGet),0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
      flowRepo.createQueryBuilder('m')
        .where('m.fromUserId=:vid AND m.type=:t', { vid: userId, t: 'withdraw' })
        .select('COALESCE(SUM(m.amount),0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
    ]);
    const withdrawInfo = {
      available: Number(availableRow?.sum || 0),
      frozen: Number(frozenRow?.sum || 0),
      totalWithdrawn: Number(totalWithdrawnRow?.sum || 0),
    };

    // — 纠纷 —
    const disputeRepo = ds.getRepository(DisputeEntity);
    const pendingDisputes = await disputeRepo.createQueryBuilder('d')
      .where('d.providerId = :vid AND d.providerRole = :role AND d.status IN (:...sts)',
        { vid: userId, role: 'vendor', sts: ['pending', 'processing'] })
      .getCount().catch(() => 0);

    // — 待处理退款（通过 refunds.orderId → orders.vendorId 关联）—
    let pendingRefundCount = 0;
    try {
      const orderIds = (await orderRepo.createQueryBuilder('o').select('o.id')
        .where('o.vendorId = :vid', { vid: userId }).getMany()).map((o: any) => o.id);
      if (orderIds.length > 0) {
        pendingRefundCount = await ds.getRepository(RefundEntity).createQueryBuilder('r')
          .where('r.orderId IN (:...oids) AND r.status = :st', { oids: orderIds, st: 'pending' })
          .getCount().catch(() => 0);
      }
    } catch { pendingRefundCount = 0; }

    ok(res, {
      todayOrders: Number(todayOrders || 0),
      pendingShipment: Number(pendingShipment || 0),
      totalSalesAmount: Number(totalSalesAmountRaw?.sum || 0),
      totalProducts: Number(totalProducts || 0),
      soldOutProducts: Number(soldOutProducts || 0),
      withdrawInfo,
      pendingDisputes: Number(pendingDisputes || 0),
      todos: [
        { type: 'pending_shipment', count: Number(pendingShipment || 0), label: '待发货' },
        { type: 'pending_refund', count: Number(pendingRefundCount || 0), label: '待处理退款' },
        { type: 'pending_dispute', count: Number(pendingDisputes || 0), label: '待响应纠纷' },
      ],
    });
  } catch (e: any) {
    log(`[vendor/dashboard] error: ${e.message}`, 'error');
    serverError(res, '仪表盘数据加载失败');
  }
});

// ============================================================================
// 🆕 Sprint 11 — Vendor 配送区域 CRUD（vendor 自管，区别于 admin 管控的只读 VendorZonePermission）
// ============================================================================

// — GET /delivery-areas — 列出当前 vendor 的自管配送区域 —
router.get('/delivery-areas-manage', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const ds = getDataSource();
  if (ds?.isInitialized) {
    try {
      const { VendorDeliveryAreaEntity } = await import('../entities');
      const repo = ds.getRepository(VendorDeliveryAreaEntity);
      const list = await repo.find({
        where: { vendorId: req.userId! },
        order: { province: 'ASC', city: 'ASC', district: 'ASC' },
      });
      ok(res, list);
    } catch (e: any) {
      log(`[vendor/delivery-areas-manage] GET error: ${e.message}`, 'error');
      serverError(res, '配送区域加载失败');
    }
  } else {
    // — 内存 fallback —
    const areas = db.vendorDeliveryAreas ?? [];
    const list = areas
      .filter((a: any) => Number(a.vendorId) === Number(req.userId))
      .sort((a: any, b: any) => {
        const p = String(a.province).localeCompare(String(b.province));
        if (p !== 0) return p;
        const c = String(a.city).localeCompare(String(b.city));
        if (c !== 0) return c;
        return String(a.district ?? '').localeCompare(String(b.district ?? ''));
      });
    ok(res, list);
  }
});

// — POST /delivery-areas — 新增配送区域 —
router.post('/delivery-areas', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { province, city, district, radiusKm } = req.body as any;

  if (!province?.trim()) return badRequest(res, 'province 必填');
  if (!city?.trim()) return badRequest(res, 'city 必填');

  const ds = getDataSource();
  if (ds?.isInitialized) {
    try {
      const { VendorDeliveryAreaEntity } = await import('../entities');
      const repo = ds.getRepository(VendorDeliveryAreaEntity);

      // — 去重：同 vendor + province + city + district 组合已存在则拒绝 —
      const exist = await repo.findOne({
        where: {
          vendorId: userId,
          province: String(province).trim(),
          city: String(city).trim(),
          district: district ? String(district).trim() : null,
        },
      });
      if (exist) {
        return fail(res, 400, '该配送区域已存在，请勿重复添加', 400);
      }

      const entity = repo.create({
        vendorId: userId,
        province: String(province).trim(),
        city: String(city).trim(),
        district: district ? String(district).trim() : null,
        radiusKm: radiusKm != null ? Number(radiusKm) : null,
        enabled: 1,
      });
      const saved = await repo.save(entity);
      log(`[vendor] 新增配送区域 id=${saved.id} ${saved.province}/${saved.city}/${saved.district || '全市'}`);
      ok(res, { id: Number(saved.id) }, '配送区域已添加');
    } catch (e: any) {
      log(`[vendor/delivery-areas] POST error: ${e.message}`, 'error');
      serverError(res, '添加配送区域失败');
    }
  } else {
    // — 内存 fallback：去重 + push —
    const areas: any[] = db.vendorDeliveryAreas ?? [];
    if (!db.vendorDeliveryAreas) {
      (db as any).vendorDeliveryAreas = areas;
    }
    const p = String(province).trim();
    const c = String(city).trim();
    const d = district ? String(district).trim() : null;
    const exist = areas.find(
      (a: any) =>
        Number(a.vendorId) === Number(userId) &&
        String(a.province) === p &&
        String(a.city) === c &&
        (a.district ?? null) === d,
    );
    if (exist) {
      return fail(res, 400, '该配送区域已存在，请勿重复添加', 400);
    }
    const now = new Date();
    const newItem = {
      id: Date.now(),
      vendorId: userId,
      province: p,
      city: c,
      district: d,
      radiusKm: radiusKm != null ? Number(radiusKm) : null,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    };
    areas.push(newItem);
    log(`[vendor:mem] 新增配送区域 id=${newItem.id} ${p}/${c}/${d || '全市'}`);
    ok(res, { id: newItem.id }, '配送区域已添加');
  }
});

// — PUT /delivery-areas/:id — 编辑配送区域 —
router.put('/delivery-areas/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '配送区域 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id }, '配送区域已更新');

  try {
    const { VendorDeliveryAreaEntity } = await import('../entities');
    const repo = ds.getRepository(VendorDeliveryAreaEntity);
    const area = await repo.findOne({ where: { id, vendorId: userId } });
    if (!area) return notFound(res, '配送区域不存在');

    const upd: any = {};
    const f = req.body as any;
    if (f.province !== undefined) {
      const v = String(f.province).trim();
      if (!v) return badRequest(res, 'province 不能为空');
      upd.province = v;
    }
    if (f.city !== undefined) {
      const v = String(f.city).trim();
      if (!v) return badRequest(res, 'city 不能为空');
      upd.city = v;
    }
    if (f.district !== undefined) {
      upd.district = f.district ? String(f.district).trim() : null;
    }
    if (f.radiusKm !== undefined) {
      upd.radiusKm = f.radiusKm == null ? null : Number(f.radiusKm);
    }
    if (f.enabled !== undefined) {
      upd.enabled = f.enabled ? 1 : 0;
    }

    // — 编辑时也要检查重复（排除自己）—
    const exist = await repo.findOne({
      where: {
        vendorId: userId,
        province: upd.province ?? area.province,
        city: upd.city ?? area.city,
        district: upd.district !== undefined ? upd.district : area.district,
      },
    });
    if (exist && Number(exist.id) !== id) {
      return fail(res, 400, '修改后该配送区域与已有记录重复', 400);
    }

    await repo.update(id, upd);
    log(`[vendor] 更新配送区域 id=${id}`);
    ok(res, { id }, '配送区域已更新');
  } catch (e: any) {
    log(`[vendor/delivery-areas/:id] PUT error: ${e.message}`, 'error');
    serverError(res, '更新配送区域失败');
  }
});

// — DELETE /delivery-areas/:id — 删除配送区域 —
router.delete('/delivery-areas/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '配送区域 ID 无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id }, '配送区域已删除');

  try {
    const { VendorDeliveryAreaEntity } = await import('../entities');
    const repo = ds.getRepository(VendorDeliveryAreaEntity);
    const area = await repo.findOne({ where: { id, vendorId: userId } });
    if (!area) return notFound(res, '配送区域不存在');
    await repo.delete(id);
    log(`[vendor] 删除配送区域 id=${id} ${area.province}/${area.city}`);
    ok(res, { id }, '配送区域已删除');
  } catch (e: any) {
    log(`[vendor/delivery-areas/:id] DELETE error: ${e.message}`, 'error');
    serverError(res, '删除配送区域失败');
  }
});

// ============================================================================
// 🆕 PATCH /products/:id/stock — 库存调整（delta 相对增减 / stock 绝对设置）
// ============================================================================
router.patch('/products/:id/stock', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '商品 ID 无效');

  const { delta, stock } = req.body as any;

  // — 参数互斥校验：只能传 delta 或 stock 其中一个 —
  const hasDelta = delta != null;
  const hasStock = stock != null;
  if (!hasDelta && !hasStock) return badRequest(res, '必须传 delta 或 stock 其中之一');
  if (hasDelta && hasStock) return badRequest(res, 'delta 和 stock 不能同时传');

  const ds = getDataSource();
  if (ds?.isInitialized) {
    try {
      const { ProductEntity } = await import('../entities');
      const repo = ds.getRepository(ProductEntity);
      const p = await repo.findOne({ where: { id, vendorId: userId } });
      if (!p) return notFound(res, '商品不存在');

      let newStock: number;

      if (hasDelta) {
        // — 相对增减 —
        const deltaNum = Number(delta);
        if (!Number.isFinite(deltaNum)) return badRequest(res, 'delta 必须是有效数字');
        newStock = Math.max(0, (Number(p.stock) || 0) + deltaNum);
      } else {
        // — 绝对设置 —
        const stockNum = Number(stock);
        if (!Number.isFinite(stockNum) || stockNum < 0) {
          return badRequest(res, 'stock 必须是非负有效数字');
        }
        newStock = stockNum;
      }

      await repo.update(id, { stock: newStock });
      log(
        `[vendor] 商品 ${id} 库存调整 → ${newStock} (${hasDelta ? `delta=${delta}` : `stock=${stock}`})`,
      );

      // — 审计日志 —
      try {
        const { AuditLogEntity } = await import('../entities');
        await ds.getRepository(AuditLogEntity).save({
          action: 'vendor.product.stock',
          targetType: 'product',
          targetId: String(id),
          userId,
          detail: {
            oldStock: Number(p.stock) || 0,
            newStock,
            mode: hasDelta ? 'delta' : 'absolute',
            value: hasDelta ? Number(delta) : Number(stock),
          },
        });
      } catch {}

      ok(
        res,
        { id: String(id), stock: newStock },
        hasDelta
          ? `库存 ${Number(delta) >= 0 ? '增加' : '减少'} ${Math.abs(Number(delta))}，当前 ${newStock}`
          : `库存已设置为 ${newStock}`,
      );
    } catch (e: any) {
      log(`[vendor/products/:id/stock] error: ${e.message}`, 'error');
      serverError(res, '库存调整失败');
    }
  } else {
    // — 内存 fallback —
    const products: any[] = db.products ?? [];
    const p = products.find((item: any) => Number(item.id) === id && Number(item.vendorId) === Number(userId));
    if (!p) return notFound(res, '商品不存在');

    let newStock: number;
    if (hasDelta) {
      const deltaNum = Number(delta);
      if (!Number.isFinite(deltaNum)) return badRequest(res, 'delta 必须是有效数字');
      newStock = Math.max(0, (Number(p.stock) || 0) + deltaNum);
    } else {
      const stockNum = Number(stock);
      if (!Number.isFinite(stockNum) || stockNum < 0) {
        return badRequest(res, 'stock 必须是非负有效数字');
      }
      newStock = stockNum;
    }
    p.stock = newStock;
    log(
      `[vendor:mem] 商品 ${id} 库存调整 → ${newStock} (${hasDelta ? `delta=${delta}` : `stock=${stock}`})`,
    );
    ok(
      res,
      { id: String(id), stock: newStock },
      hasDelta
        ? `库存 ${Number(delta) >= 0 ? '增加' : '减少'} ${Math.abs(Number(delta))}，当前 ${newStock}`
        : `库存已设置为 ${newStock}`,
    );
  }
});

// ============================================================================
// 🆕 Sprint 14 — Vendor 纠纷响应入口（providerRole=vendor, providerId=me）
// GET    /api/vendor/disputes            — 分页列表 + tab 过滤 + 聚合统计
// GET    /api/vendor/disputes/:id        — 详情（带 timeline/messages）
// POST   /api/vendor/disputes/:id/respond — 角色方补充资料/解释
// ============================================================================

const VENDOR_DISPUTE_ROLE = 'vendor' as const;

function mapDisputeTimeline(d: any) {
  // 合并原始纠纷信息 + messages 时间线（messages 按 createdAt 升序）
  const base: any = {
    id: d.id,
    orderId: d.orderId,
    orderType: d.orderType,
    settleOrderId: d.settleOrderId ?? null,
    userId: d.userId,
    providerId: d.providerId ?? null,
    providerRole: d.providerRole ?? null,
    reasonType: d.reasonType,
    reason: d.reason,
    description: d.description ?? null,
    images: d.images || [],
    claimAmount: Number(d.claimAmount || 0),
    status: d.status,
    action: d.action ?? null,
    refundAmount: Number(d.refundAmount || 0),
    reviewRemark: d.reviewRemark ?? null,
    reviewedBy: d.reviewedBy ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
  const msgs: any[] = Array.isArray(d.messages) ? [...d.messages] : [];
  // 把纠纷本身的 reason 也塞进时间线开头（作为 buyer 发起）
  msgs.unshift({
    role: 'buyer',
    userId: d.userId,
    message: d.reason,
    createdAt: d.createdAt,
  });
  msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  base.timeline = msgs;
  return base;
}

router.get('/disputes', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const tab = String(req.query.tab || 'all'); // all | pending | processing | resolved
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));

  const ds = getDataSource();
  const role = VENDOR_DISPUTE_ROLE;

  try {
    if (ds?.isInitialized) {
      const { DisputeEntity } = await import('../entities');
      const repo = ds.getRepository(DisputeEntity);
      const qb = repo.createQueryBuilder('d')
        .where('d.providerId = :vid AND d.providerRole = :role', { vid: userId, role });

      if (tab === 'pending' || tab === 'processing' || tab === 'resolved') {
        qb.andWhere('d.status = :st', { st: tab });
      }

      qb.orderBy('d.id', 'DESC').skip((page - 1) * size).take(size);
      const [rows, total] = await qb.getManyAndCount();

      // 聚合统计
      const pendingCount = await repo.createQueryBuilder('d')
        .where('d.providerId = :vid AND d.providerRole = :role AND d.status IN (:...sts)',
          { vid: userId, role, sts: ['pending', 'processing'] })
        .getCount().catch(() => 0);

      ok(res, {
        list: rows.map(mapDisputeTimeline),
        total, page, size,
        summary: {
          pendingCount: Number(pendingCount || 0),
          totalCount: Number(total),
        },
      });
    } else {
      // — 内存 fallback —
      const list: any[] = (db.disputes || [])
        .filter((d: any) => Number(d.providerId) === userId && d.providerRole === role);

      const filtered = tab === 'pending' || tab === 'processing' || tab === 'resolved'
        ? list.filter(d => d.status === tab)
        : list;
      filtered.sort((a, b) => Number(b.id) - Number(a.id));

      const total = filtered.length;
      const rows = filtered.slice((page - 1) * size, page * size);
      const pendingCount = list.filter(d => ['pending', 'processing'].includes(d.status)).length;

      ok(res, {
        list: rows.map(mapDisputeTimeline),
        total, page, size,
        summary: {
          pendingCount,
          totalCount: list.length,
        },
      });
    }
  } catch (e: any) {
    log(`[vendor/disputes] error: ${e.message}`, 'error');
    serverError(res, '纠纷列表加载失败');
  }
});

router.get('/disputes/:id', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '纠纷 ID 无效');

  const ds = getDataSource();
  const role = VENDOR_DISPUTE_ROLE;

  try {
    let d: any = null;
    if (ds?.isInitialized) {
      const { DisputeEntity } = await import('../entities');
      d = await ds.getRepository(DisputeEntity).findOne({
        where: { id, providerId: userId, providerRole: role },
      });
    } else {
      d = (db.disputes || []).find((x: any) => Number(x.id) === id
        && Number(x.providerId) === userId && x.providerRole === role);
    }
    if (!d) return notFound(res, '纠纷不存在或无权查看');

    ok(res, mapDisputeTimeline(d));
  } catch (e: any) {
    log(`[vendor/disputes/:id] error: ${e.message}`, 'error');
    serverError(res, '纠纷详情加载失败');
  }
});

router.post('/disputes/:id/respond', requireAuth, requireVendor, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { message } = req.body || {};
  if (!id) return badRequest(res, '纠纷 ID 无效');
  if (!message || String(message).trim().length < 3) {
    return badRequest(res, '响应内容至少 3 个字');
  }

  const ds = getDataSource();
  const role = VENDOR_DISPUTE_ROLE;

  try {
    let d: any = null;
    if (ds?.isInitialized) {
      const { DisputeEntity } = await import('../entities');
      const repo = ds.getRepository(DisputeEntity);
      d = await repo.findOne({ where: { id, providerId: userId, providerRole: role } });
      if (!d) return notFound(res, '纠纷不存在或无权操作');

      // 追加 messages + pending → processing
      const msgs: any[] = Array.isArray(d.messages) ? [...d.messages] : [];
      msgs.push({
        role: 'provider',
        userId,
        message: String(message).trim(),
        createdAt: new Date().toISOString(),
      });
      d.messages = msgs;
      if (d.status === 'pending') d.status = 'processing';
      d.updatedAt = new Date();
      const saved = await repo.save(d);

      // 审计日志
      try {
        const { AuditLogEntity } = await import('../entities');
        await ds.getRepository(AuditLogEntity).save({
          action: 'vendor.dispute.respond',
          targetType: 'dispute',
          targetId: String(id),
          userId,
          detail: { message: String(message).trim() },
        });
      } catch {}

      log(`[vendor] dispute ${id} responded by userId=${userId}`);
      ok(res, { id: saved.id, status: saved.status }, '响应已提交');
    } else {
      const list: any[] = db.disputes || [];
      d = list.find((x: any) => Number(x.id) === id
        && Number(x.providerId) === userId && x.providerRole === role);
      if (!d) return notFound(res, '纠纷不存在或无权操作');

      const msgs: any[] = Array.isArray(d.messages) ? [...d.messages] : [];
      msgs.push({
        role: 'provider',
        userId,
        message: String(message).trim(),
        createdAt: new Date().toISOString(),
      });
      d.messages = msgs;
      if (d.status === 'pending') d.status = 'processing';
      d.updatedAt = new Date().toISOString();
      log(`[vendor:mem] dispute ${id} responded by userId=${userId}`);
      ok(res, { id: d.id, status: d.status }, '响应已提交');
    }
  } catch (e: any) {
    log(`[vendor/disputes respond] error: ${e.message}`, 'error');
    serverError(res, '响应提交失败');
  }
});

export default router;
