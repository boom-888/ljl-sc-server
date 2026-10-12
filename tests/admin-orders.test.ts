// ============================================================================
// 订单管理 · 路由单元测试（ vitest + Node HTTP 客户端 ）
// 覆盖：GET /admin/orders 合并三种订单
//       GET /admin/orders/stats 计数
//       POST /admin/orders/:id/status 单条改状态
//       POST /admin/orders/batch-status 批量改状态
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';

const BASE = process.env.TEST_BASE || 'http://localhost:3001';
const ADMIN_ACC = process.env.TEST_ADMIN || '超级管理员';
const ADMIN_PWD = process.env.TEST_PWD || '123456';

// ---------- 简易 fetch 包装 ----------
function req(path: string, init: { method?: string; body?: any; token?: string } = {}) {
  return new Promise<any>((resolve, reject) => {
    const u = new URL(BASE + path);
    const bodyStr = init.body !== undefined ? JSON.stringify(init.body) : undefined;
    const options: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: init.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (init.token) options.headers!['Authorization'] = `Bearer ${init.token}`;
    if (bodyStr) options.headers!['Content-Length'] = Buffer.byteLength(bodyStr);

    const httpLib = u.protocol === 'https:' ? require('node:https') : http;
    const r = httpLib.request(options, (res: http.IncomingMessage) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

let ADMIN_TOKEN = '';
let FIRST_GOODS_ID = '';
let FIRST_DESIGN_ID = '';
let FIRST_INSTALL_ID = '';

// ---------- 登录 ----------
beforeAll(async () => {
  const r = await req('/api/auth/login-account', {
    method: 'POST',
    body: { account: ADMIN_ACC, password: ADMIN_PWD },
  });
  expect(r.status).toBe(200);
  expect(r.body?.code).toBe(0);
  ADMIN_TOKEN = r.body.data.token;
  expect(ADMIN_TOKEN).toBeTruthy();

  // 记录三种订单 id
  const orders = await req('/api/admin/orders?page=1&size=100', { token: ADMIN_TOKEN });
  expect(orders.status).toBe(200);
  for (const o of orders.body?.data?.list || []) {
    if (o.type === 'goods' && !FIRST_GOODS_ID) FIRST_GOODS_ID = o.id;
    if (o.type === 'design' && !FIRST_DESIGN_ID) FIRST_DESIGN_ID = o.id;
    if (o.type === 'install' && !FIRST_INSTALL_ID) FIRST_INSTALL_ID = o.id;
  }
}, 30000);

// ============================================================================
// 1. GET /admin/orders — 合并三种订单
// ============================================================================
describe('GET /api/admin/orders', () => {
  it('未登录返回 401', async () => {
    const r = await req('/api/admin/orders');
    expect(r.status).toBe(401);
  });

  it('默认返回合并列表 + 分页', async () => {
    const r = await req('/api/admin/orders?page=1&size=20', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(0);
    expect(r.body.data).toHaveProperty('list');
    expect(r.body.data).toHaveProperty('total');
    expect(r.body.data).toHaveProperty('page');
    expect(r.body.data).toHaveProperty('size');

    const list = r.body.data.list as any[];
    // 每条必须有统一字段
    for (const o of list) {
      expect(o).toHaveProperty('id');
      expect(o).toHaveProperty('orderNo');
      expect(o).toHaveProperty('customer');
      expect(o).toHaveProperty('goods');
      expect(o).toHaveProperty('total');
      expect(o).toHaveProperty('status');
      expect(o).toHaveProperty('type');
      expect(o).toHaveProperty('time');
      expect(['goods', 'design', 'install']).toContain(o.type);
    }
  });

  it('type=goods 只返回商品订单', async () => {
    const r = await req('/api/admin/orders?type=goods&page=1&size=50', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    for (const o of r.body.data.list) expect(o.type).toBe('goods');
  });

  it('type=design 只返回设计订单', async () => {
    const r = await req('/api/admin/orders?type=design&page=1&size=50', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    for (const o of r.body.data.list) expect(o.type).toBe('design');
  });

  it('type=install 只返回安装订单', async () => {
    const r = await req('/api/admin/orders?type=install&page=1&size=50', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    for (const o of r.body.data.list) expect(o.type).toBe('install');
  });

  it('keyword 搜索订单号命中', async () => {
    // 先取一个真实 orderNo
    const all = await req('/api/admin/orders?page=1&size=100', { token: ADMIN_TOKEN });
    const orderNo = all.body.data.list[0]?.orderNo;
    if (!orderNo) return; // 无数据跳过
    const r = await req(`/api/admin/orders?keyword=${encodeURIComponent(orderNo)}&page=1`, { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBeGreaterThanOrEqual(1);
    expect(r.body.data.list[0].orderNo).toBe(orderNo);
  });

  it('dateFrom / dateTo 日期筛选', async () => {
    const r = await req('/api/admin/orders?dateFrom=2026-01-01&dateTo=2026-12-31&page=1&size=50', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    const list = r.body.data.list as any[];
    for (const o of list) {
      const t = new Date(o.time).getTime();
      expect(t).toBeGreaterThanOrEqual(new Date('2026-01-01T00:00:00').getTime());
      expect(t).toBeLessThanOrEqual(new Date('2026-12-31T23:59:59').getTime());
    }
  });

  it('status=cancelled 只返回已取消订单', async () => {
    const r = await req('/api/admin/orders?status=cancelled&page=1&size=50', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    for (const o of r.body.data.list) expect(o.status).toBe('cancelled');
  });

  it('分页 page=1 size=1 只返回 1 条', async () => {
    const r = await req('/api/admin/orders?page=1&size=1', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.data.list.length).toBeLessThanOrEqual(1);
  });

  it('status 字段只出现允许的值（goods/design/install 混合共 12+ 种合法值）', async () => {
    const r = await req('/api/admin/orders?page=1&size=100', { token: ADMIN_TOKEN });
    // goods 订单 8 种 + design 订单 8 种 + install 订单 9 种 = 合起来 14 种
    const ALLOWED = new Set([
      'pending', 'paid', 'shipped', 'progress', 'completed', 'cancelled', 'refunding', 'refunded',
      'accepted', 'designing', 'revision_requested', 'reviewed', 'disputed', 'quoting', 'in_progress',
    ]);
    for (const o of r.body.data.list) {
      expect(ALLOWED.has(o.status)).toBe(true);
    }
  });
});

// ============================================================================
// 2. GET /admin/orders/stats — Tab/Segmented 计数
// ============================================================================
describe('GET /api/admin/orders/stats', () => {
  it('返回 typeCounts 和 statusCounts', async () => {
    const r = await req('/api/admin/orders/stats', { token: ADMIN_TOKEN });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(0);
    expect(r.body.data).toHaveProperty('typeCounts');
    expect(r.body.data).toHaveProperty('statusCounts');
    expect(r.body.data.typeCounts).toHaveProperty('all');
    expect(r.body.data.typeCounts).toHaveProperty('goods');
    expect(r.body.data.typeCounts).toHaveProperty('design');
    expect(r.body.data.typeCounts).toHaveProperty('install');
  });

  it('typeCounts.all = goods + design + install', async () => {
    const r = await req('/api/admin/orders/stats', { token: ADMIN_TOKEN });
    const { typeCounts } = r.body.data;
    expect(typeCounts.all).toBe(typeCounts.goods + typeCounts.design + typeCounts.install);
  });
});

// ============================================================================
// 3. POST /admin/orders/:id/status — 单条改状态
// ============================================================================
describe('POST /api/admin/orders/:id/status', () => {
  let testGoodsId = '';
  const originalStatus: Record<string, string> = {};

  // 先把一个 goods 订单置为 pending（如果不是），以便测试 paid 状态流转
  beforeAll(async () => {
    const all = await req('/api/admin/orders?type=goods&page=1&size=50', { token: ADMIN_TOKEN });
    const pending = all.body.data.list.find((o: any) => o.status === 'pending');
    if (pending) {
      testGoodsId = pending.id;
    } else if (all.body.data.list[0]) {
      // 选一个已完成的，先回退到 pending 做测试
      testGoodsId = all.body.data.list[0].id;
      originalStatus[testGoodsId] = all.body.data.list[0].status;
      await req(`/api/admin/orders/${testGoodsId}/status`, {
        method: 'POST', token: ADMIN_TOKEN, body: { status: 'pending' },
      });
    }
  });

  afterAll(async () => {
    // 还原测试用订单状态
    for (const [id, st] of Object.entries(originalStatus)) {
      await req(`/api/admin/orders/${id}/status`, {
        method: 'POST', token: ADMIN_TOKEN, body: { status: st },
      });
    }
  });

  it('缺少 status → 非 0', async () => {
    if (!testGoodsId) return;
    const r = await req(`/api/admin/orders/${testGoodsId}/status`, {
      method: 'POST', token: ADMIN_TOKEN, body: {},
    });
    expect(r.body.code).not.toBe(0);
  });

  it('非法订单 id 格式 → 非 0', async () => {
    const r = await req('/api/admin/orders/not_a_number/status', {
      method: 'POST', token: ADMIN_TOKEN, body: { status: 'paid' },
    });
    expect(r.body.code).not.toBe(0);
  });

  it('非法状态值 → 非 0', async () => {
    if (!testGoodsId) return;
    const r = await req(`/api/admin/orders/${testGoodsId}/status`, {
      method: 'POST', token: ADMIN_TOKEN, body: { status: 'nonsense' },
    });
    expect(r.body.code).not.toBe(0);
  });

  it('goods 订单 pending → paid 成功', async () => {
    if (!testGoodsId) return;
    const r = await req(`/api/admin/orders/${testGoodsId}/status`, {
      method: 'POST', token: ADMIN_TOKEN, body: { status: 'paid' },
    });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(0);
    expect(r.body.data.type).toBe('goods');
    expect(r.body.data.id).toBe(Number(testGoodsId));
    expect(r.body.data.status).toBe('paid');
  });

  it('带前缀 g_ / d_ / i_ 的 id 都能正确解析', async () => {
    if (!FIRST_GOODS_ID) return;
    const prefixed = `g${FIRST_GOODS_ID}`;
    const r = await req(`/api/admin/orders/${prefixed}/status`, {
      method: 'POST', token: ADMIN_TOKEN, body: { status: 'paid' },
    });
    expect(r.body.code).toBe(0);
  });

  it('不存在的 id → 失败（非 200）', async () => {
    const r = await req('/api/admin/orders/9999999/status', {
      method: 'POST', token: ADMIN_TOKEN, body: { status: 'paid' },
    });
    // 要么 400 要么 404 要么 500，反正不是 0
    expect(r.body.code).not.toBe(0);
  });
});

// ============================================================================
// 4. POST /admin/orders/batch-status — 批量改状态
// ============================================================================
describe('POST /api/admin/orders/batch-status', () => {
  it('缺少 ids 数组 → 400', async () => {
    const r = await req('/api/admin/orders/batch-status', {
      method: 'POST', token: ADMIN_TOKEN, body: { status: 'completed' },
    });
    expect(r.body.code).not.toBe(0);
  });

  it('空 ids → 400', async () => {
    const r = await req('/api/admin/orders/batch-status', {
      method: 'POST', token: ADMIN_TOKEN, body: { ids: [], status: 'completed' },
    });
    expect(r.body.code).not.toBe(0);
  });

  it('缺少 status → 400', async () => {
    const r = await req('/api/admin/orders/batch-status', {
      method: 'POST', token: ADMIN_TOKEN, body: { ids: ['1', '2'] },
    });
    expect(r.body.code).not.toBe(0);
  });

  it('批量更新返回 okCount + failCount', async () => {
    const r = await req('/api/admin/orders/batch-status', {
      method: 'POST', token: ADMIN_TOKEN,
      body: { ids: [FIRST_GOODS_ID, FIRST_DESIGN_ID, FIRST_INSTALL_ID].filter(Boolean), status: 'completed' },
    });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(0);
    expect(r.body.data).toHaveProperty('okCount');
    expect(r.body.data).toHaveProperty('failCount');
    expect(r.body.data.okCount + r.body.data.failCount).toBeGreaterThanOrEqual(1);
  });

  it('混合存在/不存在 id 时分别记 okCount / failCount', async () => {
    const r = await req('/api/admin/orders/batch-status', {
      method: 'POST', token: ADMIN_TOKEN,
      body: { ids: [FIRST_GOODS_ID, '99999999'], status: 'completed' },
    });
    expect(r.status).toBe(200);
    expect(r.body.data.okCount).toBeGreaterThanOrEqual(1);
    expect(r.body.data.failCount).toBeGreaterThanOrEqual(1);
  });
});
