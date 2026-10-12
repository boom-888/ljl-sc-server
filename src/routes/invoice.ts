// ============================================================================
// 🧾 Invoice Routes — /api/invoice/*（发票申请）
// GET    /invoice/list       发票列表
// POST   /invoice/apply      申请发票
// ============================================================================
import { Router } from 'express';
import { requireAuth, ok, log } from '../middleware/auth';

const router = Router();

// — GET /invoice/list —
router.get('/list', requireAuth, (req, res) => {
  const userId = (req as any).userId;
  const list = [
    {
      id: 'inv1',
      invoiceNo: 'INV202610010001',
      orderNo: 'LJL20261001000001',
      title: '杭州 XX 广告有限公司',
      amount: 1280,
      taxRate: 6,
      amountWithTax: 1280,
      status: 'issued',
      type: 'special',
      createTime: '2026-10-03T10:00:00Z',
      issuedTime: '2026-10-04T09:00:00Z',
    },
    {
      id: 'inv2',
      invoiceNo: 'INV202610020002',
      orderNo: 'LJL20261002000002',
      title: '杭州 XX 广告有限公司',
      amount: 2600,
      taxRate: 6,
      amountWithTax: 2600,
      status: 'pending',
      type: 'special',
      createTime: '2026-10-04T11:20:00Z',
      issuedTime: null,
    },
  ].map((i) => ({ ...i, id: `${userId}_${i.id}` }));
  log(`invoice-list userId=${userId}`);
  ok(res, { list, summary: { pending: 1, issued: 1 } });
});

// — POST /invoice/apply —
router.post('/apply', requireAuth, (req, res) => {
  const userId = (req as any).userId;
  const { orderNo, title, taxNo, type = 'general', contact, address } = req.body || {};
  if (!orderNo || !title) {
    return res.status(400).json({ code: 400, msg: '订单号和抬头必填' });
  }

  const invoiceNo = 'INV' + Date.now();
  const data = {
    id: `${userId}_${invoiceNo}`,
    invoiceNo,
    orderNo,
    title,
    taxNo,
    type,
    contact,
    address,
    amount: 0,
    taxRate: 6,
    amountWithTax: 0,
    status: 'pending',
    createTime: new Date().toISOString(),
  };
  log(`invoice-apply userId=${userId} orderNo=${orderNo}`);
  ok(res, data, '发票申请已提交');
});

export default router;
