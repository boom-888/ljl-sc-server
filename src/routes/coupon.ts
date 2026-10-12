// ============================================================================
// 🎟️ Coupon Routes — /api/coupon/*
// GET    /coupon/center       领券中心（可领券列表）
// GET    /coupon/mine         我的优惠券
// POST   /coupon/receive      领取优惠券
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, badRequest, log } from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { CouponEntity, UserCouponEntity } from '../entities/sprint6';

// — 内存 mock：TypeORM 未初始化时的种子数据 —
const MOCK_COUPONS = [
  {
    id: 1,
    name: '新人满200减50',
    type: 'amount',
    value: 50,
    minAmount: 200,
    description: '新注册用户专属',
    validDays: 30,
    total: 1000,
    remain: 1000,
    active: 1,
  },
  {
    id: 2,
    name: '满500减100',
    type: 'amount',
    value: 100,
    minAmount: 500,
    description: '全品类通用',
    validDays: 60,
    total: 500,
    remain: 487,
    active: 1,
  },
  {
    id: 3,
    name: '满1000减200',
    type: 'amount',
    value: 200,
    minAmount: 1000,
    description: '定制/灯箱类',
    validDays: 30,
    total: 200,
    remain: 198,
    active: 1,
  },
  {
    id: 4,
    name: '9 折优惠券',
    type: 'percent',
    value: 10,
    minAmount: 300,
    description: '全场 9 折（最高减 200）',
    validDays: 15,
    total: 2000,
    remain: 2000,
    active: 1,
  },
  {
    id: 5,
    name: '设计需求满1000减300',
    type: 'amount',
    value: 300,
    minAmount: 1000,
    description: '仅限设计定制需求单',
    validDays: 45,
    total: 100,
    remain: 97,
    active: 1,
  },
];
const MOCK_USER_COUPONS: Record<number, any[]> = {}; // userId → UserCoupon[]

const router = Router();

// — 初始化：首次启动时 seed 优惠券模板 —
async function ensureSeedCoupons() {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return;
  }
  try {
    const repo = ds.getRepository(CouponEntity);
    const cnt = await repo.count();
    if (cnt > 0) {
      return;
    }

    const templates = [
      {
        name: '新人满200减50',
        type: 'amount',
        value: 50,
        minAmount: 200,
        description: '新注册用户专属',
        validDays: 30,
        total: 1000,
        remain: 1000,
        active: 1,
      },
      {
        name: '满500减100',
        type: 'amount',
        value: 100,
        minAmount: 500,
        description: '全品类通用',
        validDays: 60,
        total: 500,
        remain: 487,
        active: 1,
      },
      {
        name: '满1000减200',
        type: 'amount',
        value: 200,
        minAmount: 1000,
        description: '定制/灯箱类',
        validDays: 30,
        total: 200,
        remain: 198,
        active: 1,
      },
      {
        name: '9 折优惠券',
        type: 'percent',
        value: 10,
        minAmount: 300,
        description: '全场 9 折（最高减 200）',
        validDays: 15,
        total: 2000,
        remain: 2000,
        active: 1,
      },
      {
        name: '设计需求满1000减300',
        type: 'amount',
        value: 300,
        minAmount: 1000,
        description: '仅限设计定制需求单',
        validDays: 45,
        total: 100,
        remain: 97,
        active: 1,
      },
    ];
    await repo.save(repo.create(templates as any));
    log(`coupon-seed: ${templates.length} templates seeded`);
  } catch (e: any) {
    log(`coupon-seed ERROR: ${e?.message}`, 'warn');
  }
}
ensureSeedCoupons();

// — GET /coupon/center — 公开接口（可选鉴权：带 token 显示已领状态）
router.get('/center', async (req, res) => {
  // 可选鉴权：尝试解析 token，无 token 也能访问
  let userId = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const jwt = require('jsonwebtoken');
      const secret = process.env.JWT_SECRET || 'change-me-to-a-strong-random-secret-in-production';
      const decoded = jwt.verify(authHeader.slice(7), secret);
      userId = decoded?.userId || null;
    } catch {
      /* token 无效 → 当未登录处理 */
    }
  }
  await ensureSeedCoupons();

  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    try {
      const couponRepo = ds.getRepository(CouponEntity);
      const coupons = await couponRepo.find({ where: { active: 1 } });

      let receivedIds = new Set();
      if (userId) {
        const ucRepo = ds.getRepository(UserCouponEntity);
        const received = await ucRepo.find({ where: { userId }, select: { couponId: true } });
        receivedIds = new Set(received.map((r) => r.couponId));
      }

      const list = coupons.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        value: Number(c.value),
        minAmount: Number(c.minAmount),
        desc: c.description,
        validDays: c.validDays,
        total: c.total,
        remain: c.remain,
        received: receivedIds.has(c.id),
      }));
      log(`coupon-center userId=${userId || 'anon'} count=${list.length}`);
      return ok(res, { list });
    } catch (e: any) {
      log(`coupon-center ERROR: ${e?.message}`, 'warn');
    }
  }
  // — 内存 mock fallback —
  const mockReceivedIds = new Set((MOCK_USER_COUPONS[userId || 0] || []).map((uc) => uc.couponId));
  const mockList = MOCK_COUPONS.filter((c) => c.active === 1).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    value: c.value,
    minAmount: c.minAmount,
    desc: c.description,
    validDays: c.validDays,
    total: c.total,
    remain: c.remain,
    received: mockReceivedIds.has(c.id),
  }));
  ok(res, { list: mockList });
});

// — GET /coupon/mine —
router.get('/mine', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    try {
      const repo = ds.getRepository(UserCouponEntity);
      const list = await repo.find({ where: { userId }, order: { createdAt: 'DESC' } });

      const now = new Date();
      let unused = 0,
        used = 0,
        expired = 0;
      for (const c of list) {
        if (c.status === 'used') {
          used++;
        } else if (c.expireTime < now) {
          expired++;
        } else {
          unused++;
        }
      }
      log(`coupon-mine userId=${userId} count=${list.length}`);
      return ok(res, { list, summary: { unused, used, expired } });
    } catch (e: any) {
      log(`coupon-mine ERROR: ${e?.message}`, 'warn');
    }
  }
  // — 内存 mock fallback —
  const mockList = MOCK_USER_COUPONS[userId] || [];
  const now = new Date();
  let u = 0,
    used = 0,
    ex = 0;
  for (const c of mockList) {
    if (c.status === 'used') used++;
    else if (new Date(c.expireTime) < now) ex++;
    else u++;
  }
  ok(res, { list: mockList, summary: { unused: u, used, expired: ex } });
});

// — POST /coupon/receive —
router.post('/receive', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { couponId } = req.body || {};
  if (!couponId) {
    return badRequest(res, 'couponId 必填');
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    // — 内存 mock fallback —
    const coupon = MOCK_COUPONS.find((c) => c.id === Number(couponId) && c.active === 1);
    if (!coupon) {
      return fail(res, 404, '优惠券不存在', 404);
    }
    if (coupon.remain <= 0) {
      return fail(res, 400, '优惠券已领完');
    }
    if (!MOCK_USER_COUPONS[userId]) {
      MOCK_USER_COUPONS[userId] = [];
    }
    const already = MOCK_USER_COUPONS[userId].find((uc) => uc.couponId === coupon.id);
    if (already) {
      return fail(res, 400, '您已领过此券');
    }
    coupon.remain -= 1;
    const uc = {
      id: Date.now(),
      userId,
      couponId: coupon.id,
      name: coupon.name,
      type: coupon.type,
      value: coupon.value,
      minAmount: coupon.minAmount,
      status: 'unused',
      source: '领券中心',
      expireTime: new Date(Date.now() + coupon.validDays * 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    MOCK_USER_COUPONS[userId].push(uc);
    log(`coupon-receive MOCK userId=${userId} couponId=${couponId}`);
    return ok(res, uc, '领取成功');
  }

  try {
    // 🔒 整个领取流程在事务里：查券(悲观锁) → 限领检查 → 条件扣减 → 插 UserCoupon
    const uc = await ds.transaction(async (t) => {
      const couponRepo = t.getRepository(CouponEntity);
      const ucRepo = t.getRepository(UserCouponEntity);

      // 1. 悲观锁查券（SELECT ... FOR UPDATE）— 防止并发同时读到 remain>0
      const coupon = await couponRepo
        .createQueryBuilder('c')
        .where('c.id = :id AND c.active = 1', { id: Number(couponId) })
        .setLock('pessimistic_write')
        .getOne();
      if (!coupon) {
        throw new Error('COUPON_NOT_FOUND');
      }
      if (coupon.remain <= 0) {
        throw new Error('COUPON_SOLD_OUT');
      }

      // 2. 每人限领 1 张（同优惠券）
      const already = await ucRepo.findOne({ where: { userId, couponId: coupon.id } });
      if (already) {
        throw new Error('ALREADY_RECEIVED');
      }

      // 3. 条件扣减 — 双保险：WHERE remain > 0，affected=0 说明被并发抢先了
      const r = await couponRepo
        .createQueryBuilder()
        .update()
        .set({ remain: () => 'remain - 1' })
        .where('id = :id AND remain > 0', { id: coupon.id })
        .execute();
      if (r.affected === 0) {
        throw new Error('COUPON_SOLD_OUT');
      }

      // 4. 插入 UserCoupon（和扣减在同一事务，要么一起成要么一起败）
      const uc = ucRepo.create({
        userId,
        couponId: coupon.id,
        name: coupon.name,
        type: coupon.type,
        value: coupon.value,
        minAmount: coupon.minAmount,
        status: 'unused',
        source: '领券中心',
        expireTime: new Date(Date.now() + coupon.validDays * 24 * 3600 * 1000),
      });
      return await ucRepo.save(uc);
    });

    log(`coupon-receive userId=${userId} couponId=${couponId}`);
    ok(res, uc, '领取成功');
  } catch (e: any) {
    const msg = e.message || '';
    if (msg === 'COUPON_NOT_FOUND') {
      return fail(res, 404, '优惠券不存在', 404);
    }
    if (msg === 'COUPON_SOLD_OUT') {
      return fail(res, 400, '优惠券已领完');
    }
    if (msg === 'ALREADY_RECEIVED') {
      return fail(res, 400, '您已领过此券');
    }
    log(`coupon-receive ERROR: ${msg}`, 'error');
    fail(res, 500, '服务器错误', 500);
  }
});

export default router;
