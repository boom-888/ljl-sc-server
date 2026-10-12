// ============================================================================
// MasterOrder 主订单（跨 Sprint 顶层聚合根）
// 一个 MasterOrder 可以同时关联：
//   - Product/OrderEntity（商品订单，sprint2）
//   - DesignOrderEntity（设计订单，sprint7）
//   - InstallationOrderEntity（安装订单，sprint4）
// 不是每个主订单都有全部三个子订单——按需组合。
// ============================================================================
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('master_orders')
export class MasterOrderEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'varchar', length: 32, unique: true })
  orderNo: string = ''; // 生成规则：'MO' + 时间戳 + 3 位随机

  // === 买家 ===
  @Column({ type: 'int' })
  buyerId: number = 0;

  @Column({ type: 'varchar', length: 50 })
  buyerNickname: string = '';

  // === 三个子订单（可选——不是每个主订单都有全部三个）===
  @Column({ type: 'int', nullable: true })
  productOrderId?: number; // → sprint2 OrderEntity.id

  @Column({ type: 'int', nullable: true })
  designOrderId?: number; // → sprint7 DesignOrderEntity.id

  @Column({ type: 'int', nullable: true })
  installationOrderId?: number; // → sprint4 InstallationOrderEntity.id

  // === 金额汇总（分）===
  @Column({ type: 'int' })
  totalAmount: number = 0; // 主订单总价 = productTotal + designTotal + installTotal

  @Column({ type: 'int', default: 0 })
  productTotal: number = 0;

  @Column({ type: 'int', default: 0 })
  designTotal: number = 0;

  @Column({ type: 'int', default: 0 })
  installTotal: number = 0;

  @Column({ type: 'int', default: 0 })
  platformFee: number = 0; // 平台抽佣（汇总）

  // === 主订单状态 ===
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status:
    | 'pending'
    | 'paid'
    | 'producing'
    | 'designing'
    | 'installing'
    | 'completed'
    | 'cancelled'
    | 'refunding'
    | 'refunded' = 'pending';

  // === 地址（快照）===
  @Column({ type: 'simple-json', nullable: true })
  address?: {
    name: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
    lng?: number;
    lat?: number;
  };

  // === 备注 ===
  @Column({ type: 'text', nullable: true })
  remark?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
