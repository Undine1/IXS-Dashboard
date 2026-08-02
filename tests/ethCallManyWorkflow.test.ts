import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('eth_callMany workflow is read-only, evidence-only, and always uploads its artifact', () => {
  const workflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'probe-eth-call-many.yml'),
    'utf8',
  );
  const productionWorkflow = fs.readFileSync(
    path.join(process.cwd(), '.github', 'workflows', 'update-dashboard-data.yml'),
    'utf8',
  );

  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*\r?\n\s+contents: read/);
  assert.match(workflow, /run: npm run probe:eth-call-many/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /path: data\/eth_call_many_shadow\.json/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /git (?:add|commit|push|config)/);
  assert.doesNotMatch(productionWorkflow, /probe:eth-call-many|eth_callMany/);
});
