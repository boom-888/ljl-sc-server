// ============================================================================
// 👤 User Routes — /api/user/* (独立于 auth)
// GET  /api/user/profile
// PUT  /api/user/profile
// POST /api/user/avatar          ← 头像文件上传
//
// 🔒 头像安全加固：
//   - 扩展名 + MIME 双白名单校验
//   - 路径穿越防护（白名单前缀 /oss/avatars/）
//   - DB 失败时 rollback 已落盘文件（防孤儿）
//   - 旧头像统一走安全删除工具
//   - gif/webp 保留原格式（不强制转 jpg 丢动画）
// ============================================================================
import { Router } from 'express';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import Jimp from 'jimp';
import { requireAuth, ok, unauthorized, badRequest, log, serverError } from '../middleware/auth';
import { safeUser } from './auth';
import { getDataSource } from '../db-manager';
import { UserEntity } from '../entities';

const router = Router();

// — 头像常量 —
const AVATAR_SIZE = 256;
const AVATAR_QUALITY = 80;
const MAX_AVATAR_SIZE = 5 * 1024 * 1024; // 5MB（express-fileupload 已有，这里做双保险）
const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const IMG_PATH_PREFIX = '/oss/avatars/'; // 头像 URL 白名单前缀

// — 工具：从 avatar URL 拼磁盘绝对路径 + 安全删除 —
// 只允许 /oss/avatars/ 开头的 URL，防止 path.join('../') 穿越
function safeRemoveAvatarFile(avatarUrl?: string | null): void {
  if (!avatarUrl || typeof avatarUrl !== 'string') return;
  if (!avatarUrl.startsWith(IMG_PATH_PREFIX)) {
    log(`[avatar] 跳过删除（非白名单路径）: ${avatarUrl}`);
    return;
  }
  const diskPath = path.join(__dirname, '..', '..', avatarUrl);
  // 二次安全检查：解析后的绝对路径必须在 oss/avatars 目录内
  const resolved = path.resolve(diskPath);
  const allowedRoot = path.resolve(path.join(__dirname, '..', '..', 'oss', 'avatars'));
  if (!resolved.startsWith(allowedRoot + path.sep) && resolved !== allowedRoot) {
    log(`[avatar] 跳过删除（路径穿越）: ${avatarUrl}`);
    return;
  }
  if (existsSync(resolved)) {
    try {
      unlinkSync(resolved);
      log(`[avatar] 旧文件已删除: ${avatarUrl}`);
    } catch (e: any) {
      log(`[avatar] 删旧文件失败: ${e.message}`);
    }
  }
}

// 扩展名白名单 + 清洗：path.extname 拿不到时从 MIME 兜底
function sanitizeExt(rawName: string, mimetype?: string): string {
  let ext = path.extname(rawName).toLowerCase();
  if (!ext && mimetype) {
    const guess = '.' + mimetype.split('/').pop()?.split(';')[0];
    ext = guess.toLowerCase();
  }
  // 去空格、去引号，path.extname('a.jpg ') 拿到 '.jpg '
  ext = ext.trim().replace(/^['"]|['"]$/g, '');
  return ALLOWED_EXTS.includes(ext) ? ext : '';
}

// ============================================================================
// POST /avatar — 头像上传
//   1. 文件接收校验（大小 / 扩展名 / MIME）
//   2. Jimp 压缩（png→deflate, jpg/webp→quality 80, gif/bmp→保留原格式）
//   3. 落盘 /oss/avatars/{userId}_{ts}.{ext}
//   4. 更新 DB → 失败时 rollback 删除已落盘文件
//   5. 删旧头像（走 safeRemoveAvatarFile 防路径穿越）
// ============================================================================
router.post('/avatar', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const file = (req as any).files?.avatar;

  // —— 校验 1：文件是否存在 ——
  if (!file) {
    return badRequest(res, '未收到头像文件');
  }

  // —— 校验 2：大小（express-fileupload 5MB 已拦，这里做兜底）——
  if (file.size > MAX_AVATAR_SIZE) {
    return badRequest(res, '头像不能超过 5MB');
  }

  // —— 校验 3：扩展名白名单（P6 清洗）——
  const rawName = file.name || '';
  const ext = sanitizeExt(rawName, file.mimetype);
  if (!ext) {
    return badRequest(res, `头像格式不支持，允许: jpg/png/gif/webp/bmp`);
  }

  // —— 校验 4：MIME 必须是 image/*（客户端声明的，有条件信任）——
  if (file.mimetype && !file.mimetype.startsWith('image/')) {
    return badRequest(res, '仅支持图片格式');
  }

  // —— 压缩：Jimp cover 256x256 不变形 ——
  // gif/bmp：Jimp 可能不支持或会丢动画帧 → 保留原格式（P5）
  // 压缩失败（HEIC/svg 等）→ 直接存原图，但 SVG 会被 express.static 当静态资源服务
  //   → 后续在 index.ts express.static 对 svg 加 Content-Disposition: attachment 防 XSS（P4）
  let finalBuf: Buffer = file.data;
  let outputExt: string = ext;
  const isLossyFormat = ['.jpg', '.jpeg', '.webp'].includes(ext);

  if (ext !== '.gif' && ext !== '.bmp') {
    try {
      const img = await Jimp.read(file.data);
      const origW = img.bitmap.width;
      const origH = img.bitmap.height;
      img.cover({
        w: AVATAR_SIZE,
        h: AVATAR_SIZE,
        alignX: Jimp.HORIZONTAL_ALIGN_CENTER,
        alignY: Jimp.VERTICAL_ALIGN_MIDDLE,
      });
      if (ext === '.png') {
        img.deflateLevel(9);
        finalBuf = await img.getBufferAsync(Jimp.MIME_PNG);
        outputExt = '.png';
      } else {
        // jpg/webp：统一输出 jpg
        img.quality(AVATAR_QUALITY);
        finalBuf = await img.getBufferAsync(Jimp.MIME_JPEG);
        outputExt = '.jpg';
      }
      log(`avatar compress ${origW}x${origH} → ${AVATAR_SIZE}x${AVATAR_SIZE} ${outputExt} size=${finalBuf.length}B (orig=${file.size}B)`);
    } catch (e: any) {
      // HEIC 等 Jimp 解析不了 → 存原图
      log(`avatar compress failed (${e.message}), fallback original size=${file.size}B ext=${ext}`);
      finalBuf = file.data;
      outputExt = ext;
    }
  } else {
    // gif/bmp：不动压缩，直接存原图（避免 Jimp 丢动画帧）
    log(`avatar gif/bmp skip-compress ext=${ext} size=${file.size}B`);
  }

  // —— 落盘 ——
  const AVATAR_DIR = path.join(__dirname, '..', '..', 'oss', 'avatars');
  if (!existsSync(AVATAR_DIR)) mkdirSync(AVATAR_DIR, { recursive: true });
  const filename = `${userId}_${Date.now()}${outputExt}`;
  const savePath = path.join(AVATAR_DIR, filename);
  writeFileSync(savePath, finalBuf);

  const avatarUrl = `${IMG_PATH_PREFIX}${filename}`;

  // —— 更新 DB + 失败回滚（P3）——
  let dbUpdated = false;
  let oldAvatarUrl: string | null = null;

  try {
    const ds = getDataSource();
    if (ds && ds.isInitialized) {
      const repo = ds.getRepository(UserEntity);
      const user = await repo.findOne({ where: { id: userId } });
      if (user) {
        oldAvatarUrl = user.avatar || null;
        user.avatar = avatarUrl;
        user.updatedAt = new Date();
        await repo.save(user);
        dbUpdated = true;
        log(`avatar DB updated userId=${userId} → ${avatarUrl}`);
      } else {
        // 用户被删了？rollback 文件
        log(`[avatar] user ${userId} not found after upload, rollback file`);
        throw new Error('用户不存在');
      }
    } else {
      // mock db fallback（向后兼容）
      const { db } = await import('../db');
      const user = db.users.find((u: any) => u.id === userId);
      if (user) {
        oldAvatarUrl = user.avatar || null;
        user.avatar = avatarUrl;
        user.updatedAt = new Date();
        dbUpdated = true;
      } else {
        throw new Error('用户不存在');
      }
    }
  } catch (e: any) {
    // DB 更新失败 → rollback 已落盘文件（P3）
    log(`[avatar] DB save FAILED (${e.message}), rolling back file ${avatarUrl}`);
    try { unlinkSync(savePath); } catch { /* ignore */ }
    return serverError(res, `头像保存失败: ${e.message}`);
  }

  // DB 成功后再删旧头像（P1 + P2：走 safeRemoveAvatarFile 防路径穿越）
  if (dbUpdated && oldAvatarUrl) {
    safeRemoveAvatarFile(oldAvatarUrl);
  }

  ok(res, { avatar: avatarUrl }, '头像上传成功');
});

// ============================================================================
// GET /profile
// ============================================================================
router.get('/profile', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id: userId } });
    if (user) {
      return ok(res, safeUser(user));
    }
  }
  // fallback: mock db（向后兼容）
  const { db } = await import('../db');
  const user = db.users.find((u: any) => u.id === userId);
  if (!user) {
    return unauthorized(res, '账号不可用');
  }
  ok(res, safeUser(user));
});

// ============================================================================
// PUT /profile — 更新昵称/头像/角色
//   avatar 字符串更新：P1 已改为自动删旧头像 + P2 路径白名单校验
// ============================================================================
router.put('/profile', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const patch = req.body || {};

  const applyPatch = (user: any, isOrm: boolean) => {
    if (typeof patch.nickname === 'string' && patch.nickname.length <= 50) {
      user.nickname = patch.nickname;
    }
    if (typeof patch.avatar === 'string' && patch.avatar.length <= 500) {
      // P2: 只有白名单路径才允许覆盖（防止伪造路径）
      if (patch.avatar.startsWith(IMG_PATH_PREFIX)) {
        // P1: 覆盖头像前先删旧的（和 POST /avatar 统一走 safeRemoveAvatarFile）
        if (user.avatar) safeRemoveAvatarFile(user.avatar);
        user.avatar = patch.avatar;
      } else {
        log(`[update-profile] 拒绝非法 avatar 路径: ${patch.avatar}`);
      }
    }
    if (patch.role && ['consumer', 'designer', 'vendor', 'installer', 'admin'].includes(patch.role)) {
      user.role = patch.role;
    }
    if (isOrm) {
      user.updatedAt = new Date();
    } else {
      user.updatedAt = new Date().toISOString();
    }
  };

  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(UserEntity);
    const user = await repo.findOne({ where: { id: userId } });
    if (!user) {
      return unauthorized(res);
    }
    applyPatch(user, true);
    await repo.save(user);
    log(`update-profile userId=${userId}`);
    return ok(res, safeUser(user), '更新成功');
  }

  // fallback: mock db
  const { db } = await import('../db');
  const user = db.users.find((u: any) => u.id === userId);
  if (!user) {
    return unauthorized(res);
  }
  applyPatch(user, false);
  log(`update-profile userId=${userId}`);
  ok(res, safeUser(user), '更新成功');
});

export default router;
