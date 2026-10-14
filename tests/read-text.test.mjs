import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decodeText, readJsonFile, readTextFile } from '../scripts/lib/read-text.mjs'

// 실행 중에 오케스트레이터가 쓴 파일을 읽는 공용 길을 고정한다. PowerShell 5.1의 `Set-Content -Encoding UTF8`은
// BOM을 붙이고, 기본 `Out-File`은 UTF-16LE로 쓴다. 2026-10-13 실행은 BOM이 붙은 `.planned.json`을 기록 스크립트는
// 받고 렌더러는 받지 못해 렌더를 다시 돌렸다 — 고친 자리가 아닌 곳에서 같은 일이 다시 났다.

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const VALUE = { skipped: [{ module: 'math', evidence: '행렬 연산 없음' }] }
const TEXT = JSON.stringify(VALUE)

test('UTF-8·UTF-8 BOM·UTF-16LE·UTF-16BE를 같은 텍스트로 읽는다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'read-text-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const be = Buffer.from(`﻿${TEXT}`, 'utf16le')
  be.swap16()
  const files = {
    'plain.json': Buffer.from(TEXT, 'utf8'),
    'bom.json': Buffer.from(`﻿${TEXT}`, 'utf8'),
    'utf16le.json': Buffer.from(`﻿${TEXT}`, 'utf16le'),
    'utf16be.json': be,
  }
  for (const [name, bytes] of Object.entries(files)) {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    assert.equal(readTextFile(path), TEXT, name)
    assert.deepEqual(readJsonFile(path), VALUE, name)
  }
  assert.equal(decodeText(Buffer.from('')), '')
})

test('읽지 못하거나 JSON이 아니면 던진다 — 빈 값으로 바꾸지 않는다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'read-text-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.throws(() => readTextFile(join(dir, 'missing.json')), /ENOENT/)
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{"skipped": [', 'utf8')
  assert.throws(() => readJsonFile(broken), SyntaxError)
})

test('스크립트는 경로로 받은 JSON을 공용 리더로 읽는다 — 플러그인이 싣고 오는 파일만 직접 읽는다', () => {
  // 처음에는 BOM을 겪은 자리마다 따로 막았고, 막지 않은 자리에서 다시 났다. 새로 생기는 자리도 이 길을 쓰게 한다.
  const SHIPPED = /catalog\.json|plugin\.json|case\.json|expected\.json/
  const offenders = []
  for (const folder of ['scripts', join('scripts', 'lib')]) {
    for (const name of readdirSync(join(ROOT, folder)).filter(file => file.endsWith('.mjs'))) {
      // 평가 하네스는 리뷰 실행이 아니라 이 저장소의 fixture를 읽는다
      if (name.startsWith('eval-')) continue
      // 설치본 하나만 복사해 돌리는 스크립트라 lib를 가져올 수 없다 — 읽는 것도 플러그인 자신의 매니페스트뿐이다
      if (name === 'plugin-version.mjs') continue
      readFileSync(join(ROOT, folder, name), 'utf8').split('\n').forEach((line, at) => {
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*')) return
        if (code.includes('JSON.parse(readFileSync(') && !SHIPPED.test(code)) offenders.push(`${folder}/${name}:${at + 1}`)
      })
    }
  }
  assert.deepEqual(offenders, [])
})
