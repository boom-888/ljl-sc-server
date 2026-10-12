// ============================================================================
// TypeORM Entities — Sprint 2 新增 4 张表（购物车/订单/订单项/地址）
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
import { UserEntity, ProductEntity } from './index';

// — 9. cart —
@Entity('cart')
export class CartEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('cart_idx_user')
  userId: number = 0;

  @Column({ type: 'int' })
  productId: number = 0;

  @Column({ type: 'varchar', length: 32, nullable: true })
  specId?: string;

  @Column({ type: 'int', default: 1 })
  quantity: number = 1;

  @Column({ type: 'tinyint', default: 1 })
  selected: number = 1; // 1=选中 0=未选中

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'productId' })
  product!: ProductEntity;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — 10. orders —
@Entity('orders')
export class OrderEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 32, unique: true })
  @Index('orders_idx_no')
  orderNo: string = '';

  @Column({ type: 'int' })
  @Index('orders_idx_user')
  userId: number = 0;

  @Column({ type: 'int', nullable: true })
  @Index('orders_idx_vendor')
  vendorId?: number;

  @Column({ type: 'varchar', length: 20 })
  status: string = 'pending'; // pending/paid/shipped/completed/cancelled

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  totalAmount: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  discount: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  shippingFee: number = 0;

  @Column({ type: 'varchar', length: 100, nullable: true })
  receiverName?: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  receiverPhone?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  receiverAddress?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark?: string;

  @Column({ type: 'varchar', length: 30, nullable: true })
  payMethod?: string; // wechat/alipay

  @Column({ type: 'datetime', nullable: true })
  paidAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  shippedAt?: Date;

  @Column({ type: 'varchar', length: 20, nullable: true })
  shippingType?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  shippingCompany?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  shippingNo?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  trackingUrl?: string;

  // Sprint 10 新增：关联 ExpressCompany（v4.1）
  @Column({ type: 'int', nullable: true })
  expressCompanyId?: number;

  // Sprint 10 新增：物流轨迹快照（JSON 字符串，v4.1）
  @Column({ type: 'text', nullable: true })
  logisticsTrail?: string;

  // 🛠️ Week 5：优惠券关联（用于支付成功后回写 UserCoupon.status）
  @Column({ type: 'int', nullable: true })
  couponId?: number;

  // P0-2: 主订单关联（MasterOrder）
  @Column({ type: 'int', nullable: true })
  masterOrderId?: number;

  @Column({ type: 'datetime', nullable: true })
  completedAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  cancelledAt?: Date;

  // — 📐 P1：买家合规校验相关 —
  @Column({ type: 'int', nullable: true })
  validationScore?: number;

  @Column({ type: 'simple-json', nullable: true })
  validationIssues?: Array<{ type: string; message: string; level: 'info' | 'warning' | 'error' }>;

  @Column({ type: 'varchar', length: 255, nullable: true })
  buyerDesignFileUrl?: string;

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'vendorId' })
  vendor?: UserEntity;

  @OneToMany(() => OrderItemEntity, (item) => item.order, { createForeignKeyConstraints: false })
  items!: OrderItemEntity[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

// — 11. order_items —
@Entity('order_items')
export class OrderItemEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('order_items_idx_order')
  orderId: number = 0;

  @Column({ type: 'int' })
  productId: number = 0;

  @Column({ type: 'int', nullable: true })
  vendorId?: number;

  @Column({ type: 'varchar', length: 200 })
  productName: string = '';

  @Column({ type: 'varchar', length: 500, nullable: true })
  productCover?: string;

  @Column({ type: 'int' })
  quantity: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  price: number = 0;

  // ✅ Relations
  @ManyToOne(() => OrderEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'orderId' })
  order!: OrderEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'productId' })
  product!: ProductEntity;
}

// — 13. addresses —
@Entity('addresses')
export class AddressEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('addresses_idx_user')
  userId: number = 0;

  @Column({ type: 'varchar', length: 50 })
  name: string = '';

  @Column({ type: 'varchar', length: 20 })
  phone: string = '';

  @Column({ type: 'varchar', length: 50 })
  province: string = '';

  @Column({ type: 'varchar', length: 50 })
  city: string = '';

  @Column({ type: 'varchar', length: 50 })
  district: string = '';

  @Column({ type: 'varchar', length: 300 })
  detail: string = '';

  @Column({ type: 'tinyint', default: 0 })
  isDefault: number = 0;

  // ✅ Relation
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
