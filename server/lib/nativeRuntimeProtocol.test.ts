/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  isCurrentNativePlayRequest,
  isNativeHostEventTypeV1,
  isTerminalNativePlayEvent,
  nativeHostEventTypesV1,
  nativeProtocolV1,
  shouldClearNativePlayRequest,
  terminalNativePlayEventTypesV1,
} from '../../src/context/nativeRuntimeProtocol';

const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'protocol/protocol-v1.json'), 'utf8')
);

describe('native runtime protocol v1', () => {
  it('conforms to the checked-in protocol fixture', () => {
    assert.equal(fixture.fixtureId, nativeProtocolV1.fixtureId);
    assert.equal(fixture.protocolVersion, nativeProtocolV1.protocolVersion);
    assert.equal(fixture.host.name, nativeProtocolV1.hostName);
    assert.equal(
      fixture.limits.requestIdMaxLength,
      nativeProtocolV1.limits.requestIdMaxLength
    );
    assert.equal(
      fixture.limits.itemIdMaxLength,
      nativeProtocolV1.limits.itemIdMaxLength
    );
    assert.equal(
      fixture.limits.ticketLength,
      nativeProtocolV1.limits.ticketLength
    );
    assert.equal(
      fixture.limits.challengeHexLength,
      nativeProtocolV1.limits.challengeHexLength
    );
    assert.deepEqual(fixture.hostMethods.playItem, ['requestId', 'itemId']);
    assert.deepEqual(nativeProtocolV1.playMethod, {
      name: 'playItem',
      arguments: fixture.hostMethods.playItem,
    });
    assert.equal(fixture.resumePolicy.owner, nativeProtocolV1.resumeOwner);
    assert.equal(fixture.resumePolicy.startPositionTicksInProtocol, false);
    assert.equal(fixture.browserFallback.required, true);
    assert.equal(
      fixture.browserFallback.navigationPreventedOnlyAfterNativeAdmission,
      true
    );
    assert.deepEqual(fixture.hostEventTypes, nativeHostEventTypesV1);
    assert.deepEqual(
      fixture.terminalPlayEventTypes,
      terminalNativePlayEventTypesV1
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

  it('keeps playback command arity at protocol v1', () => {
    assert.deepEqual(nativeProtocolV1.playMethod, {
      name: 'playItem',
      arguments: ['requestId', 'itemId'],
    });
  });

  it('rejects event types outside the closed protocol set', () => {
    for (const type of fixture.hostEventTypes) {
      assert.equal(isNativeHostEventTypeV1(type), true);
    }
    assert.equal(isNativeHostEventTypeV1('token'), false);
    assert.equal(isNativeHostEventTypeV1('renderer-details'), false);
  });

  it('matches protocol identifier and field size constraints', () => {
    assert.deepEqual(nativeProtocolV1.limits, {
      requestIdMaxLength: 64,
      itemIdMaxLength: 128,
      ticketLength: 43,
      challengeHexLength: 64,
    });
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
