import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
@Index(['ticketDigest'], { unique: true })
export class DesktopAuthTicket {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  @Index()
  public userId: number;

  @Column({ type: 'varchar', length: 64 })
  public ticketDigest: string;

  @Column({ type: 'varchar', length: 64 })
  public challengeDigest: string;

  @Column({ type: 'integer' })
  public protocolVersion: number;

  @DbAwareColumn({ type: 'datetime' })
  @Index()
  public expiresAt: Date;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public consumedAt?: Date | null;

  constructor(init?: Partial<DesktopAuthTicket>) {
    Object.assign(this, init);
  }
}
