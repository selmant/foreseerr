import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';

it('downloads the issue index with the official artifact action', () => {
  const workflow = readFileSync(
    join(process.cwd(), '.github/workflows/detect-duplicate.yml'),
    'utf8'
  );

  assert.equal(workflow.includes('dawidd6/action-download-artifact'), false);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.ok(
    workflow.includes('run-id: ${{ steps.get-latest-run-id.outputs.run_id }}')
  );
});
