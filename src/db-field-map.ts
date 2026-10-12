/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  db-field-map.ts — 数据库字段名单一数据源                         ║
 * ║                                                                  ║
 * ║  目的:                                                            ║
 * ║  1. 路由代码 enrich 时从这里取真实字段名 → 编译期验证             ║
 * ║  2. 消除 "d.title vs d.description" 这类猜测 → "N/A" 类 UI bug  ║
 * ║  3. 每行都标注服务器 DESCRIBE 原始输出 → 不猜列名                 ║
 * ║                                                                  ║
 * ║  用法:                                                            ║
 * ║  import { InstallationDemandFields as F } from './db-field-map';  ║
 * ║  return { title: d[F.description] };  // ✅ 编译期安全            ║
 * ║  return { title: d.title };            // ❌ TypeScript 报错      ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ════════════════════════════════════════════════════════════════
// 📌 InstallationDemandEntity (表: installation_demands)
// DESCRIBE 关键列: id, userId, serviceType, address, description,
//                  budgetMin, budgetMax, status, createdAt
// ⚠️ 没有 title 列！description text 是真实描述字段
// ════════════════════════════════════════════════════════════════
export const InstallationDemandFields = {
  id: 'id',
  userId: 'userId',
  categoryId: 'categoryId',
  serviceType: 'serviceType',
  address: 'address',
  description: 'description', // ✅ 真实描述字段（不是 title）
  budgetMin: 'budgetMin',
  budgetMax: 'budgetMax',
  status: 'status',
  createdAt: 'createdAt',
} as const;
export type InstallationDemandField =
  (typeof InstallationDemandFields)[keyof typeof InstallationDemandFields];

// ════════════════════════════════════════════════════════════════
// 📌 InstallationQuoteEntity (表: installation_quotes)
// DESCRIBE 关键列: id, demandId, installerId, price, description,
//                  status, createdAt
// ⚠️ 没有 title 列！description text 是报价说明
// ════════════════════════════════════════════════════════════════
export const InstallationQuoteFields = {
  id: 'id',
  demandId: 'demandId',
  installerId: 'installerId',
  price: 'price',
  labor: 'labor',
  materials: 'materials',
  freight: 'freight',
  tax: 'tax',
  toolFee: 'toolFee',
  description: 'description', // 报价说明文字
  eta: 'eta',
  status: 'status',
  createdAt: 'createdAt',
} as const;
export type InstallationQuoteField =
  (typeof InstallationQuoteFields)[keyof typeof InstallationQuoteFields];

// ════════════════════════════════════════════════════════════════
// 📌 InstallationOrderEntity (表: installation_orders)
// DESCRIBE 关键列: id, orderNo, demandId, installerId, userId,
//                  finalPrice, status, createdAt
// ════════════════════════════════════════════════════════════════
export const InstallationOrderFields = {
  id: 'id',
  orderNo: 'orderNo',
  demandId: 'demandId',
  quoteId: 'quoteId',
  userId: 'userId',
  installerId: 'installerId',
  finalPrice: 'finalPrice',
  status: 'status',
  warrantyStatus: 'warrantyStatus',
  warrantyExpireAt: 'warrantyExpireAt',
  createdAt: 'createdAt',
} as const;
export type InstallationOrderField =
  (typeof InstallationOrderFields)[keyof typeof InstallationOrderFields];

// ════════════════════════════════════════════════════════════════
// 📌 InstallerProfileEntity (表: installer_profiles)
// DESCRIBE 关键列: id, userId, realName, phone, verified, rating,
//                  serviceLat, serviceLng, completedOrders
// ⚠️ 没有 nickname 列！是 realName
// ════════════════════════════════════════════════════════════════
export const InstallerProfileFields = {
  id: 'id',
  userId: 'userId',
  realName: 'realName', // ✅ 真实名字（不是 nickname）
  avatar: 'avatar',
  phone: 'phone',
  verified: 'verified',
  rating: 'rating',
  ratingCount: 'ratingCount',
  completedOrders: 'completedOrders',
  serviceLat: 'serviceLat',
  serviceLng: 'serviceLng',
  serviceAddress: 'serviceAddress',
} as const;
export type InstallerProfileField =
  (typeof InstallerProfileFields)[keyof typeof InstallerProfileFields];

// ════════════════════════════════════════════════════════════════
// 📌 DesignerProfileEntity (表: designer_profiles)
// DESCRIBE 关键列: id, userId, realName, verified, specialties,
//                  priceRange, intro, rating, completedOrders
// ════════════════════════════════════════════════════════════════
export const DesignerProfileFields = {
  id: 'id',
  userId: 'userId',
  realName: 'realName',
  avatar: 'avatar',
  verified: 'verified',
  specialties: 'specialties',
  priceRange: 'priceRange',
  intro: 'intro', // ✅ 设计师简介
  rating: 'rating',
  completedOrders: 'completedOrders',
} as const;
export type DesignerProfileField =
  (typeof DesignerProfileFields)[keyof typeof DesignerProfileFields];

// ════════════════════════════════════════════════════════════════
// 📌 DesignDemandEntity (表: design_demands)
// DESCRIBE 关键列: id, userId, orderNo, productName, demandText,
//                  budgetMin, budgetMax, contactPhone, deliveryTime
// ✅ 有 demandText（不是 description）！和 installation_demands 不同
// ✅ 有 productName（可作 title 展示）
// ════════════════════════════════════════════════════════════════
export const DesignDemandFields = {
  id: 'id',
  userId: 'userId',
  orderNo: 'orderNo',
  productName: 'productName', // 可作 title 展示
  demandText: 'demandText', // ✅ 设计要求文本
  budgetMin: 'budgetMin',
  budgetMax: 'budgetMax',
  budget: 'budget',
  contactPhone: 'contactPhone',
  deliveryTime: 'deliveryTime',
  status: 'status',
  designerId: 'designerId',
  createdAt: 'createdAt',
} as const;
export type DesignDemandField = (typeof DesignDemandFields)[keyof typeof DesignDemandFields];

// ════════════════════════════════════════════════════════════════
// 📌 DesignOrderEntity (表: design_orders)
// DESCRIBE 关键列: id, orderNo, demandId, buyerId, designerId,
//                  price, status, completedAt
// ════════════════════════════════════════════════════════════════
export const DesignOrderFields = {
  id: 'id',
  orderNo: 'orderNo',
  demandId: 'demandId',
  buyerId: 'buyerId',
  designerId: 'designerId',
  price: 'price',
  status: 'status',
  revisionCount: 'revisionCount',
  completedAt: 'completedAt',
  createdAt: 'createdAt',
} as const;
export type DesignOrderField = (typeof DesignOrderFields)[keyof typeof DesignOrderFields];

// ════════════════════════════════════════════════════════════════
// 📌 ProductEntity (表: products)
// DESCRIBE 关键列: id, name, price, categoryId, vendorId, stock, sales
// ⚠️ 列名是 name，不是 title！
// ════════════════════════════════════════════════════════════════
export const ProductFields = {
  id: 'id',
  name: 'name', // ✅ 真实产品名（不是 title）
  cover: 'cover',
  images: 'images',
  price: 'price',
  stock: 'stock',
  sales: 'sales',
  categoryId: 'categoryId',
  vendorId: 'vendorId',
  status: 'status',
  createdAt: 'createdAt',
} as const;
export type ProductField = (typeof ProductFields)[keyof typeof ProductFields];

// ════════════════════════════════════════════════════════════════
// 📌 UserEntity (表: users)
// DESCRIBE 关键列: id, phone, nickname, avatar, role, status
// ════════════════════════════════════════════════════════════════
export const UserFields = {
  id: 'id',
  phone: 'phone',
  nickname: 'nickname',
  avatar: 'avatar',
  role: 'role',
  status: 'status',
} as const;
export type UserField = (typeof UserFields)[keyof typeof UserFields];

// ════════════════════════════════════════════════════════════════
// 📌 AddressEntity (表: addresses)
// DESCRIBE 关键列: id, userId, name, phone, province, city, district, detail
// ════════════════════════════════════════════════════════════════
export const AddressFields = {
  id: 'id',
  userId: 'userId',
  name: 'name',
  phone: 'phone',
  province: 'province',
  city: 'city',
  district: 'district',
  detail: 'detail',
  isDefault: 'isDefault',
} as const;
export type AddressField = (typeof AddressFields)[keyof typeof AddressFields];

// ════════════════════════════════════════════════════════════════
// 📌 WarrantyClaimEntity (表: warranty_claims)
// DESCRIBE 关键列: id, orderId, userId, installerId, description,
//                  issueDesc, status, resolution
// ⚠️ 有两个文本字段: description（索赔说明）+ issueDesc（问题描述）
// ════════════════════════════════════════════════════════════════
export const WarrantyClaimFields = {
  id: 'id',
  orderId: 'orderId',
  userId: 'userId',
  installerId: 'installerId',
  description: 'description', // 索赔说明（用户提交）
  issueDesc: 'issueDesc', // 问题描述（详细）
  status: 'status',
  installerResponse: 'installerResponse',
  resolution: 'resolution',
  createdAt: 'createdAt',
} as const;
export type WarrantyClaimField = (typeof WarrantyClaimFields)[keyof typeof WarrantyClaimFields];

// ════════════════════════════════════════════════════════════════
// 📌 OrderEntity (表: orders) — 买家端电商订单
// DESCRIBE 关键列: id, orderNo, userId, vendorId, status, totalAmount
// ════════════════════════════════════════════════════════════════
export const OrderFields = {
  id: 'id',
  orderNo: 'orderNo',
  userId: 'userId',
  vendorId: 'vendorId',
  status: 'status',
  totalAmount: 'totalAmount',
  receiverName: 'receiverName',
  receiverPhone: 'receiverPhone',
  receiverAddress: 'receiverAddress',
  createdAt: 'createdAt',
} as const;
export type OrderField = (typeof OrderFields)[keyof typeof OrderFields];

// ════════════════════════════════════════════════════════════════
// 📌 常见坑汇总（快速查表）
// ════════════════════════════════════════════════════════════════
export const PITFALLS = {
  /** installation_demands 没有 title → 用 description */
  demandHasTitle: false,
  installationDemandTitleField: InstallationDemandFields.description,

  /** design_demands 没有 title → 用 productName（可作展示）或 demandText（截断） */
  designDemandTitleField: DesignDemandFields.productName,
  designDemandDescField: DesignDemandFields.demandText,

  /** products 没有 title → 用 name */
  productTitleField: ProductFields.name,

  /** installer_profiles 没有 nickname → 用 realName */
  installerDisplayNameField: InstallerProfileFields.realName,

  /** warranty_claims 有 description + issueDesc 两个文本字段 */
  warrantyDescFields: [WarrantyClaimFields.description, WarrantyClaimFields.issueDesc] as const,
} as const;
