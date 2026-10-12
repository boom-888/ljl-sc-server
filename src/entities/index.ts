// ============================================================================
// TypeORM Entities — 全部显式指定 type（tsx/esbuild 不支持 emitDecoratorMetadata 反射推断）
// 对应 SPRINT1_BACKEND_TECH_PLAN.md 的 8 张 DDL
// ============================================================================
import 'reflect-metadata';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
// ⚠️ 同文件内引用，无循环依赖
// 跨文件的反向 OneToMany（如 user.addresses）在 sprint2/3/4/5 里各自声明

// — 1. users —
@Entity('users')
export class UserEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 20, unique: true })
  @Index('users_idx_phone')
  phone: string = '';

  @Column({ type: 'varchar', length: 50, nullable: true })
  nickname?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  passwordHash?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar?: string;

  @Column({ type: 'varchar', length: 20, default: 'consumer' })
  @Index('users_idx_role')
  role: string = 'consumer';

  /** 配送覆盖区域（仅 role='vendor' 生效；JSON 存储）
   * 例：[{"province":"四川省","city":"成都市","district":null}] — district=null 表示覆盖整个市 */
  @Column({ type: 'simple-json', nullable: true })
  serviceAreas?: Array<{ province: string; city: string; district?: string | null }>;

  /** 门店经度（可选，用于按距离排序） */
  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  serviceLng?: number;

  /** 门店纬度（可选，用于按距离排序） */
  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  serviceLat?: number;

  /** 办公地址（入驻时填的详细地址，vendor 资质审核用） */
  @Column({ type: 'varchar', length: 200, nullable: true })
  officeAddress?: string;

  /** 联系人（vendor/designer/installer 入驻时填） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  contactName?: string;

  /** 主营品类（JSON 数组，如 ["喷绘写真","发光字"]） */
  @Column({ type: 'simple-json', nullable: true })
  categories?: string[];

  /** 营业执照图片 URL（vendor 入驻强制上传） */
  @Column({ type: 'varchar', length: 500, nullable: true })
  businessLicenseUrl?: string;

  /** 身份证正面 URL */
  @Column({ type: 'varchar', length: 500, nullable: true })
  idCardFrontUrl?: string;

  /** 身份证反面 URL */
  @Column({ type: 'varchar', length: 500, nullable: true })
  idCardBackUrl?: string;

  /** 工厂/门店照片（JSON 数组，选填） */
  @Column({ type: 'simple-json', nullable: true })
  factoryPhotos?: string[];

  /** 入驻审核备注（admin 填，拒绝原因等） */
  @Column({ type: 'text', nullable: true })
  reviewNote?: string;

  // — 微信身份体系（开放平台 UnionID 跨端统一）—
  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index('uk_users_openid', { unique: true })
  openid?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  @Index('uk_users_unionid', { unique: true })
  unionid?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  wechatNickname?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  wechatAvatar?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  wechatAccessToken?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  wechatRefreshToken?: string;

  @Column({ type: 'datetime', nullable: true })
  wechatExpiresAt?: Date | null;

  @Column({ type: 'tinyint', default: 1 })
  level: number = 1;

  @Column({ type: 'int', default: 0 })
  points: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  wallet: number = 0;

  @Column({ type: 'int', default: 0 })
  coupons: number = 0;

  @Column({ type: 'tinyint', default: 1 })
  @Index('users_idx_status')
  status: number = 1;

  // ✅ 同文件内 OneToMany
  @OneToMany(() => SessionEntity, (s) => s.user, { createForeignKeyConstraints: false })
  sessions!: SessionEntity[];

  @OneToMany(() => AuditLogEntity, (a) => a.user, { createForeignKeyConstraints: false })
  auditLogs!: AuditLogEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — 2. sessions —
@Entity('sessions')
export class SessionEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  userId: number = 0;

  @Column({ type: 'varchar', length: 128 })
  @Index('sessions_idx_token')
  token: string = '';

  @Column({ type: 'varchar', length: 100, nullable: true })
  device?: string;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip?: string;

  @Column({ type: 'datetime' })
  @Index('sessions_idx_expires')
  expiresAt!: Date;

  // ✅ Relation: user
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @CreateDateColumn()
  createdAt!: Date;
}

// — 3. sms_codes —
@Entity('sms_codes')
export class SmsCodeEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 20 })
  phone: string = '';

  @Column({ type: 'varchar', length: 10 })
  code: string = '';

  @Column({ type: 'varchar', length: 30 })
  purpose: string = '';

  @Column({ type: 'tinyint', default: 0 })
  used: number = 0;

  @Column({ type: 'datetime' })
  @Index('sms_codes_idx_expires')
  expiresAt!: Date;

  @CreateDateColumn()
  createdAt!: Date;
}

// — 4. categories —
@Entity('categories')
export class CategoryEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int', nullable: true })
  @Index('categories_idx_parent')
  parentId?: number; // 0 或 undefined = 一级分类，>0 = 子分类

  @Column({ type: 'varchar', length: 50 })
  name: string = '';

  @Column({ type: 'varchar', length: 500, nullable: true })
  icon?: string;

  @Column({ type: 'int', default: 0 })
  sort: number = 0;

  @Column({ type: 'tinyint', default: 1 })
  status: number = 1;

  // ✅ 自引用 ManyToOne（父分类）+ OneToMany（子分类）
  @ManyToOne(() => CategoryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'parentId' })
  parent?: CategoryEntity;

  @OneToMany(() => CategoryEntity, (c) => c.parent, { createForeignKeyConstraints: false })
  children!: CategoryEntity[];

  @CreateDateColumn()
  createdAt!: Date;
}

// — 5. products —
@Entity('products')
export class ProductEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 200 })
  name: string = '';

  @Column({ type: 'varchar', length: 500, nullable: true })
  cover?: string;

  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  price: number = 0;

  @Column({ type: 'int', default: 0 })
  stock: number = 0;

  @Column({ type: 'int', default: 0 })
  @Index('products_idx_sales')
  sales: number = 0;

  @Column({ type: 'int', nullable: true })
  @Index('products_idx_category')
  categoryId?: number;

  @Column({ type: 'int', nullable: true })
  @Index('products_idx_vendor')
  vendorId?: number;

  @Column({ type: 'int', nullable: true })
  @Index('products_idx_created_by')
  createdBy?: number; // 创建者 userId（用于 vendor approve 时自动关联）

  @Column({ type: 'simple-json', nullable: true })
  tags?: string[];

  // 印刷标准：每个商品可独立设置，缺省则走全局默认
  @Column({ type: 'simple-json', nullable: true })
  printStandard?: {
    /** 最低 DPI，空则用全局 150 */
    minDpi?: number;
    /** 色彩空间要求：'CMYK' | 'RGB' | 'ANY'，默认 'ANY' */
    colorSpace?: 'CMYK' | 'RGB' | 'ANY';
    /** 最低总像素（width×height），空则用全局 250000 */
    minTotalPx?: number;
    /** 最低分辨率（px/cm²），某些商品按 cm² 计算 */
    minDensity?: number;
    /** 支持的文件格式列表，空则用全局 VALID_FORMATS */
    allowedFormats?: string[];
    /** 每个规格的具体尺寸要求（可选） */
    specRequirements?: Record<
      string,
      { minWidth?: number; minHeight?: number; dpi?: number; colorSpace?: string }
    >;
  };

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0 })
  rating: number = 0;

  @Column({ type: 'text', nullable: true })
  detail?: string;

  @Column({ type: 'tinyint', default: 1 })
  @Index('products_idx_status')
  status: number = 1;

  @Column({ type: 'int', default: 0 })
  sort: number = 0;

  /** 商品类型：ready=纯卖 / custom=需要文件定制 / combo=商品+设计打包 */
  @Column({ type: 'varchar', length: 20, default: 'ready' })
  @Index('products_idx_product_type')
  productType: 'ready' | 'custom' | 'combo' = 'ready';

  /** 设计费（combo 类型里的设计费部分，单位元） */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  designFee?: number;

  /** 印刷/生产成本（供应商的成本底，用来算抽佣基数和利润，单位元） */
  @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
  printFee?: number;

  /** 是否需要买家上传设计稿（custom 时为 true；combo 时可选） */
  @Column({ type: 'tinyint', default: 0 })
  needsDesignUpload: number = 0;

  /** 多材质选项（供应商配置可售材质，前端 SKU 级价格）
   *  例：[ { key:'aluminum', name:'铝合金（1.5mm）', surcharge:0 },
   *       { key:'stainless', name:'不锈钢（1.2mm）', surcharge:30 },
   *       { key:'acrylic',   name:'亚克力 5mm', surcharge:-10 } ]
   *  surcharge 相对基准价的增减（元），负数表示便宜 */
  @Column({ type: 'simple-json', nullable: true })
  materials?: { key: string; name: string; surcharge: number }[];

  /** 多工艺选项（如表面处理/印刷方式）
   *  例：[ { key:'plain',   name:'光面', surcharge:0 },
   *       { key:'brushed', name:'拉丝', surcharge:25 },
   *       { key:'mirror',  name:'镜面抛光', surcharge:40 } ] */
  @Column({ type: 'simple-json', nullable: true })
  crafts?: { key: string; name: string; surcharge: number }[];

  /** 组合定价（可选，覆盖 materials[i].surcharge + crafts[j].surcharge 简单加总）
   *  例：[ { material:'aluminum', craft:'brushed', price: 199 },
   *       { material:'stainless', craft:'mirror',  price: 348 } ]
   *  空则用"基准价 + material surcharge + craft surcharge"计算 */
  @Column({ type: 'simple-json', nullable: true })
  comboPrices?: { material: string; craft: string; price: number }[];

  // ✅ Relations
  @ManyToOne(() => CategoryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'categoryId' })
  category?: CategoryEntity;

  // vendorId 指向 users 表（role='vendor' 的 user）
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'vendorId' })
  vendor?: UserEntity;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — 6. banners —
@Entity('banners')
export class BannerEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 100 })
  title: string = '';

  @Column({ type: 'varchar', length: 500 })
  image: string = '';

  @Column({ type: 'varchar', length: 20 })
  linkType: string = '';

  @Column({ type: 'varchar', length: 500, nullable: true })
  link?: string;

  @Column({ type: 'int', default: 0 })
  sort: number = 0;

  @Column({ type: 'tinyint', default: 1 })
  @Index('banners_idx_status')
  status: number = 1;

  @CreateDateColumn()
  createdAt!: Date;
}

// — 7. search_hot_keywords —
@Entity('search_hot_keywords')
export class SearchKeywordEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 50, unique: true })
  keyword: string = '';

  @Column({ type: 'int', default: 0 })
  searchCount: number = 0;

  @Column({ type: 'int', default: 0 })
  sort: number = 0;

  @Column({ type: 'tinyint', default: 1 })
  status: number = 1;
}

// — 8. audit_logs —
@Entity('audit_logs')
export class AuditLogEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int', nullable: true })
  @Index('audit_logs_idx_user')
  userId?: number;

  @Column({ type: 'varchar', length: 50 })
  @Index('audit_logs_idx_action')
  action: string = '';

  @Column({ type: 'varchar', length: 30, nullable: true })
  targetType?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  targetId?: string;

  @Column({ type: 'varchar', length: 45, nullable: true })
  ip?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent?: string;

  // ✅ Relation
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity;

  @CreateDateColumn()
  @Index('audit_logs_idx_time')
  createdAt!: Date;
}

// — Sprint 2 / 3 / 4 / 5 / 6 / 7 / 8 实体 re-export —
export { AddressEntity, CartEntity, OrderEntity, OrderItemEntity } from './sprint2';
export { DesignFileEntity, DesignDemandEntity } from './sprint3';
export {
  InstallationDemandEntity,
  InstallationQuoteEntity,
  InstallationOrderEntity,
  WarrantyClaimEntity,
} from './sprint4';
export {
  InstallerProfileEntity,
  InstallerSpecialtyEntity,
  QuoteMessageEntity,
  InstallerReviewEntity,
  DesignerProfileEntity,
  InstallerProjectEntity,
} from './sprint5';
export {
  FavoriteEntity,
  CouponEntity,
  UserCouponEntity,
  ConversationEntity,
  ChatMessageEntity,
  WithdrawRequestEntity,
} from './sprint6';
export { DesignOrderEntity, DesignDeliveryEntity, DesignRevisionRequestEntity } from './sprint7';
export { ReviewEntity, RefundEntity } from './sprint8';
export { SettleOrderEntity, MoneyFlowEntity } from './sprint9-funds';
export { BankCardEntity } from './sprint10-bankcards';
export { SystemConfigEntity } from './sprint11-system';
export { ProvinceEntity, CityEntity, DistrictEntity } from './sprint12-areas';
export { DisputeEntity } from './sprint13-dispute';
export { PlatformTransactionEntity, genPlatformTxNo } from './sprint-platform';

// — MasterOrder 主订单（跨 Sprint 顶层聚合根）—
export { MasterOrderEntity } from './sprint-master';

// ============================================================================
// Sprint 10：供应商配送区域 + 快递公司码表（v4.1 新增）
// ============================================================================

// — ExpressCompany 快递公司码表 —
@Entity('express_companies')
export class ExpressCompanyEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 16, unique: true })
  code: string = ''; // 快递100 标准：SF/YTO/ZTO/JD/EMS/STO/YD

  @Column({ type: 'varchar', length: 32 })
  name: string = '';

  @Column({ type: 'varchar', length: 20, nullable: true })
  apiProvider?: string; // 'kuaidi100' | 'kuaidiniao' | null（mock fallback）

  @Column({ type: 'varchar', length: 256, nullable: true })
  apiAccount?: string; // AES-256-GCM 加密存储

  @Column({ type: 'varchar', length: 512, nullable: true })
  apiKey?: string; // AES-256-GCM 加密存储

  @Column({ type: 'varchar', length: 512, default: '' })
  defaultTrackingUrl: string = ''; // https://www.kuaidi100.com/chaxun?com={code}&nu={no}

  @Column({ type: 'tinyint', default: 1 })
  @Index('express_companies_idx_ec_enabled')
  enabled: number = 1;

  @Column({ type: 'int', default: 0 })
  sort: number = 0;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime', nullable: true })
  updatedAt!: Date;
}

// — VendorZonePermission 供应商县区权限（管理员开通，不收费）—
@Entity('vendor_zone_permissions')
export class VendorZonePermissionEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('vendor_zone_permissions_idx_vzp_vendor')
  vendorId: number = 0;

  @Column({ type: 'varchar', length: 32 })
  province: string = '';

  @Column({ type: 'varchar', length: 32 })
  city: string = '';

  @Column({ type: 'varchar', length: 32 })
  @Index('vendor_zone_permissions_idx_vzp_district')
  district: string = ''; // ✅ 权限单位：县区（供应商在这个县区内可自配送）

  @Column({ type: 'varchar', length: 16, default: 'admin_grant' })
  source: string = 'admin_grant'; // admin_grant / self_apply / platform_free

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: string = 'active'; // active / disabled / expired

  @Column({ type: 'date', nullable: true })
  expiresAt?: string; // 预留字段，后期收费续费用；null = 长期有效

  @Column({ type: 'tinyint', default: 1 })
  @Index('vendor_zone_permissions_idx_vzp_enabled')
  enabled: number = 1;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime', nullable: true })
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'vendorId' })
  vendor?: UserEntity;
}

// — P1 推送体系实体 —
export { PushDeviceEntity, PushLogEntity, NotificationsEntity, VendorDeliveryAreaEntity, type PushChannel } from './push';
