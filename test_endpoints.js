const http = require('http');
function req(method, path, token, body) {
  return new Promise((resolve) => {
    const u = new URL(path, 'http://localhost:3001');
    const o = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: {} };
    if (token) o.headers['Authorization'] = 'Bearer ' + token;
    if (body) { o.headers['Content-Type'] = 'application/json'; o.headers['Content-Length'] = Buffer.byteLength(body); }
    const r = http.request(o, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ s: res.statusCode, b: d })); });
    r.on('error', e => resolve({ s: 0, b: e.message }));
    if (body) r.write(body); r.end();
  });
}
async function run() {
  // setRole 直接返回带正确 role 的 token，用那个
  const getRoleToken = async (userId, role) => {
    const r = await req('POST','/api/auth/dev/set-role',null,JSON.stringify({userId,role}));
    const j = JSON.parse(r.b);
    return j.data.token;
  };
  const adminT = await getRoleToken(1,'admin');
  const consT = await getRoleToken(3,'consumer');

  const t = async (label,m,p,tk,body) => {
    const r = await req(m,p,tk,body);
    let pr = '';
    try { const j = JSON.parse(r.b); if (j.data) {
      if (Array.isArray(j.data)) pr = 'arr[' + j.data.length + ']';
      else if (typeof j.data === 'object') pr = Object.keys(j.data).slice(0,6).join(',');
      else pr = String(j.data).slice(0,25);
    } else if (j.msg) pr = j.msg.slice(0,30);
    } catch {}
    console.log((r.s<400?'✅':'❌') + ' ' + label + ' → ' + r.s + ' ' + pr);
  };

  console.log('\n=== 🔴 P0 designer ===');
  const dt = await getRoleToken(1,'designer');
  await t('designer /hall','GET','/api/designer/hall',dt);
  await t('designer /quotes','GET','/api/designer/quotes',dt);
  await t('designer POST /quote','POST','/api/designer/quote',dt,JSON.stringify({demandId:1,quotePrice:500,note:'测试'}));

  console.log('\n=== 🔴 P0 reviews ===');
  await t('reviews/mine vendor (admin看)','GET','/api/reviews/mine?role=vendor',adminT);
  await t('reviews/mine consumer-cross','GET','/api/reviews/mine?role=vendor',consT);

  console.log('\n=== 🔴 P0 notifications ===');
  await t('notifications list','GET','/api/notifications',consT);
  await t('notifications unread','GET','/api/notifications/unread-count',consT);

  console.log('\n=== 🟡 P1 vendor ===');
  const vt = await getRoleToken(1,'vendor');
  await t('vendor /dashboard','GET','/api/vendor/dashboard',vt);
  await t('vendor delivery-areas GET','GET','/api/vendor/delivery-areas-manage',vt);
  await t('vendor delivery-area POST','POST','/api/vendor/delivery-areas',vt,JSON.stringify({province:'浙江省',city:'杭州市',radiusKm:10}));
  await t('vendor stock PATCH','PATCH','/api/vendor/products/1/stock',vt,JSON.stringify({delta:10}));

  console.log('\n=== 🟡 P1 designer ===');
  await t('designer /dashboard','GET','/api/designer/dashboard',dt);
  await t('designer portfolio GET','GET','/api/designer/portfolio',dt);
  await t('designer portfolio POST','POST','/api/designer/portfolio',dt,JSON.stringify({title:'测试LOGO',designCategory:'logo'}));

  console.log('\n=== 🟡 P1 installer ===');
  const it = await getRoleToken(1,'installer');
  await t('installer /dashboard','GET','/api/installer/dashboard',it);
  await t('installer specialties','GET','/api/installer/specialties',it);
}
run();
