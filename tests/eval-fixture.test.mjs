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

test('before 커밋과 after 커밋을 가진 저장소를 만든다', () => {
  const dir = makeCase()
  const target = join(scratch(), 'repo')
  const fixture = buildFixture(dir, target)

  const git = (...args) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim()
  assert.notEqual(fixture.mergeBase, fixture.head)
  assert.equal(git('rev-parse', 'HEAD'), fixture.head)

  const names = git('diff', '--name-only', `${fixture.mergeBase}..HEAD`).split('\n').filter(Boolean).sort()
  assert.deepEqual(names, ['src/added.ts', 'src/edit.ts', 'src/gone.ts'])
  rmSync(dir, { recursive: true, force: true })
})

test('CLAUDE.md와 .gitignore는 before 커밋에 들어가 diff에 나타나지 않는다', () => {
  const dir = makeCase()
  const fixture = buildFixture(dir, join(scratch(), 'repo'))
  const git = (...args) => execFileSync('git', args, { cwd: fixture.root, encoding: 'utf8' }).trim()

  assert.ok(existsSync(join(fixture.root, 'CLAUDE.md')))
  const names = git('diff', '--name-only', `${fixture.mergeBase}..HEAD`).split('\n').filter(Boolean)
  assert.ok(!names.includes('CLAUDE.md'), 'CLAUDE.md가 리뷰 대상이 되면 안 된다')
  assert.ok(!names.includes('.gitignore'))
  rmSync(dir, { recursive: true, force: true })
})

test('삭제된 파일은 merge base에서, 남은 파일은 working tree에서 읽는다', () => {
  const dir = makeCase()
  const fixture = buildFixture(dir, join(scratch(), 'repo'))
  const blobs = readBlobLines(fixture.root, fixture.mergeBase, ['src/edit.ts', 'src/gone.ts'])
  assert.deepEqual(blobs.head['src/edit.ts'], ['export const edit = 4'])
  assert.deepEqual(blobs.base['src/gone.ts'], ['export const gone = 2'])
  assert.equal(blobs.head['src/gone.ts'], undefined)
  rmSync(dir, { recursive: true, force: true })
})
