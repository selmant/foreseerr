import type { DiscoverSliderType } from '@shared/constants/discover';

/** A Discover row, built-in or administrator-defined. */
interface DiscoverSlider {
  id: number;
  type: DiscoverSliderType;
  order: number;
  isBuiltIn: boolean;
  enabled: boolean;
  /** Built-in rows have no title; the UI translates their names. */
  title?: string;
  data?: string;
  sort?: string;
  createdAt: Date;
  updatedAt: Date;
}

export default DiscoverSlider;
