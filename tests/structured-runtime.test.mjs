import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  extractMarkedBlock,
  deriveManifestSchema,
  parseStructuredProducerResponse,
  validateReviewResultContract,
} from '../scripts/lib/review-result-contract.mjs'
import {
  aggregatePasses,
  consumeProducerResponse,
  createPassState,
  deriveSeverity,
  renderStructuredSections,
} from '../scripts/lib/structured-runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const workflowContractPath = join(root, 'review-rules', 'workflow-contract.md')
const manifestFixturePath = join(root, 'tests', 'review-result-contract', 'valid', 'markdown-control-content.json')

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function loadManifest() {
  const text = await readFile(workflowContractPath, 'utf8')
  const block = extractMarkedBlock(text, 'REVIEW_RESULT_CONTRACT_V1')
  return JSON.parse(block.match(/^```json\s*([\s\S]*?)\s*```$/)[1])
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value)) deepFreeze(nested)
  return value
}

test('manifest extraction and derivation use the canonical workflow contract block', async () => {
  const text = await readFile(workflowContractPath, 'utf8')
  const block = extractMarkedBlock(text, 'REVIEW_RESULT_CONTRACT_V1')
  assert.match(block, /^```json/)

  const manifest = JSON.parse(block.match(/^```json\s*([\s\S]*?)\s*```$/)[1])
  const derived = deriveManifestSchema(manifest)

  assert.equal(manifest.contractName, 'REVIEW_RESULT_CONTRACT_V1')
  assert.deepEqual([...derived.topLevelAllowed].sort(), ['findings', 'openQuestions', 'schemaVersion'])
  assert.deepEqual([...derived.locationAllowed.unverified].sort(), ['kind', 'reason'])
})

test('structured parser accepts surrounding whitespace but rejects fences prose and legacy markdown', async () => {
  const manifest = await loadManifest()
  const valid = await readJson(manifestFixturePath)
  const raw = `\n  ${JSON.stringify(valid.input, null, 2)}\n`

  assert.deepEqual(parseStructuredProducerResponse(raw, manifest), valid.input)

  for (const invalidRaw of [
    `\n\
\u0000`,
    `\n\

\

\n`,
    `before\n${JSON.stringify(valid.input)}`,
    `\`\`\`json\n${JSON.stringify(valid.input, null, 2)}\n\`\`\``,
    `# heading\n\n${JSON.stringify(valid.input)}`,
    `위반 없음`,
  ]) {
    assert.throws(() => parseStructuredProducerResponse(invalidRaw, manifest), /E_RESPONSE_(NOT_JSON_OBJECT|FENCED|PROSE_OR_LEGACY)/)
  }
})

test('contract validation reports stable errors including recursive severity rejection', async () => {
  const manifest = await loadManifest()
  const invalid = {
    schemaVersion: 1,
    findings: [{
      ruleId: '19-2',
      title: 'bad',
      body: 'bad',
      impact: 'high',
      confidence: 'low',
      location: { kind: 'unverified', reason: 'missing anchor', severity: 'red' },
      severity: 'red',
    }],
    openQuestions: [],
  }

  const errors = validateReviewResultContract(invalid, manifest)
  assert.ok(errors.some(error => error.code === 'E_FORBIDDEN_SEVERITY'))
  assert.ok(errors.some(error => error.code === 'E_FINDING_HIGH_REQUIRES_CATEGORY'))
  assert.ok(errors.some(error => error.code === 'E_FINDING_HIGH_REQUIRES_EVIDENCE'))
  assert.ok(errors.some(error => error.code === 'E_FINDING_LOW_CONFIDENCE_REQUIRES_REASON'))
})

test('contract validation rejects invisible control and bidi characters in producer strings', async () => {
  const manifest = await loadManifest()
  const valid = (await readJson(manifestFixturePath)).input
  const cases = [
    { label: 'title NUL', mutate: value => { value.findings[0].title += '\u0000hidden' } },
    { label: 'body bidi override', mutate: value => { value.findings[0].body += '\u202Ehidden' } },
    { label: 'finding reason isolate', mutate: value => { value.findings[0].reason = 'needs review\u2066hidden'; value.findings[0].confidence = 'low' } },
    { label: 'path zero-width mark', mutate: value => { value.findings[0].location.path += '\u200Bhidden' } },
    { label: 'quote C1 control', mutate: value => { value.findings[0].location.quote += '\u0085hidden' } },
  ]

  for (const { label, mutate } of cases) {
    const payload = structuredClone(valid)
    mutate(payload)
    assert.throws(
      () => parseStructuredProducerResponse(JSON.stringify(payload), manifest),
      error => error?.message.includes('E_FORBIDDEN_CONTROL_CHARACTER'),
      label,
    )
  }
})

test('corrective lifecycle: valid first response accepts and terminal states reject reuse', async () => {
  const manifest = await loadManifest()
  const valid = (await readJson(manifestFixturePath)).input
  const state = createPassState({ sourceLabel: 'module:03-react-rules', manifest })
  const accepted = consumeProducerResponse(state, JSON.stringify(valid))

  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.pass.status, 'accepted')
  assert.deepEqual(accepted.pass.result, valid)
  assert.throws(() => consumeProducerResponse(accepted.pass, JSON.stringify(valid)), /E_PASS_TERMINAL/)
})

test('corrective lifecycle: first invalid retries once, second invalid fails closed, retry success accepts', async () => {
  const manifest = await loadManifest()
  const valid = (await readJson(manifestFixturePath)).input

  const retryState = createPassState({ sourceLabel: 'module:05-structure', manifest })
  const firstInvalid = consumeProducerResponse(retryState, '```json\n{}\n```')
  assert.equal(firstInvalid.status, 'retry')
  assert.match(firstInvalid.diagnostics, /E_RESPONSE_FENCED|E_TOPLEVEL_MISSING_FINDINGS/)
  assert.equal(firstInvalid.pass.attempts, 1)
  assert.equal(firstInvalid.pass.result, null)

  const recovered = consumeProducerResponse(firstInvalid.pass, JSON.stringify(valid))
  assert.equal(recovered.status, 'accepted')
  assert.deepEqual(recovered.pass.result, valid)

  const failedState = createPassState({ sourceLabel: 'module:06-jsx', manifest })
  const invalidOnce = consumeProducerResponse(failedState, '# nope')
  const invalidTwice = consumeProducerResponse(invalidOnce.pass, '```json\n{}\n```')
  assert.equal(invalidTwice.status, 'failed')
  assert.equal(invalidTwice.pass.status, 'failed')
  assert.equal(invalidTwice.pass.failureKind, 'malformed-output')
  assert.equal(invalidTwice.pass.result, null)
})

test('aggregation keeps only accepted payloads, preserves failures, partials, deterministic order, and unique source labels', async () => {
  const manifest = await loadManifest()
  const valid = (await readJson(manifestFixturePath)).input
  const acceptedA = { ...valid, findings: [...valid.findings, { ...valid.findings[0], ruleId: '03-1', title: 'first', body: 'first body', location: { kind: 'unverified', reason: 'anchor not closed yet' } }] }
  const acceptedB = { schemaVersion: 1, findings: [{ ...valid.findings[0], ruleId: '04-2', title: 'second', body: 'second body', location: { kind: 'deleted', path: './src\\cleanup.ts', lineBefore: 9, quote: 'cleanup()' } }], openQuestions: [{ title: 'oq', body: 'body', reason: 'search incomplete', location: { kind: 'unverified', reason: 'scope open' } }] }

  deepFreeze(acceptedA)
  deepFreeze(acceptedB)

  const aggregated = aggregatePasses([
    { status: 'accepted', sourceLabel: 'module:03-react-rules', result: acceptedA },
    { status: 'failed', sourceLabel: 'module:05-structure', failureKind: 'malformed-output', result: null },
    { status: 'accepted', sourceLabel: 'module:04-state', result: acceptedB },
  ], manifest)

  assert.deepEqual(aggregated.failedPasses.map(pass => pass.sourceLabel), ['module:05-structure'])
  assert.deepEqual(aggregated.findings.map(finding => finding.ruleId), ['19-2', '03-1', '04-2'])
  assert.deepEqual(aggregated.findings[0].sourceLabels, ['module:03-react-rules'])
  assert.deepEqual(aggregated.openQuestions[0].sourceLabels, ['module:04-state'])
})

test('aggregation merges only exact conservative verified/deleted identity and never merges unverified or openQuestions', async () => {
  const manifest = await loadManifest()
  const baseFinding = {
    ruleId: '17-3',
    title: ' same title\r\n',
    body: ' same body\r\n',
    impact: 'high',
    category: 'verification-failure',
    evidence: 'same evidence',
    confidence: 'low',
    reason: 'same reason',
    recommendation: 'same rec',
    location: { kind: 'verified', path: './src\\feature.ts', line: 7, quote: 'start()' },
  }
  const merged = aggregatePasses([
    { status: 'accepted', sourceLabel: 'pass-a', result: { schemaVersion: 1, findings: [baseFinding], openQuestions: [{ title: 'oq', body: 'b', reason: 'r', location: { kind: 'unverified', reason: 'scope' } }] } },
    { status: 'accepted', sourceLabel: 'pass-b', result: { schemaVersion: 1, findings: [{ ...baseFinding, location: { ...baseFinding.location, path: 'src/feature.ts' }, title: 'same title', body: 'same body' }], openQuestions: [{ title: 'oq', body: 'b', reason: 'r', location: { kind: 'unverified', reason: 'scope' } }] } },
    { status: 'accepted', sourceLabel: 'pass-c', result: { schemaVersion: 1, findings: [{ ...baseFinding, title: 'different title' }, { ...baseFinding, location: { kind: 'unverified', reason: 'not verified' } }], openQuestions: [{ title: 'oq', body: 'b', reason: 'r', location: { kind: 'unverified', reason: 'scope' } }] } },
  ], manifest)

  assert.equal(merged.findings.length, 3)
  assert.deepEqual(merged.findings[0].sourceLabels, ['pass-a', 'pass-b'])
  assert.equal(merged.findings[1].title, 'different title')
  assert.equal(merged.findings[2].location.kind, 'unverified')
  assert.equal(merged.openQuestions.length, 3)
})

test('aggregation does not merge otherwise identical findings when confidence differs', async () => {
  const manifest = await loadManifest()
  const baseFinding = {
    ruleId: '17-3',
    title: 'same title',
    body: 'same body',
    impact: 'high',
    category: 'verification-failure',
    evidence: 'same evidence',
    location: { kind: 'verified', path: 'src/feature.ts', line: 7, quote: 'start()' },
  }

  const aggregated = aggregatePasses([
    {
      status: 'accepted',
      sourceLabel: 'pass-high',
      result: {
        schemaVersion: 1,
        findings: [{ ...baseFinding, confidence: 'high' }],
        openQuestions: [],
      },
    },
    {
      status: 'accepted',
      sourceLabel: 'pass-low',
      result: {
        schemaVersion: 1,
        findings: [{ ...baseFinding, confidence: 'low', reason: 'needs manual confirmation' }],
        openQuestions: [],
      },
    },
  ], manifest)

  assert.equal(aggregated.findings.length, 2)
  assert.deepEqual(aggregated.findings.map(finding => finding.confidence), ['high', 'low'])
})

test('aggregation rejects pending and retrying passes with a stable nonterminal error', async () => {
  const manifest = await loadManifest()

  for (const status of ['pending', 'retrying']) {
    assert.throws(
      () => aggregatePasses([{ status, sourceLabel: `pass-${status}`, manifest, result: null }]),
      error => error?.message === 'E_PASS_NONTERMINAL: aggregatePasses requires terminal pass states',
    )
  }
})

test('aggregation does not merge verified or deleted findings when only endLine or quote differs', async () => {
  const manifest = await loadManifest()
  const verifiedBase = {
    ruleId: '16-4',
    title: 'same verified title',
    body: 'same verified body',
    impact: 'high',
    category: 'external-breakage',
    evidence: 'same evidence',
    confidence: 'high',
    location: {
      kind: 'verified',
      path: './src\\api.ts',
      line: 11,
      endLine: 14,
      quote: 'const field = response.user.email',
    },
  }
  const deletedBase = {
    ruleId: '20-2',
    title: 'same deleted title',
    body: 'same deleted body',
    impact: 'high',
    category: 'verification-failure',
    evidence: 'same deletion evidence',
    confidence: 'high',
    location: {
      kind: 'deleted',
      path: 'src/cleanup.ts',
      lineBefore: 21,
      endLine: 23,
      quote: 'return () => cleanup(timer)',
    },
  }

  const aggregated = aggregatePasses([
    {
      status: 'accepted',
      sourceLabel: 'verified-a',
      result: {
        schemaVersion: 1,
        findings: [verifiedBase],
        openQuestions: [],
      },
    },
    {
      status: 'accepted',
      sourceLabel: 'verified-b',
      result: {
        schemaVersion: 1,
        findings: [{
          ...verifiedBase,
          location: { ...verifiedBase.location, endLine: 15 },
        }],
        openQuestions: [],
      },
    },
    {
      status: 'accepted',
      sourceLabel: 'deleted-a',
      result: {
        schemaVersion: 1,
        findings: [deletedBase],
        openQuestions: [],
      },
    },
    {
      status: 'accepted',
      sourceLabel: 'deleted-b',
      result: {
        schemaVersion: 1,
        findings: [{
          ...deletedBase,
          location: { ...deletedBase.location, quote: 'return () => cleanup(nextTimer)' },
        }],
        openQuestions: [],
      },
    },
  ], manifest)

  assert.equal(aggregated.findings.length, 4)
  assert.deepEqual(aggregated.findings.map(finding => finding.sourceLabels), [
    ['verified-a'],
    ['verified-b'],
    ['deleted-a'],
    ['deleted-b'],
  ])
})

test('severity derives from impact and confidence only across all four cells', () => {
  assert.equal(deriveSeverity({ impact: 'high', confidence: 'high' }), '🔴')
  assert.equal(deriveSeverity({ impact: 'high', confidence: 'low' }), '🟡')
  assert.equal(deriveSeverity({ impact: 'low', confidence: 'high' }), '🟡')
  assert.equal(deriveSeverity({ impact: 'low', confidence: 'low' }), '🔵')
})

test('severity rejects invalid or missing axes with a stable error instead of incidental destructuring failures', () => {
  for (const invalid of [
    undefined,
    null,
    [],
    {},
    { impact: 'high' },
    { confidence: 'high' },
    { impact: 'medium', confidence: 'high' },
    { impact: 'high', confidence: 'medium' },
  ]) {
    assert.throws(
      () => deriveSeverity(invalid),
      error => error?.message === 'E_INVALID_SEVERITY_AXES: deriveSeverity requires impact/confidence high|low axes',
    )
  }
})

test('renderer uses manifest slot order and labels, escapes adversarial prose, keeps urls plain, and renders safe code slots', async () => {
  const manifest = await loadManifest()
  const payload = (await readJson(manifestFixturePath)).input
  const rendered = renderStructuredSections({
    findings: [{ ...payload.findings[0], sourceLabels: ['module:19-intent'] }],
    openQuestions: [{ title: 'open [link](https://example.com)', body: '<b>body</b>', reason: '```why```', location: { kind: 'unverified', reason: 'missing `anchor`' }, sourceLabels: ['module:00-rule'] }],
  }, manifest)

  assert.ok(rendered.findings.includes('####'))
  assert.ok(rendered.findings.includes('영향: 낮음 · 확신: 높음'))
  assert.ok(rendered.findings.includes('`src/app/report.ts:12`'))
  assert.ok(rendered.findings.includes('module:19-intent'))
  assert.ok(rendered.findings.includes('본문:'))
  assert.ok(rendered.findings.includes('근거:'))
  assert.ok(!rendered.findings.includes('<a href='))
  assert.ok(!rendered.findings.includes('[link]('))
  assert.ok(!/^# /m.test(rendered.findings.replace(/^#### .*$/m, '')))
  assert.match(rendered.findings, /https&#58;\/\/example\.com/)
  assert.match(rendered.findings, /``+const title =/)
  assert.ok(rendered.openQuestions.includes('추가 확인 이유:'))
  assert.ok(rendered.openQuestions.includes('위치 미확인 사유:'))
})

test('renderer renders an openQuestion unverified location reason exactly once', async () => {
  const manifest = await loadManifest()
  const rendered = renderStructuredSections({
    findings: [],
    openQuestions: [{
      title: 'missing anchor',
      body: 'needs follow-up',
      reason: 'scope still open',
      location: { kind: 'unverified', reason: 'exact line not closed yet' },
      sourceLabels: ['module:17-concurrency'],
    }],
  }, manifest)

  const count = (rendered.openQuestions.match(/위치 미확인 사유:/g) ?? []).length
  assert.equal(count, 1)
})

test('renderer renders verified and deleted openQuestion locations exactly once with safe path range and quote', async () => {
  const manifest = await loadManifest()
  const rendered = renderStructuredSections({
    findings: [],
    openQuestions: [
      {
        title: 'verified follow-up',
        body: 'needs exact consumer check',
        reason: 'consumer scope not closed',
        location: {
          kind: 'verified',
          path: './src\\verified.ts',
          line: 4,
          endLine: 6,
          quote: 'const endpoint = api.baseUrl',
        },
        sourceLabels: ['module:16-api-contract'],
      },
      {
        title: 'deleted follow-up',
        body: 'needs cleanup recovery check',
        reason: 'deleted path impact still under review',
        location: {
          kind: 'deleted',
          path: 'src\\deleted.ts',
          lineBefore: 9,
          endLine: 11,
          quote: 'return () => dispose(subscription)',
        },
        sourceLabels: ['module:20-deletion-regression'],
      },
    ],
  }, manifest)

  const verifiedLocation = '`src/verified.ts:4-6` — `const endpoint = api.baseUrl`'
  const deletedLocation = '`src/deleted.ts:9-11` — `return () => dispose(subscription)`'
  assert.equal((rendered.openQuestions.match(/`src\/verified\.ts:4-6`/g) ?? []).length, 1)
  assert.equal((rendered.openQuestions.match(/`src\/deleted\.ts:9-11`/g) ?? []).length, 1)
  assert.ok(rendered.openQuestions.includes(verifiedLocation))
  assert.ok(rendered.openQuestions.includes(deletedLocation))
})

test('renderer neutralizes bare producer urls while preserving readable content and inert markdown/html', async () => {
  const manifest = await loadManifest()
  const rendered = renderStructuredSections({
    findings: [{
      ruleId: '19-4',
      title: 'bare url handling',
      body: 'Keep http://example.com/path?q=1 and https://example.com/docs visible, plus [md](https://example.com/x) and <a href="https://example.com/y">html</a>.',
      impact: 'low',
      confidence: 'high',
      location: {
        kind: 'verified',
        path: 'src/runtime.ts',
        line: 8,
        quote: 'const url = "http://example.com/path?q=1"',
      },
      evidence: 'See https://evidence.example.test and http://backup.example.test for context.',
      sourceLabels: ['module:19-intent'],
    }],
    openQuestions: [],
  }, manifest)

  const proseOnly = rendered.findings
    .split('\n')
    .filter(line => line.startsWith('본문:') || line.startsWith('근거:'))
    .join('\n')

  assert.ok(rendered.findings.includes('example.com/path?q=1'))
  assert.ok(rendered.findings.includes('example.com/docs'))
  assert.ok(rendered.findings.includes('evidence.example.test'))
  assert.ok(rendered.findings.includes('backup.example.test'))
  assert.ok(!proseOnly.includes('http://'))
  assert.ok(!proseOnly.includes('https://'))
  assert.ok(proseOnly.includes('http&#58;//example.com/path?q=1'))
  assert.ok(proseOnly.includes('https&#58;//example.com/docs'))
  assert.ok(proseOnly.includes('https&#58;//evidence.example.test'))
  assert.ok(proseOnly.includes('http&#58;//backup.example.test'))
  assert.ok(!proseOnly.includes('[md]('))
  assert.ok(!proseOnly.includes('<a href='))
})

test('renderer neutralizes http, www, and bare email autolink literals across prose slots without hiding readable content', async () => {
  const manifest = await loadManifest()
  const rendered = renderStructuredSections({
    findings: [{
      ruleId: '19-7',
      title: 'autolink neutralization',
      body: 'Body keeps http://body.example/path, https://secure.example/docs, www.example.com/help, and team@example.com readable.',
      impact: 'high',
      category: 'verification-failure',
      evidence: 'Evidence repeats http://evidence.example, www.evidence.example, and evidence@example.com.',
      confidence: 'low',
      reason: 'Reason mentions https://reason.example, www.reason.example, and reason@example.com.',
      recommendation: 'Recommendation keeps http://fix.example, www.fix.example, and fix@example.com visible.',
      location: {
        kind: 'verified',
        path: 'src/runtime.ts',
        line: 10,
        quote: 'const contact = "team@example.com"',
      },
      sourceLabels: ['module:19-intent'],
    }],
    openQuestions: [{
      title: 'open autolink follow-up',
      body: 'Open body has www.question.example and question@example.com.',
      reason: 'Open reason has http://question.example and www.reason-question.example plus question-reason@example.com.',
      recommendation: 'Open recommendation includes https://question-fix.example and help@example.com.',
      location: { kind: 'unverified', reason: 'Need owner at www.owner.example and owner@example.com.' },
      sourceLabels: ['module:00-rule'],
    }],
  }, manifest)

  for (const rawToken of [
    'http://body.example/path',
    'https://secure.example/docs',
    'www.example.com/help',
    'http://evidence.example',
    'www.evidence.example',
    'evidence@example.com',
    'https://reason.example',
    'www.reason.example',
    'reason@example.com',
    'http://fix.example',
    'www.fix.example',
    'fix@example.com',
    'www.question.example',
    'question@example.com',
    'http://question.example',
    'www.reason-question.example',
    'question-reason@example.com',
    'https://question-fix.example',
    'help@example.com',
    'www.owner.example',
    'owner@example.com',
  ]) {
    assert.ok(!rendered.findings.includes(rawToken))
    assert.ok(!rendered.openQuestions.includes(rawToken))
  }

  for (const readableToken of [
    'body.example/path',
    'secure.example/docs',
    'http&#58;//body.example/path',
    'https&#58;//secure.example/docs',
    'www&#46;example.com/help',
    'team&#64;example.com',
    'http&#58;//evidence.example',
    'www&#46;evidence.example',
    'evidence&#64;example.com',
    'https&#58;//reason.example',
    'www&#46;reason.example',
    'reason&#64;example.com',
    'http&#58;//fix.example',
    'www&#46;fix.example',
    'fix&#64;example.com',
    'www&#46;question.example',
    'question&#64;example.com',
    'http&#58;//question.example',
    'www&#46;reason-question.example',
    'question-reason&#64;example.com',
    'https&#58;//question-fix.example',
    'help&#64;example.com',
    'www&#46;owner.example',
    'owner&#64;example.com',
  ]) {
    assert.ok(rendered.findings.includes(readableToken) || rendered.openQuestions.includes(readableToken))
  }
})

test('renderer keeps setext headings, tilde fences, and indented markdown block controls inert while readable', async () => {
  const manifest = await loadManifest()
  const rendered = renderStructuredSections({
    findings: [{
      ruleId: '19-6',
      title: 'setext and indented block controls',
      body: [
        'Heading-like line',
        '===',
        'Subheading-like line',
        '---',
        '~~~danger',
        'payload',
        '~~~',
        '  # indented heading',
        '   > indented quote',
        '  - indented list',
        '   ```fence',
        '  ~~~tilde',
        '   | fake | table |',
      ].join('\n'),
      impact: 'low',
      confidence: 'high',
      location: {
        kind: 'verified',
        path: 'src/escape.ts',
        line: 3,
        quote: 'const text = input',
      },
      sourceLabels: ['module:19-intent'],
    }],
    openQuestions: [],
  }, manifest)

  const proseOnly = rendered.findings.split('\n').filter(line => line.startsWith('본문:') || line.startsWith('\\') || line.startsWith('Heading-like') || line.startsWith('Subheading-like') || line.startsWith('payload') || /^\s/.test(line)).join('\n')
  assert.ok(rendered.findings.includes('Heading-like line'))
  assert.ok(rendered.findings.includes('Subheading-like line'))
  assert.ok(rendered.findings.includes('payload'))
  assert.ok(proseOnly.includes('\\==='))
  assert.ok(proseOnly.includes('\\---'))
  assert.ok(proseOnly.includes('\\~~~danger'))
  assert.ok(proseOnly.includes('\\~~~'))
  assert.ok(proseOnly.includes('  \\# indented heading'))
  assert.ok(proseOnly.includes('   &gt; indented quote'))
  assert.ok(proseOnly.includes('  \\- indented list'))
  assert.ok(proseOnly.includes('   \\```fence'))
  assert.ok(proseOnly.includes('  \\~~~tilde'))
  assert.ok(proseOnly.includes('   \\| fake | table |'))
})

test('renderer neutralizes 0-3 space indented list and task markers while keeping prose readable', async () => {
  const manifest = await loadManifest()
  const rendered = renderStructuredSections({
    findings: [{
      ruleId: '19-8',
      title: 'list marker escaping',
      body: [
        '* bullet',
        '+ plus bullet',
        '1. ordered',
        '12) ordered paren',
        '- [ ] task item',
        ' - [x] nested task item',
        '  * two-space bullet',
        '   + three-space plus',
        '   1. three-space ordered',
        '   12) three-space ordered paren',
      ].join('\n'),
      impact: 'low',
      confidence: 'high',
      location: {
        kind: 'verified',
        path: 'src/escape.ts',
        line: 5,
        quote: 'const items = input',
      },
      sourceLabels: ['module:19-intent'],
    }],
    openQuestions: [],
  }, manifest)

  const proseOnly = rendered.findings
  for (const inertLine of [
    '\\* bullet',
    '\\+ plus bullet',
    '\\1. ordered',
    '12\\) ordered paren',
    '\\- \\[ \\] task item',
    ' \\- \\[x\\] nested task item',
    '  \\* two-space bullet',
    '   \\+ three-space plus',
    '   \\1. three-space ordered',
    '   12\\) three-space ordered paren',
  ]) {
    assert.ok(proseOnly.includes(inertLine))
  }
})

test('runtime interfaces expose no legacy ownership registry surface', async () => {
  const manifest = await loadManifest()
  const state = createPassState({ sourceLabel: 'module:09-code-quality', manifest })
  assert.equal('ownerRegistry' in state, false)
  assert.equal('structuredOwners' in state, false)
})
