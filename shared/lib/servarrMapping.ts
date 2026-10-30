/**
 * A Servarr operation is only safe when Foreseer knows both the configured
 * service and the corresponding movie/series within that service.
 */
export interface ServarrMediaMapping {
  serviceId?: number | null;
  externalServiceId?: number | null;
  serviceId4k?: number | null;
  externalServiceId4k?: number | null;
}

export const hasServarrMapping = (
  mediaInfo?: ServarrMediaMapping | null
): boolean =>
  Boolean(
    mediaInfo &&
    ((mediaInfo.serviceId != null && mediaInfo.externalServiceId != null) ||
      (mediaInfo.serviceId4k != null && mediaInfo.externalServiceId4k != null))
  );
