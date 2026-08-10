/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  isCurrentNativePlayRequest,
  isNativeHostEventTypeV2,
  isTerminalNativePlayEvent,
  isUsableForeseerNative,
  nativeHostEventTypesV2,
  nativeProtocolV2,
  shouldClearNativePlayRequest,
  terminalNativePlayEventTypesV2,
  type ForeseerNativeV2,
} from '../../src/context/nativeRuntimeProtocol';

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'protocol/protocol-v2.json'), 'utf8')
);

describe('native runtime protocol v2', () => {
  it('conforms to the checked-in protocol fixture', () => {
    assert.equal(fixture.fixtureId, nativeProtocolV2.fixtureId);
    assert.equal(fixture.protocolVersion, nativeProtocolV2.protocolVersion);
    assert.equal(fixture.host.name, nativeProtocolV2.hostName);
    assert.equal(fixture.eventName, nativeProtocolV2.eventName);
    assert.equal(
      fixture.limits.requestIdMaxLength,
      nativeProtocolV2.limits.requestIdMaxLength
    );
    assert.equal(
      fixture.limits.itemIdMaxLength,
      nativeProtocolV2.limits.itemIdMaxLength
    );
    assert.equal(
      fixture.limits.ticketLength,
      nativeProtocolV2.limits.ticketLength
    );
    assert.equal(
      fixture.limits.challengeHexLength,
      nativeProtocolV2.limits.challengeHexLength
    );
    assert.deepEqual(nativeProtocolV2.playCommand, {
      type: 'play.item',
      fields: ['id', 'itemId'],
    });
    assert.equal(fixture.resumePolicy.owner, nativeProtocolV2.resumeOwner);
    assert.equal(fixture.resumePolicy.startPositionTicksInProtocol, false);
    assert.equal(fixture.browserFallback.required, true);
    assert.equal(
      fixture.browserFallback.navigationPreventedOnlyAfterNativeAdmission,
      true
    );
    assert.equal(fixture.browserFallback.v1HostFallsBackToBrowser, true);
    assert.deepEqual(fixture.hostEventTypes, nativeHostEventTypesV2);
    assert.deepEqual(
      fixture.terminalPlayEventTypes,
      terminalNativePlayEventTypesV2
    );
    assert.equal(fixture.requestCorrelation.required, true);
    assert.deepEqual(fixture.bootstrapEnvelope.wireFields, [
      'serverUrl',
      'serverId',
      'userId',
      'deviceId',
      'accessToken',
      'bootstrapGeneration',
    ]);
  });

  it('keeps playback command fields at protocol v2', () => {
    const play = fixture.commands.find(
      (command: { type: string }) => command.type === 'play.item'
    );
    assert.deepEqual(play?.fields, ['id', 'itemId']);
  });

  it('rejects event types outside the closed protocol set', () => {
    for (const type of fixture.hostEventTypes) {
      assert.equal(isNativeHostEventTypeV2(type), true);
    }
    assert.equal(isNativeHostEventTypeV2('token'), false);
    assert.equal(isNativeHostEventTypeV2('renderer-details'), false);
  });

  it('matches protocol identifier and field size constraints', () => {
    assert.deepEqual(nativeProtocolV2.limits, {
      requestIdMaxLength: 64,
      itemIdMaxLength: 128,
      ticketLength: 43,
      challengeHexLength: 64,
    });
  });

  it('treats missing and v1-shaped hosts as unusable', () => {
    assert.equal(isUsableForeseerNative(undefined), false);
    assert.equal(
      isUsableForeseerNative({
        protocolVersion: 1,
        hostName: 'jellium-desktop',
        hostVersion: '0.1.0',
        capabilities: ['play-item'],
        send: () => true,
      } as unknown as ForeseerNativeV2),
      false
    );
    assert.equal(
      isUsableForeseerNative({
        protocolVersion: 2,
        hostName: 'foreseer-desktop',
        hostVersion: '0.2.0',
        capabilities: ['play-item', 'auth-bootstrap'],
        send: () => true,
      }),
      true
    );
  });

  it('keeps play B through canceled A, then clears only after finished B', () => {
    let activeRequestId: string | undefined = 'play-a';
    activeRequestId = 'play-b';

    assert.equal(
      shouldClearNativePlayRequest(activeRequestId, 'play-a', 'canceled'),
      false
    );
    assert.equal(isTerminalNativePlayEvent('playing'), false);
    assert.equal(isCurrentNativePlayRequest(activeRequestId, 'play-b'), true);
    assert.equal(
      shouldClearNativePlayRequest(activeRequestId, 'play-b', 'finished'),
      true
    );
    activeRequestId = undefined;
    assert.equal(activeRequestId, undefined);
  });
});
