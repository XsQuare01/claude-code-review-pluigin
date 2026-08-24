import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
