// ============================================================================
// 🚀 LJL Mall Sprint 10 Server — Express
// 13 endpoint（Auth 7 + Home 6）
// 存储自动切换：MYSQL_* 环境变量存在 → TypeORM MySQL；否则 → 内存 mock
// JWT_SECRET 必填（生产强制 32 字符以上）
// ============================================================================
// dotenv 加载统一由 auth.ts / db-manager.ts 顶部 `import 'dotenv/config'` 完成
// 根目录 .env 作为唯一配置源（auth.ts/db-manager.ts/所有 route 模块都从同一个文件读）
const dotenv = require('dotenv');
dotenv.config(); // 默认加载根目录 .env（和 auth.ts/db-manager.ts 一致，幂等 no-op）
console.log(`[env] root .env loaded (JWT_SECRET=${process.env.JWT_SECRET?.slice(0,20) || 'UNDEFINED'}...)`);

import express from 'express';
import cors from 'cors';
import fileUpload from 'express-fileupload';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { seed } from './db';
import { initDatabase } from './db-manager';
import authRoutes from './routes/auth';
import homeRoutes from './routes/home';
import userRoutes from './routes/user';
import cartRoutes from './routes/cart';
import orderRoutes from './routes/order';
import addressRoutes from './routes/address';
import designFileRoutes from './routes/design-file';
import adminRoutes from './routes/admin';
import adminExpressRoutes from './routes/admin-express';
import adminFinanceRoutes from './routes/admin-finance';
import adminSettingsRoutes from './routes/admin-settings';
import adminCouponRoutes from './routes/admin-coupon';
import designDemandRoutes from './routes/design-demand';
import designOrderRoutes from './routes/design-order';
import installationRoutes from './routes/installation';
import installerRoutes from './routes/installer';
import designerRoutes from './routes/designer';
import vendorRoutes from './routes/vendor';
import uploadsRoutes from './routes/uploads';
// Sprint 6 — 用户资产/沟通/帮助
import favoriteRoutes from './routes/favorite';
import couponRoutes from './routes/coupon';
import serviceRoutes from './routes/service';
import messageRoutes from './routes/message';
import chatRoutes from './routes/chat';
import notificationsRoutes from './routes/notifications';
import invoiceRoutes from './routes/invoice';
import helpRoutes from './routes/help';
import disputeRoutes from './routes/dispute';
import maskedRoutes from './routes/masked';
import reviewRefundRoutes from './routes/review-refund';
import masterOrderRoutes from './routes/master-order';
import deviceRoutes from './routes/device';
import { log, serverError, decodeToken, requestLogger, banner } from './middleware/auth';
import { findUserByIdORM } from './db-orm';
import { smsGateway } from './services/sms-gateway';
import { eventBus } from './services/event-bus';
import { registerSseDevice, unregisterSseDevice } from './services/push';
import { startScheduler } from './services/scheduler';

const PORT = Number(process.env.PORT) || 3001;

// — 🛡️ 进程级异常兜底（防 Sprint 连跑时某个 async 路由 throw 导致进程 exit）—
// Express 中间件只 catch 同步链上的错误；微任务 / setImmediate / SSE 回调里的 throw 会穿透到这里
process.on('uncaughtException', (err, origin) => {
  console.error(`[PROC] uncaughtException from ${origin}:`, err?.message || err);
  console.error(err?.stack || '');
  // 不 exit，继续服务（内存 mock 模式允许这个行为）
});
process.on('unhandledRejection', (reason, promise) => {
  const r = reason as any;
  console.error('[PROC] unhandledRejection:', r?.message || r);
  console.error(r?.stack || '');
});
process.on('SIGINT', () => {
  console.log('\n[PROC] SIGINT received, exiting...');
  process.exit(0);
});

async function bootstrap() {
  // 1. 数据库初始化（TypeORM MySQL vs 内存 mock）
  const { mode } = await initDatabase();

  // 2. Seed（内存模式必跑；MySQL 模式首次迁移后也会自动 synchronize + 双写到 MySQL）
  await seed();

  // 3. Express App
  const app = express();
  // 🛡️ 反代模式下必须设 trust proxy — 否则 nginx 传的 X-Forwarded-For 会让
  // express-rate-limit 的 keyGenerator 抛 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  app.set('trust proxy', 1);
  // 🛡️ CORS — credentials:true 时 origin 不能是 '*'（浏览器 CORS 规范）
  // 白名单来源: CORS_ORIGIN 环境变量（逗号分隔），fallback 内置
  const rawCors = (process.env.CORS_ORIGIN || '').trim();
  const envWhitelist = rawCors && rawCors !== '*'
    ? rawCors.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const fallbackWhitelist = [
    'http://192.168.10.5',
    'https://192.168.10.5',
    'http://localhost',
    'http://127.0.0.1',
  ];
  const effectiveWhitelist = envWhitelist.length > 0 ? envWhitelist : fallbackWhitelist;
  const corsWildcard = rawCors === '*';

  app.use(
    cors({
      origin(origin, callback) {
        // Allow no-origin (curl / Postman)
        if (!origin) return callback(null, true);
        // 开发模式全开放
        if (corsWildcard && process.env.NODE_ENV !== 'production') return callback(null, true);
        // 前缀匹配（允许同域名不同端口）
        const host = origin.replace(/:\d+$/, '');
        if (effectiveWhitelist.some((w) => w.startsWith(host))) return callback(null, true);
        callback(new Error(`CORS rejected: ${origin} (whitelist: ${effectiveWhitelist.join(',')})`));
      },
      credentials: true,
    }),
  );

  // 🛡️ Helmet 安全头 + CSP（Content-Security-Policy）
  // 开发模式：宽松 CSP（允许 H5 dev server inline script）
  // 生产：严格 CSP（只允许 self）
  const isProd = process.env.NODE_ENV === 'production';
  app.use(
    helmet({
      contentSecurityPolicy: isProd
        ? {
            useDefaults: true,
            directives: {
              defaultSrc: ["'self'"],
              imgSrc: ["'self'", 'data:', 'http:'],
              upgradeInsecureRequests: null, // 内网 HTTP 环境关掉，否则浏览器把 http 资源升级成 https
            },
          }
        : false, // 开发关闭 CSP 避免挡 H5 inline script
      crossOriginResourcePolicy: { policy: 'cross-origin' }, // OSS 静态文件跨域
      crossOriginEmbedderPolicy: false, // 允许多源资源（OSS 图片）
      hsts: false, // 内网 HTTP 环境不用强制 HTTPS，否则浏览器把 admin 静态资源升级成 https 导致加载失败
    }),
  );

  // 🛡️ Rate Limiting — 开发/测试模式跳过（E2E 共享 IP 请求量大），生产启用
  const isDev = process.env.NODE_ENV !== 'production';
  const globalLimiter = rateLimit({
    windowMs: 60_000,
    max: 3000,
    standardHeaders: true,
    legacyHeaders: false, // 生产 300，开发 3000
    message: { code: 429, msg: '请求过于频繁，请稍后再试' },
    skip: (req: any) => isDev || req.path === '/health' || req.path.startsWith('/oss/'),
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    max: isDev ? 500 : 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, msg: '登录尝试过于频繁，请 15 分钟后再试' },
    skip: () => isDev,
  });
  // P7: 头像上传限频 —— 防止无限上传撑爆磁盘
  const avatarLimiter = rateLimit({
    windowMs: 10 * 60_000,
    max: isDev ? 200 : 20,  // 正式环境 10 分钟 20 次足够
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 429, msg: '头像上传过于频繁，请稍后再试' },
    skip: () => isDev,
  });
  app.use('/api/', globalLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/user/avatar', avatarLimiter);

  app.use(express.json({ limit: '1mb' }));
  // 文件上传中间件 — 200MB（设计文件/资质图/头像共用）
  app.use(fileUpload({
    limits: { fileSize: 200 * 1024 * 1024 },
    createParentPath: true,
    abortOnLimit: true,
    useTempFiles: true,
    tempFileDir: path.join(__dirname, '..', 'tmp'),
  }));
  app.use(requestLogger());  // 📝 请求日志中间件（按 statusCode 分级：500→error, 400→warn, >500ms→warn）

  // — 健康检查 —
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      pid: process.pid,
      env: process.env.NODE_ENV || 'development',
      memory: process.memoryUsage(),
    });
  });

  // — 🛠️ Dev-only DB 快照 —
  app.get('/debug/db', async (_req, res) => {
    if (process.env.NODE_ENV === 'production') return res.status(404).end();
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) return res.json({ mode: 'memory', db_users: db.users.length, db_products: db.products.length });
    try {
      // 从 entities/index 已 re-export 的类型
      const ents = await import('./entities');
      const UserEntity = (ents as any).UserEntity;
      const ProductEntity = (ents as any).ProductEntity;
      const CategoryEntity = (ents as any).CategoryEntity;
      const InstallerProfileEntity = (await import('./entities/sprint5')).InstallerProfileEntity;
      const DesignerProfileEntity = (await import('./entities/sprint5')).DesignerProfileEntity;
      const users = await ds.getRepository(UserEntity).find({ take: 14, select: ['id', 'phone', 'role', 'nickname'] });
      const prods = await ds.getRepository(ProductEntity).find({ take: 5, select: ['id', 'name', 'vendorId', 'stock', 'status'] });
      const ips = await ds.getRepository(InstallerProfileEntity).find();
      const dps = await ds.getRepository(DesignerProfileEntity).find();
      res.json({ mode: 'sqljs', users, products: prods, installer_profiles: ips, designer_profiles: dps });
    } catch (e: any) {
      res.json({ err: String(e), stack: e?.stack });
    }
  });

  // — SSE 实时事件推送 —
  // 前端用 EventSource 连接（只能走 GET + query token） → 按 role:userId 过滤推送
  // 也兼容 fetch+ReadableStream 走 Authorization header
  app.get('/api/events', async (req, res) => {
    // 🔑 token 来源：优先 header，fallback query param（EventSource 加不了 header）
    const auth = req.headers.authorization || '';
    const headerToken = auth.replace(/^Bearer\s+/i, '');
    const queryToken = (req.query.token as string) || '';
    const token = headerToken || queryToken;

    let userId = 0;
    let busRole: 'user' | 'installer' | 'designer' | 'admin' | 'broadcast' = 'user';

    if (token) {
      const decoded = decodeToken(token);
      if (decoded?.sub) {
        userId = Number(decoded.sub);
        // role 优先 JWT payload（新 token 带 role），fallback 查 DB
        let rawRole = decoded.role;
        if (!rawRole) {
          try {
            const u = await findUserByIdORM(userId);
            rawRole = u?.role;
          } catch {
            /* 忽略 */
          }
        }
        // 映射 users.role → event-bus targetRole
        const map: Record<string, 'user' | 'installer' | 'designer' | 'admin' | 'broadcast'> = {
          consumer: 'user',
          installer: 'installer',
          designer: 'designer',
          admin: 'admin',
          vendor: 'user',
        };
        busRole = (rawRole && map[rawRole]) || 'user';
      }
    }
    // 未登录 → broadcast 级（只能收到 broadcast 事件）

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const clientId = `${busRole}:${userId}:${Date.now()}`;
    eventBus.subscribe(clientId, res);
    res.write(
      `event: hello\ndata: {"clientId":"${clientId}","role":"${busRole}","userId":${userId}}\n\n`,
    );

    // — P1：SSE 连接自动注册到 push_devices（有 userId 才注册）—
    if (userId > 0) {
      registerSseDevice(userId, clientId).catch(() => {});
    }
    // 客户端断开：eventBus 自动下线 clientId，同时清理 push_devices 记录
    res.on('close', () => {
      eventBus.unsubscribe(clientId);
      unregisterSseDevice(clientId).catch(() => {});
      log(`[SSE] ${clientId} disconnected`);
    });

    log(`[SSE] ${clientId} connected (token=${token ? '✓' : 'anonymous'})`);
  });

  // — 业务路由 —
  app.use('/api', homeRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/user', userRoutes);
  // Sprint 2 —
  app.use('/api/cart', cartRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/addresses', addressRoutes);
  // Sprint 3 —
  app.use('/api/design-file', designFileRoutes);
  // Sprint 3.5 — 设计需求持久化
  app.use('/api/demand', designDemandRoutes);
  app.use('/api', designOrderRoutes); // design-order 路由同时包含 /demand/:id/xxx 和 /designer/orders/:id/xxx
  // Admin —
  app.use('/api/admin', adminRoutes);
  app.use('/api/admin', adminExpressRoutes); // v4.1 Sprint 10：快递/配送
  app.use('/api/admin', adminFinanceRoutes);  // v4.1 Sprint 10：财务看板 + 冻结池 + 纠纷
  app.use('/api/admin', adminSettingsRoutes); // Sprint 11：系统配置
  app.use('/api/admin', adminCouponRoutes);   // Week 5：优惠券模板 CRUD
  // Sprint 4 — 安装需求众包（用户端）
  app.use('/api/installation', installationRoutes);
  // Sprint 5 — 师傅端安装服务
  app.use('/api/installer', installerRoutes);
  // Sprint 5.5 — 设计师端
  app.use('/api/designer', designerRoutes);
  // 🛡️ Sprint 6：设计需求 + 设计订单（之前 import 了但没 mount → 所有 design-demand 路由全挂！）
  app.use('/api/design-demand', designDemandRoutes);
  app.use('/api/design-order', designOrderRoutes);
  // Sprint 5.6 — 供应商端
  app.use('/api/vendor', vendorRoutes);
  app.use('/api/uploads', uploadsRoutes); // 🆕 通用文件上传（requireAuth，不限角色）
  // Sprint 6 — 用户资产/沟通/帮助
  app.use('/api/favorite', favoriteRoutes);
  app.use('/api/coupon', couponRoutes);
  app.use('/api/service', serviceRoutes);
  app.use('/api/message', messageRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/notifications', notificationsRoutes);
  app.use('/api/invoice', invoiceRoutes);
  app.use('/api', helpRoutes);
  app.use('/api', disputeRoutes);
  app.use('/api/masked', maskedRoutes);
  // Sprint 10 — 评价 + 退款
  app.use('/api', reviewRefundRoutes);
  // 🏗️ P0 — MasterOrder 聚合根查询
  app.use('/api/master-order', masterOrderRoutes);

  // — P1 推送设备注册 —
  app.use('/api/device', deviceRoutes);

  // — 全局错误处理 —
  app.use((err: any, _req: any, res: any, _next: any) => {
    log(`Unhandled: ${err?.message || err}`, 'error');
    serverError(res, '服务器内部错误');
  });

  // ========== 前端静态文件 + SPA fallback ==========
  // 构建产物放 /opt/ljl-sc/dist/（__dirname 是 server/src/ → ../dist）
  const DIST_DIR = path.join(__dirname, '..', 'dist');
  app.use(
    express.static(DIST_DIR, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          // index.html / fallback —— 永不缓存，每次都验证最新版本
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else if (/\.[a-f0-9]{8,}\.(js|css)$/.test(filePath)) {
          // 带 hash 的静态资源 —— 长缓存（文件名变了=内容变了）
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );

  // ========== 统一工作台登录入口 ==========
  // 四端（admin / vendor / designer / installer）统一登录页 → 选角色 + 账号密码 → 跳对应工作台
  const WORKSPACE_DIR = path.join(__dirname, '..', 'workspace');
  app.use('/workspace', express.static(WORKSPACE_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('/workspace', (_req, res) => {
    res.sendFile(path.join(WORKSPACE_DIR, 'index.html'));
  });
  // 根路径也自动跳到工作台登录页（开发调试用）
  app.get('/', (_req, res) => {
    res.redirect('/workspace');
  });

  // ========== 管理后台静态文件 ==========
  // 构建产物放 /opt/ljl-sc/admin/（__dirname 是 server/src/ → ../admin）
  const ADMIN_DIR = path.join(__dirname, '..', 'admin');
  app.use('/admin', express.static(ADMIN_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  // admin SPA fallback：任何 /admin/* 找不到的都回 index.html
  app.get('/admin/*', (_req, res) => {
    res.sendFile(path.join(ADMIN_DIR, 'index.html'));
  });

  // ========== PC 角色工作台静态文件 ==========
  // installer / designer / vendor 三套角色端
  const PC_DIR = path.join(__dirname, '..', 'pc');
  app.use('/pc', express.static(PC_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('/pc/*', (_req, res) => {
    res.sendFile(path.join(PC_DIR, 'index.html'));
  });

  // ========== 📦 OSS 文件存储 ==========
  // 服务器本地 /opt/ljl-sc/oss/ → 通过 /oss/* 访问（express.static 绕过 SPA fallback）
  // P4 安全加固：SVG 强制 Content-Disposition: attachment 防 XSS（SVG 可嵌 JS）
  const OSS_DIR = path.join(__dirname, '..', 'oss');
  app.use(
    '/oss',
    express.static(OSS_DIR, {
      setHeaders: (res, filepath) => {
        const ext = path.extname(filepath).toLowerCase();
        // SVG 里可嵌 <script>，浏览器直接渲染 = XSS
        // 强制下载后用户在浏览器里不会被自动执行
        if (ext === '.svg') {
          res.setHeader('Content-Disposition', 'attachment');
          // 让浏览器把它当 application/xml 而不是 image/svg+xml
          res.setHeader('Content-Type', 'application/octet-stream');
        }
        res.setHeader('Cache-Control', 'public, max-age=86400');
        // Access-Control-Allow-Origin 由 cors 中间件统一处理，这里不硬编码
      },
    }),
  );
  // OSS 404 兜底：不存在的文件返回 404 JSON，不走 SPA fallback
  app.use('/oss', (_req, res) => {
    res.status(404).json({ code: 404, msg: '文件不存在', path: _req.url });
  });
  log(`OSS 静态目录挂载: /oss/* → ${OSS_DIR}`);

  // SPA history fallback —— 所有非 /api/* 开头的请求，且不是 dist 里已有文件的，都返回 index.html
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(DIST_DIR, 'index.html'), (err) => {
      if (err) {
        // dist/index.html 不存在时（前端尚未部署），返回 JSON 提示
        res.status(200).json({
          status: 'backend-only',
          tip: '前端尚未部署，请上传 Taro build 产物到 dist/',
        });
      }
    });
  });

  // — /api/* 开头的请求：最终兜底 404 JSON —
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ code: 404, data: null, msg: '接口不存在' });
    } else {
      res.status(404).send('页面不存在');
    }
  });

  // 4. 启动
  app.listen(PORT, () => {
    banner(PORT, mode === 'mysql' ? 'MySQL 8.x (TypeORM)' : '内存存储 (mock)');
    log(`Server started on port ${PORT} (${mode})`);

    // ✅ 启动定时任务：质保到期释放 + 师傅未响应自动升级仲裁
    try {
      startScheduler();
    } catch (e: any) {
      log(`Scheduler start failed: ${e.message}`, 'warn');
    }
  });
}

bootstrap().catch((e) => {
  console.error('❌ Bootstrap failed:', e);
  process.exit(1);
});
