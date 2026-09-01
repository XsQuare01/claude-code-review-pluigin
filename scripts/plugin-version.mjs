#!/usr/bin/env node
// 지금 실제로 로드된 플러그인이 무엇인지 말한다.
//
// 버전만 찍는 것이 목적이 아니다. 리뷰 결과를 의심할 때 가장 먼저 확인해야
// 하는 것은 **어느 규칙으로 돌았는가**이고, 이 저장소는 그것 때문에 이미 여러
// 번 헛짚었다. C-1의 해석 순서가 홈 디렉터리 사본으로 끝나기 때문에, 설치가
// 조금만 어긋나도 리뷰는 멀쩡해 보이면서 낡은 규칙으로 돈다.
//
// 그래서 버전과 함께 **해석된 규칙 경로**와 홈 사본의 존재 여부를 같이 낸다.
//
// Usage:
//   node "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-version.mjs"
//   node "$RULES_DIR/../scripts/plugin-version.mjs" --json

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 이 스크립트는 플러그인 루트의 scripts/ 안에 있다. 자기 위치에서 루트를
// 되짚으면, cwd가 어디든 **이 사본**에 대해 답한다 — 물어본 것이 그것이다.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const countModules = dir => {
  if (!existsSync(dir)) return null
  return readdirSync(dir).filter(name => /^\d{2}-.*\.md$/.test(name)).length
}

const manifest = (() => {
  const path = join(ROOT, '.claude-plugin', 'plugin.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
})()

const rulesDir = join(ROOT, 'review-rules')
// C-1의 3번 경로. 여기 사본이 남아 있으면, CLAUDE_PLUGIN_ROOT를 세우지 않는
// 호스트에서 리뷰가 조용히 이쪽으로 내려간다.
const homeRules = join(homedir(), '.claude', 'review-rules')

const gitRef = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
})()

const skills = (() => {
  const dir = join(ROOT, 'skills')
  if (!existsSync(dir)) return null
  return readdirSync(dir).filter(name => existsSync(join(dir, name, 'SKILL.md'))).length
})()

const report = {
  name: manifest?.name ?? null,
  version: manifest?.version ?? null,
  root: ROOT,
  gitRef,
  rulesDir: existsSync(rulesDir) ? rulesDir : null,
  modules: countModules(rulesDir),
  skills,
  homeRulesDir: existsSync(homeRules) ? homeRules : null,
  homeRulesModules: countModules(homeRules),
}

if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exit(report.version ? 0 : 1)
}

// 한글은 터미널에서 두 칸을 차지한다. padEnd는 글자 수로 세므로 한글 라벨과
// 라틴 라벨이 섞이면 열이 어긋난다 — 글자 수가 아니라 폭으로 맞춘다.
const width = text => [...text].reduce((sum, char) => sum + (/[가-힣]/.test(char) ? 2 : 1), 0)
const line = (label, value) => `${label}${' '.repeat(Math.max(1, 14 - width(label)))}${value}\n`
let out = ''
// 버전을 못 읽는 것과 "0"은 다르다. 읽지 못했으면 그렇게 말한다.
out += report.version
  ? `${report.name} ${report.version}\n\n`
  : `플러그인 매니페스트를 읽지 못했다 — ${join(ROOT, '.claude-plugin', 'plugin.json')}\n\n`
out += line('설치 경로', report.root)
if (report.gitRef) out += line('git', report.gitRef)
out += line('규칙 경로', report.rulesDir ?? '(없음 — 이 사본에는 review-rules/가 없다)')
if (report.modules !== null) out += line('규칙 모듈', `${report.modules}개`)
if (report.skills !== null) out += line('스킬', `${report.skills}개`)

if (report.homeRulesDir) {
  out += `\n주의: 홈에 규칙 사본이 있다 — ${report.homeRulesDir} (모듈 ${report.homeRulesModules}개)\n`
  out += `      CLAUDE_PLUGIN_ROOT를 세우지 않는 호스트에서는 리뷰가 이쪽을 쓴다(C-1의 3번 경로).\n`
  if (report.modules !== null && report.homeRulesModules !== report.modules) {
    out += `      이 사본(${report.modules}개)과 모듈 수가 다르다. 같은 규칙이 아니다.\n`
  }
}

process.stdout.write(out)
process.exit(report.version ? 0 : 1)
