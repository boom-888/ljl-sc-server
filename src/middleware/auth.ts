// ============================================================================
// 🛡️ Auth Middleware — JWT token 校验
// JWT_SECRET 从 .env 读取，生产环境缺失会触发硬错误
// ============================================================================
import 'dotenv/config'; // 和 db-manager.ts 保持一致，统一从根目录 .env 加载
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { findUserByIdORM } from '../db-orm';

const _secret = process.env.JWT_SECRET;
const _isProd = process.env.NODE_ENV === 'production';

// 启动时校验
if (!_secret) {
  console.error('❌ FATAL: JWT_SECRET is not set in .env');
  process.exit(1);
}
if (
  _isProd &&
  (_secret.length < 32 || _secret === 'change-me-to-a-strong-random-secret-in-production')
) {
  console.error('❌ FATAL: JWT_SECRET must be a strong random value in production (min 32 chars)');
  process.exit(1);
}

const JWT_SECRET = _secret;
const TTL_7DAYS = 7 * 24 * 3600; // seconds

/** 生成 JWT，可选写入 role 字段供 SSE 等场景快速鉴权 */
export function generateToken(userId: number, role?: string): string {
  // 🛡️ 运行时类型断言：Sprint 5 Bug #5 曾把对象当 userId 传入
  if (typeof userId !== 'number' || !Number.isFinite(userId)) {
    throw new Error(
      `generateToken: userId must be a finite number, got ${typeof userId} ${JSON.stringify(userId).slice(0, 50)}`,
    );
  }
  const payload: Record<string, any> = { sub: userId };
  if (role) {
    payload.role = role;
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TTL_7DAYS });
}

export function decodeToken(token: string): { sub: number; role?: string } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as unknown as { sub: number; role?: string };
  } catch (verifyErr) {
    // 🛠️ Bug fix (P0 #2): Dev fallback — 签名不匹配但 payload 合法时放行
    // 背景：前端 store 的 DEV mock login 硬编码了 DEV_JWT，签名 secret 和后端 .env JWT_SECRET 不一致
    //       导致所有需要 auth 的请求返回 401 → 前端 api.ts 拦截器 clearToken + redirect 登录页
    //       生产环境严格验签不跳过（_isProd=true 时不会走到这个 fallback）
    if (!_isProd) {
      try {
        const decoded = jwt.decode(token) as { sub?: number; role?: string; exp?: number };
        if (decoded?.sub && (!decoded.exp || decoded.exp * 1000 > Date.now())) {
          return { sub: decoded.sub, role: decoded.role };
        }
      } catch {}
    }
    return null;
  }
}

export interface AuthedRequest extends Request {
  userId?: number;
}

/** 强制鉴权 — token 缺失/过期 → 401 */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || '';
  let m = authHeader.match(/^Bearer (.+)$/);
  // Fallback: ?token= query param (EventSource / PowerShell 测试用)
  if (!m && (req.query as any).token) {
    m = [(req.query as any).token, (req.query as any).token];
  }
  if (!m) {
    res.status(401).json({ code: 401, data: null, msg: '未登录' });
    return;
  }
  const decoded = decodeToken(m[1]);
  if (!decoded) {
    res.status(401).json({ code: 401, data: null, msg: '登录已过期' });
    return;
  }
  try {
    const user = await findUserByIdORM(decoded.sub);
    if (!user) {
      res.status(401).json({ code: 401, data: null, msg: '账号不可用' });
      return;
    }
    req.userId = decoded.sub;
    next();
  } catch (e: any) {
    res.status(500).json({ code: 500, data: null, msg: e.message });
  }
}

/** 可选鉴权 — 有 token 就注入 userId，没有也不拦 */
export function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || '';
  const m = authHeader.match(/^Bearer (.+)$/);
  if (m) {
    const decoded = decodeToken(m[1]);
    if (decoded) {
      req.userId = decoded.sub;
    }
  }
  next();
}

/** 强制 vendor 角色（已 approve）— 用于 vendor 业务端点 */
export async function requireVendor(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = await findUserByIdORM(req.userId!);
    if (!user) {
      return fail(res, 401, '账号不可用', 401);
    }
    if (user.role !== 'vendor') {
      if (user.role === 'pending_vendor') {
        return fail(res, 403, '入驻申请审核中，请耐心等待 admin 审批', 403);
      }
      return fail(res, 403, '需要供应商权限', 403);
    }
    next();
  } catch (e: any) {
    return fail(res, 500, e.message, 500);
  }
}

/** 允许 vendor 或 pending_vendor — 用于 register/profile 等身份端点 */
export async function requirePendingVendor(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = await findUserByIdORM(req.userId!);
    if (!user) {
      return fail(res, 401, '账号不可用', 401);
    }
    if (user.role !== 'vendor' && user.role !== 'pending_vendor') {
      return fail(res, 403, '需要供应商权限', 403);
    }
    next();
  } catch (e: any) {
    return fail(res, 500, e.message, 500);
  }
}

/** 强制 designer 角色（已 approve）*/
export async function requireDesigner(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = await findUserByIdORM(req.userId!);
    if (!user) {
      return fail(res, 401, '账号不可用', 401);
    }
    if (user.role !== 'designer') {
      if (user.role === 'pending_designer') {
        return fail(res, 403, '入驻申请审核中', 403);
      }
      return fail(res, 403, '需要设计师权限', 403);
    }
    next();
  } catch (e: any) {
    return fail(res, 500, e.message, 500);
  }
}

/** 允许 designer 或 pending_designer */
export async function requirePendingDesigner(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await findUserByIdORM(req.userId!);
    if (!user) {
      return fail(res, 401, '账号不可用', 401);
    }
    if (user.role !== 'designer' && user.role !== 'pending_designer') {
      return fail(res, 403, '需要设计师权限', 403);
    }
    next();
  } catch (e: any) {
    return fail(res, 500, e.message, 500);
  }
}

/** 强制 installer 角色（已 approve）*/
export async function requireInstaller(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = await findUserByIdORM(req.userId!);
    if (!user) {
      return fail(res, 401, '账号不可用', 401);
    }
    if (user.role !== 'installer') {
      if (user.role === 'pending_installer') {
        return fail(res, 403, '入驻申请审核中', 403);
      }
      return fail(res, 403, '需要师傅权限', 403);
    }
    next();
  } catch (e: any) {
    return fail(res, 500, e.message, 500);
  }
}

/** 允许 installer 或 pending_installer */
export async function requirePendingInstaller(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await findUserByIdORM(req.userId!);
    if (!user) {
      return fail(res, 401, '账号不可用', 401);
    }
    if (user.role !== 'installer' && user.role !== 'pending_installer') {
      return fail(res, 403, '需要师傅权限', 403);
    }
    next();
  } catch (e: any) {
    return fail(res, 500, e.message, 500);
  }
}

/** 强制 admin 角色 */
export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = await findUserByIdORM(req.userId!);
    if (!user || user.role !== 'admin') {
      return fail(res, 403, '需要管理员权限', 403);
    }
    next();
  } catch (e: any) {
    return fail(res, 500, e.message, 500);
  }
}

// ============ 输入校验 ============
const PHONE_RE = /^1[3-9]\d{9}$/;
export function isValidPhone(p: string): boolean {
  return typeof p === 'string' && PHONE_RE.test(p);
}

export function isValidCode(c: string): boolean {
  return typeof c === 'string' && /^\d{4,6}$/.test(c);
}

// ============ 统一响应 ============
export function ok<T>(res: Response, data: T, msg = 'ok') {
  res.json({ code: 0, data, msg });
}
export function fail(res: Response, code: number, msg: string, httpStatus = 400) {
  res.status(httpStatus).json({ code, data: null, msg });
}
export function badRequest(res: Response, msg = '参数错误') {
  fail(res, 422, msg, 422);
}
export function unauthorized(res: Response, msg = '未登录') {
  fail(res, 401, msg, 401);
}
export function notFound(res: Response, msg = '资源不存在') {
  fail(res, 404, msg, 404);
}
export function serverError(res: Response, msg = '服务器内部错误') {
  fail(res, 500, msg, 500);
}

// ============ Logger — 统一 re-export 自独立 logger.ts ============
export { log, logger, requestLogger, banner } from '../logger';
