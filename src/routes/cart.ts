// ============================================================================
// 🛒 Cart Routes — 5 endpoint（TypeORM + 内存 fallback）
// GET    /api/cart
// POST   /api/cart/add
// PUT    /api/cart/select-all  ⚠️ 必须在 /:id 之前！
// PUT    /api/cart/:id
// DELETE /api/cart/:id
// ============================================================================
import { Router } from 'express';
import {
  listCartORM,
  addCartItemORM,
  updateCartItemORM,
  deleteCartItemORM,
  selectAllCartORM,
} from '../db-orm';
import { adapters } from '../adapters';
import { requireAuth, ok, fail, badRequest, log } from '../middleware/auth';

const router = Router();

// — GET /cart —
router.get('/', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const list = await listCartORM(userId);
  ok(
    res,
    list.map((c) => adapters.cartToFront(c as any)),
  );
});

// — POST /cart/add —
router.post('/add', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { productId, specId, quantity = 1 } = req.body || {};
  if (!productId || !Number.isFinite(Number(productId))) {
    return badRequest(res, 'productId 必填');
  }
  const qty = Math.max(1, Math.min(99, Number(quantity)));

  const result = await addCartItemORM(userId, Number(productId), specId, qty);
  log(`cart/add userId=${userId} productId=${productId} qty=${qty}`);
  ok(res, adapters.cartToFront(result as any));
});

// — PUT /cart/select-all — 必须在 /:id 之前！
router.put('/select-all', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const selected = !!(req.body?.selected ?? true);
  await selectAllCartORM(userId, selected);
  ok(res, { success: true });
});

// — PUT /cart/:id —
router.put('/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const cart = await updateCartItemORM(userId, id, {
    quantity: req.body?.quantity,
    selected: req.body?.selected,
  });
  if (!cart) {
    return fail(res, 404, '购物车项不存在', 404);
  }
  ok(res, { success: true });
});

// — DELETE /cart/:id —
router.delete('/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const ok2 = await deleteCartItemORM(userId, id);
  if (ok2 === null) {
    return fail(res, 404, '购物车项不存在', 404);
  }
  ok(res, { success: true });
});

export default router;
