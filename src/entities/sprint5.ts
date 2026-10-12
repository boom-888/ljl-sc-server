// ============================================================================
// TypeORM Entities — Sprint 5 安装师傅端完整数据模型
// 五张表：InstallerProfile / InstallerSpecialty / QuoteMessage / InstallerReview / InstallerProject
// ============================================================================
import 'reflect-metadata';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
// ⚠️ 普通 import — decorator 里 () => XxxEntity 需要值引用
// 循环依赖靠 () => OtherEntity 惰性函数解决
import { InstallationQuoteEntity, InstallationOrderEntity, WarrantyClaimEntity } from './sprint4';
import { UserEntity } from './index';

// — InstallerProfile 师傅资料（扩展 users.role='installer'）—
@Entity('installer_profiles')
export class InstallerProfileEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int', unique: true })
  @Index('installer_profiles_idx_user')
  userId: number = 0;

  @Column({ type: 'varchar', length: 50 })
  realName: string = '';

  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar?: string;

  @Column({ type: 'varchar', length: 20 })
  @Index('installer_profiles_idx_phone')
  phone: string = '';

  // — 审核 —
  @Column({ type: 'tinyint', default: 0 })
  @Index('installer_profiles_idx_verified')
  verified: number = 0; // 0=pending 1=verified 2=rejected

  @Column({ type: 'varchar', length: 255, nullable: true })
  verifyNote?: string;

  @Column({ type: 'datetime', nullable: true })
  verifiedAt?: Date;

  @Column({ type: 'int', nullable: true })
  verifiedBy?: number; // admin userId

  // — 资质 —
  @Column({ type: 'varchar', length: 500, nullable: true })
  idCardFront?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  idCardBack?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  businessLicense?: string;

  // — 特种作业证（JSON 数组）—
  @Column({ type: 'simple-json', nullable: true })
  certifications?: Array<{
    type: string; // 高空作业证 / 电工证 / 焊工证 / 架子工证 / 其他
    name: string; // 证书全称
    certNo: string; // 证书编号
    imageUrl: string; // 证书照片 URL
    expireAt: string; // ISO 日期
    verified: boolean; // admin 是否已核验真伪
  }>;

  // — 保险 —
  @Column({ type: 'varchar', length: 50, nullable: true })
  insuranceProvider?: string; // 人保 / 平安 / 太保

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  insuranceAmount: number = 0; // 保额（元）

  @Column({ type: 'date', nullable: true })
  insuranceExpire?: Date;

  // — 平台保证金 —
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  bondAmount: number = 0;

  @Column({ type: 'varchar', length: 20, default: 'none' })
  bondStatus: string = 'none'; // none / frozen / available / deducted

  // — 结算 —
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  earningsAvailable: number = 0; // 可提现余额

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  earningsFrozen: number = 0; // 7 天冻结期内

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  totalEarnings: number = 0; // 历史累计

  // — 作业高度能力 —
  @Column({ type: 'varchar', length: 10, default: 'low' })
  heightTier: string = 'low'; // low=≤3m / mid=3-15m / high=15-50m / sky=≥50m

  @Column({ type: 'decimal', precision: 5, scale: 1, default: 3 })
  heightMax: number = 3; // 最高可操作高度（米）

  // — 服务范围 —
  @Column({ type: 'varchar', length: 200, nullable: true })
  serviceAddress?: string;

  @Column({ type: 'float', default: 0 })
  serviceLat: number = 0;

  @Column({ type: 'float', default: 0 })
  serviceLng: number = 0;

  @Column({ type: 'int', default: 15 })
  serviceRadiusKm: number = 15;

  // — 6 级体系：师傅等级（1=学徒 → 6=专家）—
  @Column({ type: 'tinyint', default: 1 })
  @Index('installer_profiles_idx_grade')
  grade: number = 1;

  @Column({ type: 'varchar', length: 20, nullable: true })
  gradeTitle?: string; // "学徒小工 / 初级 / 中级 / 高级 / 资深 / 专家大师"

  @Column({ type: 'tinyint', default: 0 })
  gradeManual: number = 0; // 0=自动计算 1=admin 手动锁定

  // — 信用 —
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5.0 })
  rating: number = 5.0;

  @Column({ type: 'int', default: 0 })
  ratingCount: number = 0;

  @Column({ type: 'int', default: 0 })
  completedOrders: number = 0;

  // — 银行（提现用，Phase 3 实现）—
  @Column({ type: 'varchar', length: 30, nullable: true })
  bankCard?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  bankHolder?: string;

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  // 反向 OneToMany 闭合（对应 sprint4.ts 的 ManyToOne → installer）
  @OneToMany(() => InstallationQuoteEntity, (q) => q.installer, {
    createForeignKeyConstraints: false,
  })
  quotes!: InstallationQuoteEntity[];

  @OneToMany(() => InstallationOrderEntity, (o) => o.installer, {
    createForeignKeyConstraints: false,
  })
  orders!: InstallationOrderEntity[];

  @OneToMany(() => WarrantyClaimEntity, (w) => w.installer, { createForeignKeyConstraints: false })
  warrantyClaims!: WarrantyClaimEntity[];

  // 同文件内 OneToMany
  @OneToMany(() => InstallerSpecialtyEntity, (s) => s.installer, {
    createForeignKeyConstraints: false,
  })
  specialties!: InstallerSpecialtyEntity[];

  @OneToMany(() => InstallerReviewEntity, (r) => r.installer, {
    createForeignKeyConstraints: false,
  })
  reviews!: InstallerReviewEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — InstallerSpecialty 师傅擅长分类（多对多中间表）—
@Entity('installer_specialties')
@Unique('installer_category', ['installerId', 'categoryId'])
export class InstallerSpecialtyEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('installer_specialties_idx_installer')
  installerId: number = 0;

  @Column({ type: 'int' })
  @Index('installer_specialties_idx_category')
  categoryId: number = 0;

  @Column({ type: 'tinyint', default: 1 })
  level: number = 1; // 1=熟悉 2=精通 3=专家

  @Column({ type: 'int', default: 1 })
  yearsExp: number = 1;

  // ✅ Relation: 师傅
  @ManyToOne(() => InstallerProfileEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'installerId' })
  installer!: InstallerProfileEntity;

  @CreateDateColumn()
  createdAt!: Date;
}

// — QuoteMessage 报价沟通线程（双向砍价/加预算/聊天）—
@Entity('quote_messages')
export class QuoteMessageEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('quote_messages_idx_quote')
  quoteId: number = 0;

  @Column({ type: 'int' })
  @Index('quote_messages_idx_sender')
  senderUserId: number = 0;

  @Column({ type: 'varchar', length: 20 })
  senderRole: string = 'user'; // user / installer

  @Column({ type: 'text' })
  content: string = '';

  @Column({ type: 'varchar', length: 20, default: 'text' })
  messageType: string = 'text'; // text/counter_offer/budget_increase/system

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  counterPrice?: number; // 如果是砍价/加预算消息，填这个金额

  @Column({ type: 'tinyint', default: 0 })
  isRead: number = 0;

  // ✅ Relation: 报价（跨文件）
  @ManyToOne(() => InstallationQuoteEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'quoteId' })
  quote!: InstallationQuoteEntity;

  @CreateDateColumn()
  @Index('quote_messages_idx_created')
  createdAt!: Date;
}

// — InstallerReview 师傅评价（用户完成订单后评价）—
@Entity('installer_reviews')
@Unique('order_only_once', ['orderId'])
export class InstallerReviewEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int', unique: true })
  orderId: number = 0;

  @Column({ type: 'int' })
  @Index('installer_reviews_idx_installer')
  installerId: number = 0;

  @Column({ type: 'int' })
  @Index('installer_reviews_idx_user')
  userId: number = 0;

  @Column({ type: 'tinyint' })
  rating: number = 5; // 1-5 星

  @Column({ type: 'text', nullable: true })
  content?: string;

  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  @Column({ type: 'varchar', length: 200, nullable: true })
  tags?: string; // "准时,专业,干净" 逗号分隔

  // ✅ Relations
  @ManyToOne(() => InstallationOrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'orderId' })
  order!: InstallationOrderEntity;

  @ManyToOne(() => InstallerProfileEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'installerId' })
  installer!: InstallerProfileEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @CreateDateColumn()
  @Index('installer_reviews_idx_created')
  createdAt!: Date;
}

// ============================================================================
// 🎨 DesignerProfile 设计师资料 — Sprint 7 新增（设计行业专属字段）
// 解决之前设计师资料全存 users 表、rating 硬编码 4.8 的问题
// ============================================================================
@Entity('designer_profiles')
export class DesignerProfileEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int', unique: true })
  @Index('designer_profiles_idx_user')
  userId: number = 0;

  @Column({ type: 'varchar', length: 50 })
  realName: string = '';

  @Column({ type: 'varchar', length: 500, nullable: true })
  avatar?: string;

  // — 审核 —
  @Column({ type: 'tinyint', default: 0 })
  @Index('designer_profiles_idx_verified')
  verified: number = 0;

  @Column({ type: 'datetime', nullable: true })
  verifiedAt?: Date;

  // — 设计行业属性 —
  @Column({ type: 'simple-json', nullable: true })
  designStyles?: string[]; // ["简约","高端","科技","国潮","复古","卡通","写实"]

  @Column({ type: 'simple-json', nullable: true })
  specialties?: string[]; // ["Logo","VI","海报","门头","灯箱","喷绘","插画","3D"]

  @Column({ type: 'int', default: 1 })
  yearsExp: number = 1; // 从业年限

  @Column({ type: 'varchar', length: 20, default: 'solo' })
  teamSize: string = 'solo'; // solo（个人）/ small（1-3人）/ studio（4-10人）/ agency（10+）

  @Column({ type: 'varchar', length: 50, default: '¥500-1500' })
  priceRange: string = '¥500-1500'; // 单项目报价区间（展示用）

  @Column({ type: 'text', nullable: true })
  intro?: string; // 个人/工作室介绍

  // — 改稿承诺（对买家展示）—
  @Column({ type: 'int', default: 3 })
  revisionIncluded: number = 3; // 套餐内含几次改稿

  @Column({ type: 'int', default: 5 })
  revisionMax: number = 5; // 最多可改几次（超了加钱）

  @Column({ type: 'varchar', length: 200, nullable: true })
  revisionPolicy?: string; // "每超一次 ¥100" 等自定义说明

  // — 源文件交付 —
  @Column({ type: 'tinyint', default: 1 })
  deliverSource: number = 1; // 1=含源文件 0=默认不含（需额外购买）

  @Column({ type: 'varchar', length: 100, nullable: true })
  sourceFormats?: string; // "AI/PS/Sketch/Figma" 逗号分隔

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  sourceExtraFee: number = 0; // 默认不含时，源文件额外费

  // — AI 辅助设计标签（2024+ 设计师必备）—
  @Column({ type: 'simple-json', nullable: true })
  aiTools?: string[]; // ["Midjourney","SD","DALL-E","Runway","Figma AI"]

  @Column({ type: 'tinyint', default: 0 })
  aiProficient: number = 0; // 0=了解 1=熟练 2=精通

  // — 版权/奖项 —
  @Column({ type: 'simple-json', nullable: true })
  awards?: Array<{
    // 设计奖项（增加信任）
    name: string; // "红点设计奖"
    org: string; // "德国 Red Dot"
    year: number; // 2023
    imageUrl?: string;
  }>;

  @Column({ type: 'tinyint', default: 0 })
  copyrightRegistered: number = 0; // 1=支持 DCI 数字版权登记（+¥5/件）

  // — 信用（与 installer 对齐）—
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5.0 })
  rating: number = 5.0;

  @Column({ type: 'int', default: 0 })
  ratingCount: number = 0;

  @Column({ type: 'int', default: 0 })
  completedOrders: number = 0;

  // — 6 级体系：设计师等级（1=新手 → 6=大咖）—
  @Column({ type: 'tinyint', default: 1 })
  @Index('designer_profiles_idx_grade')
  grade: number = 1;

  @Column({ type: 'varchar', length: 20, nullable: true })
  gradeTitle?: string; // "新手实习 / 初级 / 中级 / 高级 / 资深 / 顶级大咖"

  @Column({ type: 'tinyint', default: 0 })
  gradeManual: number = 0; // 0=自动计算 1=admin 手动锁定

  // — VIP 等级（calcVipLevel 计算后缓存）—
  @Column({ type: 'varchar', length: 20, default: 'none' })
  vipLevel: string = 'none'; // none/silver/gold/diamond

  // — 平台保证金 —
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  bondAmount: number = 0;

  @Column({ type: 'varchar', length: 20, default: 'none' })
  bondStatus: string = 'none';

  // — 结算 —
  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  earningsAvailable: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  earningsFrozen: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  totalEarnings: number = 0;

  // — 作品集/案例（JSON 数组，含 title/description/images/designCategory/year）—
  @Column({ type: 'simple-json', nullable: true })
  portfolio?: Array<{
    id: string;
    title: string;
    description?: string;
    images?: string[];
    designCategory?: string;
    year?: number;
    createdAt?: string;
  }>;

  // — 银行 —
  @Column({ type: 'varchar', length: 30, nullable: true })
  bankCard?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  bankHolder?: string;

  // ✅ Relation: user
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity('installer_projects')
export class InstallerProjectEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('installer_projects_idx_installer')
  installerId: number = 0;

  @Column({ type: 'varchar', length: 100 })
  title: string = '';

  @Column({ type: 'int', nullable: true })
  @Index('installer_projects_idx_category')
  categoryId?: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  location?: string;

  @Column({ type: 'date', nullable: true })
  completedAt?: Date;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  priceRange?: string; // "¥3000-5000"

  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  @Column({ type: 'int', default: 0 })
  sort: number = 0;

  @CreateDateColumn()
  createdAt!: Date;
}
