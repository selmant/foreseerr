import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizedChatgptCallback } from './chatgptCallback';
const redirect = 'http://127.0.0.1:1455/auth/callback';
describe('ChatGPT callback input', () => {
  it('submits the complete, normalized URL when the browser omits its scheme', () => {
    assert.equal(
      normalizedChatgptCallback(
        '127.0.0.1:1455/auth/callback?code=c&state=s',
        redirect,
        's'
      ),
      `${redirect}?code=c&state=s`
    );
  });
  it('waits for the code even when state was typed first', () => {
    assert.equal(
      normalizedChatgptCallback(`${redirect}?state=s`, redirect, 's'),
      null
    );
    assert.equal(
      normalizedChatgptCallback(`${redirect}?state=s&code=c`, redirect, 's'),
      `${redirect}?state=s&code=c`
    );
  });
  it('rejects unrelated clipboard contents and mismatched attempts', () => {
    for (const text of [
      'private text',
      'http://example.test/?code=c&state=s',
      `${redirect}?code=c&state=wrong`,
    ])
      assert.equal(normalizedChatgptCallback(text, redirect, 's'), null);
  });
});
