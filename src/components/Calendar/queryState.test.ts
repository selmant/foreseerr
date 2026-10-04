import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  calendarDateFromInput,
  parseCalendarPageState,
  serializeCalendarPageState,
  type CalendarPageState,
} from './queryState';

const defaults: CalendarPageState = {
  view: 'month',
  anchorDate: new Date(2026, 9, 4),
  scope: 'mine',
  mediaType: '',
  source: '',
  is4k: false,
};

describe('calendar planning navigation', () => {
  it('reads a local day exactly and rejects invalid or rolled dates', () => {
    const date = calendarDateFromInput('2028-02-29')!;
    assert.deepEqual(
      [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()],
      [2028, 1, 29, 0]
    );
    for (const value of [
      '2026-02-29',
      '2026-04-31',
      '2026-13-01',
      '2026-00-01',
      '2026-01-00',
      '10/04/2026',
      '2026-10-04T00:00:00Z',
    ])
      assert.equal(calendarDateFromInput(value), undefined);
  });
  it('restores a shared date, view, and every filter', () => {
    const state = parseCalendarPageState(
      '?date=2027-01-10&view=agenda&scope=all&mediaType=tv&source=sonarr&is4k=true',
      defaults
    );
    assert.deepEqual(state, {
      view: 'agenda',
      anchorDate: new Date(2027, 0, 10),
      scope: 'all',
      mediaType: 'tv',
      source: 'sonarr',
      is4k: true,
    });
  });
  it('preserves a shared calendar when saved filters and device defaults change', () => {
    const params = serializeCalendarPageState(defaults, '?from=library');
    const restored = parseCalendarPageState(params.toString(), {
      ...defaults,
      view: 'agenda',
      anchorDate: new Date(2028, 1, 3),
      scope: 'all',
      mediaType: 'movie',
      source: 'radarr',
      is4k: true,
    });
    assert.deepEqual(restored, defaults);
    assert.equal(params.get('from'), 'library');
  });
  it('uses validated preferences for missing or malformed values', () => {
    assert.deepEqual(
      parseCalendarPageState(
        '?date=invalid&view=year&scope=everyone&mediaType=anime&source=trakt&is4k=yes',
        defaults
      ),
      defaults
    );
  });
});
