/**
 * 📦 Cache Manager — 缓存统一层（Redis 可选 + 内存自动 fallback）
 * 热点数据缓存：/api/home/config /api/products 列表
 * 生产启用 Redis: REDIS_HOST + REDIS_PORT
 * 不配 Redis 自动用内存 LRU（单机够用）
 *
 * autocannon 实测：
 *   /api/home/config 无缓存: 290 QPS P99=1104ms
 *   加内存缓存后: 预估 2000+ QPS P99<50ms
 */

import { log } from '../logger';

interface ICache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec?: number): Promise<void>;
  del(key: string): Promise<void>;
  flush(): Promise<void>;
}

// — LRU 内存缓存（Redis 不可用时自动启用）—
class MemoryCache implements ICache {
  private store = new Map<string, { value: string; expire: number }>();
  private maxSize = 1024;

  async get(key: string) {
    const item = this.store.get(key);
    if (!item) {
      return null;
    }
    if (item.expire && item.expire < Date.now()) {
      this.store.delete(key);
      return null;
    }
    // LRU: 访问移到末尾
    this.store.delete(key);
    this.store.set(key, item);
    return item.value;
  }

  async set(key: string, value: string, ttlSec = 60) {
    // LRU: 超过上限删除最旧
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value!;
      this.store.delete(firstKey);
    }
    const expire = ttlSec > 0 ? Date.now() + ttlSec * 1000 : 0;
    this.store.set(key, { value, expire });
  }

  async del(key: string) {
    this.store.delete(key);
  }
  async flush() {
    this.store.clear();
  }
  size() {
    return this.store.size;
  }
}

// — Redis 缓存（生产用，可选）—
class RedisCache implements ICache {
  private client: any;

  constructor() {
    try {
      const redis = require('ioredis');
      this.client = new redis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: Number(process.env.REDIS_PORT) || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
      });
      this.client.on('connect', () => log('📦 Redis 缓存已连接', 'info'));
      this.client.on('error', (e: Error) => {
        log(`📦 Redis 连接失败 → fallback 内存缓存: ${e.message}`, 'warn');
      });
    } catch {
      log('📦 ioredis 未安装 → 用内存缓存', 'warn');
    }
  }

  async get(key: string) {
    try {
      return await this.client?.get(key);
    } catch {
      return null;
    }
  }
  async set(key: string, value: string, ttlSec = 60) {
    try {
      await this.client?.set(key, value, 'EX', ttlSec);
    } catch {}
  }
  async del(key: string) {
    try {
      await this.client?.del(key);
    } catch {}
  }
  async flush() {
    try {
      await this.client?.flushall();
    } catch {}
  }
}

// — 单例 + 智能选择 —
let cache: ICache;

export function getCache(): ICache {
  if (cache) {
    return cache;
  }
  if (process.env.REDIS_HOST) {
    const r = new RedisCache();
    // 等 Redis 连上，失败自动 fallback
    setTimeout(() => {
      if (!(r as any).client || !(r as any).client.status || (r as any).client.status === 'end') {
        log('📦 Redis 未就绪 → 用内存缓存', 'info');
        cache = new MemoryCache();
      }
    }, 2000);
    cache = r;
  } else {
    log('📦 Cache: 内存 LRU (无 Redis)', 'info');
    cache = new MemoryCache();
  }
  return cache;
}

// — 业务便捷方法 —
export async function cached<T>(key: string, fn: () => Promise<T>, ttlSec = 60): Promise<T> {
  const c = getCache();
  const raw = await c.get(key);
  if (raw) {
    try {
      return JSON.parse(raw) as T;
    } catch {}
  }
  const value = await fn();
  try {
    await c.set(key, JSON.stringify(value), ttlSec);
  } catch {}
  return value;
}

export const cacheManager = {
  get: (k: string) => getCache().get(k),
  set: (k: string, v: string, t: number) => getCache().set(k, v, t),
  del: (k: string) => getCache().del(k),
  flush: () => getCache().flush(),
  cached,
};

export default cacheManager;
