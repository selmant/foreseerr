/** Request routing override for a Radarr or Sonarr server. */
interface OverrideRule {
  id: number;
  radarrServiceId?: number;
  sonarrServiceId?: number;
  /** Comma-separated user ids. */
  users?: string;
  /** Comma-separated TMDB genre ids. */
  genre?: string;
  /** Pipe-separated ISO 639-1 language codes. */
  language?: string;
  /** Comma-separated TMDB keyword ids. */
  keywords?: string;
  profileId?: number;
  rootFolder?: string;
  /** Comma-separated Servarr tag ids. */
  tags?: string;
  createdAt: Date;
  updatedAt: Date;
}

export default OverrideRule;
