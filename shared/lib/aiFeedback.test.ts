import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiFeedbackQueue } from './aiFeedback';
import type { AiVerdict } from '@shared/interfaces/api/aiInterfaces';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('Concurrent AI feedback edits', () => {
  it('keeps the later identical verdict when an earlier request fails', async () => {
    const queue = new AiFeedbackQueue();
    const first = deferred();
    const second = deferred();
    let visible: AiVerdict | null = null;
    const update = async (value: AiVerdict | null, current: () => boolean) => {
      if (current()) visible = value;
    };
    const a = queue
      .submit('movie-1', null, 'like', () => first.promise, update)
      .catch(() => undefined);
    const b = queue.submit(
      'movie-1',
      'like',
      'like',
      () => second.promise,
      update
    );
    first.reject(new Error('first failed'));
    await a;
    assert.equal(visible, 'like');
    second.resolve();
    await b;
    assert.equal(visible, 'like');
  });

  it('confirms writes in order even while an older cache update is pending', async () => {
    const queue = new AiFeedbackQueue();
    const cache = deferred();
    let visible: AiVerdict | null = 'seen';
    const a = queue.submit(
      'movie-3',
      'seen',
      'like',
      async () => undefined,
      async (value, current) => {
        await cache.promise;
        if (current()) visible = value;
      }
    );
    const b = queue
      .submit(
        'movie-3',
        'like',
        'dislike',
        async () => {
          throw new Error('second failed');
        },
        async (value, current) => {
          if (current()) visible = value;
        }
      )
      .catch(() => undefined);
    await b;
    assert.equal(visible, 'like');
    cache.resolve();
    await a;
    assert.equal(visible, 'like');
  });

  it('rolls a failed later edit back to the last confirmed server value', async () => {
    const queue = new AiFeedbackQueue();
    const first = deferred();
    const second = deferred();
    let visible: AiVerdict | null = 'seen';
    const update = async (value: AiVerdict | null, current: () => boolean) => {
      if (current()) visible = value;
    };
    const a = queue
      .submit('movie-2', 'seen', 'like', () => first.promise, update)
      .catch(() => undefined);
    const b = queue
      .submit('movie-2', 'like', 'dislike', () => second.promise, update)
      .catch(() => undefined);
    first.reject(new Error('first failed'));
    await a;
    second.reject(new Error('second failed'));
    await b;
    assert.equal(visible, 'seen');
  });
});
