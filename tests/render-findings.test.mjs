import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateCandidates, loadVocabulary } from '../scripts/render-findings.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'render-findings.mjs')
const RULES = join(ROOT, 'review-rules')

const ok = extra => ({
  candidateId: '04-3#1', ruleId: '04-3', impact: 'high', confidence: 'high',
  category: 'data-loss', eligibility: 'SKIP-VERIFY', route: 'none',
  location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'const a = 1' },
  content: { title: '제목', body: '본문' },
  ...extra,
})

test('멀쩡한 후보는 사유를 내지 않는다', () => {
  assert.deepEqual(validateCandidates([ok()]), [])
})

test('모르는 impact는 거부한다 — 등급을 만들 수 없다', () => {
  const [why] = validateCandidates([ok({ impact: 'medium' })])
  assert.match(why, /04-3#1/)
  assert.match(why, /impact/)
})

test('모르는 confidence는 거부한다', () => {
  assert.match(validateCandidates([ok({ confidence: 'maybe' })])[0], /confidence/)
})

test('모르는 location.kind는 거부한다', () => {
  assert.match(validateCandidates([ok({ location: { kind: 'guessed' } })])[0], /location\.kind/)
})

test('필수 필드가 없으면 거부한다', () => {
  const broken = ok()
  delete broken.content.body
  assert.match(validateCandidates([broken])[0], /body/)
})

test('producer가 금지된 severity를 넣으면 거부한다', () => {
  assert.match(validateCandidates([ok({ severity: '🔴' })])[0], /severity/)
})

test('여러 건이면 전부 나열한다', () => {
  const why = validateCandidates([ok({ impact: 'medium' }), ok({ candidateId: '07-1#1', confidence: 'x' })])
  assert.equal(why.length, 2)
})

// -------------------------------------------------------------- loadVocabulary
//
// 실제 계약 파일이 categoryLabels를 잃는 사고는 리뷰에서 안 걸린다 — Markdown은
// 그대로 보이고, 깨지는 건 JSON 블록 안 키 하나뿐이다. 이 가드가 실제로
// 실행되는지를 테스트가 확인하지 않으면, 가드는 있어도 아무도 그게 살아있는지
// 모른다.

// 저장소의 진짜 workflow-contract.md를 건드리지 않고, impact.categoryLabels가
// 없는 상황만 흉내 낸 임시 rules 디렉터리를 만든다.
const writeBrokenRulesDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-rules-'))
  const contract = [
    '<!-- REVIEW_RESULT_CONTRACT_V1:BEGIN -->',
    '```json',
    JSON.stringify({ contractName: 'REVIEW_RESULT_CONTRACT_V1', schemaVersion: 1, impact: {} }),
    '```',
    '<!-- REVIEW_RESULT_CONTRACT_V1:END -->',
    '',
    '<!-- CROSS_VERIFICATION_RENDER_TOKENS:BEGIN -->',
    '```json',
    JSON.stringify({ label: '교차검증', tokens: {} }),
    '```',
    '<!-- CROSS_VERIFICATION_RENDER_TOKENS:END -->',
  ].join('\n')
  writeFileSync(join(dir, 'workflow-contract.md'), contract, 'utf8')
  return dir
}

test('impact.categoryLabels가 없으면 loadVocabulary가 거부한다', () => {
  const dir = writeBrokenRulesDir()
  const result = loadVocabulary(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.ok(result.error, 'error가 없다')
  assert.match(result.error, /categoryLabels/)
})

test('실제 review-rules에서는 두 어휘 맵이 모두 채워진다', () => {
  const result = loadVocabulary(RULES)
  assert.ok(result.value, `error가 나왔다: ${result.error}`)
  assert.ok(Object.keys(result.value.categoryLabels).length > 0)
  assert.ok(Object.keys(result.value.crossVerification).length > 0)
  // 실제 계약에 있는 카테고리 하나를 골라 라벨이 한글인지 확인한다 — 객체가
  // 비어있지 않다는 것만으론 raw enum이 그대로 새어나오지 않는다는 걸 보장 못 한다.
  assert.equal(result.value.categoryLabels['data-loss'], '데이터 손상·유실')
})

// -------------------------------------------------------------- CLI

const runWith = (candidates, args = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase', 'active-deletion',
    '--workflow', 'full', ...args,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  return out
}

test('거부하면 exit 2이고 아무것도 그리지 않는다', () => {
  const out = runWith([ok({ impact: 'medium' })])
  assert.equal(out.status, 2)
  assert.equal(out.stdout, '')
  assert.match(out.stderr, /04-3#1/)
})

test('--phase가 없으면 거부한다 — 기본값을 두지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  const out = spawnSync(process.execPath, [SCRIPT, '--input', input, '--rules', RULES, '--workflow', 'full'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--phase/)
})

test('--workflow가 없으면 거부한다 — 섹션 목록을 만들 수 없다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase', 'active-deletion',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--workflow/)
})

test('멀쩡한 후보는 exit 0으로 끝까지 간다 — render/loadModuleSections 스텁 상태에서는 빈 출력이 맞다', () => {
  // 이 테스트가 없으면 flag 파싱 → 입력 로드 → validateCandidates →
  // loadVocabulary → loadModuleSections으로 이어지는 정상 경로 전체가 CI에서
  // 한 번도 실행되지 않는다. loadModuleSections 스텁이 없던 시점에는 바로 이
  // 경로에서 ReferenceError가 났었는데, 거부 테스트만으로는 그 결함을 못 잡았다.
  const out = runWith([ok()])
  assert.equal(out.status, 0)
  assert.equal(out.stdout, '')
  assert.equal(out.stderr, '')
})
