// ============================================================================
// 📐 Design File Routes — 7 endpoint（API_CONTRACT.md §11）
// 11.1 POST   /api/design-file/presign-url    OSS 直传 presigned URL（mock 返回假 URL）
// 11.1b POST  /api/design-file/confirm-upload  上传后确认，保存元信息
// 11.2 GET    /api/design-file/:id             详情
// 11.3 POST   /api/design-file/:id/validate    服务端校验（模拟）
// 11.4 POST   /api/design-file/:id/new-version 创建新版本
// 11.5 GET    /api/design-file/:id/chain       版本链
// 11.6 GET    /api/design-file/active          活跃文件列表
// 11.7 DELETE /api/design-file/:id             删除整个版本链
// ============================================================================
import { Router } from 'express';
import sharp from 'sharp';
import { db } from '../db';
import { requireAuth, requireDesigner, ok, fail, badRequest, log } from '../middleware/auth';

const router = Router();

// ============================================================
// 🖼️ sharp 元数据解析工具
// 仅图片格式（png/jpg/webp/bmp/tiff）可解析；psd/ai/pdf/fig/sketch 等矢量/源文件
// sharp 不支持，会返回全部 0 —— 此时应 fallback 到前端传来的元数据
// ============================================================
async function parseImageMetadata(buffer: Buffer): Promise<{
  widthPx: number; heightPx: number; dpi?: number; colorSpace?: string; totalPx: number;
}> {
  try {
    const meta = await sharp(buffer).metadata();
    return {
      widthPx: meta.width || 0,
      heightPx: meta.height || 0,
      dpi: meta.density || undefined,
      colorSpace: meta.space?.toUpperCase() || undefined, // "srgb" → "SRGB"
      totalPx: (meta.width || 0) * (meta.height || 0),
    };
  } catch {
    // sharp 不支持的格式（psd/ai/pdf/fig/sketch 等）或损坏文件 → 返回空
    return { widthPx: 0, heightPx: 0, totalPx: 0 };
  }
}

const VALID_FORMATS = [
  'psd',
  'ai',
  'fig',
  'sketch',
  'cdr',
  'pdf',
  'eps',
  'svg',
  'bmp',
  'tiff',
  'tif',
  'jpg',
  'jpeg',
  'png',
  'webp',
];
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
// 全局兜底默认（Product 无 printStandard 时用）
const DEFAULT_PRINT_STD = {
  minDpi: 150,
  colorSpace: 'ANY' as const,
  minTotalPx: 250000,
};

function detectFormat(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return VALID_FORMATS.includes(ext) ? ext : 'unknown';
}

// — 11.1 POST /presign-url — 🔒 仅设计师
router.post('/presign-url', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const { fileName, fileSize, contentType } = req.body || {};
  if (!fileName) {
    return badRequest(res, 'fileName 必填');
  }
  const sizeNum = Number(fileSize);
  if (fileSize !== undefined && (isNaN(sizeNum) || sizeNum <= 0)) {
    return badRequest(res, 'fileSize 必须为正整数 (bytes)');
  }
  if (sizeNum > MAX_FILE_SIZE) {
    return badRequest(
      res,
      `文件大小超过 100MB 上限 (当前 ${(sizeNum / 1024 / 1024).toFixed(1)}MB)`,
    );
  }

  const format = detectFormat(fileName);
  if (format === 'unknown') {
    return badRequest(res, `不支持的文件格式，当前后端支持: ${VALID_FORMATS.join('/')}`);
  }
  const id = db.nextId('designFiles');
  const mockUploadUrl = `https://mock-oss.ljl-mall.com/designs/user_${userId}/${Date.now()}_${fileName}?mock-presigned=true`;

  ok(res, {
    fileId: id,
    uploadUrl: mockUploadUrl,
    // mock 场景下直接跳过 OSS 真上传，前端直接调 confirm-upload
    skipOss: true,
    format,
    suggestedFileName: `${userId}_${Date.now()}_${fileName}`,
  });
});

// — 11.1b POST /confirm-upload — 🔒 仅设计师
router.post('/confirm-upload', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const {
    fileId,
    fileName,
    fileSize,
    widthPx,
    heightPx,
    dpi,
    colorSpace,
    pages,
    layers,
    url,
    thumbnailUrl,
  } = req.body || {};

  const fid = Number(fileId);
  if (!fid) {
    return badRequest(res, 'fileId 必填');
  }

  // 二次校验 size 防御
  const confirmSize = Number(fileSize);
  if (confirmSize > MAX_FILE_SIZE) {
    return badRequest(res, `文件大小超过 100MB 上限`);
  }

  // ——— 🖼️ sharp 真实元数据解析（当前 mock OSS 模式暂未启用）———
  // TODO: OSS 接入后，改为 multipart 直传 express-fileupload 或 OSS postObject 回传 buffer，
  //       用 sharp 解析真实元数据覆盖前端传来的值：
  //   if (req.file?.buffer) {
  //     const realMeta = await parseImageMetadata(req.file.buffer);
  //     if (realMeta.widthPx > 0) widthPx = realMeta.widthPx;
  //     if (realMeta.heightPx > 0) heightPx = realMeta.heightPx;
  //     if (realMeta.dpi) dpi = realMeta.dpi;
  //     if (realMeta.colorSpace) colorSpace = realMeta.colorSpace;
  //   }
  // 当前 mock OSS 模式：继续使用前端传来的元数据（前端用 Image()/Taro.getImageInfo 解析）

  const existing = db.designFiles.find((f) => f.id === fid);
  if (existing) {
    // 已有 — 更新（new-version 流程复用）
    Object.assign(existing, {
      fileName: fileName || existing.fileName,
      fileSize: Number(fileSize) || existing.fileSize,
      widthPx: widthPx !== undefined ? Number(widthPx) : existing.widthPx,
      heightPx: heightPx !== undefined ? Number(heightPx) : existing.heightPx,
      dpi: dpi !== undefined ? Number(dpi) : existing.dpi,
      colorSpace: colorSpace || existing.colorSpace,
      pages: pages !== undefined ? Number(pages) : existing.pages,
      layers: layers !== undefined ? Number(layers) : existing.layers,
      url: url || existing.url,
      thumbnailUrl: thumbnailUrl || existing.thumbnailUrl,
      status: 'uploaded',
      updatedAt: new Date().toISOString(),
    });
    ok(res, existing);
    return;
  }

  const f: (typeof db.designFiles)[number] = {
    id: fid,
    userId,
    fileName: fileName || `file_${fid}`,
    originalName: fileName || `file_${fid}`,
    format: detectFormat(fileName || ''),
    fileSize: Number(fileSize) || 102400,
    url: url || `https://mock-oss.ljl-mall.com/designs/${userId}/${fid}.psd`,
    thumbnailUrl:
      thumbnailUrl || `https://mock-oss.ljl-mall.com/designs/${userId}/${fid}_thumb.png`,
    widthPx: widthPx ? Number(widthPx) : 2400,
    heightPx: heightPx ? Number(heightPx) : 3600,
    dpi: dpi ? Number(dpi) : 300,
    colorSpace: colorSpace || 'CMYK',
    pages: pages ? Number(pages) : 1,
    layers: layers ? Number(layers) : 10,
    version: 1,
    status: 'uploaded',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.designFiles.push(f);
  log(`design-file/confirm userId=${userId} id=${fid} format=${f.format}`);
  ok(res, f);
});

// — 11.6 GET /active — 🔒 仅设计师（必须在 /:id 之前，否则被 :id 吞掉）
router.get('/active', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const list = db.designFiles
    .filter((f) => f.userId === userId && f.status !== 'archived' && f.status !== 'uploading')
    .sort((a, b) => b.id - a.id);
  ok(res, list);
});

// — 11.2 GET /:id — 🔒 仅设计师
router.get('/:id', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const f = db.designFiles.find((x) => x.id === id);
  if (!f) {
    return fail(res, 404, '设计文件不存在', 404);
  }
  if (Number(f.userId) !== userId) {
    return fail(res, 403, '无权查看此设计文件', 403);
  }
  ok(res, f);
});

// — 11.3 POST /:id/validate — 🔒 仅设计师（只能校验自己的文件）
router.post('/:id/validate', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const f = db.designFiles.find((x) => x.id === id);
  if (!f) {
    return fail(res, 404, '设计文件不存在', 404);
  }
  if (Number(f.userId) !== userId) {
    return fail(res, 403, '无权校验此设计文件', 403);
  }

  // 根据文件的 productId 找到商品，读取其印刷标准；无则走全局默认
  const product = f.productId
    ? db.products.find((p) => p.id === f.productId && p.status === 1)
    : undefined;
  const pStd = product?.printStandard;
  const std = {
    minDpi: pStd?.minDpi ?? DEFAULT_PRINT_STD.minDpi,
    colorSpace: pStd?.colorSpace ?? DEFAULT_PRINT_STD.colorSpace,
    minTotalPx: pStd?.minTotalPx ?? DEFAULT_PRINT_STD.minTotalPx,
    allowedFormats: pStd?.allowedFormats ?? VALID_FORMATS,
  };
  const hasCustomStd = !!product?.printStandard;

  // 服务端校验 — 动态按商品标准（总分 100）
  const issues: any[] = [];
  let score = 100;

  // —— info 头：显示该商品标准（让用户知道系统为什么拦他）——
  const stdDesc: string[] = [];
  stdDesc.push(`DPI ≥ ${std.minDpi}`);
  if (std.colorSpace && std.colorSpace !== 'ANY') stdDesc.push(`色彩空间 ${std.colorSpace}`);
  if (std.minTotalPx) stdDesc.push(`像素 ≥ ${std.minTotalPx.toLocaleString()}`);
  issues.push({
    type: 'standard_info',
    level: 'info',
    message: hasCustomStd
      ? `【${product!.name}】印刷标准：${stdDesc.join(' / ')}`
      : `印刷标准（默认）：${stdDesc.join(' / ')}（未关联具体商品）`,
  });

  // 文件大小（后端防御性校验）
  if ((f.fileSize || 0) > MAX_FILE_SIZE) {
    issues.push({
      type: 'size_exceeded',
      message: `文件 ${((f.fileSize || 0) / 1024 / 1024).toFixed(1)}MB 超过 100MB`,
      level: 'error',
    });
    score -= 30;
  }

  // DPI（按商品标准动态校验）
  if (std.minDpi && (f.dpi || 0) < std.minDpi) {
    issues.push({
      type: 'dpi_low',
      message: `DPI ${f.dpi || '未知'} 低于该商品标准 ${std.minDpi}`,
      level: 'warning',
    });
    score -= 15;
  }

  // 色彩空间（ANY 表示宽松，CMYK 严格）
  if (std.colorSpace && std.colorSpace !== 'ANY' && f.colorSpace && f.colorSpace !== std.colorSpace) {
    const strict = std.colorSpace === 'CMYK';
    issues.push({
      type: 'color_space',
      message: `色彩空间 ${f.colorSpace}，该商品要求 ${std.colorSpace}`,
      level: strict ? 'warning' : 'info',
    });
    score -= strict ? 10 : 5;
  } else if (f.colorSpace && std.colorSpace === 'ANY') {
    issues.push({
      type: 'color_space',
      message: `色彩空间 ${f.colorSpace}，可接受（该商品 ANY 模式）`,
      level: 'info',
    });
  }

  // 总像素（按商品标准动态校验）
  const totalPx = (f.widthPx || 0) * (f.heightPx || 0);
  if (std.minTotalPx && totalPx > 0 && totalPx < std.minTotalPx) {
    issues.push({
      type: 'low_res',
      message: `分辨率过低（${f.widthPx}×${f.heightPx} = ${totalPx.toLocaleString()}px），该商品建议 ≥ ${std.minTotalPx.toLocaleString()}px`,
      level: 'warning',
    });
    score -= 10;
  } else if (totalPx > 0) {
    issues.push({
      type: 'print_size',
      level: 'info',
      message: `建议印刷尺寸: ${Math.round((f.widthPx! / (f.dpi || std.minDpi)) * 2.54)}×${Math.round((f.heightPx! / (f.dpi || std.minDpi)) * 2.54)}cm`,
    });
  }

  // 格式
  if (f.format === 'unknown') {
    issues.push({ type: 'format_unknown', message: '无法识别的文件格式', level: 'error' });
    score -= 40;
  } else if (!std.allowedFormats.includes(f.format)) {
    issues.push({
      type: 'format_not_allowed',
      message: `文件格式 ${f.format} 不在该商品允许列表中（${std.allowedFormats.join('/')}）`,
      level: 'warning',
    });
    score -= 10;
  }

  const validation = {
    passed: score >= 60,
    score: Math.max(0, score),
    issues,
    recommendTargetSize: f.dpi
      ? `${Math.round((f.widthPx! / f.dpi) * 2.54)}x${Math.round((f.heightPx! / f.dpi) * 2.54)}cm`
      : undefined,
    appliedStandard: {
      productId: product?.id,
      productName: product?.name,
      hasCustom: hasCustomStd,
      minDpi: std.minDpi,
      colorSpace: std.colorSpace,
      minTotalPx: std.minTotalPx,
    },
  };

  f.validation = validation;
  f.status = validation.passed ? 'valid' : score < 30 ? 'rejected' : 'warning';
  f.updatedAt = new Date().toISOString();

  log(`design-file/validate id=${id} productId=${f.productId || 'none'} score=${validation.score}`);
  ok(res, validation);
});

// — 11.4 POST /:id/new-version — 🔒 仅设计师
router.post('/:id/new-version', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const f = db.designFiles.find((x) => x.id === id && x.userId === userId);
  if (!f) {
    return fail(res, 404, '设计文件不存在', 404);
  }

  const { fileName, fileSize, widthPx, heightPx, dpi, colorSpace, url, thumbnailUrl } =
    req.body || {};

  // 归档旧版本（strip validation 省空间）
  const archivedVersion = f.version;
  f.status = 'archived';
  f.validation = undefined;
  f.updatedAt = new Date().toISOString();

  // 创建新版本
  const newVersion: (typeof db.designFiles)[number] = {
    id: db.nextId('designFiles'),
    userId,
    fileName: fileName || f.fileName,
    originalName: fileName || f.originalName,
    format: detectFormat(fileName || f.fileName),
    fileSize: Number(fileSize) || f.fileSize,
    url: url || f.url,
    thumbnailUrl: thumbnailUrl || f.thumbnailUrl,
    widthPx: widthPx ? Number(widthPx) : f.widthPx,
    heightPx: heightPx ? Number(heightPx) : f.heightPx,
    dpi: dpi ? Number(dpi) : f.dpi,
    colorSpace: colorSpace || f.colorSpace,
    pages: f.pages,
    layers: f.layers,
    version: archivedVersion + 1,
    parentId: f.id,
    status: 'uploaded',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.designFiles.push(newVersion);

  log(`design-file/new-version parent=${id} newId=${newVersion.id} v${newVersion.version}`);
  ok(res, newVersion);
});

// — 11.5 GET /:id/chain — 🔒 仅设计师
router.get('/:id/chain', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  // 先确认该文件归属当前用户（防御纵深）
  const ownerFile = db.designFiles.find((f) => f.id === id);
  if (!ownerFile) {
    return fail(res, 404, '设计文件不存在', 404);
  }
  if (Number(ownerFile.userId) !== userId) {
    return fail(res, 403, '无权查看此设计文件的版本链', 403);
  }
  const all = db.designFiles.filter((f) => f.userId === userId);

  // 找出 id 本身 + parentId === id 的版本
  const versionChain = all
    .filter((f) => {
      // 反向：谁的 parentId 等于 id？（id 可能是历史版本，也可能是新版本）
      const parentMatches = f.parentId === id;
      const idMatches = f.id === id;
      return parentMatches || idMatches;
    })
    .sort((a, b) => b.version - a.version);

  if (versionChain.length === 0) {
    return fail(res, 404, '版本链不存在', 404);
  }

  ok(res, {
    current: versionChain[0],
    versions: versionChain,
  });
});

// — 11.7 DELETE /:id — 🔒 仅设计师
router.delete('/:id', requireAuth, requireDesigner, (req, res) => {
  const userId = (req as any).userId;
  const id = Number(req.params.id);
  const f = db.designFiles.find((x) => x.id === id && x.userId === userId);
  if (!f) {
    return fail(res, 404, '设计文件不存在', 404);
  }

  // 删 id 本身 + 所有 parentId === id + id === parentId 的版本
  const toDelete = new Set<number>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    if (toDelete.has(cur)) {
      continue;
    }
    toDelete.add(cur);
    db.designFiles
      .filter((x) => x.userId === userId && x.parentId === cur)
      .forEach((x) => queue.push(x.id));
    const parent = db.designFiles.find((x) => x.id === cur && x.parentId);
    if (parent) {
      queue.push(parent.parentId!);
    }
  }

  db.designFiles = db.designFiles.filter((x) => !toDelete.has(x.id));
  log(`design-file/delete userId=${userId} ids=[${[...toDelete].join(',')}]`);
  ok(res, { success: true, deletedCount: toDelete.size });
});

export default router;
