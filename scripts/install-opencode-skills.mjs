#!/usr/bin/env node
// 이 플러그인의 스킬을 opencode가 읽는 자리에 놓는다.
//
// opencode는 Claude Code 플러그인을 로드하지 않는다 — `--plugin-dir`가 없고,
// `/react-code-review-plugin:code-review-full` 같은 슬래시 명령도 없다. 다만
// **스킬 규약은 같다**: `skills/**/SKILL.md`를 `name`/`description`
// 프론트매터로 읽고, 프로젝트 스코프는 `<project>/.opencode/skills/`다.
// 그래서 옮겨야 할 것은 코드가 아니라 파일 위치뿐이다.
//
// Usage:
//   node scripts/install-opencode-skills.mjs                 # 이 저장소에 설치
//   node scripts/install-opencode-skills.mjs --target <dir>  # fixture 등에 설치
//   node scripts/install-opencode-skills.mjs --target <dir> --check
//
// 검증은 `opencode debug skill`로 한다 — 모델을 부르지 않으므로 토큰이 들지 않는다.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const die = message => {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) die(`--${name} needs a value`)
  return value
}
const has = name => process.argv.includes(`--${name}`)

const target = flag('target', ROOT)
if (!existsSync(target)) die(`target not found: ${target}`)

// 스킬과 규칙을 **함께** 놓는다.
//
// C-1의 RULES_DIR 해석 순서가 이유다: 1) ${CLAUDE_PLUGIN_ROOT}/review-rules/,
// 2) ./review-rules/, 3) ~/.claude/review-rules/. opencode는 1번을 만들지
// 않으므로 2번이 없으면 **3번으로 조용히 내려간다** — 홈에 남아 있는 낡은
// 사본이다. 그러면 리뷰는 멀쩡해 보이는데 다른 규칙 버전으로 돈다.
//
// 이 저장소가 잡으려는 실패가 정확히 그 종류라, 여기서는 규칙을 반드시 같이
// 놓고 마지막에 존재를 확인한다.
const PARTS = [
  { from: 'skills', to: join('.opencode', 'skills'), why: 'opencode 프로젝트 스킬 경로' },
  { from: 'review-rules', to: 'review-rules', why: 'C-1의 2번 경로 — 없으면 홈의 낡은 사본으로 내려간다' },
  { from: '.claude-plugin', to: '.claude-plugin', why: '리포트에 적을 플러그인 버전(C-1)' },
  // 스킬이 `$RULES_DIR/../scripts/*.mjs`를 **실행한다** — 위치 대조
  // (prepare-verification.mjs)와 실행 타임라인(review-timeline.mjs)이 여기 있다.
  // 빠뜨리면 둘 다 조용히 건너뛰어지고, 리포트는 그 사실을 말하지 않는다.
  { from: 'scripts', to: 'scripts', why: '스킬이 실행하는 헬퍼 — 없으면 위치 대조와 타임라인이 조용히 빠진다' },
]

const check = () => {
  const missing = PARTS.filter(part => !existsSync(join(target, part.to)))
  const skillsDir = join(target, '.opencode', 'skills')
  const installed = existsSync(skillsDir) ? readdirSync(skillsDir) : []
  return { missing, installed }
}

if (has('check')) {
  const { missing, installed } = check()
  for (const part of missing) process.stdout.write(`MISSING ${part.to} — ${part.why}\n`)
  process.stdout.write(`skills: ${installed.length ? installed.join(', ') : '(없음)'}\n`)
  process.exit(missing.length ? 1 : 0)
}

for (const part of PARTS) {
  const from = join(ROOT, part.from)
  if (!existsSync(from)) die(`source not found: ${from}`)
  const to = join(target, part.to)
  // 같은 자리면 덮어쓰지 않는다. 이 저장소 자신에 설치할 때 review-rules를
  // 자기 자신 위에 복사하는 것을 막는다.
  if (from === to) {
    process.stdout.write(`skip  ${part.to} (원본과 같은 자리)\n`)
    continue
  }
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true })
  process.stdout.write(`copy  ${part.from} → ${part.to}\n`)
}

const { missing, installed } = check()
if (missing.length) die(`설치가 불완전하다: ${missing.map(part => part.to).join(', ')}`)
process.stdout.write(`\n설치 완료: ${target}\n`)
process.stdout.write(`스킬 ${installed.length}개: ${installed.join(', ')}\n`)
process.stdout.write(`확인: opencode debug skill  (모델 호출 없음)\n`)
