import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
// Type-only entity imports: Bun evaluates TS as ESM and hits TDZ on
// TypeORM circular graphs if these are value-imported at module load.
import type { Watchlist } from '@server/entity/Watchlist';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import PreparedEmail from '@server/lib/email';
import type { PermissionCheckOptions } from '@server/lib/permissions';
import { Permission, hasPermission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import { hashPassword, verifyPassword } from '@server/lib/password';
import { AfterDate } from '@server/utils/dateHelpers';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import path from 'path';
import {
  AfterLoad,
  Column,
  Entity,
  Not,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  RelationCount,
  UpdateDateColumn,
} from 'typeorm';
import type Issue from './Issue';
import type { MediaRequest } from './MediaRequest';
import type { UserPushSubscription } from './UserPushSubscription';
import type { UserSettings } from './UserSettings';

@Entity()
export class User {
  public static filterMany(
    users: User[],
    showFiltered?: boolean
  ): Partial<User>[] {
    return users.map((u) => u.filter(showFiltered));
  }

  static readonly filteredFields: string[] = [
    'email',
    'plexId',
    'password',
    'resetPasswordGuid',
    'jellyfinDeviceId',
    'jellyfinAuthToken',
    'plexToken',
    'settings',
  ];

  public displayName: string;

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({
    unique: true,
    transformer: {
      from: (value: string): string => (value ?? '').toLowerCase(),
      to: (value: string): string => (value ?? '').toLowerCase(),
    },
  })
  public email: string;

  @Column({ type: 'varchar', nullable: true })
  public plexUsername?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public jellyfinUsername?: string | null;

  @Column({ nullable: true })
  public username?: string;

  @Column({ nullable: true, select: false })
  public password?: string;

  @Column({ nullable: true, select: false })
  public resetPasswordGuid?: string;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public recoveryLinkExpirationDate?: Date | null;

  @Column({ type: 'integer', default: UserType.PLEX })
  public userType: UserType;

  @Column({ type: 'integer', nullable: true, select: true })
  public plexId?: number | null;

  @Column({ type: 'varchar', nullable: true })
  public jellyfinUserId?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public jellyfinDeviceId?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public jellyfinAuthToken?: string | null;

  @Column({ type: 'varchar', nullable: true, select: false })
  public plexToken?: string | null;

  @Column({ type: 'integer', default: 0 })
  public permissions = 0;

  @Column()
  public avatar: string;

  @Column({ type: 'varchar', nullable: true })
  public avatarETag?: string | null;

  @Column({ type: 'varchar', nullable: true })
  public avatarVersion?: string | null;

  @RelationCount((user: User) => user.requests)
  public requestCount: number;

  @OneToMany('MediaRequest', 'requestedBy')
  public requests: MediaRequest[];

  @OneToMany('Watchlist', 'requestedBy')
  public watchlists: Watchlist[];

  @Column({ nullable: true })
  public movieQuotaLimit?: number;

  @Column({ nullable: true })
  public movieQuotaDays?: number;

  @Column({ nullable: true })
  public tvQuotaLimit?: number;

  @Column({ nullable: true })
  public tvQuotaDays?: number;

  @OneToOne('UserSettings', 'user', {
    cascade: true,
    eager: true,
    onDelete: 'CASCADE',
  })
  public settings?: UserSettings;

  @OneToMany('UserPushSubscription', 'user')
  public pushSubscriptions: UserPushSubscription[];

  @OneToMany('Issue', 'createdBy', { cascade: true })
  public createdIssues: Issue[];

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  public warnings: string[] = [];

  constructor(init?: Partial<User>) {
    Object.assign(this, init);
  }

  public filter(showFiltered?: boolean): Partial<User> {
    const filtered: Partial<User> = Object.assign(
      {},
      ...(Object.keys(this) as (keyof User)[])
        .filter((k) => showFiltered || !User.filteredFields.includes(k))
        .map((k) => ({ [k]: this[k] }))
    );

    return filtered;
  }

  /**
   * Allowlisted client payload. Never spread a TypeORM entity into res.json:
   * eager `settings.user` and relation getters can expand until the event
   * loop is stuck (desktop "Signing In…" freeze).
   */
  public toPublicJSON(): Record<string, unknown> {
    const settings = this.settings;
    return {
      id: this.id,
      email: this.email,
      username: this.username,
      plexUsername: this.plexUsername,
      jellyfinUsername: this.jellyfinUsername,
      displayName: this.displayName,
      avatar: this.avatar,
      permissions: this.permissions,
      userType: this.userType,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      requestCount: this.requestCount,
      warnings: this.warnings ?? [],
      plexId: this.plexId,
      settings: settings
        ? {
            locale: settings.locale,
            discoverRegion: settings.discoverRegion,
            streamingRegion: settings.streamingRegion,
            originalLanguage: settings.originalLanguage,
            notificationTypes: settings.notificationTypes,
            watchlistSyncMovies: settings.watchlistSyncMovies,
            watchlistSyncTv: settings.watchlistSyncTv,
            autoCompleteSkippedEpisodeEndings:
              settings.autoCompleteSkippedEpisodeEndings,
            autoCompleteSkippedEpisodeThreshold:
              settings.autoCompleteSkippedEpisodeThreshold,
            watchAheadEpisodeCount: settings.watchAheadEpisodeCount,
            servarrInterventionsSeenAt: settings.servarrInterventionsSeenAt,
            discoverFilterDefaults: settings.discoverFilterDefaults,
          }
        : undefined,
    };
  }

  public hasPermission(
    permissions: Permission | Permission[],
    options?: PermissionCheckOptions
  ): boolean {
    return !!hasPermission(permissions, this.permissions, options);
  }

  public async passwordMatch(password: string): Promise<boolean> {
    if (!this.password) {
      return false;
    }
    return verifyPassword(password, this.password);
  }

  public async setPassword(password: string): Promise<void> {
    this.password = await hashPassword(password);
  }

  public async generatePassword(): Promise<void> {
    const password = nanoid(16);
    await this.setPassword(password);

    const { applicationTitle, applicationUrl } = getSettings().main;
    try {
      logger.info(`Sending generated password email for ${this.email}`, {
        label: 'User Management',
      });

      const email = new PreparedEmail(getSettings().notifications.agents.email);
      await email.send({
        template: path.join(__dirname, '../templates/email/generatedpassword'),
        message: {
          to: this.email,
        },
        locals: {
          password: password,
          applicationUrl,
          applicationTitle,
          recipientName: this.username,
        },
      });
    } catch (e) {
      logger.error('Failed to send out generated password email', {
        label: 'User Management',
        message: e.message,
      });
    }
  }

  public async resetPassword(): Promise<void> {
    const guid = randomUUID();
    this.resetPasswordGuid = guid;

    // 24 hours into the future
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 1);
    this.recoveryLinkExpirationDate = targetDate;

    const { applicationTitle, applicationUrl } = getSettings().main;
    const resetPasswordLink = `${applicationUrl}/resetpassword/${guid}`;

    try {
      logger.info(`Sending reset password email for ${this.email}`, {
        label: 'User Management',
      });
      const email = new PreparedEmail(getSettings().notifications.agents.email);
      await email.send({
        template: path.join(__dirname, '../templates/email/resetpassword'),
        message: {
          to: this.email,
        },
        locals: {
          resetPasswordLink,
          applicationUrl,
          applicationTitle,
          recipientName: this.displayName,
          recipientEmail: this.email,
        },
      });
    } catch (e) {
      logger.error('Failed to send out reset password email', {
        label: 'User Management',
        message: e.message,
      });
    }
  }

  @AfterLoad()
  public setDisplayName(): void {
    this.displayName =
      this.username || this.plexUsername || this.jellyfinUsername || this.email;
  }

  public async getQuota(): Promise<QuotaResponse> {
    const {
      main: { defaultQuotas },
    } = getSettings();
    const { MediaRequest } = await import('./MediaRequest');
    const requestRepository = getRepository(MediaRequest);
    const canBypass = this.hasPermission([Permission.MANAGE_USERS], {
      type: 'or',
    });

    const movieQuotaLimit = !canBypass
      ? (this.movieQuotaLimit ?? defaultQuotas.movie.quotaLimit)
      : 0;
    const movieQuotaDays = this.movieQuotaDays ?? defaultQuotas.movie.quotaDays;

    // Count movie requests made during quota period
    const movieDate = new Date();
    if (movieQuotaDays) {
      movieDate.setDate(movieDate.getDate() - movieQuotaDays);
    }

    const movieQuotaUsed = movieQuotaLimit
      ? await requestRepository.count({
          where: {
            requestedBy: {
              id: this.id,
            },
            ...(movieQuotaDays ? { createdAt: AfterDate(movieDate) } : {}),
            type: MediaType.MOVIE,
            status: Not(MediaRequestStatus.DECLINED),
            ignoreQuota: false,
          },
        })
      : 0;

    const tvQuotaLimit = !canBypass
      ? (this.tvQuotaLimit ?? defaultQuotas.tv.quotaLimit)
      : 0;
    const tvQuotaDays = this.tvQuotaDays ?? defaultQuotas.tv.quotaDays;

    // Count tv season requests made during quota period
    const tvDate = new Date();
    if (tvQuotaDays) {
      tvDate.setDate(tvDate.getDate() - tvQuotaDays);
    }
    const tvQuotaStartDate = tvDate.toJSON();
    const tvQuotaUsedQuery = requestRepository
      .createQueryBuilder('request')
      .leftJoin('request.requestedBy', 'requestedBy')
      .where('request.type = :requestType', {
        requestType: MediaType.TV,
      })
      .andWhere('requestedBy.id = :userId', {
        userId: this.id,
      })
      .andWhere('request.status != :declinedStatus', {
        declinedStatus: MediaRequestStatus.DECLINED,
      });

    if (tvQuotaDays) {
      tvQuotaUsedQuery.andWhere('request.createdAt > :date', {
        date: tvQuotaStartDate,
      });
    }

    const tvQuotaUsed = tvQuotaLimit
      ? (
          await tvQuotaUsedQuery
            .andWhere('request.ignoreQuota = :ignoreQuota', {
              ignoreQuota: false,
            })
            .getMany()
        ).reduce((sum: number, req: MediaRequest) => sum + req.tvQuotaUnits, 0)
      : 0;

    return {
      movie: {
        days: movieQuotaDays,
        limit: movieQuotaLimit,
        used: movieQuotaUsed,
        remaining: movieQuotaLimit
          ? Math.max(0, movieQuotaLimit - movieQuotaUsed)
          : undefined,
        restricted: !!(
          movieQuotaLimit && movieQuotaLimit - movieQuotaUsed <= 0
        ),
      },
      tv: {
        days: tvQuotaDays,
        limit: tvQuotaLimit,
        used: tvQuotaUsed,
        remaining: tvQuotaLimit
          ? Math.max(0, tvQuotaLimit - tvQuotaUsed)
          : undefined,
        restricted: !!(tvQuotaLimit && tvQuotaLimit - tvQuotaUsed <= 0),
      },
    };
  }
}
