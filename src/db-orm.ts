// ============================================================================
// 🧩 DB-ORM — TypeORM 查询辅助层 + 内存 fallback
// 所有函数：MySQL 可用时走 TypeORM；不可用时 fallback db.ts 内存数组。
// 解决 decimal→number / json→数组 的 MySQL 原始返回值转换。
// ============================================================================
import { IsNull } from 'typeorm';
import { getDataSource } from './db-manager';
import { db } from './db';
import {
  CategoryEntity,
  ProductEntity,
  BannerEntity,
  SearchKeywordEntity,
  UserEntity,
  AddressEntity,
  CartEntity,
  OrderEntity,
  OrderItemEntity,
  DesignDemandEntity,
  DesignOrderEntity,
  InstallationDemandEntity,
  InstallationOrderEntity,
  VendorZonePermissionEntity,
  UserCouponEntity,
  MasterOrderEntity,
  PlatformTransactionEntity,
  genPlatformTxNo,
} from './entities';

// — Decimal / JSON 转换 —
function toNum(v: any): number {
  if (v === null || v === undefined) {
    return 0;
  }
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function toArr<T>(v: any): T[] {
  if (!v) {
    return [];
  }
  if (Array.isArray(v)) {
    return v;
  }
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return [];
    }
  }
  return [];
}

// — Product 格式化 —
function fmtProduct(p: ProductEntity | any, vendorName?: string): any {
  return {
    id: p.id,
    name: p.name,
    cover: p.cover ?? '',
    images: toArr<string>(p.images),
    price: toNum(p.price),
    stock: p.stock,
    sales: p.sales,
    categoryId: p.categoryId,
    vendorId: p.vendorId ?? null,
    vendorName: vendorName ?? (p.vendorId != null ? null : '平台自营'),
    tags: toArr<string>(p.tags),
    rating: toNum(p.rating),
    detail: p.detail ?? '',
    status: p.status,
    sort: p.sort,
    productType: p.productType ?? 'ready',
    designFee: p.designFee != null ? toNum(p.designFee) : null,
    printFee: p.printFee != null ? toNum(p.printFee) : null,
    needsDesignUpload: p.needsDesignUpload ? 1 : 0,
  };
}

// ============ Categories 树（含商品数） ============
export async function getCategoryTreeORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const catRepo = ds.getRepository(CategoryEntity);
    // 一次查全量启用中分类
    const cats = await catRepo.find({ where: { status: 1 }, order: { sort: 'ASC' } });
    // GROUP BY categoryId COUNT 避免 N+1
    const rows: any[] = await ds.query(
      'SELECT categoryId, COUNT(*) AS cnt FROM products WHERE status = 1 AND categoryId IS NOT NULL GROUP BY categoryId',
    );
    const countMap = new Map<number, number>();
    for (const r of rows) {
      const cid = r.categoryId ?? r.categoryid;
      const cnt = typeof r.cnt === 'string' ? parseInt(r.cnt, 10) : Number(r.cnt);
      if (cid) {
        countMap.set(Number(cid), cnt);
      }
    }

    const map = new Map<number, any>();
    cats.forEach((c) =>
      map.set(c.id, {
        id: c.id,
        parentId: c.parentId,
        name: c.name,
        icon: c.icon ?? '',
        sort: c.sort,
        children: [] as any[],
      }),
    );
    const tree: any[] = [];
    map.forEach((node) => {
      if (node.parentId && map.has(node.parentId)) {
        map.get(node.parentId).children.push(node);
      } else {
        tree.push(node);
      }
    });
    return tree
      .sort((a, b) => a.sort - b.sort)
      .map((n) => ({
        id: String(n.id),
        name: n.name,
        icon: n.icon,
        sort: n.sort,
        children: n.children
          .sort((a: any, b: any) => a.sort - b.sort)
          .map((c: any) => ({
            id: String(c.id),
            name: c.name,
            icon: c.icon,
            sort: c.sort,
            count: countMap.get(c.id) || 0,
          })),
      }));
  }
  // — 内存 fallback — 复用 db.ts 逻辑（同步）
  const productCount = new Map<number, number>();
  db.products.forEach((p) => {
    if (p.categoryId) {
      productCount.set(p.categoryId, (productCount.get(p.categoryId) || 0) + 1);
    }
  });
  const map = new Map<number, any>();
  db.categories.filter((c) => c.status === 1).forEach((c) => map.set(c.id, { ...c, children: [] }));
  const tree: any[] = [];
  map.forEach((node) => {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId).children.push(node);
    } else {
      tree.push(node);
    }
  });
  return tree
    .sort((a, b) => a.sort - b.sort)
    .map((n) => ({
      id: String(n.id),
      name: n.name,
      icon: n.icon || '',
      sort: n.sort,
      children: n.children
        .sort((a: any, b: any) => a.sort - b.sort)
        .map((c: any) => ({
          id: String(c.id),
          name: c.name,
          icon: c.icon || '',
          sort: c.sort,
          count: productCount.get(c.id) || 0,
        })),
    }));
}

// ============ Banners（启用中 + 排序） ============
export async function getBannersORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const banners = await ds.getRepository(BannerEntity).find({
      where: { status: 1 },
      order: { sort: 'ASC' },
    });
    return banners.map((b) => ({
      id: String(b.id),
      image: b.image,
      title: b.title,
      linkType: b.linkType,
      link: b.link,
    }));
  }
  return db.banners
    .filter((b) => b.status === 1)
    .sort((a, b) => a.sort - b.sort)
    .map((b) => ({
      id: String(b.id),
      image: b.image,
      title: b.title,
      linkType: b.linkType as any,
      link: b.link,
    }));
}

// ============ Search Keywords ============
export async function getSearchKeywordsORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const list = await ds.getRepository(SearchKeywordEntity).find({
      where: { status: 1 },
      order: { sort: 'ASC' },
    });
    return list.map((k) => k.keyword);
  }
  return db.searchKeywords.sort((a, b) => a.sort - b.sort).map((k) => k.keyword);
}

// ============ Products 列表（支持 categoryId 包含 L1→L2 + keyword + productType + 分页） ============
export interface ProductListParams {
  categoryId?: number;
  keyword?: string;
  productType?: string; // 'ready' | 'custom' | 'combo'
  page: number;
  pageSize: number;
}
export async function getProductsORM(params: ProductListParams) {
  const ds = getDataSource();
  const { categoryId, keyword, productType, page, pageSize } = params;

  if (ds && ds.isInitialized) {
    const catRepo = ds.getRepository(CategoryEntity);
    const prodRepo = ds.getRepository(ProductEntity);

    // 决定 categoryId 集合
    let includeIds: number[] | null = null;
    if (categoryId) {
      includeIds = [categoryId];
      const cat = await catRepo.findOne({ where: { id: categoryId } });
      if (cat && !cat.parentId) {
        const subs = await catRepo.find({ where: { parentId: categoryId } });
        subs.forEach((s) => includeIds!.push(s.id));
      }
    }

    const qb = prodRepo.createQueryBuilder('p').where('p.status = 1');
    if (includeIds && includeIds.length > 0) {
      qb.andWhere('p.categoryId IN (:...cids)', { cids: includeIds });
    }
    if (keyword) {
      qb.andWhere('LOWER(p.name) LIKE :kw', { kw: `%${keyword.toLowerCase()}%` });
    }
    if (productType && ['ready', 'custom', 'combo'].includes(productType)) {
      qb.andWhere('p.productType = :pt', { pt: productType });
    }

    const [rows, total] = await qb
      .orderBy('p.sort', 'ASC')
      .addOrderBy('p.sales', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return {
      list: rows.map((p) => fmtProduct(p as any)),
      total,
      page,
      pageSize,
      hasMore: (page - 1) * pageSize + rows.length < total,
    };
  }

  // — 内存 fallback —
  let list = db.products.filter((p) => p.status === 1);
  if (categoryId) {
    const includeIds = new Set<number>([categoryId]);
    const cat = db.categories.find((c) => c.id === categoryId);
    if (cat && !cat.parentId) {
      db.categories.filter((c) => c.parentId === categoryId).forEach((c) => includeIds.add(c.id));
    }
    list = list.filter((p) => p.categoryId && includeIds.has(p.categoryId));
  }
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter((p) => p.name.toLowerCase().includes(kw));
  }
  if (productType && ['ready', 'custom', 'combo'].includes(productType)) {
    list = list.filter((p) => (p as any).productType === productType);
  }
  const total = list.length;
  const start = (page - 1) * pageSize;
  const pageData = list.slice(start, start + pageSize);
  return {
    list: pageData.map((p) => fmtProduct(p as any)),
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total,
  };
}

// ============ 单个 product ============
export async function getProductByIdORM(id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const p = await ds.getRepository(ProductEntity).findOne({ where: { id, status: 1 } });
    if (!p) {
      return null;
    }
    let vendorName: string | undefined;
    if (p.vendorId != null) {
      const u = await ds.getRepository(UserEntity).findOne({ where: { id: p.vendorId } });
      vendorName = u?.nickname || u?.phone || `供应商#${p.vendorId}`;
    }
    return fmtProduct(p, vendorName);
  }
  const p = db.products.find((p) => p.id === id && p.status === 1);
  return p ? fmtProduct(p, '平台自营') : null;
}

// ============ 新品 arrivals（按 sales DESC） ============
export async function getNewArrivalsORM(limit = 6) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const rows = await ds.getRepository(ProductEntity).find({
      where: { status: 1 },
      order: { sales: 'DESC' },
      take: limit,
    });
    return rows.map((p) => fmtProduct(p as any));
  }
  return db.products
    .filter((p) => p.status === 1)
    .sort((a, b) => b.sales - a.sales)
    .slice(0, limit)
    .map((p) => fmtProduct(p as any));
}

// ============ User helpers ============
function fmtUser(u: UserEntity | any) {
  // 🛡️ 敏感字段：wechatAccessToken / wechatRefreshToken 绝对不对外暴露
  const safeAccessToken = undefined;
  return {
    id: u.id,
    phone: u.phone,
    nickname: u.nickname ?? '',
    avatar: u.avatar ?? '',
    role: u.role,
    level: u.level,
    points: u.points,
    wallet: toNum(u.wallet),
    coupons: u.coupons,
    status: u.status,
    // — 微信身份（对外只暴露"是否绑定"，不暴露 token 等敏感字段）—
    openid: u.openid ?? null,
    unionid: u.unionid ?? null,
    wechatNickname: u.wechatNickname ?? null,
    wechatAvatar: u.wechatAvatar ?? null,
    wechatBound: !!(u.openid || u.unionid),  // 前端用来判断要不要弹"获取手机号"
    phoneBound: !!u.phone,                    // 是否绑了手机号（微信新用户 phone 可能为 null）
    createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt,
    updatedAt: u.updatedAt instanceof Date ? u.updatedAt.toISOString() : u.updatedAt,
  };
}

export async function findUserByPhoneORM(phone: string) {
  const u = await findUserByPhoneWithHashORM(phone);
  if (!u) {
    return null;
  }
  const { passwordHash, ...safe } = u;
  return safe as any;
}

/** 含 passwordHash — 仅 login-password/register 使用 */
export async function findUserByPhoneWithHashORM(phone: string) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(UserEntity).findOne({ where: { phone } });
  }
  return db.users.find((u) => u.phone === phone) ?? null;
}

/** 用 account 查用户（account 可以是 phone 或 nickname）—— 管理后台登录用 */
export async function findUserByAccountWithHashORM(account: string) {
  try {
    const ds = getDataSource();
    if (ds && ds.isInitialized) {
      const byPhone = await ds.getRepository(UserEntity).findOne({ where: { phone: account } });
      if (byPhone) return byPhone;
      const byNick = await ds.getRepository(UserEntity).findOne({ where: { nickname: account } });
      if (byNick) return byNick;
      return null;
    }
  } catch {}
  return db.users.find((u) => u.phone === account || u.nickname === account) ?? null;
}

export async function findUserByIdORM(id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const u = await ds.getRepository(UserEntity).findOne({ where: { id, status: 1 } });
    return u ? fmtUser(u) : null;
  }
  const u = db.users.find((u) => u.id === id && u.status === 1);
  return u ? fmtUser(u) : null;
}

/** 含 passwordHash — 仅 change-password 等需要 hash 比较的内部路由使用 */
export async function findUserByIdWithHashORM(id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(UserEntity).findOne({ where: { id, status: 1 } });
  }
  return db.users.find((u) => u.id === id && u.status === 1) ?? null;
}

// — 微信身份体系查询（WeChat Auth 专用）—
/** 含 passwordHash — 通过 unionid 查（优先级最高，跨端统一） */
export async function findUserByUnionidORM(unionid: string) {
  if (!unionid) return null;
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(UserEntity).findOne({ where: { unionid, status: 1 } });
  }
  return db.users.find((u: any) => u.unionid === unionid && u.status === 1) ?? null;
}

/** 含 passwordHash — 通过 openid 查（小程序/APP openid 各自不同，fallback 用） */
export async function findUserByOpenidORM(openid: string) {
  if (!openid) return null;
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(UserEntity).findOne({ where: { openid, status: 1 } });
  }
  return db.users.find((u: any) => u.openid === openid && u.status === 1) ?? null;
}

export async function createUserORM(data: {
  phone: string;
  nickname: string;
  passwordHash?: string;
  role?: string;
  // — 微信身份（可选，微信登录自动注册时传入）—
  openid?: string;
  unionid?: string;
  wechatNickname?: string;
  wechatAvatar?: string;
}) {
  const ds = getDataSource();
  const now = new Date().toISOString();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(UserEntity);
    const user = repo.create({
      phone: data.phone,
      nickname: data.nickname,
      passwordHash: data.passwordHash,
      role: data.role ?? 'consumer',
      // — 微信身份字段（创建时一并写入）—
      openid: data.openid,
      unionid: data.unionid,
      wechatNickname: data.wechatNickname,
      wechatAvatar: data.wechatAvatar,
      level: 1,
      points: 0,
      wallet: 0,
      coupons: 0,
      status: 1,
    });
    const saved = await repo.save(user);
    return fmtUser(saved);
  }
  const id = Math.max(0, ...db.users.map((u) => u.id)) + 1;
  const newUser = {
    id,
    phone: data.phone,
    nickname: data.nickname,
    passwordHash: data.passwordHash,
    role: (data.role ?? 'consumer') as any,
    // — 微信身份字段（内存 mock 也带上）—
    openid: data.openid,
    unionid: data.unionid,
    wechatNickname: data.wechatNickname,
    wechatAvatar: data.wechatAvatar,
    level: 1,
    points: 0,
    wallet: 0,
    coupons: 0,
    status: 1,
    createdAt: now,
    updatedAt: now,
  };
  db.users.push(newUser as any);
  return fmtUser(newUser);
}

export async function updateUserORM(id: number, patch: Partial<UserEntity>) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    await ds.getRepository(UserEntity).update(id, { ...patch, updatedAt: new Date() });
    const u = await ds.getRepository(UserEntity).findOne({ where: { id } });
    return u ? fmtUser(u) : null;
  }
  const u = db.users.find((u) => u.id === id);
  if (!u) {
    return null;
  }
  Object.assign(u, patch, { updatedAt: new Date().toISOString() });
  return fmtUser(u);
}

// ============ Address helpers ============
export async function listAddressesORM(userId: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(AddressEntity).find({
      where: { userId },
      order: { isDefault: 'DESC', id: 'DESC' },
    });
  }
  return db.addresses
    .filter((a) => a.userId === userId)
    .sort((a, b) => (b.isDefault || 0) - (a.isDefault || 0));
}

export async function createAddressORM(userId: number, data: any) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(AddressEntity);
    // isDefault 原子处理：设新默认前先清同用户其他
    if (data.isDefault) {
      await repo
        .createQueryBuilder()
        .update()
        .set({ isDefault: 0 })
        .where('userId = :uid', { uid: userId })
        .execute();
    }
    const e = repo.create({ userId, ...data, isDefault: data.isDefault ? 1 : 0 });
    return await repo.save(e);
  }
  if (data.isDefault) {
    db.addresses.filter((a) => a.userId === userId).forEach((a) => (a.isDefault = 0));
  }
  const now = new Date().toISOString();
  const id = Math.max(0, ...db.addresses.map((a) => a.id)) + 1;
  const addr = {
    id,
    userId,
    ...data,
    isDefault: data.isDefault ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  };
  db.addresses.push(addr);
  return addr;
}

export async function updateAddressORM(userId: number, id: number, patch: any) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(AddressEntity);
    const existing = await repo.findOne({ where: { id, userId } });
    if (!existing) {
      return null;
    }
    if (patch.isDefault) {
      await repo
        .createQueryBuilder()
        .update()
        .set({ isDefault: 0 })
        .where('userId = :uid AND id != :id', { uid: userId, id })
        .execute();
    }
    await repo.update(id, { ...patch, updatedAt: new Date() });
    return await repo.findOne({ where: { id } });
  }
  const a = db.addresses.find((a) => a.id === id && a.userId === userId);
  if (!a) {
    return null;
  }
  Object.assign(a, patch, { updatedAt: new Date().toISOString() });
  if (patch.isDefault) {
    db.addresses
      .filter((x) => x.userId === userId && x.id !== id)
      .forEach((x) => (x.isDefault = 0));
  }
  return a;
}

export async function deleteAddressORM(userId: number, id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const r = await ds.getRepository(AddressEntity).delete({ id, userId });
    return r.affected ? r.affected > 0 : null;
  }
  const idx = db.addresses.findIndex((a) => a.id === id && a.userId === userId);
  if (idx < 0) {
    return false;
  }
  db.addresses.splice(idx, 1);
  return true;
}

export async function setAddressDefaultORM(userId: number, id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(AddressEntity);
    const existing = await repo.findOne({ where: { id, userId } });
    if (!existing) {
      return null;
    }
    await repo
      .createQueryBuilder()
      .update()
      .set({ isDefault: 0 })
      .where('userId = :uid', { uid: userId })
      .execute();
    await repo.update(id, { isDefault: 1, updatedAt: new Date() });
    return await repo.findOne({ where: { id } });
  }
  const a = db.addresses.find((a) => a.id === id && a.userId === userId);
  if (!a) {
    return null;
  }
  db.addresses.filter((x) => x.userId === userId).forEach((x) => (x.isDefault = 0));
  a.isDefault = 1;
  return a;
}

// ============ Cart helpers ============
export async function listCartORM(userId: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const cartRepo = ds.getRepository(CartEntity);
    const productRepo = ds.getRepository(ProductEntity);
    const carts = await cartRepo.find({ where: { userId } });
    if (carts.length === 0) {
      return [];
    }
    const pids = carts.map((c) => c.productId);
    const products = await productRepo.find({ where: pids.map((id) => ({ id })) });
    const prodMap = new Map(products.map((p) => [p.id, p]));
    return carts.map((c) => ({
      ...c,
      product: prodMap.get(c.productId)
        ? {
            id: prodMap.get(c.productId)!.id,
            name: prodMap.get(c.productId)!.name,
            cover: prodMap.get(c.productId)!.cover,
            price: toNum(prodMap.get(c.productId)!.price),
            stock: prodMap.get(c.productId)!.stock,
          }
        : undefined,
    }));
  }
  return db.carts
    .filter((c) => c.userId === userId)
    .map((c) => {
      const p = db.products.find((p) => p.id === c.productId);
      return {
        ...c,
        product: p
          ? { id: p.id, name: p.name, cover: p.cover, price: p.price, stock: p.stock }
          : undefined,
      };
    });
}

export async function addCartItemORM(
  userId: number,
  productId: number,
  specId: string | undefined,
  quantity: number,
) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const cartRepo = ds.getRepository(CartEntity);
    const existing = await cartRepo.findOne({
      where: { userId, productId, specId: specId ?? IsNull() },
    });
    let cart;
    if (existing) {
      existing.quantity = Math.min(99, existing.quantity + quantity);
      cart = await cartRepo.save(existing);
    } else {
      cart = await cartRepo.save(
        cartRepo.create({ userId, productId, specId, quantity, selected: 1 }),
      );
    }
    const p = await ds.getRepository(ProductEntity).findOne({ where: { id: productId } });
    return {
      ...cart,
      product: p
        ? { id: p.id, name: p.name, cover: p.cover, price: toNum(p.price), stock: p.stock }
        : undefined,
    };
  }
  let cart = db.carts.find(
    (c) => c.userId === userId && c.productId === productId && (c.specId || '') === (specId || ''),
  );
  if (cart) {
    cart.quantity = Math.min(99, cart.quantity + quantity);
  } else {
    const id = Math.max(0, ...db.carts.map((c) => c.id)) + 1;
    cart = { id, userId, productId, specId, quantity, selected: 1 };
    db.carts.push(cart);
  }
  const p = db.products.find((p) => p.id === productId);
  return {
    ...cart,
    product: p
      ? { id: p.id, name: p.name, cover: p.cover, price: p.price, stock: p.stock }
      : undefined,
  };
}

export async function updateCartItemORM(
  userId: number,
  id: number,
  patch: { quantity?: number; selected?: number },
) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(CartEntity);
    const existing = await repo.findOne({ where: { id, userId } });
    if (!existing) {
      return null;
    }
    if (patch.quantity !== undefined) {
      existing.quantity = Math.max(1, Math.min(99, patch.quantity));
    }
    if (patch.selected !== undefined) {
      existing.selected = patch.selected ? 1 : 0;
    }
    return await repo.save(existing);
  }
  const c = db.carts.find((c) => c.id === id && c.userId === userId);
  if (!c) {
    return null;
  }
  if (patch.quantity !== undefined) {
    c.quantity = Math.max(1, Math.min(99, patch.quantity));
  }
  if (patch.selected !== undefined) {
    c.selected = patch.selected ? 1 : 0;
  }
  return c;
}

export async function deleteCartItemORM(userId: number, id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const r = await ds.getRepository(CartEntity).delete({ id, userId });
    return r.affected ? r.affected > 0 : null;
  }
  const idx = db.carts.findIndex((c) => c.id === id && c.userId === userId);
  if (idx < 0) {
    return false;
  }
  db.carts.splice(idx, 1);
  return true;
}

export async function selectAllCartORM(userId: number, selected: boolean) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    await ds
      .getRepository(CartEntity)
      .createQueryBuilder()
      .update()
      .set({ selected: selected ? 1 : 0 })
      .where('userId = :uid', { uid: userId })
      .execute();
    return true;
  }
  db.carts.filter((c) => c.userId === userId).forEach((c) => (c.selected = selected ? 1 : 0));
  return true;
}

// — 订单号生成（工具函数）—
function genOrderNo(): string {
  const now = new Date();
  const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = String(Math.floor(Math.random() * 999999)).padStart(6, '0');
  return `LJL${d}${rand}`;
}

// ============ Order helpers ============

/** 创建订单 — TypeORM 事务版（最核心） */
export async function createOrderORM(
  userId: number,
  params: {
    addressId?: number;
    remark?: string;
    itemIds?: number[];
    couponId?: number;
    discount?: number;
    // 📐 P1：买家合规校验
    validationScore?: number;
    validationIssues?: Array<{ type: string; message: string; level: 'info' | 'warning' | 'error' }>;
    buyerDesignFileUrl?: string;
    // 🏗️ P0：主订单关联（MasterOrder 聚合根）
    masterOrderId?: number;
  },
) {
  const ds = getDataSource();
  const {
    addressId, remark, itemIds, couponId,
    validationScore, validationIssues, buyerDesignFileUrl, masterOrderId,
  } = params;

  if (ds && ds.isInitialized) {
    return await ds.transaction(async (manager) => {
      const cartRepo = manager.getRepository(CartEntity);
      const productRepo = manager.getRepository(ProductEntity);
      const addrRepo = manager.getRepository(AddressEntity);
      const orderRepo = manager.getRepository(OrderEntity);
      const orderItemRepo = manager.getRepository(OrderItemEntity);

      // 1. 取购物车项（指定 itemIds 或 selected=1）
      let cartItems;
      if (Array.isArray(itemIds) && itemIds.length > 0) {
        cartItems = await cartRepo
          .createQueryBuilder('c')
          .where('c.userId = :uid AND c.id IN (:...ids)', { uid: userId, ids: itemIds })
          .getMany();
      } else {
        cartItems = await cartRepo.find({ where: { userId, selected: 1 } });
      }
      if (cartItems.length === 0) {
        throw new Error('CART_EMPTY');
      }

      // 2. 地址（指定 or 默认）
      let addr;
      if (addressId) {
        addr = await addrRepo.findOne({ where: { id: addressId, userId } });
      } else {
        addr = await addrRepo.findOne({ where: { userId, isDefault: 1 } });
      }
      if (!addr) {
        throw new Error('NO_ADDRESS');
      }

      // 3. 查商品快照 + 算金额 + 🔒 原子条件扣库存 + 累加销量
      const snapshots: {
        productId: number;
        productName: string;
        productCover?: string;
        quantity: number;
        price: number;
        vendorId?: number;
      }[] = [];
      for (const c of cartItems) {
        // 悲观锁读商品（与 coupon.ts 风格一致，防止查-扣间隙被其他事务篡改）
        const p = await productRepo
          .createQueryBuilder('p')
          .where('p.id = :id', { id: c.productId })
          .setLock('pessimistic_read')
          .getOne();
        if (!p || p.status !== 1) {
          continue;
        }
        // 🔒 条件更新：WHERE stock >= quantity — 原子防超卖
        // 同时 sales += quantity — 销量和库存扣减在同一 UPDATE 内原子完成
        const upd = await productRepo
          .createQueryBuilder()
          .update()
          .set({
            stock: () => `stock - ${c.quantity}`,
            sales: () => `sales + ${c.quantity}`,
          })
          .where('id = :id AND stock >= :qty', { id: p.id, qty: c.quantity })
          .execute();
        if (upd.affected === 0) {
          throw new Error(`STOCK_INSUFFICIENT:${p.name}`);
        }
        snapshots.push({
          productId: p.id,
          productName: p.name,
          productCover: p.cover,
          productType: (p as any).productType || 'ready',
          quantity: c.quantity,
          price: toNum(p.price),
          vendorId: p.vendorId,
        });
      }
      if (snapshots.length === 0) {
        throw new Error('PRODUCT_OFFLINE');
      }

      // 3.5 🆕 P2-3：Product 没绑 vendorId 且是定制类商品 → 按买家地址智能匹配能送到的 vendor
      // 平台自营商品（vendorId=null + productType=ready）跳过匹配，保持 null 走 '_platform' 分组
      for (const s of snapshots) {
        if (s.vendorId == null && s.productType !== 'ready') {
          const matched = await findVendorsByAreaORM(
            {
              province: addr.province,
              city: addr.city,
              district: addr.district,
            },
            manager, // 事务内用同一个 EntityManager
          );
          if (matched.length > 0) {
            s.vendorId = matched[0].id; // 第一个匹配的（serviceLng 最小，优先就近）
          } else {
            // 定制类商品没匹配到 vendor 也不硬报错，让订单以平台自营状态继续
            console.warn(`[Order] custom/combo product ${s.productId} 未匹配到区域 vendor，以平台自营状态继续`);
          }
        }
      }

      // 4. 🛠️ Sprint 10.7：按 vendorId 分组拆单
      // null vendorId（平台自营）归为 '_platform' 一组
      const groups = new Map<string, typeof snapshots>();
      for (const s of snapshots) {
        const key = s.vendorId == null ? '_platform' : String(s.vendorId);
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(s);
      }

      // 5. 每组建独立订单 + 订单项
      const zoneRepo = manager.getRepository(VendorZonePermissionEntity);
      const savedOrders: any[] = [];

      // 🛠️ Week 5：优惠券校验（只校验一次，作用于整单，折扣只扣第一组订单）
      let couponApplied = false;
      let actualDiscount = 0;
      let validCouponId: number | undefined;
      if (couponId) {
        try {
          const ucRepo = manager.getRepository(UserCouponEntity);
          const uc = await ucRepo.findOne({ where: { id: couponId, userId, status: 'unused' } });
          if (uc && new Date(uc.expireTime).getTime() > Date.now()) {
            // 先算整单商品合计（校验门槛）
            const allTotal = snapshots.reduce((s, x) => s + toNum(x.price) * x.quantity, 0);
            if (toNum(uc.minAmount) <= allTotal) {
              // 后端重新算折扣 —— 防前端作弊
              if (uc.type === 'amount') {
                actualDiscount = Math.min(toNum(uc.value), allTotal);
              } else if (uc.type === 'percent') {
                actualDiscount = Math.min(Math.floor(allTotal * toNum(uc.value) / 100), allTotal);
              }
              actualDiscount = Number(actualDiscount.toFixed(2));
              validCouponId = uc.id;
            }
          }
        } catch { /* 优惠券处理失败不阻断主流程 */ }
      }

      for (const [vendorKey, groupItems] of groups) {
        let groupTotal = 0;
        for (const s of groupItems) {
          groupTotal += toNum(s.price) * s.quantity;
        }
        const vendorId = vendorKey === '_platform' ? null : Number(vendorKey);

        // 🛠️ 运费规则：自配送/自提/快递全含在商品价里，运费固定 ¥0
        // 物流大件（德邦/安能等到付）暂时不经过此接口计算，供应商发单时自己标记
        let shippingFee = 0;
        let shippingType = 'express';
        if (vendorId !== null) {
          // 查 vendor_zone_permissions 表：该供应商是否在收货地址的县区有开通权限
          // 命中 → 自配送；没命中 → fallback 快递（到付大件除外）
          const zp = await zoneRepo
            .createQueryBuilder('z')
            .where('z.vendorId = :v AND z.enabled = 1 AND z.status = :s', { v: vendorId, s: 'active' })
            .andWhere('z.province = :p AND z.city = :c', { p: addr.province, c: addr.city })
            .getMany();
          if (zp && zp.length > 0) {
            // 县区权限命中，检查具体县区
            const matchedDistrict = zp.find((z: any) => z.district === addr.district);
            shippingType = matchedDistrict ? 'self_delivery' : 'express';
          }
        }

        // 🛠️ Week 5：优惠券只扣第一组订单（整单只抵一次）
        let orderDiscount = 0;
        let orderTotalAmount = Number(groupTotal.toFixed(2)) + shippingFee;
        if (!couponApplied && actualDiscount > 0) {
          // 第一单吸收全部折扣 —— 让 finalTotal 不会出现负数
          orderDiscount = Math.min(actualDiscount, orderTotalAmount);
          orderTotalAmount = Number((orderTotalAmount - orderDiscount).toFixed(2));
          couponApplied = true;
        }

        const order = orderRepo.create({
          orderNo: genOrderNo(),
          userId,
          vendorId,
          status: 'pending',
          totalAmount: orderTotalAmount,
          discount: orderDiscount,
          shippingFee,
          shippingType, // 🆕 Sprint 10：从 VendorDeliveryArea 动态取
          receiverName: addr.name,
          receiverPhone: addr.phone,
          receiverAddress: `${addr.province}${addr.city}${addr.district}${addr.detail}`,
          remark: remark || undefined,
          // 🛠️ Week 5：记录 couponId，支付成功后回写 UserCoupon
          couponId: validCouponId || undefined,
          // 📐 P1：买家合规校验（多 vendor 拆单时每个 Order 都带上）
          validationScore: validationScore ?? undefined,
          validationIssues: Array.isArray(validationIssues) && validationIssues.length > 0
            ? validationIssues : undefined,
          buyerDesignFileUrl: buyerDesignFileUrl || undefined,
          // 🏗️ P0：主订单关联
          masterOrderId: masterOrderId || undefined,
        } as any);
        const saved = await orderRepo.save(order);
        const savedId = (saved as any).id;

        for (const s of groupItems) {
          await orderItemRepo.save(
            orderItemRepo.create({ orderId: savedId, vendorId: s.vendorId, ...s }),
          );
        }
        savedOrders.push(saved);
      }

      // 6. 清购物车
      const cartIds = cartItems.map((c) => c.id);
      await cartRepo
        .createQueryBuilder()
        .delete()
        .where('id IN (:...ids)', { ids: cartIds })
        .execute();

      // 🛠️ 返回数组（单 vendor → 长度 1；多 vendor → 长度 N）
      return { orders: savedOrders };
    });
  }

  // — 内存 fallback —
  let cartItems = db.carts.filter((c) => c.userId === userId && c.selected === 1);
  if (Array.isArray(itemIds) && itemIds.length > 0) {
    const set = new Set(itemIds.map(Number));
    cartItems = db.carts.filter((c) => c.userId === userId && set.has(c.id));
  }
  if (cartItems.length === 0) {
    throw new Error('CART_EMPTY');
  }

  const addr = addressId
    ? db.addresses.find((a) => a.id === Number(addressId) && a.userId === userId)
    : db.addresses.find((a) => a.userId === userId && a.isDefault === 1);
  if (!addr) {
    throw new Error('NO_ADDRESS');
  }

  let totalAmount = 0;
  const snapshots = cartItems
    .map((c) => {
      const p = db.products.find((p) => p.id === c.productId);
      if (!p) {
        return null;
      }
      totalAmount += p.price * c.quantity;
      return {
        productId: p.id,
        productName: p.name,
        productCover: p.cover,
        quantity: c.quantity,
        price: p.price,
        vendorId: (p as any).vendorId,
      };
    })
    .filter(Boolean) as any[];
  if (snapshots.length === 0) {
    throw new Error('PRODUCT_OFFLINE');
  }

  // 拆单（内存 fallback）
  const groups = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    const key = s.vendorId == null ? '_platform' : String(s.vendorId);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(s);
  }

  // 🛠️ Week 5：优惠券（内存 fallback 简化版 — 不从 db.coupons 查）
  let couponApplied = false;
  let actualDiscount = 0;
  if (couponId && couponId > 0) {
    // 内存 fallback 下无法校验真实券信息，这里按前端传的值直接算整单折扣兜底
    try { actualDiscount = Number(params.discount) || 0; } catch {}
  }

  const savedOrders: any[] = [];
  for (const [vendorKey, groupItems] of groups) {
    let groupTotal = 0;
    for (const s of groupItems) {
      groupTotal += s.price * s.quantity;
    }
    const shippingFee = 0; // 运费全含在商品价里
    const vendorId = vendorKey === '_platform' ? null : Number(vendorKey);

    // 🛠️ Week 5：第一单吸收优惠券折扣
    let orderDiscount = 0;
    let orderTotalAmount = Number(groupTotal.toFixed(2)) + shippingFee;
    let orderCouponId: number | undefined;
    if (!couponApplied && actualDiscount > 0) {
      orderDiscount = Math.min(actualDiscount, orderTotalAmount);
      orderTotalAmount = Number((orderTotalAmount - orderDiscount).toFixed(2));
      couponApplied = true;
      orderCouponId = couponId;
    }

    const order = {
      id: db.nextId('orders'),
      orderNo: genOrderNo(),
      userId,
      vendorId,
      status: 'pending',
      totalAmount: orderTotalAmount,
      discount: orderDiscount,
      shippingFee,
      receiverName: addr.name,
      receiverPhone: addr.phone,
      receiverAddress: `${addr.province}${addr.city}${addr.district}${addr.detail}`,
      remark: remark || undefined,
      couponId: orderCouponId,
      masterOrderId: masterOrderId || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    db.orders.push(order as any);
    for (const s of groupItems) {
      db.orderItems.push({
        id: db.nextId('orderItems'),
        orderId: order.id,
        vendorId: s.vendorId,
        ...s,
      });
    }
    savedOrders.push(order);
  }
  cartItems.forEach((c) => {
    db.carts = db.carts.filter((x) => x.id !== c.id);
  });
  return { orders: savedOrders };
}

export async function listOrdersORM(userId: number, status?: string) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const orderRepo = ds.getRepository(OrderEntity);
    const itemRepo = ds.getRepository(OrderItemEntity);
    const where: any = { userId };
    if (status) {
      where.status = status;
    }
    const orders = await orderRepo.find({ where, order: { id: 'DESC' } });
    if (orders.length === 0) {
      return [];
    }
    const oids = orders.map((o) => o.id);
    const items = await itemRepo
      .createQueryBuilder('i')
      .where('i.orderId IN (:...oids)', { oids })
      .getMany();
    const itemMap = new Map<number, any[]>();
    items.forEach((i) => {
      if (!itemMap.has(i.orderId)) {
        itemMap.set(i.orderId, []);
      }
      itemMap.get(i.orderId)!.push(i);
    });
    return orders.map((o) => ({ ...o, items: itemMap.get(o.id) || [] }));
  }
  let list = db.orders.filter((o) => o.userId === userId);
  if (status) {
    list = list.filter((o) => o.status === status);
  }
  list.sort((a, b) => b.id - a.id);
  return list.map((o) => ({ ...o, items: db.orderItems.filter((i) => i.orderId === o.id) }));
}

export async function getOrderDetailORM(userId: number, id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const o = await ds.getRepository(OrderEntity).findOne({ where: { id, userId } });
    if (!o) {
      return null;
    }
    const items = await ds.getRepository(OrderItemEntity).find({ where: { orderId: id } });

    // 批量查 vendorName：order.vendorId + 每个 item.vendorId
    const vendorIds = new Set<number>();
    if (o.vendorId != null) {
      vendorIds.add(o.vendorId);
    }
    for (const it of items) {
      if (it.vendorId != null) {
        vendorIds.add(it.vendorId);
      }
    }
    const vendorMap: Map<number, string> = new Map();
    if (vendorIds.size > 0) {
      const users = await ds
        .getRepository(UserEntity)
        .createQueryBuilder('u')
        .where('u.id IN (:...ids)', { ids: [...vendorIds] })
        .getMany();
      for (const u of users) {
        vendorMap.set(u.id, u.nickname || u.phone || `供应商#${u.id}`);
      }
    }

    const orderVendorName = o.vendorId != null ? (vendorMap.get(o.vendorId) ?? null) : null;
    const itemsWithVendor = items.map((it) => ({
      ...it,
      vendorName: it.vendorId != null ? (vendorMap.get(it.vendorId) ?? null) : null,
    }));

    return { ...o, vendorName: orderVendorName, items: itemsWithVendor };
  }
  const order = db.orders.find((o) => o.id === id && o.userId === userId);
  if (!order) {
    return null;
  }
  return { ...order, vendorName: null, items: db.orderItems.filter((i) => i.orderId === id) };
}

export async function updateOrderStatusORM(
  userId: number,
  id: number,
  newStatus: string,
  extra?: Record<string, any>,
) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(OrderEntity);
    const existing = await repo.findOne({ where: { id, userId } });
    if (!existing) {
      return null;
    }
    const patch: any = { status: newStatus, updatedAt: new Date() };
    Object.assign(patch, extra);
    await repo.update(id, patch);
    return await repo.findOne({ where: { id } });
  }
  const order = db.orders.find((o) => o.id === id && o.userId === userId);
  if (!order) {
    return null;
  }
  order.status = newStatus as any;
  Object.assign(order, extra, { updatedAt: new Date().toISOString() });
  return order;
}

// ============ Design Demand helpers ============

export async function publishDemandORM(userId: number, data: any) {
  const ds = getDataSource();
  const now = new Date();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(DesignDemandEntity);
    const e = repo.create({
      userId,
      orderNo: 'SJ' + Date.now(),
      productId: data.productId,
      productName: data.productName,
      demandText: data.demandText.trim(),
      budget: data.budget,
      contactPhone: data.contactPhone,
      wechat: data.wechat,
      deliveryTime: data.deliveryTime,
      status: 'pending',
      statusText: '待接单',
      // 📐 Sprint 9：结构化字段
      budgetMin: data.budgetMin ?? null,
      budgetMax: data.budgetMax ?? null,
      designCategory: data.designCategory ?? null,
      demandType: data.demandType === 'fix' ? 'fix' : 'design', // 📐 P1：只允许 design / fix
      styleTags: data.styleTags ?? null,
      specSize: data.specSize ?? null,
      deliverables: data.deliverables ?? null,
      commercialLicense: data.commercialLicense ?? null,
      referenceImages: data.referenceImages ?? null,
    });
    return await repo.save(e);
  }
  const id = Math.max(0, ...db.designDemands.map((d) => d.id)) + 1;
  const d = {
    id,
    userId,
    orderNo: 'SJ' + Date.now(),
    productId: data.productId,
    productName: data.productName,
    demandText: data.demandText.trim(),
    budget: data.budget,
    contactPhone: data.contactPhone,
    wechat: data.wechat,
    deliveryTime: data.deliveryTime,
    status: 'pending' as const,
    statusText: '待接单',
    // 📐 Sprint 9 mock 也加上
    budgetMin: data.budgetMin ?? null,
    budgetMax: data.budgetMax ?? null,
    designCategory: data.designCategory ?? null,
    demandType: data.demandType === 'fix' ? 'fix' : 'design',
    styleTags: data.styleTags ?? null,
    specSize: data.specSize ?? null,
    deliverables: data.deliverables ?? null,
    commercialLicense: data.commercialLicense ?? null,
    referenceImages: data.referenceImages ?? null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  db.designDemands.push(d);
  return d;
}

export async function listDemandORM(userId: number, status?: string) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const where: any = { userId };
    if (status) {
      where.status = status;
    }
    return await ds.getRepository(DesignDemandEntity).find({ where, order: { id: 'DESC' } });
  }
  let list = db.designDemands.filter((d) => d.userId === userId);
  if (status) {
    list = list.filter((d) => d.status === status);
  }
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return list;
}

export async function getDemandDetailORM(userId: number, id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(DesignDemandEntity).findOne({ where: { id, userId } });
  }
  return db.designDemands.find((d) => d.id === id && d.userId === userId) ?? null;
}

export async function cancelDemandORM(userId: number, id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(DesignDemandEntity);
    const existing = await repo.findOne({ where: { id, userId } });
    if (!existing) {
      return null;
    }
    if (existing.status !== 'pending') {
      return { error: 'ONLY_PENDING' };
    }
    await repo.update(id, { status: 'cancelled', statusText: '已撤销', updatedAt: new Date() });
    return await repo.findOne({ where: { id } });
  }
  const d = db.designDemands.find((d) => d.id === id && d.userId === userId);
  if (!d) {
    return null;
  }
  if (d.status !== 'pending') {
    return { error: 'ONLY_PENDING' };
  }
  d.status = 'cancelled';
  d.statusText = '已撤销';
  d.updatedAt = new Date().toISOString();
  return d;
}

// ============ Admin helpers ============

/** 仪表盘聚合统计（纯 TypeORM 查询） */
export async function adminStatsORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const t0 = Date.now();
    // sqljs 单线程，Promise.all 可能产生锁竞争，改为串行
    const uCnt = await ds.getRepository(UserEntity).count();
    const t1 = Date.now();
    const uActive = await ds.getRepository(UserEntity).count({ where: { status: 1 } });
    const pCnt = await ds.getRepository(ProductEntity).count();
    const pEnabled = await ds.getRepository(ProductEntity).count({ where: { status: 1 } });
    const cCnt = await ds.getRepository(CategoryEntity).count();
    const bCnt = await ds.getRepository(BannerEntity).count();
    const oCnt = await ds.getRepository(OrderEntity).count();
    const oGMVRow = await ds.createQueryBuilder(OrderEntity, 'o').select('SUM(o.totalAmount)', 's').getRawOne();
    const oGMV = Number((oGMVRow as any)?.s ?? 0);
    const t2 = Date.now();
    // Top 分类 — sqljs 不支持 ANY_VALUE，改成 COALESCE(l1.name, '')
    const topCatRows: any[] = await ds
      .createQueryBuilder(ProductEntity, 'p')
      .select('COALESCE(l1.name, \"\")', 'catName')
      .addSelect('COUNT(p.id)', 'cnt')
      .innerJoin(CategoryEntity, 'c', 'c.id = p.categoryId')
      .innerJoin(CategoryEntity, 'l1', 'l1.id = COALESCE(c.parentId, c.id)')
      .groupBy('l1.id')
      .orderBy('cnt', 'DESC')
      .limit(5)
      .getRawMany();
    const topCategories = topCatRows.map((r) => ({ name: r.catName, value: Number(r.cnt) }));
    const topProducts = (
      await ds.getRepository(ProductEntity).find({ order: { sales: 'DESC' }, take: 3 })
    ).map((p) => ({ name: p.name, sales: p.sales, gmv: Math.round(toNum(p.price) * p.sales) }));
    return {
      overview: {
        totalUsers: uCnt,
        activeUsers: uActive,
        totalProducts: pCnt,
        enabledProducts: pEnabled,
        totalCategories: cCnt,
        totalBanners: bCnt,
        todayOrders: oCnt,
        todayGMV: Math.round(oGMV),
        todayNewUsers: 0,
      },
      topCategories,
      topProducts,
      pending: { installers: 0, designers: 0, vendors: 0, withdrawals: 0 },
    };
  }
  // — 内存 fallback — 复用 db.ts 逻辑 —
  const productCount = new Map<number, number>();
  db.products.forEach((p) => {
    if (p.categoryId) {
      productCount.set(p.categoryId, (productCount.get(p.categoryId) || 0) + 1);
    }
  });
  const topCategories = Array.from(productCount.entries())
    .map(([cid, count]) => {
      const cat = db.categories.find((c) => c.id === cid);
      const l1 = cat?.parentId ? db.categories.find((c) => c.id === cat.parentId) : cat;
      return { name: l1?.name || cat?.name || '未知', value: count };
    })
    .filter((v, i, a) => a.findIndex((t) => t.name === v.name) === i)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const todayGMV = db.orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
  return {
    overview: {
      totalUsers: db.users.length,
      activeUsers: db.users.filter((u) => u.status === 1).length,
      totalProducts: db.products.length,
      enabledProducts: db.products.filter((p) => p.status === 1).length,
      totalCategories: db.categories.length,
      totalBanners: db.banners.length,
      todayOrders: db.orders.length,
      todayGMV: Math.round(todayGMV),
      todayNewUsers: 0,
    },
    topCategories,
    topProducts: [...db.products]
      .sort((a, b) => b.sales - a.sales)
      .slice(0, 3)
      .map((p) => ({ name: p.name, sales: p.sales, gmv: (p.price || 0) * (p.sales || 0) })),
  };
}

export async function adminUsersORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const users = await ds.getRepository(UserEntity).find();
    return users.map((u) => ({
      id: String(u.id),
      nickname: u.nickname || `用户${u.phone.slice(-4)}`,
      phone: u.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
      role: u.role,
      registerTime: u.createdAt instanceof Date ? u.createdAt.toISOString().slice(0, 10) : '',
      status: u.status === 1 ? 'normal' : 'disabled',
      orders: 0, // 单独查计数太重，admin 可后续补
    }));
  }
  return db.users.map((u) => ({
    id: String(u.id),
    nickname: u.nickname || `用户${u.phone.slice(-4)}`,
    phone: u.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'),
    role: u.role,
    registerTime: (u.createdAt as string)?.slice(0, 10) || '',
    status: u.status === 1 ? 'normal' : 'disabled',
    orders: db.orders.filter((o) => o.userId === u.id).length,
  }));
}

export async function adminOrdersORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const orderRepo = ds.getRepository(OrderEntity);
    const itemRepo = ds.getRepository(OrderItemEntity);
    const userRepo = ds.getRepository(UserEntity);
    const orders = await orderRepo.find({ order: { id: 'DESC' } });
    if (orders.length === 0) {
      return [];
    }
    const oids = orders.map((o) => o.id);
    const items = await itemRepo
      .createQueryBuilder('i')
      .where('i.orderId IN (:...oids)', { oids })
      .getMany();
    const itemMap = new Map<number, any[]>();
    items.forEach((i) => {
      if (!itemMap.has(i.orderId)) {
        itemMap.set(i.orderId, []);
      }
      itemMap.get(i.orderId)!.push(i);
    });
    const uids = [...new Set(orders.map((o) => o.userId))];
    const users = uids.length ? await userRepo.find({ where: uids.map((id) => ({ id })) }) : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    return orders.map((o) => {
      const items = itemMap.get(o.id) || [];
      const user = userMap.get(o.userId);
      return {
        id: String(o.id),
        orderNo: o.orderNo,
        customer: user?.nickname || user?.phone?.slice(-4) || '未知',
        goods: items.map((i) => `${i.productName}×${i.quantity}`).join(', ') || '商品',
        total: o.totalAmount || 0,
        status: o.status,
        time:
          o.createdAt instanceof Date
            ? o.createdAt.toISOString().replace('T', ' ').slice(0, 16)
            : '',
        type: 'goods',
      };
    });
  }
  return db.orders
    .map((o) => {
      const user = db.users.find((u) => u.id === o.userId);
      const items = db.orderItems.filter((oi) => oi.orderId === o.id);
      return {
        id: String(o.id),
        orderNo: o.orderNo,
        customer: user?.nickname || user?.phone?.slice(-4) || '未知',
        goods: items.map((i) => `${i.productName}×${i.quantity}`).join(', ') || '商品',
        total: o.totalAmount || 0,
        status: o.status,
        time: (o.createdAt as string)?.replace('T', ' ').slice(0, 16) || '',
        type: 'goods',
      };
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

export async function adminProductsORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const prodRepo = ds.getRepository(ProductEntity);
    const catRepo = ds.getRepository(CategoryEntity);
    const products = await prodRepo.find();
    const catIds = [...new Set(products.map((p) => p.categoryId).filter(Boolean))] as number[];
    const cats = catIds.length ? await catRepo.find({ where: catIds.map((id) => ({ id })) }) : [];
    const catMap = new Map(cats.map((c) => [c.id, c]));
    return products.map((p) => {
      const cat = p.categoryId ? catMap.get(p.categoryId) : undefined;
      const l1 = cat?.parentId ? catMap.get(cat.parentId) : cat;
      return {
        id: String(p.id),
        name: p.name,
        price: toNum(p.price),
        stock: p.stock,
        sales: p.sales,
        categoryId: p.categoryId ? String(p.categoryId) : undefined,
        categoryName: cat?.name || '-',
        l1Name: l1?.name || '-',
        status: p.status === 1 ? 'on' : 'off',
        cover: p.cover,
      };
    });
  }
  return db.products.map((p) => {
    const cat = p.categoryId ? db.categories.find((c) => c.id === p.categoryId) : undefined;
    const l1 = cat?.parentId ? db.categories.find((c) => c.id === cat.parentId) : cat;
    return {
      id: String(p.id),
      name: p.name,
      price: p.price,
      stock: p.stock,
      sales: p.sales,
      categoryId: p.categoryId ? String(p.categoryId) : undefined,
      categoryName: cat?.name || '-',
      l1Name: l1?.name || '-',
      status: p.status === 1 ? 'on' : 'off',
      cover: p.cover,
    };
  });
}

export async function adminBannersORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(BannerEntity).find({ order: { sort: 'ASC' } });
  }
  return db.banners.sort((a, b) => a.sort - b.sort);
}

export async function adminAllCategoriesORM() {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const cats = await ds.getRepository(CategoryEntity).find({ order: { sort: 'ASC' } });
    return cats.map((c) => ({
      id: String(c.id),
      parentId: c.parentId ? String(c.parentId) : 0,
      name: c.name,
      icon: c.icon || '',
      sort: c.sort,
      status: c.status,
    }));
  }
  return db.categories.map((c) => ({
    id: String(c.id),
    parentId: c.parentId ? String(c.parentId) : 0,
    name: c.name,
    icon: c.icon || '',
    sort: c.sort,
    status: c.status,
  }));
}

export async function adminAddCategoryORM(data: {
  parentId?: number;
  name: string;
  icon?: string;
  sort?: number;
  status?: number;
}) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(CategoryEntity);
    let sort = data.sort;
    if (sort === undefined) {
      if (data.parentId) {
        sort = (await repo.count({ where: { parentId: data.parentId } })) + 1;
      } else {
        sort = (await repo.count({ where: { parentId: IsNull() } })) + 1;
      }
    }
    const e = repo.create({
      parentId: data.parentId,
      name: data.name.trim(),
      icon: data.icon || '',
      sort,
      status: data.status ?? 1,
    });
    const saved = await repo.save(e);
    return {
      id: String(saved.id),
      parentId: saved.parentId ? String(saved.parentId) : 0,
      name: saved.name,
      icon: saved.icon || '',
      sort: saved.sort,
      status: saved.status,
    };
  }
  const pid = data.parentId;
  const sort =
    data.sort ??
    (pid
      ? db.categories.filter((c) => c.parentId === pid).length + 1
      : db.categories.filter((c) => !c.parentId).length + 1);
  const id = Math.max(0, ...db.categories.map((c) => c.id)) + 1;
  const cat = {
    id,
    parentId: pid,
    name: data.name.trim(),
    icon: data.icon || '',
    sort,
    status: data.status ?? 1,
  };
  db.categories.push(cat);
  return {
    id: String(id),
    parentId: cat.parentId ? String(cat.parentId) : 0,
    name: cat.name,
    icon: cat.icon,
    sort: cat.sort,
    status: cat.status,
  };
}

export async function adminUpdateCategoryORM(id: number, patch: any) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(CategoryEntity);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) {
      return null;
    }
    const parentId =
      patch.parentId !== undefined
        ? patch.parentId
          ? Number(patch.parentId)
          : null
        : existing.parentId;
    if (parentId && parentId === id) {
      return { error: 'SELF_PARENT' };
    }
    await repo.update(id, {
      name: patch.name !== undefined ? String(patch.name).trim() : existing.name,
      icon: patch.icon !== undefined ? String(patch.icon) : existing.icon,
      sort: patch.sort !== undefined ? Number(patch.sort) : existing.sort,
      status: patch.status !== undefined ? Number(patch.status) : existing.status,
      parentId,
    } as any);
    return await repo.findOne({ where: { id } });
  }
  const cat = db.categories.find((c) => c.id === id);
  if (!cat) {
    return null;
  }
  if (patch.name !== undefined) {
    cat.name = String(patch.name).trim();
  }
  if (patch.icon !== undefined) {
    cat.icon = String(patch.icon);
  }
  if (patch.sort !== undefined) {
    cat.sort = Number(patch.sort);
  }
  if (patch.status !== undefined) {
    cat.status = Number(patch.status);
  }
  if (patch.parentId !== undefined) {
    const pid = patch.parentId ? Number(patch.parentId) : undefined;
    if (pid === id) {
      return { error: 'SELF_PARENT' };
    }
    cat.parentId = pid;
  }
  return cat;
}

export async function adminDeleteCategoryORM(id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(CategoryEntity);
    const cat = await repo.findOne({ where: { id } });
    if (!cat) {
      return null;
    }
    const childIds = (await repo.find({ where: { parentId: id } })).map((c) => c.id);
    const allIds = [id, ...childIds];
    // 检查商品
    const prodRepo = ds.getRepository(ProductEntity);
    const productCount = await prodRepo
      .createQueryBuilder('p')
      .where('p.categoryId IN (:...ids)', { ids: allIds })
      .getCount();
    if (productCount > 0) {
      return { error: `HAS_PRODUCTS:${productCount}` };
    }
    await repo.createQueryBuilder().delete().where('id IN (:...ids)', { ids: allIds }).execute();
    return { deleted: allIds.length };
  }
  const childIds = db.categories.filter((c) => c.parentId === id).map((c) => c.id);
  const allIds = [id, ...childIds];
  const productCount = db.products.filter(
    (p) => p.categoryId && allIds.includes(p.categoryId),
  ).length;
  if (productCount > 0) {
    return { error: `HAS_PRODUCTS:${productCount}` };
  }
  const before = db.categories.length;
  db.categories = db.categories.filter((c) => !allIds.includes(c.id));
  return { deleted: before - db.categories.length };
}

export async function adminReorderCategoriesORM(orders: { id: number; sort: number }[]) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(CategoryEntity);
    let updated = 0;
    for (const item of orders) {
      if (!item.id || !Number.isFinite(item.sort)) {
        continue;
      }
      await repo
        .createQueryBuilder()
        .update()
        .set({ sort: item.sort })
        .where('id = :id', { id: item.id })
        .execute();
      updated++;
    }
    return { updated };
  }
  let updated = 0;
  for (const item of orders) {
    const cat = db.categories.find((c) => c.id === Number(item.id));
    if (cat) {
      cat.sort = Number(item.sort);
      updated++;
    }
  }
  return { updated };
}

// ============ Admin 补全：User status + Product CRUD + Banner CRUD ============

export async function adminToggleUserStatusORM(userId: number, status: 'normal' | 'disabled') {
  const ds = getDataSource();
  const flag = status === 'normal' ? 1 : 0;
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(UserEntity);
    const existing = await repo.findOne({ where: { id: userId } });
    if (!existing) {
      return null;
    }
    await repo.update(userId, { status: flag });
    return { id: String(userId), status };
  }
  const u = db.users.find((u) => u.id === userId);
  if (!u) {
    return null;
  }
  u.status = flag;
  return { id: String(userId), status };
}

export async function adminResetPasswordORM(userId: number) {
  const ds = getDataSource();
  const temp = 'Aa888888';
  const hash = bcryptHashSync(temp);
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(UserEntity);
    const existing = await repo.findOne({ where: { id: userId } });
    if (!existing) {
      return null;
    }
    await repo.update(userId, { passwordHash: hash });
    return { id: String(userId), tempPassword: temp };
  }
  const u = db.users.find((u) => u.id === userId);
  if (!u) {
    return null;
  }
  u.passwordHash = hash;
  return { id: String(userId), tempPassword: temp };
}

export async function adminToggleProductORM(id: number, status: 'on' | 'off') {
  const ds = getDataSource();
  const flag = status === 'on' ? 1 : 0;
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(ProductEntity);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) {
      return null;
    }
    await repo.update(id, { status: flag });
    return { id: String(id), status };
  }
  const p = db.products.find((p) => p.id === id);
  if (!p) {
    return null;
  }
  p.status = flag;
  return { id: String(id), status };
}

export async function adminSaveProductDraftORM(data: any) {
  // 草稿：status=0（隐藏），逻辑同 publish 但默认 status=0
  return await adminPublishProductORM({ ...data, status: 0 });
}

export async function adminPublishProductORM(data: any) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(ProductEntity);
    const e = repo.create({
      name: data.name,
      cover: data.cover,
      images: Array.isArray(data.images) ? JSON.stringify(data.images) : data.images,
      price: data.price,
      stock: data.stock ?? 0,
      sales: data.sales ?? 0,
      categoryId: data.categoryId,
      vendorId: null, // 🛠️ 安全：admin 创建商品强制平台自营，不信任 body 传入的 vendorId
      createdBy: data.createdBy ?? null, // Sprint 10.4: 记录创建者 userId
      tags: Array.isArray(data.tags) ? JSON.stringify(data.tags) : data.tags,
      rating: data.rating ?? 4,
      detail: data.detail,
      status: data.status ?? 1,
      sort: data.sort ?? 0,
    } as any);
    const saved = await repo.save(e);
    return { id: String((saved as any).id) };
  }
  const id = Math.max(0, ...db.products.map((p) => p.id)) + 1;
  const p = {
    id,
    name: data.name,
    cover: data.cover,
    images: Array.isArray(data.images) ? data.images : [],
    price: data.price,
    stock: data.stock ?? 0,
    sales: data.sales ?? 0,
    categoryId: data.categoryId,
    vendorId: data.vendorId ?? null,
    tags: Array.isArray(data.tags) ? data.tags : [],
    rating: data.rating ?? 4,
    detail: data.detail,
    status: data.status ?? 1,
    sort: data.sort ?? 0,
  };
  db.products.push(p);
  return { id: String(id) };
}

export async function adminUpdateProductORM(id: number, data: any) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(ProductEntity);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) {
      return null;
    }
    const patch: any = {};
    if (data.name !== undefined) {
      patch.name = data.name;
    }
    if (data.cover !== undefined) {
      patch.cover = data.cover;
    }
    if (data.images !== undefined) {
      patch.images = Array.isArray(data.images) ? JSON.stringify(data.images) : data.images;
    }
    if (data.price !== undefined) {
      patch.price = data.price;
    }
    if (data.stock !== undefined) {
      patch.stock = data.stock;
    }
    if (data.sales !== undefined) {
      patch.sales = data.sales;
    }
    if (data.categoryId !== undefined) {
      patch.categoryId = data.categoryId;
    }
    if (data.tags !== undefined) {
      patch.tags = Array.isArray(data.tags) ? JSON.stringify(data.tags) : data.tags;
    }
    if (data.rating !== undefined) {
      patch.rating = data.rating;
    }
    if (data.detail !== undefined) {
      patch.detail = data.detail;
    }
    if (data.status !== undefined) {
      patch.status = data.status;
    }
    if (data.sort !== undefined) {
      patch.sort = data.sort;
    }
    await repo.update(id, patch);
    return { id: String(id) };
  }
  const p = db.products.find((p) => p.id === id);
  if (!p) {
    return null;
  }
  Object.assign(p, data);
  return { id: String(id) };
}

export async function adminDeleteProductORM(id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const r = await ds.getRepository(ProductEntity).delete({ id });
    return r.affected ? r.affected > 0 : null;
  }
  const idx = db.products.findIndex((p) => p.id === id);
  if (idx < 0) {
    return null;
  }
  db.products.splice(idx, 1);
  return true;
}

export async function adminAddBannerORM(data: any) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(BannerEntity);
    const maxSort = (await repo.find()).reduce((m, b) => Math.max(m, b.sort || 0), 0);
    const e = repo.create({
      title: data.title,
      image: data.image,
      linkType: data.linkType || 'product',
      link: data.link,
      sort: data.sort ?? maxSort + 1,
      status: data.status ?? 1,
    });
    const saved = await repo.save(e);
    return { id: String(saved.id) };
  }
  const id = Math.max(0, ...db.banners.map((b) => b.id)) + 1;
  const maxSort = db.banners.reduce((m, b) => Math.max(m, b.sort || 0), 0);
  const b = {
    id,
    title: data.title,
    image: data.image,
    linkType: data.linkType || ('product' as any),
    link: data.link,
    sort: data.sort ?? maxSort + 1,
    status: data.status ?? 1,
  };
  db.banners.push(b);
  return { id: String(id) };
}

export async function adminUpdateBannerORM(id: number, data: any) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(BannerEntity);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) {
      return null;
    }
    await repo.update(id, { ...data });
    return { id: String(id) };
  }
  const b = db.banners.find((b) => b.id === id);
  if (!b) {
    return null;
  }
  Object.assign(b, data);
  return { id: String(id) };
}

export async function adminToggleBannerORM(id: number, status: 'enabled' | 'disabled') {
  const ds = getDataSource();
  const flag = status === 'enabled' ? 1 : 0;
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(BannerEntity);
    const existing = await repo.findOne({ where: { id } });
    if (!existing) {
      return null;
    }
    await repo.update(id, { status: flag });
    return { id: String(id), status };
  }
  const b = db.banners.find((b) => b.id === id);
  if (!b) {
    return null;
  }
  b.status = flag;
  return { id: String(id), status };
}

export async function adminDeleteBannerORM(id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const r = await ds.getRepository(BannerEntity).delete({ id });
    return r.affected ? r.affected > 0 : null;
  }
  const idx = db.banners.findIndex((b) => b.id === id);
  if (idx < 0) {
    return null;
  }
  db.banners.splice(idx, 1);
  return true;
}

// ============ Designer hall (需求大厅) ============
export async function getDesignDemandHallORM(params?: {
  status?: string;
  keyword?: string;
  sortBy?: 'latest' | 'budget';
  grade?: number; // 🆕 当前设计师等级，大厅只返回 gradeMin ≤ self ≤ gradeMax 的需求
}) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(DesignDemandEntity);
    const where: any = { status: 'pending' }; // 大厅只展示可接单的
    const qb = repo.createQueryBuilder('d').where(where);

    // 🆕 6 级体系：按当前设计师 grade 过滤
    if (params?.grade != null) {
      qb.andWhere('d.gradeMin <= :grade AND d.gradeMax >= :grade', { grade: params.grade });
    }

    if (params?.keyword) {
      qb.andWhere('(d.demandText LIKE :kw OR d.productName LIKE :kw)', {
        kw: `%${params.keyword}%`,
      });
    }
    if (params?.sortBy === 'budget') {
      qb.addOrderBy('CAST(SUBSTRING(d.budget, LOCATE("¥", d.budget) + 1) AS DECIMAL)', 'DESC');
    } else {
      qb.addOrderBy('d.id', 'DESC');
    }
    const items = await qb.getMany();
    return items;
  }
  let list = db.designDemands.filter((d) => d.status === 'pending');
  if (params?.grade != null) {
    list = list.filter((d: any) => (d.gradeMin ?? 1) <= params.grade! && (d.gradeMax ?? 6) >= params.grade!);
  }
  if (params?.keyword) {
    const kw = params.keyword.toLowerCase();
    list = list.filter(
      (d) =>
        d.demandText.toLowerCase().includes(kw) || (d.productName || '').toLowerCase().includes(kw),
    );
  }
  if (params?.sortBy === 'budget') {
    list.sort((a, b) => {
      const an = parseFloat((a.budget.match(/[\d.]+/) || ['0'])[0]);
      const bn = parseFloat((b.budget.match(/[\d.]+/) || ['0'])[0]);
      return bn - an;
    });
  } else {
    list.sort((a, b) => b.id - a.id);
  }
  return list;
}

export async function designerAcceptDemandORM(designerId: number, demandId: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(DesignDemandEntity);
    const existing = await repo.findOne({ where: { id: demandId } });
    if (!existing) {
      return { error: 'NOT_FOUND' };
    }
    if (existing.status !== 'pending') {
      return { error: 'NOT_PENDING' };
    }
    await repo.update(demandId, {
      status: 'quoting',
      statusText: '设计师已接单',
      designerId,
      updatedAt: new Date(),
    });
    return { success: true };
  }
  const d = db.designDemands.find((d) => d.id === demandId);
  if (!d) {
    return { error: 'NOT_FOUND' };
  }
  if (d.status !== 'pending') {
    return { error: 'NOT_PENDING' };
  }
  (d as any).status = 'quoting';
  d.statusText = '设计师已接单';
  d.designerId = designerId;
  return { success: true };
}

// ============================================================================
// 🛠️ Sprint 10.5: Vendor 视角 ORM 函数
// ============================================================================

// — 🚨 2026-10-11 #13 已弃用：admin-settings 配置为真源（key=commission_rate_install/settle_freeze_days）—
// 这两个常量只作为 fallback，实际系统启动后 admin 改 settings 即可生效
const VENDOR_COMMISSION = 0.12;
const VENDOR_FROZEN_DAYS = 7;

/** 查 vendor 的 completed 订单项（带 frozen/providerGet 计算）
 *  返回数组每项: { oi, amount, commission, providerGet, frozen, frozenUntil, availableAt, completedAt }
 */
export async function getVendorCompletedItemsORM(vendorId: number) {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return [];
  }
  try {
    const oiRepo = ds.getRepository(OrderItemEntity);
    const pRepo = ds.getRepository(ProductEntity);
    const products = await pRepo.find({ where: { vendorId } });
    const productIds = products.map((p) => p.id);
    if (productIds.length === 0) {
      return [];
    }

    const now = new Date();
    const rawAndEntities = await oiRepo
      .createQueryBuilder('oi')
      .innerJoin(OrderEntity, 'o', 'o.id = oi.orderId')
      .addSelect('o.completedAt', 'completedAt')
      .where('oi.productId IN (:...productIds)', { productIds })
      .andWhere('o.status = :status', { status: 'completed' })
      .orderBy('o.completedAt', 'DESC')
      .getRawAndEntities();

    return rawAndEntities.entities.map((oi, idx) => {
      const rawCompleted = rawAndEntities.raw[idx]?.completedAt
        ? new Date(rawAndEntities.raw[idx].completedAt)
        : null;
      const amount = Number((oi.price * oi.quantity).toFixed(2));
      const commission = Number((amount * VENDOR_COMMISSION).toFixed(2));
      const providerGet = Number((amount - commission).toFixed(2));
      const freezeEnd = rawCompleted
        ? new Date(rawCompleted.getTime() + VENDOR_FROZEN_DAYS * 24 * 60 * 60 * 1000)
        : null;
      const frozen = freezeEnd ? now < freezeEnd : false;

      return {
        oi,
        orderId: oi.orderId,
        productId: oi.productId,
        productName: oi.productName,
        amount,
        commission,
        providerGet,
        status: frozen ? 'frozen' : 'available',
        frozen,
        frozenUntil: freezeEnd?.toISOString() ?? null,
        availableAt: freezeEnd?.toISOString() ?? null,
        completedAt: rawCompleted?.toISOString() ?? null,
      };
    });
  } catch {
    return [];
  }
}

/** Vendor 可用余额计算（earnings + withdraw 共用） */
export async function calculateVendorAvailableORM(vendorId: number) {
  const records = await getVendorCompletedItemsORM(vendorId);
  const grossTotal = records.reduce((s, r) => s + r.amount, 0);
  const commissionTotal = records.reduce((s, r) => s + r.commission, 0);
  const available = records.filter((r) => !r.frozen).reduce((s, r) => s + r.providerGet, 0);
  const frozen = records.filter((r) => r.frozen).reduce((s, r) => s + r.providerGet, 0);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthIncome = records
    .filter((r) => r.completedAt && new Date(r.completedAt) >= monthStart)
    .reduce((s, r) => s + r.providerGet, 0);

  const frozenSorted = records
    .filter((r) => r.frozen && r.availableAt)
    .sort((a, b) => new Date(a.availableAt!).getTime() - new Date(b.availableAt!).getTime());

  return {
    available: Number(available.toFixed(2)),
    frozen: Number(frozen.toFixed(2)),
    monthIncome: Number(monthIncome.toFixed(2)),
    total: Number((available + frozen).toFixed(2)),
    grossTotal: Number(grossTotal.toFixed(2)),
    commissionTotal: Number(commissionTotal.toFixed(2)),
    rate: VENDOR_COMMISSION,
    frozenDays: VENDOR_FROZEN_DAYS,
    nextFrozenRelease: frozenSorted[0]?.availableAt ?? null,
    records: records.map((r) => ({
      id: String(r.oi.id),
      orderId: String(r.orderId),
      productId: r.productId,
      title: r.productName,
      amount: r.amount,
      commission: r.commission,
      providerGet: r.providerGet,
      rate: VENDOR_COMMISSION,
      status: r.status,
      completedAt: r.completedAt,
      frozen: r.frozen,
      frozenUntil: r.frozenUntil,
      availableAt: r.availableAt,
    })),
  };
}

/** Vendor 视角订单详情（WHERE order.vendorId = :vendorId） */
export async function getVendorOrderDetailORM(vendorId: number, orderId: number) {
  const ds = getDataSource();
  if (!ds || !ds.isInitialized) {
    return null;
  }
  try {
    const repo = ds.getRepository(OrderEntity);
    const o = await repo.findOne({ where: { id: orderId, vendorId } });
    if (!o) {
      return null;
    }
    const items = await ds.getRepository(OrderItemEntity).find({ where: { orderId } });

    // 查 consumer 信息
    const buyer = await ds.getRepository(UserEntity).findOne({ where: { id: o.userId } });
    const buyerName = buyer?.nickname || buyer?.phone || '客户';
    const buyerPhone = buyer?.phone || '';

    return { ...o, buyerName, buyerPhone, items };
  } catch {
    return null;
  }
}

// — bcrypt hash 辅助（避免 db-orm.ts 再 import db.ts 的循环）—
import bcrypt from 'bcryptjs';
function bcryptHashSync(pwd: string): string {
  return bcrypt.hashSync(pwd, 10);
}

// ============================================================
// 🏗️ MasterOrder 聚合根 helper（P0 新增）
// ============================================================

// — MasterOrder 号生成 —
function genMasterOrderNo(): string {
  return 'MO' + Date.now().toString(36).toUpperCase().slice(-8) + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

/** 创建主订单（聚合根） */
export async function createMasterOrderORM(params: {
  buyerId: number;
  buyerNickname: string;
  productTotal: number; // 元（与 OrderEntity.totalAmount 保持一致）
  designTotal?: number;
  installTotal?: number;
  address?: any;
  remark?: string;
  productOrderId?: number;
  designOrderId?: number;
  installationOrderId?: number;
  status?: 'pending' | 'paid' | 'designing' | 'producing' | 'installing' | 'completed' | 'cancelled' | 'refunding' | 'refunded';
}): Promise<MasterOrderEntity> {
  const ds = getDataSource();
  const now = new Date();
  const designTotal = params.designTotal || 0;
  const installTotal = params.installTotal || 0;
  const totalAmount = Number((params.productTotal + designTotal + installTotal).toFixed(2));

  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(MasterOrderEntity);
    const mo = repo.create({
      orderNo: genMasterOrderNo(),
      buyerId: params.buyerId,
      buyerNickname: params.buyerNickname,
      productTotal: Number(params.productTotal.toFixed(2)),
      designTotal: Number(designTotal.toFixed(2)),
      installTotal: Number(installTotal.toFixed(2)),
      totalAmount,
      platformFee: 0,
      status: params.status || 'pending',
      address: params.address || null,
      remark: params.remark || null,
      productOrderId: params.productOrderId ?? null,
      designOrderId: params.designOrderId ?? null,
      installationOrderId: params.installationOrderId ?? null,
    });
    return await repo.save(mo);
  }
  // 内存 fallback
  const id = db.nextId('masterOrders');
  const mo = {
    id,
    orderNo: genMasterOrderNo(),
    buyerId: params.buyerId,
    buyerNickname: params.buyerNickname,
    productTotal: Number(params.productTotal.toFixed(2)),
    designTotal: Number(designTotal.toFixed(2)),
    installTotal: Number(installTotal.toFixed(2)),
    totalAmount,
    platformFee: 0,
    status: params.status || 'pending',
    address: params.address || null,
    remark: params.remark || null,
    productOrderId: params.productOrderId ?? null,
    designOrderId: params.designOrderId ?? null,
    installationOrderId: params.installationOrderId ?? null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  db.masterOrders.push(mo);
  return mo;
}

/** 回写主订单的子订单引用（子订单创建后调） */
export async function linkSubOrdersToMasterORM(
  masterOrderId: number,
  refs: { productOrderId?: number; designOrderId?: number; installationOrderId?: number },
): Promise<void> {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const patch: any = {};
    if (refs.productOrderId != null) patch.productOrderId = refs.productOrderId;
    if (refs.designOrderId != null) patch.designOrderId = refs.designOrderId;
    if (refs.installationOrderId != null) patch.installationOrderId = refs.installationOrderId;
    await ds.getRepository(MasterOrderEntity).update({ id: masterOrderId }, patch);
    return;
  }
  const mo = db.masterOrders.find((m: any) => m.id === masterOrderId);
  if (mo) {
    if (refs.productOrderId != null) mo.productOrderId = refs.productOrderId;
    if (refs.designOrderId != null) mo.designOrderId = refs.designOrderId;
    if (refs.installationOrderId != null) mo.installationOrderId = refs.installationOrderId;
  }
}

/** 更新主订单状态（子订单创建完根据是否有设计/安装切换） */
export async function updateMasterOrderStatusORM(
  masterOrderId: number,
  status: MasterOrderEntity['status'],
): Promise<void> {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    await ds.getRepository(MasterOrderEntity).update({ id: masterOrderId }, { status });
    return;
  }
  const mo = db.masterOrders.find((m: any) => m.id === masterOrderId);
  if (mo) {
    mo.status = status;
    mo.updatedAt = new Date().toISOString();
  }
}

/** 给三个子订单回写 masterOrderId */
export async function setSubOrderMasterIdORM(
  subOrderType: 'product' | 'design' | 'installation',
  subOrderId: number,
  masterOrderId: number,
): Promise<void> {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    if (subOrderType === 'product') {
      await ds.getRepository(OrderEntity).update({ id: subOrderId }, { masterOrderId });
    } else if (subOrderType === 'design') {
      await ds.getRepository(DesignOrderEntity).update({ id: subOrderId }, { masterOrderId });
    } else {
      await ds.getRepository(InstallationOrderEntity).update({ id: subOrderId }, { masterOrderId });
    }
    return;
  }
  // 内存 fallback
  if (subOrderType === 'product') {
    const o = db.orders.find((x: any) => x.id === subOrderId);
    if (o) o.masterOrderId = masterOrderId;
  } else if (subOrderType === 'design') {
    const o = db.designOrders.find((x: any) => x.id === subOrderId);
    if (o) o.masterOrderId = masterOrderId;
  } else {
    const o = db.installationOrders.find((x: any) => x.id === subOrderId);
    if (o) o.masterOrderId = masterOrderId;
  }
}

/** 当前用户的主订单列表 */
export async function listMasterOrdersORM(userId: number, status?: string) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    const where: any = { buyerId: userId };
    if (status) where.status = status;
    return await ds.getRepository(MasterOrderEntity).find({ where, order: { id: 'DESC' } });
  }
  let list = db.masterOrders.filter((m: any) => m.buyerId === userId);
  if (status) list = list.filter((m: any) => m.status === status);
  return list.sort((a: any, b: any) => b.id - a.id);
}

/** 主订单详情（带子订单引用） */
export async function getMasterOrderDetailORM(userId: number, id: number) {
  const ds = getDataSource();
  if (ds && ds.isInitialized) {
    return await ds.getRepository(MasterOrderEntity).findOne({ where: { id, buyerId: userId } });
  }
  return db.masterOrders.find((m: any) => m.id === id && m.buyerId === userId) || null;
}

// ============================================================
// 🏗️ 子订单快速创建 helper（P0 新增）
// 用于 cart-order submit 里按 productType 自动分流
// ============================================================

function genDesignOrderNo(): string {
  return 'DO' + Date.now().toString(36).toUpperCase().slice(-8) + Math.floor(Math.random() * 100).toString().padStart(2, '0');
}
function genInstallOrderNo(): string {
  return 'INO' + Date.now().toString().slice(-10) + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

/** 自动创建设计子流程：DesignDemand + DesignOrder（designerId 可选传，不传则为 NULL 等接单） */
export async function autoCreateDesignFlowORM(params: {
  userId: number;
  productId: number;
  productName: string;
  demandType: 'design' | 'fix';
  designCategory?: string;
  demandText?: string;
  budgetMin?: number;
  budgetMax?: number;
  masterOrderId?: number;
  designerId?: number | null;
  price?: number;
}): Promise<{ demand: any; designOrder: any }> {
  const ds = getDataSource();
  const now = new Date();

  // 1. DesignDemand
  const demandText = params.demandText || `${params.productName} ${params.demandType === 'fix' ? '商品已配好设计稿，请优化调整' : '定制设计需求'}`;
  const demandData: any = {
    userId: params.userId,
    orderNo: 'SJ' + Date.now(),
    productId: params.productId,
    productName: params.productName,
    demandText,
    budget: params.budgetMin && params.budgetMax ? `¥${params.budgetMin}-¥${params.budgetMax}` : (params.budgetMax ? `¥${params.budgetMax}+` : '面议'),
    contactPhone: null,
    wechat: null,
    deliveryTime: new Date(Date.now() + 7 * 86400_000).toISOString(),
    status: 'pending',
    statusText: '待接单',
    budgetMin: params.budgetMin ?? null,
    budgetMax: params.budgetMax ?? null,
    designCategory: params.designCategory ?? null,
    demandType: params.demandType,
  };

  let demand: any;
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(DesignDemandEntity);
    demand = await repo.save(repo.create(demandData));
  } else {
    const id = db.nextId('designDemands');
    demand = { id, ...demandData, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    db.designDemands.push(demand);
  }

  // 2. DesignOrder
  const price = params.price || 0;
  const designerId = params.designerId ?? 0; // 0 = 待接单，等设计师 accept 后写入真实 userId
  const designOrderData: any = {
    orderNo: genDesignOrderNo(),
    demandId: demand.id,
    buyerId: params.userId,
    designerId,
    price,
    commissionRate: 0.15,
    status: 'designing', // ENUM: accepted/designing/revision_requested/reviewed/completed/cancelled/disputed
    revisionCount: 0,
    masterOrderId: params.masterOrderId ?? null,
    acceptedAt: now, // 订单创建即视为已接单 acceptedAt 非空约束
  };

  let designOrder: any;
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(DesignOrderEntity);
    const saved = await repo.save(repo.create(designOrderData));
    // TypeORM 会自动生成 acceptedAt
    designOrder = saved;
  } else {
    const id = db.nextId('designOrders');
    designOrder = { id, ...designOrderData, acceptedAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() };
    db.designOrders.push(designOrder);
  }

  return { demand, designOrder };
}

/** 自动创建安装子流程：InstallationDemand + InstallationOrder（无报价 → installerId=NULL 等派单） */
export async function autoCreateInstallationFlowORM(params: {
  userId: number;
  productId: number;
  address: any; // { name, phone, province, city, district, detail }
  budgetMin?: number;
  budgetMax?: number;
  serviceType?: string;
  description?: string;
  masterOrderId?: number;
}): Promise<{ demand: any; installationOrder: any }> {
  const ds = getDataSource();
  const now = new Date();

  const demandData: any = {
    userId: params.userId,
    serviceType: params.serviceType || '广告安装',
    address: `${params.address?.province || ''}${params.address?.city || ''}${params.address?.district || ''}${params.address?.detail || ''}`,
    serviceLat: 0,
    serviceLng: 0,
    expectedTime: new Date(Date.now() + 3 * 86400_000).toISOString(),
    description: params.description || `商品#${params.productId} 上门安装`,
    budgetMin: params.budgetMin ?? null,
    budgetMax: params.budgetMax ?? null,
    radiusKm: 10,
    status: 'pending',
    contactName: params.address?.name || null,
    contactPhone: params.address?.phone || null,
  };

  let demand: any;
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(InstallationDemandEntity);
    demand = await repo.save(repo.create(demandData));
  } else {
    const id = db.nextId('installationDemands');
    demand = { id, ...demandData, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    db.installationDemands.push(demand);
  }

  const installOrderData: any = {
    orderNo: genInstallOrderNo(),
    demandId: demand.id,
    quoteId: 0, // 还没报价，占位
    userId: params.userId,
    installerId: 0, // 还没派单，0 = 等派单中
    finalPrice: 0, // 还没报价
    status: 'pending',
    warrantyStatus: 'none',
    warrantyHoldAmount: 0,
    masterOrderId: params.masterOrderId ?? null,
    productId: params.productId,
  };

  let installationOrder: any;
  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(InstallationOrderEntity);
    installationOrder = await repo.save(repo.create(installOrderData));
  } else {
    const id = db.nextId('installationOrders');
    installationOrder = { id, ...installOrderData, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    db.installationOrders.push(installationOrder);
  }

  return { demand, installationOrder };
}

// ============================================================
// 🧾 PlatformTransaction 平台交易流水 helper（P2-1 双写）
// 双写时机：订单 settle 完成时，每个 settle 单生成一条 platform_transaction
// ============================================================

/** 创建平台抽佣流水（双写时机：订单结算时） */
export async function createPlatformTransactionORM(params: {
  type: 'commission' | 'subscription' | 'refund' | 'adjust';
  source: 'design' | 'goods' | 'install' | 'admin';
  sourceId: number;
  baseAmount: number; // 元
  rate: number;
  targetRole: 'designer' | 'vendor' | 'installer' | 'buyer' | 'admin';
  targetUserId?: number;
  settleNo?: string;
  remark?: string;
}): Promise<any> {
  const ds = getDataSource();
  const now = new Date();
  const amount = Number(((params.baseAmount || 0) * (params.rate || 0)).toFixed(2));

  if (ds && ds.isInitialized) {
    const repo = ds.getRepository(PlatformTransactionEntity);
    const pt = repo.create({
      txNo: genPlatformTxNo(),
      type: params.type,
      source: params.source,
      sourceId: params.sourceId,
      baseAmount: Number((params.baseAmount || 0).toFixed(2)),
      amount,
      rate: Number((params.rate || 0).toFixed(4)),
      targetRole: params.targetRole,
      targetUserId: params.targetUserId,
      status: 'pending',
      settleNo: params.settleNo,
      remark: params.remark,
    });
    return await repo.save(pt);
  }
  // 内存 fallback
  const id = db.nextId('platformTransactions');
  const pt = {
    id,
    txNo: genPlatformTxNo(),
    type: params.type,
    source: params.source,
    sourceId: params.sourceId,
    baseAmount: Number((params.baseAmount || 0).toFixed(2)),
    amount,
    rate: Number((params.rate || 0).toFixed(4)),
    targetRole: params.targetRole,
    targetUserId: params.targetUserId,
    status: 'pending',
    settleNo: params.settleNo,
    remark: params.remark,
    createdAt: now.toISOString(),
  };
  (db as any).platformTransactions.push(pt);
  return pt;
}

// ============================================================
// 🔗 子订单被接单后回写 MasterOrder 引用 + 状态（P2-2）
// ============================================================

/** 子订单被接单后回写 MasterOrder 引用 + 状态 */
export async function onSubOrderAcceptedORM(
  masterOrderId: number,
  subOrderType: 'product' | 'design' | 'installation',
  subOrderId: number,
  statusHint?: string,
): Promise<void> {
  const field =
    subOrderType === 'product'
      ? 'productOrderId'
      : subOrderType === 'design'
        ? 'designOrderId'
        : 'installationOrderId';
  await linkSubOrdersToMasterORM(masterOrderId, { [field]: subOrderId } as any);
  if (statusHint) {
    await updateMasterOrderStatusORM(masterOrderId, statusHint as any);
  }
}

// ============ 🏪 智能匹配：按买家地址找能配送的 vendor ============
/**
 * 核心：UserEntity.serviceAreas JSON 字段做 JSON_CONTAINS 查询
 * 传入 manager 时走事务上下文（createOrderORM 内部用）；否则走普通 ds 查询。
 */
export async function findVendorsByAreaORM(
  params: {
    province: string;
    city: string;
    district?: string;
    excludeVendorId?: number;
  },
  em?: any,
): Promise<any[]> {
  const { province, city, district, excludeVendorId } = params;

  // TypeORM 模式
  const ds = getDataSource();
  const useORM = em || (ds && ds.isInitialized);
  if (useORM) {
    const repo = (em || ds).getRepository(UserEntity);
    const qb = repo.createQueryBuilder('u')
      .where('u.role = :role', { role: 'vendor' })
      .andWhere('u.status = :status', { status: 1 })
      // 省份匹配：serviceAreas 任一元素 province 等于目标
      .andWhere(
        `JSON_CONTAINS(u.serviceAreas, :provinceCond, '$')`,
        { provinceCond: JSON.stringify({ province }) },
      );

    // 可选：排除已绑定的 vendorId（Product 已绑 vendor 时跳过匹配）
    if (excludeVendorId != null && excludeVendorId > 0) {
      qb.andWhere('u.id != :excl', { excl: excludeVendorId });
    }

    // 可选：城市匹配（精确到市）
    if (city) {
      qb.andWhere(
        `JSON_CONTAINS(u.serviceAreas, :cityCond, '$')`,
        { cityCond: JSON.stringify({ city }) },
      );
    }

    // 可选：区匹配（精确到区优先）
    if (district) {
      qb.andWhere(
        `JSON_CONTAINS(u.serviceAreas, :distCond, '$')`,
        { distCond: JSON.stringify({ district }) },
      );
    }

    // 按 serviceLng 排序：有值的排前面，NULL 排后面（MySQL 用 IS NULL 补，PG 用 NULLS LAST）
    qb.addSelect('(u.serviceLng IS NULL)', 'lngIsNull');
    qb.orderBy('lngIsNull', 'ASC'); // IS NULL=true(1) 的排后面
    qb.addOrderBy('u.serviceLng', 'ASC');

    const rows = await qb.getMany();
    return rows.map((u: any) => ({
      id: u.id,
      phone: u.phone,
      nickname: u.nickname ?? '',
      avatar: u.avatar ?? '',
      role: u.role,
      level: u.level,
      serviceAreas: toArr(u.serviceAreas),
      serviceLng: u.serviceLng ?? null,
      serviceLat: u.serviceLat ?? null,
    }));
  }

  // — 内存 fallback —
  return findVendorsByAreaMemory(params);
}
