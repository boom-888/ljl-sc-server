// ============================================================================
// 🗄️ Database Manager — MySQL 自动连接 / SQLJS / 内存存储 三轨
// 优先级:
//   1. MYSQL_HOST + MYSQL_USER + MYSQL_DATABASE 同时存在 → MySQL (自动建库+synchronize)
//   2. DB_MODE=sqljs → sql.js (WASM SQLite，数据落盘到 data/ljl_sc.sqlite)
//   3. 其他 → db.ts 内存存储 (mock 模式)
// ============================================================================
import 'dotenv/config';
import { DataSource } from 'typeorm';
import mysql from 'mysql2/promise';
import { log } from './logger';
import * as entities from './entities';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';

const _seenNames = new Set<string>();
const UNIQUE_ENTITIES = Object.values(entities)
  .filter((v: any) => typeof v === 'function' && v.name.endsWith('Entity'))
  .filter((e: any) => {
    if (_seenNames.has(e.name)) {
      log(`⚠️ [db-manager] 跳过重复 Entity: ${e.name}`, 'warn');
      return false;
    }
    _seenNames.add(e.name);
    return true;
  });

export let dataSource: DataSource | null = null;

// ——— 模式判断 ———
function hasMysqlConfig(): boolean {
  return !!(process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_DATABASE);
}
function shouldUseSqljs(): boolean {
  return process.env.DB_MODE === 'sqljs' || process.env.USE_SQLJS === '1';
}

// ——— MySQL 自动建库 ———
async function ensureDatabase(): Promise<boolean> {
  try {
    const conn = await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD || '',
    });
    const dbName = process.env.MYSQL_DATABASE!;
    const [rows] = (await conn.query(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      [dbName],
    )) as any[];
    if (!rows || rows.length === 0) {
      await conn.query(
        `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      log(`✅ 自动创建数据库 ${dbName}`, 'info');
    } else {
      log(`✅ 数据库 ${dbName} 已存在`, 'info');
    }
    await conn.end();
    return true;
  } catch (e: any) {
    log(`⚠️ MySQL server 不可达 → 回退内存存储`, 'warn');
    return false;
  }
}

// ——— SQLJS 模式 ———
async function initSqljs(): Promise<{ mode: 'sqljs'; ds: DataSource } | null> {
  try {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();

    // 数据文件路径
    const dbPath = resolve(
      process.cwd(),
      process.env.SQLJS_PATH || './data/ljl_sc.sqlite',
    );
    mkdirSync(dirname(dbPath), { recursive: true });

    let database: any;
    if (existsSync(dbPath)) {
      const buf = readFileSync(dbPath);
      database = new SQL.Database(buf);
      log(`✅ sql.js 加载已有数据库 ${dbPath}`, 'info');
    } else {
      database = new SQL.Database();
      log(`🆕 sql.js 创建新数据库 ${dbPath}`, 'info');
    }

    dataSource = new DataSource({
      type: 'sqljs',
      database,
      entities: UNIQUE_ENTITIES,
      synchronize: true, // sql.js 空库自动 sync，不怕数据锁表
      logging: false,
    });
    await dataSource.initialize();

    // —— 启动时保存一次到文件（synchronize 会建表）——
    const save = () => {
      try {
        const data = (database as any).export();
        writeFileSync(dbPath, Buffer.from(data));
      } catch {}
    };
    save();

    log(`✅ sql.js TypeORM 连接成功 (${UNIQUE_ENTITIES.length} 实体表, ${dbPath})`, 'info');

    // 每 30s 自动保存一次
    setInterval(save, 30000);
    // 进程退出前保存
    process.on('beforeExit', save);
    process.on('SIGINT', () => { save(); process.exit(0); });

    return { mode: 'sqljs', ds: dataSource };
  } catch (e: any) {
    log(`⚠️ sql.js 初始化失败 → 回退内存存储: ${e.message}`, 'warn');
    dataSource = null;
    return null;
  }
}

// ——— MySQL 模式 ———
async function initMysql(): Promise<{ mode: 'mysql'; ds: DataSource } | null> {
  const dbOk = await ensureDatabase();
  if (!dbOk) return null;

  const isProd = process.env.NODE_ENV === 'production';
  let shouldSync = !isProd;
  if (isProd) {
    try {
      const testConn = await mysql.createConnection({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE!,
      });
      const [tbls] = (await testConn.query(
        `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ?`,
        [process.env.MYSQL_DATABASE!],
      )) as any[];
      const count = tbls?.[0]?.c ?? 0;
      await testConn.end();
      if (count === 0) { shouldSync = true; }
    } catch {}
  }

  try {
    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.MYSQL_HOST,
      port: Number(process.env.MYSQL_PORT) || 3306,
      username: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE,
      entities: UNIQUE_ENTITIES,
      synchronize: shouldSync,
      logging: process.env.NODE_ENV === 'development',
      charset: 'utf8mb4',
      timezone: '+08:00',
    });
    await dataSource.initialize();
    log(`✅ TypeORM MySQL 连接成功 (synchronize=${shouldSync}, ${UNIQUE_ENTITIES.length} 实体)`, 'info');
    return { mode: 'mysql', ds: dataSource };
  } catch (e: any) {
    log(`⚠️ TypeORM MySQL 失败 → 回退内存存储: ${e.message}`, 'warn');
    dataSource = null;
    return null;
  }
}

export async function initDatabase(): Promise<{ mode: 'mysql' | 'sqljs' | 'memory'; ds?: DataSource }> {
  if (hasMysqlConfig()) {
    const r = await initMysql();
    if (r) return r;
  }
  if (shouldUseSqljs()) {
    const r = await initSqljs();
    if (r) return r;
  }
  log('🧠 未配置 MySQL 或 sql.js，使用内存存储 (mock 模式)', 'warn');
  return { mode: 'memory' };
}

export function getRepo<T extends new (...args: any[]) => any>(Entity: T) {
  if (!dataSource) return null;
  return dataSource.getRepository(Entity);
}

export function getDataSource(): DataSource | null {
  return dataSource;
}
