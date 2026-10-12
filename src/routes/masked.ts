// ============================================================================
// 📞 Masked Number Routes — /api/masked/*（中间号 API）
// POST   /masked/bind        创建买家↔服务商中间号绑定
// GET    /masked/bind/:id    查询绑定状态
// POST   /masked/bind/:id/release  释放绑定
// POST   /masked/call        发起中间号通话
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, fail, badRequest, log } from '../middleware/auth';
import { createBinding, getBinding, releaseBinding, makeCall } from '../services/masked-number';
import { maskPhone } from '../services/chat-filter';

const router = Router();

// — POST /masked/bind —
router.post('/bind', requireAuth, (req, res) => {
  const userId = String((req as any).userId);
  const { realB, relation, hours } = req.body || {};
  if (!realB) {
    return badRequest(res, '服务商手机号必填');
  }
  if (!relation) {
    return badRequest(res, '业务关系必填（如 install_order_5）');
  }

  const realA = req.body.realA || '';
  const binding = createBinding(
    userId,
    realA || '13800000000',
    realB,
    relation,
    Number(hours) || 72,
  );
  log(`[MASKED-BIND] userId=${userId} mask=${binding.maskNumber} relation=${relation}`);
  ok(
    res,
    {
      bindingId: binding.bindingId,
      maskNumber: binding.maskNumber,
      expireAt: binding.expireAt,
    },
    '中间号创建成功',
  );
});

// — GET /masked/bind/:id —
router.get('/bind/:id', requireAuth, (req, res) => {
  const userId = String((req as any).userId);
  const b = getBinding(req.params.id, userId);
  if (!b) {
    return fail(res, 404, '绑定不存在或无权访问', 404);
  }
  ok(res, {
    bindingId: b.bindingId,
    maskNumber: b.maskNumber,
    relation: b.relation,
    expireAt: b.expireAt,
    status: b.status,
  });
});

// — POST /masked/bind/:id/release —
router.post('/bind/:id/release', requireAuth, (req, res) => {
  const userId = String((req as any).userId);
  const ok2 = releaseBinding(req.params.id, userId);
  if (!ok2) {
    return fail(res, 404, '绑定不存在或无权操作', 404);
  }
  ok(res, { released: true });
});

// — POST /masked/call —
router.post('/call', requireAuth, (req, res) => {
  const userId = String((req as any).userId);
  const { bindingId } = req.body || {};
  if (!bindingId) {
    return badRequest(res, 'bindingId 必填');
  }
  // 🛠️ 防越权：只能 call 自己创建的绑定
  const b = getBinding(bindingId, userId);
  if (!b) {
    return fail(res, 404, '绑定不存在或无权访问', 404);
  }
  const { toMask } = makeCall(bindingId, String(userId));
  if (!toMask) {
    return badRequest(res, '绑定不存在或已过期');
  }
  ok(res, { toMask });
});

export default router;
