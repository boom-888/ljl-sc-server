// ============================================================================
// Push 推送体系实体（P1 新增）
// 1. push_devices — 设备注册表：记录每个 userId 当前活跃的推送通道
//    同一用户可同时有：微信订阅消息 (openid) + APP 极光推送 (registrationId) + SSE (sseClientId)
// 2. push_logs — 推送审计日志：记录每次推了什么、哪个通道、成功/失败
// ============================================================================
import 'reflect-metadata';
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn,
  Index, OneToMany, ManyToOne, JoinColumn,
} from 'typeorm';
import { UserEntity } from './index';

/** 推送通道类型 */
export type PushChannel = 'wx_subscribe' | 'jpush_apns' | 'sse';

@Entity('push_devices')
@Index('push_devices_idx_pd_user', ['userId'])
@Index('push_devices_idx_pd_channel', ['channel'])
@Index('push_devices_idx_pd_unique', ['userId', 'channel', 'openid'], { unique: true, synchronize: false })
export class PushDeviceEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  userId: number = 0;

  /** 推送通道 */
  @Column({ type: 'varchar', length: 20 })
  channel: PushChannel = 'wx_subscribe';

  // — 微信订阅消息：绑定 userId ↔ openid / unionid —
  @Column({ type: 'varchar', length: 64, nullable: true })
  openid?: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  unionid?: string;

  // — APP 推送（极光/个推）—
  @Column({ type: 'varchar', length: 128, nullable: true })
  registrationId?: string;

  @Column({ type: 'varchar', length: 256, nullable: true })
  deviceToken?: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  pushPlatform?: string; // 'ios' | 'android'

  // — SSE 长连接：eventBus 里的 clientId —
  @Column({ type: 'varchar', length: 128, nullable: true })
  sseClientId?: string;

  // — 辅助信息 —
  @Column({ type: 'varchar', length: 20, nullable: true })
  appVersion?: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  deviceModel?: string;

  @Column({ type: 'datetime', nullable: true })
  lastActiveAt?: Date;

  @Column({ type: 'tinyint', default: 1 })
  @Index('push_devices_idx_pd_enabled')
  enabled: number = 1;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  // 不建外键约束（和项目其他表风格一致）
  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity;
}

@Entity('push_logs')
@Index('push_logs_idx_pl_user_time', ['userId', 'createdAt'])
@Index('push_logs_idx_pl_event', ['eventType'])
export class PushLogEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  userId: number = 0;

  @Column({ type: 'varchar', length: 50 })
  eventType: string = '';

  @Column({ type: 'varchar', length: 128 })
  dedupKey: string = '';

  @Column({ type: 'varchar', length: 100 })
  channels: string = ''; // 逗号分隔："wx_subscribe,jpush_apns"

  @Column({ type: 'int', default: 0 })
  successCount: number = 0;

  @Column({ type: 'int', default: 0 })
  failCount: number = 0;

  @Column({ type: 'simple-json', nullable: true })
  failDetail?: any[];

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}

// ============================================================================
// Notifications — 站内通知表（push_logs 的前端可读副本）
// 优先写入这里；前端无记录时 fallback 从 push_logs 聚合
// ============================================================================
@Entity('notifications')
@Index('notifications_idx_notif_user_time', ['userId', 'createdAt'])
@Index('notifications_idx_notif_read', ['userId', 'isRead'])
export class NotificationsEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('notifications_idx_notif_user')
  userId: number = 0;

  /** 通知类型：order_update / refund / dispute / system / push_sync */
  @Column({ type: 'varchar', length: 30 })
  @Index('notifications_idx_notif_type')
  type: string = 'system';

  /** 通知标题（简短一行） */
  @Column({ type: 'varchar', length: 100 })
  title: string = '';

  /** 通知正文（详细内容） */
  @Column({ type: 'varchar', length: 500, nullable: true })
  content?: string;

  /** 关联 push_logs.eventType（用于前后端去重/聚合） */
  @Column({ type: 'varchar', length: 50, nullable: true })
  eventType?: string;

  /** 关联 push_logs.dedupKey（同一事件不重复创建通知） */
  @Column({ type: 'varchar', length: 128, nullable: true })
  @Index('notifications_idx_notif_dedup')
  dedupKey?: string;

  /** 前端跳转用的 JSON 元信息，如 {"orderId":123,"target":"order"} */
  @Column({ type: 'simple-json', nullable: true })
  meta?: Record<string, any>;

  @Column({ type: 'tinyint', default: 0 })
  @Index('notifications_idx_notif_isread')
  isRead: number = 0;

  @Column({ type: 'datetime', nullable: true })
  readAt?: Date;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity;
}

// ============================================================================
// VendorDeliveryArea — 供应商自管配送区域（区别于 admin 管控的 vendor_zone_permissions）
// vendor_zone_permissions = admin 开通的县区准入（只读）
// vendor_delivery_areas   = vendor 自己配置的配送覆盖范围（可增删改）
// ============================================================================
@Entity('vendor_delivery_areas')
@Index('vendor_delivery_areas_idx_vda_vendor', ['vendorId'])
@Index('vendor_delivery_areas_idx_vda_location', ['vendorId', 'province', 'city'])
export class VendorDeliveryAreaEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('vendor_delivery_areas_idx_vda_vendor_id')
  vendorId: number = 0;

  @Column({ type: 'varchar', length: 32 })
  province: string = '';

  @Column({ type: 'varchar', length: 32 })
  city: string = '';

  @Column({ type: 'varchar', length: 32, nullable: true })
  district?: string;

  /** 配送半径（公里），null 表示覆盖整个 district / city */
  @Column({ type: 'decimal', precision: 8, scale: 2, nullable: true })
  radiusKm?: number;

  @Column({ type: 'varchar', length: 20, default: 'enabled' })
  enabled: number = 1;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;

  @ManyToOne(() => UserEntity, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'vendorId' })
  vendor?: UserEntity;
}
