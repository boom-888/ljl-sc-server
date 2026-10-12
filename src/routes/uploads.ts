// ============================================================================
// 📤 Upload Routes — 通用文件上传（所有已登录用户可用，不限角色）
// 存储: server/oss/{userId}/{YYYYMMDD}/{timestamp}_{随机}.{ext}
// 访问: http://host:3001/oss/{userId}/{YYYYMMDD}/xxx.jpg（express.static 已挂载）
// ============================================================================
import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth, ok, badRequest, log } from '../middleware/auth';

const router = Router();

const ALLOWED_EXT = [
  // 图片
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'svg', 'heic',
  // 设计源文件
  'psd', 'ai', 'fig', 'sketch', 'cdr', 'pdf', 'eps',
  // 视频（可选，后续扩展）
  'mp4', 'mov',
];
const MAX_SIZE = 200 * 1024 * 1024; // 200MB（头像 5MB，设计文件 100MB，留有余量）

// POST /api/uploads — multipart 单文件上传（field name 任意，取 req.files 第一个）
router.post('/', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const files: any = (req as any).files;

  if (!files || Object.keys(files).length === 0) {
    return badRequest(res, '未收到文件');
  }

  // express-fileupload: req.files 可能是 { file: {...} } 或直接数组
  const firstKey = Object.keys(files)[0];
  const file: any = Array.isArray(files[firstKey]) ? files[firstKey][0] : files[firstKey];

  if (!file || !file.data) {
    return badRequest(res, '文件为空');
  }
  if (file.size > MAX_SIZE) {
    return badRequest(res, `文件超过 ${Math.round(MAX_SIZE / 1024 / 1024)}MB 上限`);
  }

  // 校验扩展名
  const originalName = file.name || `file_${Date.now()}`;
  const ext = (path.extname(originalName) || '').toLowerCase().replace('.', '');
  const safeExt = ALLOWED_EXT.includes(ext) ? ext : 'bin';

  // 组装路径
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  const random = Math.random().toString(36).slice(2, 8);
  const safeName = `${Date.now()}_${random}.${safeExt}`;
  const relPath = `${userId}/${dateStr}/${safeName}`;
  const fullPath = path.join(__dirname, '..', '..', 'oss', relPath);

  try {
    // 确保目录存在 — 写到 server/oss/{userId}/...（和 index.ts express.static 挂载路径一致）
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    // 写文件
    fs.writeFileSync(fullPath, file.data);
  } catch (e: any) {
    log(`[uploads] write error: ${e.message}`, 'error');
    return res.status(500).json({ code: 500, msg: '文件写入失败' });
  }

  // 返回可访问 URL（前端直接用 /oss/... 拼当前 host 即可）
  const url = `/oss/${relPath}`;
  log(`[uploads] userId=${userId} file=${originalName} → ${url} (${file.size} bytes)`);

  ok(res, {
    url,
    filename: originalName,
    savedName: safeName,
    size: file.size,
    mimetype: file.mimetype || 'application/octet-stream',
    ext: safeExt,
  });
});

// POST /api/uploads/multi — 多文件上传（数组，最多 6 个）
router.post('/multi', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const files: any = (req as any).files;
  if (!files) return badRequest(res, '未收到文件');

  // 收集所有文件
  const all: any[] = [];
  for (const key of Object.keys(files)) {
    const arr = Array.isArray(files[key]) ? files[key] : [files[key]];
    all.push(...arr);
  }
  if (all.length === 0) return badRequest(res, '未收到文件');
  if (all.length > 6) return badRequest(res, '单次最多 6 个文件');

  const results: any[] = [];
  for (const f of all) {
    if (f.size > MAX_SIZE) {
      results.push({ error: `文件 ${f.name} 超过上限`, name: f.name });
      continue;
    }
    const ext = (path.extname(f.name) || '').toLowerCase().replace('.', '');
    const safeExt = ALLOWED_EXT.includes(ext) ? ext : 'bin';
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    const random = Math.random().toString(36).slice(2, 8);
    const safeName = `${Date.now()}_${random}.${safeExt}`;
    const relPath = `${userId}/${dateStr}/${safeName}`;
    const fullPath = path.join(__dirname, '..', 'oss', relPath);
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, f.data);
      results.push({
        url: `/oss/${relPath}`,
        filename: f.name,
        size: f.size,
        ext: safeExt,
      });
    } catch (e: any) {
      results.push({ error: String((e as any).message), name: f.name });
    }
  }
  ok(res, { count: results.length, list: results });
});

// DELETE /api/uploads?url=/oss/user/xxx.jpg — 删除自己的文件（简单实现，路径校验归属）
router.delete('/', requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const url = String((req.query as any).url || '');
  if (!url.startsWith('/oss/')) return badRequest(res, 'url 必须以 /oss/ 开头');

  // 安全校验：只能删自己目录下的
  const parts = url.replace(/^\/oss\//, '').split('/');
  if (parts[0] !== String(userId)) {
    return res.status(403).json({ code: 403, msg: '无权删除他人文件' });
  }
  const fullPath = path.join(__dirname, '..', '..', 'oss', ...parts);
  try {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      ok(res, { deleted: true });
    } else {
      ok(res, { deleted: false, reason: '文件不存在' });
    }
  } catch (e: any) {
    res.status(500).json({ code: 500, msg: '删除失败: ' + e.message });
  }
});

export default router;
