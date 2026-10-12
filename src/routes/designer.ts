// ============================================================================
// 🎨 Designer Routes — 设计师端独立路由
// ============================================================================
import { Router } from 'express';
import { In } from 'typeorm';
import { requireAuth, requireDesigner, requirePendingDesigner, ok, fail, badRequest, notFound, serverError, AuthedRequest } from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { db } from '../db';
import { findUserByIdORM, getDesignDemandHallORM, listDemandORM } from '../db-orm';
import { DesignDemandEntity } from '../entities/sprint3';
import { UserEntity } from '../entities';
import { DesignerProfileEntity } from '../entities/sprint5';
import { calcVipLevel } from '../services/dispatch';
import { COMMISSION_RATES } from '../services/settle';
import { log } from '../logger';

const router = Router();

// — 📐 Sprint 9：设计类型/风格/交付物 key → 中文 —
const DESIGN_TYPE_CN: Record<string, string> = {
  logo: 'LOGO 设计', vi: 'VI 品牌识别', poster: '海报/单张',
  packaging: '包装设计', banner: 'Banner/广告图', menu: '菜单/宣传单',
  card: '名片', ppt: 'PPT 模板', ecommerce: '电商详情/主图',
};
const STYLE_CN: Record<string, string> = {
  minimal: '简约', retro: '复古怀旧', guochao: '国潮插画', business: '商务稳重',
  illustration: '手绘插画', '3d': '3D 立体', flat: '扁平风', luxury: '高级奢华',
};
const DELIVERABLE_CN: Record<string, string> = {
  '1draft': '1 稿无修改', '3draft': '3 稿 + 小改 2 次', '5draft': '5 稿 + 源文件', unlimited: '不限稿 + 源文件',
};
const LICENSE_CN: Record<string, string> = {
  personal: '仅个人使用', commercial: '商用授权', exclusive: '独家商用',
};

// — 📐 Sprint 9：设计师查看需求详情（后端之前完全没有这个路由！前端一直 mock）—
router.get('/demand-detail/:id', requireAuth, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!id) { res.status(400).json({ code: 400, msg: '参数错误' }); return; }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, null);

  try {
    const repo = ds.getRepository(DesignDemandEntity);
    const d = await repo.findOne({ where: { id } });
    if (!d) { res.status(404).json({ code: 404, msg: '需求不存在' }); return; }

    // 📐 Sprint 9：同时返回 entity 全字段（结构化）+ DEFAULT_DEMAND 兼容字段名
    const data: any = { ...d };

    // — DEFAULT_DEMAND 兼容（前端 { ...DEFAULT_DEMAND, ...r } 展开）—
    data.title = DESIGN_TYPE_CN[d.designCategory || ''] || d.demandText.slice(0, 30);
    data.desc = d.demandText;
    data.tags = [
      d.designCategory && { text: DESIGN_TYPE_CN[d.designCategory] || d.designCategory },
      ...((d.styleTags || []).map((s: string) => ({ text: STYLE_CN[s] || s }))),
    ].filter(Boolean);
    data.specs = [
      { label: '设计类型', value: DESIGN_TYPE_CN[d.designCategory || ''] || '—' },
      { label: '交付周期', value: d.deliveryTime || '—' },
      { label: '交付物', value: DELIVERABLE_CN[d.deliverables || ''] || '—' },
      { label: '商用授权', value: LICENSE_CN[d.commercialLicense || ''] || '—' },
      { label: '规格尺寸', value: d.specSize || '—' },
      {
        label: '预算金额',
        value: d.budgetMin ? `¥${d.budgetMin}${d.budgetMax ? '-' + d.budgetMax : '+'}` : (d.budget || '面议'),
        isPrice: true,
      },
    ];
    data.referenceImages = d.referenceImages || []; // 📐 Sprint 9：真实参考图 URL 列表
    data.customerName = '需求用户';
    data.customerContact = d.contactPhone ? `· ${d.contactPhone}` : (d.wechat ? `· ${d.wechat}` : '');
    data.statusTitle = d.status === 'pending' ? '招标中' : d.statusText || d.status;
    data.statusDesc = d.designerId ? '已接单' : '等待设计师接单';

    ok(res, data);
  } catch (e: any) {
    log(`[designer] demand-detail error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, msg: '查询失败' });
  }
});

// POST /designer/register
router.post('/register', requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { realName, phone } = req.body || {};
  if (!realName || !phone) {return badRequest(res, '姓名和手机必填');}

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { ok: true });
  try {
    const userRepo = ds.getRepository(UserEntity);
    const user = await userRepo.findOne({ where: { id: userId } });
    if (!user) {return fail(res, 404, '账号不存在', 404);}
    // 🛠️ 限制：只有 consumer 能提交入驻；已 pending_designer/designer 不能重复提交
    if (user.role === 'pending_designer') {return fail(res, 400, '已提交入驻申请，请等待审核');}
    if (user.role === 'designer') {return fail(res, 400, '你已是设计师');}
    if (['admin', 'installer', 'vendor'].includes(user.role)) {
      return fail(res, 400, '当前角色不允许申请设计师入驻');
    }
    await userRepo.update(userId, { nickname: realName, role: 'pending_designer', phone: phone || user.phone });

    // 同步创建 designer_profiles 记录（设计师端独立 profile 表）
    const profileRepo = ds.getRepository(DesignerProfileEntity);
    const exists = await profileRepo.findOne({ where: { userId } });
    if (!exists) {
      await profileRepo.save({ userId, realName, avatar: user.avatar });
    }

    ok(res, { id: String(userId), role: 'pending_designer', verified: 'pending', message: '入驻申请已提交，待 admin 审核' });
  } catch (e: any) {
    log(`[Designer] register error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
});

// GET /designer/orders
router.get('/orders', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const tab = (req.query.tab as string) || 'all';
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { list: [], total: 0 });

  try {
    const repo = ds.getRepository(DesignDemandEntity);
    const where: any = { designerId: userId };
    if (tab === 'pending') {where.status = 'accepted';}
    else if (tab === 'in_progress') {where.status = 'designing';}
    else if (tab === 'completed') {where.status = In(['completed', 'reviewed']);}

    const list = await repo.find({ where, order: { updatedAt: 'DESC' } });
    ok(res, {
      list: list.map((d: any) => ({
        id: String(d.id),
        orderNo: d.orderNo,
        title: d.productName || d.demandText?.slice(0, 30) || '设计需求',
        demandText: d.demandText,
        budget: d.budget,
        status: d.status,
        statusText: d.statusText,
        createdAt: d.createdAt,
        contactPhone: d.contactPhone,
      })),
    });
  } catch (e: any) {
    log(`[Designer] orders error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
});

// GET /designer/orders/:id
router.get('/orders/:id', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) {return badRequest(res, '非法 ID');}
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, null);

  try {
    const repo = ds.getRepository(DesignDemandEntity);
    const d = await repo.findOne({ where: { id, designerId: userId } });
    if (!d) {return fail(res, 404, '订单不存在', 404);}
    ok(res, { ...d, id: String((d as any).id) });
  } catch (e: any) {
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
});

// GET /designer/profile — ✅ 读 designer_profiles 独立表（取代之前硬编码 4.8）
router.get('/profile', requireAuth, requirePendingDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    const u = db.users?.find((x: any) => x.id === userId);
    return ok(res, {
      id: String(userId),
      name: u?.nickname || '',
      phone: u?.phone || '',
      avatar: u?.avatar || '',
      role: u?.role || 'pending_designer',
      verified: false,
      designStyles: [], specialties: [], yearsExp: 1, teamSize: 'solo',
      priceRange: '¥500-1500', intro: '', revisionIncluded: 3, revisionMax: 5,
      revisionPolicy: '', deliverSource: 1, sourceFormats: '', sourceExtraFee: 0,
      aiTools: [], aiProficient: 0, awards: [], copyrightRegistered: 0,
      rating: 5.0, ratingCount: 0, completedOrders: 0,
      grade: 1, gradeTitle: '新锐设计师',
      vipLevel: 0, bondAmount: 0, bondStatus: 'none',
    });
  }
  try {
    const user = await findUserByIdORM(userId);
    if (!user) {return fail(res, 404, '账号不存在', 404);}

    const profileRepo = ds.getRepository(DesignerProfileEntity);
    let profile = await profileRepo.findOne({ where: { userId } });

    // 兼容：如果老设计师还没有 profile，创建一条
    if (!profile) {
      profile = await profileRepo.save({
        userId,
        realName: user.nickname || '',
        avatar: user.avatar,
        verified: user.role === 'designer' ? 1 : 0,
      });
    }

    // 实时算 VIP 等级（按完成订单数和评分）
    const vipLevel = calcVipLevel(profile.completedOrders, profile.rating);

    ok(res, {
      id: String(user.id),
      name: profile.realName || user.nickname || '',
      phone: user.phone || '',
      avatar: profile.avatar || user.avatar,
      role: user.role,
      verified: profile.verified === 1 || user.role === 'designer',

      // — 设计行业专属字段（之前完全缺失）—
      designStyles: profile.designStyles || [],
      specialties: profile.specialties || [],
      yearsExp: profile.yearsExp || 1,
      teamSize: profile.teamSize || 'solo',
      priceRange: profile.priceRange || '¥500-1500',
      intro: profile.intro || '',

      // 改稿承诺
      revisionIncluded: profile.revisionIncluded ?? 3,
      revisionMax: profile.revisionMax ?? 5,
      revisionPolicy: profile.revisionPolicy || '',

      // 源文件交付
      deliverSource: profile.deliverSource ?? 1,
      sourceFormats: profile.sourceFormats || '',
      sourceExtraFee: profile.sourceExtraFee ?? 0,

      // AI 辅助
      aiTools: profile.aiTools || [],
      aiProficient: profile.aiProficient ?? 0,

      // 版权/奖项
      awards: profile.awards || [],
      copyrightRegistered: profile.copyrightRegistered ?? 0,

      // 信用
      rating: profile.rating || 5.0,
      ratingCount: profile.ratingCount || 0,
      completedOrders: profile.completedOrders || 0,

      // 🆕 6 级体系
      grade: profile.grade ?? 1,
      gradeTitle: profile.gradeTitle || '',

      // VIP + 保证金
      vipLevel,
      bondAmount: profile.bondAmount || 0,
      bondStatus: profile.bondStatus || 'none',
    });
  } catch (e: any) {
    log(`[Designer] profile error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
});

// PUT /designer/profile — ✅ 支持全字段更新（之前只能改 nickname/avatar）
router.put('/profile', requireAuth, requirePendingDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, { ok: true });
  try {
    const {
      nickname, avatar, realName, designStyles, specialties, yearsExp, teamSize, priceRange, intro,
      revisionIncluded, revisionMax, revisionPolicy, deliverSource, sourceFormats, sourceExtraFee,
      aiTools, aiProficient, awards, copyrightRegistered,
    } = req.body || {};

    const userRepo = ds.getRepository(UserEntity);
    if (nickname) {await userRepo.update(userId, { nickname });}

    const profileRepo = ds.getRepository(DesignerProfileEntity);
    const profile = await profileRepo.findOne({ where: { userId } });
    const payload: any = {};
    if (realName !== undefined) {payload.realName = realName;}
    if (avatar !== undefined) {payload.avatar = avatar;}
    if (designStyles !== undefined) {payload.designStyles = designStyles;}
    if (specialties !== undefined) {payload.specialties = specialties;}
    if (yearsExp !== undefined) {payload.yearsExp = yearsExp;}
    if (teamSize !== undefined) {payload.teamSize = teamSize;}
    if (priceRange !== undefined) {payload.priceRange = priceRange;}
    if (intro !== undefined) {payload.intro = intro;}
    if (revisionIncluded !== undefined) {payload.revisionIncluded = revisionIncluded;}
    if (revisionMax !== undefined) {payload.revisionMax = revisionMax;}
    if (revisionPolicy !== undefined) {payload.revisionPolicy = revisionPolicy;}
    if (deliverSource !== undefined) {payload.deliverSource = deliverSource;}
    if (sourceFormats !== undefined) {payload.sourceFormats = sourceFormats;}
    if (sourceExtraFee !== undefined) {payload.sourceExtraFee = sourceExtraFee;}
    if (aiTools !== undefined) {payload.aiTools = aiTools;}
    if (aiProficient !== undefined) {payload.aiProficient = aiProficient;}
    if (awards !== undefined) {payload.awards = awards;}
    if (copyrightRegistered !== undefined) {payload.copyrightRegistered = copyrightRegistered;}

    if (Object.keys(payload).length > 0) {
      if (profile) {
        await profileRepo.update(profile.id, payload);
      } else {
        await profileRepo.save({ userId, realName: nickname || '', avatar, ...payload });
      }
    }

    ok(res, { success: true });
  } catch (e: any) {
    log(`[Designer] profile PUT error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
});

// GET /designer/earnings — ✅ 加平台抽佣 15%（设计撮合佣金）
router.get('/earnings', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) return ok(res, {
    summary: { totalIncome: 0, withdrawAmount: 0, pendingAmount: 0 },
    available: 0, frozen: 0, monthIncome: 0, total: 0, grossTotal: 0,
    commissionTotal: 0, rate: 0.15, records: [], trend: [],
  });

  try {
    const repo = ds.getRepository(DesignDemandEntity);
    const done = await repo.find({ where: { designerId: userId, status: In(['completed', 'reviewed']) } });

    const COMMISSION_RATE = COMMISSION_RATES.design.base; // 平台抽佣比例（统一配置源）
    const records = done.map((d: any) => {
      const budget = parseFloat(d.budget) || 0;
      const commission = Number((budget * COMMISSION_RATE).toFixed(2));
      const providerGet = Number((budget - commission).toFixed(2));
      return {
        id: String(d.id),
        type: 'income',
        title: d.productName || '设计服务费',
        amount: budget,
        commission,
        rate: COMMISSION_RATE,
        providerGet,
        createdAt: d.updatedAt,
        status: 'settled',
      };
    });

    const total = records.reduce((s, r) => s + r.amount, 0);
    const commissionTotal = records.reduce((s, r) => s + r.commission, 0);
    const available = records.reduce((s, r) => s + r.providerGet, 0);

    ok(res, {
      available: Number(available.toFixed(2)),      // 可提现
      frozen: 0,
      monthIncome: Number(available.toFixed(2)),   // 本月净收入
      total: Number(available.toFixed(2)),         // 累计净收入
      grossTotal: total,                            // 累计毛收入
      commissionTotal: Number(commissionTotal.toFixed(2)), // 累计抽佣
      rate: COMMISSION_RATE,
      records,
    });
  } catch (e: any) {
    log(`[Designer] earnings error: ${e.message}`, 'error');
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
});


// ============================================================================
// Sprint 10 — bank-cards 三项后端（TypeORM 化，取代 withdraw_requests hack 版）
// ============================================================================

// — GET /bank-cards — 列表 —
router.get('/bank-cards', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, []);
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const list = await repo.find({ where: { userId: req.userId!, role: 'designer', status: 'active' }, order: { isDefault: 'DESC', createdAt: 'DESC' } });
    ok(res, { list });
  } catch (e: any) { log(`[Designer] bank-cards error: ${e.message}`, 'error'); serverError(res, '查询失败'); }
});

// — POST /bank-cards — 新增 —
router.post('/bank-cards', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const { bankName, cardNo, accountName, branchName } = req.body || {};
  if (!bankName?.trim() || !cardNo?.trim() || !accountName?.trim()) return badRequest(res, '银行/卡号/持卡人必填');
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const count = await repo.count({ where: { userId: req.userId!, role: 'designer', status: 'active' } });
    if (count >= 5) return fail(res, 400, '最多绑定 5 张银行卡');
    // 脱敏：**** + 后 4 位
    const masked = '****' + cardNo.trim().slice(-4);
    // 如果是第一张，自动设默认
    let isDefault = count === 0 ? 1 : 0;
    // 如果新增时选了默认，先清掉旧默认
    if (req.body.isDefault) {
      await repo.createQueryBuilder().update().set({ isDefault: 0 }).where('userId=:uid AND role=:role AND isDefault=1', { uid: req.userId!, role: 'designer' }).execute();
      isDefault = 1;
    }
    const entity = repo.create({
      userId: req.userId!, role: 'designer',
      bankName: bankName.trim(), cardNo: cardNo.trim(), cardNoMasked: masked,
      accountName: accountName.trim(), branchName: branchName?.trim() || '',
      isDefault, status: 'active',
    });
    const saved = await repo.save(entity);
    ok(res, { success: true, card: saved });
  } catch (e: any) { log(`[Designer] bank-cards add error: ${e.message}`, 'error'); serverError(res, '绑卡失败'); }
});

// — DELETE /bank-cards/:id — 解绑 —
router.delete('/bank-cards/:id', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const card = await repo.findOne({ where: { id, userId: req.userId!, role: 'designer' } });
    if (!card) return notFound(res, '银行卡不存在');
    card.status = 'disabled';
    await repo.save(card);
    ok(res, { success: true });
  } catch (e: any) { log(`[Designer] bank-cards delete error: ${e.message}`, 'error'); serverError(res, '解绑失败'); }
});

// — POST /bank-cards/:id/default — 设为默认 —
router.post('/bank-cards/:id/default', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const card = await repo.findOne({ where: { id, userId: req.userId!, role: 'designer', status: 'active' } });
    if (!card) return notFound(res, '银行卡不存在');
    await repo.createQueryBuilder().update().set({ isDefault: 0 }).where('userId=:uid AND role=:role', { uid: req.userId!, role: 'designer' }).execute();
    card.isDefault = 1;
    await repo.save(card);
    ok(res, { success: true });
  } catch (e: any) { log(`[Designer] bank-cards default error: ${e.message}`, 'error'); serverError(res, '设置失败'); }
});

// — POST /bank-cards/:id — 更新 branchName / accountName / isDefault（cardNo 安全字段不允许改）—
router.post('/bank-cards/:id', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const { branchName, accountName, isDefault } = req.body || {};
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(id), ok: true });
  try {
    const { BankCardEntity } = await import('../entities');
    const repo = ds.getRepository(BankCardEntity);
    const role = 'designer';
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
  } catch (e: any) { log(`[designer] bank-cards update error: ${e.message}`, 'error'); serverError(res, '更新失败'); }
});

// POST /designer/withdraw — 提现申请（对齐 vendor/installer 同构）
router.post('/withdraw', requireAuth, requireDesigner, async (req: any, res) => {
  const { amount, bankName, bankCard, accountName, fee } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ code: 400, msg: '提现金额无效' });
  if (!bankName || !bankCard) return res.status(400).json({ code: 400, msg: '银行卡信息缺失' });
  const ds = getDataSource();
  if (!ds) return ok(res, { withdrawNo: 'MOCK' + Date.now(), amount: 0, ok: true });
  try {
    const userId = Number(req.userId);
    const role = 'designer';

    // 1. 查可用余额（SettleOrderEntity.providerId=me providerRole=designer status=available）
    const { SettleOrderEntity, WithdrawRequestEntity } = await import('../entities/index');
    const availRow = await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .where('s.providerId=:pid AND s.providerRole=:role AND s.status=:st',
        { pid: userId, role, st: 'available' })
      .select('SUM(s.providerGet)', 'sum').getRawOne();
    const available = Number(availRow?.sum || 0);
    if (available < amt) return res.status(400).json({ code: 400, msg: '可用余额不足' });

    // 2. 冻结对应结算单（status → withdrawn）
    await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .update(SettleOrderEntity)
      .set({ status: 'withdrawn' })
      .where('s.providerId=:pid AND s.providerRole=:role AND s.status=:st',
        { pid: userId, role, st: 'available' })
      .execute();

    // 3. 创建提现单
    const feeAmt = Number(fee || (amt * 0.006).toFixed(2));
    const actual = Number((amt - feeAmt).toFixed(2));
    const withdrawNo = 'WD' + Date.now() + Math.floor(Math.random() * 1000);
    const wRepo = ds.getRepository(WithdrawRequestEntity);
    await wRepo.save({
      withdrawNo, vendorId: userId, providerRole: 'designer',
      amount: amt, fee: feeAmt, actualAmount: actual,
      bankName: bankName.trim(), cardNo: bankCard.trim(), status: 'pending',
    });

    log(`[Designer] withdraw userId=${userId} amt=${amt} actual=${actual} no=${withdrawNo}`);
    ok(res, { withdrawNo, amount: amt, fee: feeAmt, actualAmount: actual }, '提现申请已提交，等待审核');
  } catch (e: any) { log(`[Designer] withdraw error: ${e.message}`, 'error'); serverError(res, '提现申请失败'); }
});

// GET /designer/withdraw-info — 提现页信息（对齐 vendor/installer 同构）
router.get('/withdraw-info', requireAuth, requireDesigner, async (req: any, res) => {
  const ds = getDataSource();
  if (!ds) return ok(res, { available: 0, recent: [] });
  try {
    const userId = Number(req.userId);
    const role = 'designer';
    const { SettleOrderEntity, WithdrawRequestEntity } = await import('../entities/index');

    // 可用余额：providerId=me providerRole=designer status=available
    const availRow = await ds.getRepository(SettleOrderEntity)
      .createQueryBuilder('s')
      .where('s.providerId=:pid AND s.providerRole=:role AND s.status=:st',
        { pid: userId, role, st: 'available' })
      .select('SUM(s.providerGet)', 'sum').getRawOne();
    const available = Number(availRow?.sum || 0);

    // 最近 5 条提现记录
    const wrRepo = ds.getRepository(WithdrawRequestEntity);
    const recent = await wrRepo.find({
      where: { vendorId: userId },
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
  } catch (e: any) { log(`[designer/withdraw-info] error: ${e.message}`, 'error'); serverError(res, '提现信息加载失败'); }
});

// ============================================================
// 🆕 Sprint 14：设计师"抢单大厅 + 报价竞标" — 补完整接口
// 参考 installer.ts hall/quote 同构，复用 design-demand 里已有的 bidder 数组机制
// ============================================================

// — 大厅列表：返回待接单(pending)的设计需求 + bidders 摘要 —
router.get('/hall', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const keyword = String(req.query.keyword || '');
  const sortBy = (req.query.sortBy as string) || 'latest';
  try {
    const items = await getDesignDemandHallORM({
      keyword: keyword || undefined,
      sortBy: (sortBy === 'budget' ? 'budget' : 'latest') as any,
    });
    // 前端友好字段 + 已有报价摘要
    const list = items.map((d: any) => ({
      id: String(d.id),
      orderNo: 'SJ' + d.id,
      title: d.designCategory ? DESIGN_TYPE_CN[d.designCategory] : d.demandText?.slice(0, 30),
      desc: d.demandText,
      budget: d.budgetMin != null
        ? (d.budgetMax != null ? `¥${d.budgetMin}-${d.budgetMax}` : `¥${d.budgetMin}+`)
        : (d.budget || '面议'),
      deliveryTime: d.deliveryTime,
      designCategory: d.designCategory,
      styleTags: d.styleTags,
      referenceImages: d.referenceImages,
      status: d.status,
      createdAt: d.createdAt,
      biddersCount: (d.bidders || []).length,
      biddersPreview: (d.bidders || []).slice(0, 3).map((b: any) => ({
        designerId: b.designerId,
        quotePrice: b.quotePrice,
        accepted: !!b.accepted,
        cancelled: !!b.cancelled,
      })),
      // 我自己的报价（如果已报过）
      myBid: (d.bidders || []).find((b: any) => Number(b.designerId) === userId && !b.cancelled) || null,
    }));
    ok(res, list);
  } catch (e: any) {
    log(`[designer/hall] error: ${e.message}`, 'error');
    serverError(res, '大厅加载失败');
  }
});

// — 提交报价（bid）—
router.post('/quote', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { demandId, quotePrice, note } = req.body || {};
  const did = Number(demandId);
  const price = Number(quotePrice);
  if (!did) return badRequest(res, 'demandId 必填');
  if (!price || price <= 0) return badRequest(res, '报价金额无效');

  const ds = getDataSource();
  try {
    // — TypeORM 模式 —
    if (ds?.isInitialized) {
      const repo = ds.getRepository(DesignDemandEntity);
      const demand = await repo.findOne({ where: { id: did } });
      if (!demand) return notFound(res, '需求不存在');
      if (demand.status !== 'pending') return fail(res, 409, '需求已关闭或已被其他设计师接单');
      if (demand.designerId) return fail(res, 409, '需求已被接单');

      const bidders: any[] = demand.bidders || [];
      const existingIdx = bidders.findIndex((b) => Number(b.designerId) === userId && !b.cancelled);
      const bid = {
        designerId: userId, quotePrice: price,
        note: String(note || '').slice(0, 200),
        createdAt: new Date().toISOString(),
        accepted: false, cancelled: false,
      };
      if (existingIdx >= 0) bidders[existingIdx] = { ...bidders[existingIdx], ...bid };
      else bidders.push(bid);
      demand.bidders = bidders;
      await repo.save(demand);
      log(`[designer/quote] userId=${userId} demandId=${did} price=${price}`);
      ok(res, { id: demand.id, biddersCount: bidders.length, myBid: bid });
      return;
    }

    // — 内存 mock fallback —
    if (!db) return serverError(res, 'DB 未就绪');
    const demand = db.designDemands?.find((d: any) => d.id === did);
    if (!demand) return notFound(res, '需求不存在');
    if (demand.status !== 'pending') return fail(res, 409, '需求已关闭');
    if (demand.designerId) return fail(res, 409, '需求已被接单');

    const bidders: any[] = Array.isArray(demand.bidders) ? demand.bidders : [];
    const existingIdx = bidders.findIndex((b: any) => Number(b.designerId) === userId && !b.cancelled);
    const bid = {
      designerId: userId, quotePrice: price,
      note: String(note || '').slice(0, 200),
      createdAt: new Date().toISOString(),
      accepted: false, cancelled: false,
    };
    if (existingIdx >= 0) bidders[existingIdx] = { ...bidders[existingIdx], ...bid };
    else bidders.push(bid);
    demand.bidders = bidders;
    log(`[designer/quote mock] userId=${userId} demandId=${did}`);
    ok(res, { id: demand.id, biddersCount: bidders.length, myBid: bid });
  } catch (e: any) {
    log(`[designer/quote] error: ${e.message}`, 'error');
    serverError(res, '报价失败');
  }
});

// — 撤销报价 —
router.post('/quote/:id/cancel', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const did = Number(req.params.id);
  if (!did) return badRequest(res, 'id 参数无效');
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(did), ok: true });
  try {
    const repo = ds.getRepository(DesignDemandEntity);
    const demand = await repo.findOne({ where: { id: did } });
    if (!demand) return notFound(res, '需求不存在');
    const bidders: any[] = demand.bidders || [];
    const idx = bidders.findIndex((b) => Number(b.designerId) === userId);
    if (idx < 0) return notFound(res, '你对该需求没有报价');
    if (bidders[idx].accepted) return fail(res, 409, '报价已被买家选中，无法撤销');
    bidders[idx].cancelled = true;
    demand.bidders = bidders;
    await repo.save(demand);
    log(`[designer/quote/cancel] userId=${userId} demandId=${did}`);
    ok(res, { id: demand.id });
  } catch (e: any) {
    log(`[designer/quote/cancel] error: ${e.message}`, 'error');
    serverError(res, '撤销失败');
  }
});

// — 我的报价列表（聚合所有需求中我提交的 bid）—
router.get('/quotes', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const tab = (req.query.tab as string) || 'all'; // all | pending | accepted | cancelled
  const ds = getDataSource();
  try {
    const repo = ds?.isInitialized ? ds.getRepository(DesignDemandEntity) : null;
    const all = repo
      ? await repo.find({ order: { id: 'DESC' } })
      : (globalThis as any).db?.designDemands || [];

    // 从所有需求的 bidders 数组里提取我自己的报价
    const myQuotes: any[] = [];
    for (const d of all) {
      const bidders: any[] = d.bidders || [];
      for (const b of bidders) {
        if (Number(b.designerId) !== userId) continue;
        const isCancelled = !!b.cancelled;
        const isAccepted = !!b.accepted;
        const status = isCancelled ? 'cancelled'
                     : isAccepted ? 'accepted'
                     : 'pending';
        if (tab !== 'all' && tab !== status) continue;
        myQuotes.push({
          id: String(d.id),
          demandId: String(d.id),
          demandTitle: d.demandText?.slice(0, 40),
          designCategory: d.designCategory,
          demandStatus: d.status,
          quotePrice: b.quotePrice,
          note: b.note,
          bidStatus: status, // pending=等待买家选择 | accepted=被选中接了 | cancelled=我撤了
          createdAt: b.createdAt,
          finalOrderNo: d.designerId === userId && d.status === 'accepted' ? `DO${d.id}` : null,
        });
      }
    }
    myQuotes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    ok(res, myQuotes);
  } catch (e: any) {
    log(`[designer/quotes] error: ${e.message}`, 'error');
    serverError(res, '加载失败');
  }
});

// ============================================================================
// 🆕 GET /api/designer/dashboard — 工作台聚合数据
// ============================================================================
router.get('/dashboard', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, {
    activeQuotes: 0, acceptedQuotes: 0,
    activeOrders: 0, completedOrders: 0,
    withdrawInfo: { available: 0, frozen: 0 },
    incomeTrend: [],
    pendingDisputes: 0,
    todos: [
      { type: 'active_orders', count: 0, label: '进行中' },
      { type: 'pending_dispute', count: 0, label: '待响应纠纷' },
    ],
  });

  try {
    const { DesignDemandEntity, SettleOrderEntity, DisputeEntity } = await import('../entities');

    // — 报价聚合：遍历所有需求的 bidders JSON —
    const demandRepo = ds.getRepository(DesignDemandEntity);
    const allDemands = await demandRepo.find({ order: { id: 'DESC' } }).catch(() => []);

    let activeQuotes = 0;
    let acceptedQuotes = 0;
    for (const d of allDemands) {
      const bidders: any[] = (d as any).bidders || [];
      for (const b of bidders) {
        if (Number(b.designerId) !== userId || b.cancelled) continue;
        if (b.accepted) acceptedQuotes++;
        else activeQuotes++;
      }
    }

    // — 订单聚合（DesignDemandEntity.designerId = me）—
    const orderRepo = demandRepo;
    const [activeOrders, completedOrders] = await Promise.all([
      orderRepo.createQueryBuilder('d')
        .where('d.designerId = :uid AND d.status IN (:...sts)',
          { uid: userId, sts: ['accepted', 'designing'] })
        .getCount().catch(() => 0),
      orderRepo.createQueryBuilder('d')
        .where('d.designerId = :uid AND d.status IN (:...sts)',
          { uid: userId, sts: ['completed', 'reviewed'] })
        .getCount().catch(() => 0),
    ]);

    // — 财务聚合 —
    const settleRepo = ds.getRepository(SettleOrderEntity);
    const [availableRow, frozenRow] = await Promise.all([
      settleRepo.createQueryBuilder('s')
        .where('s.providerId=:uid AND s.providerRole=:role AND s.status=:st',
          { uid: userId, role: 'designer', st: 'available' })
        .select('COALESCE(SUM(s.providerGet),0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
      settleRepo.createQueryBuilder('s')
        .where('s.providerId=:uid AND s.providerRole=:role AND s.status IN (:...sts)',
          { uid: userId, role: 'designer', sts: ['frozen', 'released'] })
        .select('COALESCE(SUM(s.providerGet),0)', 'sum').getRawOne().catch(() => ({ sum: 0 })),
    ]);

    // — 近 30 天收入趋势（按天聚合）—
    const trendDays: Array<{ date: string; amount: number }> = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      trendDays.push({ date: d.toISOString().slice(0, 10), amount: 0 });
    }
    try {
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(now.getDate() - 29);
      const rows: any[] = await settleRepo.createQueryBuilder('s')
        .select("DATE(s.createdAt) as day, COALESCE(SUM(s.providerGet),0) as amt")
        .where('s.providerId=:uid AND s.providerRole=:role AND s.status != :frozen AND s.createdAt >= :from',
          { uid: userId, role: 'designer', frozen: 'frozen', from: thirtyDaysAgo })
        .groupBy('DATE(s.createdAt)')
        .getRawMany().catch(() => []);
      for (const r of rows) {
        const day = String(r.day).slice(0, 10);
        const slot = trendDays.find(t => t.date === day);
        if (slot) slot.amount = Number(r.amt || 0);
      }
    } catch (e) {
      log(`[designer/dashboard] trend query fallback: ${e.message}`, 'warn');
    }

    // — 纠纷 —
    const pendingDisputes = await ds.getRepository(DisputeEntity).createQueryBuilder('d')
      .where('d.providerId = :uid AND d.providerRole = :role AND d.status IN (:...sts)',
        { uid: userId, role: 'designer', sts: ['pending', 'processing'] })
      .getCount().catch(() => 0);

    ok(res, {
      activeQuotes,
      acceptedQuotes,
      activeOrders: Number(activeOrders || 0),
      completedOrders: Number(completedOrders || 0),
      withdrawInfo: {
        available: Number(availableRow?.sum || 0),
        frozen: Number(frozenRow?.sum || 0),
      },
      incomeTrend: trendDays,
      pendingDisputes: Number(pendingDisputes || 0),
      todos: [
        { type: 'active_orders', count: Number(activeOrders || 0), label: '进行中' },
        { type: 'pending_dispute', count: Number(pendingDisputes || 0), label: '待响应纠纷' },
      ],
    });
  } catch (e: any) {
    log(`[designer/dashboard] error: ${e.message}`, 'error');
    serverError(res, '仪表盘数据加载失败');
  }
});

// ============================================================================
// 🆕 Portfolio — 设计师作品集（存在 designer_profiles.portfolio JSON 字段）
// ============================================================================

// GET /api/designer/portfolio — 查作品集
router.get('/portfolio', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, []);
  try {
    const profile = await ds.getRepository(DesignerProfileEntity).findOne({ where: { userId } });
    const portfolio: any[] = (profile as any)?.portfolio || [];
    ok(res, portfolio);
  } catch (e: any) {
    log(`[designer/portfolio GET] error: ${e.message}`, 'error');
    serverError(res, '作品集加载失败');
  }
});

// POST /api/designer/portfolio — 新增一条
// body: { title, description, images, designCategory, year }
router.post('/portfolio', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { title, description, images, designCategory, year } = req.body || {};
  if (!title?.trim()) return badRequest(res, 'title 必填');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id: String(Date.now().toString(36)), ok: true });
  try {
    const repo = ds.getRepository(DesignerProfileEntity);
    let profile = await repo.findOne({ where: { userId } });
    if (!profile) {
      profile = repo.create({ userId, realName: '', avatar: null });
    }
    const list: any[] = Array.isArray((profile as any).portfolio) ? [...(profile as any).portfolio] : [];
    const newItem = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: title.trim(),
      description: description ? String(description) : '',
      images: Array.isArray(images) ? images : [],
      designCategory: designCategory ? String(designCategory) : '',
      year: year ? Number(year) : new Date().getFullYear(),
      createdAt: new Date().toISOString(),
    };
    list.push(newItem);
    (profile as any).portfolio = list;
    await repo.save(profile);
    ok(res, newItem, '作品集已新增');
  } catch (e: any) {
    log(`[designer/portfolio POST] error: ${e.message}`, 'error');
    serverError(res, '新增作品集失败');
  }
});

// DELETE /api/designer/portfolio/:id — 删除一条
router.delete('/portfolio/:id', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = String(req.params.id);
  if (!id) return badRequest(res, 'id 参数无效');

  const ds = getDataSource();
  if (!ds?.isInitialized) return ok(res, { id, ok: true });
  try {
    const repo = ds.getRepository(DesignerProfileEntity);
    const profile = await repo.findOne({ where: { userId } });
    if (!profile) return notFound(res, '设计师资料不存在');

    const list: any[] = Array.isArray((profile as any).portfolio) ? [...(profile as any).portfolio] : [];
    const before = list.length;
    const filtered = list.filter((p: any) => String(p.id) !== id);
    if (filtered.length === before) return notFound(res, '作品集条目不存在');

    (profile as any).portfolio = filtered;
    await repo.save(profile);
    ok(res, { id }, '作品集已删除');
  } catch (e: any) {
    log(`[designer/portfolio DELETE] error: ${e.message}`, 'error');
    serverError(res, '删除作品集失败');
  }
});

// ============================================================================
// 🆕 Sprint 14 — Designer 纠纷响应入口（providerRole=designer, providerId=me）
// GET    /api/designer/disputes            — 分页列表 + tab 过滤 + 聚合统计
// GET    /api/designer/disputes/:id        — 详情（带 timeline/messages）
// POST   /api/designer/disputes/:id/respond — 角色方补充资料/解释
// ============================================================================

const DESIGNER_DISPUTE_ROLE = 'designer' as const;

function mapDesignerDisputeTimeline(d: any) {
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

router.get('/disputes', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const tab = String(req.query.tab || 'all');
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 20));

  const ds = getDataSource();
  const role = DESIGNER_DISPUTE_ROLE;

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
        list: rows.map(mapDesignerDisputeTimeline),
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
        list: rows.map(mapDesignerDisputeTimeline),
        total, page, size,
        summary: { pendingCount, totalCount: list.length },
      });
    }
  } catch (e: any) {
    log(`[designer/disputes] error: ${e.message}`, 'error');
    serverError(res, '纠纷列表加载失败');
  }
});

router.get('/disputes/:id', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!id) return badRequest(res, '纠纷 ID 无效');

  const ds = getDataSource();
  const role = DESIGNER_DISPUTE_ROLE;

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
    ok(res, mapDesignerDisputeTimeline(d));
  } catch (e: any) {
    log(`[designer/disputes/:id] error: ${e.message}`, 'error');
    serverError(res, '纠纷详情加载失败');
  }
});

router.post('/disputes/:id/respond', requireAuth, requireDesigner, async (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  const { message } = req.body || {};
  if (!id) return badRequest(res, '纠纷 ID 无效');
  if (!message || String(message).trim().length < 3) {
    return badRequest(res, '响应内容至少 3 个字');
  }

  const ds = getDataSource();
  const role = DESIGNER_DISPUTE_ROLE;

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
          action: 'designer.dispute.respond', targetType: 'dispute', targetId: String(id), userId,
          detail: { message: String(message).trim() },
        });
      } catch {}

      log(`[designer] dispute ${id} responded by userId=${userId}`);
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
      log(`[designer:mem] dispute ${id} responded by userId=${userId}`);
      ok(res, { id: d.id, status: d.status }, '响应已提交');
    }
  } catch (e: any) {
    log(`[designer/disputes respond] error: ${e.message}`, 'error');
    serverError(res, '响应提交失败');
  }
});

export default router;

