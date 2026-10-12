// ============================================================================
// Sprint 12：行政区划三张码表（省 / 市 / 区县）
// 数据源：china-division npm 包（民政部国标码）
//   province.code = 2 位（如 '11'）
//   city.code     = 4 位（如 '1101'）  city.provinceCode = 2 位
//   district.code = 6 位（如 '110101') district.cityCode = 4 位
// ============================================================================
import 'reflect-metadata';
import { Entity, PrimaryColumn, Column, Index, CreateDateColumn } from 'typeorm';

@Entity('provinces')
export class ProvinceEntity {
  @PrimaryColumn({ type: 'varchar', length: 10 })
  code: string = '';

  @Column({ type: 'varchar', length: 50 })
  name: string = '';

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}

@Entity('cities')
export class CityEntity {
  @PrimaryColumn({ type: 'varchar', length: 10 })
  code: string = '';

  @Column({ type: 'varchar', length: 50 })
  name: string = '';

  @Column({ type: 'varchar', length: 10 })
  @Index('cities_idx_city_province')
  provinceCode: string = '';

  @Column({ type: 'tinyint', default: 0 })
  isHot: number = 0; // 标记热门

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}

@Entity('districts')
export class DistrictEntity {
  @PrimaryColumn({ type: 'varchar', length: 10 })
  code: string = '';

  @Column({ type: 'varchar', length: 50 })
  name: string = '';

  @Column({ type: 'varchar', length: 10 })
  @Index('districts_idx_district_city')
  cityCode: string = '';

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
