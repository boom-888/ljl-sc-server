// ============================================================================
// TypeORM Entity — Sprint 11 系统配置表（admin-settings 专用）
// ============================================================================
import 'reflect-metadata';
import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

@Entity('system_config')
export class SystemConfigEntity {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  key: string = '';

  @Column({ type: 'text' })
  value: string = ''; // 存 JSON 字符串，前端需要时 parse

  @Column({ type: 'varchar', length: 30, default: 'general' })
  @Index()
  group: string = 'general'; // general / order / permission / financial

  @Column({ type: 'varchar', length: 200, nullable: true })
  remark?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
