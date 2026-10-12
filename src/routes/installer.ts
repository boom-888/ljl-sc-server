// ============================================================================
// 🔧 Installer Routes — 师傅端（Phase 2）
// register / hall / quote / quote.cancel / orders / orders.:id / orders.:id.start / orders.:id.complete / profile / profile PUT / earnings
// ============================================================================
import { Router, Response } from 'express';
import { In } from 'typeorm';
import { getDataSource } from '../db-manager';
import { InstallationDemandEntity, InstallationQuoteEntity, InstallationOrderEntity, WarrantyClaimEntity } from '../entities/sprint4';
import { InstallerProfileEntity, InstallerSpecialtyEntity } from '../entities/sprint5';
import { requireAuth, requireInstaller, requirePendingInstaller, AuthedRequest, ok, fail, badRequest, notFound, serverError } from '../middleware/auth';
import { smsGateway } from '../services/sms-gateway';
import { eventBus } from '../services/event-bus';
import { log } from '../logger';
import { rankCandidates, calcVipLevel } from '../services/dispatch';
import { COMMISSION_RATES, tierDiscount, WARRANTY_CONFIG } from '../services/settle';
import { findUserByIdORM } from '../db-orm';
import { db } from '../db';
import { writeCardMessage } from '../services/chat-hook';

const router = Router();

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// — 工具：获取师傅 profile 或 404 —
async function getInstaller(userId: number, ds: any, res: Response): Promise<InstallerProfileEntity | null> {
  const inst = await ds.getRepository(InstallerProfileEntity).findOne({ where: { userId } });
  if (!inst) { res.status(404).json({ code: 404, msg: '师傅资料不存在，请先入驻' }); return null; }
  return inst;
}

// ① POST /installer/register — 提交入驻申请
router.post('/register', requireAuth, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const {
    realName, phone, idCardFront, idCardBack, businessLicense,
    serviceAddress, serviceLat, serviceLng, serviceRadiusKm,
    specialtyCategoryIds = [],
  } = req.body as any;

  if (!realName || !phone) { res.status(400).json({ code: 400, msg: '姓名和手机号必填' }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { ok: true });

  try {
    // 🛠️ 限制：只有 consumer 能提交入驻申请
    const user = await findUserByIdORM(userId);
    if (user) {
      if (user.role === 'pending_installer') { res.status(400).json({ code: 400, msg: '已提交入驻申请，请等待审核' }); return; }
      if (user.role === 'installer') { res.status(400).json({ code: 400, msg: '你已是师傅' }); return; }
      if (['admin', 'designer', 'vendor'].includes(user.role)) {
        res.status(400).json({ code: 400, msg: '当前角色不允许申请师傅入驻' }); return;
      }
    }

    const repo = ds.getRepository(InstallerProfileEntity);
    const existing = await repo.findOne({ where: { userId } });

    let profile: InstallerProfileEntity;
    if (existing) {
      Object.assign(existing, {
        realName, phone, idCardFront, idCardBack, businessLicense,
        serviceAddress, serviceLat: serviceLat || 0, serviceLng: serviceLng || 0,
        serviceRadiusKm: serviceRadiusKm ?? 15,
        verified: 0, // 每次修改重新等审核
        verifyNote: undefined,
        verifiedAt: undefined,
      });
      profile = await repo.save(existing);
    } else {
      profile = repo.create({
        userId, realName, phone, idCardFront, idCardBack, businessLicense,
        serviceAddress, serviceLat: serviceLat || 0, serviceLng: serviceLng || 0,
        serviceRadiusKm: serviceRadiusKm ?? 15,
        verified: 0,
      });
      profile = await repo.save(profile);
    }

    // 🛠️ Bug fix (注册链路 A): register 必须同步改 UserEntity.role → pending_installer
    // 否则 admin approve 后 role 还是 consumer（因为 installer.ts register 只创建 profile 没改 role）
    try {
      await ds.getRepository(UserEntity).update(userId, { role: 'pending_installer' });
    } catch {}

    // 保存擅长分类（先清旧的再批量插入）
    const specRepo = ds.getRepository(InstallerSpecialtyEntity);
    await specRepo.delete({ installerId: profile.id });
    if (Array.isArray(specialtyCategoryIds) && specialtyCategoryIds.length > 0) {
      const specs = specialtyCategoryIds.map(cid => specRepo.create({
        installerId: profile.id, categoryId: cid, level: 1, yearsExp: 1,
      }));
      await specRepo.save(specs);
    }

    res.json({ code: 0, data: { installerId: profile.id, verified: 0, msg: '提交成功，等待 admin 审核' } });
  } catch (e: any) {
    log(`[Installer] register error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, msg: '提交失败' });
  }
});

// ② GET /installer/hall — 附近安装需求（师傅视角）
router.get('/hall', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const sort = (req.query.sort as string) || 'newest'; // newest / distance

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, []);

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}
    if (installer.verified !== 1) {
      res.json({ code: 0, data: { jobs: [], needVerify: true, msg: '您的入驻申请还在审核中' } });
      return;
    }

    // 师傅擅长的分类
    const specRepo = ds.getRepository(InstallerSpecialtyEntity);
    const specialties = await specRepo.find({ where: { installerId: installer.id } });
    const catIds = specialties.map(s => s.categoryId);

    // 查需求：pending/quoting 状态 + 在师傅服务范围内
    const demandRepo = ds.getRepository(InstallationDemandEntity);
    const all = await demandRepo.find({
      where: [{ status: 'pending' }, { status: 'quoting' }],
      order: { createdAt: sort === 'distance' ? undefined : 'DESC' },
    });

    // 🆕 6 级体系：按师傅 grade 过滤匹配等级的需求
    const selfGrade = installer.grade ?? 1;

    // 过滤 + 加权排序（评分×完成数×距离×分类匹配×新手保护×🆕grade 匹配）
    const jobs = rankCandidates(
      all
        .map(d => ({
          ...d,
          distance: haversine(installer.serviceLat, installer.serviceLng, d.serviceLat, d.serviceLng),
        }))
        .filter((d: any) => {
          if (d.distance > d.radiusKm || d.distance > installer.serviceRadiusKm) return false;
          // 🆕 grade 匹配
          const gradeMin = d.gradeMin ?? 1;
          const gradeMax = d.gradeMax ?? 6;
          if (selfGrade < gradeMin || selfGrade > gradeMax) return false;
          return true;
        })
        .map((d: any) => ({
          id: d.id, rating: installer.rating || 0, completedOrders: installer.completedOrders || 0,
          distance: d.distance, matchScore: catIds.includes(d.categoryId || 0) ? 1 : 0,
          isNewbie: (installer.completedOrders || 0) < 5,
        })),
      { topN: 50 },
    ).map((d: any) => {
      const src = all.find(a => a.id === d.id);
      return {
        id: d.id,
        serviceType: src?.serviceType,
        title: src?.description || src?.serviceType,
        budget: (src?.budgetMin && src?.budgetMax)
          ? `¥${src?.budgetMin}-${src?.budgetMax}`
          : (src?.budgetMin ? `¥${src?.budgetMin}` : '面议'),
        address: src?.address,
        distance: `${d.distance.toFixed(1)}km`,
        publishTime: src?.createdAt,
        categoryId: src?.categoryId,
        dispatchScore: d.dispatchScore,
        rank: d.rank,
        gradeMin: src?.gradeMin ?? 1,
        gradeMax: src?.gradeMax ?? 6,
      };
    });

    res.json({ code: 0, data: { jobs, needVerify: false, selfGrade, selfGradeTitle: installer.gradeTitle || '' } });
  } catch (e: any) {
    log(`[Installer] hall error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ③ POST /installer/quote — 师傅报价
router.post('/quote', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { demandId, price, eta, description } = req.body as any;
  if (!demandId || !price) { res.status(400).json({ code: 400 }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { id: String(Date.now()), ok: true });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}
    if (installer.verified !== 1) { res.status(403).json({ code: 403, msg: '未审核通过' }); return; }

    const demandRepo = ds.getRepository(InstallationDemandEntity);
    const demand = await demandRepo.findOne({ where: { id: demandId, status: In(['pending', 'quoting']) } });
    if (!demand) { res.status(404).json({ code: 404, msg: '需求不存在或已结束' }); return; }

    // 防重复报价
    const quoteRepo = ds.getRepository(InstallationQuoteEntity);
    const existing = await quoteRepo.findOne({ where: { demandId, installerId: installer.id } });
    if (existing) {
      // 允许修改自己未被接受的报价
      if (existing.status === 'pending') {
        Object.assign(existing, { price, eta, description });
        await quoteRepo.save(existing);
      } else {
        res.status(400).json({ code: 400, msg: '您已报价过，无法修改状态' }); return;
      }
    } else {
      const quote = quoteRepo.create({ demandId, installerId: installer.id, price, eta, description });
      await quoteRepo.save(quote);
    }

    // 更新需求状态为 quoting
    if (demand.status === 'pending') {
      demand.status = 'quoting';
      demand.quoteCount += 1;
      await demandRepo.save(demand);
    } else {
      demand.quoteCount += 1;
      await demandRepo.save(demand);
    }

    // 通知用户（SMS 兜底 + SSE 实时推）
    eventBus.emit('new_quote', 'user', demand.userId, {
      quoteId: (existing as any)?.id ?? 0, installerName: installer.realName, price,
      demandId: demand.id,
    });
    // 异步 SMS
    (async () => {
      try {
        const userRepo = (ds.getRepository as any)(require('../entities').UserEntity);
        const user = await userRepo.findOne({ where: { id: demand.userId } });
        if (user?.phone) {
          await (smsGateway as any).sendTemplateSms!({
            phone: user.phone,
            templateKey: 'new_quote',
            variables: { installerName: installer.realName, price },
          });
        }
      } catch { /* 静默失败 */ }
    })();

    res.json({ code: 0, data: { ok: true } });
  } catch (e: any) {
    log(`[Installer] quote error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ④ POST /installer/quote/:id/cancel — 师傅撤销报价
router.post('/quote/:id/cancel', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const quoteId = Number(req.params.id);
  if (!quoteId) { res.status(400).json({ code: 400 }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { id: String(quoteId), ok: true });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const quote = await ds.getRepository(InstallationQuoteEntity).findOne({
      where: { id: quoteId, installerId: installer.id, status: 'pending' },
    });
    if (!quote) { res.status(404).json({ code: 404, msg: '报价不存在或已处理' }); return; }

    quote.status = 'cancelled';
    await ds.getRepository(InstallationQuoteEntity).save(quote);

    // 通知用户
    const demand = await ds.getRepository(InstallationDemandEntity).findOne({ where: { id: quote.demandId } });
    if (demand) {
      const userRepo = (ds.getRepository as any)(require('../entities').UserEntity);
      const user = await userRepo.findOne({ where: { id: demand.userId } });
      if (user?.phone) {
        await (smsGateway as any).sendTemplateSms!({
          phone: user.phone,
          templateKey: 'quote_cancelled_user',
          variables: { installerName: installer.realName },
        });
      }
    }

    res.json({ code: 0, data: { ok: true } });
  } catch (e: any) {
    log(`[INSTALLER] complete ERROR order=${id}: ${e?.message}\n${e?.stack?.slice(0, 500)}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ⑩ GET /installer/orders — 我的安装订单师傅的安装订单列表
router.get('/orders', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const tab = (req.query.tab as string) || 'all'; // all / pending / in_progress / completed

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { list: [], total: 0 });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const repo = ds.getRepository(InstallationOrderEntity);
    const where: any = { installerId: installer.id };
    if (tab === 'pending') {where.status = 'pending';}
    else if (tab === 'in_progress') {where.status = 'in_progress';}
    else if (tab === 'completed') {where.status = In(['completed', 'reviewed']);}

    const list = await repo.find({ where, order: { createdAt: 'DESC' } });
    res.json({ code: 0, data: list });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑥ GET /installer/orders/:id — 订单详情
router.get('/orders/:id', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ code: 400 }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, null);

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const order = await ds.getRepository(InstallationOrderEntity).findOne({
      where: { id, installerId: installer.id },
    });
    if (!order) { res.status(404).json({ code: 404 }); return; }

    // 带上 demand 信息
    const demand = await ds.getRepository(InstallationDemandEntity).findOne({ where: { id: order.demandId } });
    res.json({ code: 0, data: { ...order, demand } });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑦ POST /installer/orders/:id/start — 师傅标记开工
router.post('/orders/:id/start', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ code: 400 }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { id: String(id), ok: true });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const repo = ds.getRepository(InstallationOrderEntity);
    const order = await repo.findOne({ where: { id, installerId: installer.id, status: 'pending' } });
    if (!order) { res.status(404).json({ code: 404, msg: '订单不存在或状态不允许' }); return; }

    order.status = 'in_progress';
    order.startedAt = new Date();
    await repo.save(order);

    // SSE：师傅开工 → 推给用户
    if (order.userId) {
      eventBus.emit('order_started', 'user', order.userId, {
        orderId: order.id, orderNo: order.orderNo, installerId: installer.id,
      });
    }

    res.json({ code: 0, data: { ok: true } });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ============================================================================
// ✅ 第四批：师傅上传现场施工进度照（5 阶段）
// ============================================================================

// ⑦.5 POST /installer/orders/:id/progress — 师傅上传当前阶段现场照
// body: { stage: number (0-4), photos: string[], note?: string }
router.post('/orders/:id/progress', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { stage, photos = [], note = '' } = req.body as any;
  if (!id) { return badRequest(res, '订单 ID 无效'); }
  if (typeof stage !== 'number' || stage < 0 || stage > 5) { return badRequest(res, 'stage 必须是 0-5 的数字'); }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { id: String(id), ok: true });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) { return; }

    const repo = ds.getRepository(InstallationOrderEntity);
    const order = await repo.findOne({
      where: { id, installerId: installer.id, status: In(['pending', 'in_progress']) },
    });
    if (!order) { return notFound(res, '订单不存在或状态不允许'); }

    // 阶段约束：不能跳阶段（可以重复上传同一阶段更新照片）
    if (stage > order.currentStage + 1) {
      return badRequest(res, `不能跳过阶段（当前 stage=${order.currentStage}）`);
    }

    // 更新阶段 + 照片
    order.currentStage = stage;
    const stagePhotos: any = order.stagePhotos ? JSON.parse(JSON.stringify(order.stagePhotos)) : {};
    stagePhotos[String(stage)] = {
      photos: Array.isArray(photos) ? photos : [],
      note: note || '',
      uploadedAt: new Date().toISOString(),
    };
    order.stagePhotos = stagePhotos;
    if (note) { order.progressNote = note; }

    // 自动从 pending → in_progress（师傅传了任何阶段的照片就算开工）
    if (order.status === 'pending' && stage >= 1) {
      order.status = 'in_progress';
      order.startedAt = order.startedAt || new Date();
    }

    await repo.save(order);

    // SSE：进度推给买家
    eventBus.emit('install_progress', 'user', order.userId, {
      orderId: order.id, stage, stagePhotos: stagePhotos[String(stage)],
    });

    // chat 卡片（静默失败）
    try {
      await writeCardMessage({
        refType: 'installation_order',
        refId: order.id,
        partyA: order.userId,
        partyB: installer.userId,
        cardType: 'progress',
        cardData: { stage, photos, note },
      });
    } catch { /* 静默 */ }

    ok(res, { ok: true, currentStage: order.currentStage });
  } catch (e: any) {
    log(`[Installer] progress error: ${e.message}`, 'error');
    serverError(res, '上传失败');
  }
});

// ============================================================================
// ⑧ POST /installer/orders/:id/complete — 师傅标记"施工完成"（带 chat 卡片）
// ============================================================================
router.post('/orders/:id/complete', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ code: 400 }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { id: String(id), ok: true });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const repo = ds.getRepository(InstallationOrderEntity);
    const order = await repo.findOne({ where: { id, installerId: installer.id, status: In(['pending', 'in_progress']) } });
    if (!order) { res.status(404).json({ code: 404, msg: '订单不存在或状态不允许' }); return; }

    order.status = 'completed';
    order.completedAt = new Date();
    order.currentStage = 4; // 竣工验收完成

    // ✅ Sprint 8：自动激活 90 天质保
    const expireAt = new Date(Date.now() + WARRANTY_CONFIG.days * 24 * 3600 * 1000);
    order.warrantyStatus = 'active';
    order.warrantyExpireAt = expireAt;
    // 5% 质保金 = finalPrice * (1 - 12%抽佣后) * 5% ≈ finalPrice * 0.88 * 0.05
    order.warrantyHoldAmount = Number((order.finalPrice * 0.88 * WARRANTY_CONFIG.holdRate).toFixed(2));

    await repo.save(order);

    // 师傅已完成订单数 +1
    installer.completedOrders += 1;
    await ds.getRepository(InstallerProfileEntity).save(installer);

    // — 💰 自动结算：生成 settle 单 → 师傅 earnings 冻结 7 天 + 质保金扣 5% —
    try {
      const { buildSettle, settle } = await import('../services/settle');
      const settleOrder = buildSettle(
        String(order.id),
        'install',
        installer.userId,
        'installer',
        Number(order.finalPrice),
        'none',
        installer.completedOrders - 1, // this installer's monthly volume
      );
      await settle(settleOrder);
    } catch (settleErr: any) {
      log(`[INSTALLER] settle error order=${order.orderNo}: ${settleErr.message}`, 'error');
    }

    // 通知用户（含质保提示）
    const demand = await ds.getRepository(InstallationDemandEntity).findOne({ where: { id: order.demandId } });
    if (demand) {
      // SSE 实时推（附带质保信息）
      eventBus.emit('order_completed', 'user', demand.userId, {
        orderId: order.id, orderNo: order.orderNo, installerName: installer.realName,
        warrantyDays: WARRANTY_CONFIG.days, warrantyExpireAt: expireAt.toISOString().slice(0, 10),
        holdAmount: order.warrantyHoldAmount,
      });
      // SMS 兜底（附带质保提示）
      const userRepo = (ds.getRepository as any)(require('../entities').UserEntity);
      const user = await userRepo.findOne({ where: { id: demand.userId } });
      if (user?.phone) {
        await (smsGateway as any).sendTemplateSms!({
          phone: user.phone,
          templateKey: 'order_completed',
          variables: { installerName: installer.realName },
        });
      }

      // 🆕 installer_completed 事件（单独给前端区分"师傅已完成"和"买家已验收"）
      eventBus.emit('installer_completed', 'user', demand.userId, {
        orderId: order.id, orderNo: order.orderNo,
      });

      // 🆕 chat 卡片：请买家验收
      try {
        await writeCardMessage({
          refType: 'installation_order',
          refId: order.id,
          partyA: demand.userId,
          partyB: installer.userId,
          cardType: 'confirm',
          cardData: {
            title: '请验收安装施工',
            description: '师傅已完成施工，请验收后确认',
          },
        });
      } catch { /* 静默 */ }
    }

    res.json({
      code: 0,
      data: {
        ok: true,
        warranty: {
          status: 'active',
          days: WARRANTY_CONFIG.days,
          expireAt: expireAt.toISOString().slice(0, 10),
          holdAmount: order.warrantyHoldAmount,
          holdRate: `${(WARRANTY_CONFIG.holdRate * 100).toFixed(0)}%`,
        },
      },
    });
  } catch (e: any) {
    log(`[INSTALLER] complete ERROR orderId=${id}: ${e?.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ⑩ installer profile 更新

// ⑨ GET /installer/profile — 我的师傅资料
router.get('/profile', requireAuth, requirePendingInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    const u = (db.users as any[]).find((x: any) => Number(x.id) === userId);
    return ok(res, { nickname: u?.nickname || '', avatar: u?.avatar || '' });
  }

  try {
    const profile = await getInstaller(userId, ds, res);
    if (!profile) {return;}

    const specs = await ds.getRepository(InstallerSpecialtyEntity).find({ where: { installerId: profile.id } });
    res.json({ code: 0, data: { ...profile, specialties: specs } });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑩ PUT /installer/profile — 更新资料（服务半径/擅长分类）
router.put('/profile', requireAuth, requirePendingInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { serviceRadiusKm, specialtyCategoryIds, realName, avatar, serviceAddress, serviceLat, serviceLng } = req.body as any;

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { ok: true });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const updater: any = {};
    if (serviceRadiusKm != null) {updater.serviceRadiusKm = serviceRadiusKm;}
    if (realName) {updater.realName = realName;}
    if (avatar !== undefined) {updater.avatar = avatar;}
    if (serviceAddress !== undefined) {updater.serviceAddress = serviceAddress;}
    if (serviceLat != null) {updater.serviceLat = serviceLat;}
    if (serviceLng != null) {updater.serviceLng = serviceLng;}

    if (Object.keys(updater).length > 0) {
      Object.assign(installer, updater);
      await ds.getRepository(InstallerProfileEntity).save(installer);
    }

    if (Array.isArray(specialtyCategoryIds)) {
      const specRepo = ds.getRepository(InstallerSpecialtyEntity);
      await specRepo.delete({ installerId: installer.id });
      if (specialtyCategoryIds.length > 0) {
        const specs = specialtyCategoryIds.map(cid => specRepo.create({
          installerId: installer.id, categoryId: cid, level: 1, yearsExp: 1,
        }));
        await specRepo.save(specs);
      }
    }

    res.json({ code: 0, data: { ok: true } });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑪ GET /installer/earnings — ✅ 抽佣计算 + VIP 等级 + 阶梯单价
router.get('/earnings', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { summary: { totalIncome: 0, withdrawAmount: 0, pendingAmount: 0 }, list: [], trend: [] });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const orders = await ds.getRepository(InstallationOrderEntity).find({
      where: { installerId: installer.id, status: In(['completed', 'reviewed']) },
    });

    // 真实抽佣：基础 15% + VIP 折扣 + 阶梯折扣
    const monthlyOrders = orders.length; // 简化：直接用完成数
    const vip = calcVipLevel(installer.completedOrders || 0, installer.rating || 0);
    const tierSave = tierDiscount(monthlyOrders);
    const baseRate = COMMISSION_RATES.install.base;
    let finalRate = baseRate - vip.monthlyDiscount - tierSave;
    finalRate = Math.max(0.04, finalRate);

    const records = orders.map((o: any) => {
      const gross = Number(o.finalPrice) || 0;
      const commission = Number((gross * finalRate).toFixed(2));
      const providerGet = Number((gross - commission).toFixed(2));
      return {
        id: String(o.id), orderNo: o.orderNo || '', title: '安装服务费',
        amount: gross, commission, providerGet, rate: Number(finalRate.toFixed(4)),
        createdAt: o.updatedAt, status: 'settled',
        // ✅ 质保字段
        warrantyStatus: o.warrantyStatus || 'none',
        warrantyHoldAmount: Number(o.warrantyHoldAmount || 0),
        warrantyExpireAt: o.warrantyExpireAt,
      };
    });

    // ✅ 质保聚合统计（收入页展示"质保扣留"）
    let warrantyHeld = 0;       // 当前被扣住的总质保金（active + claimed + arbitrated）
    let warrantyPendingRelease = 0; // active 状态（90天到期自动释放）
    let warrantyClaimed = 0;    // claimed/arbitrated（索赔处理中）
    for (const o of orders) {
      if (o.warrantyHoldAmount && o.warrantyStatus !== 'none' && o.warrantyStatus !== 'expired' && o.warrantyStatus !== 'settled') {
        warrantyHeld += Number(o.warrantyHoldAmount);
        if (o.warrantyStatus === 'active') {warrantyPendingRelease += Number(o.warrantyHoldAmount);}
        else {warrantyClaimed += Number(o.warrantyHoldAmount);}
      }
    }

    const grossTotal = records.reduce((s, r) => s + r.amount, 0);
    const commissionTotal = records.reduce((s, r) => s + r.commission, 0);
    const available = records.reduce((s, r) => s + r.providerGet, 0);

    res.json({
      code: 0,
      data: {
        available: Number(available.toFixed(2)),
        frozen: 0,
        monthIncome: Number(available.toFixed(2)),
        total: Number(available.toFixed(2)),
        grossTotal: Number(grossTotal.toFixed(2)),
        commissionTotal: Number(commissionTotal.toFixed(2)),
        rate: Number(finalRate.toFixed(4)),
        baseRate,
        vipDiscount: vip.monthlyDiscount,
        tierDiscount: tierSave,
        vip,
        completedCount: orders.length,
        rating: installer.rating,
        ratingCount: installer.ratingCount,
        // ✅ 质保聚合
        warrantyHeld: Number(warrantyHeld.toFixed(2)),
        warrantyPendingRelease: Number(warrantyPendingRelease.toFixed(2)),
        warrantyClaimed: Number(warrantyClaimed.toFixed(2)),
        warrantyRate: WARRANTY_CONFIG.holdRate,
        warrantyDays: WARRANTY_CONFIG.days,
        records,
      },
    });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ============================================================================
// ✅ Sprint 8：90 天质保索赔
// ============================================================================

// ⑨ GET /installer/warranty-claims — 我的质保索赔列表（师傅端）
router.get('/warranty-claims', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, []);

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const repo = ds.getRepository(WarrantyClaimEntity);
    const list = await repo.find({
      where: { installerId: installer.id },
      order: { createdAt: 'DESC' },
      take: 50,
    });

    res.json({ code: 0, data: list });
  } catch (e: any) {
    log(`[Warranty] claims list error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});

// ⑩ GET /installer/warranty-claims/:id — 索赔详情
router.get('/warranty-claims/:id', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ code: 400 }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, null);

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const claim = await ds.getRepository(WarrantyClaimEntity).findOne({
      where: { id, installerId: installer.id },
    });
    if (!claim) { res.status(404).json({ code: 404, msg: '索赔不存在' }); return; }

    res.json({ code: 0, data: claim });
  } catch (e: any) {
    res.status(500).json({ code: 500 });
  }
});

// ⑪ POST /installer/warranty-claims/:id/respond — 师傅响应索赔
router.post('/warranty-claims/:id/respond', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { action, response } = req.body as any;
  if (!id || !action) { res.status(400).json({ code: 400 }); return; }
  if (!['accept', 'reject'].includes(action)) { res.status(400).json({ code: 400, msg: 'action 必须是 accept 或 reject' }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { id: String(id), ok: true });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) {return;}

    const repo = ds.getRepository(WarrantyClaimEntity);
    const claim = await repo.findOne({ where: { id, installerId: installer.id, status: 'pending' } });
    if (!claim) { res.status(404).json({ code: 404, msg: '索赔不存在或已处理' }); return; }

    claim.status = action === 'accept' ? 'accepted' : 'rejected';
    claim.installerResponse = response || (action === 'accept' ? '已接受，将尽快上门' : '人为损坏，不在保修范围');
    claim.installerRespondAt = new Date();
    await repo.save(claim);

    // 如果 reject：师傅拒绝 → 自动升级 admin 仲裁（status → arbitrated）
    // 简化版：reject 时改 status 为 arbitrated，等 admin 介入
    if (action === 'reject') {
      claim.status = 'arbitrated';
      claim.resolution = '师傅拒绝，等待平台仲裁';
      await repo.save(claim);
      log(`[Warranty] claim ${claim.claimNo} rejected by installer ${installer.id}, auto-arbitrated`, 'info');
    }

    // 通知用户
    eventBus.emit('warranty_claim_responded', 'user', claim.userId, {
      claimId: claim.id,
      claimNo: claim.claimNo,
      action,
      installerResponse: claim.installerResponse,
    });

    res.json({ code: 0, data: { ok: true, status: claim.status } });
  } catch (e: any) {
    log(`[Warranty] respond error: ${e.message}`, 'error');
    res.status(500).json({ code: 500 });
  }
});


// GET /installer/quotes — 我的报价列表
router.get('/quotes', requireAuth, requireInstaller, async (req, res) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { list: [], total: 0 });
  try {
    const repo = ds.getRepository(InstallationQuoteEntity);
    const list = await repo.find({ where: { installerId: req.userId }, order: { createdAt: 'DESC' } });
    res.json({ code: 0, data: { list: list.map(q => ({
      id: (q as any).id, demandId: (q as any).demandId, price: (q as any).price,
      eta: (q as any).eta, description: (q as any).description, status: (q as any).status,
      createdAt: (q as any).createdAt,
    })), total: list.length } });
  } catch (e: any) { res.status(500).json({ code: 500, msg: e.message }); }
});

// ============================================================================
// 🛠️ Week 1 补：Installer 提现（抄 vendor withdraw 同构，providerRole=installer）
// ============================================================================

/** POST /api/installer/withdraw — 师傅提现申请 */
router.post('/withdraw', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { amount, bankName, cardNo, fee } = req.body as any;

  const amt = Number(amount);
  if (!amt || amt <= 0) return badRequest(res, '提现金额无效');
  if (!bankName?.trim() || !cardNo?.trim()) return badRequest(res, '请填写银行卡信息');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { withdrawNo: 'MOCK' + Date.now(), amount: 0, ok: true });

  try {
    const { SettleOrderEntity, WithdrawRequestEntity } = await import('../entities/index');
    const role = 'installer';

    // 1. 查可用余额（SettleOrderEntity.providerRole=installer status=available）
    const availRow = await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .where('s.providerId=:pid AND s.providerRole=:role AND s.status=:st',
        { pid: userId, role, st: 'available' })
      .select('SUM(s.providerGet)', 'sum').getRawOne();
    const available = Number(availRow?.sum || 0);
    if (amt > available) return fail(res, 422, `可用余额不足（可提现 ${available.toFixed(2)}）`, 422);

    // 2. 创建提现单（WithdrawRequestEntity.vendorId 复用存 installer userId）
    const feeAmt = Number(fee || (amt * 0.006).toFixed(2));
    const actual = Number((amt - feeAmt).toFixed(2));
    const withdrawNo = 'WD' + Date.now() + Math.floor(Math.random() * 1000);
    const wRepo = ds.getRepository(WithdrawRequestEntity);
    await wRepo.save({
      withdrawNo, vendorId: userId, providerRole: 'installer',
      amount: amt, fee: feeAmt, actualAmount: actual,
      bankName: bankName.trim(), cardNo: cardNo.trim(), status: 'pending',
    });

    // 3. 冻结对应结算单（status → withdrawn）
    await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .update(SettleOrderEntity)
      .set({ status: 'withdrawn' })
      .where('s.providerId=:pid AND s.providerRole=:role AND s.status=:st',
        { pid: userId, role, st: 'available' })
      .execute();

    log(`[Installer] withdraw userId=${userId} amt=${amt} actual=${actual} no=${withdrawNo}`);
    ok(res, { withdrawNo, amount: amt, actualAmount: actual, fee: feeAmt, bankName: bankName.trim() });
  } catch (e: any) {
    log(`[Installer] withdraw error: ${e.message}`, 'error');
    serverError(res, '提现申请失败');
  }
});

/** GET /api/installer/withdraw-info — 提现页信息（可用余额 + 最近 5 条）*/
router.get('/withdraw-info', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { available: 0, recent: [] });
  try {
    const { SettleOrderEntity, WithdrawRequestEntity } = await import('../entities/index');
    const role = 'installer';

    const availRow = await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .where('s.providerId=:pid AND s.providerRole=:role AND s.status=:st',
        { pid: req.userId, role, st: 'available' })
      .select('SUM(s.providerGet)', 'sum').getRawOne();
    const available = Number(availRow?.sum || 0);

    const recent = await ds.getRepository(WithdrawRequestEntity).find({
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
    log(`[Installer] withdraw-info error: ${e.message}`, 'error');
    serverError(res, '提现信息加载失败');
  }
});

// ============================================================================
// Sprint 10 — bank-cards 三项后端：列表 / 新增 / 解绑 / 设默认
// ============================================================================

// — GET /bank-cards — 列表 —
router.get('/bank-cards', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, []);
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const list = await repo.find({ where: { userId: req.userId!, role: 'installer', status: 'active' }, order: { isDefault: 'DESC', createdAt: 'DESC' } });
    ok(res, { list });
  } catch (e: any) { log(`[Installer] bank-cards error: ${e.message}`, 'error'); serverError(res, '查询失败'); }
});

// — POST /bank-cards — 新增 —
router.post('/bank-cards', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const { bankName, cardNo, accountName, branchName } = req.body || {};
  if (!bankName?.trim() || !cardNo?.trim() || !accountName?.trim()) return badRequest(res, '银行/卡号/持卡人必填');
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: '', ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const count = await repo.count({ where: { userId: req.userId!, role: 'installer', status: 'active' } });
    if (count >= 5) return fail(res, 400, '最多绑定 5 张银行卡');
    // 脱敏：**** + 后 4 位
    const masked = '****' + cardNo.trim().slice(-4);
    // 如果是第一张，自动设默认
    let isDefault = count === 0 ? 1 : 0;
    // 如果新增时选了默认，先清掉旧默认
    if (req.body.isDefault) {
      await repo.createQueryBuilder().update().set({ isDefault: 0 }).where('userId=:uid AND role=:role AND isDefault=1', { uid: req.userId!, role: 'installer' }).execute();
      isDefault = 1;
    }
    const entity = repo.create({
      userId: req.userId!, role: 'installer',
      bankName: bankName.trim(), cardNo: cardNo.trim(), cardNoMasked: masked,
      accountName: accountName.trim(), branchName: branchName?.trim() || '',
      isDefault, status: 'active',
    });
    const saved = await repo.save(entity);
    ok(res, { success: true, card: saved });
  } catch (e: any) { log(`[Installer] bank-cards add error: ${e.message}`, 'error'); serverError(res, '绑卡失败'); }
});

// — DELETE /bank-cards/:id — 解绑 —
router.delete('/bank-cards/:id', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const card = await repo.findOne({ where: { id, userId: req.userId!, role: 'installer' } });
    if (!card) return notFound(res, '银行卡不存在');
    card.status = 'disabled';
    await repo.save(card);
    ok(res, { success: true });
  } catch (e: any) { log(`[Installer] bank-cards delete error: ${e.message}`, 'error'); serverError(res, '解绑失败'); }
});

// — POST /bank-cards/:id/default — 设为默认 —
router.post('/bank-cards/:id/default', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const card = await repo.findOne({ where: { id, userId: req.userId!, role: 'installer', status: 'active' } });
    if (!card) return notFound(res, '银行卡不存在');
    await repo.createQueryBuilder().update().set({ isDefault: 0 }).where('userId=:uid AND role=:role', { uid: req.userId!, role: 'installer' }).execute();
    card.isDefault = 1;
    await repo.save(card);
    ok(res, { success: true });
  } catch (e: any) { log(`[Installer] bank-cards default error: ${e.message}`, 'error'); serverError(res, '设置失败'); }
});

// — POST /bank-cards/:id — 更新 branchName / accountName / isDefault（cardNo 安全字段不允许改）—
router.post('/bank-cards/:id', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const id = Number(req.params.id);
  const { branchName, accountName, isDefault } = req.body || {};
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const role = 'installer';
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
  } catch (e: any) { log(`[installer] bank-cards update error: ${e.message}`, 'error'); serverError(res, '更新失败'); }
});

// ============================================================================
// 🆕 GET /api/installer/dashboard — 师傅工作台聚合数据
// ============================================================================
router.get('/dashboard', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, {
    activeQuotes: 0, acceptedQuotes: 0,
    activeOrders: 0, completedOrders: 0,
    warrantyClaims: 0,
    withdrawInfo: { available: 0, frozen: 0 },
    totalInstalls: 0, avgRating: null,
    todos: [
      { type: 'active_orders', count: 0, label: '进行中' },
      { type: 'warranty_claim', count: 0, label: '待处理质保' },
    ],
  });

  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) return;

    const { InstallationQuoteEntity, InstallationOrderEntity, WarrantyClaimEntity, SettleOrderEntity, DisputeEntity } = await import('../entities');
    const instId = installer.id;

    // — 报价聚合 —
    const quoteRepo = ds.getRepository(InstallationQuoteEntity);
    const [activeQuotes, acceptedQuotes] = await Promise.all([
      quoteRepo.createQueryBuilder('q')
        .where('q.installerId = :iid AND q.status = :st', { iid: instId, st: 'pending' })
        .getCount().catch(() => 0),
      quoteRepo.createQueryBuilder('q')
        .where('q.installerId = :iid AND q.status = :st', { iid: instId, st: 'accepted' })
        .getCount().catch(() => 0),
    ]);

    // — 订单聚合 —
    const orderRepo = ds.getRepository(InstallationOrderEntity);
    const [activeOrders, completedOrders] = await Promise.all([
      orderRepo.createQueryBuilder('o')
        .where('o.installerId = :iid AND o.status IN (:...sts)',
          { iid: instId, sts: ['pending', 'in_progress'] })
        .getCount().catch(() => 0),
      orderRepo.createQueryBuilder('o')
        .where('o.installerId = :iid AND o.status IN (:...sts)',
          { iid: instId, sts: ['completed', 'reviewed'] })
        .getCount().catch(() => 0),
    ]);

    // — 待处理质保索赔 —
    const warrantyClaims = await ds.getRepository(WarrantyClaimEntity).createQueryBuilder('w')
      .where('w.installerId = :iid AND w.status = :st', { iid: instId, st: 'pending' })
      .getCount().catch(() => 0);

    // — 财务 —
    const settleRepo = ds.getRepository(SettleOrderEntity);
    const [availableRow, frozenRow] = await Promise.all([
      settleRepo.createQueryBuilder('s')
        .where('s.providerId=:uid AND s.providerRole=:role AND s.status=:st',
          { uid: userId, role: 'installer', st: 'available' })
        .select('COALESCE(SUM(s.providerGet),0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
      settleRepo.createQueryBuilder('s')
        .where('s.providerId=:uid AND s.providerRole=:role AND s.status IN (:...sts)',
          { uid: userId, role: 'installer', sts: ['frozen', 'released'] })
        .select('COALESCE(SUM(s.providerGet),0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
    ]);

    // — 服务统计 —
    const totalInstalls = Number(installer.completedOrders || 0);
    const avgRating = Number(installer.ratingCount || 0) > 0 ? Number(installer.rating) : null;

    // — 纠纷 —
    const pendingDisputes = await ds.getRepository(DisputeEntity).createQueryBuilder('d')
      .where('d.providerId = :uid AND d.providerRole = :role AND d.status IN (:...sts)',
        { uid: userId, role: 'installer', sts: ['pending', 'processing'] })
      .getCount().catch(() => 0);

    ok(res, {
      activeQuotes: Number(activeQuotes || 0),
      acceptedQuotes: Number(acceptedQuotes || 0),
      activeOrders: Number(activeOrders || 0),
      completedOrders: Number(completedOrders || 0),
      warrantyClaims: Number(warrantyClaims || 0),
      withdrawInfo: {
        available: Number(availableRow?.sum || 0),
        frozen: Number(frozenRow?.sum || 0),
      },
      totalInstalls,
      avgRating,
      todos: [
        { type: 'active_orders', count: Number(activeOrders || 0), label: '进行中' },
        { type: 'warranty_claim', count: Number(warrantyClaims || 0), label: '待处理质保' },
        { type: 'pending_dispute', count: Number(pendingDisputes || 0), label: '待响应纠纷' },
      ],
    });
  } catch (e: any) {
    log(`[installer/dashboard] error: ${e.message}`, 'error');
    serverError(res, '仪表盘数据加载失败');
  }
});

// ============================================================================
// 🆕 Installer Specialties CRUD — 师傅专长标签
// ============================================================================

// GET /api/installer/specialties — 查自己的专长标签列表
router.get('/specialties', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, []);
  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) return;
    const repo = ds.getRepository(InstallerSpecialtyEntity);
    const list = await repo.find({ where: { installerId: installer.id }, order: { createdAt: 'ASC' } });
    ok(res, list);
  } catch (e: any) {
    log(`[installer/specialties GET] error: ${e.message}`, 'error');
    serverError(res, '专长列表加载失败');
  }
});

// POST /api/installer/specialties — 全量替换专长标签
// body: { specialties: (string|number)[] }
//   支持两种写法：
//   - { specialties: [1, 2, 3] } — categoryId 数组
//   - { specialties: ['1','2','3'] } — 数字字符串
//   - 兼容 { specialtyCategoryIds: [...] } 老字段
router.post('/specialties', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const { specialties, specialtyCategoryIds } = req.body || {};
  const rawList = specialties ?? specialtyCategoryIds;

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { ok: true });
  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) return;

    if (!Array.isArray(rawList)) return badRequest(res, 'specialties 必须是数组');

    // 清洗：只保留合法数字 categoryId
    const categoryIds: number[] = [];
    for (const v of rawList) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) categoryIds.push(n);
    }

    const specRepo = ds.getRepository(InstallerSpecialtyEntity);
    // 先清空旧的
    await specRepo.delete({ installerId: installer.id });
    if (categoryIds.length > 0) {
      const specs = categoryIds.map(cid => specRepo.create({
        installerId: installer.id,
        categoryId: cid,
        level: 1,
        yearsExp: 1,
      }));
      await specRepo.save(specs);
    }

    // 回读最新列表
    const list = await specRepo.find({ where: { installerId: installer.id }, order: { createdAt: 'ASC' } });
    ok(res, list, '专长已更新');
  } catch (e: any) {
    log(`[installer/specialties POST] error: ${e.message}`, 'error');
    serverError(res, '更新专长失败');
  }
});

// DELETE /api/installer/specialties/:id — 删除单个专长
router.delete('/specialties/:id', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, 'id 参数无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { ok: true });
  try {
    const installer = await getInstaller(userId, ds, res);
    if (!installer) return;

    const repo = ds.getRepository(InstallerSpecialtyEntity);
    const sp = await repo.findOne({ where: { id, installerId: installer.id } });
    if (!sp) return notFound(res, '专长条目不存在');

    await repo.delete({ id });
    ok(res, { id }, '专长已删除');
  } catch (e: any) {
    log(`[installer/specialties DELETE] error: ${e.message}`, 'error');
    serverError(res, '删除专长失败');
  }
});

// ============================================================================
// 🆕 Sprint 14 — Installer 纠纷响应入口（providerRole=installer, providerId=me）
// GET    /api/installer/disputes            — 分页列表 + tab 过滤 + 聚合统计
// GET    /api/installer/disputes/:id        — 详情（带 timeline/messages）
// POST   /api/installer/disputes/:id/respond — 角色方补充资料/解释
// ============================================================================

const INSTALLER_DISPUTE_ROLE = 'installer' as const;

function mapInstallerDisputeTimeline(d: any) {
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

router.get('/disputes', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const tab = String(req.query.tab || 'all');
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));

  const ds = getDataSource();
  const role = INSTALLER_DISPUTE_ROLE;

  try {
    if (ds?.isInitialized) {
      const { DisputeEntity } = await import('../entities');
      const repo = ds.getRepository(DisputeEntity);
      const qb = repo.createQueryBuilder('d')
        .where('d.providerId = :uid AND d.providerRole = :role', { uid: userId, role });
      if (['pending', 'processing', 'resolved'].includes(tab)) {
        qb.andWhere('d.status = :st', { st: tab });
      }
      qb.orderBy('d.id', 'DESC').skip((page - 1) * size).take(size);
      const [rows, total] = await qb.getManyAndCount();

      const pendingCount = await repo.createQueryBuilder('d')
        .where('d.providerId = :uid AND d.providerRole = :role AND d.status IN (:...sts)',
          { uid: userId, role, sts: ['pending', 'processing'] })
        .getCount().catch(() => 0);

      ok(res, {
        list: rows.map(mapInstallerDisputeTimeline),
        total, page, size,
        summary: { pendingCount: Number(pendingCount || 0), totalCount: Number(total) },
      });
    } else {
      const list: any[] = (db.disputes || [])
        .filter((d: any) => Number(d.providerId) === userId && d.providerRole === role);
      const filtered = ['pending', 'processing', 'resolved'].includes(tab)
        ? list.filter(d => d.status === tab) : list;
      filtered.sort((a, b) => Number(b.id) - Number(a.id));
      const total = filtered.length;
      const rows = filtered.slice((page - 1) * size, page * size);
      const pendingCount = list.filter(d => ['pending', 'processing'].includes(d.status)).length;

      ok(res, {
        list: rows.map(mapInstallerDisputeTimeline),
        total, page, size,
        summary: { pendingCount, totalCount: list.length },
      });
    }
  } catch (e: any) {
    log(`[installer/disputes] error: ${e.message}`, 'error');
    serverError(res, '纠纷列表加载失败');
  }
});

router.get('/disputes/:id', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '纠纷 ID 无效');

  const ds = getDataSource();
  const role = INSTALLER_DISPUTE_ROLE;

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
    ok(res, mapInstallerDisputeTimeline(d));
  } catch (e: any) {
    log(`[installer/disputes/:id] error: ${e.message}`, 'error');
    serverError(res, '纠纷详情加载失败');
  }
});

router.post('/disputes/:id/respond', requireAuth, requireInstaller, async (req: AuthedRequest, res: Response) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { message } = req.body || {};
  if (!id) return badRequest(res, '纠纷 ID 无效');
  if (!message || String(message).trim().length < 3) {
    return badRequest(res, '响应内容至少 3 个字');
  }

  const ds = getDataSource();
  const role = INSTALLER_DISPUTE_ROLE;

  try {
    let d: any = null;
    if (ds?.isInitialized) {
      const { DisputeEntity } = await import('../entities');
      const repo = ds.getRepository(DisputeEntity);
      d = await repo.findOne({ where: { id, providerId: userId, providerRole: role } });
      if (!d) return notFound(res, '纠纷不存在或无权操作');

      const msgs: any[] = Array.isArray(d.messages) ? [...d.messages] : [];
      msgs.push({ role: 'provider', userId, message: String(message).trim(), createdAt: new Date().toISOString() });
      d.messages = msgs;
      if (d.status === 'pending') d.status = 'processing';
      d.updatedAt = new Date();
      const saved = await repo.save(d);

      try {
        const { AuditLogEntity } = await import('../entities');
        await ds.getRepository(AuditLogEntity).save({
          action: 'installer.dispute.respond', targetType: 'dispute', targetId: String(id), userId,
          detail: { message: String(message).trim() },
        });
      } catch {}

      log(`[installer] dispute ${id} responded by userId=${userId}`);
      ok(res, { id: saved.id, status: saved.status }, '响应已提交');
    } else {
      const list: any[] = db.disputes || [];
      d = list.find((x: any) => Number(x.id) === id
        && Number(x.providerId) === userId && x.providerRole === role);
      if (!d) return notFound(res, '纠纷不存在或无权操作');

      const msgs: any[] = Array.isArray(d.messages) ? [...d.messages] : [];
      msgs.push({ role: 'provider', userId, message: String(message).trim(), createdAt: new Date().toISOString() });
      d.messages = msgs;
      if (d.status === 'pending') d.status = 'processing';
      d.updatedAt = new Date().toISOString();
      log(`[installer:mem] dispute ${id} responded by userId=${userId}`);
      ok(res, { id: d.id, status: d.status }, '响应已提交');
    }
  } catch (e: any) {
    log(`[installer/disputes respond] error: ${e.message}`, 'error');
    serverError(res, '响应提交失败');
  }
});

export default router;

