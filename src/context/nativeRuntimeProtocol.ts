/**
 * Protocol v2 uses a single send(command) surface. Resume selection remains
 * Jellyfin-owned; startPositionTicks stays out of the native bridge.
 */
export const nativeProtocolV2 = {
  fixtureId: 'foreseer-native-protocol-v2-2026-08-10',
  protocolVersion: 2,
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

export interface ForeseerNativeCommandV2 {
  id: string;
  type: string;
  ticket?: string;
  itemId?: string;
  url?: string;
  allowHttp?: boolean;
}

export interface ForeseerNativeV2 {
  readonly protocolVersion: 2;
  readonly hostName: 'foreseer-desktop';
  readonly hostVersion: string;
  readonly capabilities: readonly string[];
  send(command: ForeseerNativeCommandV2): boolean;
}

export const nativeHostEventTypesV2 = [
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
] as const;

export type NativeHostEventTypeV2 = (typeof nativeHostEventTypesV2)[number];

export const terminalNativePlayEventTypesV2 = [
  'stopped',
  'finished',
  'canceled',
  'error',
] as const satisfies readonly NativeHostEventTypeV2[];

export const isNativeHostEventTypeV2 = (
  type: string
): type is NativeHostEventTypeV2 =>
  (nativeHostEventTypesV2 as readonly string[]).includes(type);

export const isCurrentNativePlayRequest = (
  activeRequestId: string | undefined,
  eventRequestId: string
) => activeRequestId !== undefined && activeRequestId === eventRequestId;

export const isTerminalNativePlayEvent = (
  type: string
): type is (typeof terminalNativePlayEventTypesV2)[number] =>
  (terminalNativePlayEventTypesV2 as readonly string[]).includes(type);

export const shouldClearNativePlayRequest = (
  activeRequestId: string | undefined,
  eventRequestId: string,
  type: string
) =>
  isCurrentNativePlayRequest(activeRequestId, eventRequestId) &&
  isTerminalNativePlayEvent(type);

export const isUsableForeseerNative = (
  host: ForeseerNativeV2 | undefined
): host is ForeseerNativeV2 =>
  !!host &&
  host.protocolVersion === nativeProtocolV2.protocolVersion &&
  host.hostName === nativeProtocolV2.hostName &&
  typeof host.send === 'function' &&
  Array.isArray(host.capabilities) &&
  host.capabilities.includes('play-item');
