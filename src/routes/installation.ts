// ============================================================================
// 📦 Installation Routes — 用户端安装需求（Phase 1 + Phase 2）
// Phase 1（6）：publish / :id / :id/expand / accept / my
// Phase 2（4）：quote/:id/messages GET/POST + installer/:id 师傅主页
// ============================================================================
import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { getDataSource } from '../db-manager';
import {
  InstallationDemandEntity,
  InstallationQuoteEntity,
  InstallationOrderEntity,
  WarrantyClaimEntity,
} from '../entities/sprint4';
import {
  QuoteMessageEntity,
  InstallerProfileEntity,
  InstallerReviewEntity,
  InstallerProjectEntity,
  InstallerSpecialtyEntity,
} from '../entities/sprint5';
import { requireAuth, requireInstaller, ok, fail, badRequest, AuthedRequest } from '../middleware/auth';
import { smsGateway } from '../services/sms-gateway';
import { eventBus } from '../services/event-bus';
import { ensureBusinessConv, writeCardMessage } from '../services/chat-hook';
import { log } from '../logger';
import { rankCandidates } from '../services/dispatch';
import { onSubOrderAcceptedORM } from '../db-orm';

const router = Router();

// — 工具函数：Haversine 距离计算（km）—
function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// — 工具：生成订单号 —
function genOrderNo() {
  return (
    'INO' +
    Date.now().toString().slice(-10) +
    Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')
  );
}

// ============================================================================
// Phase 1：用户端安装需求
// ============================================================================

// ① POST /installation/publish — 发布安装需求
router.post('/publish', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const {
    categoryId,
    serviceType,
    address,
    serviceLat,
    serviceLng,
    expectedTime,
    description,
    budgetMin,
    budgetMax,
    contactName,
    contactPhone, // 🚨 P0 修复：之前后端没接这俩
    craftType,
    specSize,
    installHeight,
    powerStatus, // 📐 Sprint 9 结构化字段
    materialBy,
    needDemolition,
    installLocation,
    accessibility,
    sitePhotos,
  } = req.body as any;

  // 🔧 P0：serviceType 仍为必填（前端若传 craftType 则优先用 craftType 冗余到 serviceType）
  const finalServiceType = craftType || serviceType;
  if (!finalServiceType || !address) {
    res.status(400).json({ code: 400, msg: '缺少必填字段：需求描述/地址' });
    return;
  }
  // 🔧 P0：lat/lng 不再硬编码，前端必须用 chooseLocation 传值；没传则用 (0,0) 但标注为 null 级
  const finalLat = typeof serviceLat === 'number' && serviceLat !== 0 ? serviceLat : null;
  const finalLng = typeof serviceLng === 'number' && serviceLng !== 0 ? serviceLng : null;

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503, msg: '数据库不可用' });
    return;
  }

  try {
    const repo = ds.getRepository(InstallationDemandEntity);
    const demand = repo.create({
      userId,
      categoryId: categoryId || null, // 🔧 P0：之前前端传 null，现在有分类选择器
      serviceType: finalServiceType,
      address,
      serviceLat: finalLat ?? 0,
      serviceLng: finalLng ?? 0,
      expectedTime,
      description,
      budgetMin: budgetMin ? Number(budgetMin) : null,
      budgetMax: budgetMax ? Number(budgetMax) : null,
      radiusKm: 10,
      status: 'pending',
      // 🚨 P0 Bug 修复：新增字段
      contactName: contactName || null,
      contactPhone: contactPhone || null,
      // 📐 Sprint 9 结构化字段
      craftType: craftType || null,
      specSize: specSize || null,
      installHeight: installHeight || null,
      powerStatus: powerStatus || null,
      materialBy: materialBy || null,
      needDemolition: needDemolition ? Number(needDemolition) : 0,
      installLocation: installLocation || null,
      accessibility: Array.isArray(accessibility) ? accessibility : null,
      sitePhotos: Array.isArray(sitePhotos) ? sitePhotos : null,
    } as any);
    await repo.save(demand);

    // — Phase 2 核心：推送范围内师傅（10km + 擅长分类匹配）—
    // 🚨 lat/lng 无效（0 或 null）时**不推送**，避免把需求发到几千公里外的师傅
    if (finalLat == null || finalLng == null) {
      log(`[Installation] demand ${(demand as any).id} 无有效坐标，跳过师傅推送`, 'info');
    } else {
      setTimeout(async () => {
        try {
          const installerRepo = ds.getRepository(InstallerProfileEntity);
          const specsRepo = ds.getRepository(InstallerSpecialtyEntity);

          // 粗筛矩形
          const latDelta = 10 / 111;
          const lngDelta = 10 / (111 * Math.cos((finalLat * Math.PI) / 180));
          const candidates = await installerRepo.find({
            where: { verified: 1 },
          });

          // 🆕 6 级体系：按 demand 的 gradeMin/gradeMax 过滤匹配等级的师傅
          const dGradeMin = (demand as any).gradeMin ?? 1;
          const dGradeMax = (demand as any).gradeMax ?? 6;

          // 精确距离过滤 + 师傅愿意覆盖该距离 + 🆕 grade 匹配
          const matched = candidates.filter((inst) => {
            if (
              Math.abs(inst.serviceLat - finalLat) > latDelta ||
              Math.abs(inst.serviceLng - finalLng) > lngDelta
            ) {
              return false;
            }
            const d = haversine(finalLat, finalLng, inst.serviceLat, inst.serviceLng);
            if (d > 10 || inst.serviceRadiusKm < d) return false;
            // 🆕 grade 过滤
            if (inst.grade != null && (inst.grade < dGradeMin || inst.grade > dGradeMax)) return false;
            return true;
          });

          // 提前生成分类匹配集合
          const specIds = categoryId
            ? (await specsRepo.find({ where: { categoryId } })).map((s) => s.installerId)
            : [];

          // — Phase 2 加权排序：评分30%+完成数20%+距离20%+分类匹配20%+活跃度10%+新手保护 —
          const sorted = rankCandidates(
            matched.map((inst) => ({
              id: inst.id,
              rating: inst.rating || 0,
              completedOrders: inst.completedOrders || 0,
              distance: haversine(finalLat, finalLng, inst.serviceLat, inst.serviceLng),
              matchScore: categoryId ? (specIds.includes(inst.id) ? 1 : 0) : 0,
              isNewbie: (inst.completedOrders || 0) < 5,
            })),
            { topN: 15 },
          );
          // 取出完整实体
          const top15Ids = new Set(sorted.map((s) => s.id));
          const top15 = matched.filter((m) => top15Ids.has(m.id));
          // 按 rank 顺序排列
          top15.sort(
            (a, b) =>
              sorted.find((s) => s.id === a.id)!.rank - sorted.find((s) => s.id === b.id)!.rank,
          );
          if (top15.length > 0) {
            const budgetStr =
              budgetMin && budgetMax
                ? `¥${budgetMin}-${budgetMax}`
                : budgetMin
                  ? `¥${budgetMin}`
                  : '面议';
            await (smsGateway as any).batchSend!({
              phones: top15.map((i) => i.phone),
              templateKey: 'new_demand',
              variables: {
                serviceType: finalServiceType || '安装', // 🔧 改成 final
                distance: '10',
                budget: budgetStr,
              },
            });
            log(`[Installation] demand ${(demand as any).id} 推送 ${top15.length} 位师傅`, 'info');
            // SSE 实时推：广播新需求
            eventBus.emit('new_demand', 'broadcast', 0, {
              demandId: (demand as any).id,
              serviceType: finalServiceType,
              address,
              radiusKm: 10,
            });
          }
        } catch (e: any) {
          log(`[Installation] 推送师傅失败: ${e.message}`, 'error');
        }
      }, 200);
    }

    res.json({ code: 0, data: { id: (demand as any).id, status: (demand as any).status } });
  } catch (e: any) {
    log(`[Installation] publish error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, msg: '发布失败' });
  }
});

// — 🆕 师傅接单大厅（固定路径，必须在 /:id 之前）—
// 返回 pending/quoting 的安装需求，按当前师傅 grade 过滤
router.get('/hall', requireAuth, requireInstaller, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { categoryId, keyword } = req.query as { categoryId?: string; keyword?: string };

  // 🆕 6 级体系：查当前登录师傅的 grade
  let selfGrade: number | undefined;
  try {
    const ds = getDataSource();
    if (ds?.isInitialized) {
      const profile = await ds.getRepository(InstallerProfileEntity).findOne({
        where: { userId },
      });
      if (profile) selfGrade = profile.grade;
    }
  } catch (e) {
    log('查询 installer_profile grade 失败', 'warn');
  }

  try {
    const ds = getDataSource();
    if (!ds?.isInitialized) return res.status(500).json({ code: 500, msg: '数据库未连接' });

    const repo = ds.getRepository(InstallationDemandEntity);
    const qb = repo.createQueryBuilder('d').where('d.status IN (:...statuses)', {
      statuses: ['pending', 'quoting'],
    });

    // 🆕 按师傅 grade 过滤
    if (selfGrade != null) {
      qb.andWhere('d.gradeMin <= :grade AND d.gradeMax >= :grade', { grade: selfGrade });
    }
    if (categoryId) {
      qb.andWhere('d.categoryId = :cid', { cid: Number(categoryId) });
    }
    if (keyword) {
      qb.andWhere('(d.description LIKE :kw OR d.address LIKE :kw)', { kw: `%${keyword}%` });
    }
    qb.addOrderBy('d.id', 'DESC').limit(50);

    const items = await qb.getMany();

    const list = items.map((d: any) => ({
      id: String(d.id),
      categoryId: d.categoryId,
      serviceType: d.serviceType,
      address: d.address,
      budgetMin: d.budgetMin != null ? Number(d.budgetMin) : null,
      budgetMax: d.budgetMax != null ? Number(d.budgetMax) : null,
      craftType: d.craftType,
      installHeight: d.installHeight,
      gradeMin: d.gradeMin ?? 1,
      gradeMax: d.gradeMax ?? 6,
      status: d.status,
      quoteCount: d.quoteCount ?? 0,
      description: d.description,
      createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt,
    }));

    ok(res, { list, total: list.length, selfGrade });
  } catch (e: any) {
    log(`[Installation] hall error: ${e.message}`, 'error');
    fail(res, 500, '大厅加载失败', 500);
  }
});

// ⑤ GET /installation/my — 我发布的需求列表（必须在 /:id 之前，否则被当成 id=my）
router.get('/my', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const repo = ds.getRepository(InstallationDemandEntity);
    const list = await repo.find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 20,
    });
    res.json({ code: 0, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑪ GET /installation/my-orders — 用户自己的安装订单列表（带质保聚合）
// 注意：必须在 /:id 之前，否则被当成 id=my-orders
router.get('/my-orders', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const tab = (req.query?.tab as string) || 'all'; // all/completed/in_progress

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const repo = ds.getRepository(InstallationOrderEntity);
    const where: any = { userId };
    if (tab === 'completed') {
      where.status = 'completed';
    } else if (tab === 'in_progress') {
      where.status = In(['pending', 'accepted', 'in_progress']);
    }

    const list = await repo.find({
      where,
      order: { createdAt: 'DESC' },
      take: 50,
    });

    // 附带简要质保状态（前端列表要展示）
    const enriched = list.map((o: any) => ({
      ...o,
      // 方便前端展示的质保衍生字段
      warrantyDaysLeft: o.warrantyExpireAt
        ? Math.max(
            0,
            Math.ceil((new Date(o.warrantyExpireAt).getTime() - Date.now()) / (24 * 3600 * 1000)),
          )
        : 0,
    }));

    res.json({ code: 0, data: enriched });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑫ GET /installation/my-orders/:id — 用户自己的安装订单详情（带完整质保信息）
router.get('/my-orders/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ code: 400 });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const repo = ds.getRepository(InstallationOrderEntity);
    const order = await repo.findOne({ where: { id, userId } });
    if (!order) {
      res.status(404).json({ code: 404, msg: '订单不存在' });
      return;
    }

    // 附带师傅简要信息
    const installerRepo = ds.getRepository(InstallerProfileEntity);
    const installer = await installerRepo.findOne({ where: { id: order.installerId } });

    // 附带 demand 需求快照
    const demandRepo = ds.getRepository(InstallationDemandEntity);
    const demand = order.demandId
      ? await demandRepo.findOne({ where: { id: order.demandId } } as any)
      : null;

    // 附带最新报价（如果有）
    const quoteRepo = ds.getRepository(InstallationQuoteEntity);
    const quote = await quoteRepo.findOne({ where: { orderId: order.id } } as any);

    // 附带质保状态
    const warrantyStatusRepo = ds.getRepository(InstallationOrderEntity);
    const warranty = {
      status: order.warrantyStatus,
      holdAmount: Number(order.warrantyHoldAmount || 0),
      expireAt: order.warrantyExpireAt,
      daysLeft: order.warrantyExpireAt
        ? Math.max(
            0,
            Math.ceil(
              (new Date(order.warrantyExpireAt).getTime() - Date.now()) / (24 * 3600 * 1000),
            ),
          )
        : 0,
      canClaim:
        order.warrantyStatus === 'active' &&
        order.warrantyExpireAt &&
        new Date(order.warrantyExpireAt) > new Date(),
    };

    ok(res, {
      ...(order as any),
      installer: installer
        ? {
            id: installer.id,
            realName: installer.realName,
            avatar: installer.avatar,
            rating: installer.rating,
            completedOrders: installer.completedOrders,
          }
        : null,
      demand: demand
        ? {
            id: (demand as any).id,
            demandText: (demand as any)?.demandText,
            categoryId: demand.categoryId,
            heightTier: (demand as any)?.heightTier,
            address: demand.address,
          }
        : null,
      quote: quote
        ? {
            price: Number(quote.price),
            labor: Number(quote.labor || 0),
            materials: Number(quote.materials || 0),
            freight: Number(quote.freight || 0),
            tax: Number(quote.tax || 0),
          }
        : null,
      warranty,
    });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —
// 🔗 Gap-2: GET /installation/service-order/timeline — 服务订单 timeline
// 前端 cart-order.ts serviceOrderService.getTimeline() 调用
// ⚠️ 固定路径必须在 /:id 通配符之前注册（§8.2）
// — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —

function fmtInstallTime(d: any): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

router.get('/service-order/timeline', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const orderIdStr = req.query.id as string | undefined;
  if (!orderIdStr) {
    res.status(400).json({ code: 400, msg: 'id 必填' });
    return;
  }
  const orderId = Number(orderIdStr);
  if (!orderId) {
    res.status(400).json({ code: 400, msg: '非法的订单 ID' });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503, msg: '数据库未连接' });
    return;
  }

  try {
    const repo = ds.getRepository(InstallationOrderEntity);
    // 先查订单，admin 可看任意订单
    const order = await repo.findOne({ where: { id: orderId } });
    if (!order) {
      res.status(404).json({ code: 404, msg: '订单不存在' });
      return;
    }
    // 从 token 或 DB 拿 role 做权限判断
    const tokenRole = (req.headers.authorization || '').match(/^Bearer (.+)$/);
    let role = '';
    if (tokenRole) {
      try {
        const { decodeToken } = await import('../middleware/auth');
        role = decodeToken(tokenRole[1])?.role || '';
      } catch {}
    }
    if (role !== 'admin' && Number(order.userId) !== userId) {
      res.status(403).json({ code: 403, msg: '无权查看' });
      return;
    }

    // 前端 STAGE_CONFIGS 7 阶段映射 → 后端按订单 status + 时间戳动态构建
    const createdAt = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt);
    const startedAt = order.startedAt ? fmtInstallTime(order.startedAt) : '';
    const completedAt = order.completedAt ? fmtInstallTime(order.completedAt) : '';

    // 按状态确定当前进度位置
    const s = order.status;
    let pubStatus = 'done';
    let dispatchStatus: string = 'pending';
    let acceptStatus: string = 'pending';
    let onsiteStatus: string = 'pending';
    let progressStatus: string = 'pending';
    let checkStatus: string = 'pending';
    let settleStatus: string = 'pending';

    // accepted/in_progress/completed → 正常流程
    if (s === 'pending') {
      dispatchStatus = 'currentOrange';
    } else if (s === 'accepted') {
      dispatchStatus = 'done';
      acceptStatus = 'current';
    } else if (s === 'in_progress' || s === 'started') {
      dispatchStatus = 'done';
      acceptStatus = 'done';
      onsiteStatus = startedAt ? 'done' : 'currentOrange';
      progressStatus = 'current';
    } else if (s === 'completed') {
      dispatchStatus = 'done';
      acceptStatus = 'done';
      onsiteStatus = startedAt ? 'done' : 'pending';
      progressStatus = 'done';
      checkStatus = 'done';
      settleStatus = 'currentPurple';
    } else if (s === 'reviewed') {
      dispatchStatus = 'done';
      acceptStatus = 'done';
      onsiteStatus = 'done';
      progressStatus = 'done';
      checkStatus = 'done';
      settleStatus = 'done';
    } else if (s === 'cancelled') {
      dispatchStatus = 'done';
      // 后面的都跳过
    }

    const orderNo = order.orderNo;

    const timeline = [
      { status: pubStatus, icon: 'check', title: '需求已发布', time: fmtInstallTime(createdAt) },
      { status: dispatchStatus, icon: 'users', title: '平台派单中', time: s === 'pending' ? '进行中' : fmtInstallTime(createdAt) },
      { status: acceptStatus, icon: 'calendar', title: '师傅已接单', time: s !== 'pending' && s !== 'cancelled' ? fmtInstallTime(createdAt) : '待完成' },
      { status: onsiteStatus, icon: 'truck', title: '师傅已到达现场', time: startedAt || (s === 'in_progress' ? '待到达' : '待完成') },
      { status: progressStatus, icon: 'hammer', title: '施工进行中', time: startedAt || '待完成' },
      { status: checkStatus, icon: 'eye', title: '待验收', time: s === 'completed' || s === 'reviewed' ? completedAt : '待完成' },
      { status: settleStatus, icon: 'check-circle', title: '已结算', time: s === 'reviewed' ? completedAt : '待完成' },
    ];

    // cancelled 覆盖
    if (s === 'cancelled') {
      timeline.length = 2;
      timeline.push({ status: 'done', icon: 'x-circle', title: '订单已取消', time: fmtInstallTime(order.updatedAt) });
    }

    ok(res, {
      orderId: String(order.id),
      orderNo,
      stage: s === 'completed' ? 'check' : s === 'reviewed' ? 'settled' : s === 'cancelled' ? 'cancelled' : s === 'in_progress' || s === 'started' ? 'progress' : s === 'accepted' ? 'booked' : 'dispatching',
      timeline,
    });
  } catch (e: any) {
    log(`[Installation] timeline error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ② GET /installation/:id — 追踪详情（含报价列表）
router.get('/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ code: 400, msg: '参数错误' });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const demand = await ds
      .getRepository(InstallationDemandEntity)
      .findOne({ where: { id, userId } });
    if (!demand) {
      res.status(404).json({ code: 404, msg: '需求不存在' });
      return;
    }

    const quotes = await ds.getRepository(InstallationQuoteEntity).find({
      where: { demandId: id },
      order: { createdAt: 'DESC' },
    });

    // 报价带上师傅基本信息
    const installerIds = [...new Set(quotes.map((q) => q.installerId))];
    const profiles =
      installerIds.length > 0
        ? await ds.getRepository(InstallerProfileEntity).findBy({ id: installerIds as any })
        : [];

    const result: any = { ...demand };
    result.quotes = quotes.map((q) => {
      const profile = profiles.find((p) => p.id === q.installerId);
      // 🆕 方案1：信任层计算（与 test/trust-layer.test.ts 同源）
      const verified = profile?.verified === 1;
      const bondAmount = Number(profile?.bondAmount || 0);
      const rating = profile?.rating || 5;
      const ratingCount = profile?.ratingCount || 0;
      const completedOrders = profile?.completedOrders || 0;
      const onTimeRate = Math.min(99, Math.round(70 + ratingCount * 0.5 + completedOrders * 0.05));
      const guaranteeTags: string[] = [];
      if (bondAmount >= 1000) guaranteeTags.push('先行赔付');
      if (verified) guaranteeTags.push('实名认证');
      if (completedOrders >= 20) guaranteeTags.push('经验充足');
      guaranteeTags.push('30天质保');
      const trustScore = (bondAmount / 1000) * 3 + rating * 2 + Math.min(completedOrders * 0.1, 5);

      return {
        ...q,
        installerName: profile?.realName || '师傅',
        installerAvatar: profile?.avatar,
        installerPhone: profile?.phone,
        installerRating: rating,
        installerCompletedOrders: completedOrders,
        distance: haversine(
          demand.serviceLat,
          demand.serviceLng,
          profile?.serviceLat || 0,
          profile?.serviceLng || 0,
        ).toFixed(1),
        // 🆕 方案1 信任层字段
        installerVerified: verified,
        installerBondAmount: bondAmount,
        installerRatingCount: ratingCount,
        installerOnTimeRate: onTimeRate,
        installerGuaranteeTags: guaranteeTags,
        installerTrustScore: Math.round(trustScore * 100) / 100,
      };
    });

    // 倒计时：30 分钟从发布时算
    const now = Date.now();
    const createdTime = new Date(demand.createdAt).getTime();
    const elapsed = Math.floor((now - createdTime) / 1000);
    result.countdown = Math.max(0, 30 * 60 - elapsed); // 剩余秒数
    result.quotable = (demand as any).status === 'pending' || (demand as any).status === 'quoting';

    res.json({ code: 0, data: result });
  } catch (e: any) {
    log(`[Installation] tracking error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, msg: '查询失败' });
  }
});

// ③ POST /installation/:id/expand — 扩大范围 10→25km
router.post('/:id/expand', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ code: 400 });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const repo = ds.getRepository(InstallationDemandEntity);
    const demand = await repo.findOne({ where: { id, userId } });
    if (!demand) {
      res.status(404).json({ code: 404, msg: '需求不存在' });
      return;
    }

    if (demand.radiusKm >= 25) {
      res.json({ code: 0, data: { expanded: false, msg: '已经是最大范围了' } });
      return;
    }

    demand.radiusKm = 25;
    demand.expandedAt = new Date();
    await repo.save(demand);

    // 重新推送（新增范围内师傅）
    const installerRepo = ds.getRepository(InstallerProfileEntity);
    const allInstallers = await installerRepo.find({ where: { verified: 1 } });
    const matched = allInstallers
      .filter((inst) => {
        const d = haversine(demand.serviceLat, demand.serviceLng, inst.serviceLat, inst.serviceLng);
        return d > 10 && d <= 25 && inst.serviceRadiusKm >= d;
      })
      .slice(0, 15);

    if (matched.length > 0) {
      await (smsGateway as any).batchSend!({
        phones: matched.map((i) => i.phone),
        templateKey: 'demand_expanded',
        variables: { serviceType: demand.serviceType, distance: '25' },
      });
    }

    res.json({ code: 0, data: { expanded: true, newPushCount: matched.length } });
  } catch (e: any) {
    log(`[Installation] expand error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ④ POST /installation/accept — 用户接受某个报价（生成订单）
router.post('/accept', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { quoteId } = req.body as any;
  if (!quoteId) {
    res.status(400).json({ code: 400 });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const quote = await ds
      .getRepository(InstallationQuoteEntity)
      .findOne({ where: { id: quoteId, status: 'pending' } });
    if (!quote) {
      res.status(404).json({ code: 404, msg: '报价不存在或已处理' });
      return;
    }

    const demand = await ds
      .getRepository(InstallationDemandEntity)
      .findOne({ where: { id: quote.demandId, userId } });
    if (!demand) {
      res.status(404).json({ code: 404, msg: '需求不存在' });
      return;
    }

    // 生成订单
    const order = ds.getRepository(InstallationOrderEntity).create({
      orderNo: genOrderNo(),
      demandId: (demand as any).id,
      quoteId: quote.id,
      userId: demand.userId,
      installerId: quote.installerId,
      finalPrice: quote.price,
      status: 'pending',
    });
    await ds.getRepository(InstallationOrderEntity).save(order);

    // 🆕 P2-2：子订单被接单后回写 MasterOrder（若有 masterOrderId，即购物车创建的安装子流程）
    if (order.masterOrderId) {
      await onSubOrderAcceptedORM(Number(order.masterOrderId), 'installation', order.id, 'installing');
    }

    // 更新状态
    quote.status = 'accepted';
    await ds.getRepository(InstallationQuoteEntity).save(quote);
    (demand as any).status = 'accepted';
    await ds.getRepository(InstallationDemandEntity).save(demand);

    // 其他 pending 报价标记为 rejected
    await ds
      .getRepository(InstallationQuoteEntity)
      .createQueryBuilder()
      .update()
      .set({ status: 'rejected' })
      .where('demandId = :demandId AND id != :acceptedId AND status = :pending', {
        demandId: (demand as any).id,
        acceptedId: quote.id,
        pending: 'pending',
      })
      .execute();

    // 通知师傅
    const installer = await ds
      .getRepository(InstallerProfileEntity)
      .findOne({ where: { id: quote.installerId } });
    if (installer) {
      await (smsGateway as any).sendTemplateSms!({
        phone: installer.phone,
        templateKey: 'quote_accepted',
        variables: { orderNo: order.orderNo },
      });
      eventBus.emit('quote_accepted', 'installer', installer.userId, {
        quoteId: quote.id,
        orderId: order.id,
        orderNo: order.orderNo,
      });

      // — 自动创建 chat 会话（买家 ↔ 师傅，关联 installation_order#order.id）—
      try {
        await ensureBusinessConv({
          refType: 'installation_order',
          refId: order.id,
          partyA: userId,                      // 买家
          partyB: Number(installer.userId),    // 师傅
          event: 'installer_accept',
        });
      } catch (e: any) {
        log('[installation] chat-hook fail', e?.message, 'warn');
      }
    }

    res.json({ code: 0, data: { orderId: order.id, orderNo: order.orderNo } });
  } catch (e: any) {
    log(`[Installation] accept error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ============================================================================
// ⑤.5 POST /installation/:id/reject-all — 用户拒绝全部报价
// （前端"全部拒绝"按钮调此接口，持久化 rejected_all 状态）
// ============================================================================
router.post('/:id/reject-all', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ code: 400 });

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return res.status(503).json({ code: 503 });

  try {
    const demand = await ds
      .getRepository(InstallationDemandEntity)
      .findOne({ where: { id, userId } });
    if (!demand) return res.status(404).json({ code: 404, msg: '需求不存在' });

    // 必须有报价才能拒绝全部
    if (demand.status !== 'quoting') {
      return res.status(422).json({ code: 422, msg: `当前状态 ${demand.status} 不允许拒绝` });
    }

    // 更新 demand 状态
    demand.status = 'rejected_all';
    (demand as any).updatedAt = new Date();
    await ds.getRepository(InstallationDemandEntity).save(demand);

    // 所有 pending 报价标记 rejected
    await ds
      .getRepository(InstallationQuoteEntity)
      .createQueryBuilder()
      .update()
      .set({ status: 'rejected' })
      .where('demandId = :demandId AND status = :pending', { demandId: id, pending: 'pending' })
      .execute();

    res.json({ code: 0, data: { id: demand.id, status: 'rejected_all' } });
  } catch (e: any) {
    log(`[Installation] reject-all error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ============================================================================
// Phase 2：用户端补端点
// ============================================================================

// ⑥ GET /installation/quote/:id/messages — 报价沟通消息列表
router.get('/quote/:id/messages', requireAuth, async (req: AuthedRequest, res: Response) => {
  const quoteId = Number(req.params.id);
  if (!quoteId) {
    res.status(400).json({ code: 400 });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    // 验证这个报价属于当前用户的 demand
    const quote = await ds
      .getRepository(InstallationQuoteEntity)
      .findOne({ where: { id: quoteId } });
    if (!quote) {
      res.status(404).json({ code: 404 });
      return;
    }
    const demand = await ds
      .getRepository(InstallationDemandEntity)
      .findOne({ where: { id: quote.demandId, userId: req.userId! } });
    if (!demand) {
      res.status(403).json({ code: 403, msg: '无权访问' });
      return;
    }

    const messages = await ds.getRepository(QuoteMessageEntity).find({
      where: { quoteId },
      order: { createdAt: 'ASC' },
    });
    res.json({ code: 0, data: messages });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑦ POST /installation/quote/:id/messages — 发消息（砍价/加预算）
router.post('/quote/:id/messages', requireAuth, async (req: AuthedRequest, res: Response) => {
  const quoteId = Number(req.params.id);
  const { content, messageType = 'text', counterPrice } = req.body as any;
  if (!quoteId || !content) {
    res.status(400).json({ code: 400 });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const quote = await ds
      .getRepository(InstallationQuoteEntity)
      .findOne({ where: { id: quoteId } });
    if (!quote) {
      res.status(404).json({ code: 404 });
      return;
    }

    const msg = ds.getRepository(QuoteMessageEntity).create({
      quoteId,
      senderUserId: req.userId!,
      senderRole: 'user',
      content,
      messageType,
      counterPrice,
    });
    await ds.getRepository(QuoteMessageEntity).save(msg);

    // 通知对方
    if (
      messageType === 'counter_offer' ||
      messageType === 'budget_increase' ||
      messageType === 'text'
    ) {
      if (quote.installerId) {
        const installer = await ds
          .getRepository(InstallerProfileEntity)
          .findOne({ where: { id: quote.installerId } });
        if (installer) {
          await (smsGateway as any).sendTemplateSms!({
            phone: installer.phone,
            templateKey: 'quote_counter_offer',
            variables: { message: content.slice(0, 40) },
          });
          // SSE：用户发消息 → 推给师傅
          if ((req as any).userRole === 'user') {
            eventBus.emit('counter_offer', 'installer', installer.userId, {
              quoteId,
              content,
              messageType,
            });
          }
        }
      }
      // SSE：如果师傅发消息（从 installer.ts 那个 messages POST 来的）→ 推给用户
      // 但这个 POST 端点只有 user role 能发，师傅发消息走 /api/installer/quote/:id/messages
    }

    res.json({ code: 0, data: msg });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑧ GET /installation/installer/:id — 师傅主页（资料+评价+过往项目）
router.get('/installer/:id', requireAuth, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ code: 400 });
    return;
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    res.status(503).json({ code: 503 });
    return;
  }

  try {
    const profile = await ds
      .getRepository(InstallerProfileEntity)
      .findOne({ where: { id, verified: 1 } });
    if (!profile) {
      res.status(404).json({ code: 404, msg: '师傅不存在或未审核通过' });
      return;
    }

    const [specialties, reviews, projects] = await Promise.all([
      ds.getRepository(InstallerSpecialtyEntity).find({ where: { installerId: id } }),
      ds
        .getRepository(InstallerReviewEntity)
        .find({ where: { installerId: id }, order: { createdAt: 'DESC' }, take: 20 }),
      ds
        .getRepository(InstallerProjectEntity)
        .find({ where: { installerId: id }, order: { sort: 'ASC' }, take: 12 }),
    ]);

    res.json({
      code: 0,
      data: {
        ...profile,
        specialties,
        reviews,
        projects,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ============================================================================
// ✅ Sprint 8：90 天质保（用户端）
// ============================================================================

// ⑨ POST /installation/orders/:id/warranty-claim — 用户发起质保索赔
router.post(
  '/orders/:id/warranty-claim',
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const userId = req.userId!;
    const orderId = Number(req.params.id);
    const { issueDesc, images } = req.body as any;
    if (!orderId || !issueDesc) {
      res.status(400).json({ code: 400, msg: '缺少必填字段' });
      return;
    }

    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      res.status(503).json({ code: 503 });
      return;
    }

    try {
      const repo = ds.getRepository(InstallationOrderEntity);
      const order = await repo.findOne({ where: { id: orderId, userId } });
      if (!order) {
        res.status(404).json({ code: 404, msg: '订单不存在' });
        return;
      }

      // 质保必须 active 且未过期
      if (order.warrantyStatus !== 'active') {
        res.status(400).json({ code: 400, msg: `质保状态不可索赔（${order.warrantyStatus}）` });
        return;
      }
      if (order.warrantyExpireAt && new Date(order.warrantyExpireAt) <= new Date()) {
        res.status(400).json({ code: 400, msg: '质保期已过' });
        return;
      }

      // 一个订单只能索赔一次
      const claimRepo = ds.getRepository(WarrantyClaimEntity);
      const existing = await claimRepo.findOne({ where: { orderId } });
      if (existing) {
        res.status(400).json({ code: 400, msg: '已发起过索赔' });
        return;
      }

      // 创建索赔单
      const now = new Date();
      const claimNo =
        'WC' +
        now.getTime().toString().slice(-10) +
        Math.floor(Math.random() * 1000)
          .toString()
          .padStart(3, '0');
      const claim = claimRepo.create({
        claimNo,
        orderId: order.id,
        orderNo: order.orderNo,
        userId: order.userId,
        installerId: order.installerId,
        issueDesc,
        images: images || [],
        status: 'pending',
      });
      await claimRepo.save(claim);

      // 更新订单质保状态
      order.warrantyStatus = 'claimed';
      await repo.save(order);

      // 通知师傅（SSE + SMS）
      eventBus.emit('new_warranty_claim', 'installer', 0, {
        claimId: claim.id,
        claimNo,
        orderNo: order.orderNo,
        issueDesc,
      });
      const installer = await ds
        .getRepository(InstallerProfileEntity)
        .findOne({ where: { id: order.installerId } });
      if (installer?.phone) {
        await (smsGateway as any).sendTemplateSms!({
          phone: installer.phone,
          templateKey: 'warranty_claim',
          variables: { orderNo: order.orderNo, issue: issueDesc.slice(0, 30) },
        });
      }

      log(`[Warranty] new claim ${claimNo} order=${order.orderNo} user=${userId}`, 'info');

      res.json({ code: 0, data: { claimId: claim.id, claimNo, status: 'pending' } });
    } catch (e: any) {
      log(`[Warranty] claim error: ${e.message}`, 'error');
      res.status(500).json({ code: 500 });
    }
  },
);

// ⑩ GET /installation/orders/:id/warranty-status — 用户查质保状态
router.get(
  '/orders/:id/warranty-status',
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const userId = req.userId!;
    const orderId = Number(req.params.id);
    if (!orderId) {
      res.status(400).json({ code: 400 });
      return;
    }

    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      res.status(503).json({ code: 503 });
      return;
    }

    try {
      const order = await ds
        .getRepository(InstallationOrderEntity)
        .findOne({ where: { id: orderId, userId } });
      if (!order) {
        res.status(404).json({ code: 404, msg: '订单不存在' });
        return;
      }

      // 如果已索赔，带索赔详情
      let claim: any = null;
      if (order.warrantyStatus === 'claimed' || order.warrantyStatus === 'settled') {
        claim = await ds.getRepository(WarrantyClaimEntity).findOne({ where: { orderId } });
      }

      res.json({
        code: 0,
        data: {
          warrantyStatus: order.warrantyStatus,
          warrantyExpireAt: order.warrantyExpireAt,
          warrantyHoldAmount: order.warrantyHoldAmount,
          warrantyHoldRate: 5, // %
          daysLeft: order.warrantyExpireAt
            ? Math.max(
                0,
                Math.ceil(
                  (new Date(order.warrantyExpireAt).getTime() - Date.now()) / (24 * 3600 * 1000),
                ),
              )
            : 0,
          holdAmount: order.warrantyHoldAmount,
          claim,
        },
      });
    } catch (e: any) {
      res.status(500).json({ code: 500 });
    }
  },
);

// ============================================================================
// ✅ 第四批：买家验收（approve / reject）
// ============================================================================

// ⑪ POST /installation/my-orders/:id/acceptance — 买家验收安装施工
// body: { action: 'approve' | 'reject', remark?: string }
router.post(
  '/my-orders/:id/acceptance',
  requireAuth,
  async (req: AuthedRequest, res: Response) => {
    const userId = req.userId!;
    const orderId = Number(req.params.id);
    const { action, remark } = req.body as any;
    if (!orderId) {
      res.status(400).json({ code: 400, msg: '订单 ID 无效' });
      return;
    }
    if (!action || (action !== 'approve' && action !== 'reject')) {
      res.status(400).json({ code: 400, msg: 'action 必须是 approve 或 reject' });
      return;
    }

    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      res.status(503).json({ code: 503, msg: '数据库未连接' });
      return;
    }

    try {
      const repo = ds.getRepository(InstallationOrderEntity);
      const order = await repo.findOne({ where: { id: orderId, userId } });
      if (!order) {
        res.status(404).json({ code: 404, msg: '订单不存在' });
        return;
      }
      // 只有师傅已完成（completed）才能验收
      if (order.status !== 'completed') {
        res.status(422).json({ code: 422, msg: `当前状态 ${order.status} 不允许验收` });
        return;
      }

      // 查师傅
      const installer = await ds
        .getRepository(InstallerProfileEntity)
        .findOne({ where: { id: order.installerId } });
      if (!installer) {
        res.status(404).json({ code: 404, msg: '师傅资料不存在' });
        return;
      }

      if (action === 'approve') {
        order.status = 'reviewed'; // 验收通过 → reviewed（已结算完成态）
        order.currentStage = 5;     // 买家验收通过
        order.completedAt = order.completedAt || new Date();
        await repo.save(order);

        // 通知师傅
        eventBus.emit('acceptance_confirmed', 'installer', installer.userId, {
          orderId: order.id, orderNo: order.orderNo,
        });
        try {
          if (installer.phone) {
            await (smsGateway as any).sendTemplateSms!({
              phone: installer.phone,
              templateKey: 'acceptance_confirmed',
              variables: { orderNo: order.orderNo },
            });
          }
        } catch { /* 静默 */ }

        log(`[Acceptance] ✅ approve order=${order.orderNo} installerId=${installer.id}`, 'info');
        ok(res, { ok: true, status: 'reviewed' });
      } else {
        // reject
        order.status = 'rejected_acceptance';
        order.progressNote = remark ? String(remark).slice(0, 500) : order.progressNote;
        await repo.save(order);

        // 通知师傅（需要返工）
        eventBus.emit('acceptance_rejected', 'installer', installer.userId, {
          orderId: order.id, orderNo: order.orderNo,
          reason: remark || '',
        });
        try {
          if (installer.phone) {
            await (smsGateway as any).sendTemplateSms!({
              phone: installer.phone,
              templateKey: 'acceptance_rejected',
              variables: { orderNo: order.orderNo, reason: (remark || '').slice(0, 20) },
            });
          }
        } catch { /* 静默 */ }

        log(`[Acceptance] ❌ reject order=${order.orderNo} installerId=${installer.id}`, 'info');
        ok(res, { ok: true, status: 'rejected_acceptance' });
      }
    } catch (e: any) {
      log(`[Acceptance] error: ${e.message}`, 'error');
      res.status(500).json({ code: 500 });
    }
  },
);

export default router;
