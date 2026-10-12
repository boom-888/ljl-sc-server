// ============================================================================
// Week 9 · DisputeEntity 独立化
// 从 settle_orders.dispute_status / dispute_remark 两列临时字段拆分出独立表
// 参考 refunds 表结构（同属 admin 财务管辖）
// ============================================================================
import 'reflect-metadata';
import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
  UpdateDateColumn, Index,
} from 'typeorm';

/** 纠纷类型：买家对商品/设计/施工的申诉 */
export type DisputeOrderType = 'goods' | 'design' | 'install';
/** 纠纷状态机：pending（挂起）→ processing（处理中）→ resolved（已处理） */
export type DisputeStatus = 'pending' | 'processing' | 'resolved';
/** admin 处理动作 */
export type DisputeAction = 'dismiss' | 'full_refund' | 'partial_refund' | 'redo' | 'compensate';

@Entity('disputes')
@Index('disputes_idx_dispute_order', ['orderId', 'orderType'])
@Index('disputes_idx_dispute_status', ['status'])
@Index('disputes_idx_dispute_user', ['userId'])
export class DisputeEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  // ========== 关联订单 ==========
  @Column({ type: 'varchar', length: 32 })
  orderId: string = '';          // 原订单 id（goods/design/install 三表各自主键，统一 varchar）

  @Column({ type: 'varchar', length: 20 })
  orderType: DisputeOrderType = 'goods';

  @Column({ type: 'varchar', length: 32, nullable: true })
  settleOrderId?: string;        // 关联结算单 id（纠纷挂到冻结池上）

  // ========== 参与方 ==========
  @Column({ type: 'int' })
  userId: number = 0;            // 买家 userId

  @Column({ type: 'int', nullable: true })
  providerId?: number;           // 供应商 userId（vendor/designer/installer）

  @Column({ type: 'varchar', length: 20, nullable: true })
  providerRole?: string;         // vendor / designer / installer

  // ========== 纠纷内容 ==========
  @Column({ type: 'varchar', length: 30, default: 'other' })
  reasonType: string = 'other';  // quality / delay / mismatch / damage / other

  @Column({ type: 'varchar', length: 500 })
  reason: string = '';           // 用户申诉详情

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'simple-json', nullable: true })
  images?: any[];

  // ========== 纠纷时间线 / 消息 ==========
  // 角色方（vendor/designer/installer）或 admin 在纠纷里的响应记录
  // 格式：{ role: 'buyer'|'provider'|'admin', userId: number, message: string, createdAt: string }
  @Column({ type: 'simple-json', nullable: true })
  messages?: any[];

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  claimAmount: number = 0;       // 用户诉求退款金额

  // ========== 状态机 ==========
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: DisputeStatus = 'pending';

  @Column({ type: 'int', nullable: true })
  reviewedBy?: number;           // admin userId

  @Column({ type: 'varchar', length: 30, nullable: true })
  action?: DisputeAction;        // admin 最终处理动作

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  refundAmount: number = 0;      // 实际退款金额

  @Column({ type: 'varchar', length: 500, nullable: true })
  reviewRemark?: string;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
