# 🚀 LJL Mall 后端服务

> Express + TypeORM + MySQL 8.x + JWT
> 基础路径：http://localhost:3001/api

---

## 快速启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（复制 .env.example → .env，填 MySQL 和 JWT）
cp .env.example .env

# 3. 开发模式（tsx watch 热重载）
npm run dev

# 4. 生产模式
npm run start

# 5. 健康检查
curl http://localhost:3001/health
```

## 环境变量

```env
# MySQL
MYSQL_HOST=192.168.10.5
MYSQL_USER=root
MYSQL_PASSWORD=root
MYSQL_DATABASE=ljl_sc

# JWT 签名密钥（所有角色共用同一个 SECRET）
JWT_SECRET=vm-local-dev-jwt-secret-keep-safe

# 端口
PORT=3001
```

**注意**：`server/.env` 里的 `JWT_SECRET` 和前端 `src/store/index.ts` 里的 `DEV_JWT` 必须对齐——前端 dev token 用当前 SECRET 签的，后端换 SECRET 后前端 token 立刻失效。

## 目录结构

```
server/
├── src/
│   ├── index.ts              # 入口：路由挂载 + 中间件 + 静态文件
│   ├── db-manager.ts         # TypeORM 数据源初始化
│   ├── middleware/
│   │   └── auth.ts           # 鉴权中间件链 + 响应工具函数
│   ├── entities/             # 13 个文件，45 张表
│   │   ├── sprint1.ts        # 用户/认证
│   │   ├── sprint2.ts        # 商品/分类/订单/购物车/地址
│   │   ├── sprint4.ts        # 安装需求/安装订单/质保索赔
│   │   ├── sprint5.ts        # 师傅/设计师/供应商资料 + 银行 + 提现
│   │   └── ...
│   ├── routes/               # 29 个路由文件（见下方路由分组）
│   ├── services/             # 业务服务层：sms-gateway / event-bus / dispatch
│   ├── config/               # 配置
│   └── logger.ts             # 日志
├── scripts/                  # 辅助脚本（冒烟、seed、迁移）
├── docker/                   # Docker 相关
├── oss/                      # 静态文件挂载目录
├── .env                      # 本地环境变量（gitignore）
├── .env.example              # 模板
├── package.json
└── tsconfig.json
```

## 鉴权模型

JWT Payload：`{ sub: userId, role: string }`

中间件链（`middleware/auth.ts`）：

| 中间件 | 允许的 role |
|--------|-------------|
| requireAuth | **任何已登录**（consumer/admin/vendor/designer/installer 以及 pending_*） |
| requireAdmin | **admin**（已通过审核的管理员） |
| requireVendor | **vendor**（已通过审核的供应商） |
| requireDesigner | **designer**（已通过审核的设计师） |
| requireInstaller | **installer**（已通过审核的师傅） |
| requirePendingVendor | **vendor 或 pending_vendor**（注册中的也能访问） |
| requirePendingDesigner | **designer 或 pending_designer** |
| requirePendingInstaller | **installer 或 pending_installer** |

调用方式：

```typescript
router.get('/profile', requireAuth, requireAdmin, async (req, res) => {
  const userId = (req as AuthedRequest).userId;  // requireAuth 注入的
  // ...
});
```

## 路由挂载总览

`index.ts` L228-267 统一挂载：

```typescript
app.use('/api',          homeRoutes)               // 公开：商品/搜索/地区/快递/服务
app.use('/api/auth',     authRoutes)               // 认证：发码/登录/注册/登出
app.use('/api/user',     userRoutes)               // 用户资料
app.use('/api/cart',     cartRoutes)               // 购物车
app.use('/api/orders',   orderRoutes)              // 订单
app.use('/api/addresses',addressRoutes)            // 收货地址
app.use('/api/design-file',designFileRoutes)       // 设计文件
app.use('/api/demand',   designDemandRoutes)       // 设计需求
app.use('/api',          designOrderRoutes)        // 设计订单（暴露两条路径）
app.use('/api/admin',    adminRoutes)              // 管理后台核心
app.use('/api/admin',    adminExpressRoutes)        // 管理：快递/配送
app.use('/api/admin',    adminFinanceRoutes)        // 管理：财务/纠纷
app.use('/api/admin',    adminSettingsRoutes)       // 管理：系统配置
app.use('/api/admin',    adminCouponRoutes)         // 管理：优惠券
app.use('/api/installation',installationRoutes)    // 用户端安装需求发布
app.use('/api/installer',installerRoutes)           // 师傅端
app.use('/api/designer', designerRoutes)            // 设计师端
app.use('/api/vendor',   vendorRoutes)              // 供应商端
app.use('/api/favorite', favoriteRoutes)            // 收藏
app.use('/api/coupon',   couponRoutes)              // 优惠券中心
app.use('/api/service',  serviceRoutes)             // 服务大厅
app.use('/api/message',  messageRoutes)             // 站内消息
app.use('/api/chat',     chatRoutes)                // 即时聊天
app.use('/api/notifications',notificationsRoutes)  // 通知
app.use('/api/invoice',  invoiceRoutes)             // 发票
app.use('/api',          helpRoutes)                // FAQ 帮助
app.use('/api',          disputeRoutes)             // 纠纷
app.use('/api/masked',   maskedRoutes)               // 隐私号
app.use('/api',          reviewRefundRoutes)        // 评价 + 退款
```

## 路由注册顺序注意事项

Express 按注册顺序匹配，**固定路径必须在通配符之前**。

✅ 正确示例（installation.ts）：
```typescript
router.get('/my', requireAuth, ...);          // ✅ 固定路径先注册
router.get('/my-orders', requireAuth, ...);   // ✅ 固定路径先注册
router.get('/my-orders/:id', requireAuth, ...);
router.get('/:id', requireAuth, ...);         // ✅ 通配符放最后
```

❌ 错误示例（已修复）：
```typescript
router.get('/my', requireAuth, ...);
router.get('/:id', requireAuth, ...);         // ❌ 通配符先注册
router.get('/my-orders', requireAuth, ...);   // ❌ 永远被 /:id 截走
router.get('/my-orders/:id', requireAuth, ...);
```

## 数据库

- 引擎：MySQL 8.x
- ORM：TypeORM
- 连接：`192.168.10.5:3306/ljl_sc`
- synchronize：`true`（开发模式自动建表，生产环境建议关闭改 migration）
- 物理外键：**关闭**（所有实体 `createForeignKeyConstraints: false`，FK 靠应用层保证）
- 实体文件：13 个 `.ts` 文件，45 张表

> 详细表结构见 [docs/数据库表结构设计.md](../docs/数据库表结构设计.md)

## 接口规范

- 基础路径：`/api/*`（除 `/health` 健康检查）
- 鉴权：除 `/health`、首页/商品/搜索等公开接口外，都要带 `Authorization: Bearer <token>`
- 成功响应：`{ code: 0, data: ..., msg: 'ok' }`
- 错误响应：`{ code: 非0, msg: '错误说明' }`
- 分页：`{ code: 0, data: { list: [...], total: 100, page: 1, pageSize: 10 } }`

> 完整接口清单见 [docs/API接口文档.md](../docs/API接口文档.md)

## 常用脚本

```bash
npm run dev          # 开发模式（tsx watch 热重载）
npm run start        # 生产模式（tsx src/index.ts）

# scripts/ 目录下
node scripts/smoke-full-v2.js      # 全链路冒烟（95 endpoint / 6 组）
node scripts/seed-test-users.js    # 补 vendor/designer/installer 三种测试用户
node scripts/make-smoke-admin.js   # 生成 admin token
```

## 已知坑

1. **dotenv import 提升**：`import 'dotenv/config'` 是 ES 静态 import，会在 CommonJS require 之前执行。`auth.ts`、`db-manager.ts`、`index.ts` 都要读根目录 `.env`，不要改加载顺序。
2. **JWT_SECRET 统一**：所有入口和前端 `DEV_JWT` 必须用同一个 SECRET，改了就同步更新所有位置。
3. **installer_profiles seed**：后端启动会自动 seed users/categories/products/banners 等，**但 installer_profiles / vendor_profiles / designer_profiles 不会自动 seed**——这些是用户注册时动态创建的。冒烟测试前如果需要，请执行 seed-test-users.js 补 users 表，但 roles 专属表要用户注册过才会有记录。

## Docker

Week 11 做了 Docker 三件套：server 容器 + MySQL 容器 + docker-compose.yml。详见 Week 11 迭代记录。
