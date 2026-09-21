import { test } from 'node:test'
import assert from 'node:assert/strict'

import { markedBlock, markedJson } from '../scripts/lib/contract-blocks.mjs'

// 블록을 꺼내는 일은 validator와 렌더러가 똑같이 한다. 두 벌을 두면 한쪽만
// 고쳐질 수 있고, 그러면 같은 계약 파일을 두 도구가 다르게 읽는다.

const doc = [
  '앞 문단',
  '<!-- SAMPLE:BEGIN -->',
  '```json',
  '{ "a": 1 }',
  '```',
  '<!-- SAMPLE:END -->',
  '뒤 문단',
].join('\n')

test('라벨 사이의 내용을 꺼낸다', () => {
  const out = markedBlock(doc, 'SAMPLE')
  assert.equal(out.error, undefined)
  assert.equal(out.value, '```json\n{ "a": 1 }\n```')
})

test('블록이 없으면 사유를 낸다', () => {
  const out = markedBlock('내용 없음', 'SAMPLE')
  assert.match(out.error, /SAMPLE/)
  assert.equal(out.value, undefined)
})

test('블록이 두 번 나오면 거부한다', () => {
  const out = markedBlock(doc + '\n' + doc, 'SAMPLE')
  assert.match(out.error, /정확히 한 번/)
})

test('END가 BEGIN보다 앞서면 거부한다', () => {
  const broken = '<!-- SAMPLE:END -->\n<!-- SAMPLE:BEGIN -->'
  assert.match(markedBlock(broken, 'SAMPLE').error, /끝이 시작보다 앞/)
})

test('json 코드펜스를 파싱한다', () => {
  assert.deepEqual(markedJson(doc, 'SAMPLE').value, { a: 1 })
})

test('json이 아니면 사유를 낸다', () => {
  const plain = '<!-- S:BEGIN -->\n그냥 글\n<!-- S:END -->'
  assert.match(markedJson(plain, 'S').error, /json 코드펜스/)
})
