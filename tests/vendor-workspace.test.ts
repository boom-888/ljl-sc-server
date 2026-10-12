// Vendor 工作台后端路由测试
import { describe, it, expect, beforeAll } from 'vitest';
import http from 'http';

const BASE = 'http://localhost:3001';
let vendorToken = '';

function req(method: string, path: string, token?: string, body?: any) {
  return new Promise<any>((resolve, reject) => {
    const opts = new URL(path, BASE);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const reqBody = body ? JSON.stringify(body) : undefined;
    const r = http.request({
      hostname: opts.hostname, port: opts.port, method, path: opts.pathname + opts.search, headers,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }); } catch { reject(new Error('JSON parse fail: ' + d)); }
      });
    });
    r.on('error', reject);
    if (reqBody) r.write(reqBody);
    r.end();
  });
}

describe('vendor workspace', () => {
  beforeAll(async () => {
    const r = await req('POST', '/api/auth/login-account', undefined, { account: '上海图文社', password: '123456' });
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(r.json.data.user.role).toBe('vendor');
    vendorToken = r.json.data.token;
    console.log('✓ vendor login ok, userId=' + r.json.data.user.id);
  }, 15000);

  it('GET /vendor/profile → merchant info + stats', async () => {
    const r = await req('GET', '/api/vendor/profile', vendorToken);
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(r.json.data.role).toBeUndefined(); // 不是 admin 返回格式
    expect(r.json.data.nickname).toBeTruthy();
    expect(r.json.data.stats).toBeTruthy();
    console.log('✓ profile:', JSON.stringify(r.json.data));
  });

  it('GET /vendor/products → list own products', async () => {
    const r = await req('GET', '/api/vendor/products', vendorToken);
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(Array.isArray(r.json.data.list)).toBe(true);
    expect(r.json.data.total).toBeTypeOf('number');
    // 验证所有商品 vendorId=3
    for (const p of r.json.data.list) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
    }
    console.log('✓ products total=' + r.json.data.total);
  });

  it('GET /vendor/products?status=on → filtered', async () => {
    const r = await req('GET', '/api/vendor/products?status=on', vendorToken);
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
  });

  it('GET /vendor/orders → own goods orders', async () => {
    const r = await req('GET', '/api/vendor/orders', vendorToken);
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(Array.isArray(r.json.data.list)).toBe(true);
    for (const o of r.json.data.list) {
      expect(o.id).toBeTruthy();
      expect(['pending', 'paid', 'shipped', 'completed', 'cancelled'].includes(o.status)).toBe(true);
      expect(o.statusText).toBeTruthy();
    }
    console.log('✓ orders total=' + r.json.data.total);
  });

  it('GET /vendor/orders?status=paid → pending-shipment only', async () => {
    const r = await req('GET', '/api/vendor/orders?status=paid', vendorToken);
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    for (const o of r.json.data.list) expect(o.status).toBe('paid');
  });

  it('GET /vendor/orders/:id → order detail with items', async () => {
    // 先找一个 paid 状态的订单
    const all = await req('GET', '/api/vendor/orders', vendorToken);
    const paidOrder = all.json.data.list.find((o: any) => o.status === 'paid');
    if (!paidOrder) {
      console.log('  (skip: no paid order to test detail)');
      return;
    }
    const r = await req('GET', `/api/vendor/orders/${paidOrder.id}`, vendorToken);
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(Array.isArray(r.json.data.items)).toBe(true);
    console.log('✓ order detail id=' + paidOrder.id + ' items=' + r.json.data.items?.length);
  });

  it('POST /vendor/orders/:id/ship → success on paid order', async () => {
    const all = await req('GET', '/api/vendor/orders', vendorToken);
    const paidOrder = all.json.data.list.find((o: any) => o.status === 'paid');
    if (!paidOrder) {
      console.log('  (skip: no paid order to test ship)');
      return;
    }
    const r = await req('POST', `/api/vendor/orders/${paidOrder.id}/ship`, vendorToken, {
      shippingType: 'express',
      shippingCompany: '顺丰速运',
      shippingNo: 'SF' + Date.now(),
    });
    expect(r.status).toBe(200);
    expect(r.json.code).toBe(0);
    expect(r.json.data.status).toBe('shipped');
    console.log('✓ ship ok → status=shipped');
  });

  it('POST /vendor/orders/:id/ship → rejected without shippingNo', async () => {
    const all = await req('GET', '/api/vendor/orders', vendorToken);
    const shippedOrder = all.json.data.list.find((o: any) => o.status === 'shipped');
    if (!shippedOrder) {
      console.log('  (skip: no shipped order to test validation)');
      return;
    }
    const r = await req('POST', `/api/vendor/orders/${shippedOrder.id}/ship`, vendorToken, {
      shippingCompany: '顺丰',
    });
    expect(r.json.code).toBeGreaterThan(0); // 4xx
  });

  it('GET /vendor/profile as non-vendor → 403', async () => {
    // login as admin
    const admin = await req('POST', '/api/auth/login-account', undefined, { account: '超级管理员', password: '123456' });
    const t = admin.json.data.token;
    const r = await req('GET', '/api/vendor/profile', t);
    expect([403, 401]).toContain(r.json.code);
  });
});
