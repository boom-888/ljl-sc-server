// ============================================================================
// 🎨 Auth Routes — 认证相关 endpoint
// POST /api/auth/send-code        发送验证码（mock 固定 123456）
// POST /api/auth/login            验证码登录（首次出现即自动注册）
// POST /api/auth/login-password   手机号+密码登录（bcrypt 校验）
// POST /api/auth/login-account   管理后台账号密码登录
// POST /api/auth/register         手机号+验证码+密码注册（不自动登录）
// POST /api/auth/wechat-login    微信 openid 自动登录/注册
// POST /api/auth/change-password  已登录用户改密码
// POST /api/auth/reset-password   手机号+验证码重置密码（免登录）
// POST /api/auth/logout           登出（后端无状态，仅 ack）
// POST /api/auth/dev/set-role     开发态角色注入
//
// ⚠️ GET/PUT /profile 已迁移到 user.ts 并 mount 在 /api/user/profile
//    前端 authService.getProfile() / updateProfile() 走的就是那套
//    本文件不再保留 profile 端点，避免双轨维护
// ============================================================================
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import {
  findUserByPhoneWithHashORM,
  findUserByAccountWithHashORM,
  findUserByIdWithHashORM,
  findUserByUnionidORM,
  findUserByOpenidORM,
  createUserORM,
  updateUserORM,
} from '../db-orm';
import { getStore, isTypeORMReady, db } from '../db';
import {
  generateToken,
  isValidPhone,
  isValidCode,
  requireAuth,
  ok,
  fail,
  badRequest,
  unauthorized,
  serverError,
  log,
} from '../middleware/auth';
import {
  wechatCode2Session,
  decryptWechatPhone,
  isWechatMockMode,
  type WechatPlatform,
} from '../services/wechat-client';

const router = Router();

console.log('🔥 AUTH.TS LOADED OK — all imports resolved');

// 测试用验证码（mock 固定值）
const MOCK_CODE = '123456';

// — 2.1 send-code —
router.post('/send-code', (req, res) => {
  const { phone } = req.body || {};
  if (!phone || !isValidPhone(phone)) {
    return badRequest(res, '手机号格式错误');
  }
  log(`send-code phone=${phone} code=${MOCK_CODE} (mock)`);
  ok(res, { success: true, expiresIn: 300 }, '验证码已发送（mock: 123456）');
});

// — 2.2 login (验证码) —
router.post('/login', async (req, res) => {
  const { phone, code } = req.body || {};
  if (!phone || !isValidPhone(phone)) {
    return badRequest(res, '手机号格式错误');
  }
  if (!code || !isValidCode(code)) {
    return badRequest(res, '验证码格式错误');
  }
  if (code !== MOCK_CODE) {
    return fail(res, 422, '验证码错误', 422);
  }

  let user;
  try {
    user = await findUserByPhoneWithHashORM(phone);
    log(`[login] TypeORM query OK user=${user?.id ?? 'null'}`);
  } catch (e: any) {
    log(`[login] ORM fallback: ${e.message}`, 'warn');
    user = getStore().users.find((u) => u.phone === phone) ?? null;
  }
  if (!user) {
    // 查内存 store 也没有 → 自动注册
    try {
      user = await createUserORM({ phone, nickname: `用户${phone.slice(-4)}`, role: 'consumer' });
      log(`[login] auto-register userId=${user.id}`);
    } catch (e: any) {
      log(`[login] auto-register fail: ${e.message}`, 'error');
      return fail(res, 500, '自动注册失败: ' + e.message, 500);
    }
  } else if (user.status !== 1) {
    return fail(res, 403, '账号已禁用', 403);
  }

  const token = generateToken(user.id);
  await updateUserORM(user.id, {}).catch(() => {});
  log(`login userId=${user.id} phone=${phone}`);
  ok(res, { token, user: safeUser(user as any) });
});

// — 2.3 login-password —
router.post('/login-password', async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !isValidPhone(phone)) {
    return badRequest(res, '手机号格式错误');
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return badRequest(res, '密码至少 6 位');
  }

  let user;
  try {
    user = await findUserByPhoneWithHashORM(phone);
  } catch {
    user = getStore().users.find(u => u.phone === phone);
  }
  if (!user || !user.passwordHash) {
    return fail(res, 401, '手机号或密码错误', 401);
  }
  if (user.status !== 1) {
    return fail(res, 403, '账号已禁用', 403);
  }
  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return fail(res, 401, '手机号或密码错误', 401);
  }

  const token = generateToken(user.id);
  log(`login-password userId=${user.id}`);
  ok(res, { token, user: safeUser(user as any) });
});

// — 2.3 login-account（用户名 or 手机号 + 密码）——
// 管理后台和内部账号登录专用，account 可以是 username/nickname/phone
router.post('/login-account', async (req, res) => {
  try {
  const { account, password } = req.body || {};
  if (!account || !password) {
    return badRequest(res, '账号和密码不能为空');
  }
  if (typeof password !== 'string' || password.length < 6) {
    return badRequest(res, '密码至少 6 位');
  }

  // 先用手机号查，如果不是手机号就用 account 字段查
  let user;
  try {
    if (isValidPhone(account)) {
      user = await findUserByPhoneWithHashORM(account);
    } else {
      user = await findUserByAccountWithHashORM(account);
    }
  } catch (e) {
    log(`[login-account] ORM error: ${e.message}`, 'error');
    const store = getStore();
    if (isValidPhone(account)) {
      user = store.users.find(u => u.phone === account);
    } else {
      user = store.users.find(u => u.nickname === account);
    }
  }

  if (!user || !user.passwordHash) {
    return fail(res, 401, '账号或密码错误', 401);
  }
  if (user.status !== 1) {
    return fail(res, 403, '账号已禁用', 403);
  }
  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return fail(res, 401, '账号或密码错误', 401);
  }

  const token = generateToken(user.id);
  log(`login-account userId=${user.id} role=${user.role}`);
  ok(res, { token, user: safeUser(user as any) });
  } catch (e) {
    log(`[login-account] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误: ' + (e as any).message, 500);
  }
});

// — 2.4 register —
router.post('/register', async (req, res) => {
  const { phone, code, password } = req.body || {};
  if (!phone || !isValidPhone(phone)) {
    return badRequest(res, '手机号格式错误');
  }
  if (!code || !isValidCode(code)) {
    return badRequest(res, '验证码格式错误');
  }
  if (password && (typeof password !== 'string' || password.length < 6)) {
    return badRequest(res, '密码至少 6 位');
  }

  if (await findUserByPhoneWithHashORM(phone)) {
    return fail(res, 409, '手机号已注册', 409);
  }
  if (code !== MOCK_CODE) {
    return fail(res, 422, '验证码错误', 422);
  }

  const hash = password ? bcrypt.hashSync(password, 10) : undefined;
  const user = await createUserORM({
    phone,
    nickname: `用户${phone.slice(-4)}`,
    passwordHash: hash,
    role: 'consumer',
  });
  log(`register userId=${user.id} phone=${phone}`);
  ok(res, safeUser(user), '注册成功');
});

// — 2.5 logout —
router.post('/logout', requireAuth, (_req, res) => {
  ok(res, { success: true }, '已登出');
});

// — 2.6 changePassword — 已登录用户改密码（需知道旧密码）
router.post('/change-password', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return badRequest(res, '请输入旧密码和新密码');
  if (oldPassword === newPassword) return badRequest(res, '新旧密码不能相同');
  if (newPassword.length < 6) return badRequest(res, '新密码至少 6 位');

  // 用 findUserByIdWithHashORM — findUserByIdORM 返回 fmtUser 会过滤 passwordHash！
  const user = await findUserByIdWithHashORM(userId);
  if (!user) return unauthorized(res, '账号不可用');
  if (!user.passwordHash) return fail(res, 422, '该账号未设置密码，请用验证码登录', 422);
  if (!bcrypt.compareSync(oldPassword, user.passwordHash)) return fail(res, 401, '旧密码不正确', 401);

  await updateUserORM(userId, { passwordHash: bcrypt.hashSync(newPassword, 10) } as any);
  log(`change-password userId=${userId}`);
  ok(res, null, '密码修改成功');
});

// — 2.10 resetPassword — 忘记密码重置（手机号 + 验证码 + 新密码，无需登录）
router.post('/reset-password', async (req, res) => {
  const { phone, code, newPassword } = req.body || {};
  if (!phone || !isValidPhone(phone)) return badRequest(res, '手机号格式错误');
  if (!code || !isValidCode(code)) return badRequest(res, '验证码格式错误');
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) return badRequest(res, '新密码至少 6 位');
  if (code !== MOCK_CODE) return fail(res, 422, '验证码错误', 422);

  const user = await findUserByPhoneWithHashORM(phone);
  if (!user) return fail(res, 404, '该手机号未注册', 404);

  await updateUserORM(user.id, { passwordHash: bcrypt.hashSync(newPassword, 10) } as any);
  log(`reset-password phone=${phone} userId=${user.id}`);
  ok(res, null, '密码重置成功，请用新密码登录');
});

// — 2.11 wechat-login — 微信授权登录（开放平台 UnionID 跨端统一）—
// 流程：前端 wx.login() 拿 code → 后端 code2session 换 openid+unionid
//       → 用 unionid 查 users 表（优先）→ 命中直接登录，没命中自动创建 consumer 用户
//       → 可选：前端同时传 encryptedData+iv，后端解密手机号补到新用户
// 状态字段：返回 user.wechatBound（是否绑微信）+ user.phoneBound（是否绑手机号）
//       新用户 phoneBound=false 时 → 前端可弹"获取手机号"按钮补填
router.post('/wechat-login', async (req, res) => {
  try {
    const { platform, code, encryptedData, iv } = req.body || {};
    // 1. 校验参数
    const p = platform as WechatPlatform;
    if (!code) return badRequest(res, '缺少微信 code');
    if (!['mini', 'app', 'h5'].includes(p)) {
      return badRequest(res, 'platform 必须是 mini | app | h5');
    }

    // 2. 换 openid + unionid + sessionKey
    const { openid, unionid, sessionKey, mock } = await wechatCode2Session(p, code);
    if (!openid) return fail(res, 400, '微信 code 无效');
    if (mock) {
      log(`[wechat-login:MOCK] platform=${p} openid=${openid} unionid=${unionid}`);
    }

    // 3. 查用户：unionid 优先（跨端统一），openid fallback（老用户可能只有 openid 没 unionid）
    let user = unionid
      ? await findUserByUnionidORM(unionid)
      : await findUserByOpenidORM(openid);
    if (!user && unionid && unionid !== openid) {
      // unionid 没命中时再试一次 openid
      user = await findUserByOpenidORM(openid);
    }

    // 4. 命中老用户：补充可能缺失的微信字段（比如老 unionid 用户后来换了 openid）
    if (user) {
      if (user.status !== 1) return fail(res, 403, '账号已禁用', 403);
      // 如果发现用户已有 unionid，但 openid 为空 → 把本次拿到的 openid 补回去
      const u = user as any;
      const needUpdate = { ...(u.openid ? null : { openid }), ...(u.unionid ? null : { unionid }) };
      if (Object.keys(needUpdate).length > 0) {
        await updateUserORM(u.id, needUpdate as any);
      }
    }

    // 5. 没命中 → 自动注册 consumer 用户（phone 先设 null，前端后续补）
    if (!user) {
      try {
        // phone 用占位符，null 在 TypeORM 里也成立；但现有 ORM 实现 phone 是必填 → 用 openid 截断做占位
        const placeholderPhone = `wx_${openid.slice(-11)}`.padEnd(11, '0').slice(0, 11);
        user = await createUserORM({
          phone: placeholderPhone,
          nickname: `微信用户${(unionid || openid).slice(-4)}`,
          role: 'consumer',
          openid,
          unionid: unionid || undefined,
        });
        log(`[wechat-login] 自动注册 userId=${(user as any).id} unionid=${unionid} openid=${openid}`);
      } catch (e: any) {
        // 唯一索引冲突（极端并发：两个请求同时用同一个 unionid 注册）→ 再查一次
        if (e?.code === 'ER_DUP_ENTRY') {
          user = (unionid
            ? await findUserByUnionidORM(unionid)
            : await findUserByOpenidORM(openid)) || null;
        }
        if (!user) {
          log(`[wechat-login] 自动注册失败: ${e.message}`, 'error');
          return serverError(res, '自动注册失败');
        }
      }
    }

    // 6. 如果前端同时传了 encryptedData → 解密手机号补到用户
    let decryptedPhone: string | null = null;
    if (encryptedData && iv && sessionKey) {
      decryptedPhone = decryptWechatPhone(sessionKey, encryptedData, iv);
      if (decryptedPhone && !(user as any).phone) {
        await updateUserORM((user as any).id, { phone: decryptedPhone } as any);
        log(`[wechat-login] 补手机号 userId=${(user as any).id} phone=${decryptedPhone}`);
        // 补完了重新 fmt 一次拿最新状态
        const refreshed = await findUserByIdWithHashORM((user as any).id);
        if (refreshed) user = refreshed;
      }
    }

    // 7. 生成 token + 返回（payload 带 role）
    const token = generateToken((user as any).id, (user as any).role);
    const safeU = safeUser(user as any);
    ok(res, {
      token,
      user: safeU,  // fmtUser 已带 wechatBound / phoneBound 字段
    }, mock ? `登录成功（开发 mock 模式：${isWechatMockMode() ? '微信真实密钥未配置' : '正常 mock 兜底'}）` : '登录成功');
  } catch (e: any) {
    log(`[wechat-login] FATAL: ${e.message}`, 'error');
    fail(res, 500, '微信登录失败: ' + e.message);
  }
});

// — 2.12 wechat-bind-phone — 新微信用户用验证码补手机号（二次绑定）—
// 场景：用户微信静默登录拿到 token 了，想下单但 phone=null → 调现有 send-code 通道
//       发验证码 → 后端校验验证码 → 把真实 phone 补到 users 记录
router.post('/wechat-bind-phone', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { phone, code } = req.body || {};

    if (!phone || !isValidPhone(phone)) return badRequest(res, '手机号格式错误');
    if (!code || !isValidCode(code)) return badRequest(res, '验证码格式错误');
    if (code !== MOCK_CODE) return fail(res, 422, '验证码错误', 422);

    // 1. 查当前用户
    const user = await findUserByIdWithHashORM(userId);
    if (!user) return unauthorized(res, '账号不可用');

    // 2. 如果用户已经有 phone → 拒绝（不能覆盖）
    if (user.phone) {
      return fail(res, 409, '该账号已绑定手机号', 409);
    }

    // 3. 手机号是否已被别人占用？
    const phoneOwner = await findUserByPhoneWithHashORM(phone);
    if (phoneOwner && phoneOwner.id !== userId) {
      return fail(res, 409, '该手机号已被其他账号绑定', 409);
    }

    // 4. 补 phone
    await updateUserORM(userId, { phone } as any);
    log(`[wechat-bind-phone] userId=${userId} phone=${phone}`);

    // 5. 重新生成 token（user 状态变了）
    const token = generateToken(userId, user.role);
    const refreshed = await findUserByIdWithHashORM(userId);
    ok(res, { token, user: safeUser(refreshed as any) }, '手机号绑定成功');
  } catch (e: any) {
    log(`[wechat-bind-phone] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误');
  }
});

// — 2.13 bind-wechat — 已有手机号用户主动绑定微信 —
// 场景：用户先用手机号注册了账号 → 后来在"账号安全"里点"绑定微信" → 前端 wx.login() 拿 code
//       → 后端 code2session → 检查 openid/unionid 是否被占用 → 没占用则写入当前用户
router.post('/bind-wechat', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const { platform, code } = req.body || {};
    const p = platform as WechatPlatform;

    if (!code) return badRequest(res, '缺少微信 code');
    if (!['mini', 'app', 'h5'].includes(p)) return badRequest(res, 'platform 非法');

    const { openid, unionid } = await wechatCode2Session(p, code);
    if (!openid) return fail(res, 400, '微信 code 无效');

    // 1. 检查 openid / unionid 是否已被其他账号占用
    if (openid) {
      const openOwner = await findUserByOpenidORM(openid);
      if (openOwner && openOwner.id !== userId) {
        return fail(res, 409, '该微信已被其他账号绑定', 409);
      }
    }
    if (unionid) {
      const unionOwner = await findUserByUnionidORM(unionid);
      if (unionOwner && unionOwner.id !== userId) {
        return fail(res, 409, '该微信已被其他账号绑定', 409);
      }
    }

    // 2. 写入当前用户
    const patch: any = {};
    if (openid) patch.openid = openid;
    if (unionid) patch.unionid = unionid;
    await updateUserORM(userId, patch);
    log(`[bind-wechat] userId=${userId} openid=${openid} unionid=${unionid}`);

    const refreshed = await findUserByIdWithHashORM(userId);
    ok(res, { token: generateToken(userId, refreshed?.role), user: safeUser(refreshed as any) }, '微信绑定成功');
  } catch (e: any) {
    log(`[bind-wechat] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误');
  }
});

// — 2.14 unbind-wechat — 解绑微信（换个微信号重新绑）—
// 规则：如果这个用户没有绑定手机号 → 拒绝解绑（解绑了就没法登录了）
router.post('/unbind-wechat', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId;
    const user = await findUserByIdWithHashORM(userId);
    if (!user) return unauthorized(res, '账号不可用');

    // 1. 安全检查：纯微信账号（没有 phone）不允许解绑
    if (!user.phone) {
      return fail(res, 422, '该账号未绑定手机号，请先绑定手机号再解绑微信', 422);
    }

    // 2. 清除 openid / unionid
    await updateUserORM(userId, { openid: null, unionid: null } as any);
    log(`[unbind-wechat] userId=${userId}`);

    const refreshed = await findUserByIdWithHashORM(userId);
    ok(res, { token: generateToken(userId, refreshed?.role), user: safeUser(refreshed as any) }, '微信解绑成功');
  } catch (e: any) {
    log(`[unbind-wechat] FATAL: ${e.message}`, 'error');
    fail(res, 500, '服务器内部错误');
  }
});

// ============ 🧪 Dev Helper — 开发环境专用角色注入 ============
// POST /api/auth/dev/set-role  { userId?: number, role }
// 安全：仅在 NODE_ENV !== 'production' 时启用；生产直接 404
const ALLOWED_ROLES = ['consumer', 'designer', 'vendor', 'installer', 'admin'] as const;
router.post('/dev/set-role', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ code: 404, msg: 'Not Found' });
  }
  const { userId, role } = req.body || {};
  if (!ALLOWED_ROLES.includes(role as any)) {
    return badRequest(res, `非法角色，允许: ${ALLOWED_ROLES.join(', ')}`);
  }

  let finalUser: any;
  let newToken: string;

  // — 内存 mock 路径 —
  if (!isTypeORMReady()) {
    if (userId) {
      finalUser = db.users.find((u) => u.id === Number(userId));
      if (!finalUser) {
        return fail(res, 404, '用户不存在', 404);
      }
      finalUser.role = role;
    } else {
      // 🛡️ 统一用 createUserORM：避免两套 ID 策略导致重复 id
      const phone = '139' + String(Date.now()).slice(-8);
      finalUser = await createUserORM({
        phone,
        passwordHash: 'dev',
        nickname: `dev-${role}`,
        role,
      });
      if (!finalUser) {
        return serverError(res, '创建测试用户失败');
      }
    }
    newToken = generateToken(finalUser.id, role);
    log(`[DEV-SET-ROLE-mock] userId=${finalUser.id} role=${role}`);
    ok(res, { ...safeUser(finalUser), token: newToken }, `角色已设为 ${role}`);
    return;
  }

  // — TypeORM 路径 —
  if (!userId) {
    const phone = '139' + String(Date.now()).slice(-8);
    finalUser = await createUserORM({ phone, passwordHash: 'dev', nickname: `dev-${role}`, role });
    newToken = generateToken(finalUser.id, role);
    log(`[DEV-SET-ROLE] 自动创建测试用户 id=${finalUser.id} phone=${phone} role=${role}`);
  } else {
    finalUser = await updateUserORM(Number(userId), { role } as any);
    if (!finalUser) {
      return fail(res, 404, '用户不存在', 404);
    }
    newToken = generateToken(finalUser.id, role);
    log(`[DEV-SET-ROLE] userId=${userId} → role=${role}`);
  }

  ok(res, { ...safeUser(finalUser), token: newToken }, `角色已设为 ${role}`);
});

// ============ 工具：去掉 passwordHash ============
export function safeUser(u: any) {
  const { passwordHash, ...rest } = u;
  return rest;
}

export default router;
