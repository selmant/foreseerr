/**
 * Protocol v1 uses a single send(command) surface. Resume selection remains
 * Jellyfin-owned; startPositionTicks stays out of the native bridge.
 */
export const nativeProtocolV1 = {
  fixtureId: 'foreseer-native-protocol-v1-2026-08-11',
  protocolVersion: 1,
  hostName: 'foreseer-desktop',
  eventName: 'foreseer:native-event',
  limits: {
    requestIdMaxLength: 64,
    itemIdMaxLength: 128,
    ticketLength: 43,
    challengeHexLength: 64,
  },
  playCommand: {
    type: 'play.item',
    fields: ['id', 'itemId'],
  },
  resumeOwner: 'jellyfin',
} as const;

export interface ForeseerNativeCommandV1 {
  id: string;
  type: string;
  ticket?: string;
  itemId?: string;
  url?: string;
  allowHttp?: boolean;
}

export interface ForeseerNativeV1 {
  readonly protocolVersion: 1;
  readonly hostName: 'foreseer-desktop';
  readonly hostVersion: string;
  readonly capabilities: readonly string[];
  send(command: ForeseerNativeCommandV1): boolean;
}

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
  'connectivity-success',
  'save-config-success',
  'browser-cache-cleared',
  'runtime-failed',
  'runtime-recovered',
  'logs-opened',
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

export const isUsableForeseerNative = (
  host: ForeseerNativeV1 | undefined
): host is ForeseerNativeV1 =>
  !!host &&
  host.protocolVersion === nativeProtocolV1.protocolVersion &&
  host.hostName === nativeProtocolV1.hostName &&
  typeof host.send === 'function' &&
  Array.isArray(host.capabilities) &&
  host.capabilities.includes('play-item');
