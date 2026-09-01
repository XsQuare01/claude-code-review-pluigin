import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `/code-review-version`이 실제로 답하는 것을 고정한다.
//
// 버전 숫자만 찍는 명령이 아니다. 리뷰 결과를 의심할 때 먼저 확인해야 하는
// 것은 **어느 규칙으로 돌았는가**이고, C-1의 해석 순서가 홈 디렉터리 사본으로
// 끝나기 때문에 설치가 어긋나면 리뷰가 멀쩡해 보이면서 낡은 규칙으로 돈다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'plugin-version.mjs')

const run = (script = SCRIPT, args = []) => spawnSync(process.execPath, [script, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

test('매니페스트의 이름과 버전을 낸다', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  const out = run()
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, new RegExp(`${manifest.name} ${manifest.version.replace(/\./g, '\\.')}`))
})

test('cwd가 어디든 자기 사본에 대해 답한다', t => {
  // 물어본 것은 "지금 로드된 플러그인"이다. cwd를 따라가면 엉뚱한 저장소의
  // 버전을 답할 수 있다.
  const elsewhere = mkdtempSync(join(tmpdir(), 'cwd-'))
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }))
  const out = spawnSync(process.execPath, [SCRIPT], { cwd: elsewhere, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(out.status, 0)
  assert.match(out.stdout, /react-code-review-plugin/)
})

test('--json은 기계가 읽을 형태로 같은 값을 낸다', () => {
  const parsed = JSON.parse(run(SCRIPT, ['--json']).stdout)
  const manifest = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
  assert.equal(parsed.version, manifest.version)
  assert.equal(parsed.name, manifest.name)
  assert.ok(parsed.modules > 0)
  assert.ok(parsed.skills > 0)
})

test('규칙 모듈 수가 validate-rules와 같은 기준으로 세어진다', () => {
  // 두 곳이 다른 수를 말하면, 어느 쪽이 맞는지 확인하러 가야 한다 —
  // 이 명령이 없애려던 왕복이 그대로 생긴다.
  const parsed = JSON.parse(run(SCRIPT, ['--json']).stdout)
  const validated = spawnSync(process.execPath, [join(ROOT, 'scripts', 'validate-rules.mjs')],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const claimed = validated.stdout.match(/(\d+) numbered modules/)
  assert.ok(claimed, `validate-rules가 모듈 수를 내지 않았다: ${validated.stdout}`)
  assert.equal(parsed.modules, Number(claimed[1]))
})

// ── 매니페스트를 못 읽는 사본 ──────────────────────────────────────────────

const fakeCopy = t => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-copy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(join(ROOT, 'scripts', 'plugin-version.mjs'), join(dir, 'scripts', 'plugin-version.mjs'), { recursive: true })
  return dir
}

test('매니페스트가 없으면 0을 지어내지 않고 사유를 낸다', t => {
  const copy = fakeCopy(t)
  const out = run(join(copy, 'scripts', 'plugin-version.mjs'))
  assert.equal(out.status, 1)
  assert.match(out.stdout, /매니페스트를 읽지 못했다/)
})

test('규칙 디렉터리가 없으면 없다고 말한다', t => {
  const copy = fakeCopy(t)
  const out = run(join(copy, 'scripts', 'plugin-version.mjs'))
  assert.match(out.stdout, /review-rules\/가 없다/)
})

test('매니페스트가 깨져도 던지지 않는다', t => {
  const copy = fakeCopy(t)
  writeFileSync(join(copy, 'scripts', '..', 'broken.json'), '{', 'utf8')
  cpSync(join(copy, 'broken.json'), join(copy, '.claude-plugin', 'plugin.json'), { recursive: true })
  const out = run(join(copy, 'scripts', 'plugin-version.mjs'))
  assert.equal(out.status, 1)
  assert.match(out.stdout, /매니페스트를 읽지 못했다/)
  assert.equal(out.stderr, '')
})
