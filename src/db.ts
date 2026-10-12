// ============================================================================
// 💾 内存存储 + TypeORM MySQL 双写代理
// 当 MYSQL_* 环境变量配置时，seed() 同时写入 MySQL 表；
// 路由层暂用内存数组（同步），后续渐进式迁移到 getRepo().
// ============================================================================
import bcrypt from 'bcryptjs';
import { getDataSource } from './db-manager';
import { log } from './logger';
import {
  UserEntity,
  SessionEntity,
  SmsCodeEntity,
  CategoryEntity,
  ProductEntity,
  BannerEntity,
  SearchKeywordEntity,
  AddressEntity,
  DesignDemandEntity,
  DesignOrderEntity,
  InstallationDemandEntity,
  InstallationOrderEntity,
  MasterOrderEntity,
  OrderEntity,
} from './entities';

export interface User {
  id: number;
  phone: string;
  nickname?: string;
  passwordHash?: string;
  avatar?: string;
  role:
    | 'consumer'
    | 'designer'
    | 'vendor'
    | 'installer'
    | 'admin'
    | 'pending_vendor'
    | 'pending_designer'
    | 'pending_installer';
  level: number;
  points: number;
  wallet: number;
  coupons: number;
  status: number; // 1=正常 0=禁用
  /** 配送覆盖区域（仅 role='vendor' 生效） */
  serviceAreas?: Array<{ province: string; city: string; district?: string | null }>;
  /** 门店经度 */
  serviceLng?: number | null;
  /** 门店纬度 */
  serviceLat?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: number;
  userId: number;
  token: string;
  createdAt: number; // ms timestamp
  expiresAt: number;
}

export interface ProductPrintStandard {
  minDpi?: number;
  colorSpace?: 'CMYK' | 'RGB' | 'ANY';
  minTotalPx?: number;
  minDensity?: number;
  allowedFormats?: string[];
  specRequirements?: Record<
    string,
    { minWidth?: number; minHeight?: number; dpi?: number; colorSpace?: string }
  >;
}

export interface Product {
  id: number;
  name: string;
  cover?: string;
  images?: string[];
  price: number;
  stock: number;
  sales: number;
  categoryId?: number;
  vendorId?: number;
  tags?: string[];
  printStandard?: ProductPrintStandard;
  rating: number;
  detail?: string;
  status: number;
  sort: number;
  createdBy?: number;
  /** 商品类型：ready=纯卖 / custom=需要文件定制 / combo=商品+设计打包 */
  productType?: 'ready' | 'custom' | 'combo';
  /** 设计费（combo 类型里的设计费部分，单位元） */
  designFee?: number | null;
  /** 印刷/生产成本（供应商成本底，单位元） */
  printFee?: number | null;
  /** 是否需要买家上传设计稿 */
  needsDesignUpload?: number;
}

export interface Category {
  id: number;
  parentId?: number; // 0 或 undefined = 一级分类，>0 = 子分类
  name: string;
  icon?: string;
  sort: number;
  status: number; // 1=启用 0=禁用
}

export interface Banner {
  id: number;
  title: string;
  image: string;
  linkType: 'product' | 'category' | 'url';
  link?: string;
  sort: number;
  status: number;
}

export interface SearchKeyword {
  id: number;
  keyword: string;
  searchCount: number;
  sort: number;
}

// — Sprint 2 —
export interface CartItem {
  id: number;
  userId: number;
  productId: number;
  specId?: string;
  quantity: number;
  selected: number; // 1=选中 0=未选中
}
export interface Order {
  id: number;
  orderNo: string;
  userId: number;
  vendorId?: number;
  status: string; // pending/paid/shipped/completed/cancelled
  totalAmount: number;
  discount: number;
  shippingFee: number;
  receiverName?: string;
  receiverPhone?: string;
  receiverAddress?: string;
  remark?: string;
  payMethod?: string;
  paidAt?: string;
  shippedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
  trackingNo?: string;
  carrier?: string;
  /** P1: 主订单关联（MasterOrder） */
  masterOrderId?: number;
}
export interface OrderItem {
  id: number;
  orderId: number;
  productId: number;
  productName: string;
  productCover?: string;
  quantity: number;
  price: number;
}
export interface Address {
  id: number;
  userId: number;
  name: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: number;
  createdAt: string;
  updatedAt: string;
}

// — Sprint 3.5 — 设计需求 —
export interface DesignDemand {
  id: number;
  userId: number;
  productId?: number;
  productName?: string;
  demandText: string;
  designCategory?: string; // 原 Sprint 9 demandType（logo/vi/poster...）
  demandType?: 'design' | 'fix'; // 📐 P1：design=从零 fix=改稿
  styleTags?: string[];
  deliverables?: string[];
  commercialLicense?: boolean;
  specSize?: string;
  budget: string; // 如 "¥500-1000"
  budgetMin?: number | null;
  budgetMax?: number | null;
  contactPhone?: string;
  wechat?: string;
  deliveryTime: string; // 如 "3天内"
  referenceImages?: string[];
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  statusText: string;
  designerId?: number;
  orderNo?: string;
  createdAt: string;
  updatedAt: string;
}

// — Sprint 3 —
export interface DesignFile {
  id: number;
  userId: number;
  fileName: string;
  originalName: string;
  format: string;
  fileSize: number;
  url?: string;
  thumbnailUrl?: string;
  widthPx?: number;
  heightPx?: number;
  dpi?: number;
  colorSpace?: string;
  pages?: number;
  layers?: number;
  version: number;
  parentId?: number;
  status: string;
  validation?: { passed: boolean; score: number; issues: any[]; recommendTargetSize?: string };
  productId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SmsCode {
  phone: string;
  code: string;
  purpose: string;
  used: boolean;
  expiresAt: number;
}

// ============ 单例存储 ============
interface Store {
  users: User[];
  sessions: Session[];
  products: Product[];
  categories: Category[];
  banners: Banner[];
  searchKeywords: SearchKeyword[];
  smsCodes: SmsCode[];
  // Sprint 2
  carts: CartItem[];
  orders: Order[];
  orderItems: OrderItem[];
  addresses: Address[];
  designFiles: DesignFile[];
  designDemands: DesignDemand[];
  // Sprint 3+ 扩展集合（内存 fallback stub）
  designOrders: any[];
  designDeliveries: any[];
  designRevisionRequests: any[];
  withdrawRequests: any[];
  reviews: any[];
  refunds: any[];
  installerWarrantyClaims: any[];
  // MasterOrder 聚合根 + 安装子流程（内存 fallback）
  masterOrders: any[];
  installationDemands: any[];
  installationOrders: any[];
  // PlatformTransaction 平台交易流水（内存 fallback）
  platformTransactions: any[];
  // VendorDeliveryArea 供应商自管配送区域（内存 fallback）
  vendorDeliveryAreas: any[];
  // Dispute 纠纷（Week 9 Sprint 13，内存 fallback）
  disputes: any[];
  idCounters: Record<string, number>;
}

const store: Store = {
  users: [],
  sessions: [],
  products: [],
  categories: [],
  banners: [],
  searchKeywords: [],
  smsCodes: [],
  carts: [],
  orders: [],
  orderItems: [],
  addresses: [],
  designFiles: [],
  designDemands: [],
  designOrders: [],
  designDeliveries: [],
  designRevisionRequests: [],
  withdrawRequests: [],
  reviews: [],
  refunds: [],
  installerWarrantyClaims: [],
  masterOrders: [],
  installationDemands: [],
  installationOrders: [],
  platformTransactions: [],
  vendorDeliveryAreas: [],
  disputes: [],
  idCounters: {
    users: 50000,  // ← seed 用户从 50001 起（给真实用户 id 预留低位空间）
    sessions: 0,
    products: 0,
    categories: 0,
    banners: 0,
    searchKeywords: 0,
    carts: 0,
    orders: 0,
    orderItems: 0,
    addresses: 0,
    designFiles: 0,
    designDemands: 0,
    designOrders: 0,
    designDeliveries: 0,
    designRevisionRequests: 0,
    withdrawRequests: 0,
    reviews: 0,
    refunds: 0,
    installerWarrantyClaims: 0,
    masterOrders: 0,
    installationDemands: 0,
    installationOrders: 0,
    platformTransactions: 0,
    disputes: 0,
  },
};

export function nextId(key: keyof typeof store.idCounters): number {
  store.idCounters[key] = (store.idCounters[key] || 0) + 1;
  return store.idCounters[key];
}

// ============ Seed ============
export async function seed() {
  // — 分类（17 L1 × 4 L2 = 68 子分类 + 17 L1）—
  // ============ L1 一级分类：硬编码固定 ID 对齐前端 specMaps ============
  // 关键约束：L1 id 必须与 src/constants/specMaps.ts 的 CATEGORY_SPEC_MAP key 对齐！
  // L2 子分类 id = L1_id * 100 + idx（0~99），避免 L1 id=11 与 L2 id=1×10+1=11 冲突！
  // L1 id 范围: 1~99，L2 id 范围: 100-109, 600-609, 1100-1103, ...
  const L1 = [
    { id: 1, name: '材料销售', icon: '📦', sort: 1, spec: true },
    { id: 3, name: '设计策划', icon: '🎨', sort: 2, spec: false }, // 服务类，无商品规格
    { id: 6, name: '喷绘制作', icon: '🖼️', sort: 3, spec: true },
    { id: 11, name: '写真制作', icon: '🖨️', sort: 4, spec: true },
    { id: 16, name: '卷材制作', icon: '📜', sort: 5, spec: true },
    { id: 21, name: '旗帜条幅', icon: '🚩', sort: 6, spec: true }, // ← 新补：catId=21 之前 specMaps 缺口
    { id: 26, name: '快印装订', icon: '📚', sort: 7, spec: true },
    { id: 31, name: '标牌证卡', icon: '🪪', sort: 8, spec: true },
    { id: 36, name: '胶板印刷', icon: '🏭', sort: 9, spec: true },
    { id: 41, name: '雕刻加工', icon: '🔪', sort: 10, spec: true },
    { id: 46, name: '展板制作', icon: '📋', sort: 11, spec: true },
    { id: 51, name: '立体大字', icon: '🔤', sort: 12, spec: true },
    { id: 56, name: '户外工程', icon: '🏗️', sort: 13, spec: true },
    { id: 61, name: '广告礼品', icon: '🎁', sort: 14, spec: true },
    { id: 66, name: '庆典布展', icon: '🎉', sort: 15, spec: true },
    { id: 71, name: '交通设施', icon: '🚦', sort: 16, spec: true },
    { id: 76, name: '电子亮化', icon: '💡', sort: 17, spec: true },
    { id: 81, name: '展示器材', icon: '🎪', sort: 18, spec: true },
  ];
  // 每个 L1 精确 4 个子分类
  const L2Map: Record<string, { name: string }[]> = {
    材料销售: [{ name: '喷绘布' }, { name: '写真布' }, { name: '亚克力板' }, { name: 'KT板' }],
    设计策划: [
      { name: 'VI设计' },
      { name: '海报设计' },
      { name: '包装设计' },
      { name: 'LOGO设计' },
    ],
    喷绘制作: [
      { name: '户外喷绘' },
      { name: '室内喷绘' },
      { name: '宽幅喷绘' },
      { name: '网格喷绘' },
    ],
    写真制作: [
      { name: '高清写真' },
      { name: 'PP写真' },
      { name: '背胶写真' },
      { name: '相纸写真' },
    ],
    卷材制作: [
      { name: '灯箱卷材' },
      { name: 'UV卷材' },
      { name: '打印卷材' },
      { name: '反光卷材' },
    ],
    旗帜条幅: [{ name: '注水旗' }, { name: '刀旗' }, { name: '沙滩旗' }, { name: '数码旗帜' }],
    快印装订: [
      { name: '彩页印刷' },
      { name: '名片印刷' },
      { name: '手册装订' },
      { name: '相册制作' },
    ],
    标牌证卡: [
      { name: '金属标牌' },
      { name: 'PVC证卡' },
      { name: '亚克力标牌' },
      { name: '胸牌工牌' },
    ],
    胶板印刷: [
      { name: '胶印彩盒' },
      { name: '书刊印刷' },
      { name: '标签印刷' },
      { name: '票据印刷' },
    ],
    雕刻加工: [
      { name: '石材雕刻' },
      { name: '木工雕刻' },
      { name: '金属雕刻' },
      { name: '激光雕刻' },
    ],
    展板制作: [
      { name: '雪弗板展板' },
      { name: '亚克力展板' },
      { name: '铝合金展板' },
      { name: '可移胶展板' },
    ],
    立体大字: [{ name: '发光字' }, { name: '亚克力字' }, { name: '金属字' }, { name: '迷你字' }],
    户外工程: [
      { name: '楼顶大字' },
      { name: '门头招牌' },
      { name: '立柱广告' },
      { name: '围栏广告' },
    ],
    广告礼品: [{ name: '定制T恤' }, { name: '保温杯' }, { name: '帆布袋' }, { name: '雨伞' }],
    庆典布展: [
      { name: '展会背景板' },
      { name: '桁架搭建' },
      { name: '舞台搭建' },
      { name: '气球拱门' },
    ],
    交通设施: [{ name: '交通标志牌' }, { name: '减速带' }, { name: '反光膜' }, { name: '隔离桩' }],
    电子亮化: [
      { name: 'LED显示屏' },
      { name: '霓虹灯带' },
      { name: '楼体灯光' },
      { name: '轮廓灯' },
    ],
    展示器材: [{ name: '易拉宝' }, { name: 'X展架' }, { name: '拉网展架' }, { name: '促销台' }],
  };

  const categories: Category[] = [];
  for (const l1 of L1) {
    // 硬编码固定 ID（来自 L1[i].id，已与前端 specMaps 对齐）
    categories.push({ id: l1.id, name: l1.name, icon: l1.icon, sort: l1.sort, status: 1 });
    const subs = L2Map[l1.name] || [];
    subs.forEach((s, i) => {
      // L2 id = L1_id * 100 + idx → 可反向推导 parent = Math.floor(id / 100)
      // 用 100 而不是 10：避免 L1 id=11 与 L2 id=1×10+1=11 冲突
      categories.push({
        id: l1.id * 100 + i,
        parentId: l1.id,
        name: s.name,
        icon: '',
        sort: i + 1,
        status: 1,
      });
    });
  }
  store.categories = categories;

  // — 建 L1→L2 id 映射（用于商品分配）—
  const l1ToL2Ids = new Map<string, number[]>();
  categories.forEach((c) => {
    if (c.parentId) {
      const parent = categories.find((p) => p.id === c.parentId);
      if (parent) {
        if (!l1ToL2Ids.has(parent.name)) {
          l1ToL2Ids.set(parent.name, []);
        }
        l1ToL2Ids.get(parent.name)!.push(c.id);
      }
    }
  });
  const pickFirst = (l1Name: string, idx = 0) => {
    const arr = l1ToL2Ids.get(l1Name);
    return arr ? arr[Math.min(idx, arr.length - 1)] : undefined;
  };
  const pickAny = (l1Name: string) => {
    const arr = l1ToL2Ids.get(l1Name);
    return arr ? arr[Math.floor(Math.random() * arr.length)] : undefined;
  };

  // — Banner —
  store.banners = [
    {
      id: nextId('banners'),
      title: '开业特惠 全场8折',
      image: '/images/banner1.png',
      linkType: 'product',
      link: '/api/products/1',
      sort: 1,
      status: 1,
    },
    {
      id: nextId('banners'),
      title: '设计定制 免费报价',
      image: '/images/banner2.png',
      linkType: 'url',
      link: '/customize',
      sort: 2,
      status: 1,
    },
    {
      id: nextId('banners'),
      title: '新品上架 限时秒杀',
      image: '/images/banner3.png',
      linkType: 'category',
      link: '1',
      sort: 3,
      status: 1,
    },
  ];

  // — 商品（27 个，按 60/20/20 重分类）—
  // ready ~5 个（20%，原材料/成品/纯服务）
  // custom ~17 个（60%，需要买家上传设计稿）
  // combo ~5 个（20%，设计+印刷打包）
  // 元组: [name, price, stock, sales, catId, printStandard?, productType?, designFee?, printFee?]
  const stdPrintAny72: ProductPrintStandard = { minDpi: 72, colorSpace: 'ANY', minTotalPx: 100000 };
  const stdPrintAny100: ProductPrintStandard = { minDpi: 100, colorSpace: 'ANY', minTotalPx: 200000 };
  const stdCmyk300A4: ProductPrintStandard = { minDpi: 300, colorSpace: 'CMYK', minTotalPx: 2480 * 3508 }; // A4 @300dpi
  const stdCmyk300Card: ProductPrintStandard = { minDpi: 300, colorSpace: 'CMYK', minTotalPx: 1050 * 600 }; // 名片 @300dpi

  const PT_READY = 'ready' as const;
  const PT_CUSTOM = 'custom' as const;
  const PT_COMBO = 'combo' as const;

  const productData: Array<[
    string, number, number, number, number,
    ProductPrintStandard?,
    'ready' | 'custom' | 'combo'?,
    number?, number?,
  ]> = [
    // ====== ready（~5 个，原材料/工艺/成品/纯服务）======
    ['户外喷绘布 520g', 15, 5000, 320, pickFirst('材料销售', 0), undefined, PT_READY],
    ['进口写真布 260g', 28, 3000, 510, pickFirst('材料销售', 1), undefined, PT_READY],
    ['亚克力激光雕刻加工', 15, 2000, 780, pickFirst('雕刻加工', 3), undefined, PT_READY],
    ['LED 显示屏 P3 室内', 2980, 42, 15, pickFirst('电子亮化', 0), undefined, PT_READY],
    ['楼顶大字安装', 1200, 30, 23, pickFirst('户外工程', 0), undefined, PT_READY],

    // ====== combo（~5 个，设计+印刷打包，price 里拆 designFee）======
    // price=总价, designFee=设计师分成基数, printFee=供应商印刷成本
    ['企业 VI 设计套餐', 2800, 100, 45, pickFirst('设计策划', 3), undefined, PT_COMBO, 1500, 1300],
    ['彩页印刷 A4 157g 含设计', 1280, 50000, 12000, pickFirst('快印装订', 0), stdCmyk300A4, PT_COMBO, 400, 880],
    ['名片印刷 500 张 含设计', 288, 5000, 680, pickFirst('快印装订', 1), stdCmyk300Card, PT_COMBO, 120, 168],
    ['门头招牌设计+喷绘套餐', 2800, 99, 67, pickFirst('户外工程', 1), undefined, PT_COMBO, 800, 2000],
    ['展会背景板设计+桁架套餐', 2000, 30, 23, pickFirst('庆典布展', 0), stdPrintAny100, PT_COMBO, 600, 1400],

    // ====== custom（~17 个，需要买家上传设计稿）======
    ['高清户外喷绘定制', 120, 200, 89, pickFirst('喷绘制作', 0), stdPrintAny72, PT_CUSTOM],
    ['宽幅喷绘 5m 无拼接', 180, 100, 23, pickFirst('喷绘制作', 2), stdPrintAny72, PT_CUSTOM],
    ['高清写真 PP 纸', 25, 2000, 800, pickFirst('写真制作', 0), stdPrintAny72, PT_CUSTOM],
    ['背胶写真 KT 板', 28, 999, 156, pickFirst('写真制作', 2), stdPrintAny72, PT_CUSTOM],
    ['灯箱专用 UV 卷材', 65, 500, 120, pickFirst('卷材制作', 0), stdPrintAny100, PT_CUSTOM],
    ['注水旗 3m×5m', 120, 200, 312, pickFirst('旗帜条幅', 0), stdPrintAny72, PT_CUSTOM],
    ['数码旗帜 定制', 35, 500, 189, pickFirst('旗帜条幅', 3), stdPrintAny72, PT_CUSTOM],
    ['金属标牌定制', 380, 60, 42, pickFirst('标牌证卡', 0), stdPrintAny100, PT_CUSTOM],
    ['亚克力胸牌工牌', 8, 500, 230, pickFirst('标牌证卡', 3), stdPrintAny100, PT_CUSTOM],
    ['胶印彩盒定制', 12, 3000, 560, pickFirst('胶板印刷', 0), stdCmyk300A4, PT_CUSTOM],
    ['雪弗板展板 8mm', 45, 300, 120, pickFirst('展板制作', 0), stdPrintAny100, PT_CUSTOM],
    ['LED 无边发光字', 168, 50, 89, pickFirst('立体大字', 0), undefined, PT_CUSTOM],
    ['亚克力迷你发光字', 98, 180, 143, pickFirst('立体大字', 3), undefined, PT_CUSTOM],
    ['定制保温杯 印logo', 45, 300, 180, pickFirst('广告礼品', 1), stdPrintAny100, PT_CUSTOM],
    ['交通标志牌 反光', 120, 200, 76, pickFirst('交通设施', 0), stdPrintAny100, PT_CUSTOM],
    ['霓虹灯带 定制', 85, 300, 201, pickFirst('电子亮化', 1), undefined, PT_CUSTOM],
    ['易拉宝 80×200cm', 75, 1000, 420, pickFirst('展示器材', 0), stdPrintAny72, PT_CUSTOM],
  ];
  // — vendor id 池（真实 seed id：50007-50011 对应 5 个 vendor）—
  // id 顺序由 roleUsers 数组决定：前 2 个 consumer + 1 个 admin + 4 个 consumer + 5 个 vendor + 2 个 designer + 1 个 installer
  const VENDOR_IDS = [50007, 50008, 50009, 50010, 50011];
  store.products = productData.map(([name, price, stock, sales, catId, printStd, pType, dFee, pFee], i) => {
    const productType = pType || PT_READY;
    // needsDesignUpload: custom→1, combo→0, ready→0
    const needsDesignUpload = productType === PT_CUSTOM ? 1 : 0;
    // 5 个 vendor 均匀分配商品
    const vendorId = VENDOR_IDS[i % VENDOR_IDS.length];
    return {
      id: nextId('products'),
      vendorId,
      name: name as string,
      price: price as number,
      stock: stock as number,
      sales: sales as number,
      categoryId: catId as number,
      printStandard: printStd,
      cover: `/images/product_${Math.floor(Math.random() * 5) + 1}.png`,
      images: [`/images/product_${Math.floor(Math.random() * 5) + 1}.png`],
      tags: ['热销', '新品', '推荐'].slice(0, Math.floor(Math.random() * 2) + 1),
      rating: 4 + Math.random(),
      detail: '<p>优质广告物料，品质保障</p>',
      status: 1,
      sort: 0,
      productType,
      designFee: pType === PT_COMBO ? (dFee != null ? dFee : null) : null,
      printFee: pFee != null ? pFee : null,
      needsDesignUpload,
    };
  });

  // — 搜索热词 —
  store.searchKeywords = [
    { id: nextId('searchKeywords'), keyword: '灯箱', searchCount: 3280, sort: 1 },
    { id: nextId('searchKeywords'), keyword: '喷绘', searchCount: 2890, sort: 2 },
    { id: nextId('searchKeywords'), keyword: '招牌', searchCount: 2560, sort: 3 },
    { id: nextId('searchKeywords'), keyword: '展会', searchCount: 2100, sort: 4 },
    { id: nextId('searchKeywords'), keyword: '设计', searchCount: 1800, sort: 5 },
    { id: nextId('searchKeywords'), keyword: '安装', searchCount: 1500, sort: 6 },
  ];

  // — 预置测试用户（13800138000 / 密码 123456 / 验证码 123456）—
  const hash = bcrypt.hashSync('123456', 10);
  store.users.push({
    id: nextId('users'),
    phone: '13800138000',
    nickname: '广告达人',
    passwordHash: hash,
    avatar: '',
    role: 'consumer',
    level: 3,
    points: 1280,
    wallet: 328.5,
    coupons: 5,
    status: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // — Admin 用户（13389210520 / 123456）—
  const adminHash = bcrypt.hashSync('123456', 10);
  store.users.push({
    id: nextId('users'),
    phone: '13389210520',
    nickname: '超级管理员',
    passwordHash: adminHash,
    avatar: '',
    role: 'admin',
    level: 99,
    points: 0,
    wallet: 0,
    coupons: 0,
    status: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // — Sprint 2: 预置测试地址（测试用户 id=1）—
  store.addresses.push({
    id: nextId('addresses'),
    userId: 50001,
    name: '张经理',
    phone: '13800138000',
    province: '上海市',
    city: '上海市',
    district: '浦东新区',
    detail: '张江高科 88 号创意大厦 15F',
    isDefault: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.addresses.push({
    id: nextId('addresses'),
    userId: 50001,
    name: '李师傅',
    phone: '13800138000',
    province: '北京市',
    city: '北京市',
    district: '朝阳区',
    detail: '建国路 77 号万达广场 B 座',
    isDefault: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // — Sprint 3.5: 预置设计需求（测试用户 id=1 发 2 条）—
  store.designDemands.push({
    id: nextId('designDemands'),
    userId: 50001,
    productId: 1,
    productName: '高清喷绘广告牌',
    demandText:
      '需要一张 3m×2m 的户外高清喷绘，画面主体是蓝色渐变背景 + 白色文字，用于商场外墙广告位。要求分辨率 72dpi+，色彩模式 CMYK，边缘预留 5mm 出血。',
    budget: '¥500-1000',
    contactPhone: '13800138000',
    wechat: 'zhang_manager',
    deliveryTime: '3天内',
    status: 'pending',
    statusText: '待接单',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.designDemands.push({
    id: nextId('designDemands'),
    userId: 50001,
    productId: 2,
    productName: 'LED 灯箱海报',
    demandText:
      '室内 LED 灯箱海报 1.2m×0.6m，内容是咖啡新品推广，风格年轻活泼，主色调橙色和深咖色。需提供 PSD 源文件和 150dpi JPG。',
    budget: '¥300-500',
    contactPhone: '13800138000',
    wechat: 'zhang_manager',
    deliveryTime: '5天内',
    status: 'accepted',
    statusText: '已接单',
    designerId: 50012, // 设计小王（真实 seed id：50000 偏移）
    orderNo: 'DD20261003001',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // — Admin mock：多角色用户补充（consumer + vendor + designer + installer）—
  const adminMockHash = bcrypt.hashSync('123456', 10);
  type SeedUser = {
    phone: string; nickname: string;
    role: 'admin'|'installer'|'designer'|'consumer'|'vendor'|'pending_vendor'|'pending_designer'|'pending_installer';
    serviceAreas?: Array<{ province: string; city: string; district?: string | null }>;
    serviceLng?: number | null;
    serviceLat?: number | null;
  };
  const roleUsers: SeedUser[] = [
    { phone: '13800001001', nickname: '王老板', role: 'consumer' },
    { phone: '13800001002', nickname: '李经理', role: 'consumer' },
    { phone: '13800001003', nickname: '张设计', role: 'consumer' },
    { phone: '13800001004', nickname: '赵工', role: 'consumer' },
    // — 5 个 vendor，各覆盖不同地理区域 —
    { phone: '13900002001', nickname: '上海图文社', role: 'vendor',
      serviceAreas: [
        { province: '上海市', city: '上海市', district: '浦东新区' },
        { province: '上海市', city: '上海市', district: '徐汇区' },
        { province: '上海市', city: '上海市', district: '长宁区' },
      ],
      serviceLng: 121.5447, serviceLat: 31.2230,
    },
    { phone: '13900002002', nickname: '深圳彩印厂', role: 'vendor',
      serviceAreas: [
        { province: '广东省', city: '深圳市', district: '南山区' },
        { province: '广东省', city: '深圳市', district: '福田区' },
        { province: '广东省', city: '广州市', district: '天河区' },
        { province: '广东省', city: '广州市', district: '白云区' },
      ],
      serviceLng: 114.0579, serviceLat: 22.5431,
    },
    { phone: '13900002003', nickname: '北京朝阳印刷', role: 'vendor',
      serviceAreas: [
        { province: '北京市', city: '北京市', district: '朝阳区' },
        { province: '北京市', city: '北京市', district: '海淀区' },
      ],
      serviceLng: 116.4614, serviceLat: 39.9219,
    },
    { phone: '13900002004', nickname: '成都广告制作', role: 'vendor',
      serviceAreas: [
        { province: '四川省', city: '成都市', district: null }, // 覆盖整个成都
      ],
      serviceLng: 104.0668, serviceLat: 30.5728,
    },
    { phone: '13900002005', nickname: '杭州图文快印', role: 'vendor',
      serviceAreas: [
        { province: '浙江省', city: '杭州市', district: null }, // 覆盖整个杭州
      ],
      serviceLng: 120.1551, serviceLat: 30.2741,
    },
    { phone: '13700003001', nickname: '设计小王', role: 'designer' },
    { phone: '13700003002', nickname: '创意工作室', role: 'designer' },
    { phone: '13600004001', nickname: '安装刘师傅', role: 'installer' },
  ];
  for (const u of roleUsers) {
    store.users.push({
      id: nextId('users'),
      phone: u.phone, nickname: u.nickname,
      passwordHash: adminMockHash, avatar: '',
      role: u.role, level: 1, points: 0, wallet: 0, coupons: 0,
      status: 1,
      serviceAreas: u.serviceAreas,
      serviceLng: u.serviceLng ?? null,
      serviceLat: u.serviceLat ?? null,
      createdAt: new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  // — Admin mock：商品订单（goods × 3 + design × 2 + install × 2）—
  const goodsStatuses = ['paid', 'shipped', 'completed'];
  const orderProducts = [
    { name: '高清喷绘广告牌', total: 1200 },
    { name: 'LED 灯箱海报', total: 860 },
    { name: '亚克力水晶字', total: 2100 },
  ];
  for (let i = 0; i < 3; i++) {
    const p = orderProducts[i];
    // VENDOR_IDS = [50007, 50008, 50009, 50010, 50011] — 这里 3 个订单用前 3 个 vendor
    store.orders.push({
      id: nextId('orders'),
      orderNo: 'GD' + (2026100000 + i + 1),
      userId: 50001, vendorId: 50007 + i,
      totalAmount: p.total, discount: 0, shippingFee: 15,
      status: goodsStatuses[i],
      receiverName: '张经理', receiverPhone: '13800138000',
      receiverAddress: '上海市浦东新区张江高科 88 号',
      payMethod: 'wechat',
      createdAt: new Date(Date.now() - (i + 1) * 2 * 86400000).toISOString(),
      paidAt: new Date(Date.now() - (i + 1) * 2 * 86400000 + 3600000).toISOString(),
      shippedAt: i >= 1 ? new Date(Date.now() - i * 86400000).toISOString() : undefined,
      completedAt: i >= 2 ? new Date(Date.now() - 3600000).toISOString() : undefined,
    });
    store.orderItems.push({
      id: nextId('orderItems'),
      orderId: store.orders[store.orders.length - 1].id,
      productId: 1, productName: p.name, productCover: '',
      quantity: 1, price: p.total,
    });
  }
  store.designDemands; // 引用防 TS 未使用警告
  // 设计 & 安装订单（admin.ts 的 /orders 路由会查 DesignOrderEntity 和 InstallationOrderEntity）
  // 这里只填 goods 类型，design/install 在各自的 seed 或 admin.ts 的 mock 里处理

  // — Admin mock：质保索赔（2 条，1 条仲裁中 + 1 条已解决）—
  store.installerWarrantyClaims.push(
    { id: 1, claimNo: 'WC20261008001', orderId: 1, userId: 50001, installerId: 50014, issueDesc: '招牌脱落重新装', images: [], status: 'arbitrated', installerResponse: null, installerRespondAt: null, resolution: null, compensationAmount: 0, handlerId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    { id: 2, claimNo: 'WC20261008002', orderId: 2, userId: 50002, installerId: 50014, issueDesc: '发光字不亮', images: [], status: 'pending', installerResponse: null, installerRespondAt: null, resolution: null, compensationAmount: 0, handlerId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  );

  // — Admin mock：提现申请（4 条）—
  const wStatuses = ['pending', 'pending', 'approved', 'rejected'];
  const wVendors = [50007, 50008, 50009, 50010]; // 对应 4 个真实 vendor id（7=上海/8=深圳/9=北京/10=成都）
  const wAmounts = [5000, 3200, 8800, 1500];
  for (let i = 0; i < 4; i++) {
    const s = wStatuses[i];
    store.withdrawRequests.push({
      id: nextId('withdrawRequests'),
      withdrawNo: 'WD' + (20261000 + i + 1),
      vendorId: wVendors[i],
      amount: wAmounts[i],
      fee: Math.round(wAmounts[i] * 0.006),
      actualAmount: Math.round(wAmounts[i] * 0.994),
      bankName: i % 2 === 0 ? '工商银行' : '招商银行',
      cardNo: '**** **** **** 88' + (10 + i),
      status: s,
      remark: s === 'rejected' ? '银行卡信息不完整' : null,
      reviewedBy: s !== 'pending' ? 2 : null,
      reviewedAt: s !== 'pending' ? new Date(Date.now() - 86400000).toISOString() : null,
      paidAt: s === 'approved' ? new Date(Date.now() - 3600000).toISOString() : null,
      createdAt: new Date(Date.now() - (i + 1) * 3 * 86400000).toISOString(),
    });
  }

  // — P1: MasterOrder 主订单 + 子订单种子 —
  // 先 push 子订单（DesignOrder / InstallationDemand / InstallationOrder），
  // 再 push MasterOrder 引用它们，最后 patch 子订单的 masterOrderId 回指
  const now = new Date();

  // --- DesignOrder × 2（关联已有的 DesignDemand id=1, id=2）---
  const do1 = {
    id: nextId('designOrders'),
    orderNo: 'DO202610110001',
    demandId: 1,
    buyerId: 50001,
    designerId: 50012, // 设计小王（真实 seed id：50000 偏移）
    price: 500,
    commissionRate: 0.15,
    status: 'designing' as const,
    revisionCount: 0,
    finalDeliveryId: null,
    masterOrderId: null as number | null, // patch 回写
    acceptedAt: new Date(Date.now() - 3600000),
    createdAt: new Date(Date.now() - 86400000),
    updatedAt: now,
  };
  const do2 = {
    id: nextId('designOrders'),
    orderNo: 'DO202610110002',
    demandId: 2,
    buyerId: 50001,
    designerId: 50013, // 创意工作室（真实 seed id：50000 偏移）
    price: 400,
    commissionRate: 0.15,
    status: 'accepted' as const,
    revisionCount: 0,
    finalDeliveryId: null,
    masterOrderId: null as number | null,
    acceptedAt: new Date(Date.now() - 7200000),
    createdAt: new Date(Date.now() - 172800000),
    updatedAt: now,
  };
  store.designOrders.push(do1, do2);

  // --- InstallationDemand × 1（带 productId — 门头招牌喷绘 custom 商品 id=14）---
  // productData 第 14 个（0-indexed 13）是 ['定制保温杯 印logo', ...]
  // 但我要一个更贴合安装的——LED 无边发光字（id=24，0-indexed 23），productId=24
  const demandInstall = {
    id: nextId('installationDemands'),
    userId: 50001,
    categoryId: 5601, // 户外工程 / 门头招牌（L1=56，L2 第一个子分类 = 5600 + 0 = 5600... 让我算）
    // L1 id * 100 + idx，户外工程 id=56，idx=1 对应"门头招牌" → 56*100+1=5601
    serviceType: 'signage',
    address: '北京市朝阳区建国路 77 号万达广场 B 座',
    serviceLat: 39.9087,
    serviceLng: 116.4614,
    expectedTime: new Date(Date.now() + 86400000 * 3),
    description: '门头招牌喷绘 + 安装，尺寸 8m×0.6m',
    budgetMin: 2000,
    budgetMax: 4000,
    radiusKm: 10,
    contactName: '张经理',
    contactPhone: '13800138000',
    productId: 14, // 门头招牌设计+喷绘套餐 combo（productData 里第 10 个，id=14）
    craftType: 'uv-banner',
    specSize: '长8m×高0.6m',
    installHeight: 'mid',
    powerStatus: 'need_connect',
    materialBy: 'installer',
    needDemolition: 0,
    installLocation: 'storefront',
    accessibility: ['parking', 'elevator'],
    sitePhotos: [],
    gradeMin: 3,
    gradeMax: 6,
    status: 'accepted',
    quoteCount: 1,
    createdAt: new Date(Date.now() - 86400000),
    updatedAt: now,
  };
  store.installationDemands.push(demandInstall);

  // --- InstallationOrder × 1（带 masterOrderId + productId）---
  const installOrder = {
    id: nextId('installationOrders'),
    orderNo: 'IO202610110001',
    demandId: demandInstall.id,
    quoteId: 1, // placeholder，InstallationQuoteEntity 没 seed，这里随便填
    userId: 50001,
    installerId: 50014, // 安装刘师傅（真实 seed id：50000 偏移）
    price: 3000,
    status: 'installing',
    masterOrderId: null as number | null, // patch 回写
    productId: 14, // 门头招牌设计+喷绘套餐
    startedAt: new Date(Date.now() - 3600000),
    createdAt: new Date(Date.now() - 86400000),
    updatedAt: now,
  };
  store.installationOrders.push(installOrder);

  // --- MasterOrder × 3 ---
  // 现有 Order 种子：GD2026100001（id=1, 1200）/ GD2026100002（id=2, 860）/ GD2026100003（id=3, 2100）
  // 但需求里 MO1 的 productTotal 是 8800，MO2 是 28000，MO3 是 12800
  // 这些金额跟现有 Order 种子不匹配——我们新增 3 条专门的 Order 种子给 MasterOrder 用
  const orderMo1 = {
    id: nextId('orders'),
    orderNo: 'PO202610110001',
    userId: 50001,
    vendorId: 50007, // 上海图文社
    totalAmount: 8800,
    discount: 0,
    shippingFee: 0,
    status: 'paid',
    receiverName: '张经理',
    receiverPhone: '13800138000',
    receiverAddress: '上海市浦东新区张江高科 88 号创意大厦 15F',
    payMethod: 'wechat',
    masterOrderId: null as number | null,
    createdAt: new Date(Date.now() - 86400000),
    paidAt: new Date(Date.now() - 82800000),
    updatedAt: now,
  };
  const orderMo2 = {
    id: nextId('orders'),
    orderNo: 'PO202610110002',
    userId: 50001,
    vendorId: 50007, // 上海图文社
    totalAmount: 28000,
    discount: 0,
    shippingFee: 0,
    status: 'paid',
    receiverName: '张经理',
    receiverPhone: '13800138000',
    receiverAddress: '上海市浦东新区张江高科 88 号创意大厦 15F',
    payMethod: 'wechat',
    masterOrderId: null as number | null,
    createdAt: new Date(Date.now() - 172800000),
    paidAt: new Date(Date.now() - 169200000),
    updatedAt: now,
  };
  const orderMo3 = {
    id: nextId('orders'),
    orderNo: 'PO202610110003',
    userId: 50004, // consumer 2 王老板
    vendorId: 50009, // 北京朝阳印刷
    totalAmount: 12800,
    discount: 0,
    shippingFee: 0,
    status: 'paid',
    receiverName: '王老板',
    receiverPhone: '13800001001',
    receiverAddress: '北京市朝阳区建国路 77 号万达广场 B 座',
    payMethod: 'wechat',
    masterOrderId: null as number | null,
    createdAt: new Date(Date.now() - 259200000),
    paidAt: new Date(Date.now() - 255600000),
    updatedAt: now,
  };
  store.orders.push(orderMo1, orderMo2, orderMo3);

  // 再补对应的 OrderItem
  store.orderItems.push(
    { id: nextId('orderItems'), orderId: orderMo1.id, productId: 7, productName: '彩页印刷 A4 157g 含设计', productCover: '', quantity: 1000, price: 8.8 },
    { id: nextId('orderItems'), orderId: orderMo2.id, productId: 14, productName: '门头招牌设计+喷绘套餐', productCover: '', quantity: 1, price: 28000 },
    { id: nextId('orderItems'), orderId: orderMo3.id, productId: 7, productName: '彩页印刷 A4 157g 含设计', productCover: '', quantity: 10000, price: 1.28 },
  );

  // 现在 push MasterOrder（引用上面的子订单 id）
  const mo1 = {
    id: nextId('masterOrders'),
    orderNo: 'MO202610110001',
    buyerId: 50001,
    buyerNickname: '广告达人',
    productOrderId: orderMo1.id,
    designOrderId: null,
    installationOrderId: null,
    productTotal: 8800,
    designTotal: 0,
    installTotal: 0,
    totalAmount: 8800,
    platformFee: 0,
    status: 'paid',
    address: { name: '张经理', phone: '13800138000', province: '上海市', city: '上海市', district: '浦东新区', detail: '张江高科 88 号创意大厦 15F' },
    remark: null,
    createdAt: new Date(Date.now() - 86400000),
    updatedAt: now,
  };
  const mo2 = {
    id: nextId('masterOrders'),
    orderNo: 'MO202610110002',
    buyerId: 50001,
    buyerNickname: '广告达人',
    productOrderId: orderMo2.id,
    designOrderId: do1.id,
    installationOrderId: null,
    productTotal: 28000,
    designTotal: 6000,
    installTotal: 0,
    totalAmount: 34000,
    platformFee: 0,
    status: 'designing',
    address: { name: '张经理', phone: '13800138000', province: '上海市', city: '上海市', district: '浦东新区', detail: '张江高科 88 号创意大厦 15F' },
    remark: null,
    createdAt: new Date(Date.now() - 172800000),
    updatedAt: now,
  };
  const mo3 = {
    id: nextId('masterOrders'),
    orderNo: 'MO202610110003',
    buyerId: 50004,
    buyerNickname: '王老板',
    productOrderId: orderMo3.id,
    designOrderId: do2.id,
    installationOrderId: installOrder.id,
    productTotal: 12800,
    designTotal: 4000,
    installTotal: 3000,
    totalAmount: 19800,
    platformFee: 0,
    status: 'installing',
    address: { name: '王老板', phone: '13800001001', province: '北京市', city: '北京市', district: '朝阳区', detail: '建国路 77 号万达广场 B 座' },
    remark: null,
    createdAt: new Date(Date.now() - 259200000),
    updatedAt: now,
  };
  store.masterOrders.push(mo1, mo2, mo3);

  // 回补子订单的 masterOrderId
  orderMo1.masterOrderId = mo1.id;
  orderMo2.masterOrderId = mo2.id;
  orderMo3.masterOrderId = mo3.id;
  do1.masterOrderId = mo2.id;
  do2.masterOrderId = mo3.id;
  installOrder.masterOrderId = mo3.id;

  // ============ TypeORM 双写 ============
  // ⚠️ 生产环境（NODE_ENV=production）跳过 seed 双写，避免 truncate 真实数据
  const ds = getDataSource();
  if (ds && ds.isInitialized && process.env.NODE_ENV !== 'production') {
    try {
      // 清空旧 seed 避免主键冲突
      const truncate = async (entity: any) => {
        try {
          await ds.createQueryBuilder().delete().from(entity).execute();
        } catch {}
      };
      await truncate(UserEntity);
      await truncate(SessionEntity);
      await truncate(SmsCodeEntity);
      await truncate(CategoryEntity);
      await truncate(ProductEntity);
      await truncate(BannerEntity);
      await truncate(SearchKeywordEntity);
      await truncate(AddressEntity);
      await truncate(DesignDemandEntity);
      // P1 新增种子表（子表先清，主表后清）
      await truncate(OrderEntity);
      await truncate(DesignOrderEntity);
      await truncate(InstallationDemandEntity);
      await truncate(InstallationOrderEntity);
      await truncate(MasterOrderEntity);

      // 写入
      await ds.getRepository(CategoryEntity).save(
        store.categories.map((c) => ({
          id: c.id,
          parentId: c.parentId,
          name: c.name,
          icon: c.icon,
          sort: c.sort,
          status: c.status,
        })),
      );
      await ds.getRepository(BannerEntity).save(
        store.banners.map((b) => ({
          id: b.id,
          title: b.title,
          image: b.image,
          linkType: b.linkType,
          link: b.link,
          sort: b.sort,
          status: b.status,
        })),
      );
      await ds.getRepository(ProductEntity).save(
        store.products.map((p) => ({
          id: p.id,
          vendorId: (p as any).vendorId ?? null,
          name: p.name,
          cover: p.cover,
          images: p.images,
          price: p.price,
          stock: p.stock,
          sales: p.sales,
          categoryId: p.categoryId,
          tags: p.tags,
          printStandard: p.printStandard,
          rating: p.rating,
          detail: p.detail,
          status: p.status,
          sort: p.sort,
          productType: p.productType || 'ready',
          designFee: p.designFee ?? null,
          printFee: p.printFee ?? null,
          needsDesignUpload: p.needsDesignUpload ?? 0,
        })),
      );
      await ds.getRepository(SearchKeywordEntity).save(
        store.searchKeywords.map((k) => ({
          id: k.id,
          keyword: k.keyword,
          searchCount: k.searchCount,
          sort: k.sort,
          status: 1,
        })),
      );
      await ds.getRepository(UserEntity).save(
        store.users.map((u) => ({
          id: u.id,
          phone: u.phone,
          nickname: u.nickname,
          passwordHash: u.passwordHash,
          avatar: u.avatar,
          role: u.role,
          level: u.level,
          points: u.points,
          wallet: u.wallet,
          coupons: u.coupons,
          status: u.status,
          serviceAreas: u.serviceAreas ?? null,
          serviceLng: u.serviceLng ?? null,
          serviceLat: u.serviceLat ?? null,
        })),
      );
      await ds.getRepository(AddressEntity).save(
        store.addresses.map((a) => ({
          id: a.id,
          userId: a.userId,
          name: a.name,
          phone: a.phone,
          province: a.province,
          city: a.city,
          district: a.district,
          detail: a.detail,
          isDefault: a.isDefault,
        })),
      );
      await ds.getRepository(DesignDemandEntity).save(
        store.designDemands.map((d) => ({
          id: d.id,
          userId: d.userId,
          productId: d.productId,
          productName: d.productName,
          demandText: d.demandText,
          budget: d.budget,
          contactPhone: d.contactPhone,
          wechat: d.wechat,
          deliveryTime: d.deliveryTime,
          status: d.status,
          statusText: d.statusText,
          designerId: d.designerId,
          orderNo: d.orderNo || 'SJ' + d.id,
        })),
      );

      // — P1: OrderEntity（goods 订单，含 masterOrderId）—
      // 只 seed 给 MasterOrder 用的那 3 条（原有 3 条 goods 订单 ID=1,2,3 不双写）
      const masterOrderProductOrders = store.orders.filter(
        (o: Order) => o.orderNo.startsWith('PO20261011'),
      );
      await ds.getRepository(OrderEntity).save(
        masterOrderProductOrders.map((o: Order) => ({
          id: o.id,
          orderNo: o.orderNo,
          userId: o.userId,
          vendorId: o.vendorId ?? null,
          status: o.status,
          totalAmount: o.totalAmount,
          discount: o.discount ?? 0,
          shippingFee: o.shippingFee ?? 0,
          receiverName: o.receiverName ?? null,
          receiverPhone: o.receiverPhone ?? null,
          receiverAddress: o.receiverAddress ?? null,
          payMethod: o.payMethod ?? null,
          paidAt: o.paidAt ? new Date(o.paidAt) : null,
          masterOrderId: o.masterOrderId ?? null,
        })),
      );

      // — P1: DesignOrderEntity（带 masterOrderId）—
      await ds.getRepository(DesignOrderEntity).save(
        store.designOrders.map((d: any) => ({
          id: d.id,
          orderNo: d.orderNo,
          demandId: d.demandId,
          buyerId: d.buyerId,
          designerId: d.designerId,
          price: d.price,
          commissionRate: d.commissionRate,
          status: d.status,
          revisionCount: d.revisionCount ?? 0,
          finalDeliveryId: d.finalDeliveryId ?? null,
          masterOrderId: d.masterOrderId ?? null,
          acceptedAt: d.acceptedAt,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
      );

      // — P1: InstallationDemandEntity（带 productId）—
      await ds.getRepository(InstallationDemandEntity).save(
        store.installationDemands.map((d: any) => ({
          id: d.id,
          userId: d.userId,
          categoryId: d.categoryId ?? null,
          serviceType: d.serviceType,
          address: d.address,
          serviceLat: d.serviceLat,
          serviceLng: d.serviceLng,
          expectedTime: d.expectedTime ?? null,
          description: d.description ?? null,
          budgetMin: d.budgetMin ?? null,
          budgetMax: d.budgetMax ?? null,
          radiusKm: d.radiusKm ?? 10,
          contactName: d.contactName ?? null,
          contactPhone: d.contactPhone ?? null,
          productId: d.productId ?? null,
          craftType: d.craftType ?? null,
          specSize: d.specSize ?? null,
          installHeight: d.installHeight ?? null,
          powerStatus: d.powerStatus ?? null,
          materialBy: d.materialBy ?? null,
          needDemolition: d.needDemolition ?? 0,
          installLocation: d.installLocation ?? null,
          accessibility: d.accessibility ?? null,
          sitePhotos: d.sitePhotos ?? null,
          gradeMin: d.gradeMin ?? 1,
          gradeMax: d.gradeMax ?? 6,
          status: d.status ?? 'pending',
          quoteCount: d.quoteCount ?? 0,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })),
      );

      // — P1: InstallationOrderEntity（带 masterOrderId + productId）—
      await ds.getRepository(InstallationOrderEntity).save(
        store.installationOrders.map((o: any) => ({
          id: o.id,
          orderNo: o.orderNo,
          demandId: o.demandId,
          quoteId: o.quoteId ?? 0,
          userId: o.userId,
          installerId: o.installerId,
          price: o.price,
          finalPrice: o.finalPrice ?? o.price,
          status: o.status,
          masterOrderId: o.masterOrderId ?? null,
          productId: o.productId ?? null,
          startedAt: o.startedAt ?? null,
          completedAt: o.completedAt ?? null,
          createdAt: o.createdAt,
          updatedAt: o.updatedAt,
        })),
      );

      // — P1: MasterOrderEntity —
      await ds.getRepository(MasterOrderEntity).save(
        store.masterOrders.map((m: any) => ({
          id: m.id,
          orderNo: m.orderNo,
          buyerId: m.buyerId,
          buyerNickname: m.buyerNickname,
          productOrderId: m.productOrderId ?? null,
          designOrderId: m.designOrderId ?? null,
          installationOrderId: m.installationOrderId ?? null,
          productTotal: m.productTotal,
          designTotal: m.designTotal,
          installTotal: m.installTotal,
          totalAmount: m.totalAmount,
          platformFee: m.platformFee ?? 0,
          status: m.status,
          address: m.address ?? null,
          remark: m.remark ?? null,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        })),
      );

      // — installer + designer profile（路由 requireInstaller/requireDesigner 查不到 profile 会 404）—
      const sprint5 = await import('./entities/sprint5');
      const InstallerProfileEntity = sprint5.InstallerProfileEntity;
      const DesignerProfileEntity = sprint5.DesignerProfileEntity;
      try {
        // 真实 seed id（50000 偏移）: installer=50014 (13600004001), designers=50012 (13700003001)/50013 (13700003002)
        await ds.createQueryBuilder().delete().from(InstallerProfileEntity).where('userId IN (?)', [[50014]]).execute();
        await ds.createQueryBuilder().delete().from(DesignerProfileEntity).where('userId IN (?)', [[50012, 50013]]).execute();
        await ds.getRepository(InstallerProfileEntity).save([
          { userId: 50014, realName: '安装刘师傅', phone: '13600004001', verified: 1, verifiedAt: new Date() },
        ]);
        await ds.getRepository(DesignerProfileEntity).save([
          { userId: 50012, realName: '设计小王', phone: '13700003001', verified: 1, verifiedAt: new Date() },
          { userId: 50013, realName: '创意工作室', phone: '13700003002', verified: 1, verifiedAt: new Date() },
        ]);
        log('  ✅ Seed(TypeORM): 补 installer/designer profile', 'info');
      } catch (err: any) {
        log('  ⚠️ Seed profile 写入失败: ' + err.message, 'warn');
      }

      log(
        `  ✅ Seed(TypeORM): 写 ${store.categories.length} 分类 / ${store.products.length} 商品 / ${store.users.length} 用户 / ${store.banners.length} Banner / ${store.searchKeywords.length} 热词 / ${store.addresses.length} 地址 / ${store.designDemands.length} 设计需求 到 MySQL`,
        'info',
      );
    } catch (err: any) {
      log('  ⚠️ Seed TypeORM 双写失败（内存模式继续）: ' + err.message, 'warn');
    }
  }

  log(
    `  ✅ Seed: ${store.users.length} 用户 / ${store.products.length} 商品 / ${store.categories.length} 分类 / ${store.banners.length} Banner / ${store.searchKeywords.length} 热词 / ${store.addresses.length} 地址 / ${store.designDemands.length} 设计需求`,
    'info',
  );
}

// ============ Getters ============
export const db = {
  get users() {
    return store.users;
  },
  set users(v) {
    store.users = v;
  },
  get sessions() {
    return store.sessions;
  },
  set sessions(v) {
    store.sessions = v;
  },
  get products() {
    return store.products;
  },
  set products(v) {
    store.products = v;
  },
  get categories() {
    return store.categories;
  },
  set categories(v) {
    store.categories = v;
  },
  get banners() {
    return store.banners;
  },
  set banners(v) {
    store.banners = v;
  },
  get searchKeywords() {
    return store.searchKeywords;
  },
  set searchKeywords(v) {
    store.searchKeywords = v;
  },
  get smsCodes() {
    return store.smsCodes;
  },
  // Sprint 2
  get carts() {
    return store.carts;
  },
  set carts(v) {
    store.carts = v;
  },
  get orders() {
    return store.orders;
  },
  set orders(v) {
    store.orders = v;
  },
  get orderItems() {
    return store.orderItems;
  },
  set orderItems(v) {
    store.orderItems = v;
  },
  get addresses() {
    return store.addresses;
  },
  set addresses(v) {
    store.addresses = v;
  },
  // Sprint 3
  get designFiles() {
    return store.designFiles;
  },
  set designFiles(v) {
    store.designFiles = v;
  },
  get designDemands() {
    return store.designDemands;
  },
  set designDemands(v) {
    store.designDemands = v;
  },
  // Sprint 3+ 扩展集合
  get designOrders() {
    return store.designOrders;
  },
  set designOrders(v) {
    store.designOrders = v;
  },
  get designDeliveries() {
    return store.designDeliveries;
  },
  set designDeliveries(v) {
    store.designDeliveries = v;
  },
  get designRevisionRequests() {
    return store.designRevisionRequests;
  },
  set designRevisionRequests(v) {
    store.designRevisionRequests = v;
  },
  get withdrawRequests() {
    return store.withdrawRequests;
  },
  set withdrawRequests(v) {
    store.withdrawRequests = v;
  },
  get reviews() {
    return store.reviews;
  },
  set reviews(v) {
    store.reviews = v;
  },
  get refunds() {
    return store.refunds;
  },
  set refunds(v) {
    store.refunds = v;
  },
  get installerWarrantyClaims() {
    return store.installerWarrantyClaims;
  },
  set installerWarrantyClaims(v) {
    store.installerWarrantyClaims = v;
  },
  get masterOrders() {
    return store.masterOrders;
  },
  set masterOrders(v) {
    store.masterOrders = v;
  },
  get installationDemands() {
    return store.installationDemands;
  },
  set installationDemands(v) {
    store.installationDemands = v;
  },
  get installationOrders() {
    return store.installationOrders;
  },
  set installationOrders(v) {
    store.installationOrders = v;
  },
  get vendorDeliveryAreas() {
    return store.vendorDeliveryAreas;
  },
  set vendorDeliveryAreas(v) {
    store.vendorDeliveryAreas = v;
  },
  get disputes() {
    return store.disputes;
  },
  set disputes(v) {
    store.disputes = v;
  },
  nextId,
};

// ============ 简单查询辅助 ============
export function findUserByPhone(phone: string): User | undefined {
  return store.users.find((u) => u.phone === phone);
}
export function findUserById(id: number): User | undefined {
  return store.users.find((u) => u.id === id && u.status === 1);
}
export function findProductById(id: number): Product | undefined {
  return store.products.find((p) => p.id === id && p.status === 1);
}

// ============ 🏪 内存：按地址找能配送的 vendor（供 findVendorsByAreaORM fallback 调用） ============
export function findVendorsByAreaMemory(params: {
  province: string;
  city: string;
  district?: string;
  excludeVendorId?: number;
}): User[] {
  const { province, city, district, excludeVendorId } = params;
  const vendors = store.users.filter((u) => {
    if (u.role !== 'vendor' || u.status !== 1) return false;
    if (excludeVendorId != null && excludeVendorId > 0 && u.id === excludeVendorId) return false;
    const areas = u.serviceAreas || [];
    if (areas.length === 0) return false;
    for (const a of areas) {
      // 省份必须匹配
      if (!a.province || a.province !== province) continue;
      // 城市匹配（vendor 配了 city 则必须相等；没配则视为覆盖整个省——但种子里都配了 city）
      if (city && a.city && a.city !== city) continue;
      // 区匹配（vendor 配了 district 且非 null 才参与区过滤；district=null 表示覆盖整个市）
      if (district && a.district && a.district !== district) continue;
      return true;
    }
    return false;
  });
  // 有 serviceLng 的排前面，然后按经度升序（简化距离就近）
  vendors.sort((a, b) => {
    const aNull = a.serviceLng == null ? 1 : 0;
    const bNull = b.serviceLng == null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    return (a.serviceLng ?? 0) - (b.serviceLng ?? 0);
  });
  return vendors;
}

// — stub exports for routes layer —
export function isTypeORMReady(): boolean {
  try {
    const { getDataSource } = require('./db-manager');
    const ds = getDataSource();
    return !!(ds && ds.isInitialized);
  } catch {
    return false;
  }
}
export function getStore() {
  return db;
}
