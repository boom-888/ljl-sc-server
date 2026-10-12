// ============================================================================
// 🏠 Home Routes — 7 endpoint（公开接口，不需要鉴权）
// GET /api/home/config         首页配置聚合
// GET /api/products           商品列表（分页 + 过滤 + 搜索）
// GET /api/products/:id       商品详情
// GET /api/product/adaptable  可做设计适配的商品（筛 print-capable 分类）
// GET /api/categories         分类列表
// GET /api/search/hot         搜索热词
// GET /api/search/suggest     搜索建议
// ============================================================================
import { Router } from 'express';
import {
  getBannersORM,
  getCategoryTreeORM,
  getProductsORM,
  getProductByIdORM,
  getSearchKeywordsORM,
  getNewArrivalsORM,
} from '../db-orm';
import { ok, badRequest, notFound, log } from '../middleware/auth';
import { getCache } from '../services/cache-manager';

const router = Router();

// — 1.1 home/config（⚠️ 热点接口，加 60s 缓存 → autocannon 290→2800+ QPS）—
router.get('/home/config', async (_req, res) => {
  try {
    const cached = await getCache().get('home:config');
    if (cached) {
      res.send(cached);
      return;
    } // 缓存已存完整 {code,data,msg} 格式
  } catch {}

  const [banners, categories, newArrivals] = await Promise.all([
    getBannersORM(),
    getCategoryTreeORM(),
    getNewArrivalsORM(6),
  ]);
  const data = {
    banners,
    categories,
    designEntry: {
      title: '找人设计',
      subtitle: '专业设计师 免费报价',
      image: '',
      gradient: 'linear-gradient(135deg,#667EEA,#764BA2)',
    },
    serviceBar: [
      { id: 's1', icon: 'check-circle', label: '品质保障', value: '正品保证' },
      { id: 's2', icon: 'shield', label: '安全支付', value: '交易安全' },
      { id: 's3', icon: 'wallet', label: '7天无理由', value: '退换货' },
      { id: 's4', icon: 'clock', label: '极速发货', value: '当日发出' },
    ],
    newArrivals,
  };

  const fullResp = { code: 0, data, msg: 'ok' };
  try {
    await getCache().set('home:config', JSON.stringify(fullResp), 60);
  } catch {}
  ok(res, data);
});

// — 1.2 products (list)（⚠️ 热点，15s 缓存，按 page+category+productType 细粒度）—
router.get('/products', async (req, res) => {
  const { categoryId, keyword, page = '1', pageSize = '10', productType } = req.query as any;
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 10));

  const cid =
    categoryId && Number.isFinite(parseInt(categoryId, 10)) ? parseInt(categoryId, 10) : undefined;
  const kw = keyword ? String(keyword).trim() : undefined;
  // productType 白名单校验，非法值丢弃
  const pt = (productType && ['ready', 'custom', 'combo'].includes(String(productType)))
    ? String(productType)
    : undefined;
  const cacheKey = `products:${cid || 'all'}:${kw || 'all'}:${pt || 'all'}:${p}:${ps}`;

  // 关键词搜索不走缓存（实时性要求）
  if (!kw) {
    try {
      const cached = await getCache().get(cacheKey);
      if (cached) {
        res.type('json').send(cached);
        return;
      }
    } catch {}
  }

  const result = await getProductsORM({ categoryId: cid, keyword: kw, productType: pt, page: p, pageSize: ps });
  log(
    `products query categoryId=${cid || '-'} keyword=${kw || '-'} productType=${pt || '-'} page=${p} pageSize=${ps} total=${result.total}`,
  );

  // 🆕 给每个商品追加固定质保标签（与 products/:id 一致）
  const GT = ['正品保障', '7天无理由', '包邮上门'];
  if (Array.isArray(result.list)) {
    result.list = result.list.map((item: any) => ({ ...item, guaranteeTags: GT }));
  }

  if (!kw) {
    try {
      await getCache().set(cacheKey, JSON.stringify({ code: 0, data: result, msg: 'ok' }), 15);
    } catch {}
  }
  ok(res, result);
});

// — 1.3 products/:id —
router.get('/products/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || !Number.isFinite(id)) {
    return badRequest(res, '商品 ID 格式错误');
  }
  const p = await getProductByIdORM(id);
  if (!p) {
    return notFound(res, '商品不存在');
  }
  // 商品天然质保标签（所有商品默认带，与师傅/设计 guaranteeTags 逻辑解耦）
  const guaranteeTags = ['正品保障', '7天无理由', '包邮上门'];
  ok(res, { ...p, guaranteeTags });
});

// — 1.9 product/adaptable — 可做设计适配的商品（筛 print-capable 分类）—
// 前端 design-file.ts → getAdaptableProducts() 期望 AdaptableProduct[]
// ProductEntity 无 printCapable 字段 → 用 category 名称 + product name 尺寸解析
router.get('/product/adaptable', async (_req, res) => {
  try {
    // 一级分类：这些分类下的全部商品默认可做设计适配
    const ADAPTABLE_L1_NAMES = ['喷绘制作', '写真制作', '展示器材', '展板制作'];
    // 额外纳入的 L2 子分类（跨 L1，目前是「材料销售」下的 KT板 / 亚克力板）
    const EXTRA_ADAPTABLE_L2 = new Set(['KT板', '亚克力板']);
    // 尺寸解析：从 product name 中提取 "W×Hcm" 模式
    const parseCm = (name: string): { w: number; h: number } | null => {
      const m = name.match(/(\d+(?:\.\d+)?)\s*[×xX*]\s*(\d+(?:\.\d+)?)/);
      if (!m) return null;
      return { w: parseFloat(m[1]), h: parseFloat(m[2]) };
    };
    // 按 L1 分类映射到前端显示分类 + categoryId key
    const resolveDisplay = (l1Name: string, l2Name: string): { category: string; categoryId: string } => {
      if (l1Name === '喷绘制作' || l1Name === '写真制作') return { category: '户外喷绘', categoryId: 'banner' };
      if (l1Name === '展示器材') return { category: '易拉宝', categoryId: 'rollup' };
      if (l1Name === '展板制作') {
        return l2Name.includes('亚克力')
          ? { category: '亚克力', categoryId: 'acrylic' }
          : { category: 'KT板', categoryId: 'kt' };
      }
      if (l1Name === '材料销售') {
        if (l2Name === '亚克力板') return { category: '亚克力', categoryId: 'acrylic' };
        return { category: 'KT板', categoryId: 'kt' };
      }
      return { category: l1Name || l2Name || '其他', categoryId: 'kt' };
    };

    const ds = (await import('../db-manager')).getDataSource();
    const { CategoryEntity, ProductEntity } = await import('../entities');

    let result: any[] = [];

    if (ds && ds.isInitialized) {
      // —— TypeORM 路径 ——
      const allCats = await ds.getRepository(CategoryEntity).find({ where: { status: 1 } });
      // 建立 id→cat 索引 + parentId→L1 映射
      const catById = new Map<number, any>();
      const l1ByL2Id = new Map<number, any>();
      for (const c of allCats) {
        catById.set(c.id, c);
        if (c.parentId) l1ByL2Id.set(c.id, catById.get(c.parentId));
      }
      // 收集可适配的 categoryId
      const adaptableCatIds = new Set<number>();
      for (const c of allCats) {
        if (!c.parentId) {
          if (ADAPTABLE_L1_NAMES.includes(c.name)) adaptableCatIds.add(c.id);
        } else {
          const l1 = l1ByL2Id.get(c.id);
          if (l1 && ADAPTABLE_L1_NAMES.includes(l1.name)) adaptableCatIds.add(c.id);
          if (EXTRA_ADAPTABLE_L2.has(c.name)) adaptableCatIds.add(c.id);
        }
      }

      const products = await ds.getRepository(ProductEntity)
        .createQueryBuilder('p')
        .where('p.status = 1')
        .andWhere('p.categoryId IN (:...cids)', { cids: [...adaptableCatIds] })
        .orderBy('p.sort', 'ASC')
        .addOrderBy('p.sales', 'DESC')
        .getMany();

      result = products.map((p: any) => {
        const cat = catById.get(p.categoryId);
        const l1 = cat?.parentId ? l1ByL2Id.get(cat.id) : cat;
        const { category, categoryId } = resolveDisplay(l1?.name || '', cat?.name || '');
        const size = parseCm(p.name);
        return {
          id: String(p.id),
          name: p.name,
          cover: p.cover || '',
          category,
          categoryId,
          widthCm: size?.w || 60,
          heightCm: size?.h || 40,
          price: Number(p.price) || 0,
        };
      });
    } else {
      // —— 内存 fallback ——
      const { db } = await import('../db');
      const catById = new Map<number, any>();
      const l1ByL2Id = new Map<number, any>();
      for (const c of db.categories) {
        catById.set(c.id, c);
        if (c.parentId) l1ByL2Id.set(c.id, catById.get(c.parentId));
      }
      const adaptableCatIds = new Set<number>();
      for (const c of db.categories) {
        if (!c.parentId) {
          if (ADAPTABLE_L1_NAMES.includes(c.name)) adaptableCatIds.add(c.id);
        } else {
          const l1 = l1ByL2Id.get(c.id);
          if (l1 && ADAPTABLE_L1_NAMES.includes(l1.name)) adaptableCatIds.add(c.id);
          if (EXTRA_ADAPTABLE_L2.has(c.name)) adaptableCatIds.add(c.id);
        }
      }
      result = db.products
        .filter((p: any) => p.status === 1 && p.categoryId && adaptableCatIds.has(p.categoryId))
        .map((p: any) => {
          const cat = catById.get(p.categoryId);
          const l1 = cat?.parentId ? l1ByL2Id.get(cat.id) : cat;
          const { category, categoryId } = resolveDisplay(l1?.name || '', cat?.name || '');
          const size = parseCm(p.name);
          return {
            id: String(p.id),
            name: p.name,
            cover: p.cover || '',
            category,
            categoryId,
            widthCm: size?.w || 60,
            heightCm: size?.h || 40,
            price: Number(p.price) || 0,
          };
        });
    }

    ok(res, result);
  } catch (e: any) {
    log(`[home] product/adaptable error: ${e?.message || e}`);
    badRequest(res, '服务暂时不可用');
  }
});

// — 1.4 categories — 全量树形
router.get('/categories', async (_req, res) => {
  ok(res, await getCategoryTreeORM());
});

// — 公开 banners（Sprint 14：前端首页 banner 根路径）—
router.get('/banners', async (_req, res) => {
  ok(res, await getBannersORM());
});

// — 1.5 search/hot —
router.get('/search/hot', async (_req, res) => {
  ok(res, await getSearchKeywordsORM());
});

// — 1.6 search/suggest —
router.get('/search/suggest', async (req, res) => {
  const { keyword } = req.query as any;
  if (!keyword || typeof keyword !== 'string') {
    return badRequest(res, '关键词不能为空');
  }
  const kw = keyword.trim().toLowerCase();
  if (!kw) {
    return badRequest(res, '关键词不能为空');
  }

  const hotAll = await getSearchKeywordsORM();
  const hot = hotAll.filter((k) => k.toLowerCase().includes(kw));
  const suggestions = [`${kw}大全`, `${kw}品牌`, `${kw}安装`]
    .filter((s) => !hot.includes(s))
    .slice(0, 3);
  ok(res, [...hot, ...suggestions]);
});

// — 1.7 cities（公开，不需要登录。前端 city 页 mount 时调）—
const HOT_CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '西安', '南京', '重庆'];
const PROVINCES = [
  { name: '直辖市', cities: ['北京', '上海', '天津', '重庆'] },
  { name: '广东', cities: ['广州', '深圳', '东莞', '佛山', '珠海', '中山', '惠州'] },
  { name: '浙江', cities: ['杭州', '宁波', '温州', '嘉兴', '绍兴'] },
  { name: '江苏', cities: ['南京', '苏州', '无锡', '常州', '南通'] },
  { name: '四川', cities: ['成都', '绵阳', '德阳'] },
  { name: '湖北', cities: ['武汉', '宜昌', '襄阳'] },
  { name: '福建', cities: ['厦门', '福州', '泉州'] },
  { name: '山东', cities: ['济南', '青岛', '烟台', '威海'] },
  { name: '陕西', cities: ['西安', '咸阳', '宝鸡'] },
];
router.get('/cities', async (_req, res) => {
  // needAuth=false — 公开接口，前端 city 页 mount 时裸调
  try {
    const { getDataSource } = await import('../db-manager');
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) {
      return ok(res, { hotCities: HOT_CITIES, provinces: PROVINCES });
    }
    const { ProvinceEntity, CityEntity } = await import('../entities');
    const cityRepo = ds.getRepository(CityEntity);
    const provRepo = ds.getRepository(ProvinceEntity);
    const [hotCitiesAll, provinces, citiesAll] = await Promise.all([
      cityRepo.find({ where: { isHot: 1 }, order: { name: 'ASC' } }),
      provRepo.find({ order: { code: 'ASC' } }),
      cityRepo.find(),
    ]);
    const hotCities = hotCitiesAll.slice(0, 10).map((c: any) => c.name);
    const provinceMap = provinces.map((p: any) => ({
      name: p.name,
      cities: citiesAll
        .filter((c: any) => c.provinceCode === p.code)
        .map((c: any) => c.name),
    })).filter((p: any) => p.cities.length > 0);
    ok(res, { hotCities, provinces: provinceMap });
  } catch (e: any) {
    log(`[home] cities ORM fallback: ${e.message}`, 'warn');
    ok(res, { hotCities: HOT_CITIES, provinces: PROVINCES });
  }
});

// ============================================================================
// 🗺️ Sprint 12 新增：行政区划公开 API（前端 Picker 级联选择器用，全部免鉴权）
// — Mock fallback 常量（种子未灌时用）—
const MOCK_PROVINCES_AREAS = [
  { code: '11', name: '北京市' }, { code: '12', name: '天津市' },
  { code: '31', name: '上海市' }, { code: '50', name: '重庆市' },
  { code: '44', name: '广东省' }, { code: '33', name: '浙江省' },
  { code: '32', name: '江苏省' }, { code: '51', name: '四川省' },
  { code: '42', name: '湖北省' }, { code: '35', name: '福建省' },
  { code: '37', name: '山东省' }, { code: '61', name: '陕西省' },
];
const MOCK_CITIES_MAP: Record<string, Array<{ code: string; name: string; isHot: number }>> = {
  '11': [{ code: '1101', name: '北京市', isHot: 1 }],
  '12': [{ code: '1201', name: '天津市', isHot: 1 }],
  '31': [{ code: '3101', name: '上海市', isHot: 1 }],
  '50': [{ code: '5001', name: '重庆市', isHot: 1 }],
  '44': [
    { code: '4401', name: '广州市', isHot: 1 }, { code: '4403', name: '深圳市', isHot: 1 },
    { code: '4419', name: '东莞市', isHot: 0 }, { code: '4406', name: '佛山市', isHot: 0 },
  ],
  '33': [
    { code: '3301', name: '杭州市', isHot: 1 }, { code: '3302', name: '宁波市', isHot: 1 },
  ],
  '32': [{ code: '3201', name: '南京市', isHot: 1 }, { code: '3205', name: '苏州市', isHot: 1 }],
  '51': [{ code: '5101', name: '成都市', isHot: 1 }],
  '42': [{ code: '4201', name: '武汉市', isHot: 1 }],
  '35': [{ code: '3502', name: '厦门市', isHot: 1 }, { code: '3501', name: '福州市', isHot: 0 }],
  '37': [{ code: '3701', name: '济南市', isHot: 0 }, { code: '3702', name: '青岛市', isHot: 1 }],
  '61': [{ code: '6101', name: '西安市', isHot: 1 }],
};
const MOCK_DISTRICTS_MAP: Record<string, Array<{ code: string; name: string }>> = {
  '3101': [
    { code: '310101', name: '黄浦区' }, { code: '310104', name: '徐汇区' },
    { code: '310105', name: '长宁区' }, { code: '310115', name: '浦东新区' },
    { code: '310106', name: '静安区' }, { code: '310109', name: '虹口区' },
    { code: '310110', name: '杨浦区' }, { code: '310114', name: '嘉定区' },
  ],
  '1101': [
    { code: '110101', name: '东城区' }, { code: '110105', name: '朝阳区' },
    { code: '110106', name: '丰台区' }, { code: '110108', name: '海淀区' },
  ],
  '4403': [
    { code: '440304', name: '福田区' }, { code: '440305', name: '南山区' },
    { code: '440306', name: '宝安区' }, { code: '440308', name: '盐田区' },
  ],
  '4401': [
    { code: '440103', name: '荔湾区' }, { code: '440104', name: '越秀区' },
    { code: '440105', name: '海珠区' }, { code: '440106', name: '天河区' },
  ],
  '3301': [
    { code: '330102', name: '上城区' }, { code: '330105', name: '拱墅区' },
    { code: '330106', name: '西湖区' }, { code: '330108', name: '滨江区' },
  ],
  '5101': [
    { code: '510104', name: '锦江区' }, { code: '510105', name: '青羊区' },
    { code: '510106', name: '金牛区' }, { code: '510107', name: '武侯区' },
    { code: '510108', name: '成华区' },
  ],
  '6101': [
    { code: '610102', name: '新城区' }, { code: '610103', name: '碑林区' },
    { code: '610104', name: '莲湖区' }, { code: '610112', name: '未央区' },
    { code: '610113', name: '雁塔区' }, { code: '610114', name: '阎良区' },
  ],
};

/** GET /api/areas/provinces — 全量省列表 */
router.get('/areas/provinces', async (_req, res) => {
  try {
    const { getDataSource } = await import('../db-manager');
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) return ok(res, { list: MOCK_PROVINCES_AREAS });
    const { ProvinceEntity } = await import('../entities');
    const list = await ds.getRepository(ProvinceEntity).find({ order: { code: 'ASC' } });
    if (list.length === 0) return ok(res, { list: MOCK_PROVINCES_AREAS });
    ok(res, { list });
  } catch (e: any) { log(`[home] areas provinces error: ${e.message}`, 'warn'); ok(res, { list: MOCK_PROVINCES_AREAS }); }
});

/** GET /api/areas/cities?provinceCode=XX — 指定省的市列表 */
router.get('/areas/cities', async (req, res) => {
  const provinceCode = String((req.query as any).provinceCode || '');
  if (!provinceCode) return badRequest(res, 'provinceCode 必填');
  try {
    const { getDataSource } = await import('../db-manager');
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) return ok(res, { list: MOCK_CITIES_MAP[provinceCode] || [] });
    const { CityEntity } = await import('../entities');
    const list = await ds.getRepository(CityEntity).find({
      where: { provinceCode },
      order: { isHot: 'DESC', name: 'ASC' },
    });
    if (list.length === 0) return ok(res, { list: MOCK_CITIES_MAP[provinceCode] || [] });
    ok(res, { list });
  } catch (e: any) { log(`[home] areas cities error: ${e.message}`, 'warn'); ok(res, { list: MOCK_CITIES_MAP[provinceCode] || [] }); }
});

/** GET /api/areas/districts?cityCode=XXXX — 指定市的区列表 */
router.get('/areas/districts', async (req, res) => {
  const cityCode = String((req.query as any).cityCode || '');
  if (!cityCode) return badRequest(res, 'cityCode 必填');
  try {
    const { getDataSource } = await import('../db-manager');
    const ds = getDataSource();
    if (!ds || !ds.isInitialized) return ok(res, { list: MOCK_DISTRICTS_MAP[cityCode] || [] });
    const { DistrictEntity } = await import('../entities');
    const list = await ds.getRepository(DistrictEntity).find({
      where: { cityCode },
      order: { name: 'ASC' },
    });
    if (list.length === 0) return ok(res, { list: MOCK_DISTRICTS_MAP[cityCode] || [] });
    ok(res, { list });
  } catch (e: any) { log(`[home] areas districts error: ${e.message}`, 'warn'); ok(res, { list: MOCK_DISTRICTS_MAP[cityCode] || [] }); }
});

// ============================================================================
// 📦 Sprint 10 新增：快递相关公开接口（前端发货页 + admin 选择器用）
// ============================================================================

/** GET /api/express-companies — 启用中的快递公司列表（公开，vendor 发货页下拉）*/
router.get('/express-companies', async (_req, res) => {
  try {
    const ds = (await import('../db-manager')).getDataSource();
    if (!ds || !ds.isInitialized) return ok(res, []);
    const { ExpressCompanyEntity } = await import('../entities');
    const repo = ds.getRepository(ExpressCompanyEntity);
    const list = await repo.createQueryBuilder('e')
      .where('e.enabled = 1')
      .orderBy('e.sort', 'ASC')
      .addOrderBy('e.id', 'ASC')
      .getMany();
    // 不暴露 apiKey/apiAccount 给前端
    const safe = list.map((e: any) => ({
      id: e.id, code: e.code, name: e.name,
      defaultTrackingUrl: e.defaultTrackingUrl,
    }));
    ok(res, safe);
  } catch (e: any) { ok(res, []); }
});

// — 1.8 delivery/check（公开，C 端订单确认页用，检查配送覆盖情况）—
router.get('/delivery/check', async (req, res) => {
  const { vendorId, province, city, district, total } = req.query as any;

  if (!province || !city) {
    return badRequest(res, 'province 和 city 必填');
  }

  const isPlatformFallback = !vendorId;
  let covered = true; // 平台自营默认兜底
  let shippingType = 'express';
  let message = '';

  if (!isPlatformFallback) {
    try {
      const ds = (await import('../db-manager')).getDataSource();
      if (ds && ds.isInitialized) {
        const { VendorZonePermissionEntity } = await import('../entities');
        const repo = ds.getRepository(VendorZonePermissionEntity);
        const zps = await repo
          .createQueryBuilder('z')
          .where('z.vendorId = :v AND z.enabled = 1 AND z.status = :s', { v: Number(vendorId), s: 'active' })
          .andWhere('z.province = :p AND z.city = :c', { p: String(province).trim(), c: String(city).trim() })
          .getMany();

        if (!zps || zps.length === 0) {
          covered = false;
          shippingType = 'express'; // 没开县区权限 → 走快递 fallback
          message = '该供应商暂未在本市区开通配送，将使用快递发货';
        } else {
          // 命中至少一个县区权限
          covered = true;
          const matched = district ? zps.find((z) => z.district === String(district).trim()) : zps[0];
          shippingType = matched ? 'self_delivery' : 'express';
          if (!matched) {
            message = '该供应商在本市区未覆盖此县区，将使用快递发货';
          }
        }
      }
    } catch (e: any) {
      log(`delivery/check error: ${e?.message || e}`);
      covered = false;
    }
  }

  ok(res, {
    covered,
    shippingFee: 0, // ✅ 运费全含在商品价里
    isFreeShipping: true,
    freeShippingMin: 0,
    gapToFree: 0,
    shippingType,
    deliveryHours: '48小时内发出',
    platformFallback: isPlatformFallback,
    ...(message ? { message } : {}),
  });
});

export default router;
