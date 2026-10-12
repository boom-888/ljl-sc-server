// ============================================================================
// ❤️ Favorite Routes — /api/favorite/*
// GET    /favorite/list       我的收藏列表
// POST   /favorite/toggle     收藏/取消收藏
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, log } from '../middleware/auth';
import { getDataSource } from '../db-manager';
import { FavoriteEntity } from '../entities/sprint6';

const router = Router();

// — GET /favorite/list —
router.get('/list', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const ds = getDataSource();

  if (ds && ds.isInitialized) {
    try {
      const repo = ds.getRepository(FavoriteEntity);
      const list = await repo.find({ where: { userId }, order: { createdAt: 'DESC' } });
      log(`favorite-list userId=${userId} count=${list.length}`);
      return ok(res, { list, total: list.length });
    } catch (err: any) {
      log(`favorite-list ERROR: ${err?.message}`, 'warn');
    }
  }

  // fallback: 空列表（首次请求或表不存在）
  ok(res, { list: [], total: 0 });
});

// — POST /favorite/toggle —
router.post('/toggle', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { productId, productName, productCover, price } = req.body || {};
  if (!productId) {
    return res.status(400).json({ code: 400, msg: 'productId 必填' });
  }

  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    log(`favorite-toggle userId=${userId} productId=${productId} (DB not ready)`);
    return ok(res, { success: true, favorited: true });
  }

  try {
    const repo = ds.getRepository(FavoriteEntity);
    const exist = await repo.findOne({ where: { userId, productId } });

    if (exist) {
      await repo.remove(exist);
      log(`favorite-toggle OFF userId=${userId} productId=${productId}`);
      return ok(res, { success: true, favorited: false, message: '已取消收藏' });
    }

    const fav = repo.create({
      userId,
      productId: Number(productId),
      productName,
      productCover,
      price: price ? Number(price) : undefined,
    });
    await repo.save(fav);
    log(`favorite-toggle ON userId=${userId} productId=${productId}`);
    ok(res, { success: true, favorited: true, message: '已添加到收藏' });
  } catch (err: any) {
    log(`favorite-toggle ERROR: ${err?.message}`, 'error');
    fail(res, 500, '服务器错误', 500);
  }
});

export default router;
