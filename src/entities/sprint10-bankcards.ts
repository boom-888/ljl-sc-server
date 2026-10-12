// ============================================================================
// Sprint 10 — BankCardEntity（三方角色 vendor/designer/installer 通用绑卡表）
// ============================================================================
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('bank_cards')
export class BankCardEntity {
  @PrimaryGeneratedColumn({ type: 'int' })
  id: number = 0;

  @Column({ type: 'int' })
  @Index('bank_cards_idx_bc_user')
  userId: number = 0;

  @Column({ type: 'varchar', length: 20 })
  role: string = 'vendor'; // vendor / designer / installer

  @Column({ type: 'varchar', length: 100 })
  bankName: string = '';

  @Column({ type: 'varchar', length: 50 })
  cardNo: string = '';

  @Column({ type: 'varchar', length: 20 })
  cardNoMasked: string = ''; // 后 4 位：****8888

  @Column({ type: 'varchar', length: 50 })
  accountName: string = ''; // 持卡人

  @Column({ type: 'varchar', length: 30, nullable: true })
  branchName?: string;

  @Column({ type: 'tinyint', default: 0 })
  isDefault: number = 0;

  @Column({ type: 'varchar', length: 20, default: 'active' })
  status: string = 'active'; // active / disabled

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
