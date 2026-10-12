// ============================================================================
// Sprint 8 — Review（评价） + Refund（退款） 两表
// 对应 review-refund.ts 路由
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
  JoinColumn,
} from 'typeorm';
import { UserEntity } from './index';

// — reviews — 评价表（商品/服务/安装/设计/商家通用）
@Entity('reviews')
export class ReviewEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('reviews_idx_review_user')
  userId: number = 0;

  @Column({ type: 'varchar', length: 20 })
  @Index('reviews_idx_review_target')
  targetType: string = ''; // product/service/installer/designer/vendor

  @Column({ type: 'int' })
  @Index('reviews_idx_review_target_id')
  targetId: number = 0;

  @Column({ type: 'int', nullable: true })
  orderId?: number;

  @Column({ type: 'tinyint' })
  rating: number = 5; // 1-5

  @Column({ type: 'varchar', length: 500 })
  content: string = '';

  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  @Column({ type: 'varchar', length: 20, default: 'published' })
  @Index('reviews_idx_review_status')
  status: string = 'published';

  @Column({ type: 'int', default: 0 })
  helpful: number = 0;

  // ✅ Relation: 评价者（确定指向 users）
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  // ⚠️ targetId 是多态 FK（targetType='product'→products, 'service'→..., 'installer'→installer_profiles）
  // 不声明 relation（TypeORM 不支持多态 FK，运行时按 targetType 判断）
  // orderId 同理 — 可能指向 orders（电商）或 design_orders（设计）— 跳过

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — refunds — 退款申请表
@Entity('refunds')
export class RefundEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('refunds_idx_refund_user')
  userId: number = 0;

  @Column({ type: 'int' })
  @Index('refunds_idx_refund_order')
  orderId: number = 0;

  @Column({ type: 'varchar', length: 32 })
  orderNo: string = '';

  @Column({ type: 'varchar', length: 30, default: 'other' })
  reasonType: string = 'other';

  @Column({ type: 'varchar', length: 500 })
  reason: string = '';

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: number = 0;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  description?: string;

  @Column({ type: 'simple-json', nullable: true })
  images?: string[];

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index('refunds_idx_refund_status')
  status: string = 'pending'; // pending/approved/rejected/completed

  // 🚨 2026-10-11 #11 退货运费责任判定
  @Column({ type: 'varchar', length: 20, default: 'user' })
  shippingFeeLiable: string = 'user'; // merchant=商家出 / user=买家出 / platform=平台出

  @Column({ type: 'varchar', length: 500, nullable: true })
  shippingFeeLiableReason?: string; // admin 判定理由：质量问题 / 无理由 / 印刷错误 等

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  shippingAmount: number = 0; // 退货运费金额（shippingFeeLiable=user 时从退款金额里扣）

  @Column({ type: 'int', nullable: true })
  reviewedBy?: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reviewRemark?: string;

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  // reviewedBy → admin userId（也是指向 users 表，同类型）
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'reviewedBy' })
  reviewer?: UserEntity;

  // ⚠️ orderId 是多态 FK（可能指向 orders 或 design_orders）— 跳过
  // 路由代码按 orderNo + orderNo 前缀（DO/DIO/IO）判断类型

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
