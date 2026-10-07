import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 리뷰가 시작되기 전에 시작됐다는 사실부터 남기는 관문을 고정한다.
//
// 왜 있는가: C-9는 첫 sub-agent보다 먼저 `run.start`를 남기라고 하지만 그것은
// 기억해야 하는 지시였다. 2026-09-08의 한 실행(357개 파일, 3시간 28분)은 계약
// 문서를 읽고도 타임라인을 한 줄도 남기지 않았다 — 컨텍스트 압축 때문이 아니라
// (첫 producer보다 55분 뒤에야 압축이 일어났다) 시작 단계에서 건너뛴 것이다.
// 그래서 기록을 모델이 출력을 필요로 하는 자리로 옮겼다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'review-preflight.mjs')
const RULES = join(ROOT, 'review-rules')
const RUN = 'code-review-full-feat-x-2026-09-08'

const freshDir = t => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 일회용 저장소를 만들어 그 안에서 잰다.
 *
 * 이 저장소의 `main`을 base로 쓰면 **테스트가 주변 상태에 의존한다.** 실제로 CI의
 * 체크아웃에는 로컬 `main` ref가 없어서, 로컬에서 통과한 네 건이 거기서 전부
 * 깨졌다. 범위를 재는 스크립트를 검증하는 테스트가 재는 대상 저장소를 스스로
 * 만들지 않으면, 통과 여부가 "지금 어느 브랜치가 있는가"에 달린다.
 *
 * 커밋이 둘이라 base와 HEAD 사이에 파일 하나가 바뀐 상태가 된다. 한 번 만들어
 * 재사용하되 테스트는 읽기만 한다.
 */
let scratch = null
const scratchRepo = () => {
  if (scratch) return scratch
  const dir = mkdtempSync(join(tmpdir(), 'preflight-repo-'))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  writeFileSync(join(dir, 'b.txt'), 'b\n')
  git('add', '-A')
  git('commit', '-qm', 'change')
  scratch = { dir, base }
  return scratch
}
process.on('exit', () => {
  if (scratch) rmSync(scratch.dir, { recursive: true, force: true })
})

const preflight = (dir, extra = []) => {
  const repo = scratchRepo()
  return spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'full',
    '--repo', repo.dir, '--base', repo.base, '--host', 'test', ...extra,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const linesOf = dir => readFileSync(join(dir, '.timing', `${RUN}.jsonl`), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))

test('후보 수를 catalog에서 세고, 후보가 아닌 모듈은 이유와 함께 낸다', t => {
  // 한 리포트가 후보를 20개가 아니라 21개로 적었다 — synthesis 전용 모듈을
  // 후보로 세면서. 세는 일을 스크립트로 옮기면 그 오류가 생길 자리가 없다.
  const out = preflight(freshDir(t))
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /후보 모듈 +20개/)
  assert.match(out.stdout, /후보 아님 +00 — 공통 컨텍스트 전용/)
  assert.match(out.stdout, /후보 아님 +10 — post-verification-synthesis/)
  assert.match(out.stdout, /특수 패스 +props math exception/)
})

test('run.start를 사이드카에 남긴다', t => {
  const dir = freshDir(t)
  assert.equal(preflight(dir).status, 0)
  const [first] = linesOf(dir)
  assert.equal(first.phase, 'run.start')
  assert.equal(first.candidates, 20)
  assert.equal(first.host, 'test')
  assert.equal(first.workflow, 'full')
  assert.equal(typeof first.changedFiles, 'number')
  assert.match(first.version, /^\d+\.\d+\.\d+$/)
  // 규칙 경로와 버전은 서로 다른 설치에서 올 수 있다(C-1의 홈 사본). 둘을 각각
  // 남겨야 그 어긋남이 사이드카에 보인다.
  assert.equal(first.rules, RULES)
})

test('run.start에 무엇을 리뷰하는지를 남긴다 — 실행 ID, HEAD, 작업 트리, 저장소, 규칙 내용', t => {
  // 브랜치와 merge-base만으로는 두 실행이 같은 대상을 봤는지 말할 수 없다. 같은 HEAD에서
  // 작업 트리만 바뀐 두 실행이 기록상 똑같았다(#88 PR 0).
  const dir = freshDir(t)
  const repo = scratchRepo()
  const out = preflight(dir)
  assert.equal(out.status, 0, out.stderr)
  const [first] = linesOf(dir)
  assert.match(first.runId, /^[0-9a-f-]{36}$/)
  assert.equal(first.head, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim())
  assert.equal(first.base, repo.base)
  assert.equal(first.worktree, 'clean')
  assert.equal(first.dirtyFiles, 0)
  assert.equal(first.repoRoot, repo.base)
  assert.equal(first.repo, undefined, '원격이 없으면 필드를 비워 둔다 — 없는 값을 지어 넣지 않는다')
  assert.match(first.rulesDigest, /^sha256:[0-9a-f]{64}$/)
  assert.ok(out.stdout.includes(first.runId), out.stdout)
  assert.match(out.stdout, /작업 트리 +clean/)
})

test('리포트 디렉터리가 저장소 안이어도 작업 트리를 바꾼 것으로 세지 않는다', t => {
  // 기본 저장 위치 `./review-reports/`는 대상 저장소 안이다. preflight가 쓰는 타임라인이
  // 대상을 바꾼 것으로 보이면, 그 뒤의 어떤 비교도 같은 실행을 다른 대상으로 읽는다.
  const repoDir = mkdtempSync(join(tmpdir(), 'preflight-dirty-'))
  t.after(() => rmSync(repoDir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', [
    '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false',
    '-c', 'init.defaultBranch=main', ...args,
  ], { cwd: repoDir, stdio: 'ignore' })
  git('init', '-q')
  writeFileSync(join(repoDir, 'a.txt'), 'a\n')
  git('add', '-A')
  git('commit', '-qm', 'base')
  const reports = join(repoDir, 'review-reports')
  const run = (dir, name) => spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', name, '--rules', RULES, '--workflow', 'full',
    '--repo', repoDir, '--base', 'HEAD', '--host', 'test',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(run(reports, 'first').status, 0)
  const second = run(reports, 'second')
  assert.equal(second.status, 0, second.stderr)
  const read = name => JSON.parse(readFileSync(join(reports, '.timing', `${name}.jsonl`), 'utf8').split('\n')[0])
  assert.equal(read('second').worktree, 'clean')

  // 커밋하지 않은 변경은 대상이다. diff에는 없지만 파일을 읽는 단계는 그 내용을 본다.
  writeFileSync(join(repoDir, 'a.txt'), 'edited\n')
  const dirty = run(reports, 'third')
  assert.equal(dirty.status, 0, dirty.stderr)
  assert.match(read('third').worktree, /^sha256:/)
  assert.equal(read('third').dirtyFiles, 1)
  assert.match(dirty.stdout, /커밋하지 않은 변경 1개/)
})

test('선택 패스는 켰는지를 run.start에 남긴다 — 기본은 꺼짐이다', t => {
  // correctness 패스는 full에서 켰을 때만 돈다(#88 PR 1). 켰는지를 기록이 말하지 않으면,
  // 결과가 없는 것이 "안 켰다"인지 "켰는데 실패했다"인지 가를 수 없다.
  const off = freshDir(t)
  const outOff = preflight(off)
  assert.equal(outOff.status, 0, outOff.stderr)
  assert.equal(linesOf(off)[0].correctness, 'off')
  assert.match(outOff.stdout, /특수 패스 +props math exception —/)
  assert.match(outOff.stdout, /선택 패스 +correctness 꺼짐/)

  const on = freshDir(t)
  const outOn = preflight(on, ['--correctness', 'on'])
  assert.equal(outOn.status, 0, outOn.stderr)
  assert.equal(linesOf(on)[0].correctness, 'on')
  assert.match(outOn.stdout, /선택 패스 +correctness 켜짐/)
})

test('시간·호출 한도와 죽은 시도로 볼 시간을 run.start에 남긴다 — 주지 않은 한도는 없다', t => {
  // 작업 대장(C-12)이 이 값으로 디스패치를 멈춘다. 주지 않은 한도를 기본값으로 지어 넣으면 사용자가
  // 정하지 않은 이유로 리뷰가 멈춘다.
  const none = freshDir(t)
  assert.equal(preflight(none).status, 0)
  const plain = linesOf(none)[0]
  assert.equal(plain.maxTasks, undefined)
  assert.equal(plain.maxDurationSec, undefined)
  assert.equal(plain.staleAfterSec, 1200)

  const limited = freshDir(t)
  const out = preflight(limited, ['--max-duration', '30m', '--max-tasks', '40', '--stale-after', '15m', '--continues', 'run-before'])
  assert.equal(out.status, 0, out.stderr)
  const start = linesOf(limited)[0]
  assert.deepEqual([start.maxDurationSec, start.maxTasks, start.staleAfterSec, start.continues], [1800, 40, 900, 'run-before'])
  assert.match(out.stdout, /한도 +호출 40개 · 시간 30분/)
  assert.match(out.stdout, /이어 받음 +앞 실행 run-before/)
})

test('읽지 못하는 한도는 거부한다 — 잘못 읽은 한도는 한도가 없는 것보다 나쁘다', t => {
  for (const extra of [['--max-duration', '0'], ['--max-duration', '30 minutes'], ['--max-tasks', '0'], ['--max-tasks', '2.5'], ['--stale-after', 'soon']]) {
    const out = preflight(freshDir(t), extra)
    assert.equal(out.status, 2, extra.join(' '))
    assert.match(out.stderr, new RegExp(extra[0]))
  }
})

test('호스트가 시간 상한을 어디까지 지킬 수 있는지 함께 낸다', t => {
  const out = preflight(freshDir(t), ['--max-duration', '1h'])
  assert.equal(out.status, 0, out.stderr)
  // preflight 헬퍼는 --host test로 시작한다. 모르는 호스트에는 아무 능력도 가정하지 않는다.
  assert.match(out.stdout, /알려지지 않은 호스트 — 아무 능력도 가정하지 않는다/)
  assert.match(out.stdout, /멈추지 못한다/)
})

test('선택 패스가 없는 워크플로우에서 켜면 거부한다', t => {
  const dir = freshDir(t)
  const repo = scratchRepo()
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'props',
    '--repo', repo.dir, '--base', repo.base, '--host', 'test', '--correctness', 'on',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /correctness/)
  assert.equal(preflight(freshDir(t), ['--correctness', 'maybe']).status, 2)
})

test('--dry-run은 계산만 하고 쓰지 않는다', t => {
  const dir = freshDir(t)
  const out = preflight(dir, ['--dry-run'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /--dry-run, 쓰지 않았다/)
  assert.equal(existsSync(join(dir, '.timing', `${RUN}.jsonl`)), false)
})

test('--run이 .md로 끝나면 시작하지 않고 basename을 알려 준다', t => {
  // 2026-09-30의 한 실행은 리포트 파일 이름을 그대로 넘겨 기록이 전부 `….md.jsonl`로
  // 남았다. 끝에 가서 `--check`가 이름이 다르다고 짚었지만, 그때는 바꿀 수 없다.
  const dir = freshDir(t)
  const repo = scratchRepo()
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', `${RUN}.md`, '--rules', RULES, '--workflow', 'full',
    '--repo', repo.dir, '--base', repo.base, '--host', 'test',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.ok(out.stderr.includes(`"${RUN}"`), out.stderr)
  assert.equal(existsSync(join(dir, '.timing')), false)
})

test('이미 시작된 타임라인에 두 번째 시작을 얹지 않는다', t => {
  // 한 파일에 두 실행이 섞이면 어느 줄이 어느 실행인지 가릴 수 없다.
  const dir = freshDir(t)
  assert.equal(preflight(dir).status, 0)
  const again = preflight(dir)
  assert.equal(again.status, 2)
  assert.match(again.stderr, /이미 시작된 타임라인이다/)
  assert.equal(linesOf(dir).length, 1)
})

test('없는 규칙 경로는 거부한다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--rules', join(dir, 'nope'), '--workflow', 'full', '--repo', scratchRepo().dir,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /--rules not found/)
})

test('해석되지 않는 base는 조용히 HEAD로 바꾸지 않는다', t => {
  // 범위가 조용히 달라지면 리뷰가 무엇을 봤는지 리포트만 보고 알 수 없다.
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', freshDir(t), '--run', RUN, '--rules', RULES, '--workflow', 'full',
    '--repo', scratchRepo().dir, '--base', 'no-such-ref-here',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /맞춰볼 수 없다/)
})

test('인용을 빠뜨려 남은 토큰은 거부한다', t => {
  const dir = freshDir(t)
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', dir, '--run', RUN, '--rules', RULES, '--workflow', 'full', '--repo', scratchRepo().dir, '--host', '검토', '완료',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /unexpected argument/)
})

test('catalog에 없는 워크플로우는 거부한다', t => {
  const out = spawnSync(process.execPath, [
    SCRIPT, '--dir', freshDir(t), '--run', RUN, '--rules', RULES, '--workflow', 'nope', '--repo', scratchRepo().dir,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 2)
  assert.match(out.stderr, /catalog\.json에 없다/)
})

test('같은 플래그가 두 번 오면 거부한다', t => {
  // 값을 읽는 쪽은 첫 번째만 본다. 두 번째를 조용히 버리면 넘긴 값과 쓰인 값이
  // 다른데 아무도 모른다 — 실제로 이 테스트를 쓰다가 그 상태를 만들었다.
  const out = preflight(freshDir(t), ['--base', 'HEAD'])
  assert.equal(out.status, 2)
  assert.match(out.stderr, /두 번 왔다/)
})
