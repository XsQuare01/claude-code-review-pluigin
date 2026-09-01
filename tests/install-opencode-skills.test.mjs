import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// opencode에 스킬을 설치하는 스크립트를 고정한다.
//
// opencode는 Claude Code 플러그인을 로드하지 않지만 **스킬 규약은 같다**
// (`skills/**/SKILL.md`, `name`/`description` 프론트매터). 그래서 옮겨야 할
// 것은 코드가 아니라 파일 위치뿐이고, 이 스크립트가 그 일을 한다.
//
// 여기서 지키는 진짜 위험은 규칙 디렉터리다. C-1의 해석 순서는
// 1) ${CLAUDE_PLUGIN_ROOT}/review-rules/, 2) ./review-rules/,
// 3) ~/.claude/review-rules/ 인데, opencode는 1번을 만들지 않는다. 2번을
// 빠뜨리면 **3번으로 조용히 내려가** 홈에 남은 낡은 사본으로 리뷰가 돈다 —
// 리포트는 멀쩡해 보이고, 규칙 버전만 다르다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'install-opencode-skills.mjs')

const run = args => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})

const freshTarget = t => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-skills-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('스킬 7개를 opencode 프로젝트 경로에 놓는다', t => {
  const target = freshTarget(t)
  const done = run(['--target', target])
  assert.equal(done.status, 0, done.stderr)

  const skills = readdirSync(join(target, '.opencode', 'skills')).sort()
  assert.deepEqual(skills, [
    'code-review', 'code-review-commit', 'code-review-exception',
    'code-review-fast', 'code-review-full', 'code-review-math', 'code-review-props',
  ])
  assert.ok(existsSync(join(target, '.opencode', 'skills', 'code-review-full', 'SKILL.md')))
})

test('규칙 디렉터리를 스킬과 함께 놓는다', t => {
  // 이것이 빠지면 리뷰가 홈의 낡은 규칙으로 조용히 내려간다.
  const target = freshTarget(t)
  assert.equal(run(['--target', target]).status, 0)
  assert.ok(existsSync(join(target, 'review-rules', '00-rule.md')))
  // 리포트의 `리뷰 기준`에 적을 버전이 여기서 나온다(C-1).
  assert.ok(existsSync(join(target, '.claude-plugin', 'plugin.json')))
})

test('스킬이 실행하는 헬퍼 스크립트를 함께 놓는다', t => {
  // 스킬은 `$RULES_DIR/../scripts/*.mjs`를 **실행한다**. 이게 빠지면 위치
  // 대조와 실행 타임라인이 조용히 건너뛰어지고, 리포트는 그 사실을 말하지 않는다.
  const target = freshTarget(t)
  assert.equal(run(['--target', target]).status, 0)
  assert.ok(existsSync(join(target, 'scripts', 'prepare-verification.mjs')))
  assert.ok(existsSync(join(target, 'scripts', 'review-timeline.mjs')))
})

test('규칙이 없으면 --check가 사유와 함께 실패한다', t => {
  const target = freshTarget(t)
  assert.equal(run(['--target', target]).status, 0)
  rmSync(join(target, 'review-rules'), { recursive: true, force: true })

  const checked = run(['--target', target, '--check'])
  assert.equal(checked.status, 1)
  assert.match(checked.stdout, /MISSING review-rules/)
  // 사유를 함께 낸다 — 무엇이 없는지만 알면 왜 위험한지는 모른다.
  assert.match(checked.stdout, /낡은 사본/)
})

test('설치가 온전하면 --check는 통과한다', t => {
  const target = freshTarget(t)
  assert.equal(run(['--target', target]).status, 0)
  assert.equal(run(['--target', target, '--check']).status, 0)
})

test('없는 target은 조용히 넘어가지 않는다', () => {
  const missing = run(['--target', join(tmpdir(), 'oc-skills-does-not-exist-xyz')])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /target not found/)
})
