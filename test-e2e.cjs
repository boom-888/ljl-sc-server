// 四端 E2E 全链路测试脚本
// 运行: cd d:\00\ljl-sc\server; node test-e2e.cjs
const http = require('http');
const BASE = 'http://localhost:3001';

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request(
      { hostname: 'localhost', port: 3001, method, path, headers },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null });
          } catch (e) {
            reject(new Error('JSON parse fail: ' + d.slice(0, 200)));
          }
        });
      },
    );
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function login(account, password) {
  const r = await req('POST', '/api/auth/login-account', null, { account, password });
  if (r.json?.code !== 0) throw new Error(`login fail ${account}: ${JSON.stringify(r.json)}`);
  return { token: r.json.data.token, user: r.json.data.user };
}

let PASS = 0,
  FAIL = 0;
function ok(tag, msg) {
  PASS++;
  console.log(`  ✅ ${tag}: ${msg}`);
}
function fail(tag, msg) {
  FAIL++;
  console.log(`  ❌ ${tag}: ${msg}`);
}

async function main() {
  console.log('\n========================================');
  console.log('  🧪 四端 E2E 全链路测试');
  console.log('========================================\n');

  // ---- 登录所有角色 ----
  console.log('① 登录四端账号');
  let admin, designerLv2, designerLv3, designerLv5, installerLv3, vendor;
  try {
    admin = await login('admin', '123456');
    ok('admin', `ok role=${admin.user.role}`);
  } catch (e) { fail('admin', e.message); }
  try {
    // 刘创意 = grade=2 初级
    designerLv2 = await login('刘创意', '123456');
    ok('designerLv2', `ok role=${designerLv2.user.role}`);
  } catch (e) { fail('designerLv2', e.message); }
  try {
    // 陈设计工作室 = grade=3 中级
    designerLv3 = await login('陈设计工作室', '123456');
    ok('designerLv3', `ok role=${designerLv3.user.role}`);
  } catch (e) { fail('designerLv3', e.message); }
  try {
    // 赵大师 = grade=5 资深
    designerLv5 = await login('赵大师设计工作室', '123456');
    ok('designerLv5', `ok role=${designerLv5.user.role}`);
  } catch (e) { fail('designerLv5', e.message); }
  try {
    installerLv3 = await login('张师傅安装队', '123456');
    ok('installerLv3', `ok role=${installerLv3.user.role}`);
  } catch (e) { fail('installerLv3', e.message); }
  try {
    vendor = await login('零距离广告工厂', '123456');
    ok('vendor', `ok role=${vendor.user.role}`);
  } catch (e) { fail('vendor', e.message); }

  // ---- Admin 监管后台 ----
  console.log('\n② 🔴 Admin 监管后台');
  try {
    const r = await req('GET', '/api/admin/orders', admin.token);
    if (r.json?.code === 0 && Array.isArray(r.json.data?.list)) {
      ok('admin/orders', `返回 ${r.json.data.total} 条订单（goods+design+install 三表合并）`);
    } else fail('admin/orders', JSON.stringify(r.json).slice(0, 100));
  } catch (e) { fail('admin/orders', e.message); }

  try {
    const r = await req('GET', '/api/admin/stats', admin.token);
    if (r.json?.code === 0) ok('admin/stats', `概览 ${JSON.stringify(r.json.data?.overview).slice(0, 80)}`);
    else fail('admin/stats', r.json?.msg);
  } catch (e) { fail('admin/stats', e.message); }

  try {
    const r = await req('GET', '/api/admin/users', admin.token);
    if (r.json?.code === 0) ok('admin/users', `返回 ${r.json.data?.length ?? r.json.data?.total ?? '?'} 个用户`);
    else fail('admin/users', r.json?.msg);
  } catch (e) { fail('admin/users', e.message); }

  try {
    const r = await req('GET', '/api/admin/products', admin.token);
    if (r.json?.code === 0) ok('admin/products', `返回 ${r.json.data?.length ?? '?'} 个商品`);
    else fail('admin/products', r.json?.msg);
  } catch (e) { fail('admin/products', e.message); }

  // ---- 设计师 grade 过滤 ----
  console.log('\n③ 🎨 设计师 grade 交叉过滤');
  try {
    // 刘创意 grade=2 初级
    const h2 = await req('GET', '/api/demand/hall', designerLv2.token);
    // 陈设计 grade=3 中级
    const h3 = await req('GET', '/api/demand/hall', designerLv3.token);
    // 赵大师 grade=5 资深
    const h5 = await req('GET', '/api/demand/hall', designerLv5.token);

    const list2 = h2.json?.data?.list || [];
    const list3 = h3.json?.data?.list || [];
    const list5 = h5.json?.data?.list || [];
    const sg2 = h2.json?.data?.selfGrade;
    const sg3 = h3.json?.data?.selfGrade;
    const sg5 = h5.json?.data?.selfGrade;

    ok('grade.selfGrade', `Lv.2=${sg2}  Lv.3=${sg3}  Lv.5=${sg5}`);

    // 验证每条返回的需求都满足 gradeMin ≤ self ≤ gradeMax
    const checkRange = (list, selfG, tag) => {
      for (const d of list) {
        if (selfG < d.gradeMin || selfG > d.gradeMax) {
          fail(`${tag} grade check`, `需求 ${d.id} gradeMin=${d.gradeMin} gradeMax=${d.gradeMax} 不包含 self=${selfG}`);
          return false;
        }
      }
      return true;
    };
    if (checkRange(list2, sg2, 'Lv.2')) ok('grade.range.Lv2', `全部 ${list2.length} 条符合 Lv.2 范围`);
    if (checkRange(list3, sg3, 'Lv.3')) ok('grade.range.Lv3', `全部 ${list3.length} 条符合 Lv.3 范围`);
    if (checkRange(list5, sg5, 'Lv.5')) ok('grade.range.Lv5', `全部 ${list5.length} 条符合 Lv.5 范围`);

    // 数量对比：Lv.5 应该 ≥ Lv.3 ≥ Lv.2（高等级能看到更多）
    if (list5.length >= list3.length && list3.length >= list2.length) {
      ok('grade.coverage', `Lv.5(${list5.length}) ≥ Lv.3(${list3.length}) ≥ Lv.2(${list2.length}) ✓ 高等级覆盖更广`);
    } else {
      fail('grade.coverage', `Lv.5=${list5.length} Lv.3=${list3.length} Lv.2=${list2.length} 不满足递减`);
    }
  } catch (e) {
    fail('grade-filter', e.message);
  }

  // ---- 安装师傅 grade 过滤 ----
  console.log('\n④ 🔧 安装师傅 grade 过滤');
  try {
    const h = await req('GET', '/api/installer/hall', installerLv3.token);
    if (h.json?.code === 0) {
      const list = h.json.data?.jobs || [];
      const sg = h.json.data?.selfGrade;
      ok('installer.hall', `selfGrade=${sg} 返回 ${list.length} 条需求`);
      for (const d of list) {
        if (sg < (d.gradeMin ?? 1) || sg > (d.gradeMax ?? 6)) {
          fail('installer.grade', `需求 ${d.id} 范围不包含 self=${sg}`);
          break;
        }
      }
      if (list.length > 0) ok('installer.grade.range', `全部符合 Lv.${sg} 范围`);
    } else {
      fail('installer.hall', h.json?.msg);
    }
  } catch (e) {
    fail('installer.hall', e.message);
  }

  // ---- 供应商工作台 ----
  console.log('\n⑤ 🛒 供应商工作台');
  try {
    const p = await req('GET', '/api/vendor/profile', vendor.token);
    if (p.json?.code === 0) {
      ok('vendor.profile', `昵称=${p.json.data.nickname}  stats=${JSON.stringify(p.json.data.stats)}`);
    } else fail('vendor.profile', p.json?.msg);
  } catch (e) { fail('vendor.profile', e.message); }

  try {
    const prod = await req('GET', '/api/vendor/products', vendor.token);
    if (prod.json?.code === 0) ok('vendor.products', `total=${prod.json.data.total}`);
    else fail('vendor.products', prod.json?.msg);
  } catch (e) { fail('vendor.products', e.message); }

  try {
    const o = await req('GET', '/api/vendor/orders', vendor.token);
    if (o.json?.code === 0) {
      const paidOrder = o.json.data.list.find((x) => x.status === 'paid');
      ok('vendor.orders', `total=${o.json.data.total}  paid待发货=${o.json.data.list.filter((x) => x.status === 'paid').length}`);
      // 测试发货
      if (paidOrder) {
        const ship = await req(
          'POST',
          `/api/vendor/orders/${paidOrder.id}/ship`,
          vendor.token,
          { shippingType: 'express', shippingCompany: '顺丰速运', shippingNo: 'SF' + Date.now() },
        );
        if (ship.json?.code === 0 && ship.json.data?.status === 'shipped') {
          ok('vendor.ship', `订单 ${paidOrder.orderNo} 已发货 → status=shipped`);
        } else {
          fail('vendor.ship', JSON.stringify(ship.json));
        }
      }
    } else fail('vendor.orders', o.json?.msg);
  } catch (e) { fail('vendor.orders', e.message); }

  // ---- 订单状态流转 ----
  console.log('\n⑥ 订单状态流转（admin 强制修改）');
  try {
    // 先找一个商品订单测试流转
    const all = await req('GET', '/api/admin/orders?type=goods', admin.token);
    const testOrder = all.json?.data?.list?.[0];
    if (testOrder) {
      const orderId = testOrder.id;
      // 先设成 paid
      const r1 = await req('POST', `/api/admin/orders/${orderId}/status`, admin.token, { status: 'paid' });
      if (r1.json?.code === 0) ok('status→paid', `${testOrder.orderNo} → paid`);
      else fail('status→paid', JSON.stringify(r1.json));

      // 再设成 shipped
      const r2 = await req('POST', `/api/admin/orders/${orderId}/status`, admin.token, { status: 'shipped' });
      if (r2.json?.code === 0) ok('status→shipped', `${testOrder.orderNo} → shipped`);
      else fail('status→shipped', JSON.stringify(r2.json));

      // 批量改
      const r3 = await req('POST', '/api/admin/orders/batch-status', admin.token, { ids: [orderId], status: 'completed' });
      if (r3.json?.code === 0) ok('batch→completed', `okCount=${r3.json.data?.okCount}`);
      else fail('batch→completed', JSON.stringify(r3.json));
    } else fail('order-flow', '没有商品订单可测');
  } catch (e) { fail('order-flow', e.message); }

  // ---- Admin 兜底告警 ----
  console.log('\n⑦ 🚨 admin 告警引擎');
  try {
    const alerted = await req('GET', '/api/admin/orders?alerted=true', admin.token);
    if (alerted.json?.code === 0) {
      const cnt = alerted.json.data?.list?.length || 0;
      ok('admin.alerted', `检测到 ${cnt} 条异常订单`);
    } else fail('admin.alerted', alerted.json?.msg);
  } catch (e) { fail('admin.alerted', e.message); }

  // ---- 汇总 ----
  console.log('\n========================================');
  console.log(`  🏁 结果: ${PASS} pass / ${FAIL} fail`);
  console.log('========================================\n');

  process.exit(FAIL > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
