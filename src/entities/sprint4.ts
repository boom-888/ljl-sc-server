// ============================================================================
// TypeORM Entities — Sprint 4 安装需求众包（用户端发布 + 师傅端报价）
// 三张表：InstallationDemand / InstallationQuote / InstallationOrder
// 全部显式 type，tsx/esbuild 兼容
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
// ⚠️ 普通 import（不是 import type）— decorator 里 () => InstallerProfileEntity 需要值引用
// 循环依赖靠 TypeORM 惰性函数 () => OtherEntity 解决（运行时调用时所有模块已加载）
import { InstallerProfileEntity } from './sprint5';

// ═════════════════════════════════════════════════════════════════
// Relation 闭合规则（重要！防踩坑）:
//   ManyToOne  — 声明在子表（有 xxxId 列的那个），用 joinColumn: { name: 'xxxId' }
//   OneToMany  — 声明在父表，用 ManyToOne 属性名（非列名！）反向指向
//   跨文件     — import type + () => OtherEntity 惰性加载（避免循环依赖）
//   无物理 FK  — 全部加 createForeignKeyConstraints: false
// ═════════════════════════════════════════════════════════════════

// — InstallationDemand 安装需求（用户发布）—
@Entity('installation_demands')
export class InstallationDemandEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('installation_demands_idx_user')
  userId: number = 0;

  @Column({ type: 'int', nullable: true })
  @Index('installation_demands_idx_category')
  categoryId?: number; // 对应 categories.id（发光字/灯箱/门牌…）

  @Column({ type: 'varchar', length: 50 })
  serviceType: string = ''; // 冗余字段："lightbox"/"signage"/"banner"…

  @Column({ type: 'varchar', length: 200 })
  address: string = '';

  @Column({ type: 'float' })
  serviceLat: number = 0;

  @Column({ type: 'float' })
  serviceLng: number = 0;

  @Column({ type: 'datetime', nullable: true })
  expectedTime?: Date;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  budgetMin?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  budgetMax?: number;

  @Column({ type: 'int', default: 10 })
  radiusKm: number = 10; // 推送半径：10 → 25

  // — 🚨 P0 修复：之前前端提交了 contactName/contactPhone 但后端没存 —
  @Column({ type: 'varchar', length: 30, nullable: true })
  contactName?: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  contactPhone?: string;

  // — P1: 关联的商品 ID（安装师傅需要知道装的是什么）—
  @Column({ type: 'int', nullable: true })
  productId?: number;

  // — 📐 Sprint 9 安装结构化字段（让师傅精准报价的关键字段）—
  @Column({ type: 'varchar', length: 30, nullable: true })
  craftType?: string; // 工艺类型：edge-lit / flat / mini / lightbox / uv-banner / led-screen / signage / wall-culture

  @Column({ type: 'varchar', length: 60, nullable: true })
  specSize?: string; // 规格尺寸："长8m×高0.6m" 或 "面积4.8㎡"

  @Column({ type: 'varchar', length: 10, nullable: true })
  installHeight?: string; // 安装高度：ground / low(1-3f) / mid(4-6f) / high(≥7f) / extreme(高空作业)

  @Column({ type: 'varchar', length: 15, nullable: true })
  powerStatus?: string; // 电源情况：ready / need_connect / none

  @Column({ type: 'varchar', length: 10, nullable: true })
  materialBy?: string; // 辅料：user(自备) / installer(包工包料)

  @Column({ type: 'tinyint', default: 0 })
  needDemolition: number = 0; // 是否拆旧：0=新装 1=先拆后装 2=改字保留底板

  @Column({ type: 'varchar', length: 20, nullable: true })
  installLocation?: string; // 安装位置：storefront / indoor / rooftop / glass_wall / ceiling

  @Column({ type: 'simple-json', nullable: true })
  accessibility?: string[]; // 现场可达性：parking / elevator / stairs / freight_limited

  @Column({ type: 'simple-json', nullable: true })
  sitePhotos?: string[]; // 现场照片 URL（最多 5 张）

  // — 🚨 2026-10-11 #12 加急标记：用户选加急后预算自动上浮 50-100%，让师傅优先报价 —
  @Column({ type: 'tinyint', default: 0 })
  urgentFlag: number = 0; // 0=普通 1=加急

  // — 6 级体系：需求端指定期望师傅等级 —
  @Column({ type: 'tinyint', default: 1 })
  gradeMin: number = 1; // 最低等级（不填默认 1 = 不限）

  @Column({ type: 'tinyint', default: 6 })
  gradeMax: number = 6; // 最高等级（不填默认 6 = 不限）

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index('installation_demands_idx_status')
  status: string = 'pending'; // pending / quoting / accepted / rejected_all / expired / cancelled / completed

  @Column({ type: 'datetime', nullable: true })
  expandedAt?: Date; // 30 分钟超时后扩大范围的时间

  @Column({ type: 'int', default: 0 })
  quoteCount: number = 0;

  // ✅ Relations — 同文件直接引用类名
  @OneToMany(() => InstallationQuoteEntity, (q) => q.demand, { createForeignKeyConstraints: false })
  quotes!: InstallationQuoteEntity[];

  @OneToMany(() => InstallationOrderEntity, (o) => o.demand, { createForeignKeyConstraints: false })
  orders!: InstallationOrderEntity[];

  @CreateDateColumn()
  @Index('installation_demands_idx_created')
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — InstallationQuote 师傅报价（多条）—
@Entity('installation_quotes')
export class InstallationQuoteEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('installation_quotes_idx_demand')
  demandId: number = 0;

  @Column({ type: 'int' })
  @Index('installation_quotes_idx_installer')
  installerId: number = 0;

  // — 报价总额（自动 = labor + materials + freight + tax + toolFee）—
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number = 0;

  // — 报价明细（让师傅和买家都清楚钱花在哪）—
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  labor: number = 0; // 人工费

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  materials: number = 0; // 辅料费（胶/螺丝/线缆等）

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  freight: number = 0; // 运费（远距/高楼层）

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  tax: number = 0; // 税费（专票 6%）

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  toolFee: number = 0; // 平台提供工具费

  // — 报价模式 —
  @Column({ type: 'varchar', length: 20, default: '清工' })
  materialMode: string = '清工'; // 清工 / 包工包料 / 包工不包料

  @Column({ type: 'tinyint', default: 0 })
  toolProvided: number = 0; // 0=自备 1=平台提供

  @Column({ type: 'tinyint', default: 0 })
  needsElectricalPermit: number = 0; // 0=不需要 1=需要（大型招牌/LED 屏）

  // — 高空作业分级（辅助信息，用于定价系数）—
  @Column({ type: 'varchar', length: 10, nullable: true })
  heightTier?: string; // low/mid/high/sky

  @Column({ type: 'varchar', length: 100, nullable: true })
  eta?: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: string = 'pending'; // pending / accepted / cancelled / rejected

  // ✅ Relations
  @ManyToOne(() => InstallationDemandEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'demandId' })
  demand!: InstallationDemandEntity;

  // 跨文件 — 用 import type + () => OtherEntity 惰性加载
  @ManyToOne(() => InstallerProfileEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'installerId' })
  installer!: InstallerProfileEntity;

  @CreateDateColumn()
  @Index('installation_quotes_idx_created')
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — InstallationOrder 安装订单（1 个 demand 对应 1 个）—
@Entity('installation_orders')
export class InstallationOrderEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 32, unique: true })
  @Index('installation_orders_idx_no')
  orderNo: string = '';

  @Column({ type: 'int' })
  @Index('installation_orders_idx_demand')
  demandId: number = 0;

  @Column({ type: 'int' })
  @Index('installation_orders_idx_quote')
  quoteId: number = 0;

  @Column({ type: 'int' })
  @Index('installation_orders_idx_user')
  userId: number = 0;

  @Column({ type: 'int' })
  @Index('installation_orders_idx_installer')
  installerId: number = 0;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  finalPrice: number = 0;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index('installation_orders_idx_status')
  status: string = 'pending'; // pending(started)/in_progress/completed/reviewed/cancelled

  // 🆕 v3.0 现场施工 5 阶段
  // stages: 0=开工(无照片), 1=隐蔽工程(必拍), 2=主体安装(必拍), 3=收尾调试(可选), 4=竣工验收(必拍), 5=买家已验收通过
  @Column({ name: 'current_stage', type: 'tinyint', default: 0 })
  currentStage: number = 0;

  // 每阶段照片 JSON：{ "1": { photos: string[], note: string, uploadedAt: ISO }, "2": {...} }
  @Column({ name: 'stage_photos', type: 'simple-json', nullable: true })
  stagePhotos?: any;

  @Column({ name: 'progress_note', type: 'text', nullable: true })
  progressNote?: string;

  @Column({ type: 'datetime', nullable: true })
  startedAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  completedAt?: Date;

  // — 90 天质保（Sprint 8 新增）—
  @Column({ type: 'varchar', length: 20, default: 'none' })
  @Index('installation_orders_idx_warranty')
  warrantyStatus: string = 'none'; // none/active/expired/claimed/settled

  @Column({ type: 'datetime', nullable: true })
  warrantyExpireAt?: Date; // 完工日 + 90 天

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  warrantyHoldAmount: number = 0; // 质保扣留金额 = finalPrice * 0.05（默认 5%）

  // P0-2: 主订单关联（MasterOrder）
  @Column({ type: 'int', nullable: true })
  masterOrderId?: number;

  // P0-2: 商品关联（安装师傅需要知道装的是什么）
  @Column({ type: 'int', nullable: true })
  productId?: number;

  // ✅ Relations
  @ManyToOne(() => InstallationDemandEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'demandId' })
  demand!: InstallationDemandEntity;

  @ManyToOne(() => InstallationQuoteEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'quoteId' })
  quote!: InstallationQuoteEntity;

  @ManyToOne(() => InstallerProfileEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'installerId' })
  installer!: InstallerProfileEntity;

  @CreateDateColumn()
  @Index('installation_orders_idx_created')
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — WarrantyClaim 质保索赔（Sprint 8 新增）—
@Entity('warranty_claims')
export class WarrantyClaimEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 32, unique: true })
  @Index('warranty_claims_idx_claim_no')
  claimNo: string = '';

  @Column({ type: 'int' })
  @Index('warranty_claims_idx_order')
  orderId: number = 0;

  @Column({ type: 'varchar', length: 32 })
  orderNo: string = '';

  @Column({ type: 'int' })
  @Index('warranty_claims_idx_user')
  userId: number = 0;

  @Column({ type: 'int' })
  @Index('warranty_claims_idx_installer')
  installerId: number = 0;

  @Column({ type: 'text' })
  issueDesc: string = ''; // 问题描述（"灯箱 LED 不亮了"）

  @Column({ type: 'simple-json', nullable: true })
  images?: string[]; // 问题照片

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index('warranty_claims_idx_status')
  status: string = 'pending'; // pending/accepted/rejected/resolved/arbitrated/paid

  @Column({ type: 'varchar', length: 200, nullable: true })
  installerResponse?: string; // 师傅响应（"已联系，明天上门" / "人为损坏不保修"）

  @Column({ type: 'datetime', nullable: true })
  installerRespondAt?: Date;

  @Column({ type: 'varchar', length: 200, nullable: true })
  resolution?: string; // 最终处理（"师傅已上门修复" / "从保证金扣 ¥800 赔付"）

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  compensationAmount: number = 0; // 实际赔付金额（从质保金或保证金里扣）

  @Column({ type: 'int', nullable: true })
  handlerId?: number; // 处理人 userId（仲裁时 = admin）

  // ✅ Relations
  @ManyToOne(() => InstallationOrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'orderId' })
  order!: InstallationOrderEntity;

  @ManyToOne(() => InstallerProfileEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'installerId' })
  installer!: InstallerProfileEntity;

  @CreateDateColumn()
  @Index('warranty_claims_idx_created')
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
