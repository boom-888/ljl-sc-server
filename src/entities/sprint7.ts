// ============================================================================
// 🎨 Sprint 7 · Design Order Flow Entities
// 设计委托订单 / 交付物 / 反馈请求三表
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
import { UserEntity } from './index';

@Entity('design_orders')
export class DesignOrderEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 32, unique: true })
  orderNo: string = '';

  @Column({ type: 'int' })
  @Index()
  demandId: number = 0;

  @Column({ type: 'int' })
  @Index()
  buyerId: number = 0;

  @Column({ type: 'int' })
  @Index()
  designerId: number = 0;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number = 0;

  @Column({ type: 'decimal', precision: 5, scale: 4, default: 0.15 })
  commissionRate: number = 0.15;

  @Column({
    type: 'varchar', length: 32,
    enum: [
      'accepted',
      'designing',
      'revision_requested',
      'reviewed',
      'completed',
      'cancelled',
      'disputed',
    ],
    default: 'accepted',
  })
  status: string = 'accepted';

  @Column({ type: 'int', default: 0 })
  revisionCount: number = 0;

  @Column({ type: 'int', nullable: true })
  finalDeliveryId?: number | null;

  // P0-2: 主订单关联（MasterOrder）
  @Column({ type: 'int', nullable: true })
  masterOrderId?: number;

  @Column({ type: 'datetime' })
  acceptedAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  deadlineAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  completedAt?: Date;

  // ✅ Relations — 跨文件用 require() 惰性加载防循环
  // demand → DesignDemandEntity (sprint3)
  @ManyToOne(
    () => {
      const { DesignDemandEntity } = require('./sprint3');
      return DesignDemandEntity;
    },
    { createForeignKeyConstraints: false },
  )
  @JoinColumn({ name: 'demandId' })
  demand!: import('./sprint3').DesignDemandEntity;

  // buyer → UserEntity
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'buyerId' })
  buyer!: UserEntity;

  // designer → DesignerProfileEntity (sprint5)
  @ManyToOne(
    () => {
      const { DesignerProfileEntity } = require('./sprint5');
      return DesignerProfileEntity;
    },
    { createForeignKeyConstraints: false },
  )
  @JoinColumn({ name: 'designerId' })
  designer!: import('./sprint5').DesignerProfileEntity;

  // finalDelivery → DesignDeliveryEntity (同文件内)
  @ManyToOne(() => DesignDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'finalDeliveryId' })
  finalDelivery?: DesignDeliveryEntity;

  // OneToMany 反向闭合
  @OneToMany(() => DesignDeliveryEntity, (d) => d.order, { createForeignKeyConstraints: false })
  deliveries!: DesignDeliveryEntity[];

  @OneToMany(() => DesignRevisionRequestEntity, (r) => r.order, {
    createForeignKeyConstraints: false,
  })
  revisionRequests!: DesignRevisionRequestEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

@Entity('design_deliveries')
export class DesignDeliveryEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index()
  orderId: number = 0;

  @Column({ type: 'int' })
  revision: number = 1;

  @Column({ type: 'int' })
  @Index()
  authorId: number = 0;

  @Column({ type: 'text', nullable: true })
  summary?: string;

  @Column({ type: 'simple-json' })
  files: {
    designFileId: number;
    url: string;
    filename: string;
    format: string;
    fileSize?: number;
  }[] = [];

  @Column({
    type: 'varchar', length: 32,
    enum: ['pending_upload', 'uploaded', 'accepted', 'rejected'],
    default: 'pending_upload',
  })
  status: string = 'pending_upload';

  @Column({ type: 'tinyint', default: 0 })
  isFinal: number = 0;

  @Column({ type: 'datetime', nullable: true })
  reviewedAt?: Date;

  // ✅ Relations
  @ManyToOne(() => DesignOrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'orderId' })
  order!: DesignOrderEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'authorId' })
  author!: UserEntity;

  @CreateDateColumn()
  createdAt!: Date;
}

@Entity('design_revision_requests')
export class DesignRevisionRequestEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index()
  orderId: number = 0;

  @Column({ type: 'int' })
  fromDeliveryId: number = 0;

  @Column({ type: 'int', nullable: true })
  toDeliveryId?: number | null;

  @Column({ type: 'text' })
  issueDesc: string = '';

  @Column({ type: 'simple-json', nullable: true })
  attachments?: string[];

  // ✅ Relations
  @ManyToOne(() => DesignOrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'orderId' })
  order!: DesignOrderEntity;

  // 注意: fromDeliveryId + toDeliveryId 两个列都指向 DesignDeliveryEntity
  // 不声明反向（DesignDeliveryEntity 不需要 revisionRequestsFrom/To 两个丑陋属性）
  @ManyToOne(() => DesignDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'fromDeliveryId' })
  fromDelivery!: DesignDeliveryEntity;

  @ManyToOne(() => DesignDeliveryEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'toDeliveryId' })
  toDelivery?: DesignDeliveryEntity;

  @CreateDateColumn()
  createdAt!: Date;
}
