// ============================================================================
// 📜 Logger v2 — 分级日志（debug/info/warn/error）+ 控制台颜色 + 请求日志中间件
// ============================================================================
import fs from 'fs';
import path from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_NUM: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',   // 灰色
  info:  '\x1b[36m',   // 青色
  warn:  '\x1b[33m',   // 黄色
  error: '\x1b[31m',   // 红色
};
const RESET = '\x1b[0m';

// 生产环境默认关 debug，开发全开
const IS_PROD = process.env.NODE_ENV === 'production';
const LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || (IS_PROD ? 'info' : 'debug');
const SHOW_LOGO = process.env.LOG_SILENT !== '1';

function shouldShow(lvl: LogLevel): boolean {
  return LEVEL_NUM[lvl] >= LEVEL_NUM[LEVEL];
}

function fmt(level: LogLevel, msg: string, meta?: any): string {
  const ts = new Date().toISOString();
  const base = `${COLORS[level]}[${level.toUpperCase().padEnd(5)}] ${ts} ${msg}${RESET}`;
  if (meta !== undefined) {
    try { return base + ' ' + (typeof meta === 'string' ? meta : JSON.stringify(meta).slice(0, 500)); }
    catch { return base; }
  }
  return base;
}

// — 主入口 —
export function log(msg: string, level: LogLevel = 'info', meta?: any) {
  if (!shouldShow(level)) return;
  const line = fmt(level, msg, meta);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// 便捷方法
export const logger = {
  debug: (m: string, meta?: any) => log(m, 'debug', meta),
  info:  (m: string, meta?: any) => log(m, 'info', meta),
  warn:  (m: string, meta?: any) => log(m, 'warn', meta),
  error: (m: string, meta?: any) => log(m, 'error', meta),
};

// — Express 请求日志中间件 —
export function requestLogger() {
  return (req: any, res: any, next: any) => {
    const start = Date.now();
    const started = new Date().toISOString();
    res.on('finish', () => {
      const ms = Date.now() - start;
      const lvl: LogLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : ms > 500 ? 'warn' : 'info';
      log(`${req.method.padEnd(5)} ${req.originalUrl.padEnd(40)} ${res.statusCode} ${ms}ms`, lvl);
    });
    next();
  };
}

// 启动 banner
export function banner(port: number, storage: string) {
  if (!SHOW_LOGO) return;
  console.log('\n' + '='.repeat(55));
  console.log('  🚀 LJL Mall v1.0  (Sprint 1-10, 2026-10-09)');
  console.log(`  📡 http://localhost:${port}`);
  console.log(`  🗄️  Storage : ${storage}`);
  console.log(`  📦 Cache   : ${process.env.REDIS_HOST ? 'Redis (ioredis)' : 'Memory LRU'}`);
  console.log(`  📝 LogLevel: ${LEVEL}`);
  console.log('='.repeat(55) + '\n');
}
