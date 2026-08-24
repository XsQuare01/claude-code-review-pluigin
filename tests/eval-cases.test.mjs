import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { readTree, changedPaths } from '../scripts/lib/eval-fixture.mjs'
import { assertNoPathOverlap } from '../scripts/lib/eval-grade.mjs'

// `after/`가 완전한 트리이므로 변경하지 않을 파일도 복사된다. 복사 과정에서
// 한 글자가 어긋나면 의도하지 않은 diff 항목이 생기고, 그러면 리뷰가 우리가
// 심지 않은 것을 보게 된다. case.json이 선언한 변경 집합과 실제를 대조한다.

const CASES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'evals', 'cases')

const caseNames = existsSync(CASES_DIR)
  ? readdirSync(CASES_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  : []

test('케이스가 최소 하나 있다', () => {
  assert.ok(caseNames.length > 0, 'evals/cases 아래에 케이스가 없다')
})

for (const name of caseNames) {
  const caseDir = join(CASES_DIR, name)
  const readJson = file => JSON.parse(readFileSync(join(caseDir, file), 'utf8'))

  test(`${name}: 선언한 변경 집합이 실제 트리 차이와 같다`, () => {
    const meta = readJson('case.json')
    const actual = changedPaths(readTree(join(caseDir, 'before')), readTree(join(caseDir, 'after')))
    assert.deepEqual(actual, {
      added: meta.changedFiles.added,
      removed: meta.changedFiles.removed,
      modified: meta.changedFiles.modified,
    })
  })

  test(`${name}: expected.json의 경로가 겹치지 않는다`, () => {
    assert.doesNotThrow(() => assertNoPathOverlap(readJson('expected.json')))
  })

  // buildFixture()는 before 트리에 자기 CLAUDE.md/.gitignore를 써 넣고, after
  // 커밋을 만들 때는 before가 소유한 경로를 먼저 지운 뒤 after 트리를 그대로
  // 덮어쓴다. 케이스가 자기 CLAUDE.md나 .gitignore를 갖고 있으면 그 삭제
  // 단계가 케이스 파일 대신 harness의 파일을 지우고, after 트리에는 harness가
  // 다시 쓴 적 없는 그 경로가 남지 않는다 — 리포트 저장 위치를 지정하는
  // CLAUDE.md가 사라지면 리포트가 다른 곳에 쓰이고 reportFound가 조용히
  // false가 된다. 케이스 트리 자체에 이 두 이름이 없는지 여기서 고정한다.
  test(`${name}: before/after 트리에 CLAUDE.md나 .gitignore가 없다`, () => {
    const before = readTree(join(caseDir, 'before'))
    const after = readTree(join(caseDir, 'after'))
    for (const forbidden of ['CLAUDE.md', '.gitignore']) {
      assert.ok(!before.has(forbidden), `before 트리가 자기 ${forbidden}를 갖고 있다 — harness의 것과 충돌한다`)
      assert.ok(!after.has(forbidden), `after 트리가 자기 ${forbidden}를 갖고 있다 — harness의 것과 충돌한다`)
    }
  })

  test(`${name}: mustFind가 가리키는 줄이 after 트리에 실제로 있다`, () => {
    const expected = readJson('expected.json')
    const after = readTree(join(caseDir, 'after'))
    for (const target of expected.mustFind) {
      const contents = after.get(target.path)
      assert.ok(contents, `${target.path}가 after 트리에 없다`)
      const lines = contents.split(/\r\n|\r|\n/)
      assert.ok(target.line >= 1 && target.line <= lines.length,
        `${target.id}: ${target.path}:${target.line} 은 파일 범위(1..${lines.length}) 밖이다`)
    }
  })
}
