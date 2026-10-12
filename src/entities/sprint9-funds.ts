// ============================================================================
// TypeORM Entities — Sprint 9 资金流
// 两张表：settle_orders (结算单) / money_flows (资金流水审计)
// ============================================================================
import 'reflect-metadata';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

// — 结算单（每次订单完成生成一条）—
@Entity('settle_orders')
export class SettleOrderEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 32, unique: true })
  @Index('settle_orders_idx_settle_no')
  settleNo: string = '';

  @Column({ type: 'varchar', length: 32 })
  orderId: string = '';

  @Column({ type: 'varchar', length: 20 })
  orderType: string = 'goods'; // goods / design / install

  @Column({ type: 'int' })
  @Index('settle_orders_idx_provider')
  providerId: number = 0;

  @Column({ type: 'varchar', length: 20 })
  providerRole: string = 'vendor'; // vendor / designer / installer

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  totalAmount: number = 0;

  @Column({ type: 'decimal', precision: 5, scale: 4 })
  commissionRate: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  commission: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  providerGet: number = 0;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0 })
  warrantyHoldAmount: number = 0; // install only

  @Column({ type: 'varchar', length: 20, default: 'frozen' })
  @Index('settle_orders_idx_status')
  status: string = 'frozen'; // frozen / available / withdrawn / released

  @Column({ type: 'datetime' })
  freezeUntil!: Date; // 7 天后自动解冻

  @Column({ type: 'datetime', nullable: true })
  settledAt?: Date; // 实际可用时间

  // — 纠纷标记（DB 层 ALTER 过，admin-finance 纠纷处理用）—
  @Column({ type: 'varchar', length: 20, nullable: true })
  dispute_status?: string; // pending / mediating / resolved

  @Column({ type: 'varchar', length: 500, nullable: true })
  dispute_remark?: string;

  @CreateDateColumn({ type: 'datetime' })
  @Index('settle_orders_idx_created')
  createdAt!: Date;
}

// — 资金流水（所有资金变动记一条，审计用）—
@Entity('money_flows')
export class MoneyFlowEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 40, unique: true })
  @Index('money_flows_idx_flow_no')
  flowNo: string = '';

  @Column({ type: 'varchar', length: 30 })
  @Index('money_flows_idx_type')
  type: string = ''; // settle / withdraw / warranty_release / arbitration / deposit

  @Column({ type: 'varchar', length: 40, nullable: true })
  refNo?: string; // settleNo / orderNo / claimNo / withdrawNo

  @Column({ type: 'int', nullable: true })
  @Index('money_flows_idx_from_user')
  fromUserId?: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  fromRole?: string; // consumer / vendor / designer / installer / platform

  @Column({ type: 'int', nullable: true })
  @Index('money_flows_idx_to_user')
  toUserId?: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  toRole?: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: number = 0;

  @Column({ type: 'varchar', length: 20, default: 'completed' })
  status: string = 'completed';

  @Column({ type: 'varchar', length: 200, nullable: true })
  remark?: string;

  @CreateDateColumn({ type: 'datetime' })
  @Index('money_flows_idx_created')
  createdAt!: Date;
}
