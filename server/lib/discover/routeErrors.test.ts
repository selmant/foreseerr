import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleDiscoverRouteError } from './routeErrors';

describe('Discover route error handling', () => {
  it('preserves provider retry metadata', () => {
    let result: unknown;
    handleDiscoverRouteError(
      new Error('slow down'),
      (error) => {
        result = error;
      },
      'fallback',
      [
        {
          matches: () => true,
          status: 429,
          retryAfter: () => 12,
          message: (error) => (error as Error).message,
        },
      ]
    );

    assert.deepEqual(result, {
      status: 429,
      message: 'slow down',
      retryAfter: 12,
    });
  });
});
