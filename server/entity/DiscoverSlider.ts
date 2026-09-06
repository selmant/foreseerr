import {
  defaultSliders,
  retiredDiscoverSliderTypes,
  type DiscoverSliderType,
} from '@server/constants/discover';
import { getRepository } from '@server/datasource';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  In,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
class DiscoverSlider {
  public static async bootstrapSliders(): Promise<void> {
    const sliderRepository = getRepository(DiscoverSlider);
    await sliderRepository.delete({
      type: In([...retiredDiscoverSliderTypes]),
    });
    for (const slider of defaultSliders) {
      const existingBuiltIn = await sliderRepository.findOne({
        where: {
          type: slider.type,
          isBuiltIn: true,
        },
      });

      if (!existingBuiltIn) {
        logger.info('Creating built-in discovery slider', {
          label: 'Discover Slider',
          slider,
        });
        await sliderRepository.save(new DiscoverSlider(slider));
      }
    }

    // Custom rows are administrator configuration, even when their type
    // currently matches a built-in slider. Keep them intact so adding a new
    // built-in type cannot delete a user's slider during startup.
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'int' })
  public type: DiscoverSliderType;

  @Column({ type: 'int' })
  public order: number;

  @Column({ default: false })
  public isBuiltIn: boolean;

  @Column({ default: true })
  public enabled: boolean;

  @Column({ nullable: true })
  // Title is not required for built in sliders because we will
  // use translations for them.
  public title?: string;

  @Column({ nullable: true })
  public data?: string;

  @Column({ nullable: true })
  public sort?: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<DiscoverSlider>) {
    Object.assign(this, init);
  }
}

export default DiscoverSlider;
