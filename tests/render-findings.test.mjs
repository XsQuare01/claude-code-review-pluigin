import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  validateCandidates, loadVocabulary, renderFinding, severityOf, escapeProse, codeSpan,
  withInstanceNumbers, labelFor, dispositionOf, compareCandidates, loadModuleSections, loadSpecialistPasses, render,
} from '../scripts/render-findings.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'render-findings.mjs')
const RULES = join(ROOT, 'review-rules')

// renderFinding 테스트 전용 어휘 — loadVocabulary가 실제 계약에서 읽어오는
// { categoryLabels, crossVerification } 모양만 흉내 낸 최소 fixture다. 실제
// 계약 파일을 읽는 경로는 위 loadVocabulary 테스트가 이미 검증한다.
const VOCAB = {
  categoryLabels: { 'data-loss': '데이터 손상·유실', 'user-malfunction': '사용자에게 보이는 오동작 또는 사용 불가' },
  crossVerification: { upheld: '유지', 'not-eligible': '대상 아님' },
}

const ok = extra => ({
  candidateId: '04-3#1', ruleId: '04-3', impact: 'high', confidence: 'high',
  category: 'data-loss', eligibility: 'SKIP-VERIFY', route: 'none',
  location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'const a = 1' },
  // `prepare-verification.mjs`가 이 위치를 실제 트리에 맞춰 본 결과다.
  // 렌더러가 요구하는 필드이며, `location`을 갈아끼우는 테스트는 이 값도
  // 같이 갈아끼워야 한다 — `unverified`에는 `not-applicable`이 짝이다.
  locationCheck: 'location-ok',
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

// PR #85 리뷰 지적 5 — 계약(REVIEW_RESULT_CONTRACT_V1의 location.variants)은
// endLine에 `positive-and-gte-line`(verified) / `positive-and-gte-lineBefore`
// (deleted) 제약을 건다. endLine이 시작 줄보다 작으면 위치 줄이 거꾸로
// 뒤집힌 범위(`10-5`)로 그려지는데, 이 계약 위반을 validateCandidates가
// 여태 잡지 않았다 — 등급뿐 아니라 위치도 "만들 수 없는" 입력이다.
test('verified location의 endLine이 line보다 작으면 거부한다', () => {
  const [why] = validateCandidates([ok({ location: { kind: 'verified', path: 'src/a.ts', line: 10, endLine: 5, quote: 'x' } })])
  assert.match(why, /endLine/)
})

test('deleted location의 endLine이 lineBefore보다 작으면 거부한다', () => {
  const [why] = validateCandidates([ok({ location: { kind: 'deleted', path: 'src/a.ts', lineBefore: 10, endLine: 5, quote: 'x' } })])
  assert.match(why, /endLine/)
})

test('endLine이 시작 줄과 같거나 크면 거부하지 않는다', () => {
  assert.deepEqual(validateCandidates([ok({ location: { kind: 'verified', path: 'src/a.ts', line: 10, endLine: 10, quote: 'x' } })]), [])
  assert.deepEqual(validateCandidates([ok({ location: { kind: 'verified', path: 'src/a.ts', line: 10, endLine: 12, quote: 'x' } })]), [])
})

// 2026-09-28 실행 리뷰 — `locationCheck`는 렌더러의 입력(routed.json)에 이미
// 들어 있었는데 렌더러가 보지 않았다. 없으면 "확인 안 함"이 아니라 "확인했는지
// 알 수 없다"이므로, 기본값으로 흘려보내면 확인되지 않은 주장이 확인된 위치처럼
// 찍힌다.
test('locationCheck가 없으면 거부한다 — 확인했는지 알 수 없다', () => {
  const candidate = ok()
  delete candidate.locationCheck
  const [why] = validateCandidates([candidate])
  assert.match(why, /locationCheck/)
})

test('locationCheck가 닫힌 목록 밖이면 거부한다', () => {
  const [why] = validateCandidates([ok({ locationCheck: 'maybe' })])
  assert.match(why, /locationCheck/)
})

// `not-applicable`은 checkLocation이 `unverified`에만 주는 값이다. 맞춰 볼 수
// 있는 위치에 이 값이 붙으면 검사를 요구한 의미가 그대로 사라진다.
test('verified 위치에 not-applicable이 붙으면 거부한다', () => {
  const [why] = validateCandidates([ok({ locationCheck: 'not-applicable' })])
  assert.match(why, /not-applicable/)
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

// 잘못된 `--rules`(오타·존재하지 않는 경로)는 사용자가 가장 저지르기 쉬운
// 실수다. loadModuleSections/loadSpecialistPasses처럼 sibling loader는 이미
// readFileSync를 감싸 { error }를 낸다 — loadVocabulary만 감싸지 않아 raw
// ENOENT를 그대로 던지면 CLI가 exit 2 대신 stack trace와 exit 1로 죽는다.
// 2026-09-28 라운드 리뷰 지적 2 — categoryLabels는 맵의 존재만 봐도 됐다.
// 라벨이 빠지면 원시 enum이 그려져 리포트에 흔적이 남기 때문이다. 교차검증
// 토큰은 다르다. 키 하나가 빠지면 라벨이 undefined가 되고 축 줄이 통째로
// 사라져, 검증을 끈 실행이 "교차검증 축 자체가 없는 워크플로우"와 구분되지
// 않는다. 그 상태로도 렌더는 성공한다.
const writeTokenRulesDir = tokens => {
  const dir = mkdtempSync(join(tmpdir(), 'render-rules-'))
  writeFileSync(join(dir, 'workflow-contract.md'), [
    '<!-- REVIEW_RESULT_CONTRACT_V1:BEGIN -->',
    '```json',
    JSON.stringify({ impact: { categoryLabels: { 'data-loss': '데이터 손상·유실' } } }),
    '```',
    '<!-- REVIEW_RESULT_CONTRACT_V1:END -->',
    '',
    '<!-- CROSS_VERIFICATION_RENDER_TOKENS:BEGIN -->',
    '```json',
    JSON.stringify({ label: '교차검증', tokens }),
    '```',
    '<!-- CROSS_VERIFICATION_RENDER_TOKENS:END -->',
  ].join('\n'), 'utf8')
  return dir
}

const ALL_TOKENS = {
  upheld: '유지',
  'rejected-shadow': '반박됨 — 관찰 중',
  'rejected-other': '반박 시도 — 분류 밖',
  'scope-open': '범위 미확정',
  'verification-unavailable': '검증 실패',
  'not-eligible': '대상 아님',
  'verification-disabled': '꺼짐',
}

test('교차검증 토큰이 하나라도 빠지면 loadVocabulary가 거부한다', () => {
  const { 'verification-disabled': _dropped, ...partial } = ALL_TOKENS
  const dir = writeTokenRulesDir(partial)
  const result = loadVocabulary(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.ok(result.error, '키가 빠졌는데 통과했다 — 축 줄이 조용히 사라진다')
  assert.match(result.error, /verification-disabled/)
})

test('교차검증 토큰이 빈 문자열이어도 거부한다', () => {
  const dir = writeTokenRulesDir({ ...ALL_TOKENS, 'scope-open': '' })
  const result = loadVocabulary(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.ok(result.error, '빈 문자열이 통과했다')
  assert.match(result.error, /scope-open/)
})

test('교차검증 토큰이 전부 있으면 통과한다', () => {
  const dir = writeTokenRulesDir(ALL_TOKENS)
  const result = loadVocabulary(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.ok(!result.error, `거부하면 안 되는데 거부했다: ${result.error}`)
  assert.equal(result.value.crossVerification['verification-disabled'], '꺼짐')
})

test('workflow-contract.md를 읽지 못하면 거부한다 — loadVocabulary', () => {
  const result = loadVocabulary(join(tmpdir(), 'no-such-rules-dir'))
  assert.ok(result.error, 'error가 없다')
  assert.match(result.error, /workflow-contract\.md/)
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

// -------------------------------------------------------------- renderFinding
//
// 정렬·묶음은 Task 6의 몫이다. 여기서는 finding 한 건이 헤딩·축 줄·위치
// 줄·슬롯으로 정확히 갈라지는지만 본다.

test('등급은 영향 × 확신에서 나온다', () => {
  assert.equal(severityOf('high', 'high'), '🔴')
  assert.equal(severityOf('high', 'low'), '🟡')
  assert.equal(severityOf('low', 'high'), '🟡')
  assert.equal(severityOf('low', 'low'), '🔵')
})

test('verified 위치는 경로와 인용을 낸다', () => {
  const md = renderFinding(ok(), { label: '유지', vocabulary: VOCAB })
  assert.equal(md, [
    '#### 🔴 `04-3` 제목',
    '영향: 높음 (데이터 손상·유실) · 확신: 높음 · 교차검증: `유지`',
    '`src/a.ts:1` — `const a = 1`',
    '본문: 본문',
  ].join('\n'))
})

// PR #85 리뷰 지적 3 — dedup provenance는 exactDedup의 seen.sources까지만
// 살아있고 renderer는 출처 패스 줄 자체를 낸 적이 없었다(이전 리포트에는
// 있었던 줄이라 이는 회귀다). candidate.source/sources가 있으면 축 줄
// 바로 다음, 위치 줄보다 앞에 낸다 — 실제 리포트(profile-slim-export
// 2026-09-18 등)에서 이 줄이 있던 자리와 같다.
test('candidate.source가 있으면 출처 패스 한 줄을 낸다', () => {
  const md = renderFinding(ok({ source: '일반' }), { label: '유지', vocabulary: VOCAB })
  assert.equal(md, [
    '#### 🔴 `04-3` 제목',
    '영향: 높음 (데이터 손상·유실) · 확신: 높음 · 교차검증: `유지`',
    '출처 패스: 일반',
    '`src/a.ts:1` — `const a = 1`',
    '본문: 본문',
  ].join('\n'))
})

test('병합된 finding은 출처 패스에 기여한 라벨을 모두 낸다', () => {
  const md = renderFinding(ok({ source: '일반', sources: ['일반', 'Props'] }), { label: '유지', vocabulary: VOCAB })
  assert.match(md, /^출처 패스: 일반, Props$/m)
})

test('source가 없으면 출처 패스 줄 자체를 내지 않는다', () => {
  const md = renderFinding(ok(), { label: '유지', vocabulary: VOCAB })
  assert.doesNotMatch(md, /출처 패스/)
})

// PR #85 리뷰 지적 4 — `출처 패스`는 producer content(escapeProse)나 code
// slot(codeSpan)을 거치지 않는 유일한 렌더 값이었다. source는 producer가
// 아니라 오케스트레이터가 붙이는 값이라고 해도, 그 값 자체가 신뢰된
// 문자열이라는 보장은 없다 — envelope의 source도 결국 문자열이고, 이 슬롯만
// escape를 건너뛸 이유가 없다. `##`로 시작하면 heading을 새로 열어 이
// 브랜치가 세 라운드에 걸쳐 막아온 것과 같은 구멍이 된다.
test('source에 Markdown 제어 문자가 있으면 이스케이프한다', () => {
  const md = renderFinding(ok({ source: '## 해킹' }), { label: '유지', vocabulary: VOCAB })
  assert.match(md, /출처 패스: \\#\\# 해킹/)
  assert.doesNotMatch(md, /^## 해킹/m, '이스케이프되지 않은 헤딩이 새 줄을 열었다')
})

test('영향이 낮으면 괄호를 붙이지 않는다', () => {
  const md = renderFinding(ok({ impact: 'low', category: undefined }), { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /^#### 🟡 /)
  assert.match(md, /영향: 낮음 · 확신: 높음/)
})

test('deleted 위치는 lineBefore를 쓴다', () => {
  const md = renderFinding(ok({ location: { kind: 'deleted', path: 'src/old.ts', lineBefore: 7, quote: 'gone()' } }),
    { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /`src\/old\.ts:7` — `gone\(\)`/)
})

// 계약 스키마(REVIEW_RESULT_CONTRACT_V1의 location.variants)는 verified·
// deleted 모두에 선택적 endLine을 허용한다. renderer가 start만 쓰면 여러
// 줄짜리 인용의 끝이 리포트에서 사라진다 — `42-45`가 `42`로 접힌다.
test('verified 위치에 endLine이 있고 시작과 다르면 범위로 낸다', () => {
  const md = renderFinding(ok({ location: { kind: 'verified', path: 'src/a.ts', line: 42, endLine: 45, quote: 'x' } }),
    { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /`src\/a\.ts:42-45` — `x`/)
})

test('deleted 위치에 endLine이 있고 시작과 다르면 범위로 낸다', () => {
  const md = renderFinding(
    ok({ location: { kind: 'deleted', path: 'src/old.ts', lineBefore: 7, endLine: 9, quote: 'gone()' } }),
    { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /`src\/old\.ts:7-9` — `gone\(\)`/)
})

test('endLine이 시작 줄과 같으면 범위로 부풀리지 않는다', () => {
  const md = renderFinding(ok({ location: { kind: 'verified', path: 'src/a.ts', line: 1, endLine: 1, quote: 'const a = 1' } }),
    { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /`src\/a\.ts:1` — `const a = 1`/)
  assert.doesNotMatch(md, /:1-1/)
})

test('unverified 위치는 사유 줄이 대신한다', () => {
  const md = renderFinding(ok({ location: { kind: 'unverified', reason: '경로를 찾지 못했습니다.' }, locationCheck: 'not-applicable' }),
    { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /위치 미확인 사유: 경로를 찾지 못했습니다\./)
})

// 2026-09-28 실행 — 후보 5건 중 3건은 주장된 경로가 HEAD에도 merge-base에도
// 없었고, 1건은 인용이 실제 내용과 달랐다. 그 사실을 `prepare-verification`이
// 이미 계산해 뒀는데 렌더러가 보지 않으면 없는 파일의 줄 번호가 사실처럼
// 찍힌다 — 00-10이 🔴로 막는 "틀린 위치를 가리키는 지적".
test('읽지 못한 경로는 확인된 위치처럼 그리지 않는다', () => {
  const md = renderFinding(
    ok({ location: { kind: 'verified', path: 'src/gone.ts', line: 9, endLine: 10, quote: 'precisionValue: 0.3,' },
         locationCheck: 'location-unresolvable' }),
    { label: '검증 실패', vocabulary: VOCAB })
  assert.match(md, /위치 확인 실패: `src\/gone\.ts:9-10` — 리뷰 대상 트리에서 그 경로를 읽지 못했습니다/)
  // 인용을 다시 찍지 않는다 — 그 자리에 없다는 것이 지금 말하는 사실인데,
  // 같은 줄에 한 번 더 찍으면 읽는 사람이 그것을 코드로 읽는다.
  assert.doesNotMatch(md, /precisionValue/)
})

test('인용 불일치는 실제로 그 자리에 있던 것을 함께 낸다', () => {
  const md = renderFinding(
    ok({ location: { kind: 'verified', path: 'src/shared/api/index.ts', line: 1, quote: "export type { CameraDevice } from './types'" },
         locationCheck: 'location-mismatch', observed: '// shared/api 공개 API' }),
    { label: '반박됨', vocabulary: VOCAB })
  assert.match(md, /위치 확인 실패: `src\/shared\/api\/index\.ts:1` — 인용과 실제 내용이 다릅니다 · 실제 `\/\/ shared\/api 공개 API`/)
  assert.doesNotMatch(md, /CameraDevice/)
})

test('인용 불일치인데 읽은 내용이 없으면 실제 칸을 비워 두지 않는다', () => {
  const md = renderFinding(ok({ locationCheck: 'location-mismatch', observed: null }),
    { label: '반박됨', vocabulary: VOCAB })
  assert.match(md, /위치 확인 실패: `src\/a\.ts:1` — 인용과 실제 내용이 다릅니다$/m)
  assert.doesNotMatch(md, /실제 ``/)
})

test('있는 슬롯만 각자 한 줄로 낸다', () => {
  const md = renderFinding(ok({ content: { title: '제목', body: 'B', recommendation: 'R' } }),
    { label: '대상 아님', vocabulary: VOCAB })
  const lines = md.split('\n')
  assert.deepEqual(lines.slice(3), ['본문: B', '개선 제안: R'])
})

// 리뷰 Important — 슬롯 두 개짜리 순서 테스트(위)와 낮은 확신 사유 테스트(아래
// 확신이 낮으면 사유 줄을 낸다)는 각각 슬롯을 둘만 켠다. `recommendation`과
// `reason`이 서로 바뀌어도 두 테스트 모두 통과한다 — SLOTS 배열의 순서 자체를
// 검증하려면 네 슬롯을 동시에 켜고 `lines.slice(...)`로 정확한 순서를 봐야 한다.
test('네 슬롯이 모두 있으면 body·evidence·recommendation·reason 순서를 지킨다', () => {
  const md = renderFinding(ok({
    confidence: 'low',
    content: { title: '제목', body: 'B', evidence: 'E', recommendation: 'R', reason: 'Y' },
  }), { label: undefined, vocabulary: VOCAB })
  const lines = md.split('\n')
  assert.deepEqual(lines.slice(3), ['본문: B', '근거: E', '개선 제안: R', '확신 낮음 사유: Y'])
})

test('확신이 낮으면 사유 줄을 낸다', () => {
  const md = renderFinding(ok({ confidence: 'low', content: { title: '제목', body: 'B', reason: '추정' } }),
    { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /확신 낮음 사유: 추정/)
})

test('교차검증 축이 없으면 축 줄에서 뺀다', () => {
  // `undefined`는 "축 없음"이다. `labelFor`의 `null`("렌더링하지 않음")과 다르며,
  // 후자는 `render`가 걸러내므로 여기까지 오지 않는다.
  const md = renderFinding(ok(), { label: undefined, vocabulary: VOCAB })
  assert.match(md, /영향: 높음 \(데이터 손상·유실\) · 확신: 높음\n/)
  assert.doesNotMatch(md, /교차검증/)
})

test('산문이 Markdown 구조를 만들지 못하게 막는다', () => {
  assert.equal(escapeProse('# 헤딩'), '\\# 헤딩')
  assert.equal(escapeProse('a | b'), 'a \\| b')
  assert.equal(escapeProse('```fence'), '\\`\\`\\`fence')
  // 대괄호가 문자 참조가 되면 `[텍스트](url)` 링크가 성립하지 않는다(아래 `수식 구분자` 참고).
  assert.equal(escapeProse('[링크](http://x)'), '&#91;링크&#93;(http://x)')
  assert.equal(escapeProse('> 인용'), '\\> 인용')
})

// 리뷰 Critical 1 — 계약은 raw HTML을 헤딩/펜스/표/링크/인용과 별개의 필수
// escape 대상으로 명시한다. 기존 문자 집합은 그 다섯과만 겹쳤고 `<`는 없었다.
// `>`만 escape하면 여는 델리미터(`<script>`)는 그대로 열려 있고, CommonMark는
// 여는 델리미터만으로 HTML 블록/인라인 HTML을 인식하므로 보호가 안 된다.
test('산문의 raw HTML 여는 델리미터(`<`)를 escape한다', () => {
  assert.equal(escapeProse('<script>alert(1)</script>'), '\\<script\\>alert(1)\\</script\\>')
})

// 리뷰 Critical 2 — 이 태스크가 막아야 했던 결함(슬롯이 한 칸으로 합쳐지는 것)의
// 거울상이다. `본문: ` 라벨 접두어는 producer 텍스트가 0번 컬럼에서 시작하는
// 것만 막을 뿐, 텍스트 안에 박힌 개행이 그 뒤 문자를 다시 0번 컬럼으로 되돌리는
// 것은 못 막는다 — `<div>`뿐 아니라 `---`(thematic break/setext 헤딩)나
// `1. `(리스트 항목)도 같은 경로로 새는데, 그 문자들은 escape 대상 집합에
// 없다. substring 매치는 이 결함을 못 잡는다 — 줄이 샌 채로도 부분 문자열은
// 그대로 들어있기 때문이다. 그래서 반드시 줄 개수를 센다.
test('산문 안의 개행은 한 칸으로 접혀 슬롯이 여러 물리 줄로 새지 않는다', () => {
  const md = renderFinding(ok({ content: { title: '제목', body: 'body line1\n<div>\ninjected' } }),
    { label: undefined, vocabulary: VOCAB })
  const lines = md.split('\n')
  // 헤딩 · 축 줄 · 위치 줄 · 본문 슬롯 — 딱 네 줄이어야 한다. 개행이 escape
  // 되지 않으면 본문 슬롯 하나가 세 줄로 새서 총 6줄이 나온다.
  assert.equal(lines.length, 4, `본문 슬롯이 여러 줄로 샜다: ${JSON.stringify(lines)}`)
  assert.equal(lines[3], '본문: body line1 \\<div\\> injected')
})

test('인용의 backtick과 충돌하지 않는 delimiter를 고른다', () => {
  assert.equal(codeSpan('const a = 1'), '`const a = 1`')
  assert.equal(codeSpan('a `b` c'), '`` a `b` c ``')
  assert.equal(codeSpan('``x``'), '``` ``x`` ```')
})

// 리뷰 라운드 2 — escapeProse에서 고친 것과 같은 종류의 결함이 codeSpan에도
// 있었다. `location.path`/`location.quote`는 producer가 채우는 신뢰하지 않는
// 값인데, 그 안의 개행을 codeSpan이 막지 않았다. 단순 개행은 위치 줄을 여러
// 물리 줄로 새게 하고, 빈 줄(개행 두 번)은 그보다 더 나쁘다 — CommonMark의
// code span은 빈 줄을 담을 수 없어 여는 backtick과 짝이 되는 닫는 backtick이
// 없어지고, 그 지점부터 리포트 구조 전체가 깨진다.
test('quote/path에 박힌 개행은 code span 안에서 한 칸으로 접힌다', () => {
  assert.equal(codeSpan('a\nb'), '`a b`')
})

test('quote 안의 빈 줄(개행 두 번)도 한 칸으로 접힌다 — 이건 스팬을 반영하는 게 아니라 깨는 경우다', () => {
  assert.equal(codeSpan('a\n\nb'), '`a b`')
})

// 위 둘은 codeSpan 단위 테스트라 delimiter 선택 자체는 건드리지 않는다.
// renderFinding까지 내려가서 실제 위치 줄이 여전히 한 줄인지, 그리고
// escapeProse 라운드에서 썼던 것과 같은 방식(line count)으로 확인한다 —
// substring 매치는 줄이 샌 채로도 통과하기 때문이다.
test('quote 안의 빈 줄이 있어도 위치 줄이 한 줄로 남고 finding 구조가 깨지지 않는다', () => {
  const md = renderFinding(ok({ location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'a\n\nb' } }),
    { label: undefined, vocabulary: VOCAB })
  const lines = md.split('\n')
  assert.equal(lines.length, 4, `위치 줄이 여러 줄로 샜다: ${JSON.stringify(lines)}`)
  assert.equal(lines[2], '`src/a.ts:1` — `a b`')
})

// path도 같은 codeSpan을 타므로 값싼 확인 하나를 더 둔다.
test('path에 박힌 개행도 위치 줄이 한 줄로 남게 접힌다', () => {
  const md = renderFinding(ok({ location: { kind: 'verified', path: 'src/a.ts\nx', line: 1, quote: 'const a = 1' } }),
    { label: undefined, vocabulary: VOCAB })
  const lines = md.split('\n')
  assert.equal(lines.length, 4, `위치 줄이 여러 줄로 샜다: ${JSON.stringify(lines)}`)
  assert.equal(lines[2], '`src/a.ts x:1` — `const a = 1`')
})

// 리뷰 라운드 3 — round 2에서 codeSpan에 넣은 `\s+` 전체 공백 접기 + trim은
// 개행 결함은 고쳤지만 다른 것을 깼다. quote는 실제 소스 한 줄이고, 들여쓰기는
// 그 줄이 코드에서 얼마나 깊이 있는지를 말해주는 내용이다. escapeProse가
// 다루는 산문은 공백의 양이 의미를 안 갖지만 quote는 다르다 — 그래서
// 컨트롤러가 escapeProse의 처방을 그대로 재사용한 판단을 승인하지 않고
// codeSpan만 되돌리라고 판정했다. 개행(과 개행 연속인 빈 줄)만 한 칸으로
// 바꾸고, 그 외 공백(들여쓰기 포함)과 trim은 손대지 않는다.
test('quote의 들여쓰기는 codeSpan 안에서 그대로 보존된다 — 공백의 양 자체가 내용이다', () => {
  assert.equal(codeSpan('    if (pending) return'), '`    if (pending) return`')
})

test('들여쓰기가 있는 quote로 실제 위치 줄을 그려도 들여쓰기가 살아남는다', () => {
  const md = renderFinding(ok({ location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: '    if (pending) return' } }),
    { label: undefined, vocabulary: VOCAB })
  const lines = md.split('\n')
  assert.equal(lines.length, 4, `위치 줄이 여러 줄로 샜다: ${JSON.stringify(lines)}`)
  assert.equal(lines[2], '`src/a.ts:1` — `    if (pending) return`')
})

// -------------------------------------------------------------- CLI

const runWith = (candidates, args = []) => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verification-state', 'disabled', ...args,
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

test('--phase-high가 없으면 거부한다 — 기본값을 두지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-low', 'active-deletion', '--workflow', 'full',
    '--verification-state', 'disabled',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--phase-high/)
})

test('--phase-low가 없으면 거부한다 — high만으로는 low의 phase를 정할 수 없다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--workflow', 'full',
    '--verification-state', 'disabled',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--phase-low/)
})

test('--workflow가 없으면 거부한다 — 섹션 목록을 만들 수 없다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--verification-state', 'disabled',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--workflow/)
})

test('--verification-state가 없으면 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--verification-state/)
})

test('--verification-state가 ran/disabled가 아니면 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verification-state', 'off',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--verification-state/)
})

// PR #85 리뷰 지적 5 — `--verification-state disabled`는 "이 실행은 검증
// 판정이 없다"는 선언이다. 그런데도 `--verdicts`를 함께 주면 CLI는 그 파일을
// 조용히 무시했다 — 호출자가 모순된 두 신호를 보냈는데 아무 쪽도 듣지
// 못했다는 사실을 알 수 없었다. 이제는 명시적으로 거부한다.
test('--verdicts와 --verification-state disabled를 함께 주면 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  const verdictsPath = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()] }), 'utf8')
  writeFileSync(verdictsPath, JSON.stringify({ verdicts: [] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verification-state', 'disabled', '--verdicts', verdictsPath,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--verdicts/)
  assert.match(out.stderr, /disabled/)
})

test('멀쩡한 후보는 exit 0이고 실제 모듈 리포트를 낸다', () => {
  // 이 테스트가 없으면 flag 파싱 → 입력 로드 → validateCandidates →
  // loadVocabulary → loadModuleSections → loadSpecialistPasses로 이어지는
  // 정상 경로 전체가 CI에서 한 번도 실행되지 않는다. render/loadModuleSections이
  // 스텁이던 시점에는 이 경로가 빈 출력으로 "통과"했는데, 거부 테스트만으로는
  // 그 결함을 못 잡았다. --workflow full의 실제 catalog.json으로 돌리므로
  // 04번 모듈 제목은 이 저장소의 진짜 값("상태 관리 & 사이드이펙트")이어야 한다.
  const out = runWith([ok()])
  assert.equal(out.status, 0)
  assert.equal(out.stderr, '')
  assert.match(out.stdout, /^## 상세 지적\n/)
  assert.match(out.stdout, /### 04 상태 관리 & 사이드이펙트\n/)
  assert.match(out.stdout, /#### 🔴 `04-3` 제목/)
  // 특수 패스 후보가 없어도 그 절은 나오고, 세 패스가 각자 "지적 없음."을 말한다.
  assert.match(out.stdout, /## 특수 패스\n\n### Props\n\n지적 없음\.\n\n### 수학\n\n지적 없음\.\n\n### 예외\n\n지적 없음\./)
})

test('CLI가 특수 패스 규칙 ID 접두를 실제로 예외 섹션으로 묶는다', () => {
  // loadModuleSections와 loadSpecialistPasses를 CLI가 합쳐 sections로 넘기는
  // 배선 자체를 검증한다 — render 단위 테스트는 손으로 만든 SECTIONS를 쓰므로
  // 이 배선이 실제로 맞는지는 CLI를 직접 돌려야만 드러난다.
  const out = runWith([ok({
    candidateId: 'EX-1#1', ruleId: 'EX-1', impact: 'low', category: undefined,
    content: { title: '예외 통합 테스트', body: 'B' },
  })])
  assert.equal(out.status, 0)
  assert.equal(out.stderr, '')
  // 예외 절 바로 아래에 그 지적이 온다 — 앞의 Props·수학은 지적 없음으로 남는다.
  assert.match(out.stdout, /## 특수 패스\n\n### Props\n\n지적 없음\.\n\n### 수학\n\n지적 없음\.\n\n### 예외\n\n#### /)
  assert.match(out.stdout, /`EX-1` 예외 통합 테스트/)
})

// PR #85 리뷰 지적 2a — CLI 전체 경로로도 확인한다. render 단위 테스트는
// 이미 markdown/movedToOpenQuestions 분리를 보지만, stdout·stderr로 실제
// 나뉘어 나오는지는 CLI를 직접 돌려야만 드러난다.
test('CLI가 needs-context finding을 상세 지적에서 빼고 stderr에 이동 알림을 낸다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  const verdictsPath = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify({
    candidates: [ok({
      candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY',
      content: { title: '범위 미확정 CLI 지적', body: 'B' },
    })],
  }), 'utf8')
  writeFileSync(verdictsPath, JSON.stringify({ verdicts: [{ candidateId: '04-3#1', disposition: 'needs-context' }] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verdicts', verdictsPath, '--verification-state', 'ran',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 0)
  assert.doesNotMatch(out.stdout, /범위 미확정 CLI 지적/, '상세 지적(stdout)에 그대로 남아있다')
  assert.match(out.stderr, /04-3/, 'stderr 알림에 ruleId가 없다')
  assert.match(out.stderr, /범위 미확정 CLI 지적/, 'stderr 알림에 title이 없다')
})

// 2026-09-28 라운드 리뷰 지적 1 — CLI 전체 경로에서 verdict 파일의 reason이
// stderr 알림까지 살아 오는지 본다. 판정 파일을 읽는 자리는 이 loader 하나뿐이라,
// 거기서 버리면 뒤에서 되찾을 방법이 없다. `정확히 한 번`까지 보는 이유는
// 같은 값을 두 자리에 찍으면 옮겨 적는 쪽이 중복을 만들기 때문이다.
test('CLI가 needs-context의 reason·출처·위치·본문을 stderr로 넘긴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  const verdictsPath = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify({
    candidates: [ok({
      candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY', source: '04-state',
      content: { title: '범위 미확정 CLI 지적', body: '본문 문장', evidence: '근거 문장' },
    })],
  }), 'utf8')
  writeFileSync(verdictsPath, JSON.stringify({
    verdicts: [{ candidateId: '04-3#1', disposition: 'needs-context', reason: '호출자 확인 필요' }],
  }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verdicts', verdictsPath, '--verification-state', 'ran',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 0)
  const once = (text, needle) => text.split(needle).length - 1
  assert.equal(once(out.stderr, '추가 확인 이유: 호출자 확인 필요'), 1, 'verifier의 reason이 정확히 한 번 나오지 않는다')
  assert.equal(once(out.stderr, '출처 패스: 04-state'), 1, '출처 패스가 정확히 한 번 나오지 않는다')
  assert.equal(once(out.stderr, '본문: 본문 문장'), 1, '본문이 정확히 한 번 나오지 않는다')
  assert.equal(once(out.stderr, '근거: 근거 문장'), 1, '근거가 정확히 한 번 나오지 않는다')
  assert.match(out.stderr, /`src\/a\.ts:1` — `const a = 1`/, '위치 줄이 없다')
  // stdout은 두 섹션 자리에 그대로 붙일 Markdown 전용이다 — 옮겨 적을 재료가
  // 거기 섞이면 상세 지적에 없는 finding의 본문이 그 자리에 들어간다.
  assert.doesNotMatch(out.stdout, /호출자 확인 필요|본문 문장/, 'stdout에 이동 항목이 샜다')
})

// verifier가 계약을 어겨 reason 없이 needs-context를 내면, 알림이 조용히
// 빈 칸으로 나가지 않고 그 사실을 적는다 — 옮겨 적는 쪽이 "사유가 없다"와
// "사유를 옮기지 못했다"를 구분할 수 있어야 한다.
test('CLI는 reason 없는 needs-context를 빈 칸이 아니라 사실로 적는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  const verdictsPath = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify({
    candidates: [ok({ candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY' })],
  }), 'utf8')
  writeFileSync(verdictsPath, JSON.stringify({ verdicts: [{ candidateId: '04-3#1', disposition: 'needs-context' }] }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verdicts', verdictsPath, '--verification-state', 'ran',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 0)
  assert.match(out.stderr, /추가 확인 이유: \(verifier가 reason을 내지 않았다/)
})

// PR #85 리뷰 지적 2 — CLI 전체 경로로도 active-deletion 삭제 채널이
// stderr에 나오는지 본다. needs-context 알림과 같은 이유로 stdout에는 섞지
// 않는다 — stdout은 두 섹션 자리에 그대로 붙일 Markdown 전용이다.
test('CLI가 active-deletion 삭제를 stderr에 낸다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  const verdictsPath = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify({
    candidates: [ok({
      candidateId: '04-3#1', ruleId: '04-3', impact: 'high', eligibility: 'VERIFY',
      location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'x' },
      content: { title: '지워지는 CLI 지적', body: 'B' },
    })],
  }), 'utf8')
  writeFileSync(verdictsPath, JSON.stringify({
    verdicts: [{ candidateId: '04-3#1', disposition: 'rejected', rebuttal: { kind: 'guard-exists' } }],
  }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verdicts', verdictsPath, '--verification-state', 'ran',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 0)
  assert.doesNotMatch(out.stdout, /지워지는 CLI 지적/, '상세 지적(stdout)에 그대로 남아있다')
  assert.match(out.stderr, /04-3/, 'stderr 알림에 ruleId가 없다')
  assert.match(out.stderr, /src\/a\.ts/, 'stderr 알림에 anchor path가 없다')
  assert.match(out.stderr, /guard-exists/, 'stderr 알림에 rebuttal.kind가 없다')
})

// PR #85 리뷰 지적 2b/3 — CLI 전체 경로에서도 disabled가 검증 대상(VERIFY)
// finding에 꺼짐 토큰을 찍는지 본다. --verdicts를 아예 안 줘도(검증을
// 껐으므로 판정 파일 자체가 없는 것이 정상) 축이 사라지지 않고 꺼짐으로
// 남아야 한다. eligibility를 명시적으로 VERIFY로 둔다 — `ok()`의 기본값은
// SKIP-VERIFY이고(대상 자체가 아니었던 후보), 그 경우는 disabled에서도
// `대상 아님`을 유지해야 한다(바로 아래 disabled/eligibility 테스트가 그
// 구분을 본다). 이 테스트는 "검증 대상이었는데 껐다"만 확인한다.
test('CLI가 --verification-state disabled에서 검증 대상 finding에 꺼짐을 찍는다', () => {
  const out = runWith([ok({ eligibility: 'VERIFY' })])
  assert.equal(out.status, 0)
  assert.match(out.stdout, /교차검증: `꺼짐`/)
})

// -------------------------------------------------------- 정렬·순번·교차검증 라벨
//
// 이 셋은 Task 6이 조립할 render()가 어떤 순서·모양으로 finding을 묶을지를
// 결정한다. renderFinding 자체(헤딩·축 줄·슬롯)는 이미 위에서 검증했다.

test('같은 규칙 ID가 여럿이면 순번을 붙인다', () => {
  const out = withInstanceNumbers([
    ok({ candidateId: '11-6#1', ruleId: '11-6' }),
    ok({ candidateId: '11-6#2', ruleId: '11-6' }),
    ok({ candidateId: '04-3#1', ruleId: '04-3' }),
  ])
  assert.deepEqual(out.map(c => c.renderedRuleId), ['11-6 (1/2)', '11-6 (2/2)', '04-3'])
})

test('순번의 분모는 리포트 전체 기준이다', () => {
  const out = withInstanceNumbers([
    ok({ candidateId: '07-1#1', ruleId: '07-1' }),
    ok({ candidateId: '07-1#2', ruleId: '07-1' }),
    ok({ candidateId: '07-1#3', ruleId: '07-1' }),
  ])
  assert.deepEqual(out.map(c => c.renderedRuleId), ['07-1 (1/3)', '07-1 (2/3)', '07-1 (3/3)'])
})

test('규칙 ID를 문자열이 아니라 숫자로 정렬한다', () => {
  const sorted = [
    ok({ candidateId: '04-10#1', ruleId: '04-10' }),
    ok({ candidateId: '04-3#1', ruleId: '04-3' }),
  ].sort(compareCandidates)
  assert.deepEqual(sorted.map(c => c.ruleId), ['04-3', '04-10'])
})

test('모듈 번호가 규칙 번호보다 먼저다', () => {
  const sorted = [
    ok({ candidateId: '11-1#1', ruleId: '11-1' }),
    ok({ candidateId: '04-9#1', ruleId: '04-9' }),
  ].sort(compareCandidates)
  assert.deepEqual(sorted.map(c => c.ruleId), ['04-9', '11-1'])
})

// 문자 접두 규칙 ID(EX-/P-/A-/C-, 전문 패스)가 섞여도 compareCandidates가
// 죽지 않는지 본다. 숫자 모듈끼리의 순서만큼 이 저장소가 요구하는 건
// 아니지만, 크래시하면 Task 6의 render 전체가 죽는다.
test('문자 접두 규칙 ID가 섞여도 죽지 않고 정렬된다', () => {
  const sorted = [
    ok({ candidateId: 'EX-2#1', ruleId: 'EX-2' }),
    ok({ candidateId: '04-3#1', ruleId: '04-3' }),
    ok({ candidateId: 'P-1#1', ruleId: 'P-1' }),
    ok({ candidateId: 'A-1#1', ruleId: 'A-1' }),
    ok({ candidateId: 'C-1#1', ruleId: 'C-1' }),
  ].sort(compareCandidates)
  assert.deepEqual(sorted.map(c => c.ruleId), ['04-3', 'A-1', 'C-1', 'EX-2', 'P-1'])
})

test('검증 대상이 아니면 대상 아님이다', () => {
  const label = labelFor(ok({ eligibility: 'SKIP-VERIFY' }), new Map(), { high: 'active-deletion', low: 'active-deletion' }, VOCAB)
  assert.equal(label, '대상 아님')
})

test('판정이 없는 검증 대상은 검증 실패다', () => {
  const label = labelFor(ok({ eligibility: 'VERIFY' }), new Map(), { high: 'active-deletion', low: 'active-deletion' },
    { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'verification-unavailable': '검증 실패' } })
  assert.equal(label, '검증 실패')
})

// 리뷰 fix round 1, Important 2 — verdictByCandidateId의 값은 더 이상 disposition
// 문자열 하나가 아니라 { disposition, rebuttalKind } 객체다(아래
// "rebuttal.kind = other" 절 참고). rebuttal이 없는 판정에서는 rebuttalKind를
// 그냥 생략한다.
test('반박된 finding은 active-deletion에서 사라진다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'rejected' }]])
  assert.equal(labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'active-deletion', low: 'active-deletion' }, VOCAB), null)
})

test('반박된 finding은 rollout-shadow에서 관찰 중으로 남는다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'rejected' }]])
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'rejected-shadow': '반박됨 — 관찰 중' } }
  assert.equal(labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'rollout-shadow', low: 'rollout-shadow' }, vocab), '반박됨 — 관찰 중')
})

test('needs-context 판정은 범위 미확정이다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'needs-context' }]])
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'scope-open': '범위 미확정' } }
  assert.equal(labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'active-deletion', low: 'active-deletion' }, vocab), '범위 미확정')
})

// PR #85 리뷰 지적 2a — 계약의 상태표(C-6B)는 scope-open을 "openQuestion으로
// 이동"이라고 적는다. `labelFor`가 라벨을 낼 수 있다는 것과, `render`가 그
// finding을 상세 지적에 라벨을 단 채로 남겨도 된다는 것은 다른 이야기다.
// render는 이 renderer가 소유하지 않는 `미해결 / 후속 확인` 섹션으로 빠져야
// 할 후보를 상세 지적에서 빼고, 무엇이 빠졌는지를 돌려줘야 한다 — 조용히
// 사라지면 안 되기 때문이다.
test('needs-context finding은 상세 지적에서 빠지고 이동 목록으로 돌아온다', () => {
  const candidates = [
    ok({ candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY',
         content: { title: '범위 미확정 지적', body: 'B' } }),
  ]
  const verdicts = new Map([['04-3#1', { disposition: 'needs-context', reason: '호출자를 diff 밖에서 확인해야 한다' }]])
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'scope-open': '범위 미확정' } }
  const { markdown, movedToOpenQuestions } = render(candidates, verdicts,
    { high: 'active-deletion', low: 'active-deletion' }, vocab,
    [{ kind: 'module', id: '04', title: '상태와 Effect' }], 'ran')
  assert.doesNotMatch(markdown, /범위 미확정 지적/, '상세 지적 본문에 그대로 남아있다')
  assert.doesNotMatch(markdown, /범위 미확정/, '라벨을 단 채로 상세 지적에 남아있다')
  assert.deepEqual(movedToOpenQuestions, [{
    id: '04-3#1', ruleId: '04-3', title: '범위 미확정 지적',
    reason: '호출자를 diff 밖에서 확인해야 한다',
    content: { title: '범위 미확정 지적', body: 'B' },
    location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'const a = 1' },
    locationCheck: 'location-ok',
    sources: [],
  }])
})

// 2026-09-28 라운드 리뷰 지적 1 — 이 채널은 needs-context finding의 **유일한
// 출구**다. 상세 지적에서 빠진 뒤 여기에 없는 것은 리포트 어디에도 없다.
// 그런데 id·ruleId·title만 실어 보내면 받는 쪽이 producer JSON을 다시 열어
// 사유와 본문을 찾아야 하고, 그 왕복이 이 렌더러가 없애려는 수작업이다.
test('needs-context 이동 항목은 옮겨 적을 재료를 전부 들고 나온다', () => {
  const candidates = [
    ok({ candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY',
         source: '04-state', sources: ['04-state', 'props'],
         content: { title: '제목', body: '본문', evidence: '근거', recommendation: '제안' } }),
  ]
  const verdicts = new Map([['04-3#1', { disposition: 'needs-context', reason: '범위 밖 호출자 확인 필요' }]])
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'scope-open': '범위 미확정' } }
  const [moved] = render(candidates, verdicts, { high: 'active-deletion', low: 'active-deletion' },
    vocab, [{ kind: 'module', id: '04', title: '상태와 Effect' }], 'ran').movedToOpenQuestions
  assert.equal(moved.reason, '범위 밖 호출자 확인 필요', 'verifier가 낸 reason이 유실됐다')
  assert.equal(moved.content.evidence, '근거', '본문 슬롯이 유실됐다')
  assert.deepEqual(moved.sources, ['04-state', 'props'], '출처 패스가 유실됐다')
  assert.equal(moved.location.path, 'src/a.ts', '위치가 유실됐다')
  assert.equal(moved.locationCheck, 'location-ok', '위치 확인 결과가 유실됐다')
})

// source 하나만 있는 경로(exactDedup이 병합하지 않은 보통의 finding)에서도
// sources 배열로 정규화해 돌려준다 — 받는 쪽이 두 모양을 다시 가르지 않게 한다.
test('needs-context 이동 항목은 source 하나도 배열로 정규화한다', () => {
  const candidates = [
    ok({ candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY', source: '04-state' }),
  ]
  const verdicts = new Map([['04-3#1', { disposition: 'needs-context', reason: 'r' }]])
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'scope-open': '범위 미확정' } }
  const [moved] = render(candidates, verdicts, { high: 'active-deletion', low: 'active-deletion' },
    vocab, [{ kind: 'module', id: '04', title: '상태와 Effect' }], 'ran').movedToOpenQuestions
  assert.deepEqual(moved.sources, ['04-state'])
})

// PR #85 리뷰 지적 2b/3 — "검증을 껐다"와 "이 리포트에는 검증 축 자체가
// 없다"는 다른 사실이다(계약이 verification-disabled와
// verification-unavailable을 가르는 것과 같은 이유). 종전에는 --verdicts를
// 안 주면 축 자체가 사라져 두 경우가 구분되지 않았다.
//
// 그런데 verificationState='disabled'가 "판정 유무와 무관하다"는 것이
// "eligibility와도 무관하다"는 뜻은 아니다. disposition 표(C-6B)는
// `verification-disabled`를 "검증을 끈 실행의 **검증 대상**"에만 부여한다
// — SKIP-VERIFY 후보는 이 실행이 검증을 껐든 켰든 애초에 대상이 아니다
// (`not-eligible` — SKIP-VERIFY 후보). eligibility는 후보 자체의 성질이지
// 그 pass가 실제로 돌았는지에 좌우되지 않는다. 이전 버전은 이 교차를
// 놓치고 SKIP-VERIFY 후보에도 꺼짐을 찍었다 — 이 테스트가 그 잘못된 읽기를
// 그대로 하드코딩하고 있었다.
test('verification-state가 disabled여도 대상 아님은 대상 아님으로 남고 검증 대상만 꺼짐이 찍힌다', () => {
  const candidates = [
    ok({ candidateId: '04-3#1', ruleId: '04-3', eligibility: 'SKIP-VERIFY',
         content: { title: '대상 아님이었던 지적', body: 'B1' } }),
    ok({ candidateId: '11-6#1', ruleId: '11-6', impact: 'low', category: undefined, eligibility: 'VERIFY',
         content: { title: '검증 대상이었던 지적', body: 'B2' } }),
  ]
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'verification-disabled': '꺼짐' } }
  // verdicts를 하나도 안 줘도(빈 Map) disabled는 라벨을 낸다 — ran과 달리
  // 판정 데이터에 의존하지 않는다.
  const { markdown, movedToOpenQuestions } = render(candidates, new Map(),
    { high: 'active-deletion', low: 'active-deletion' }, vocab,
    [{ kind: 'module', id: '04', title: '상태와 Effect' }, { kind: 'module', id: '11', title: '스타일링' }], 'disabled')
  const axisLines = [...markdown.matchAll(/교차검증: `([^`]+)`/g)].map(m => m[1])
  assert.deepEqual(axisLines, ['대상 아님', '꺼짐'])
  assert.deepEqual(movedToOpenQuestions, [], 'disabled는 needs-context 이동 대상이 없다')
})

test('upheld 판정은 유지다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'upheld' }]])
  assert.equal(labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'active-deletion', low: 'active-deletion' }, VOCAB), '유지')
})

// 리뷰 fix round 2 — labelFor의 마지막 줄(`return tokens.upheld`)은 닫힌
// 목록 검사 없는 catch-all이었다. 오타나 이 코드가 모르는 disposition이
// 들어오면 반박됐거나 판정이 불확실한 finding에 "교차검증: `유지`"라는
// 거짓 표기가 찍히고, 독자는 리포트만 보고는 그 사실을 알 수 없다.
// tally-verdicts.mjs가 같은 상황(C-6B 닫힌 목록 밖 disposition)에서 죽는
// 것과 같은 이유로 여기서도 조용히 넘기지 않고 던진다.
// 결과 스냅숏(#88 PR 0)과 리포트가 같은 함수로 disposition을 정한다. 두 곳이 각자
// 정하면 JSON과 리포트가 같은 후보를 다르게 말할 수 있다.
test('dispositionOf는 C-6B 표의 값을 낸다 — 오케스트레이터가 부여하는 값까지', () => {
  const verify = ok({ eligibility: 'VERIFY' })
  const skip = ok({ eligibility: 'SKIP-VERIFY' })
  assert.equal(dispositionOf(skip, undefined, 'ran'), 'not-eligible')
  assert.equal(dispositionOf(skip, undefined, 'disabled'), 'not-eligible', 'eligibility는 검증을 껐는지와 무관하다')
  assert.equal(dispositionOf(verify, { disposition: 'upheld' }, 'disabled'), 'verification-disabled', 'disabled는 판정을 보지 않는다')
  assert.equal(dispositionOf(verify, undefined, 'ran'), 'verification-unavailable')
  assert.equal(dispositionOf(verify, { disposition: 'upheld' }, 'ran'), 'upheld')
  assert.equal(dispositionOf(verify, { disposition: 'rejected' }, 'ran'), 'rejected')
  assert.equal(dispositionOf(verify, { disposition: 'needs-context' }, 'ran'), 'scope-open')
  assert.throws(() => dispositionOf(verify, { disposition: 'totally-bogus' }, 'ran'), /totally-bogus/)
  assert.throws(() => dispositionOf(verify, undefined, undefined), /ran.*disabled/)
})

test('닫힌 목록 밖 disposition은 유지로 흘려보내지 않고 던진다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'totally-bogus' }]])
  assert.throws(
    () => labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'active-deletion', low: 'active-deletion' }, VOCAB),
    /totally-bogus/,
  )
})

// 리뷰 fix round 1, Important 1 — 위의 정렬 테스트는 전부 ruleId가 다른 후보만
// 썼다. compareCandidates의 candidateId tie-break(같은 ruleId일 때만 타는
// 마지막 줄)은 그 테스트들로는 한 번도 실행되지 않는다. withInstanceNumbers는
// 정렬된 배열의 "그 자리 순서"로 (n/총)을 매기므로, tie-break가 뒤집히거나
// 지워지면 같은 ruleId의 두 finding이 서로의 순번과 — 렌더링에서는 서로의
// 본문까지 — 뒤바뀐 채로 나가는데도 이 파일의 11개 테스트는 전부 그대로
// 통과한다. 그래서 순서 자체를 candidateId로 직접 확인한다.
test('같은 규칙 ID의 형제는 candidateId로 정렬해 순번이 서로 바뀌지 않게 한다', () => {
  const sorted = [
    ok({ candidateId: '11-6#2', ruleId: '11-6' }),
    ok({ candidateId: '11-6#1', ruleId: '11-6' }),
  ].sort(compareCandidates)
  assert.deepEqual(sorted.map(c => c.candidateId), ['11-6#1', '11-6#2'])
})

// -------------------------------------------------------- rebuttal.kind = other
//
// 리뷰 fix round 1, Important 2 — 계약(C-6B)은 `other`가 어떤 phase에서도
// finding을 지우지 않는다고 세 번 못박는다. 그런데 labelFor는 disposition만
// 보고 `rejected`면 active-deletion에서 무조건 null을 냈다 — `other`도 그
// 경로를 탔고, 그러면 차단해야 할 🔴가 계약이 금지한 그 우회로로 사라진다.
// 이걸 구분하려면 verdict 채널이 disposition 문자열 하나가 아니라
// `{ disposition, rebuttalKind }`를 실어야 한다. 이 시점부터
// verdictByCandidateId의 값은 문자열이 아니라 이 객체 모양이다 — 아래 세
// 테스트와 위의 세 판정 테스트(rejected/needs-context/upheld)가 그 모양을
// 쓴다.

test('rebuttal.kind가 other면 active-deletion에서도 사라지지 않는다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'rejected', rebuttalKind: 'other' }]])
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'rejected-other': '반박 시도 — 분류 밖' } }
  assert.equal(labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'active-deletion', low: 'active-deletion' }, vocab), '반박 시도 — 분류 밖')
})

test('rebuttal.kind가 other면 rollout-shadow에서도 분류 밖으로 남는다 — 관찰 중이 아니다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'rejected', rebuttalKind: 'other' }]])
  const vocab = {
    ...VOCAB,
    crossVerification: { ...VOCAB.crossVerification, 'rejected-other': '반박 시도 — 분류 밖', 'rejected-shadow': '반박됨 — 관찰 중' },
  }
  assert.equal(labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'rollout-shadow', low: 'rollout-shadow' }, vocab), '반박 시도 — 분류 밖')
})

test('rebuttal.kind가 other가 아니면 active-deletion에서 그대로 사라진다', () => {
  const verdicts = new Map([['04-3#1', { disposition: 'rejected', rebuttalKind: 'guard-exists' }]])
  assert.equal(labelFor(ok({ eligibility: 'VERIFY' }), verdicts, { high: 'active-deletion', low: 'active-deletion' }, VOCAB), null)
})

// -------------------------------------------------------------- loadModuleSections
//
// 섹션 목록은 손으로 넘기지 않는다. catalog.json에 모듈 제목이 있고
// modules-planned.json에 건너뛴 모듈이 있으므로, 둘을 합치면 결정적으로 나온다.

test('catalog에서 워크플로우의 모듈 섹션을 만든다', () => {
  const { value } = loadModuleSections(RULES, 'full')
  assert.ok(value.length >= 19)
  // `source`는 결과 파일·`collected.sources`가 쓰는 규칙 문서 이름이다.
  assert.deepEqual(value[0], { kind: 'module', id: '01', title: 'FSD 아키텍처', source: '01-fsd' })
  assert.equal(value.some(section => section.id === '00'), false, '공통 규칙은 섹션이 아니다')
  assert.equal(value.some(section => section.id === '10'), false, 'synthesis 전용 모듈은 섹션이 아니다')
})

test('건너뛴 모듈은 섹션에서 뺀다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planned-'))
  const planned = join(dir, 'planned.json')
  writeFileSync(planned, JSON.stringify({
    candidates: 20, applied: 19, unknown: [],
    skipped: [{ module: '21-rsc', status: 'skipped', reasonCode: 'profile-mismatch' }],
  }), 'utf8')
  const { value } = loadModuleSections(RULES, 'full', planned)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(value.some(section => section.id === '21'), false)
})

test('catalog을 읽지 못하면 사유를 낸다 — loadModuleSections', () => {
  assert.match(loadModuleSections(join(tmpdir(), 'no-such-dir'), 'full').error, /catalog/)
})

// -------------------------------------------------------------- loadSpecialistPasses
//
// 리뷰 판정 Ruling 1 — `passLabel`은 어디에도 없다. prepare-verification의
// 입력은 `{ results: [...] }`뿐이라 패스 정보를 안 나른다. 특수 패스는 대신
// 규칙 ID 접두로 가른다. 그 접두를 review-rules 문서 텍스트에서 손으로
// 베끼지 않고 catalog.json의 rulePrefixes에서 읽는다는 것을 이 테스트가 고정한다.

test('catalog에서 특수 패스 접두를 얻는다', () => {
  const { value } = loadSpecialistPasses(RULES)
  assert.deepEqual(value, [
    { kind: 'pass', id: 'props', title: 'Props', prefixes: ['P'], source: 'props' },
    { kind: 'pass', id: 'math', title: '수학', prefixes: ['A', 'C'], source: 'math' },
    { kind: 'pass', id: 'exception', title: '예외', prefixes: ['EX'], source: 'exception' },
    // 선택 패스. full에서 켰을 때만 돈다(#88 PR 1) — catalog의 optIn이 그렇게 말한다.
    { kind: 'pass', id: 'correctness', title: '정확성', prefixes: ['CR'], source: 'correctness', optIn: true },
  ])
})

test('catalog을 읽지 못하면 사유를 낸다 — loadSpecialistPasses', () => {
  assert.match(loadSpecialistPasses(join(tmpdir(), 'no-such-dir')).error, /catalog/)
})

// 리뷰 fix round 1, Important 4 — rulePrefixes가 없거나 빈 배열이면 조용히
// "접두 없음"으로 넘기지 않고 거부한다. catalog를 접두의 단일 소스로 만든
// 것(Ruling 1)은 그 소스가 조용히 사라질 수 있으면 단일 소스가 아니다.
test('specialist 항목에 rulePrefixes가 없으면 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-catalog-'))
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({
    modules: [
      { id: 'props', role: 'specialist' },
      { id: 'math', role: 'specialist', rulePrefixes: ['A', 'C'] },
      { id: 'exception', role: 'specialist', rulePrefixes: ['EX'] },
    ],
  }), 'utf8')
  const result = loadSpecialistPasses(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.ok(result.error, 'error가 없다')
  assert.match(result.error, /props/)
  assert.match(result.error, /rulePrefixes/)
})

test('specialist 항목의 rulePrefixes가 빈 배열이면 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-catalog-'))
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify({
    modules: [
      { id: 'props', role: 'specialist', rulePrefixes: [] },
      { id: 'math', role: 'specialist', rulePrefixes: ['A', 'C'] },
      { id: 'exception', role: 'specialist', rulePrefixes: ['EX'] },
    ],
  }), 'utf8')
  const result = loadSpecialistPasses(dir)
  rmSync(dir, { recursive: true, force: true })
  assert.match(result.error, /props/)
})

// -------------------------------------------------------------- render — golden
//
// 기대 Markdown 전문을 golden으로 고정한다. 표 형식이나 영어 등급, 축 줄
// 누락을 따로 검사할 필요가 없다 — 한 글자만 달라도 깨진다.
//
// SECTIONS는 CLI가 실제로 만드는 모양(loadModuleSections + loadSpecialistPasses를
// 이어붙인 것)을 흉내 낸다 — `kind: 'module'`은 모듈, `kind: 'pass'`는 특수
// 패스다(리뷰 fix round 1, Important 5). `passLabel` 필드는 애초에 없으므로
// EX-6 후보의 ruleId 접두(`EX`)만으로 "예외" 섹션에 묶인다.

const SECTIONS = [
  { kind: 'module', id: '04', title: '상태와 Effect' },
  { kind: 'module', id: '11', title: '스타일링' },
  { kind: 'pass', id: 'props', title: 'Props', prefixes: ['P'] },
  { kind: 'pass', id: 'math', title: '수학', prefixes: ['A', 'C'] },
  { kind: 'pass', id: 'exception', title: '예외', prefixes: ['EX'] },
]

test('두 섹션 전문을 낸다 — golden', () => {
  const candidates = [
    ok({ candidateId: '11-6#2', ruleId: '11-6', impact: 'low', category: undefined,
         content: { title: '두 번째', body: 'B2' },
         location: { kind: 'unverified', reason: '못 찾음' }, locationCheck: 'not-applicable' }),
    ok({ candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY',
         content: { title: '첫 번째', body: 'B1', evidence: 'E1', recommendation: 'R1' } }),
    ok({ candidateId: '11-6#1', ruleId: '11-6', impact: 'low', category: undefined,
         content: { title: '첫 스타일', body: 'B3' },
         location: { kind: 'deleted', path: 'src/x.ts', lineBefore: 4, quote: 'old()' } }),
    ok({ candidateId: 'EX-6#1', ruleId: 'EX-6', impact: 'low', category: undefined,
         content: { title: '예외 지적', body: 'B4' },
         location: { kind: 'unverified', reason: '사유' }, locationCheck: 'not-applicable' }),
  ]
  const verdicts = new Map([['04-3#1', { disposition: 'upheld' }]])
  const vocab = { categoryLabels: { 'data-loss': '데이터 손상·유실' },
    crossVerification: { upheld: '유지', 'not-eligible': '대상 아님' } }

  assert.equal(render(candidates, verdicts, { high: 'active-deletion', low: 'active-deletion' }, vocab, SECTIONS, 'ran').markdown, [
    '## 상세 지적',
    '',
    '### 04 상태와 Effect',
    '',
    '#### 🔴 `04-3` 첫 번째',
    '영향: 높음 (데이터 손상·유실) · 확신: 높음 · 교차검증: `유지`',
    '`src/a.ts:1` — `const a = 1`',
    '본문: B1',
    '근거: E1',
    '개선 제안: R1',
    '',
    '### 11 스타일링',
    '',
    '#### 🟡 `11-6 (1/2)` 첫 스타일',
    '영향: 낮음 · 확신: 높음 · 교차검증: `대상 아님`',
    '`src/x.ts:4` — `old()`',
    '본문: B3',
    '',
    '#### 🟡 `11-6 (2/2)` 두 번째',
    '영향: 낮음 · 확신: 높음 · 교차검증: `대상 아님`',
    '위치 미확인 사유: 못 찾음',
    '본문: B2',
    '',
    '## 특수 패스',
    '',
    // 지적이 없는 특수 패스도 제 자리에 남는다(아래 `빈 특수 패스` 참고).
    '### Props',
    '',
    '지적 없음.',
    '',
    '### 수학',
    '',
    '지적 없음.',
    '',
    '### 예외',
    '',
    '#### 🟡 `EX-6` 예외 지적',
    '영향: 낮음 · 확신: 높음 · 교차검증: `대상 아님`',
    '위치 미확인 사유: 사유',
    '본문: B4',
    '',
  ].join('\n'))
})

test('적용 대상인데 지적이 없는 모듈은 지적 없음으로 남는다', () => {
  const { markdown: md } = render([], new Map(), { high: 'active-deletion', low: 'active-deletion' },
    { categoryLabels: {}, crossVerification: {} }, [{ kind: 'module', id: '03', title: 'React 규칙' }], 'ran')
  assert.match(md, /### 03 React 규칙\n\n지적 없음\.\n/)
})

// 리뷰 fix round 1, Important 2 — 원래 이 테스트는 `crossVerification: {}`인
// vocab을 썼다. 빈 토큰 테이블에서는 render가 crossVerified를 무시하고
// labelFor를 그냥 불러도 `labelFor`가 모든 경로에서 undefined를 내므로
// `doesNotMatch(md, /교차검증/)`가 통과했다 — 검증하려던 동작(labelFor를
// 부르지 않는 것)이 실패해도 테스트는 못 잡는 헛것이었다. `not-eligible`
// 토큰이 채워진 실제 VOCAB을 쓰면, render가 crossVerified===false에서도
// labelFor를 부르는 회귀가 생기면 "교차검증: `대상 아님`"이 찍혀 이 assert가
// 실제로 깨진다.
test('교차검증을 돌리지 않았으면 축을 아예 내지 않는다', () => {
  const { markdown: md } = render([ok({ eligibility: 'SKIP-VERIFY' })], new Map(), { high: 'active-deletion', low: 'active-deletion' },
    VOCAB, [{ kind: 'module', id: '04', title: '상태와 Effect' }], false)
  assert.doesNotMatch(md, /교차검증/)
  assert.match(md, /영향: 높음 \(데이터 손상·유실\) · 확신: 높음\n/)
})

// 리뷰 fix round 1, Important 1 — labelFor가 null을 내는 finding(반박된
// VERIFY 대상)이 순번 매기기 *전에* 걸러지는지를 직접 본다. `labelFor`
// 단위 테스트(위)는 null이라는 값 자체만 확인하지, render가 그 null을
// 정렬·순번보다 먼저 거르는지는 보지 않는다 — 순서를 바꿔도(순번을 먼저
// 매기고 나중에 거르면) 그 단위 테스트들은 전부 그대로 통과한다. 세 형제
// 중 가운데 하나가 반박되면, 살아남은 둘의 분모는 2여야 한다(반박된 것까지
// 센 3이 아니라).
test('반박된 형제는 순번 분모에서도 빠진다 — 필터링이 정렬·순번보다 먼저다', () => {
  const candidates = [
    ok({ candidateId: '11-6#1', ruleId: '11-6', eligibility: 'VERIFY', impact: 'low', category: undefined,
         content: { title: '살아남음1', body: 'B1' } }),
    ok({ candidateId: '11-6#2', ruleId: '11-6', eligibility: 'VERIFY', impact: 'low', category: undefined,
         content: { title: '반박됨', body: 'B2' } }),
    ok({ candidateId: '11-6#3', ruleId: '11-6', eligibility: 'VERIFY', impact: 'low', category: undefined,
         content: { title: '살아남음2', body: 'B3' } }),
  ]
  const verdicts = new Map([['11-6#2', { disposition: 'rejected', rebuttalKind: 'guard-exists' }]])
  const { markdown: md } = render(candidates, verdicts, { high: 'active-deletion', low: 'active-deletion' }, VOCAB,
    [{ kind: 'module', id: '11', title: '스타일링' }], 'ran')
  assert.doesNotMatch(md, /반박됨/, '반박된 finding 자체가 리포트에 남아있다')
  assert.doesNotMatch(md, /\/3\)/, '걸러지기 전 건수(3)가 분모에 남아있다')
  assert.match(md, /`11-6 \(1\/2\)` 살아남음1/)
  assert.match(md, /`11-6 \(2\/2\)` 살아남음2/)
})

// PR #85 리뷰 지적 1 — phase는 전역이 아니라 impact별 오케스트레이터 설정이다
// (workflow-contract.md, "candidate ID 표기" 절 바로 뒤 deletionPhase 블록).
// high가 아직 rollout-shadow인 동안 low만 active-deletion으로 옮기는 것이
// 정상 구성이고, 그 반대(모두 rollout-shadow)와도 구분돼야 한다. 하나의
// phase 문자열로는 이 독립 승인을 표현할 수 없다.
test('phase는 impact별로 독립이다 — high는 관찰 중으로 남고 low는 사라진다', () => {
  const candidates = [
    ok({ candidateId: '04-3#1', ruleId: '04-3', impact: 'high', eligibility: 'VERIFY',
         content: { title: '반박된 high', body: 'B1' } }),
    ok({ candidateId: '11-6#1', ruleId: '11-6', impact: 'low', category: undefined, eligibility: 'VERIFY',
         content: { title: '반박된 low', body: 'B2' } }),
  ]
  const verdicts = new Map([
    ['04-3#1', { disposition: 'rejected' }],
    ['11-6#1', { disposition: 'rejected' }],
  ])
  const vocab = { ...VOCAB, crossVerification: { ...VOCAB.crossVerification, 'rejected-shadow': '반박됨 — 관찰 중' } }
  const { markdown: md } = render(candidates, verdicts, { high: 'rollout-shadow', low: 'active-deletion' }, vocab,
    [{ kind: 'module', id: '04', title: '상태와 Effect' }, { kind: 'module', id: '11', title: '스타일링' }], 'ran')
  assert.match(md, /`04-3` 반박된 high/, 'high는 rollout-shadow이므로 남아있어야 한다')
  assert.match(md, /교차검증: `반박됨 — 관찰 중`/)
  assert.doesNotMatch(md, /반박된 low/, 'low는 active-deletion인데도 리포트에 남아있다')
})

// PR #85 리뷰 지적 2 — 계약(C-6B "오판 가시성")은 `active-deletion`에서
// 지워지는 rejected finding의 흔적을 audit이 아니라 리포트 본문
// (`미해결 / 후속 확인`)에 남기라고 명시한다: impact=high는 건별로
// 규칙 ID·anchor path·rebuttal.kind, impact=low는 건수만. 그런데 render는
// label===null을 만나면 movedToOpenQuestions처럼 돌려주는 채널 없이 그냥
// continue해 버렸다 — needs-context를 위해 만든 "조용히 사라지지 않는다"
// 장치가 active-deletion에는 없었다. 두 번째 채널(activeDeletionRemovals)로
// 이 삭제 사실을 돌려받는지 본다.
test('active-deletion에서 지워진 rejected finding은 두 번째 채널로 돌아온다', () => {
  const candidates = [
    ok({ candidateId: '04-3#1', ruleId: '04-3', impact: 'high', eligibility: 'VERIFY',
         location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'x' },
         content: { title: '사라지는 high', body: 'B1' } }),
    ok({ candidateId: '11-6#1', ruleId: '11-6', impact: 'low', category: undefined, eligibility: 'VERIFY',
         location: { kind: 'verified', path: 'src/b.ts', line: 2, quote: 'y' },
         content: { title: '사라지는 low 1', body: 'B2' } }),
    ok({ candidateId: '11-6#2', ruleId: '11-6', impact: 'low', category: undefined, eligibility: 'VERIFY',
         location: { kind: 'verified', path: 'src/c.ts', line: 3, quote: 'z' },
         content: { title: '사라지는 low 2', body: 'B3' } }),
  ]
  const verdicts = new Map([
    ['04-3#1', { disposition: 'rejected', rebuttalKind: 'guard-exists' }],
    ['11-6#1', { disposition: 'rejected', rebuttalKind: 'unreachable' }],
    ['11-6#2', { disposition: 'rejected', rebuttalKind: 'unreachable' }],
  ])
  const { markdown, activeDeletionRemovals } = render(candidates, verdicts,
    { high: 'active-deletion', low: 'active-deletion' }, VOCAB,
    [{ kind: 'module', id: '04', title: '상태와 Effect' }, { kind: 'module', id: '11', title: '스타일링' }], 'ran')
  assert.doesNotMatch(markdown, /사라지는/, '지워진 finding이 상세 지적에 그대로 남아있다')
  assert.deepEqual(activeDeletionRemovals.high, [{ ruleId: '04-3', path: 'src/a.ts', rebuttalKind: 'guard-exists' }])
  assert.equal(activeDeletionRemovals.lowCount, 2, 'low는 건수만 남긴다 — 건별 항목이 아니다')
})

// 리뷰 fix round 1, Important 3 — Ruling 2가 고정한 순서(Props → 수학 →
// 예외)를 loadSpecialistPasses 자체의 deepEqual만으로는 render가 지키는지
// 확인할 수 없다(golden 테스트는 예외 하나만 후보가 있어 Props·수학이
// 통째로 스킵된다). 세 패스에 각각 후보를 하나씩 둬서 실제로 그 순서로
// 나오는지를 직접 본다.
test('특수 패스는 Props → 수학 → 예외 순서로 나온다', () => {
  const candidates = [
    ok({ candidateId: 'EX-1#1', ruleId: 'EX-1', impact: 'low', category: undefined,
         content: { title: '예외 후보', body: 'B' } }),
    ok({ candidateId: 'A-1#1', ruleId: 'A-1', impact: 'low', category: undefined,
         content: { title: '수학 후보', body: 'B' } }),
    ok({ candidateId: 'P-1#1', ruleId: 'P-1', impact: 'low', category: undefined,
         content: { title: 'Props 후보', body: 'B' } }),
  ]
  const { markdown: md } = render(candidates, new Map(), { high: 'active-deletion', low: 'active-deletion' }, VOCAB, SECTIONS, false)
  const order = [...md.matchAll(/^### (Props|수학|예외)$/gm)].map(match => match[1])
  assert.deepEqual(order, ['Props', '수학', '예외'])
})

// 리뷰 fix round 1, Important 5 — sections 항목의 kind가 'module'도 'pass'도
// 아니면 두 분기 모두에서 조용히 빠지지 않고 던진다. 조용히 버리면 그
// 섹션의 지적이 리포트에서 통째로 사라지는데, 원인이 CLI 배선이라 다시
// 돌려도 똑같이 사라진다.
test('sections 항목의 kind가 module·pass가 아니면 조용히 사라지지 않고 던진다', () => {
  assert.throws(
    () => render([], new Map(), { high: 'active-deletion', low: 'active-deletion' }, VOCAB, [{ kind: 'mystery', id: 'zz', title: '?' }], false),
    /kind/,
  )
})

// -------------------------------------------------------------- 판정 파일 모양

// 2026-09-30 실행(2.14.0) — 오케스트레이터가 판정 파일을 `{ tasks: [ …payload… ] }`로
// 만들었다. `tally-verdicts.mjs`는 그 모양을 받아 유지 19건으로 셌는데, 렌더러는
// 최상위 `verdicts`만 봐서 **같은 파일을 판정 0건으로 읽었다.** 그대로 그렸으면
// 검증 대상 23건이 전부 `검증 실패`로 찍혔고, 집계와 리포트가 말없이 어긋났다.
// 오케스트레이터가 렌더러 소스를 읽고 파일 모양을 바꿔서 겨우 피했다.
const runWithVerdicts = verdictsPayload => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  const verdictsPath = join(dir, 'verdicts.json')
  writeFileSync(input, JSON.stringify({
    candidates: [ok({ candidateId: '04-3#1', ruleId: '04-3', eligibility: 'VERIFY', route: 'bundle' })],
  }), 'utf8')
  writeFileSync(verdictsPath, JSON.stringify(verdictsPayload), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'rollout-shadow', '--phase-low', 'rollout-shadow',
    '--workflow', 'full', '--verdicts', verdictsPath, '--verification-state', 'ran',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  return out
}

const UPHELD = { candidateId: '04-3#1', disposition: 'upheld', evidence: 'e',
  location: { kind: 'verified', path: 'src/a.ts', line: 1, quote: 'const a = 1' } }

test('CLI가 tally-verdicts가 받는 { tasks: [...] } 판정 파일을 같은 판정으로 읽는다', () => {
  const out = runWithVerdicts({ tasks: [{ schemaVersion: 1, verdicts: [UPHELD] }] })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /교차검증: `유지`/)
  assert.doesNotMatch(out.stdout, /검증 실패/)
})

test('CLI가 payload 배열로 된 판정 파일도 같은 판정으로 읽는다', () => {
  const out = runWithVerdicts([{ schemaVersion: 1, verdicts: [UPHELD] }])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /교차검증: `유지`/)
})

test('CLI가 판정 목록을 찾지 못한 판정 파일을 0건으로 흘리지 않고 거부한다', () => {
  const out = runWithVerdicts({ results: [UPHELD] })
  assert.equal(out.status, 2)
  assert.equal(out.stdout, '')
  assert.match(out.stderr, /verdicts\.json/)
})

// -------------------------------------------------------------- 수식 구분자
//
// 2026-09-30 리포트에서 `[0, 0, 1]`이 세로로 쪼개진 "0 , 0 , 1 0,0,1"로, `-8`이
// 수식 기호 `−8`로 보였다. escapeProse가 링크를 막으려고 `[`·`(`를 `\[`·`\(`로
// 바꿨는데, KaTeX를 쓰는 Markdown 뷰어에서 `\[ … \]`는 수식 블록이고 `\( … \)`는
// 인라인 수식이다. 링크를 막으려던 이스케이프가 수식을 열었다. `$ … $`도 같은
// 이유로 수식이 된다 — producer 산문에는 `${name}` 같은 템플릿 리터럴이 흔하다.
const MATH_OPENERS = /\\[[\]()]|(^|[^\\])\$/

test('산문 이스케이프가 수식 구분자를 만들지 않는다', () => {
  for (const text of ['Z-up 축 [0, 0, 1]과 방향 [5, -8, 5]', 'names.map(name => x)', '`processed/${name}`', '$$x$$']) {
    assert.doesNotMatch(escapeProse(text), MATH_OPENERS, text)
  }
})

test('대괄호는 문자 참조로 바꿔 링크를 막고 값은 그대로 보이게 한다', () => {
  assert.equal(escapeProse('[0, 0, 1]'), '&#91;0, 0, 1&#93;')
  assert.equal(escapeProse('[링크](http://x)'), '&#91;링크&#93;(http://x)')
})

test('달러 기호는 역슬래시로 이스케이프한다', () => {
  assert.equal(escapeProse('a $b$ c'), 'a \\$b\\$ c')
})

// -------------------------------------------------------------- 빈 특수 패스
//
// 2026-09-30 `feat/scene-graph-undo-redo` 리포트의 `특수 패스`에는 `예외`만 있었다.
// Props는 돌아서 지적이 0건이었고, 수학은 적용 범위가 없어 SKIPPED였다 — 둘 다
// 리포트 어디에도 없었다. 번호 모듈은 0건이어도 "지적 없음."이 찍히는데 특수 패스는
// 지적이 없으면 헤딩째 빠졌고, 계약(C-7)이 이 절을 "렌더러 출력 그대로"로 정해 두어
// 오케스트레이터가 채울 수도 없었다. 읽는 쪽은 "돌았는데 0건"과 "안 돌았다"를 가를
// 수 없다. 리포트를 감사한 에이전트 넷도 이것을 못 잡았다.

const PHASES_BOTH = { high: 'active-deletion', low: 'active-deletion' }

test('특수 패스는 지적이 없어도 이름과 "지적 없음."을 낸다', () => {
  const { markdown } = render([], new Map(), PHASES_BOTH, VOCAB, SECTIONS, false)
  assert.match(markdown, /## 특수 패스\n\n### Props\n\n지적 없음\.\n\n### 수학\n\n지적 없음\.\n\n### 예외\n\n지적 없음\./)
})

test('SKIPPED 특수 패스는 사유와 비차단을 낸다', () => {
  const sections = SECTIONS.map(section => (section.id === 'math' ? { ...section, skipped: { reason: '행렬 연산 없음' } } : section))
  const { markdown } = render([], new Map(), PHASES_BOTH, VOCAB, sections, false)
  assert.match(markdown, /### 수학\n\n`SKIPPED` — 행렬 연산 없음 · 비차단\n/)
})

test('CLI가 --planned의 SKIPPED 특수 패스를 그 패스 자리에 표시한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const planned = join(dir, 'planned.json')
  writeFileSync(planned, JSON.stringify({ skipped: [{ module: 'math', reasonCode: 'no-matrix-ops', reason: '행렬 연산 없음' }], unknown: [] }), 'utf8')
  const out = runWith([ok()], ['--planned', planned])
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /### Props\n\n지적 없음\./)
  assert.match(out.stdout, /### 수학\n\n`SKIPPED` — 행렬 연산 없음 · 비차단/)
})

// 수집 기록과 대조한다. `prepare-verification.mjs --collect`는 결과 파일을 모은 모듈을
// `collected.sources`로 남긴다. 그 목록이 있는데 거기 없는 모듈·패스를 "지적 없음."으로
// 찍으면, 실행이 실패했거나 결과가 빠진 모듈이 0건인 것처럼 보인다.
test('수집 목록이 있으면 결과가 수집되지 않은 모듈과 패스를 지적 없음과 구분한다', () => {
  const sections = [
    { kind: 'module', id: '04', title: '상태와 Effect', source: '04-state' },
    { kind: 'module', id: '11', title: '스타일링', source: '11-styling' },
    ...SECTIONS.filter(section => section.kind === 'pass'),
  ]
  const { markdown } = render([], new Map(), PHASES_BOTH, VOCAB, sections, false, { collected: new Set(['04-state', 'exception']) })
  assert.match(markdown, /### 04 상태와 Effect\n\n지적 없음\.\n/)
  assert.match(markdown, /### 11 스타일링\n\n결과 없음 — /)
  assert.match(markdown, /### Props\n\n결과 없음 — /)
  assert.match(markdown, /### 예외\n\n지적 없음\.\n/)
})

test('CLI가 routed의 collected로 수집되지 않은 모듈을 표시한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'render-'))
  const input = join(dir, 'targets.json')
  writeFileSync(input, JSON.stringify({ candidates: [ok()], collected: { sources: ['04-state'] } }), 'utf8')
  const out = spawnSync(process.execPath, [
    SCRIPT, '--input', input, '--rules', RULES, '--phase-high', 'active-deletion', '--phase-low', 'active-deletion',
    '--workflow', 'full', '--verification-state', 'disabled',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  rmSync(dir, { recursive: true, force: true })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /### 01 FSD 아키텍처\n\n결과 없음 — /)
  assert.match(out.stdout, /#### 🔴 `04-3` 제목/)
})

// ------------------------------------------------- 정확성 패스 (#88 PR 1)
//
// 선택 패스는 켰을 때만 돈다. 켜지 않은 실행에서 "지적 없음."을 찍으면 돌았는데 0건인 것처럼
// 보이고, 섹션을 빼면 그런 패스가 있는지조차 보이지 않는다. 켰는지는 prepare-verification이
// run.start에서 읽어 `collected.optIn`으로 넘긴다.

const CORRECTNESS = { kind: 'pass', id: 'correctness', title: '정확성', prefixes: ['CR'], source: 'correctness', optIn: true }
const WITH_CORRECTNESS = [...SECTIONS, CORRECTNESS]
const crFinding = extra => ok({ candidateId: 'CR-1#1', ruleId: 'CR-1', source: 'correctness', impact: 'high', confidence: 'low',
  content: { title: '취소 뒤 늦은 응답이 상태를 덮는다', body: '본문', evidence: '근거', reason: '취소 경로 일부만 읽었다' }, ...extra })

test('켜지 않은 정확성 패스는 SKIPPED와 이유를 낸다 — 지적 없음으로 찍지 않는다', () => {
  const { markdown } = render([], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false,
    { collected: new Set(['props', 'math', 'exception']), optIn: { correctness: 'off' } })
  assert.match(markdown, /### 정확성\n\n`SKIPPED` — 선택 패스, 이 실행에서 켜지 않았다\(`--correctness on` 없음\) · 비차단\n/)
})

test('켜지 않았는데 결과가 있었던 정확성 패스는 모으지 않았다는 사실도 낸다', () => {
  const { markdown } = render([], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false,
    { collected: new Set(), optIn: { correctness: 'off' }, excludedNotRequested: new Set(['correctness']) })
  assert.match(markdown, /### 정확성\n\n`SKIPPED` — 선택 패스, .* 기록이나 결과 파일이 있었지만 이 실행의 결과로 모으지 않았다\./)
})

test('켠 정확성 패스는 다른 특수 패스와 같다 — 지적, 지적 없음, 결과 없음', () => {
  const on = { optIn: { correctness: 'on' } }
  const empty = render([], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false, { ...on, collected: new Set(['correctness']) }).markdown
  assert.match(empty, /### 정확성\n\n지적 없음\.\n/)
  const failed = render([], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false, { ...on, collected: new Set([]) }).markdown
  assert.match(failed, /### 정확성\n\n결과 없음 — /)
  const found = render([crFinding()], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false, { ...on, collected: new Set(['correctness']) }).markdown
  // 출처·영향·확신이 그대로 남는다
  assert.match(found, /### 정확성\n\n#### 🟡 `CR-1` 취소 뒤 늦은 응답이 상태를 덮는다\n영향: 높음 \(데이터 손상·유실\) · 확신: 낮음\n출처 패스: correctness\n/)
})

test('켰는지 모르는 입력(--input 경로)은 CR 지적이 있을 때만 정확성 섹션을 낸다', () => {
  assert.doesNotMatch(render([], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false).markdown, /정확성/)
  assert.match(render([crFinding()], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false).markdown, /### 정확성\n\n#### /)
})

test('같은 자리의 다른 namespace 지적은 관련 지적 줄로 잇는다 — 상세 지적에 없는 것은 그렇다고 적는다', () => {
  const rule = ok({ candidateId: '04-3#1', ruleId: '04-3', relatedCandidateIds: ['CR-1#1'] })
  const cr = crFinding({ relatedCandidateIds: ['04-3#1', '11-6#1'] })
  const { markdown } = render([rule, cr], new Map(), PHASES_BOTH, VOCAB, WITH_CORRECTNESS, false, { optIn: { correctness: 'on' } })
  assert.match(markdown, /#### 🔴 `04-3` 제목\n[^\n]*\n관련 지적: `CR-1`\n/)
  assert.match(markdown, /출처 패스: correctness\n관련 지적: `04-3`, `11-6#1` \(상세 지적에 없음\)\n/)
})
