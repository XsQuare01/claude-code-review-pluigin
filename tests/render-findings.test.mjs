import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateCandidates, loadVocabulary, renderFinding, severityOf, escapeProse, codeSpan }
  from '../scripts/render-findings.mjs'

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

test('unverified 위치는 사유 줄이 대신한다', () => {
  const md = renderFinding(ok({ location: { kind: 'unverified', reason: '경로를 찾지 못했습니다.' } }),
    { label: '대상 아님', vocabulary: VOCAB })
  assert.match(md, /위치 미확인 사유: 경로를 찾지 못했습니다\./)
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
  assert.equal(escapeProse('[링크](http://x)'), '\\[링크\\]\\(http://x\\)')
  assert.equal(escapeProse('> 인용'), '\\> 인용')
})

// 리뷰 Critical 1 — 계약은 raw HTML을 헤딩/펜스/표/링크/인용과 별개의 필수
// escape 대상으로 명시한다. 기존 문자 집합은 그 다섯과만 겹쳤고 `<`는 없었다.
// `>`만 escape하면 여는 델리미터(`<script>`)는 그대로 열려 있고, CommonMark는
// 여는 델리미터만으로 HTML 블록/인라인 HTML을 인식하므로 보호가 안 된다.
test('산문의 raw HTML 여는 델리미터(`<`)를 escape한다', () => {
  assert.equal(escapeProse('<script>alert(1)</script>'), '\\<script\\>alert\\(1\\)\\</script\\>')
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
