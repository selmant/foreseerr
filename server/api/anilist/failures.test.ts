import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AnilistAuthError,
  AnilistOutageError,
  classifyAnilistFailure,
  firstAnilistGraphQlError,
} from './failures';

describe('classifyAnilistFailure', () => {
  it('treats AniList stability 403 as an outage, not expired auth', () => {
    const error = classifyAnilistFailure({
      httpStatus: 403,
      graphQlStatus: 403,
      message:
        'The AniList API has been temporarily disabled due to severe stability issues.',
    });
    assert.ok(error instanceof AnilistOutageError);
    assert.match(error.message, /temporarily disabled/);
  });

  it('keeps a bare 401/403 as reconnect-required auth', () => {
    assert.ok(
      classifyAnilistFailure({ httpStatus: 401 }) instanceof AnilistAuthError
    );
    assert.ok(
      classifyAnilistFailure({ graphQlStatus: 403 }) instanceof AnilistAuthError
    );
  });

  it('reads the first GraphQL error off an AniList body', () => {
    assert.deepEqual(
      firstAnilistGraphQlError({
        errors: [{ message: 'nope', status: 403 }],
        data: null,
      }),
      { status: 403, message: 'nope' }
    );
    assert.deepEqual(firstAnilistGraphQlError(null), {});
  });
});
