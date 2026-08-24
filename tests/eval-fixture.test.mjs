import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readTree, changedPaths, buildFixture, readBlobLines } from '../scripts/lib/eval-fixture.mjs'

const scratch = () => mkdtempSync(join(tmpdir(), 'eval-fixture-'))

const write = (root, relative, contents) => {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents, 'utf8')
}

// `after/`는 완전한 트리이지 패치가 아니다. 그래서 `before/`에만 있는 파일이
// 삭제로, `after/`에만 있는 파일이 신규로 저절로 표현된다.
const makeCase = () => {
  const dir = scratch()
  write(dir, 'before/src/keep.ts', 'export const keep = 1\n')
  write(dir, 'before/src/gone.ts', 'export const gone = 2\n')
  write(dir, 'before/src/edit.ts', 'export const edit = 3\n')
  write(dir, 'after/src/keep.ts', 'export const keep = 1\n')
  write(dir, 'after/src/edit.ts', 'export const edit = 4\n')
  write(dir, 'after/src/added.ts', 'export const added = 5\n')
  return dir
}

test('트리를 상대 경로 맵으로 읽는다', () => {
  const dir = makeCase()
  const tree = readTree(join(dir, 'before'))
  assert.deepEqual([...tree.keys()].sort(), ['src/edit.ts', 'src/gone.ts', 'src/keep.ts'])
  assert.equal(tree.get('src/keep.ts'), 'export const keep = 1\n')
  rmSync(dir, { recursive: true, force: true })
})

test('두 트리의 차이를 추가/삭제/수정으로 나눈다', () => {
  const dir = makeCase()
  const changed = changedPaths(readTree(join(dir, 'before')), readTree(join(dir, 'after')))
  assert.deepEqual(changed.added, ['src/added.ts'])
  assert.deepEqual(changed.removed, ['src/gone.ts'])
  assert.deepEqual(changed.modified, ['src/edit.ts'])
  rmSync(dir, { recursive: true, force: true })
})

test('before 커밋과 after 커밋을 가진 저장소를 만든다', t => {
  const dir = makeCase()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // `scratch()`가 만드는 부모 디렉터리를 변수에 묶어야 나중에 지울 수 있다 —
  // `join(scratch(), 'repo')`처럼 인라인으로만 쓰면 그 부모 경로가 어디에도
  // 남지 않아 정리할 수 없다.
  const targetParent = scratch()
  t.after(() => rmSync(targetParent, { recursive: true, force: true }))
  const fixture = buildFixture(dir, join(targetParent, 'repo'))

  const git = (...args) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim()
  assert.notEqual(fixture.mergeBase, fixture.head)
  assert.equal(git('rev-parse', 'HEAD'), fixture.head)

  const names = git('diff', '--name-only', `${fixture.mergeBase}..HEAD`).split('\n').filter(Boolean).sort()
  assert.deepEqual(names, ['src/added.ts', 'src/edit.ts', 'src/gone.ts'])
})

test('CLAUDE.md와 .gitignore는 before 커밋에 들어가 diff에 나타나지 않는다', t => {
  const dir = makeCase()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const targetParent = scratch()
  t.after(() => rmSync(targetParent, { recursive: true, force: true }))
  const fixture = buildFixture(dir, join(targetParent, 'repo'))
  const git = (...args) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim()

  assert.ok(existsSync(join(fixture.root, 'CLAUDE.md')))
  const names = git('diff', '--name-only', `${fixture.mergeBase}..HEAD`).split('\n').filter(Boolean)
  assert.ok(!names.includes('CLAUDE.md'), 'CLAUDE.md가 리뷰 대상이 되면 안 된다')
  assert.ok(!names.includes('.gitignore'))
})

test('삭제된 파일은 merge base에서, 남은 파일은 working tree에서 읽는다', t => {
  const dir = makeCase()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const targetParent = scratch()
  t.after(() => rmSync(targetParent, { recursive: true, force: true }))
  const fixture = buildFixture(dir, join(targetParent, 'repo'))
  const blobs = readBlobLines(fixture.root, fixture.mergeBase, ['src/edit.ts', 'src/gone.ts'])
  assert.deepEqual(blobs.head['src/edit.ts'], ['export const edit = 4'])
  assert.deepEqual(blobs.base['src/gone.ts'], ['export const gone = 2'])
  assert.equal(blobs.head['src/gone.ts'], undefined)
})

// I3 회귀 테스트: `paths`는 리포트가 언급한 경로라 모델 출력이다. 예전에는
// `join(root, path)`로 곧바로 읽어서 `../../x` 같은 경로가 fixture 밖으로
// 새어나갔다 — grader가 "observed"로 echo하는 내용이 임의의 로컬 파일이 될
// 수 있었다는 뜻이다. `resolveWithinRoot`를 재사용한 뒤에는 그런 경로가
// 조용히 "존재하지 않음"으로 접혀야 한다(던지지도, fixture 밖 내용을 읽지도
// 않아야 한다).
test('fixture 밖으로 나가는 경로는 존재하지 않는 것으로 접힌다 — 밖의 파일을 읽지 않는다', t => {
  const dir = makeCase()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const targetParent = scratch()
  t.after(() => rmSync(targetParent, { recursive: true, force: true }))
  // repo 밖, targetParent 바로 아래에 "비밀" 파일을 둔다 — `../secret.txt`가
  // 정확히 이 파일을 가리킨다.
  writeFileSync(join(targetParent, 'secret.txt'), 'do-not-leak-this-line\n', 'utf8')
  const fixture = buildFixture(dir, join(targetParent, 'repo'))

  const blobs = readBlobLines(fixture.root, fixture.mergeBase, ['../secret.txt', '..\\secret.txt'])
  assert.equal(blobs.head['../secret.txt'], undefined)
  assert.equal(blobs.base['../secret.txt'], undefined)
  assert.equal(blobs.head['..\\secret.txt'], undefined)
  assert.equal(blobs.base['..\\secret.txt'], undefined)
})

// Finding 1 회귀 테스트: 삭제된 파일의 blob을 `git show`로 읽을 때 앞뒤 빈 줄이
// 사라지면 안 된다. 이전 구현은 rev-parse용 `.trim()` 헬퍼를 파일 내용에도
// 재사용해서 첫/마지막 빈 줄을 지웠고, 그 결과 삭제된 파일 쪽 줄 번호가
// working tree 쪽과 어긋났다. 길이만 비교하면 이 버그를 못 잡으므로 정확한
// 배열을 비교한다.
test('삭제된 파일의 앞뒤 빈 줄이 git show 결과에서 사라지지 않는다', t => {
  const dir = scratch()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  write(dir, 'before/src/keep.ts', 'export const keep = 1\n')
  write(dir, 'before/src/gone.ts', '\nexport const gone = 2\n\n')
  write(dir, 'after/src/keep.ts', 'export const keep = 1\n')

  const targetParent = scratch()
  t.after(() => rmSync(targetParent, { recursive: true, force: true }))
  const fixture = buildFixture(dir, join(targetParent, 'repo'))

  const blobs = readBlobLines(fixture.root, fixture.mergeBase, ['src/gone.ts'])
  assert.deepEqual(blobs.base['src/gone.ts'], ['', 'export const gone = 2', ''])
})

// Finding 2 회귀 테스트: mergeBase가 가리키는 대상이 없으면 조용히 빈 결과를
// 주는 게 아니라 던져야 한다. 그래야 "환경이 망가졌다"와 "이 경로가 양쪽에
// 다 없다"가 구분된다.
test('mergeBase가 유효하지 않으면 조용히 빈 값을 주지 않고 던진다', t => {
  const dir = makeCase()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const targetParent = scratch()
  t.after(() => rmSync(targetParent, { recursive: true, force: true }))
  const fixture = buildFixture(dir, join(targetParent, 'repo'))

  // 매처 없는 assert.throws는 아무 에러나 던지면 통과한다 — 이 테스트가 지키려는
  // 회귀(사전 검증이 mergeBase 자체를 잡아내는 것)가 조용히 다른 이유로 던지는
  // 것으로 바뀌어도 계속 초록으로 남는다. 잘못된 ref 문자열이 에러 메시지 안에
  // 그대로 나오는지까지 확인해야, 이 던짐이 실제로 mergeBase 검증에서 온 것임을
  // 고정한다.
  assert.throws(() => readBlobLines(fixture.root, 'not-a-real-sha', ['src/gone.ts']), /not-a-real-sha/)
})
