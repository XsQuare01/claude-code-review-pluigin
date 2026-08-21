import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The unit tests import the module's functions, so they keep passing even when the CLI
// entry point references something that no longer exists. Running it is the only way to
// catch that, and the CLI is the surface an orchestrator actually uses.

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'prepare-verification.mjs')

const run = payload =>
  JSON.parse(execFileSync('node', [SCRIPT, '--merge-base', 'HEAD'], { input: JSON.stringify(payload), encoding: 'utf8' }))

test('the CLI runs end to end on an empty candidate set', () => {
  const result = run({ candidates: [] })
  assert.equal(result.counts.total, 0)
})

test('the CLI accepts producer results and assigns candidate ids', () => {
  const result = run({
    results: [
      {
        schemaVersion: 1,
        openQuestions: [],
        findings: [
          { ruleId: '01-1', title: 't', body: 'b', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'README.md', line: 1, quote: '# React Code Review Plugin' } },
        ],
      },
    ],
  })
  assert.equal(result.counts.total, 1)
  assert.equal(result.candidates[0].candidateId, '01-1#1')
  assert.equal(result.candidates[0].locationCheck, 'location-ok')
})

test('the CLI reports an unreadable path rather than crashing', () => {
  const result = run({ candidates: [{ candidateId: 'x#1', ruleId: 'x', impact: 'low', confidence: 'high', location: { kind: 'verified', path: 'does/not/exist.ts', line: 1, quote: 'q' } }] })
  assert.equal(result.candidates[0].locationCheck, 'location-unresolvable')
})
