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

// mustFind가 가리키는 파일이 반드시 after에 있는 것은 아니다. 삭제 회귀
// 케이스에서 결함은 **삭제된 파일 안**에 있고, 리뷰가 인용해야 하는 줄
// 번호도 그 파일이 마지막으로 존재하던 트리의 것이다. 채점기의
// resolveLines가 working tree 다음에 merge base를 보는 것과 같은 순서로
// after -> mid -> before를 훑는다.
const treesFor = caseDir => ({
  after: readTree(join(caseDir, 'after')),
  mid: existsSync(join(caseDir, 'mid')) ? readTree(join(caseDir, 'mid')) : null,
  before: readTree(join(caseDir, 'before')),
})
const fileIn = (trees, path) => trees.after.get(path) ?? trees.mid?.get(path) ?? trees.before.get(path)

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

  test(`${name}: mustFind가 가리키는 줄이 그 파일 범위 안이다`, () => {
    const expected = readJson('expected.json')
    const trees = treesFor(caseDir)
    for (const target of expected.mustFind) {
      const contents = fileIn(trees, target.path)
      assert.ok(contents, `${target.path}가 after/mid/before 어느 트리에도 없다`)
      const lines = contents.split(/\r\n|\r|\n/)
      assert.ok(target.line >= 1 && target.line <= lines.length,
        `${target.id}: ${target.path}:${target.line} 은 파일 범위(1..${lines.length}) 밖이다`)
    }
  })

  // 범위 안이라는 것만으로는 줄 번호가 맞다는 증거가 못 된다. fixture를 한 줄
  // 고치면 모든 줄 번호가 조용히 어긋나고, 그 상태로 채점하면 locationsOnTarget이
  // 리뷰의 실패가 아니라 fixture의 낡음을 재게 된다 — 측정 장치의 결함을 측정
  // 대상의 결함으로 읽는 이 저장소의 단골 실패다. anchor는 그 줄에 실제로
  // 무엇이 있어야 하는지를 못박는다.
  // mustFind가 비면 그 아래 검사들이 전부 **무증상으로 통과**한다. 빈 배열이
  // 설계인 경우(처리량 측정)와 expected.json을 빠뜨린 경우가 같은 초록불로
  // 보이면, 케이스를 추가하다 기대값을 잊은 것을 아무도 못 잡는다.
  //
  // 그래서 빈 mustFind는 case.json에 measures로 **선언해야만** 허용한다.
  test(`${name}: mustFind가 비어 있으면 measures를 선언했다`, () => {
    const expected = readJson('expected.json')
    if (expected.mustFind.length > 0) return
    const meta = readJson('case.json')
    assert.ok(meta.measures,
      `${name}: mustFind가 비어 있는데 case.json에 measures 선언이 없다 — 처리량 측정이면 선언하고, 아니면 기대값을 빠뜨린 것이다`)
  })

  test(`${name}: mustFind의 anchor가 그 줄에 실제로 있다`, () => {
    const expected = readJson('expected.json')
    for (const target of expected.mustFind) {
      assert.ok(target.anchor, `${target.id}: anchor가 없다 — 줄 번호를 지킬 방법이 없다`)
      const line = fileIn(treesFor(caseDir), target.path).split(/\r\n|\r|\n/)[target.line - 1]
      assert.ok(line.includes(target.anchor),
        `${target.id}: ${target.path}:${target.line} 에 anchor ${JSON.stringify(target.anchor)} 가 없다. 실제 줄: ${JSON.stringify(line)}`)
    }
  })

  // 대조군이 실제로 diff 안에 있어야 오탐을 잴 수 있다. diff 밖에 두는 것이
  // 의도인 대조군(any-outside-the-diff)은 반대로 diff에 나타나면 안 된다.
  test(`${name}: 심은 결함이 전부 diff 안에 있다`, () => {
    const expected = readJson('expected.json')
    const changed = changedPaths(readTree(join(caseDir, 'before')), readTree(join(caseDir, 'after')))
    const inDiff = new Set([...changed.added, ...changed.modified, ...changed.removed])
    for (const target of expected.mustFind) {
      assert.ok(inDiff.has(target.path),
        `${target.id}: ${target.path} 가 diff 밖이다 — 리뷰가 볼 수 없는 결함은 재현율을 잴 수 없다`)
    }
  })
}
