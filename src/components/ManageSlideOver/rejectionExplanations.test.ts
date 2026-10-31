import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIntl } from 'react-intl';
import { explainRejection, explainRejections } from './rejectionExplanations';

const intl = createIntl({ locale: 'en' });

describe('rejection explanations', () => {
  it('explains the common Sonarr 5 release reasons', () => {
    assert.equal(
      explainRejection(intl, 'release', 'blocklisted', 'Sonarr'),
      'Blocklisted: this release failed or was rejected before.'
    );
    assert.match(
      explainRejection(intl, 'release', 'multiSeason', 'Sonarr') ?? '',
      /Sonarr won't grab it on its own or import it automatically/
    );
    for (const code of [
      'fullSeasonNotAired',
      'beforeAirDate',
      'episodeNotMonitored',
      'qualityNotWanted',
      'belowMinimumSize',
      'diskCutoffMet',
    ]) {
      assert.ok(explainRejection(intl, 'release', code, 'Sonarr'), code);
    }
  });

  it("falls back to Sonarr's message", () => {
    assert.equal(
      explainRejection(intl, 'release', 'somethingNew', 'Sonarr'),
      undefined
    );
    assert.equal(
      explainRejection(intl, 'release', undefined, 'Sonarr'),
      undefined
    );
    assert.equal(
      explainRejection(intl, 'release', 'constructor', 'Sonarr'),
      undefined,
      'not an object key'
    );
    assert.deepEqual(
      explainRejections(
        intl,
        'release',
        [
          { message: 'Release is blocklisted', code: 'blocklisted' },
          { message: 'Wrong season' },
          { message: 'Custom thing', code: 'somethingNew' },
        ],
        'Sonarr'
      ),
      [
        {
          text: 'Blocklisted: this release failed or was rejected before.',
          detail: 'Release is blocklisted',
        },
        { text: 'Wrong season' },
        { text: 'Custom thing' },
      ]
    );
  });

  it('explains import reasons apart from release ones', () => {
    assert.match(
      explainRejection(intl, 'import', 'executableFile', 'Sonarr') ?? '',
      /Foreseerr won't import it/
    );
    assert.match(
      explainRejection(intl, 'import', 'multiSeason', 'Sonarr') ?? '',
      /Pick the episodes/
    );
    assert.equal(
      explainRejection(intl, 'import', 'blocklisted', 'Sonarr'),
      undefined,
      'a release reason'
    );
  });
});
