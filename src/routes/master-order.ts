// ============================================================================
// 🏗️ MasterOrder 主订单查询路由（P0 新增）
// GET  /api/master-order/my    — 当前用户的主订单列表
// GET  /api/master-order/:id   — 主订单详情（带子订单引用）
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, log } from '../middleware/auth';
import { listMasterOrdersORM, getMasterOrderDetailORM } from '../db-orm';

const router = Router();

// — 固定路径（必须在 /:id 之前！§8.2）—
router.get('/my', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { status } = req.query as any;
  const list = await listMasterOrdersORM(userId, status || undefined);
  ok(res, { list, total: list.length });
});

// — 参数路由 —
router.get('/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return fail(res, 400, '主订单 ID 无效', 400);
  }
  const mo = await getMasterOrderDetailORM(userId, id);
  if (!mo) {
    return fail(res, 404, '主订单不存在', 404);
  }
  ok(res, mo);
});

export default router;
