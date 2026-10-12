// ============================================================================
// 📍 Address Routes — 5 endpoint（TypeORM + 内存 fallback）
// GET    /api/addresses
// POST   /api/addresses
// PUT    /api/addresses/:id
// DELETE /api/addresses/:id
// POST   /api/addresses/:id/default
// ============================================================================
import { Router } from 'express';
import {
  listAddressesORM,
  createAddressORM,
  updateAddressORM,
  deleteAddressORM,
  setAddressDefaultORM,
} from '../db-orm';
import { adapters } from '../adapters';
import { requireAuth, ok, fail, badRequest, log } from '../middleware/auth';

const router = Router();

router.get('/', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const list = await listAddressesORM(userId);
  ok(
    res,
    list.map((a) => adapters.addressToFront(a as any)),
  );
});

router.post('/', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { name, phone, province, city, district, detail, isDefault } = req.body || {};
  if (!name || !phone || !province || !city || !district || !detail) {
    return badRequest(res, '姓名/手机/省/市/区/详细地址 必填');
  }
  const addr = await createAddressORM(userId, {
    name,
    phone,
    province,
    city,
    district,
    detail,
    isDefault,
  });
  log(`address/add userId=${userId}`);
  ok(res, adapters.addressToFront(addr as any));
});

router.put('/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const addr = await updateAddressORM(userId, id, req.body || {});
  if (!addr) {
    return fail(res, 404, '地址不存在', 404);
  }
  ok(res, adapters.addressToFront(addr as any));
});

router.delete('/:id', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const ok2 = await deleteAddressORM(userId, id);
  if (ok2 === null) {
    return fail(res, 404, '地址不存在', 404);
  }
  ok(res, { success: true });
});

router.post('/:id/default', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const addr = await setAddressDefaultORM(userId, id);
  if (!addr) {
    return fail(res, 404, '地址不存在', 404);
  }
  ok(res, adapters.addressToFront(addr as any));
});

export default router;
