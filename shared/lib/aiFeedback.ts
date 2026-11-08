import type { AiVerdict } from '@shared/interfaces/api/aiInterfaces';

/** Order writes per title and fence each optimistic edit with a unique identity. */
export class AiFeedbackQueue {
  private entries = new Map<
    string,
    {
      tail: Promise<unknown>;
      latest: symbol;
      confirmed: AiVerdict | null;
    }
  >();

  async submit<T>(
    key: string,
    previous: AiVerdict | null,
    kind: AiVerdict | null,
    write: () => Promise<T>,
    update: (
      value: AiVerdict | null,
      isCurrent: () => boolean
    ) => Promise<unknown>
  ): Promise<T> {
    const token = Symbol(key);
    const entry = this.entries.get(key) ?? {
      tail: Promise.resolve(),
      latest: token,
      confirmed: previous,
    };
    entry.latest = token;
    const isCurrent = () => entry.latest === token;
    const request = entry.tail
      .catch(() => undefined)
      .then(async () => {
        const result = await write();
        entry.confirmed = kind;
        return result;
      });
    entry.tail = request;
    // Cache updates can lag behind a failed request; handle its rejection immediately.
    void request.catch(() => undefined);
    this.entries.set(key, entry);
    await update(kind, isCurrent);
    try {
      const result = await request;
      if (isCurrent()) await update(kind, isCurrent);
      return result;
    } catch (error) {
      if (isCurrent()) await update(entry.confirmed, isCurrent);
      throw error;
    } finally {
      if (entry.tail === request) this.entries.delete(key);
    }
  }
}
