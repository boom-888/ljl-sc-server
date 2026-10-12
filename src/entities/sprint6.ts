// ============================================================================
// TypeORM Entities — Sprint 6 补全缺失表
// 六张表：favorites / coupons / user_coupons / conversations / chat_messages / withdraw_requests
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

// — Favorite 收藏（user + product 联合）—
@Entity('favorites')
export class FavoriteEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('favorites_idx_fav_user')
  userId: number = 0;

  @Column({ type: 'int' })
  @Index('favorites_idx_fav_product')
  productId: number = 0;

  @Column({ type: 'varchar', length: 255, nullable: true })
  productName?: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  productCover?: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number;

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @ManyToOne(() => ProductEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'productId' })
  product!: ProductEntity;

  @CreateDateColumn()
  createdAt: Date = new Date();
}

// — Coupon 优惠券模板（管理端发布）—
@Entity('coupons')
export class CouponEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 100 })
  name: string = '';

  @Column({ type: 'varchar', length: 20 })
  type: 'amount' | 'percent' = 'amount';

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  value: number = 0;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  minAmount: number = 0;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description?: string;

  @Column({ type: 'int', default: 30 })
  validDays: number = 30;

  @Column({ type: 'int', default: 0 })
  total: number = 0;

  @Column({ type: 'int', default: 0 })
  remain: number = 0;

  @Column({ type: 'tinyint', default: 1 })
  active: number = 1;

  // ✅ OneToMany: 用户领取记录（同文件内，无需循环担忧）
  @OneToMany(() => UserCouponEntity, (uc) => uc.coupon, { createForeignKeyConstraints: false })
  userCoupons!: UserCouponEntity[];

  @CreateDateColumn()
  createdAt: Date = new Date();
}

// — UserCoupon 用户领取的优惠券 —
@Entity('user_coupons')
export class UserCouponEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('user_coupons_idx_uc_user')
  userId: number = 0;

  @Column({ type: 'int' })
  @Index('user_coupons_idx_uc_coupon')
  couponId: number = 0;

  @Column({ type: 'varchar', length: 100 })
  name: string = '';

  @Column({ type: 'varchar', length: 20 })
  type: 'amount' | 'percent' = 'amount';

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  value: number = 0;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  minAmount: number = 0;

  @Column({ type: 'varchar', length: 50 })
  status: 'unused' | 'used' | 'expired' = 'unused';

  @Column({ type: 'varchar', length: 30, nullable: true })
  source?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  orderNo?: string;

  @Column({ type: 'datetime' })
  expireTime: Date = new Date();

  // ✅ Relations
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user!: UserEntity;

  @ManyToOne(() => CouponEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'couponId' })
  coupon!: CouponEntity;

  @CreateDateColumn()
  createdAt: Date = new Date();

  @UpdateDateColumn()
  updatedAt: Date = new Date();
}

// — Conversation 会话（user1 ↔ user2 点对点）—
@Entity('conversations')
export class ConversationEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('conversations_idx_conv_user1')
  user1Id: number = 0;

  @Column({ type: 'int' })
  @Index('conversations_idx_conv_user2')
  user2Id: number = 0;

  @Column({ type: 'varchar', length: 50, nullable: true })
  refType?: string; // design_demand / installation_order / vendor

  @Column({ type: 'int', nullable: true })
  refId?: number;

  @Column({ type: 'datetime', nullable: true })
  lastMsgTime?: Date;

  @Column({ type: 'int', default: 0 })
  unreadUser1: number = 0;

  @Column({ type: 'int', default: 0 })
  unreadUser2: number = 0;

  // ✅ 两个 ManyToOne 都指向 UserEntity（同一张表两个不同列）
  // 注意: 不声明 UserEntity 反向 OneToMany（会冲突属性名 conversationsAsUser1 vs conversationsAsUser2）
  // 单向关系完全合法，路由代码可以通过 conversation.user1 / conversation.user2 使用
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user1Id' })
  user1!: UserEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'user2Id' })
  user2!: UserEntity;

  // ✅ OneToMany: 消息（反向在 ChatMessageEntity.conversation 已声明 ManyToOne）
  @OneToMany(() => ChatMessageEntity, (m) => m.conversation, { createForeignKeyConstraints: false })
  messages!: ChatMessageEntity[];

  @CreateDateColumn()
  createdAt: Date = new Date();
}

// — ChatMessage 聊天消息（真实持久化）—
@Entity('chat_messages')
export class ChatMessageEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('chat_messages_idx_msg_conv')
  conversationId: number = 0;

  @Column({ type: 'int' })
  @Index('chat_messages_idx_msg_sender')
  senderId: number = 0;

  @Column({ type: 'text' })
  content: string = '';

  @Column({ type: 'varchar', length: 20, default: 'text' })
  msgType: 'text' | 'image' | 'system' | 'card' = 'text';

  // v3.0 结构化卡片
  @Column({ name: 'cardType', type: 'varchar', nullable: true, length: 32 })
  cardType?: string; // quote | change | progress | deliver | confirm

  @Column({ name: 'cardData', type: 'simple-json', nullable: true })
  cardData?: any; // 卡片具体 payload

  // senderType: 1=user(默认), 0=system（系统自动写入的卡片消息）
  @Column({ name: 'senderType', type: 'tinyint', default: 1 })
  senderType: number = 1;

  @Column({ type: 'tinyint', default: 1 })
  passedFilter: number = 1; // 0=被拦截

  @Column({ type: 'varchar', length: 100, nullable: true })
  filterReason?: string;

  // ✅ Relations
  @ManyToOne(() => ConversationEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'senderId' })
  sender!: UserEntity;

  @CreateDateColumn()
  createdAt: Date = new Date();
}

// — WithdrawRequest 商家提现申请 —
@Entity('withdraw_requests')
export class WithdrawRequestEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 50, unique: true })
  withdrawNo: string = '';

  @Column({ type: 'int' })
  @Index('withdraw_requests_idx_withdraw_vendor')
  vendorId: number = 0;

  // — 多态字段：标记是谁在提现（vendor / designer / installer）
  // Week 7 遗留修复：installer 提现把 installer userId 存进 vendorId 列，靠此列区分
  @Column({ type: 'varchar', length: 20, default: 'vendor' })
  @Index('withdraw_requests_idx_withdraw_provider_role')
  providerRole: string = 'vendor';

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: number = 0;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  fee: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  actualAmount: number = 0;

  @Column({ type: 'varchar', length: 100, nullable: true })
  bankName?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  cardNo?: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index('withdraw_requests_idx_withdraw_status')
  status: 'pending' | 'approved' | 'rejected' | 'paid' = 'pending';

  @Column({ type: 'varchar', length: 255, nullable: true })
  remark?: string;

  @Column({ type: 'datetime', nullable: true })
  processedAt?: Date;

  @Column({ type: 'int', nullable: true })
  reviewedBy?: number;

  @Column({ type: 'datetime', nullable: true })
  reviewedAt?: Date;

  @Column({ type: 'datetime', nullable: true })
  paidAt?: Date;

  // ✅ Relation: vendor（指向 users.role='vendor' 的 user）
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'vendorId' })
  vendor!: UserEntity;

  @CreateDateColumn()
  createdAt: Date = new Date();
}

// ⚠️ WarrantyClaimEntity 已迁移至 sprint4.ts（完整版，含 installerId/compensationAmount/claimNo）
// 此处原极简版已删除，避免 @Entity('warranty_claims') 重复注册导致 TypeORM 初始化崩溃
