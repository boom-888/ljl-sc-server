// ============================================================================
// 📍 Seed Areas — 省 / 市 / 区县三张码表
// 数据源: china-division v4 扁平结构
// 运行: cd server && node node_modules/tsx/dist/cli.mjs scripts/seed-areas.mjs
// ============================================================================
const { provinces, cities, areas } = require('china-division');
const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

// — 加载 .env —
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = Number(process.env.MYSQL_PORT) || 3306;
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DB = process.env.MYSQL_DATABASE;

if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DB) {
  console.error('❌ MYSQL 配置缺失，请检查 server/.env');
  process.exit(1);
}

(async function main() {
  console.log(`🌱 Areas Seed — china-division v4`);
  console.log(`   provinces=${provinces.length}  cities=${cities.length}  areas=${areas.length}`);

  const conn = await mysql.createConnection({
    host: MYSQL_HOST, port: MYSQL_PORT,
    user: MYSQL_USER, password: MYSQL_PASSWORD,
    database: MYSQL_DB,
  });
  console.log(`✅ MySQL 已连 ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`);

  // — 1. Truncate —
  console.log('🗑️  Truncate districts → cities → provinces');
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  await conn.query('TRUNCATE TABLE districts');
  await conn.query('TRUNCATE TABLE cities');
  await conn.query('TRUNCATE TABLE provinces');
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // — 2. Provinces —
  console.log('📝 Insert provinces...');
  for (const p of provinces) {
    await conn.query('INSERT INTO provinces (code, name) VALUES (?, ?)', [p.code, p.name]);
  }

  // — 3. Cities —
  console.log('📝 Insert cities...');
  const HOT = new Set(['1101', '1201', '3101', '5001']);
  for (const c of cities) {
    await conn.query(
      'INSERT INTO cities (code, name, provinceCode, isHot) VALUES (?, ?, ?, ?)',
      [c.code, c.name, c.provinceCode, HOT.has(c.code) ? 1 : 0],
    );
  }

  // — 4. Areas → districts —
  console.log('📝 Insert districts...');
  let count = 0;
  for (const a of areas) {
    await conn.query(
      'INSERT INTO districts (code, name, cityCode) VALUES (?, ?, ?)',
      [a.code, a.name, a.cityCode],
    );
    count++;
    if (count % 500 === 0) console.log(`   ... ${count}/${areas.length}`);
  }

  console.log(`\n✅ 种子灌入完成:`);
  console.log(`   provinces = ${provinces.length}`);
  console.log(`   cities    = ${cities.length}`);
  console.log(`   districts = ${areas.length}`);

  await conn.end();
})().catch((e) => {
  console.error('❌ Seed 失败:', e.message);
  process.exit(1);
});
