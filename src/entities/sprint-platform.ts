// ============================================================================
// 🧾 PlatformTransaction — 平台层交易流水实体
// 记录平台从各业务域（设计/商品/安装）抽取的每一笔佣金
// 同时覆盖：订阅费 / 退款冲回 / 平台调整 等非抽佣类平台收支
// ============================================================================
import 'reflect-metadata';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type PlatformTxType = 'commission' | 'subscription' | 'refund' | 'adjust';
export type PlatformTxSource = 'design' | 'goods' | 'install' | 'admin';
export type PlatformTxTargetRole = 'designer' | 'vendor' | 'installer' | 'buyer' | 'admin';
export type PlatformTxStatus = 'pending' | 'deducted' | 'released' | 'refunded' | 'cancelled';

@Entity('platform_transactions')
export class PlatformTransactionEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id!: number;

  /** 流水号：PT + 时间戳 + 4位随机，全局唯一 */
  @Column({ type: 'varchar', length: 32, unique: true })
  @Index('platform_transactions_idx_ptx_no')
  txNo!: string;

  /** 交易类型 */
  @Column({ type: 'varchar', length: 20 })
  type: PlatformTxType = 'commission';

  /** 来源业务域 */
  @Column({ type: 'varchar', length: 30 })
  source: PlatformTxSource = 'design';

  /** 来源订单 id（DesignOrder / Order / InstallationOrder / 管理员手动调整单） */
  @Column({ type: 'int' })
  @Index('platform_transactions_idx_ptx_source_id')
  sourceId!: number;

  /** 抽佣基数（分 / 元，保持与订单主字段单位一致：本项目用元 × 100 存分） */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  baseAmount: number = 0;

  /** 本次平台收入金额（元） */
  @Column({ type: 'decimal', precision: 14, scale: 2 })
  amount: number = 0;

  /** 抽佣比例（0.15 = 15%；订阅/退款/调整类可能为 0） */
  @Column({ type: 'decimal', precision: 5, scale: 4, default: 0 })
  rate: number = 0;

  /** 佣金从谁那抽 */
  @Column({ type: 'varchar', length: 20 })
  targetRole: PlatformTxTargetRole = 'vendor';

  /** 具体从哪个用户抽（users.id） */
  @Column({ type: 'int', nullable: true })
  @Index('platform_transactions_idx_ptx_target_user')
  targetUserId?: number;

  /** 状态：pending=已记录未扣 / deducted=已从服务商冻结金扣 / released=已释放 / refunded=已退款冲回 / cancelled=已作废 */
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  @Index('platform_transactions_idx_ptx_status')
  status: PlatformTxStatus = 'pending';

  /** 关联的结算单号（settleOrders.settleNo），settle 流程双写时回填 */
  @Column({ type: 'varchar', length: 32, nullable: true })
  settleNo?: string;

  /** 备注：管理员调整原因 / 退款原因 / 特殊说明 */
  @Column({ type: 'text', nullable: true })
  remark?: string;

  @CreateDateColumn({ type: 'datetime' })
  @Index('platform_transactions_idx_ptx_created')
  createdAt!: Date;
}

/** 生成平台流水号 */
export function genPlatformTxNo(): string {
  return (
    'PT' +
    Date.now().toString(36).toUpperCase() +
    Math.floor(Math.random() * 1000000)
      .toString(36)
      .toUpperCase()
      .padStart(6, '0')
  );
}
