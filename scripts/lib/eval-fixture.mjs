import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'

// 케이스 매니페스트에서 임시 git 저장소를 만든다.
//
// fixture를 저장소에 커밋된 git 저장소로 두지 않는 이유는 중첩 저장소를 피하고,
// 매번 같은 트리에서 같은 merge-base 관계를 재현하기 위해서다.

// 리포트 저장 위치를 저장소 안으로 고정한다. 사용자 글로벌 CLAUDE.md는 산출
// 문서를 다른 곳으로 보내며, 그러면 grader가 리포트를 찾지 못한다.
// C-7은 프로젝트 설정이 우선이라고 명시하므로 위반이 아니다.
export const FIXTURE_CLAUDE_MD = `# Eval fixture

이 저장소는 코드 리뷰 계측용 fixture다.

- 리뷰 리포트는 반드시 이 저장소의 \`./review-reports/\`에 저장한다. 다른 위치를 쓰지 않는다.
- 코드를 수정하지 않는다. 리뷰만 한다.
`

export const FIXTURE_GITIGNORE = `review-reports/\n`

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

export function readTree(dir) {
  const tree = new Map()
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else tree.set(relative(dir, path).split('\\').join('/'), readFileSync(path, 'utf8'))
    }
  }
  walk(dir)
  return tree
}

export function changedPaths(beforeTree, afterTree) {
  const added = []
  const removed = []
  const modified = []
  for (const [path, contents] of afterTree) {
    if (!beforeTree.has(path)) added.push(path)
    else if (beforeTree.get(path) !== contents) modified.push(path)
  }
  for (const path of beforeTree.keys()) if (!afterTree.has(path)) removed.push(path)
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() }
}

const writeTree = (root, tree) => {
  for (const [path, contents] of tree) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents, 'utf8')
  }
}

export function buildFixture(caseDir, targetDir) {
  const beforeTree = readTree(join(caseDir, 'before'))
  const afterTree = readTree(join(caseDir, 'after'))

  mkdirSync(targetDir, { recursive: true })
  git(targetDir, 'init', '--initial-branch', 'main')
  git(targetDir, 'config', 'user.email', 'eval@example.invalid')
  git(targetDir, 'config', 'user.name', 'Eval Fixture')
  git(targetDir, 'config', 'commit.gpgsign', 'false')
  // 이 머신은 글로벌 core.hooksPath로 Notion 로깅 post-commit 훅을 갖고 있다.
  // 커밋 자체는 성공하지만 매 커밋마다 stderr에 실패 메시지를 남긴다. fixture는
  // 개발자 개인 훅을 실행하면 안 되고, Task 7은 fixture를 반복 생성하므로 그
  // 노이즈가 매 실행마다 쌓인다. 존재하지 않는 경로로 로컬 hooksPath를 덮어써
  // 훅 자체를 무력화한다.
  git(targetDir, 'config', 'core.hooksPath', join(targetDir, '.no-hooks'))

  writeFileSync(join(targetDir, 'CLAUDE.md'), FIXTURE_CLAUDE_MD, 'utf8')
  writeFileSync(join(targetDir, '.gitignore'), FIXTURE_GITIGNORE, 'utf8')
  writeTree(targetDir, beforeTree)
  git(targetDir, 'add', '-A')
  git(targetDir, 'commit', '-m', 'before')
  const mergeBase = git(targetDir, 'rev-parse', 'HEAD')

  // before 트리에서 온 파일을 먼저 지운다. after가 완전한 트리이므로 이렇게
  // 하면 after에 없는 파일이 삭제로 표현된다. CLAUDE.md와 .gitignore는
  // before 트리 소속이 아니므로 살아남고, 따라서 diff에 나타나지 않는다.
  for (const path of beforeTree.keys()) rmSync(join(targetDir, path), { force: true })
  writeTree(targetDir, afterTree)
  git(targetDir, 'add', '-A')
  git(targetDir, 'commit', '-m', 'after')
  const head = git(targetDir, 'rev-parse', 'HEAD')

  return { root: targetDir, mergeBase, head, changed: changedPaths(beforeTree, afterTree) }
}

/**
 * grader에 넣을 파일 내용을 모은다.
 *
 * 살아 있는 파일은 working tree에서, 삭제된 파일은 merge base에서 읽는다.
 * `{head, base}` 키 구조는 `prepare-verification.mjs`의 `collectBlobs`와 같지만, 값은
 * **줄 배열**이다 — `collectBlobs`는 원시 문자열을 담는다. grader가 줄 경계 검사에
 * `.length`를 쓰므로 여기서 미리 쪼개고, `collectBlobs`의 출력을 grader에 직결하지 않는다.
 */
export function readBlobLines(root, mergeBase, paths) {
  const head = {}
  const base = {}
  for (const path of paths) {
    try {
      head[path] = readFileSync(join(root, path), 'utf8').split(/\r\n|\r|\n/)
      if (head[path].at(-1) === '') head[path].pop()
    } catch {
      try {
        base[path] = git(root, 'show', `${mergeBase}:${path}`).split(/\r\n|\r|\n/)
      } catch {
        // 어느 쪽에도 없는 경로. grader가 `path not in fixture`로 기록한다.
      }
    }
  }
  return { head, base }
}
