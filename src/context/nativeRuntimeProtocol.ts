/**
 * Protocol v1 has a two-argument play command. Resume selection remains
 * Jellyfin-owned until a future version carries a validated tick argument
 * through every native boundary.
 */
export const nativeProtocolV1 = {
  fixtureId: 'foreseer-native-protocol-v1-2026-08-08',
  protocolVersion: 1,
  hostName: 'jellium-desktop',
  limits: {
    requestIdMaxLength: 64,
    itemIdMaxLength: 128,
    ticketLength: 43,
    challengeHexLength: 64,
  },
  playMethod: {
    name: 'playItem',
    arguments: ['requestId', 'itemId'],
  },
  resumeOwner: 'jellyfin',
} as const;

export const nativeHostEventTypesV1 = [
  'auth-challenge',
  'ready',
  'accepted',
  'resolving',
  'starting',
  'playing',
  'stopped',
  'finished',
  'canceled',
  'error',
] as const;

export type NativeHostEventTypeV1 = (typeof nativeHostEventTypesV1)[number];

export const terminalNativePlayEventTypesV1 = [
  'stopped',
  'finished',
  'canceled',
  'error',
] as const satisfies readonly NativeHostEventTypeV1[];

export const isNativeHostEventTypeV1 = (
  type: string
): type is NativeHostEventTypeV1 =>
  (nativeHostEventTypesV1 as readonly string[]).includes(type);

export const isCurrentNativePlayRequest = (
  activeRequestId: string | undefined,
  eventRequestId: string
) => activeRequestId !== undefined && activeRequestId === eventRequestId;

export const isTerminalNativePlayEvent = (
  type: string
): type is (typeof terminalNativePlayEventTypesV1)[number] =>
  (terminalNativePlayEventTypesV1 as readonly string[]).includes(type);

export const shouldClearNativePlayRequest = (
  activeRequestId: string | undefined,
  eventRequestId: string,
  type: string
) =>
  isCurrentNativePlayRequest(activeRequestId, eventRequestId) &&
  isTerminalNativePlayEvent(type);
