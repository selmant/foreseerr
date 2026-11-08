import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editAiSliderPrompt, parseAiSlider } from './aiSlider';

const config = {
  version: 1,
  request: {
    prompt: 'Based on my taste',
    seed: { mediaType: 'tv', tmdbId: 123 },
    only: 'tv',
    anime: true,
    refinements: ['Twistier mysteries'],
  },
  initialRunId: 42,
  savedAt: '2026-11-08T00:00:00.000Z',
};

describe('Saved AI slider editing', () => {
  it('shows a plain prompt for both legacy and structured sliders', () => {
    assert.equal(
      parseAiSlider('Cozy mysteries').request.prompt,
      'Cozy mysteries'
    );
    assert.equal(
      parseAiSlider(JSON.stringify(config)).request.prompt,
      'Based on my taste'
    );
    assert.equal(parseAiSlider().request.prompt, '');
  });

  it('preserves the initial cache for title-only edits', () => {
    const data = JSON.stringify(config);
    assert.equal(editAiSliderPrompt(data, 'Based on my taste'), data);
  });

  it('invalidates old picks when the prompt changes and retains the other constraints', () => {
    const updated = parseAiSlider(
      editAiSliderPrompt(JSON.stringify(config), 'Slow mysteries')
    );
    assert.deepEqual(updated.request, {
      ...config.request,
      prompt: 'Slow mysteries',
    });
    assert.equal(updated.initialRunId, undefined);
    assert.equal(updated.savedAt, undefined);
  });
});
