# 零距离广告商城 — 后端 API 清单

**生成时间**: 2026-10-07  
**Base URL**: `http://localhost:3001/api`  
**响应格式**: `{ code: 0, data: any, msg: string }`  
**鉴权**: `Authorization: Bearer <JWT>` (或 `?token=<JWT>` query param)

---

## 通用响应码

| code | 说明 |
|---|---|
| 0 | 成功 |
| 401 | 未登录 / token 过期 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 422 | 参数校验失败 |
| 500 | 服务器内部错误 |

---

## 📜 auth.ts — 认证

| Method | Path | 说明 |
|---|---|---|
| POST | `/auth/phone-login` | 手机号 + 验证码登录 |
| POST | `/auth/phone-send` | 发送验证码 |
| POST | `/auth/register` | 注册新用户 |
| POST | `/auth/vendor-register` | 供应商入驻申请 |
| POST | `/auth/installer-register` | 师傅入驻申请 |
| POST | `/auth/designer-register` | 设计师入驻申请 |

---

## 👤 user.ts — 用户中心

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET | `/user/profile` | ✅ | 获取当前用户资料 |
| PUT | `/user/profile` | ✅ | 更新用户资料 |
| POST | `/user/avatar` | ✅ | 上传头像 |

---

## 🛒 cart.ts — 购物车

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET | `/cart/list` | ✅ | 购物车列表 |
| POST | `/cart/add` | ✅ | 加入购物车 |
| PUT | `/cart/update/:id` | ✅ | 修改数量/规格 |
| DELETE | `/cart/remove/:id` | ✅ | 移除商品 |
| POST | `/cart/clear` | ✅ | 清空购物车 |

---

## 📦 order.ts — 商品订单

| Method | Path | Auth | 说明 |
|---|---|---|---|
| POST | `/orders` | ✅ | 创建订单 |
| GET | `/orders` | ✅ | 订单列表 |
| GET | `/orders/:id` | ✅ | 订单详情 |
| POST | `/orders/:id/pay` | ✅ | 支付订单 → emit `order_paid` |
| POST | `/orders/:id/cancel` | ✅ | 取消订单 → emit `order_cancelled` |
| POST | `/orders/:id/ship` | ✅ vendor | 发货 |
| POST | `/orders/:id/confirm` | ✅ | 确认收货 → emit `order_completed` |

---

## 🏠 home.ts — 首页

| Method | Path | 说明 |
|---|---|---|
| GET | `/home/banners` | 首页 Banner |
| GET | `/home/categories` | 分类导航 |
| GET | `/home/features` | 特色商品 |

---

## 📋 address.ts — 收货地址

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET | `/address/list` | ✅ | 地址列表 |
| POST | `/address` | ✅ | 新增地址 |
| PUT | `/address/:id` | ✅ | 更新地址 |
| DELETE | `/address/:id` | ✅ | 删除地址 |
| POST | `/address/:id/default` | ✅ | 设为默认 |

---

## 💬 chat.ts — 聊天

| Method | Path | Auth | 说明 |
|---|---|---|---|
| GET | `/chat/conversations` | ✅ | 会话列表 |
| GET | `/chat/list/:userId` | ✅ | 与某用户的会话 |
| POST | `/chat/send` | ✅ | 发送消息 → emit `generic` |
| GET | `/chat/unread` | ✅ | 未读会话数 |

---

## 🔔 /api/events — SSE 实时推送

**接入**: EventSource `GET /api/events?token=<JWT>` 或 `fetch + Authorization header`

### 事件类型 (16+)

| Event | 推送方向 | payload | 触发场景 |
|---|---|---|---|
| `new_demand` | broadcast (师傅) | `desc` | 用户发布安装需求 |
| `new_quote` | user | `amount` | 师傅报价 |
| `quote_accepted` | installer | — | 用户接受报价 |
| `counter_offer` | 对方 | — | 砍价/议价消息 |
| `order_started` | user | `orderId, orderNo` | 师傅开工 |
| `order_completed` | user | — | 师傅完工 |
| `new_design_demand` | broadcast (设计师) | `desc` | 用户发布设计需求 |
| `new_design_quote` | user | `amount` | 设计师接单 |
| `order_paid` | vendor | `orderId, orderNo, amount` | 用户支付商品订单 |
| `order_cancelled` | vendor | `orderId, orderNo` | 用户取消订单 |
| `installer_approved/rejected` | installer | — | admin 审核 |
| `designer_approved/rejected` | designer | — | admin 审核 |
| `vendor_approved/rejected` | vendor | — | admin 审核 |
| `warranty_auto_escalated` | admin | — | 质保超时自动升级 |
| `generic` | 对方 | `message, messageType` | 通用消息（聊天等） |

---

## 🛡️ 管理员端点 (admin.* requireAdmin)

| 文件 | 核心端点 |
|---|---|
| admin.ts | `/admin/overview`, `/admin/audits`, `/admin/users`, `/admin/products`, `/admin/orders`, `/admin/stats`, `/admin/withdrawals/:id/approve|reject`, `/admin/designers/:id/approve|reject`, `/admin/vendors/:id/approve|reject` |
| installer.ts | installer 入驻 + profile + orders + withdraw |
| designer.ts | designer 入驻 + profile + quotes + withdraw |
| vendor.ts | vendor 入驻 + products + orders + profile + withdraw |
| installation.ts | 安装需求发布/报价/接单/完工 |
| design-demand.ts | 设计需求发布/接单 |
| coupon.ts | 优惠券领取/核销 |
| service.ts | 上门服务（清洗/维修等） |

---

## 📂 项目结构

```
ljl-sc/
├── src/                    # Taro 前端 (React + TypeScript + SCSS CSS Modules)
│   ├── components/         # 通用组件 (AppTopNav, Icon, EmptyState, Skeleton...)
│   ├── pages/              # 用户端页面 (主包)
│   ├── pages-installer/    # 师傅端分包
│   ├── pages-designer/     # 设计师端分包
│   ├── pages-vendor/       # 供应商端分包
│   ├── pages-admin/        # admin 后台分包 (PC + mobile 共用)
│   ├── pages-popup/        # 弹窗/空态/帮助等分包
│   ├── styles/             # theme.scss (唯一 token 来源) + variables.scss (8 个 @mixin)
│   ├── services/           # API 层 (api.ts, sse.ts, vendor.ts, installer.ts...)
│   ├── constants/          # routes.ts (ROUTES 主包 + SUB_ROUTES 分包)
│   ├── hooks/              # useRoleGuard, useEffectOnce...
│   └── app.tsx             # 入口 (SSE 生命周期接入)
├── server/                 # Express + TypeORM 后端
│   ├── src/
│   │   ├── index.ts        # Express 启动 + Helmet + CORS + SSE /api/events
│   │   ├── middleware/     # auth.ts (JWT + 角色守卫 + 输入校验)
│   │   ├── routes/         # 22 路由文件
│   │   ├── services/       # event-bus.ts (SSE EventBus)
│   │   ├── db-orm.ts       # TypeORM 实体 + Repository
│   │   ├── seed.ts         # 开发环境种子数据
│   │   └── scheduler.ts    # 定时任务 (质保自动升级)
│   └── .env.example        # 环境变量模板
└── dist-h5/ dist-weapp/    # 编译产物 (已在 .gitignore)
```

---

## 🛠️ 开发命令

```bash
# 前端
npm run dev:h5       # H5 dev server
npm run build:h5     # H5 生产编译
npm run build:weapp  # 微信小程序编译

# 后端
cd server
npm run dev          # ts-node 启动 (默认 3001)
npm run build        # tsc 编译
npm test             # vitest (68 tests)
```
