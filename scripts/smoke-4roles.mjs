// 四端核心接口 200 探测
const BASE = 'http://localhost:3001';

const ROLES = [
  { key: 'admin',    account: '超级管理员',   password: '123456', paths: [
    '/api/admin/orders?page=1&size=5',
    '/api/admin/orders/stats',
    '/api/admin/users?page=1&size=5',
    '/api/admin/products?page=1&size=5',
  ]},
  { key: 'vendor',   account: '上海图文社',   password: '123456', paths: [
    '/api/vendor/profile',
    '/api/vendor/products',
    '/api/vendor/orders',
    '/api/vendor/earnings',
  ]},
  { key: 'consumer', account: '广告达人',     password: '123456', paths: [
    '/api/user/profile',
    '/api/cart',
    '/api/orders?page=1&size=5',
    '/api/coupon/mine',
  ]},
  { key: 'installer',account: '安装刘师傅',   password: '123456', paths: [
    '/api/installer/profile',
    '/api/installer/quotes',
    '/api/installer/orders',
    '/api/installer/dashboard',
  ]},
];

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
async function get(path, token) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const r = await fetch(BASE + path, { headers });
  try { return { status: r.status, ...(await r.json()) }; }
  catch { return { status: r.status, msg: 'non-json' }; }
}

const rows = [];
for (const role of ROLES) {
  const login = await post('/api/auth/login-account', { account: role.account, password: role.password });
  const token = login?.data?.token;
  const who = login?.data?.user;
  const whoStr = who ? `${who.nickname}(id=${who.id},${who.role})` : 'LOGIN_FAIL';
  rows.push({ role: role.key, step: 'login', path: '/api/auth/login-account', code: login.code ?? '-', msg: whoStr });

  if (!token) {
    for (const p of role.paths) rows.push({ role: role.key, step: 'skip', path: p, code: 'SKIP', msg: 'no token' });
    continue;
  }
  for (const p of role.paths) {
    const r = await get(p, token);
    const code = typeof r.code === 'number' ? r.code : `HTTP${r.status}`;
    const mark = (r.code === 0 || r.status === 200) ? '✓' : '✗';
    rows.push({ role: role.key, step: mark, path: p, code, msg: r.msg || (r.data?.list ? `list=${r.data.list.length}` : '') });
  }
}

// 简单表格
const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(pad('ROLE',10) + pad('STEP',6) + pad('CODE',8) + 'PATH' + '  ' + 'MSG');
console.log('-'.repeat(100));
let fail = 0;
for (const r of rows) {
  const ok = r.code === 0 || r.step === '✓';
  if (!ok && r.step !== 'login') fail++;
  if (r.step === 'login') continue; // 已打印
  console.log(pad(r.role,10) + pad(r.step,6) + pad(String(r.code),8) + r.path + '  ' + (r.msg||'').slice(0,40));
}
console.log('-'.repeat(100));
console.log(`总接口: ${rows.length - ROLES.length}  失败: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
