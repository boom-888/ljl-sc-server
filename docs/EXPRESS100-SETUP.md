# ============================================================================
# 📮 快递100 L2/L3 真实轨迹接入指引
# ============================================================================
# 
# ✅ 后端代码已全就绪（order.ts L285-337），只差 .env 配置开关 + key
# ✅ 自动 fallback：L2 任何异常静默降级 L1 mock，不影响用户体验
# ✅ 结果缓存：L2 成功后自动写入 order.logisticsTrail JSON
# ============================================================================

## 第一步：注册 + 获取 API Key

### 免费 L2（推荐开发/测试用）
1. 打开 https://www.kuaidi100.com/openapi/apiad/followinfo.html
2. 用手机号注册 → 进入"快递查询 API"免费版
3. 免费版配额：**每天 3000 次**，足够开发 + 小量生产
4. 获取 API Key（32 位左右字母数字）

### 付费 L3（高并发生产）
- 企业版账号 https://www.kuaidi100.com/openapi/price.html
- 年付约 ¥800-2000 不等，每天 3-10 万次
- 代码无需改动，同一个接口 + key 切换即可

## 第二步：填 .env

修改 `server/.env`：
```
FEATURE_EXPRESS_API=true
EXPRESS100_KEY=你的32位key
# EXPRESS100_URL 默认即可，无需修改
```

如果已经拆了 `.env.development` + `.env.production`，**只在 `.env.production` 里开**（开发保持 L1 mock 避免消耗额度）。

## 第三步：验证

1. 后端重启（新 env 才生效）
2. 准备一条 DB 里已发货的订单（有 shippingCompany + shippingNo + shippedAt）
3. 调用 API：
   ```
   curl http://localhost:3001/api/logistics/timeline?orderId=5 -H "Authorization: Bearer xxx"
   ```
4. 看返回的 `source` 字段：
   - `"source": "api"` → ✅ L2 真实轨迹命中
   - `"source": "mock"` → 查 FEATURE_EXPRESS_API/key 是否生效
   - `"source": "cache"` → ✅ L0 缓存命中（之前 L2 成功过）
   - `"shipped": false` → 订单还没发货，正常

## 第四步：订阅推送（可选进阶）

当前实现是**主动查询模式**（用户打开订单详情才调一次 API）。如果要订阅推送（快递100 实时推状态变更到你服务器）：
1. 快递100 控制台配置订阅 URL：`https://你的域名/api/express/callback`
2. 在后端新增 `POST /api/express/callback` 路由：验签 → 更新 orders.logisticsTrail JSON
3. 代码骨架（在 order.ts 或单独 express.ts 里加）：
   ```ts
   router.post('/express/callback', express.json(), async (req, res) => {
     const { com, num, data, sign } = req.body;
     // 验签（快递100 MD5(com+num+key)）
     const expected = require('crypto').createHash('md5').update(com + num + EXPRESS100_KEY).digest('hex').toUpperCase();
     if (expected !== sign) return res.status(403).json({ code: 403 });
     // 更新订单轨迹
     // ...
   });
   ```

## 附录：当前 codeMap 映射

| 快递公司 | Entity.code | 快递100 com 码 |
|---|---|---|
| 顺丰 | SF | sf |
| 圆通 | YT | yto |
| 中通 | ZTO | zto |
| 申通 | ST/STO | sto |
| 京东 | JD/JD_EXPRESS | jd |
| EMS | EMS | ems |
| 韵达 | YD/YUNDA | yunda |
| 德邦/免费 | FREEZE | freeze |

如果后续加新快递公司，只需要：
1. DB `express_companies` 表加一行（name/code/defaultTrackingUrl）
2. 上面 codeMap 补一条 `新code: '快递100的com码'`
