import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 단위 테스트는 모듈 함수를 import하므로, CLI 엔트리포인트가 없어진 이름을
// 참조해도 계속 통과한다. 실제로 실행하는 것이 그것을 잡는 유일한 방법이다.
// `--dry-run`은 fixture만 만들고 claude를 부르지 않으므로 비용이 없다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'eval-review.mjs')

const run = (...args) => execFileSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })

test('--dry-run은 fixture를 만들고 변경 집합을 보고한다', () => {
  const output = run('--case', 'location-trap', '--dry-run')
  assert.match(output, /location-trap/)
  assert.match(output, /src\/features\/order-list\/ui\/order-list\.tsx/)
  assert.match(output, /mergeBase/)
})

test('없는 케이스는 크래시 대신 사유를 낸다', () => {
  assert.throws(
    () => run('--case', 'no-such-case', '--dry-run'),
    error => {
      assert.match(String(error.stderr), /no-such-case/)
      return true
    },
  )
})

// 아래 네 테스트는 인자 파싱 단계에서 die()로 끝나므로 --dry-run 여부와 무관하게
// claude를 부르지 않는다 — fixture조차 만들기 전에 죽는다.

test('플래그처럼 보이는 --runs 값은 사유를 낸다', () => {
  assert.throws(
    () => run('--case', 'location-trap', '--runs', '--dry-run'),
    error => {
      assert.match(String(error.stderr), /runs/)
      return true
    },
  )
})

test('마지막에 위치해 값이 없는 --timeout-minutes는 사유를 낸다', () => {
  assert.throws(
    () => run('--case', 'location-trap', '--dry-run', '--timeout-minutes'),
    error => {
      assert.match(String(error.stderr), /timeout-minutes/)
      return true
    },
  )
})

test('숫자가 아닌 --runs 값은 사유를 낸다', () => {
  assert.throws(
    () => run('--case', 'location-trap', '--runs', 'abc', '--dry-run'),
    error => {
      assert.match(String(error.stderr), /runs/)
      return true
    },
  )
})

test('0 이하의 --timeout-minutes 값은 사유를 낸다', () => {
  assert.throws(
    () => run('--case', 'location-trap', '--timeout-minutes', '0', '--dry-run'),
    error => {
      assert.match(String(error.stderr), /timeout-minutes/)
      return true
    },
  )
})

// executionShape는 두 곳에 나타나야 한다: --dry-run 출력과 **저장되는 결과
// 파일의 provenance**. 처음 추가했을 때 dry-run 쪽에만 들어가고 결과 파일에는
// 빠졌는데, dry-run 출력만 보면 정상으로 보였다 — 리뷰 실행 두 번을 치르고
// 나서야 저장된 파일에 값이 없다는 것을 알았다.
//
// 값은 있는데 무엇이 그 값을 냈는지 모르는 것이 이 저장소의 단골 실패다.
// 결과 파일을 만들려면 리뷰를 실제로 돌려야 하므로, 여기서는 소스에서
// provenance 리터럴을 잘라 그 안에 필드가 있는지 확인한다. 거친 방법이지만
// "파일 어딘가에 있다"와 "저장되는 객체에 있다"를 구분하는 유일한 값싼 방법이다.

test('executionShape가 --dry-run 출력에 들어간다', () => {
  const output = run('--case', 'location-trap', '--dry-run')
  assert.match(output, /"executionShape": "as-experienced"/)
})

test('--dispatch는 executionShape를 as-designed로 바꾼다', () => {
  const output = run('--case', 'location-trap', '--dry-run', '--dispatch')
  assert.match(output, /"executionShape": "as-designed"/)
})

test('executionShape가 저장되는 결과 파일의 provenance에도 들어간다', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  const at = source.indexOf('writeFileSync(outPath')
  assert.ok(at !== -1, 'writeResults를 찾지 못했다 — 이 테스트가 낡았다')
  const literal = source.slice(at, source.indexOf('}, null, 2)', at))
  for (const field of ['executionShape', 'model', 'effort', 'pluginRef', 'pluginVersion']) {
    assert.ok(literal.includes(field),
      `결과 파일 provenance에 ${field}가 없다. dry-run 출력에만 넣으면 저장된 숫자가 무엇에서 나왔는지 복원할 수 없다`)
  }
})

test('--dry-run이 무엇으로 잴지 미리 보여준다', () => {
  // 실행 전에 조건을 확인할 수 있어야 한다. A2의 첫 6회는 모델과 effort가
  // 세션 기본값이었고, 결과 파일을 열기 전까지 그것을 알 방법이 없었다.
  const output = run('--case', 'location-trap', '--dry-run')
  assert.match(output, /"model": "opus"/)
  assert.match(output, /"effort": "xhigh"/)
})

test('--regrade 대상 케이스가 다르면 사유를 낸다', () => {
  assert.throws(
    () => run('--case', 'location-trap', '--regrade', 'evals/results/baseline-mixed-a2.json'),
    error => {
      assert.match(String(error.stderr), /baseline-mixed/)
      return true
    },
  )
})
