// ============================================================================
// 📐 Design File Entity — Sprint 3
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
import { UserEntity, ProductEntity } from './index';

@Entity('design_files')
export class DesignFileEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('design_files_idx_user')
  userId: number = 0;

  @Column({ type: 'varchar', length: 200 })
  fileName: string = '';

  @Column({ type: 'varchar', length: 200 })
  originalName: string = '';

  @Column({ type: 'varchar', length: 20 })
  format: string = ''; // psd/ai/fig/sketch/pdf/jpg/png...

  @Column({ type: 'int' })
  fileSize: number = 0;

  @Column({ type: 'varchar', length: 500, nullable: true })
  url?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  thumbnailUrl?: string;

  @Column({ type: 'int', nullable: true })
  widthPx?: number;

  @Column({ type: 'int', nullable: true })
  heightPx?: number;

  @Column({ type: 'int', nullable: true })
  dpi?: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  colorSpace?: string;

  @Column({ type: 'int', nullable: true })
  pages?: number;

  @Column({ type: 'int', nullable: true })
  layers?: number;

  @Column({ type: 'int', default: 1 })
  version: number = 1;

  @Column({ type: 'int', nullable: true })
  @Index('design_files_idx_parent')
  parentId?: number;

  @Column({ type: 'varchar', length: 30, default: 'uploaded' })
  @Index('design_files_idx_status')
  status: string = 'uploaded'; // uploading/uploaded/validating/valid/warning/rejected/manual_review/used/archived

  @Column({ type: 'simple-json', nullable: true })
  validation?: {
    passed: boolean;
    score: number;
    issues: { type: string; message: string; level: string }[];
    recommendTargetSize?: string;
  };

  @Column({ type: 'int', nullable: true })
  productId?: number;

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'productId' })
  product?: ProductEntity;

  // 自引用 ManyToOne（父文件，如缩略图 → 原图）
  @ManyToOne(() => DesignFileEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'parentId' })
  parent?: DesignFileEntity;

  @OneToMany(() => DesignFileEntity, (f) => f.parent, { createForeignKeyConstraints: false })
  children!: DesignFileEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// ============================================================================
// 📋 Design Demand Entity — Sprint 3.5 需求撮合
// 骨架实现：发布/列表/详情/撤销
// 后续可扩展：quotes[]、地理围栏字段、虚拟号保护
// ============================================================================
@Entity('design_demands')
export class DesignDemandEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('design_demands_idx_user')
  userId: number = 0;

  @Column({ type: 'varchar', length: 32, unique: true })
  orderNo: string = '';

  @Column({ type: 'int', nullable: true })
  productId?: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  productName?: string;

  @Column({ type: 'text' })
  demandText: string = '';

  @Column({ type: 'varchar', length: 50 })
  budget: string = ''; // 如 "¥500-1000" — 🔧 保留向后兼容，新代码用 budgetMin/budgetMax

  // — 📐 Sprint 9：拆 budget varchar 为 decimal 字段（结构化排序/查询）—
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  budgetMin?: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  budgetMax?: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  contactPhone?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  wechat?: string;

  @Column({ type: 'varchar', length: 30 })
  deliveryTime: string = '';

  // — 📐 Sprint 9：设计品类（让设计师精准报价）—
  @Column({ type: 'varchar', length: 30, nullable: true })
  designCategory?: string; // logo / vi / poster / packaging / banner / menu / card / ppt（原 Sprint 9 demandType 改名）

  // — 📐 P1：需求模式 —
  @Column({ type: 'varchar', length: 20, default: 'design' })
  demandType: 'design' | 'fix' = 'design'; // design=从零设计 fix=改稿（买家有现成稿）

  @Column({ type: 'simple-json', nullable: true })
  styleTags?: string[]; // 风格：minimal / retro / guochao / business / illustration / 3d

  @Column({ type: 'varchar', length: 80, nullable: true })
  specSize?: string; // 尺寸规格："A4 / 120×80cm / 1920×1080px"

  @Column({ type: 'varchar', length: 50, nullable: true })
  deliverables?: string; // 交付物："3稿+源文件 / 5稿 / 仅1稿"

  @Column({ type: 'varchar', length: 15, nullable: true })
  commercialLicense?: string; // 授权：personal / commercial / exclusive

  // — 🚨 2026-10-11 #3 设计版权授权签署时间戳 —
  // 用户勾选"付清全款后获得商用授权、设计师保留署名权和作品集展示权"后的确认时间
  @Column({ type: 'datetime', nullable: true })
  agreementSignedAt?: Date;

  @Column({ type: 'simple-json', nullable: true })
  referenceImages?: string[]; // 参考图 URL（最多 9 张）

  // — 🚨 2026-10-11 #12 加急标记：用户选加急后预算自动上浮 50-100%，让设计师优先报价 —
  @Column({ type: 'tinyint', default: 0 })
  urgentFlag: number = 0; // 0=普通 1=加急

  // — 6 级体系：需求端指定期望设计师等级 —
  @Column({ type: 'tinyint', default: 1 })
  gradeMin: number = 1; // 最低等级（不填默认 1 = 不限下限）

  @Column({ type: 'tinyint', default: 6 })
  gradeMax: number = 6; // 最高等级（不填默认 6 = 不限上限）

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index('design_demands_idx_status')
  status: string = 'pending'; // pending/quoting/accepted/in_progress/completed/cancelled

  @Column({ type: 'varchar', length: 20, default: '待接单' })
  statusText: string = '待接单';

  @Column({ type: 'int', nullable: true })
  designerId?: number;

  // — 🆕 Sprint 13：设计师报价数组（bid 机制）—
  // 注意：budgetMin/budgetMax 是买家预算区间，bidders[i].quotePrice 才是设计师实际报价
  @Column({ type: 'simple-json', nullable: true })
  bidders?: Array<{
    designerId: number;
    designerNickname: string;
    designerAvatar?: string;
    designerGrade?: number;
    quotePrice: number;
    note?: string;
    createdAt: string; // ISO date string
    counterOffers?: Array<{
      from: 'buyer' | 'designer';
      price: number;
      note?: string;
      at: string;
    }>;
    accepted?: boolean;
  }>;

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'productId' })
  product?: ProductEntity;

  // 跨文件：DesignerProfileEntity 在 sprint5.ts — 普通 import 避免 import type 限制
  @ManyToOne(
    () => {
      // 惰性 require 避免循环依赖（sprint5 已经 import index.ts）
      const { DesignerProfileEntity } = require('./sprint5');
      return DesignerProfileEntity;
    },
    { createForeignKeyConstraints: false },
  )
  @JoinColumn({ name: 'designerId' })
  designer?: import('./sprint5').DesignerProfileEntity;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
