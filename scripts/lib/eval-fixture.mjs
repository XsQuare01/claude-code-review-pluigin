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

// stdio를 명시해서 실패한 git 호출의 stderr가 이 프로세스의 실제 stderr로
// 그대로 새는 것을 막는다 — Node의 execFileSync는 옵션을 안 주면 자식의
// stderr를 부모 stderr로 흘려보내면서 동시에 던지는 에러의 `.stderr`에도
// 담는다. 실패 메시지는 에러 객체 안에 남으니 진단 능력은 그대로다.
const GIT_STDIO = ['ignore', 'pipe', 'pipe']

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: GIT_STDIO }).trim()

// `git show`로 읽은 blob 내용을 그대로 돌려주는 raw 버전. `git`의 `.trim()`은
// rev-parse류 한 줄 출력에는 맞지만 파일 내용에 적용하면 앞뒤 빈 줄이 사라진다 —
// 그러면 삭제된 파일의 줄 번호가 working tree 쪽 알고리즘과 어긋난다. 파일
// 내용을 읽을 때는 반드시 이 raw 버전을 쓴다.
const gitRaw = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: GIT_STDIO })

// 텍스트를 줄 배열로 쪼갠다. 마지막 개행이 만드는 빈 원소 하나만 버린다.
// working tree 읽기와 git show 읽기가 반드시 이 알고리즘을 공유해야, 살아있는
// 파일과 삭제된 파일의 줄 번호가 같은 규칙으로 셈해진다.
const toLines = text => {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

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
 *
 * "양쪽 다 없는 경로"만 조용히 넘어간다. 그 밖의 실패 — git이 없다, root가
 * 저장소가 아니다, mergeBase가 틀렸다 — 는 던진다. 그런 환경 문제를 조용히
 * 삼키면 "이 경로는 없다"와 구분이 안 되고, 결과가 비어 있을 뿐 틀렸다는
 * 신호가 전혀 없는 채로 grader에 넘어간다.
 */
export function readBlobLines(root, mergeBase, paths) {
  const head = {}
  const base = {}

  // mergeBase 자체를 미리 검증한다. 여기서 던지면 환경 문제가 아래 루프의
  // catch 안에서 "이 경로가 양쪽에 다 없다"로 둔갑하는 일을 막는다 — 그
  // 둔갑이 바로 조용히 틀린 결과를 만들던 원인이었다.
  git(root, 'rev-parse', '--verify', `${mergeBase}^{commit}`)

  for (const path of paths) {
    let workingTreeText
    try {
      workingTreeText = readFileSync(join(root, path), 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    if (workingTreeText !== undefined) {
      head[path] = toLines(workingTreeText)
      continue
    }
    try {
      base[path] = toLines(gitRaw(root, 'show', `${mergeBase}:${path}`))
    } catch {
      // mergeBase는 위에서 이미 검증했으므로 여기서 남는 유일한 실패 원인은
      // "이 경로가 그 커밋에 없다"뿐이다 — 양쪽 어디에도 없는 합법적인 경로이고,
      // grader가 `path not in fixture`로 기록한다.
    }
  }
  return { head, base }
}
