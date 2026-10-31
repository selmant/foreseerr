import type { QualityProfile, RootFolder, Tag } from '@shared/api/servarr/base';
import type {
  LanguageProfile,
  MetadataLanguage,
} from '@shared/api/servarr/sonarr';

export interface ServiceCommonServer {
  id: number;
  name: string;
  is4k: boolean;
  isDefault: boolean;
  activeProfileId: number;
  activeDirectory: string;
  activeLanguageProfileId?: number;
  activeAnimeProfileId?: number;
  activeAnimeDirectory?: string;
  activeAnimeLanguageProfileId?: number;
  /** Sonarr 5: the metadata language series are added with. */
  metadataLanguageId?: number | null;
  /** Sonarr 5: the anime override of `metadataLanguageId`. */
  animeMetadataLanguageId?: number | null;
  activeTags: number[];
  activeAnimeTags?: number[];
}

export interface ServiceCommonServerWithDetails {
  server: ServiceCommonServer;
  profiles: QualityProfile[];
  rootFolders: Partial<RootFolder>[];
  languageProfiles?: LanguageProfile[] | null;
  /** Sonarr 5 only: what `metadataLanguageId` chooses from. */
  metadataLanguages?: MetadataLanguage[] | null;
  /** Sonarr 5's preferred metadata language, used when nothing is chosen. */
  defaultMetadataLanguageId?: number | null;
  tags: Tag[];
}
