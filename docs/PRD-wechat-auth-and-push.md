# PRD · 微信授权登录 + 小程序/APP 推送体系

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|---------|
| v1.0 | 2026-10-12 | Project Requirement Lead | 初版发布，覆盖 7 项需求决策 |

---

## 一、需求背景

### 1.1 业务现状

当前 `ljl-mall-server`（零距离广告商城后端）仅支持 **手机验证码** 和 **账号密码** 两种登录方式，核心问题：

| 问题 | 影响 |
|------|------|
| 小程序端强制验证码登录 | 用户打开小程序就要填手机号+收短信，首屏流失率高 |
| APP 端无原生推送通道 | 发货、师傅接单、设计交付等关键状态变更用户收不到通知 |
| 通知全靠 SSE 长连接 | 小程序 EventSource 受限、APP 不能常驻耗电，SSE 仅适用于 PC Web 工作台 |
| 微信身份信息未存储 | users 表无 openid/unionid 字段，无法做跨端身份打通 |
| 推送设备无统一注册机制 | APP/小程序/PC Web 三种活跃通道散落在业务代码里，无审计、无去重、无限频 |

### 1.2 需求目标

| # | 目标 | 衡量标准 |
|---|------|---------|
| 1 | 新增微信授权登录，新用户打开小程序即可免密登录 | 用户调 `POST /api/auth/wechat-login` 后拿到 token 和 consumer 角色 |
| 2 | 已绑定手机号的老用户和微信用户身份可互相绑定/解绑 | 绑定时 openid/unionid 占用检测、解绑时防纯微信账号丢失登录入口 |
| 3 | APP 端可通过极光/APNs 收到订单状态变更等关键推送 | 业务触发点调 `push(userId, event)` 即自动路由到 jpush_apns 通道 |
| 4 | 小程序端可通过微信订阅消息收到关键状态变更 | 业务触发点同调 `push()` 即自动路由到 wx_subscribe 通道 |
| 5 | PC Web 工作台继续用现有 SSE 实时通知 | SSE 端点自动注册/清理 push_devices 记录 |
| 6 | 推送服务端限频去重 | 同一 userId + eventType + 业务主键 5 分钟内只推一次 |
| 7 | 全链路审计 | push_logs 记录每次推送的通道、成功/失败数、失败原因 |

### 1.3 非目标（本期不做）

- **APP 端微信开放平台代开发登录**：本期只实现小程序 jscode2session，APP/H5 开放平台 OAuth2 留待下一期
- **微信长期订阅**：仅覆盖"关键状态变更"6 个模板，不做全业务覆盖 15+ 模板
- **各厂商推送直连**：统一走极光/个推聚合，不在后端接小米/华为/OPPO/vivo 厂商通道
- **推送失败重试队列**：微信订阅消息不重试（微信规则限制）；极光/APNs 失败仅记录日志，由 APP 下次启动重新注册触发
- **admin/vendor/designer/installer 角色端**：角色端仍走账号密码登录，本期不做微信授权入口

### 1.4 前提条件（需用户/项目方提前准备）

| # | 条件 | 用途 |
|---|------|------|
| 1 | 已注册微信开放平台账号（open.weixin.qq.com）**· 必须有企业主体资质** | 小程序和 APP 绑定到同一个开放平台账号 → 后端能拿到 unionid |
| 2 | 开放平台下已绑定 1 个小程序 | 小程序端 jscode2session |
| 3 | 微信公众平台申请 6 个订阅消息模板（见 §5.3 模板清单） | 小程序端状态变更推送 |
| 4 | 极光推送后台账号 + Master Secret | APP 端聚合推送 |
| 5 | 小程序前端代码调 `wx.login()` + `wx.getPhoneNumber()` | 后端微信登录流程依赖前端配合 |

如果前提条件 1 **不满足**（个人主体小程序无法注册开放平台），则降级方案：

- users 表只加 openid 一列，不加 unionid
- 小程序和 APP 用户身份各自独立，同一个人两端登录会变成两个账号
- 接口签名不变，后端自动适配（unionid 为空时 fallback 用 openid）

---

## 二、业务流程图

### 2.1 微信授权登录（新用户首次进入）

```
[打开小程序/APP]
       │
       ▼
┌──────────────────────┐
│ 前端 wx.login()       │
│  → 拿到 code          │
└──────────┬───────────┘
           │ code
           ▼
┌──────────────────────────────────────────┐
│ POST /api/auth/wechat-login              │
│ body: { platform, code }                 │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│ 后端 wechatCode2Session(platform, code)  │
│ 真实：调微信 jscode2session HTTP API     │
│ mock：开发态自动生成确定性 openid/unionid │
└──────────┬───────────────────────────────┘
           │ openid + unionid + sessionKey
           ▼
┌──────────────────────────────────────────┐
│ 查 users 表：unionid 优先 → openid 兜底  │
└──────┬───────────────────────────┬───────┘
       │                           │
  命中老用户                    未命中
       │                           │
  检查 status=1              自动注册 consumer
       │                    phone=null 占位
  补充可能缺失               写入 openid + unionid
  的 openid/unionid                │
       │                           │
       ▼                           ▼
┌──────────────────────────────────────────┐
│ 生成 JWT（payload 带 role="consumer"）   │
│ 返回 user.wechatBound=true               │
│       user.phoneBound=false（新用户无手机号）│
└──────────┬───────────────────────────────┘
           │
           ▼
[前端拿到 token]
       │
       ▼
  ┌──────────────┐  phoneBound=false
  │ 是否弹获取   │──────────────────────┐
  │ 手机号按钮？ │                      │
  └──────┬───────┘                      │
         │ 是                           │ 否（用户只是看看）
         ▼                              │
┌──────────────────────┐               │
│ 前端 wx.getPhoneNumber              │
│  → encryptedData, iv, code          │
│ OR 用户手动填手机号 + 验证码         │
└──────────┬───────────┘               │
           │                           │
           ▼                           ▼
┌──────────────────────────────────┐
│ POST /api/auth/wechat-bind-phone  │
│ OR 升级：wechat-login 时同时传    │
│ encryptedData + iv                │
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│ 校验验证码/解密手机号              │
│ → UPDATE users SET phone=?        │
└──────────┬───────────────────────┘
           │
           ▼
[用户进入完整消费者账号体系]
  phoneBound=true → 不再弹获取手机号
```

### 2.2 已有手机号账号绑定微信

```
[用户打开小程序]
       │
       ▼
[用手机号验证码/账号密码登录]
       │
       ▼
[进入"账号安全 → 绑定微信"]
       │
       ▼
┌──────────────────────┐
│ 前端 wx.login()       │
└──────────┬───────────┘
           │ code + platform
           ▼
┌──────────────────────────────────┐
│ POST /api/auth/bind-wechat        │
│ （需携带现有 token 鉴权）          │
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│ code2Session → openid + unionid           │
│ 检查 openid/unionid 是否被其他账号占用       │
│ 占用 → 返回 409 "该微信已被其他账号绑定"     │
│ 未占用 → UPDATE users SET openid=?,       │
│         unionid=? WHERE id=当前 userId    │
└──────────┬───────────────────────────────┘
           │
           ▼
[以后小程序端直接微信静默登录，和手机号账号同一个 userId]
```

### 2.3 推送体系三通道自动路由

```
[业务触发：订单发货]
       │
       ▼
vendor 调 POST /api/orders/:id/ship 成功
       │
       ▼
orderService 内部：
┌────────────────────────────────────────┐
│ push(order.userId, {                    │
│   type: 'order_shipped',                │
│   title: '订单已发货',                   │
│   content: '您的订单 XXX 已发货',        │
│   data: { orderNo, trackingNo },         │
│   dedupKey: `${order.userId}:order_shipped:${order.orderNo}`│
│ })                                      │
└──────────┬─────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│ ① 限频去重 Redis SETNX(dedupKey, 300s)   │
│    5 分钟内同事件重复触发 → 跳过            │
└──────────┬───────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│ ② SELECT * FROM push_devices               │
│    WHERE userId=? AND enabled=1            │
│    → 得到该用户当前活跃的所有通道设备       │
└──────┬──────────┬──────────┬─────────────┘
       │          │          │
  wx_subscribe  jpush_apns   sse
  (openid)      (regId)    (clientId)
       │          │          │
       ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌────────────┐
│ 微信订阅  │ │ 极光推送  │ │ eventBus   │
│ 消息模板  │ │ v3 HTTP  │ │ .publish() │
│ API 调用  │ │  POST    │ │            │
└──────────┘ └──────────┘ └────────────┘
       │          │          │
       └──────────┼──────────┘
                  │
                  ▼
         写入 push_logs
         (channels, successCount,
          failCount, failDetail)
```

---

## 三、角色与权限矩阵

### 3.1 角色定义与登录方式

| 角色 | role 字段值 | 前端入口 | 本期登录方式 | 本期新增 |
|------|------------|---------|-------------|---------|
| 消费者 | `consumer` | 小程序 + APP | 手机验证码 / 账号密码 / **微信授权登录（新增）** | ✅ 微信授权 + 微信绑定/解绑 |
| 管理员 | `admin` | Admin Web 后台 | 账号密码（login-account） | ❌ 维持现状 |
| 供应商 | `vendor` | PC Web 工作台 | 账号密码 + admin 审核 | ❌ 维持现状 |
| 设计师 | `designer` | PC Web 工作台 | 账号密码 + admin 审核 | ❌ 维持现状 |
| 安装师傅 | `installer` | PC Web 工作台 | 账号密码 + admin 审核 | ❌ 维持现状 |

### 3.2 鉴权规则

| 端点 | 鉴权级别 | 说明 |
|------|---------|------|
| `POST /api/auth/wechat-login` | **公开** | 不需要 token，任何人可以调 |
| `POST /api/auth/wechat-bind-phone` | requireAuth | 必须已拿 wechat-login 给的 token |
| `POST /api/auth/bind-wechat` | requireAuth | 必须有手机号的账号才能绑微信 |
| `POST /api/auth/unbind-wechat` | requireAuth + phone 非空 | 纯微信账号禁止解绑 |
| `POST /api/device/register` | requireAuth | 绑定到当前登录用户 |
| `POST /api/device/unregister` | requireAuth | 仅解绑当前用户设备 |
| `GET /api/device/list` | requireAuth | 仅返回当前用户自己的设备 |

---

## 四、功能列表（按模块 · 优先级）

### 模块 A：微信授权登录

| # | 功能 | 优先级 | 描述 |
|---|------|--------|------|
| A1 | 微信 code2session 换 openid + unionid | **P0** | 支持 mini / app / h5 三种 platform；真实调微信 API；开发态自动降级 mock |
| A2 | 用户自动匹配（unionid 优先） | **P0** | 用 unionid 查 users 表，没命中再用 openid 兜底；新用户自动创建 consumer 角色 |
| A3 | 老用户字段补全 | P1 | 命中老用户但 openid/unionid 缺失时自动补回 |
| A4 | 并发唯一索引冲突兜底 | P0 | 极端并发下两个请求同时注册同一 unionid → catch ER_DUP_ENTRY 再查一次 |
| A5 | 手机号解密补填（一步走） | **P0** | 微信登录同时传 encryptedData + iv → 后端 AES-128-CBC 解密 → 补到 phone 字段 |
| A6 | 手机号验证码补填（两步走） | **P0** | 已登录微信用户调 wechat-bind-phone → 走现有 send-code → 补 phone |
| A7 | 已有账号绑微信 | **P0** | 检查 openid/unionid 不被其他账号占用 → 写入当前 users 记录 |
| A8 | 解绑微信（换号） | **P0** | 安全检查：纯微信账号（phone=null）禁止解绑 |
| A9 | fmtUser 输出 wechatBound/phoneBound | **P0** | 前端根据这两个字段决定是否弹"获取手机号"按钮；敏感 token 字段不暴露 |

### 模块 B：推送服务核心

| # | 功能 | 优先级 | 描述 |
|---|------|--------|------|
| B1 | 限频去重（Redis SETNX + 5min TTL） | **P1** | Redis 可用时走 SETNX；不可用时 fallback 进程内 Map |
| B2 | 活跃设备查询 | **P1** | 按 userId + enabled=1 查 push_devices |
| B3 | 三通道适配器统一接口 | **P1** | wx_subscribe / jpush_apns / sse 实现同一 PushAdapter 接口 |
| B4 | SSE 适配器 | **P1** | eventBus.publish(clientId, event) |
| B5 | 微信订阅消息适配器 | **P1** | POST 微信 subscribe/send；模板 ID 映射表；开发 mock |
| B6 | 极光推送适配器 | **P1** | POST 极光 v3/push；Basic Auth；开发 mock |
| B7 | 推送审计日志 | **P1** | 记录 channels、successCount、failCount、failDetail |

### 模块 C：设备注册

| # | 功能 | 优先级 | 描述 |
|---|------|--------|------|
| C1 | 设备注册 register | **P1** | upsert（同 userId+channel 更新）；支持 wx_subscribe/openid 和 jpush_apns/registrationId 两种 channel |
| C2 | 设备解绑 unregister | **P1** | enabled=0；可指定 channel；用户退出登录时调 |
| C3 | 设备查询 list | P2 | 仅返回当前用户；脱敏（不暴露 deviceToken/registrationId 原文） |
| C4 | SSE 自动注册 | **P1** | /api/events 端点连接时自动 register；客户端断开自动 unregister |

---

## 五、接口详细规范

### 5.1 认证接口

#### A1. 微信登录

```
POST /api/auth/wechat-login
Content-Type: application/json
Public（无需鉴权）

请求体:
{
  "platform": "mini | app | h5",   // 必填，平台类型
  "code": string,                   // 必填，前端 wx.login() / 开放平台 OAuth2 拿到的 code
  "encryptedData": string,          // 可选，一步走时前端传（wx.getPhoneNumber）
  "iv": string                      // 可选，encryptedData 对应的向量
}

成功响应 (200):
{
  "code": 0,
  "msg": "登录成功",
  "data": {
    "token": "JWT...",
    "user": {
      "id": 123,
      "phone": "wx_xxxxx" | null | "13800138000",
      "nickname": "微信用户xxxx",
      "avatar": "",
      "role": "consumer",
      "openid": "mini_xxxxx" | null,
      "unionid": "wx_union_xxxxx" | null,
      "wechatNickname": null,
      "wechatAvatar": null,
      "wechatBound": true,        // 是否绑定微信（openid/unionid 非空）
      "phoneBound": false,        // 是否绑定手机号
      "status": 1,
      "wallet": 0,
      ...其它 fmtUser 字段
    }
  }
}

失败响应:
400: { code: 400, msg: "微信 code 无效" }
401: { code: 401, msg: "未登录" }
403: { code: 403, msg: "账号已禁用" }
422: { code: 422, msg: "platform 必须是 mini | app | h5" }
500: { code: 500, msg: "微信登录失败: xxx" }

注意：
- 开发态（未配置 WX_MINI_PROGRAM_APPID/SECRET）自动走 mock，返回 msg "登录成功（开发 mock 模式...）"
- 新用户 phone 字段为占位符（wx_开头 11 位），phoneBound=false 时前端应弹"获取手机号"
- 老用户 phone 已有值时 phoneBound=true
- token payload 带 role="consumer"，SSE/eventBus 等场景快速鉴权
```

#### A2. 微信登录同时补手机号（一步走：encryptedData + iv）

```
请求体（与 A1 相同，encryptedData + iv 必填）:
{
  "platform": "mini",
  "code": "test-code-001",
  "encryptedData": "wx.getPhoneNumber 返回的 base64",
  "iv": "wx.getPhoneNumber 返回的 base64"
}

后端处理：
1. wechatCode2Session 拿 sessionKey
2. decryptWechatPhone(sessionKey, encryptedData, iv) → 拿到真实手机号
3. 用户 phone 为空 → 自动补；用户 phone 已有值 → 不覆盖
4. 返回 user.phoneBound=true

微信手机号格式：
purePhoneNumber 去掉 +86 国家码，如 "13800138000"
```

#### A3. 两步走：wechat-bind-phone

```
POST /api/auth/wechat-bind-phone
Authorization: Bearer <token>   // 必须已登录
Content-Type: application/json

请求体:
{
  "phone": "13800138000",     // 必填，11 位手机号
  "code": "123456"             // 必填，走现有 send-code 通道
}

成功响应 (200):
{
  "code": 0,
  "msg": "手机号绑定成功",
  "data": { "token": "...", "user": { ... phoneBound: true ... } }
}

失败响应:
401: { code: 401, msg: "账号不可用" }
409: { code: 409, msg: "该账号已绑定手机号" }
409: { code: 409, msg: "该手机号已被其他账号绑定" }
422: { code: 422, msg: "手机号格式错误" }
422: { code: 422, msg: "验证码错误" }

安全规则：
- 已绑手机号的账号不能再调此接口（防覆盖）
- 手机号必须未被其他用户占用（防撞号）
- 走现有 send-code → MOCK_CODE=123456 通道（开发验证用）
```

#### A4. bind-wechat（已有账号绑微信）

```
POST /api/auth/bind-wechat
Authorization: Bearer <token>
Content-Type: application/json

请求体:
{
  "platform": "mini | app | h5",   // 必填
  "code": string                    // 必填，前端 wx.login() 拿的
}

成功响应:
{
  "code": 0, "msg": "微信绑定成功",
  "data": { "token": "...", "user": { ... wechatBound: true ... } }
}

失败响应:
400: { code: 400, msg: "微信 code 无效" }
409: { code: 409, msg: "该微信已被其他账号绑定" }
500: { code: 500, msg: "服务器内部错误" }

安全规则：
- openid / unionid 占用检测：被其他 userId 占用 → 409
- 允许纯 consumer/designer/vendor/installer/admin 任意角色调（只要已登录）
- 绑定成功后重新生成 token
```

#### A5. unbind-wechat（解绑微信）

```
POST /api/auth/unbind-wechat
Authorization: Bearer <token>

请求体：无

成功响应:
{
  "code": 0, "msg": "微信解绑成功",
  "data": { "token": "...", "user": { ... wechatBound: false ... } }
}

失败响应:
401: { code: 401, msg: "账号不可用" }
422: { code: 422, msg: "该账号未绑定手机号，请先绑定手机号再解绑微信" }

安全规则：
- phone 为空（纯微信账号）→ 拒绝解绑
- openid/unionid 置 NULL
```

### 5.2 设备注册接口

#### C1. register

```
POST /api/device/register
Authorization: Bearer <token>
Content-Type: application/json

请求体:
{
  "channel": "wx_subscribe | jpush_apns",   // 必填；sse 不走这里，SSE 端点自动注册
  "openid": string,                            // channel=wx_subscribe 时必填
  "unionid": string,                            // 可选
  "registrationId": string,                    // channel=jpush_apns 时必填
  "deviceToken": string,                       // channel=jpush_apns 可选
  "pushPlatform": "ios | android",             // 可选
  "appVersion": string,                        // 可选
  "deviceModel": string                        // 可选
}

成功响应:
{ "code": 0, "msg": "设备注册成功", "data": { "success": true } }

安全规则：
- 同 userId + channel 已存在 → upsert（更新 enabled/lastActiveAt/字段）
- 不同 userId + 相同 openid 不校验（一个 openid 可能在多个设备登录）
```

#### C2. unregister

```
POST /api/device/unregister
Authorization: Bearer <token>

请求体（可选）:
{ "channel": "wx_subscribe | jpush_apns | sse" }   // 不传 = 解绑所有

成功响应: { "code": 0, "msg": "已解绑", "data": { "success": true } }
```

#### C3. list

```
GET /api/device/list
Authorization: Bearer <token>

成功响应:
{
  "code": 0,
  "data": [
    {
      "id": 1,
      "channel": "wx_subscribe",
      "channelDetail": { "openid": "mini_xxx", "unionid": "wx_union_xxx" },
      "appVersion": "1.0.0",
      "deviceModel": "iPhone 15",
      "lastActiveAt": "2026-10-12T10:00:00Z"
    },
    {
      "id": 2,
      "channel": "sse",
      "channelDetail": { "sseClientId": "user:123:1728672000" },
      ...
    }
  ]
}

安全：不暴露 deviceToken / registrationId 原文
```

### 5.3 业务侧调用 push()（内部接口，无 HTTP 路由）

```typescript
// 业务层调用（示例：订单发货成功时）
import { push } from '../services/push';

await push(order.userId, {
  type: 'order_shipped',
  title: '订单已发货',
  content: `您的订单 ${order.orderNo} 已发货，请及时查收`,
  data: {
    orderNo: order.orderNo,
    trackingNo: trackingNo,
    page: 'pages/order/detail',   // 小程序/APP 点击跳转的路径
  },
  dedupKey: `${order.userId}:order_shipped:${order.orderNo}`,
});
// 5 分钟内同一 orderNo 重复调 → 跳过

// 推送结果（已写 push_logs）：
// wx_subscribe 成功 | jpush_apns 成功 | sse 成功 → 三路都推到
```

### 5.4 微信订阅消息模板映射

| 业务事件 | event.type | 模板 ID 环境变量 | 模板内容（向微信申请时填写） |
|---------|-----------|-----------------|---------------------------|
| 订单支付成功 | `order_paid` | `WX_TPL_ORDER_PAID` | 订单支付成功：{{thing1}}（订单号），时间 {{time3}} |
| 订单已发货 | `order_shipped` | `WX_TPL_ORDER_SHIPPED` | 订单已发货：{{thing1}}（快递公司） {{thing2}}（快递单号） |
| 安装师傅接单 | `install_master_accept` | `WX_TPL_INSTALL_ACCEPT` | 安装订单已接单：{{thing1}}（师傅姓名） {{thing2}}（预计上门时间） |
| 设计稿交付 | `design_delivered` | `WX_TPL_DESIGN_DELIVERED` | 设计需求已交付：{{thing1}}（设计名称），请及时查看 |
| 纠纷处理完成 | `dispute_resolved` | `WX_TPL_DISPUTE_RESOLVED` | 纠纷已处理：{{thing1}}（处理结果） {{thing2}}（处理说明） |
| 账号安全变更 | `security_change` | `WX_TPL_SECURITY_CHANGE` | 账号安全变更：{{thing1}}（变更类型） {{time3}} |

模板数据构建规则（`buildWxTemplateData`）：

```typescript
{
  thing1: { value: truncate(event.title, 20) },   // 微信 thing 类型最多 20 字
  thing2: { value: truncate(event.content, 20) },
  time3:  { value: new Date().toLocaleString('zh-CN') },
}
```

---

## 六、数据字典

### 6.1 Entity：UserEntity 扩展字段

| 字段 | 类型 | 长度 | 约束 | 说明 |
|------|------|------|------|------|
| `openid` | VARCHAR | 64 | UNIQUE | 微信 openid（小程序/APP/公众号各自不同，同一端不重复） |
| `unionid` | VARCHAR | 64 | UNIQUE | 微信开放平台 unionid（跨端同一人一个 unionid） |
| `wechatNickname` | VARCHAR | 50 | NULL | 微信授权时的昵称快照 |
| `wechatAvatar` | VARCHAR | 500 | NULL | 微信头像 URL 快照 |
| `wechatAccessToken` | VARCHAR | 500 | NULL | 微信 access_token（敏感，fmtUser 不暴露） |
| `wechatRefreshToken` | VARCHAR | 255 | NULL | 微信 refresh_token（敏感，fmtUser 不暴露） |
| `wechatExpiresAt` | DATETIME | - | NULL | wechatAccessToken 过期时间 |

### 6.2 Entity：PushDeviceEntity

| 字段 | 类型 | 长度 | 约束 | 说明 |
|------|------|------|------|------|
| `id` | INT | - | PK AUTO_INCREMENT | 主键 |
| `userId` | INT | - | NOT NULL, INDEX | 关联 users.id（外键约束未启用，与项目风格一致） |
| `channel` | VARCHAR | 20 | NOT NULL | 推送通道：'wx_subscribe' / 'jpush_apns' / 'sse' |
| `openid` | VARCHAR | 64 | NULL | 微信订阅消息目标 |
| `unionid` | VARCHAR | 64 | NULL | 微信身份（可选冗余） |
| `registrationId` | VARCHAR | 128 | NULL | 极光/个推 SDK 返回的 registrationId |
| `deviceToken` | VARCHAR | 256 | NULL | APNs deviceToken（iOS 专属） |
| `pushPlatform` | VARCHAR | 20 | NULL | 'ios' / 'android' |
| `sseClientId` | VARCHAR | 128 | NULL | eventBus clientId（SSE 自动注册） |
| `appVersion` | VARCHAR | 20 | NULL | APP/小程序版本号（调试用） |
| `deviceModel` | VARCHAR | 50 | NULL | 设备型号 |
| `lastActiveAt` | DATETIME | - | NULL | 最近一次活跃时间（设备心跳刷新） |
| `enabled` | TINYINT | - | DEFAULT 1, INDEX | 1=活跃 0=已解绑 |
| `createdAt` | DATETIME | - | DEFAULT CURRENT_TIMESTAMP | 创建时间 |

### 6.3 Entity：PushLogEntity

| 字段 | 类型 | 长度 | 约束 | 说明 |
|------|------|------|------|------|
| `id` | BIGINT | - | PK AUTO_INCREMENT | 主键 |
| `userId` | INT | - | NOT NULL, INDEX | 推送目标用户 |
| `eventType` | VARCHAR | 50 | NOT NULL, INDEX | 事件类型：'order_paid' 等 |
| `dedupKey` | VARCHAR | 128 | NOT NULL | 去重键，格式 `${userId}:${eventType}:${业务主键}` |
| `channels` | VARCHAR | 100 | NOT NULL | 本次推了哪些通道，逗号分隔：'wx_subscribe,jpush_apns' |
| `successCount` | INT | - | DEFAULT 0 | 成功的通道数 |
| `failCount` | INT | - | DEFAULT 0 | 失败的通道数 |
| `failDetail` | JSON | - | NULL | 失败明细数组 `[{ channel, error }]` |
| `createdAt` | DATETIME | - | DEFAULT CURRENT_TIMESTAMP, INDEX | 推送时间 |

---

## 七、DDL 变更脚本（生产手动执行）

```sql
-- ====== 1. users 表扩展微信身份字段 ======
ALTER TABLE users
  ADD COLUMN openid VARCHAR(64) NULL COMMENT '微信 openid' AFTER reviewNote,
  ADD COLUMN unionid VARCHAR(64) NULL COMMENT '微信开放平台 unionid' AFTER openid,
  ADD COLUMN wechatNickname VARCHAR(50) NULL COMMENT '微信昵称快照' AFTER unionid,
  ADD COLUMN wechatAvatar VARCHAR(500) NULL COMMENT '微信头像 URL' AFTER wechatNickname,
  ADD COLUMN wechatAccessToken VARCHAR(500) NULL COMMENT '微信 access_token（敏感）' AFTER wechatAvatar,
  ADD COLUMN wechatRefreshToken VARCHAR(255) NULL COMMENT '微信 refresh_token（敏感）' AFTER wechatAccessToken,
  ADD COLUMN wechatExpiresAt DATETIME NULL COMMENT 'access_token 过期时间' AFTER wechatRefreshToken;

CREATE UNIQUE INDEX uk_users_openid  ON users(openid);
CREATE UNIQUE INDEX uk_users_unionid ON users(unionid);

-- ====== 2. 推送设备注册表 ======
CREATE TABLE IF NOT EXISTS push_devices (
  id INT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL COMMENT '关联 users.id',
  channel VARCHAR(20) NOT NULL COMMENT 'wx_subscribe | jpush_apns | sse',
  openid VARCHAR(64) NULL COMMENT '微信订阅消息目标 openid',
  unionid VARCHAR(64) NULL COMMENT '微信 unionid（冗余）',
  registrationId VARCHAR(128) NULL COMMENT '极光/个推 registrationId',
  deviceToken VARCHAR(256) NULL COMMENT 'APNs deviceToken（iOS）',
  pushPlatform VARCHAR(20) NULL COMMENT 'ios | android',
  sseClientId VARCHAR(128) NULL COMMENT 'SSE 连接 eventBus clientId',
  appVersion VARCHAR(20) NULL COMMENT 'APP/小程序版本号',
  deviceModel VARCHAR(50) NULL COMMENT '设备型号',
  lastActiveAt DATETIME NULL COMMENT '最近活跃时间',
  enabled TINYINT NOT NULL DEFAULT 1 COMMENT '1=活跃 0=已解绑',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pd_user (userId),
  INDEX idx_pd_channel (channel),
  INDEX idx_pd_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='推送设备注册表';

-- ====== 3. 推送审计日志表 ======
CREATE TABLE IF NOT EXISTS push_logs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  userId INT NOT NULL COMMENT '推送目标用户',
  eventType VARCHAR(50) NOT NULL COMMENT '事件类型',
  dedupKey VARCHAR(128) NOT NULL COMMENT '去重键',
  channels VARCHAR(100) NOT NULL COMMENT '通道列表，逗号分隔',
  successCount INT NOT NULL DEFAULT 0 COMMENT '成功通道数',
  failCount INT NOT NULL DEFAULT 0 COMMENT '失败通道数',
  failDetail JSON NULL COMMENT '失败明细',
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_pl_user_time (userId, createdAt),
  INDEX idx_pl_event (eventType)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='推送审计日志';
```

---

## 八、环境变量清单（`.env` 补充）

```bash
# ============== 微信开放平台 ==============
# 拿到企业主体资质后填这两个（小程序 jscode2session 用）
WX_MINI_PROGRAM_APPID=
WX_MINI_PROGRAM_SECRET=

# APP / H5 开放平台 OAuth2 登录（下一期再接入，预留）
WX_OPEN_PLATFORM_APPID=
WX_OPEN_PLATFORM_SECRET=

# 微信 access_token（后端定时刷新，生产定时任务写进去即可，开发可手动填）
WX_ACCESS_TOKEN=

# ============== Redis（推送限频去重用；开发不填走内存 fallback）==============
REDIS_HOST=
REDIS_PORT=6379

# ============== 极光推送 ==============
JPUSH_APPKEY=
JPUSH_MASTER_SECRET=

# ============== 微信订阅消息模板 ID ==============
WX_TPL_ORDER_PAID=
WX_TPL_ORDER_SHIPPED=
WX_TPL_INSTALL_ACCEPT=
WX_TPL_DESIGN_DELIVERED=
WX_TPL_DISPUTE_RESOLVED=
WX_TPL_SECURITY_CHANGE=
```

---

## 九、验收标准

### 9.1 微信授权登录（P0）

| # | 验收场景 | 预期行为 |
|---|---------|---------|
| V1 | 新用户调 wechat-login | 返回 consumer 角色 token，user.phone=null，user.phoneBound=false |
| V2 | 新用户首次调 encryptedData+iv 同时登录 | phone 被自动解密补入，phoneBound=true |
| V3 | 新用户仅静默登录，后续调 wechat-bind-phone | phone 通过验证码补入，token 重新生成 |
| V4 | 已有手机号账号调 bind-wechat（openid 未占用） | wechatBound=true，成功关联 |
| V5 | 已有手机号账号调 bind-wechat（openid 被其他用户占用） | 返回 409 "该微信已被其他账号绑定" |
| V6 | 纯微信账号（无 phone）调 unbind-wechat | 返回 422 拒绝 |
| V7 | 正常微信账号（有 phone）调 unbind-wechat | openid/unionid 置 NULL，wechatBound=false |
| V8 | 并发：10 个请求同时用同一个 unionid 注册 | 只有一个成功创建，其余拿到已存在用户（ER_DUP_ENTRY 兜底） |
| V9 | 老用户调 bind-wechat（unionid 已存在但 openid 为空） | 自动补 openid，不重新创建 |

### 9.2 推送服务（P1）

| # | 验收场景 | 预期行为 |
|---|---------|---------|
| P1 | 同一 userId + dedupKey 5 分钟内连续调 2 次 push() | 第 2 次跳过，不推 |
| P2 | 用户有 wx_subscribe + sse 活跃设备 | 两个通道都推，push_logs.channels='wx_subscribe,sse' |
| P3 | 用户无任何活跃设备 | push() 静默跳过，日志里记"无活跃设备" |
| P4 | 业务触发 order_shipped，用户有 openid | 微信订阅消息 API 被调（生产返回微信 API 响应；mock 写日志） |
| P5 | SSE 客户端连接 /api/events | push_devices 自动写入 sse 记录；close 时自动删除 |
| P6 | APP 端调 device/register 后业务触发 push() | 极光 v3/push API 被调（mock 写日志） |

### 9.3 设备管理

| # | 验收场景 | 预期行为 |
|---|---------|---------|
| D1 | 同 userId+channel 第 2 次调 register | upsert（enabled=1，lastActiveAt 更新），不新增行 |
| D2 | unregister 不传 channel | 该用户所有 channel enabled=0 |
| D3 | list 返回 | 脱敏：不暴露 deviceToken/registrationId 原文 |

### 9.4 兼容现有登录流程

| # | 验收场景 | 预期行为 |
|---|---------|---------|
| C1 | 现有 `/api/auth/login`（验证码登录） | 不受影响，继续可用 |
| C2 | 现有 `/api/auth/login-password` | 不受影响 |
| C3 | 现有 `/api/auth/login-account` | 不受影响，admin/vendor/designer/installer 继续用账号密码 |
| C4 | fmtUser 输出 | 现有调用方不受影响（新增字段 wechatBound/phoneBound 向后兼容） |

---

## 十、开发任务拆分

### 10.1 后端 Agent 任务

| 任务 | 优先级 | 依赖 | 产出 | PRD 参考 |
|------|--------|------|------|---------|
| T1.1 改造 UserEntity + DDL | **P0** | 无 | 6 列 + 2 唯一索引 | §6.1 / §7 |
| T1.2 新建 services/wechat-client.ts | **P0** | T1.1 | code2session + 手机号解密 + mock 模式 | §5.1 A1-A2 |
| T1.3 改造 wechat-login 路由 | **P0** | T1.1, T1.2 | unionid 优先查找 + 自动注册 + 并发兜底 | §5.1 A1 |
| T1.4 新增 wechat-bind-phone / bind-wechat / unbind-wechat | **P0** | T1.3 | 三个端点 | §5.1 A3-A5 |
| T1.5 db-orm.ts 补查询函数 + fmtUser 扩展 | **P0** | T1.1 | findUserByUnionidORM / findUserByOpenidORM | §6.1 |
| T1.6 新建 push_devices / push_logs 实体 | P1 | T1.1 | 两张 Entity | §6.2 / §6.3 |
| T1.7 新建 services/push.ts | P1 | T1.6 | 限频去重 + 三通道适配器 | §5.3 / §9.2 |
| T1.8 新增 device register/unregister/list 路由 | P1 | T1.6 | 三个端点 | §5.2 C1-C3 |
| T1.9 SSE 端点自动注册 sse 设备 | P1 | T1.7, T1.8 | index.ts 改动 | §9.2 P5 |
| T1.10 业务触发点埋 push() 调用 | P1 | T1.7 | 6 个业务触发点 | §5.3 |
| T1.11 执行生产 DDL | 上线前 | T1.1, T1.6 | ALTER TABLE + CREATE TABLE | §7 |

### 10.2 前端 Agent 任务（小程序 + APP）

| 任务 | 依赖 | 产出 | PRD 参考 |
|------|------|------|---------|
| T2.1 登录页：自动调 wx.login → POST wechat-login | 无 | 登录入口改造 | §2.1 / §5.1 A1 |
| T2.2 phoneBound=false 时弹"获取手机号"按钮 | T2.1 | 前端弹窗 + 调 wx.getPhoneNumber | §2.1 |
| T2.3 账号安全页：绑定微信 / 解绑微信 | T2.1 | 两个按钮 + 调用 bind-wechat / unbind-wechat | §2.2 / §5.1 A4-A5 |
| T2.4 APP 启动时调 device/register（jpush_apns） | 后端 T1.8 | registrationId 上送 | §5.2 C1 |
| T2.5 用户退出时调 device/unregister | T2.4 | 清理 | §5.2 C2 |
| T2.6 关键动作前调 wx.requestSubscribeMessage | 后端 T1.7 | 6 个模板选择框 | §5.4 |
| T2.7 消费端不调 SSE（小程序/APP 不常驻） | — | 避免 EventSource 限制 | §1.2 |

### 10.3 PC Web 角色端（admin/vendor/designer/installer）

| 任务 | 产出 | PRD 参考 |
|------|------|---------|
| T3.1 继续使用账号密码登录 + SSE 实时通知 | 无变化 | §3.1 |

### 10.4 数据 Agent 任务

| 任务 | 产出 | PRD 参考 |
|------|------|---------|
| T4.1 建 push_devices 表 DDL | 建表脚本 | §7 |
| T4.2 建 push_logs 表 DDL | 建表脚本 | §7 |
| T4.3 users 表 ALTER 脚本 | 变更脚本 | §7 |
| T4.4 创建 SQL 回滚脚本（上线前准备） | 回滚脚本 | 运维 |
| T4.5 历史手机号用户数据修复脚本（批量补 openid/unionid） | 数据修复脚本 | 可选，上线后 |

---

## 十一、风险与应对

| 风险 | 可能性 | 影响 | 应对方案 |
|------|--------|------|---------|
| 微信开放平台审核未通过 | 低 | 阻塞上线 | 提前申请；降级方案：只做 openid 不做 unionid（代码已兼容） |
| 小程序是个人主体（无法申请开放平台） | 中 | 无法拿到 unionid | 降级方案：仅做 openid，APP 和小程序身份独立；接口签名不变，后端自动适配 |
| 微信订阅消息模板被驳回 | 中 | 部分推送失效 | 按微信规范重新申请；业务降级为 SSE（PC 端仍可用）+ APP 极光推送 |
| 并发重复注册同一 unionid | 低 | 数据不一致 | ER_DUP_ENTRY 兜底（catch 后再查一次） |
| Redis 不可用 | 低 | 限频去重失效 | 自动 fallback 进程内 Map（内存模式也走这个），5 分钟内限流在多实例部署下不严谨——但极光/微信有自己的频控兜底 |
| 极光推送 SDK 未在 APP 端集成 | 中 | APP 推不出去 | 后端 mock 模式不阻塞前端开发；前端 SDK 集成后自动启用真实推送 |
| 用户解绑微信后手机号丢失（纯微信账号） | 中 | 无法登录 | 强制检查：phone 为空时 unbind-wechat 返回 422 |
| 开放开发 mock 接口被线上客户端调用 | 低 | 安全 | process.env.NODE_ENV !== 'production' 时才暴露（现有 dev/set-role 的安全模式） |

---

## 十二、测试计划

| 测试类型 | 覆盖范围 | 执行方式 |
|---------|---------|---------|
| **单元测试** | wechat-client：code2session 入参校验 / mock 模式确定性 / decryptWechatPhone 算法正确性 | Vitest |
| **单元测试** | push：限频去重 / 适配器接口契约 / audit log 写入 | Vitest |
| **接口测试** | A1-A5 五个 auth 端点 + C1-C3 三个 device 端点 | curl / Postman / Vitest |
| **并发测试** | 同一 unionid 并发 10 个请求 → 只有一个创建成功 | autocannon 或并发脚本 |
| **端到端测试** | 小程序微信登录 → 绑手机号 → 下单 → 收到发货推送 | 前端真机 + 后端联调 |
| **兼容性测试** | 现有 login / login-password / login-account 流程不受影响 | 回归测试 |

---

## 十三、上线 Checklist

| # | 事项 | 负责 | 完成 |
|---|------|------|------|
| 1 | 执行 DDL 脚本（users 扩展 + push_devices + push_logs） | DBA/运维 | |
| 2 | 配置 .env：WX_MINI_PROGRAM_APPID / SECRET | 后端运维 | |
| 3 | 配置 .env：JPUSH_APPKEY / MASTER_SECRET（APP 推送） | 后端运维 | |
| 4 | 配置 .env：WX_TPL_* 6 个模板 ID | 后端运维 | |
| 5 | 配置 Redis host（限频去重） | 后端运维 | |
| 6 | 生产 Node 实例重启 + 健康检查 | 运维 | |
| 7 | 小程序前端版本发布（含 wx.login + wx.getPhoneNumber + wx.requestSubscribeMessage） | 小程序 | |
| 8 | APP 前端版本发布（含极光 SDK + device register） | APP | |
| 9 | 灰度验证：新用户微信登录 → 手机号绑定 → 订单发货推送 | QA | |
| 10 | 清理历史 debug 代码（tmp-* 等） | 后端 | |

---

*—— PRD 终—— 开发任务已在 §10 拆分完毕，等待确认后分发到各 Agent。*
