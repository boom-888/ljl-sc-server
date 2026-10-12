// ============================================================================
// 🚀 LJL Mall · 本地冒烟脚本
// 后端内存 mock 模式（无 MySQL 依赖）验证全链路
// 用法：启动后端后 node scripts/smoke-local.mjs
// ============================================================================

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const http = require('http');

const BASE = 'http://localhost:3001';
const MOCK_CODE = '123456';

// ————— HTTP 封装 —————
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: {} };
    let data = null;
    if (body) { data = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; opts.headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function req(method, path, body, label) {
  try {
    const r = await request(method, path, body);
    const ok = r.status === 200 && (r.data?.code === 0 || r.data?.success || (typeof r.data === 'object' && !r.data?.code));
    const mark = ok ? '✅' : '❌';
    console.log(`${mark} ${label}: ${method} ${path} → ${r.status} code=${r.data?.code ?? r.data?.success ?? '-'}`);
    if (!ok) console.log(`   ↳ ${JSON.stringify(r.data).slice(0, 200)}`);
    return { ok, data: r.data };
  } catch (e) {
    console.log(`❌ ${label}: ${method} ${path} → ${e.message}`);
    return { ok: false, data: null };
  }
}

// ————— 测试体 —————
async function run() {
  console.log('═'.repeat(60));
  console.log('🚀 LJL Mall · 本地冒烟测试');
  console.log(`⏳ 目标: ${BASE}`);
  console.log('═'.repeat(60));

  let passed = 0, failed = 0;
  const check = (b) => { b ? passed++ : failed++; };

  // 0️⃣ Health
  console.log('\n📋 0️⃣  Health Check');
  const hc = await req('GET', '/health', null, '健康检查');
  check(hc.ok);

  // 1️⃣ 公开接口
  console.log('\n📋 1️⃣  公开接口');
  await req('GET', '/api/home', null, '首页配置');
  await req('GET', '/api/categories', null, '分类列表');
  await req('GET', '/api/products', null, '商品列表');

  // 2️⃣ 四角色登录（验证码 123456）
  console.log('\n📋 2️⃣  四角色登录（验证码 123456）');
  const logins = [
    { role: 'admin', phone: '13389210520' },
    { role: 'installer', phone: '13600004001' },
    { role: 'designer', phone: '13700003001' },
    { role: 'vendor', phone: '13900002001' },
  ];
  const tokens = {};
  for (const l of logins) {
    const r = await req('POST', '/api/auth/login', { phone: l.phone, code: MOCK_CODE }, `${l.role} 登录`);
    tokens[l.role] = r.data?.data?.token;
    check(r.ok && tokens[l.role]);
  }

  // 3️⃣ Admin 核心接口
  console.log('\n📋 3️⃣  Admin 核心接口（用 admin token）');
  const adminH = { Authorization: `Bearer ${tokens.admin}` };
  const adminGet = async (p, label) => {
    try {
      const r = await fetch(BASE + p, { headers: adminH });
      const j = await r.json();
      const ok = j.code === 0;
      console.log(`${ok ? '✅' : '❌'} ${label}: ${p} → code=${j.code}`);
      check(ok);
    } catch (e) { console.log(`❌ ${label}: ${e.message}`); check(false); }
  };
  await adminGet('/api/admin/stats', '统计概览');
  await adminGet('/api/admin/users', '用户列表');
  await adminGet('/api/admin/orders', '订单列表');
  await adminGet('/api/admin/products', '商品列表');
  await adminGet('/api/admin/categories', '分类管理');
  await adminGet('/api/admin/banners', 'Banner 管理');
  await adminGet('/api/admin/withdrawals', '提现审批');
  await adminGet('/api/admin/express-companies', '快递公司');

  // 4️⃣ 🎟️ 优惠券 CRUD（admin-coupon.ts）
  console.log('\n📋 4️⃣  🎟️ 优惠券 CRUD');
  let couponId = null;
  try {
    // 列表
    let r = await fetch(BASE + '/api/admin/coupons', { headers: adminH });
    let j = await r.json();
    console.log(`${j.code === 0 ? '✅' : '❌'} 优惠券列表 → code=${j.code} total=${j.data?.total ?? '-'}`);
    check(j.code === 0);

    // 新增
    r = await fetch(BASE + '/api/admin/coupons', { method: 'POST', headers: { ...adminH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '冒烟测试券', type: 'amount', value: 88, minAmount: 888, description: '冒烟测试用，可删', validDays: 7, total: 100, active: 1 }) });
    j = await r.json();
    console.log(`${j.code === 0 ? '✅' : '❌'} 新增券 → code=${j.code} id=${j.data?.coupon?.id ?? '-'}`);
    check(j.code === 0);
    couponId = j.data?.coupon?.id;

    if (couponId) {
      // 详情
      r = await fetch(BASE + `/api/admin/coupons/${couponId}`, { headers: adminH });
      j = await r.json();
      console.log(`${j.code === 0 ? '✅' : '❌'} 券详情 → code=${j.code}`);
      check(j.code === 0);

      // 编辑
      r = await fetch(BASE + `/api/admin/coupons/${couponId}`, { method: 'PUT', headers: { ...adminH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '冒烟测试券-已改', description: '已更新' }) });
      j = await r.json();
      console.log(`${j.code === 0 ? '✅' : '❌'} 编辑券 → code=${j.code}`);
      check(j.code === 0);

      // 启停
      r = await fetch(BASE + `/api/admin/coupons/${couponId}/toggle`, { method: 'POST', headers: adminH });
      j = await r.json();
      console.log(`${j.code === 0 ? '✅' : '❌'} 启停券 → code=${j.code} active=${j.data?.active}`);
      check(j.code === 0);

      // 删除（软删）
      r = await fetch(BASE + `/api/admin/coupons/${couponId}`, { method: 'DELETE', headers: adminH });
      j = await r.json();
      console.log(`${j.code === 0 ? '✅' : '❌'} 软删券 → code=${j.code}`);
      check(j.code === 0);
    }
  } catch (e) { console.log(`❌ 优惠券块异常: ${e.message}`); check(false); }

  // 5️⃣ 角色端核心
  console.log('\n📋 5️⃣  角色端核心接口');
  const auth = (role) => ({ Authorization: `Bearer ${tokens[role]}` });
  const roleTests = [
    { role: 'vendor', label: '供应商 /profile', url: '/api/vendor/profile' },
    { role: 'vendor', label: '供应商 /products', url: '/api/vendor/products' },
    { role: 'vendor', label: '供应商 /orders', url: '/api/vendor/orders' },
    { role: 'installer', label: '师傅 /hall', url: '/api/installer/hall' },
    { role: 'installer', label: '师傅 /orders', url: '/api/installer/orders' },
    { role: 'installer', label: '师傅 /earnings', url: '/api/installer/earnings' },
    { role: 'designer', label: '设计师 /demand/hall', url: '/api/demand/hall' },
    { role: 'designer', label: '设计师 /orders', url: '/api/designer/orders' },
    { role: 'designer', label: '设计师 /earnings', url: '/api/designer/earnings' },
  ];
  for (const t of roleTests) {
    try {
      const r = await fetch(BASE + t.url, { headers: auth(t.role) });
      const j = await r.json();
      const ok = r.status === 200;
      console.log(`${ok ? '✅' : '❌'} ${t.label} → HTTP ${r.status} code=${j.code ?? '-'}`);
      check(ok);
    } catch (e) { console.log(`❌ ${t.label}: ${e.message}`); check(false); }
  }

  // ————— 结果 —————
  console.log('\n' + '═'.repeat(60));
  console.log(`📊 结果: ${passed} ✅  ${failed} ❌  共 ${passed + failed}`);
  console.log(`🎯 通过率: ${Math.round((passed / (passed + failed)) * 100)}%`);
  console.log('═'.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error('💥 脚本崩溃:', e); process.exit(2); });
