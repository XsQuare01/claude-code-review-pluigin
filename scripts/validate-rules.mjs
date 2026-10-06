#!/usr/bin/env node
// Consistency validator for the review-rules plugin.
//
// Checks the properties this repository promises but cannot enforce by hand:
// module inventory, rule-ID/prefix agreement, cross-reference targets, README
// inventory, skill references, fast-digest sync, hard-coded paths, catalog
// coverage, and plugin manifests.
//
// No dependencies. Run: node scripts/validate-rules.mjs

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { checkProducerWriteAccess, parseAgentTools } from './lib/producer-tools.mjs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEffectiveCommonContext } from './lib/effective-common-context-validator.mjs'
import { markedBlock, CROSS_VERIFICATION_TOKEN_KEYS } from './lib/contract-blocks.mjs'
import {
  addError, hasOwn, manifestAllowedSet, scanForbiddenSeverity, validateLocationAgainst, validatePlainObject,
  validateRequiredString, validateUnknownKeys, validateVerdictPayload,
} from './lib/contract-validate.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RULES = join(ROOT, 'review-rules')
const SKILLS = join(ROOT, 'skills')

const problems = []
const fail = (check, message) => problems.push({ check, message })
const failCode = (check, code, message) => fail(check, `${code}: ${message}`)

const read = p => readFileSync(p, 'utf8')
const rulesFile = name => read(join(RULES, name))

function walkFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(path))
    else files.push(path)
  }
  return files.sort()
}

// 블록을 자르는 실제 로직은 scripts/lib/contract-blocks.mjs 에 있다. 렌더러도
// 같은 계약 파일을 읽어야 해서 그 헬퍼는 순수 함수(예외 대신 값 반환)로
// 뺐고, 여기서는 validator의 실패 수집 방식(failCode)에 감싸 쓴다.
function extractMarkedBlock(text, label, check, code) {
  const out = markedBlock(text, label)
  if (out.error) {
    failCode(check, code, out.error)
    return null
  }
  return out.value
}

function parseJsonCodeBlock(block, label, check, code) {
  const match = block.match(/^```json\s*([\s\S]*?)\s*```$/)
  if (!match) {
    failCode(check, code, `${label} block must contain exactly one json fenced block`)
    return null
  }
  try {
    return JSON.parse(match[1])
  } catch (error) {
    failCode(check, code, `${label} block contains invalid JSON: ${error.message}`)
    return null
  }
}

const STRUCTURED_PRODUCER_MARKER = 'REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT'
const STRUCTURED_OWNER_CONSUMERS = {
  'skills/code-review-full/SKILL.md': ['validation', 'aggregation', 'rendering'],
  'skills/code-review-props/SKILL.md': ['validation', 'rendering'],
  'skills/code-review-math/SKILL.md': ['validation', 'rendering'],
  'skills/code-review-exception/SKILL.md': ['validation', 'rendering'],
}
const STRUCTURED_OWNER_POLICY_BEARING_COMMON_CONTEXTS = {
  'skills/code-review-full/SKILL.md': ['review-rules/00-rule.md'],
  'skills/code-review-props/SKILL.md': ['review-rules/00-rule.md'],
  'skills/code-review-math/SKILL.md': ['review-rules/00-rule.md'],
  'skills/code-review-exception/SKILL.md': ['review-rules/00-rule.md'],
}
const LEGACY_WORKFLOW_FILES = [
  'skills/code-review/SKILL.md',
  'skills/code-review-commit/SKILL.md',
  'skills/code-review-fast/SKILL.md',
]
let CONTRACT_MANIFEST_CACHE = null

function getContractManifest() {
  if (CONTRACT_MANIFEST_CACHE) return CONTRACT_MANIFEST_CACHE
  const workflowContract = rulesFile('workflow-contract.md')
  const block = extractMarkedBlock(workflowContract, 'REVIEW_RESULT_CONTRACT_V1', 'structured-contract', 'E_MANIFEST_BLOCK_COUNT')
  if (!block) return null
  const manifest = parseJsonCodeBlock(block, 'REVIEW_RESULT_CONTRACT_V1', 'structured-contract', 'E_MANIFEST_JSON')
  if (!manifest) return null
  CONTRACT_MANIFEST_CACHE = manifest
  return CONTRACT_MANIFEST_CACHE
}

function getManifestDerivedSchema() {
  const manifest = getContractManifest()
  if (!manifest) return null
  const categoryIds = Array.isArray(manifest.impact?.categoryEnum) ? manifest.impact.categoryEnum : []
  const categoryLabels = manifest.impact?.categoryLabels ?? {}
  return {
    manifest,
    topLevelAllowed: manifestAllowedSet(manifest.topLevel?.allowed),
    findingAllowed: manifestAllowedSet(manifest.findingsItem?.allowed),
    openQuestionAllowed: manifestAllowedSet(manifest.openQuestionsItem?.allowed),
    locationAllowed: {
      verified: manifestAllowedSet(manifest.location?.variants?.verified?.allowed),
      deleted: manifestAllowedSet(manifest.location?.variants?.deleted?.allowed),
      unverified: manifestAllowedSet(manifest.location?.variants?.unverified?.allowed),
    },
    categoryIds,
    categoryLabels,
  }
}

function sameMembers(actual, expected) {
  return actual.length === expected.length && expected.every(value => actual.includes(value))
}

function sameEntries(actual, expected) {
  const actualKeys = Object.keys(actual).sort()
  const expectedKeys = Object.keys(expected).sort()
  return sameMembers(actualKeys, expectedKeys) && expectedKeys.every(key => actual[key] === expected[key])
}

function isLowerKebabCase(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
}

function parseClosedListLabelsFromCommonRules(text) {
  const labels = []
  const closedListSection = text.slice(text.indexOf('### 영향도'), text.indexOf('### 확신도'))
  for (const match of closedListSection.matchAll(/^- .*\(`([^`]+)`\)/gm)) labels.push(match[1])
  return labels
}

function listMissing(text, tokens) {
  return tokens.filter(token => !text.includes(token))
}

function validateMarkdownBlocks(relativePath, text, check) {
  const fenceCount = (text.match(/^```/gm) ?? []).length
  if (fenceCount % 2 !== 0) {
    failCode(check, 'E_MARKDOWN_UNBALANCED_FENCE', `${relativePath} has an unbalanced fenced code block count (${fenceCount})`)
  }

  const markerCounts = new Map()
  for (const [, label, kind] of text.matchAll(/<!--\s*([A-Z0-9_-]+):(BEGIN|END)\s*-->/g)) {
    if (!markerCounts.has(label)) markerCounts.set(label, { BEGIN: 0, END: 0 })
    markerCounts.get(label)[kind] += 1
  }
  for (const [label, counts] of markerCounts) {
    if (counts.BEGIN !== counts.END) {
      failCode(check, 'E_MARKDOWN_ORPHAN_BLOCK', `${relativePath} has mismatched block markers for ${label} (BEGIN=${counts.BEGIN}, END=${counts.END})`)
    }
  }
}

function validateLocation(location, errors, where) {
  validateLocationAgainst(getContractManifest(), location, errors, where)
}

function validateFinding(item, errors, where) {
  const schema = getManifestDerivedSchema()
  if (!validatePlainObject(item, errors, 'E_FINDING_NOT_OBJECT', where)) return
  validateUnknownKeys(item, schema?.findingAllowed ?? new Set(), errors, 'E_FINDING_UNKNOWN_KEY', where)
  for (const key of ['ruleId', 'title', 'body']) validateRequiredString(item, key, errors, `E_FINDING_REQUIRES_${key.toUpperCase()}`, where)
  if (!['high', 'low'].includes(item.impact)) addError(errors, 'E_FINDING_INVALID_IMPACT', `${where}.impact must be high or low`)
  if (!['high', 'low'].includes(item.confidence)) addError(errors, 'E_FINDING_INVALID_CONFIDENCE', `${where}.confidence must be high or low`)
  validateLocation(item.location, errors, `${where}.location`)
  if (item.impact === 'high') {
    if (!hasOwn(item, 'category')) addError(errors, 'E_FINDING_HIGH_REQUIRES_CATEGORY', `${where}.category is required when impact is high`)
    else if (!(schema?.categoryIds ?? []).includes(item.category)) addError(errors, 'E_FINDING_INVALID_CATEGORY', `${where}.category must be one of the five approved IDs`)
    if (!hasOwn(item, 'evidence') || typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      addError(errors, 'E_FINDING_HIGH_REQUIRES_EVIDENCE', `${where}.evidence is required when impact is high`)
    }
  }
  if (item.impact === 'low' && hasOwn(item, 'category')) addError(errors, 'E_FINDING_LOW_FORBIDS_CATEGORY', `${where}.category is forbidden when impact is low`)
  if (item.confidence === 'low' && (!hasOwn(item, 'reason') || typeof item.reason !== 'string' || item.reason.trim() === '')) {
    addError(errors, 'E_FINDING_LOW_CONFIDENCE_REQUIRES_REASON', `${where}.reason is required when confidence is low`)
  }
}

function validateOpenQuestion(item, errors, where) {
  const schema = getManifestDerivedSchema()
  if (!validatePlainObject(item, errors, 'E_OPEN_QUESTION_NOT_OBJECT', where)) return
  validateUnknownKeys(item, schema?.openQuestionAllowed ?? new Set(), errors, 'E_OPEN_QUESTION_UNKNOWN_KEY', where)
  for (const key of ['title', 'body', 'reason']) validateRequiredString(item, key, errors, `E_OPEN_QUESTION_REQUIRES_${key.toUpperCase()}`, where)
  validateLocation(item.location, errors, `${where}.location`)
}

function validateReviewResultContract(value) {
  const schema = getManifestDerivedSchema()
  const errors = []
  if (!validatePlainObject(value, errors, 'E_TOPLEVEL_NOT_OBJECT', 'result')) return errors
  scanForbiddenSeverity(value, errors, 'result')
  validateUnknownKeys(value, schema?.topLevelAllowed ?? new Set(), errors, 'E_TOPLEVEL_UNKNOWN_KEY', 'result')
  if (!hasOwn(value, 'schemaVersion')) addError(errors, 'E_TOPLEVEL_MISSING_SCHEMA_VERSION', 'result.schemaVersion is required')
  else if (value.schemaVersion !== 1) addError(errors, 'E_TOPLEVEL_INVALID_SCHEMA_VERSION', 'result.schemaVersion must be 1')
  if (!hasOwn(value, 'findings')) addError(errors, 'E_TOPLEVEL_MISSING_FINDINGS', 'result.findings is required')
  else if (!Array.isArray(value.findings)) addError(errors, 'E_TOPLEVEL_FINDINGS_NOT_ARRAY', 'result.findings must be an array')
  if (!hasOwn(value, 'openQuestions')) addError(errors, 'E_TOPLEVEL_MISSING_OPEN_QUESTIONS', 'result.openQuestions is required')
  else if (!Array.isArray(value.openQuestions)) addError(errors, 'E_TOPLEVEL_OPEN_QUESTIONS_NOT_ARRAY', 'result.openQuestions must be an array')
  if (Array.isArray(value.findings)) value.findings.forEach((item, index) => validateFinding(item, errors, `result.findings[${index}]`))
  if (Array.isArray(value.openQuestions)) value.openQuestions.forEach((item, index) => validateOpenQuestion(item, errors, `result.openQuestions[${index}]`))
  return errors
}

function nearestHeadingSlice(text, anchor) {
  const headingRegex = /^## .*$/gm
  let start = 0
  let match
  while ((match = headingRegex.exec(text))) {
    if (match.index > anchor) break
    start = match.index
  }
  let end = text.length
  headingRegex.lastIndex = anchor
  const next = headingRegex.exec(text)
  if (next) end = next.index
  return text.slice(start, end)
}

const EXPLICIT_STRUCTURED_PRODUCER_FILES = [
  'skills/code-review-full/SKILL.md',
  'skills/code-review-props/SKILL.md',
  'skills/code-review-math/SKILL.md',
  'skills/code-review-exception/SKILL.md',
]

/**
 * Rule-ID-shaped tokens, e.g. 03-1, 10-SSOT, 16-8.
 * The lookbehind rejects `path.ts:20-46` and `src/20-46`, which are line ranges, not rule ids.
 */
const RULE_ID = /(?<![\w\-:/.])(\d{2})-([A-Za-z][A-Za-z0-9]*|\d+)(?![\w-])/g
/** Numbered module filenames, e.g. 03-react-rules.md */
const MODULE_FILE = /\b\d{2}-[a-z0-9-]+\.md\b/g
/** Section headings that declare a rule, e.g. "## 03-1. ..." or "### 10-SSOT (…)". */
const RULE_HEADING = /^#{2,3}\s+((\d{2})-([A-Za-z][A-Za-z0-9]*|\d+))(?:[.\s]|$)/

const WORKFLOW_NAMES = ['default', 'full', 'fast', 'commit', 'props', 'math', 'exception']
/** Headings that are structural, not reviewable rules. */
const STRUCTURAL = new Set(['CHECK', 'OUTPUT', 'SCOPE', 'JUDGE'])

// ---------------------------------------------------------------- inventory

const allFiles = readdirSync(RULES).sort()
const moduleFiles = allFiles.filter(f => /^\d{2}-.*\.md$/.test(f))
const numbers = moduleFiles.map(f => f.slice(0, 2))
const STRUCTURED_PRODUCER_FILES = [...EXPLICIT_STRUCTURED_PRODUCER_FILES]
const RULE_MODULE_NEUTRALITY_FILES = [
  ...moduleFiles.filter(file => file !== '00-rule.md').map(file => `review-rules/${file}`),
  'review-rules/props.md',
  'review-rules/math.md',
  'review-rules/exception.md',
  'review-rules/correctness.md',
]

// 1. contiguous numbering, no duplicates
{
  const seen = new Set()
  for (const n of numbers) {
    if (seen.has(n)) fail('inventory', `duplicate module number ${n}`)
    seen.add(n)
  }
  const ints = [...seen].map(Number).sort((a, b) => a - b)
  if (ints[0] !== 0) fail('inventory', `module numbering must start at 00, found ${ints[0]}`)
  for (let i = 1; i < ints.length; i++) {
    if (ints[i] !== ints[i - 1] + 1) {
      fail('inventory', `gap in module numbering between ${ints[i - 1]} and ${ints[i]}`)
    }
  }
}

// ------------------------------------------------------- rule id extraction

/** moduleNumber -> Set(ruleId) */
const ruleIds = new Map()
/** ruleId -> { severity, qualifier } for conditional rules */
const ruleMeta = new Map()

for (const file of moduleFiles) {
  const num = file.slice(0, 2)
  const ids = new Set()
  ruleIds.set(num, ids)

  for (const line of rulesFile(file).split('\n')) {
    const m = line.match(RULE_HEADING)
    if (!m) continue
    const [, id, prefix, suffix] = m

    // 2. prefix agreement
    if (prefix !== num) {
      fail('rule-id', `${file}: heading "${id}" does not match the file prefix ${num}`)
    }
    if (STRUCTURAL.has(suffix.toUpperCase())) continue

    // 3. duplicates
    if (ids.has(id)) fail('rule-id', `${file}: duplicate rule id ${id}`)
    ids.add(id)

    const severity = (line.match(/[🔴🟡🔵]/) || [])[0] ?? null
    const qualifier = (line.match(/\*\(([^)]+)\)\*/) || [])[1] ?? null
    ruleMeta.set(id, { file, severity, qualifier })
  }
}

const knownModule = n => ruleIds.has(n)
const knownRule = id => ruleMeta.has(id)

// ------------------------------------------------------- cross-references

for (const file of allFiles.filter(f => f.endsWith('.md'))) {
  const text = rulesFile(file)

  // referenced module files must exist
  for (const ref of text.match(MODULE_FILE) ?? []) {
    if (!existsSync(join(RULES, ref))) {
      fail('cross-ref', `${file}: references missing module file ${ref}`)
    }
  }

  // referenced rule ids must exist — strip filenames first so 01-fsd.md is not read as a rule
  const stripped = text.replace(MODULE_FILE, '')
  for (const [, prefix, suffix] of stripped.matchAll(RULE_ID)) {
    const id = `${prefix}-${suffix}`
    if (!knownModule(prefix)) continue // not a module reference (dates, versions, …)
    if (STRUCTURAL.has(suffix.toUpperCase())) continue
    if (/^x$/i.test(suffix) || /^n$/i.test(suffix)) continue // ID format placeholders
    if (!knownRule(id)) {
      fail('cross-ref', `${file}: references rule ${id}, which does not exist in ${prefix}`)
    }
  }
}

// ------------------------------------------------------------------ README

{
  const readme = read(join(ROOT, 'README.md'))
  const listed = new Map()
  for (const [, num, name] of readme.matchAll(/^\|\s*(\d{2})\s*\|\s*`([^`]+)`/gm)) {
    listed.set(num, name)
  }
  for (const file of moduleFiles) {
    const num = file.slice(0, 2)
    if (!listed.has(num)) fail('readme', `module ${file} is missing from the README inventory`)
    else if (listed.get(num) !== file) {
      fail('readme', `README lists ${listed.get(num)} for ${num}, actual file is ${file}`)
    }
  }
  for (const num of listed.keys()) {
    if (!knownModule(num)) fail('readme', `README lists module ${num}, which has no file`)
  }
  for (const file of allFiles) {
    if (!readme.includes(file)) fail('readme', `${file} is not mentioned anywhere in the README`)
  }
}

// ------------------------------------------------------------------ skills

const skillDirs = readdirSync(SKILLS).filter(d => existsSync(join(SKILLS, d, 'SKILL.md')))

for (const dir of skillDirs) {
  const path = join(SKILLS, dir, 'SKILL.md')
  const text = read(path)
  const where = `skills/${dir}/SKILL.md`

  // 6a. must defer to the shared contract
  if (!text.includes('workflow-contract.md')) {
    fail('skill', `${where}: does not reference workflow-contract.md`)
  }

  // 6b. declared workflow-name must be registered
  const declared = [...text.matchAll(/`workflow-name`(?:은|는)?\s*\|?\s*`([a-z]+)`/g)].map(m => m[1])
  for (const name of declared) {
    if (!WORKFLOW_NAMES.includes(name)) {
      fail('skill', `${where}: unregistered workflow-name "${name}"`)
    }
  }
  if (declared.length === 0) fail('skill', `${where}: does not declare a workflow-name`)

  // 6c. referenced rule documents must exist
  for (const [, ref] of text.matchAll(/\$?\{?RULES_DIR\}?\/([A-Za-z0-9._-]+)/g)) {
    if (ref.includes('*') || ref.startsWith('[')) continue
    if (!existsSync(join(RULES, ref))) {
      fail('skill', `${where}: references ${ref}, which does not exist in review-rules/`)
    }
  }

  // 8. no re-introduced hard-coded home path
  if (text.includes('~/.claude/review-rules')) {
    fail('hardcoded-path', `${where}: hard-codes ~/.claude/review-rules — use the contract's resolution order`)
  }
}

// the fallback path belongs in exactly one place
{
  const contract = rulesFile('workflow-contract.md')
  if (!contract.includes('~/.claude/review-rules/')) {
    fail('hardcoded-path', 'workflow-contract.md: lost the ~/.claude/review-rules fallback from the resolution order')
  }
}

/**
 * Distinctive words from a rule's applicability qualifier, e.g.
 * "*(contract 제공자일 때)*" -> ["contract", "제공자일"].
 * Generic words are dropped so a match means the digest really carried the condition.
 */
const CONDITION_STOPWORDS = new Set([
  '적용', '전용', '경우', '프로젝트', '프로젝트에만', '코드', '코드에만', '쓰는', '있을', '때', '때만', '해당',
])
function conditionKeywords(qualifier) {
  const latin = qualifier.match(/[A-Za-z][A-Za-z0-9/+.]{2,}/g) ?? []
  const korean = (qualifier.match(/[가-힣]{2,}/g) ?? []).filter(w => !CONDITION_STOPWORDS.has(w))
  return [...latin, ...korean]
}

// ------------------------------------------------------------- fast digest

{
  const fast = rulesFile('fast.md')
  const sections = new Map()
  for (const [, num, body] of fast.matchAll(/^## (\d{2})\..*$([\s\S]*?)(?=^## |\Z)/gm)) {
    sections.set(num, body)
  }

  for (const file of moduleFiles) {
    const num = file.slice(0, 2)
    if (num === '00') continue // common rules appear under a differently-titled section
    if (!sections.has(num)) {
      fail('fast-sync', `fast.md: no section for module ${file}`)
      continue
    }
    const section = sections.get(num)
    const source = rulesFile(file)

    // 7a. a module with a trigger must keep its applicability in the digest
    if (source.includes('## Trigger') && !section.includes('적용 조건')) {
      fail('fast-sync', `fast.md section ${num}: source module has a Trigger section but the digest states no 적용 조건`)
    }

    // 7b. conditional rules must keep their severity and their condition
    for (const [id, meta] of ruleMeta) {
      if (!id.startsWith(`${num}-`) || !meta.qualifier || !meta.severity) continue
      if (!section.includes(meta.severity)) {
        fail('fast-sync', `fast.md section ${num}: ${id} is ${meta.severity} in the source but that severity is absent from the digest`)
        continue
      }
      const keywords = conditionKeywords(meta.qualifier)
      if (keywords.length && !keywords.some(k => section.includes(k))) {
        fail('fast-sync', `fast.md section ${num}: ${id} applies only when "${meta.qualifier}" but the digest does not carry that condition`)
      }
    }
  }

  // 7c. digest must not claim a module range that does not match reality
  const claimed = fast.match(/`(\d{2})`\s*~\s*`(\d{2})`/)
  if (claimed) {
    const actual = [numbers[0], numbers[numbers.length - 1]]
    if (claimed[1] !== actual[0] || claimed[2] !== actual[1]) {
      fail('fast-sync', `fast.md sync note claims ${claimed[1]}~${claimed[2]}, actual range is ${actual[0]}~${actual[1]}`)
    }
  }
}

// ----------------------------------------------------------------- catalog

{
  const catalog = JSON.parse(rulesFile('catalog.json'))
  const profiles = new Set(Object.keys(catalog.profiles ?? {}))
  const entries = catalog.modules ?? []
  const byPath = new Map(entries.map(e => [e.path, e]))

  // 8a. every profile says how it is detected, so a skip rests on a signal rather than an impression
  const LEAF = ['dependency', 'file', 'content', 'dirs', 'profile']
  const LEAF_EXTRA = ['in', 'under', 'min', 'notes']
  const PROFILE_KEYS = ['description', 'detect', 'cautions', 'declaredBy', 'hints', 'hintsNote', 'implicit']

  const checkSignal = (node, where) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      fail('catalog', `${where}: detect signal must be an object`)
      return
    }
    const keys = Object.keys(node)
    const combinator = keys.find(k => k === 'any' || k === 'all')
    if (combinator) {
      if (keys.length !== 1) {
        fail('catalog', `${where}: "${combinator}" must be the only key, found ${keys.join(', ')}`)
      }
      if (!Array.isArray(node[combinator]) || node[combinator].length === 0) {
        fail('catalog', `${where}: "${combinator}" must be a non-empty array`)
        return
      }
      node[combinator].forEach((branch, i) => checkSignal(branch, `${where}.${combinator}[${i}]`))
      return
    }
    const found = keys.filter(k => LEAF.includes(k))
    if (found.length !== 1) {
      fail('catalog', `${where}: a leaf signal needs exactly one of ${LEAF.join('|')}, found ${keys.join(', ') || 'nothing'}`)
      return
    }
    for (const k of keys) {
      if (!LEAF.includes(k) && !LEAF_EXTRA.includes(k)) {
        fail('catalog', `${where}: unknown key "${k}" — a typo here silently never matches`)
      }
    }
    if (found[0] === 'content' && !node.in) {
      fail('catalog', `${where}: a "content" signal must say where to look with "in"`)
    }
    if (found[0] === 'dirs') {
      if (!Array.isArray(node.dirs) || node.dirs.length === 0) {
        fail('catalog', `${where}: "dirs" must be a non-empty array`)
      } else if (!Number.isInteger(node.min) || node.min < 1 || node.min > node.dirs.length) {
        fail('catalog', `${where}: "dirs" needs an integer "min" between 1 and ${node.dirs.length}, got ${node.min}`)
      }
    }
    if (found[0] === 'profile' && !profiles.has(node.profile)) {
      fail('catalog', `${where}: references undefined profile "${node.profile}"`)
    }
  }

  const referencedProfiles = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const n of node) referencedProfiles(n, out)
      return out
    }
    if (typeof node.profile === 'string') out.push(node.profile)
    referencedProfiles(node.any, out)
    referencedProfiles(node.all, out)
    return out
  }

  for (const [name, profile] of Object.entries(catalog.profiles ?? {})) {
    const where = `catalog.json: profile "${name}"`
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
      fail('catalog', `${where}: must be an object with "description" and "detect"`)
      continue
    }
    for (const k of Object.keys(profile)) {
      if (!PROFILE_KEYS.includes(k)) fail('catalog', `${where}: unknown key "${k}"`)
    }
    if (!profile.description) fail('catalog', `${where}: missing "description"`)
    if (profile.detect === undefined) {
      fail('catalog', `${where}: missing "detect" — a profile with no signal is judged by impression`)
    } else if (profile.detect === 'declared') {
      if (!profile.declaredBy) {
        fail('catalog', `${where}: detect "declared" must say who declares it in "declaredBy"`)
      }
    } else if (typeof profile.detect === 'string') {
      fail('catalog', `${where}: "detect" must be a signal object, or the string "declared"`)
    } else {
      checkSignal(profile.detect, `${where}.detect`)
    }
  }

  // a profile reference cycle would make detection non-terminating
  for (const name of profiles) {
    const seen = new Set()
    const walk = (current, trail) => {
      for (const ref of referencedProfiles(catalog.profiles[current]?.detect)) {
        if (ref === name) {
          fail('catalog', `catalog.json: profile reference cycle ${[...trail, ref].join(' -> ')}`)
          return
        }
        if (seen.has(ref)) continue
        seen.add(ref)
        walk(ref, [...trail, ref])
      }
    }
    walk(name, [name])
  }

  // a profile no module requires is dead weight that drifts out of step with the modules
  {
    const required = new Set()
    for (const entry of entries) {
      for (const p of entry.requires ?? []) required.add(p)
      for (const part of entry.partial ?? []) for (const p of part.requires ?? []) required.add(p)
    }
    for (const [name, profile] of Object.entries(catalog.profiles ?? {})) {
      const impliedBy = [...profiles].some(other =>
        other !== name && referencedProfiles(catalog.profiles[other]?.detect).includes(name))
      if (!required.has(name) && !profile?.implicit && !impliedBy) {
        fail('catalog', `catalog.json: profile "${name}" is required by no module — remove it or mark it "implicit": true`)
      }
    }
  }

  for (const entry of entries) {
    if (!existsSync(join(RULES, entry.path))) {
      fail('catalog', `catalog.json: entry "${entry.id}" points at missing file ${entry.path}`)
    }
    for (const p of entry.requires ?? []) {
      if (!profiles.has(p)) fail('catalog', `catalog.json: "${entry.id}" requires undefined profile "${p}"`)
    }
    for (const part of entry.partial ?? []) {
      for (const p of part.requires ?? []) {
        if (!profiles.has(p)) fail('catalog', `catalog.json: "${entry.id}" partial requires undefined profile "${p}"`)
      }
    }
    for (const w of entry.workflows ?? []) {
      if (!WORKFLOW_NAMES.includes(w)) {
        fail('catalog', `catalog.json: "${entry.id}" lists unregistered workflow "${w}"`)
      }
    }
  }

  // 규칙 모듈이 아닌 문서다. `workflow-contract.md`는 공통 계약이고,
  // `verifier-prompt.md`는 prepare-verification.mjs가 읽는 검증자 지시문 템플릿이다.
  const NOT_RULE_DOCS = new Set(['workflow-contract.md', 'verifier-prompt.md'])
  for (const file of allFiles.filter(f => f.endsWith('.md') && !NOT_RULE_DOCS.has(f))) {
    if (!byPath.has(file)) fail('catalog', `catalog.json: no entry for ${file}`)
  }

  // 8b. workflow membership must match what each skill says it loads.
  // Nothing tied the two together, so both drifted — in opposite directions, which is
  // why neither showed up as an obviously wrong total: `commit` was missing from every
  // numbered module it loads, and `fast` was present on all 21 it never loads.
  {
    const numbered = entries.filter(e => /^\d\d$/.test(e.id) && e.id !== '00')
    const loads = (entry, wf) => (entry?.workflows ?? []).includes(wf)
    const sample = list => list.slice(0, 4).join(', ') + (list.length > 4 ? `, … (${list.length} total)` : '')

    for (const dir of skillDirs) {
      const text = read(join(SKILLS, dir, 'SKILL.md'))
      const where = `skills/${dir}/SKILL.md`
      const wf = (/`workflow-name`(?:은|는)?\s*\|?\s*`([a-z]+)`/.exec(text) ?? [])[1]
      if (!wf) continue // 6b already reported the missing declaration

      const declared = (/^\|\s*모듈 집합\s*\|\s*(.+?)\s*\|\s*$/m.exec(text) ?? [])[1]
      if (!declared) {
        fail('catalog', `${where}: no 모듈 집합 row, so catalog membership for "${wf}" cannot be checked`)
        continue
      }

      const everyModule = declared.includes('numbered non-00')
      const singleDoc = /`\$?\{?RULES_DIR\}?\/([A-Za-z0-9._-]+\.md)`\s*단일 문서/.exec(declared)

      if (everyModule) {
        const missing = numbered.filter(e => !loads(e, wf)).map(e => e.path)
        if (missing.length) {
          fail('catalog', `catalog.json: ${where} loads every numbered non-00 module, but these entries omit "${wf}": ${sample(missing)}`)
        }
      } else if (singleDoc) {
        const stray = numbered.filter(e => loads(e, wf)).map(e => e.path)
        if (stray.length) {
          fail('catalog', `catalog.json: ${where} loads only ${singleDoc[1]}, but these numbered entries claim "${wf}": ${sample(stray)}`)
        }
        if (!loads(byPath.get(singleDoc[1]), wf)) {
          fail('catalog', `catalog.json: ${singleDoc[1]} omits "${wf}", which ${where} declares as its only rule document`)
        }
      } else {
        // An unrecognized phrasing cannot be checked, and an unchecked declaration is how
        // this drifted. Keep the vocabulary small rather than widening the regex.
        fail('catalog', `${where}: 모듈 집합 "${declared}" is not a recognized form — phrase it as "numbered non-00 …" or "\`$RULES_DIR/x.md\` 단일 문서 …", or teach validate-rules.mjs the new form`)
      }

      for (const specialist of ['props', 'math', 'exception', 'correctness']) {
        if (new RegExp(`\\+\\s*${specialist}\\b`).test(declared) && !loads(byPath.get(`${specialist}.md`), wf)) {
          fail('catalog', `catalog.json: ${specialist}.md omits "${wf}", which ${where} adds to its module set`)
        }
      }
    }
  }
}

// --------------------------------------------------------------- manifests

{
  const pluginPath = join(ROOT, '.claude-plugin', 'plugin.json')
  const marketPath = join(ROOT, '.claude-plugin', 'marketplace.json')
  const plugin = JSON.parse(read(pluginPath))
  for (const field of ['name', 'version', 'description']) {
    if (!plugin[field]) fail('manifest', `plugin.json: missing required field "${field}"`)
  }

  if (!existsSync(marketPath)) {
    fail('manifest', 'marketplace.json is missing — the plugin cannot be installed from a marketplace')
  } else {
    const market = JSON.parse(read(marketPath))
    if (!market.name) fail('manifest', 'marketplace.json: missing "name"')
    const listed = (market.plugins ?? []).find(p => p.name === plugin.name)
    if (!listed) {
      fail('manifest', `marketplace.json: does not list plugin "${plugin.name}"`)
    } else if (listed.version !== undefined) {
      // plugin.json wins when both are set, so a second copy can only drift out of sync.
      fail('manifest', `marketplace.json: remove "version" from the plugin entry — plugin.json is the single source (currently ${listed.version} vs ${plugin.version})`)
    }
    // the same reasoning applies to every other version string in this file: nothing
    // reads them, nothing bumps them, and a stale one contradicts the documented rule
    for (const [where, value] of [['top-level', market.version], ['"metadata"', market.metadata?.version]]) {
      if (value !== undefined) {
        fail('manifest', `marketplace.json: remove the ${where} "version" (${value}) — plugin.json is the single source and this copy only goes stale`)
      }
    }
    if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) {
      fail('manifest', `plugin.json: version must be MAJOR.MINOR.PATCH, got "${plugin.version}"`)
    }
  }

  // package smoke check: the pieces a working install needs
  for (const required of ['review-rules', 'skills', 'agents', 'LICENSE', '.claude-plugin/plugin.json', 'README.md']) {
    if (!existsSync(join(ROOT, required))) fail('manifest', `packaged plugin is missing ${required}`)
  }
  for (const dir of skillDirs) {
    const front = read(join(SKILLS, dir, 'SKILL.md')).split('---')[1] ?? ''
    if (!/^\s*name:\s*\S+/m.test(front)) fail('manifest', `skills/${dir}/SKILL.md: frontmatter has no name`)
    if (!/^\s*description:\s*\S+/m.test(front)) fail('manifest', `skills/${dir}/SKILL.md: frontmatter has no description`)
  }
}

// ------------------------------------------------------------------ agents

// An agent produces findings that land in the same report as a module's, so it is
// held to the same contract. The one that shipped outside it referenced no clause,
// no ID convention, and no read-only rule — nothing in the tree said it should.
const AGENTS = join(ROOT, 'agents')
const agentFiles = existsSync(AGENTS) ? readdirSync(AGENTS).filter(f => f.endsWith('.md')).sort() : []

{
  if (agentFiles.length === 0) fail('agent', 'agents/ contains no agent document')

  const commonRules = rulesFile('00-rule.md')
  const readmeText = read(join(ROOT, 'README.md'))

  for (const file of agentFiles) {
    const text = read(join(AGENTS, file))
    const where = `agents/${file}`

    const front = text.split('---')[1] ?? ''
    if (!/^\s*name:\s*\S+/m.test(front)) fail('agent', `${where}: frontmatter has no name`)
    if (!/^\s*description:\s*\S+/m.test(front)) fail('agent', `${where}: frontmatter has no description`)

    if (!text.includes('workflow-contract.md')) {
      fail('agent', `${where}: does not defer to workflow-contract.md`)
    }
    for (const clause of ['00-9', '00-10', '00-11']) {
      if (!text.includes(clause)) {
        fail('agent', `${where}: does not say how it follows ${clause} — findings from it reach the same report`)
      }
    }

    // a finding ID has to be traceable back to something; an unregistered prefix is not
    //
    // 자기 prefix를 만드는 것만이 추적 가능한 형태는 아니다. 규칙 모듈 하나를
    // 받아 그 모듈로만 판정하는 에이전트는 **근거가 정확히 그 규칙 문서**여서,
    // 별도 prefix를 붙이면 오히려 추적이 끊긴다(`20-2`를 `RM-1`로 바꾸면 독자가
    // 규칙 문서에서 근거를 찾을 수 없다). 그래서 "모듈 규칙 ID를 그대로 쓴다"는
    // 선언도 유효한 답으로 받는다 — 린터를 만족시키려고 가짜 prefix를 만드는
    // 것이 이 검사가 막으려던 바로 그 상태다.
    const reusesModuleIds = text.includes('규칙 ID를 그대로 쓴다')
    const prefixes = [...new Set([...text.matchAll(/\b([A-Z]{2,3})-\{/g)].map(m => m[1]))]
    if (prefixes.length === 0 && !reusesModuleIds) {
      fail('agent', `${where}: declares no finding ID prefix, and does not declare that it reuses the module rule IDs`)
    }
    for (const prefix of prefixes) {
      if (!commonRules.includes(`${prefix}-{`)) {
        fail('agent', `${where}: ID prefix ${prefix}- is not registered in 00-rule.md 00-2`)
      }
      if (!readmeText.includes(`${prefix}-{n}`)) {
        fail('agent', `${where}: ID prefix ${prefix}- is missing from the README rule-ID table`)
      }
    }
  }
}

// ------------------------------------------------------- clauseless passes
//
// correctness 패스(#88 PR 1)의 `CR-{n}`은 지적의 순번이지 규칙 조항이 아니다. 그 사실을
// catalog(`ruleClauses: false`)가 선언하고, 검증 준비 스크립트가 그 선언을 보고 검증자에게
// 조항 대신 판정 기준 블록(`VERIFICATION_BASIS`)을 준다. 세 곳이 어긋나면 검증자가 없는
// 조항을 받거나, 받을 것이 없어 스크립트가 멈춘다.
{
  const catalog = JSON.parse(rulesFile('catalog.json'))
  for (const entry of (catalog.modules ?? []).filter(module => module.ruleClauses === false)) {
    const where = `catalog.json: "${entry.id}"`
    const prefixes = Array.isArray(entry.rulePrefixes) ? entry.rulePrefixes : []
    if (!prefixes.length) fail('catalog', `${where} has ruleClauses false but no rulePrefixes — its findings cannot be told apart from rule IDs`)
    if (!existsSync(join(RULES, entry.path ?? ''))) continue
    const doc = rulesFile(entry.path)
    const basis = doc.split('<!-- VERIFICATION_BASIS:BEGIN -->').length - 1
    const basisEnd = doc.split('<!-- VERIFICATION_BASIS:END -->').length - 1
    if (basis !== 1 || basisEnd !== 1) {
      fail('catalog', `${entry.path}: ruleClauses false needs exactly one VERIFICATION_BASIS block — the verifier gets it instead of a clause (BEGIN=${basis}, END=${basisEnd})`)
    }
    // 조항이 없다고 선언한 문서에 조항 헤딩이 생기면, 검증자에게는 기준 블록이 가고 독자는
    // 그 헤딩을 근거로 읽는다. 둘 중 하나는 거짓이다.
    for (const prefix of prefixes) {
      const heading = new RegExp(`^#{2,4}\\s+${prefix}-\\d+[.\\s]`, 'm')
      if (heading.test(doc)) fail('catalog', `${entry.path}: declares ruleClauses false but has a ${prefix}-{n} clause heading — ${prefix}-{n} numbers findings, not clauses`)
    }
  }

  // 직접 호출 에이전트와 full의 정확성 패스는 같은 판정 기준을 쓴다. 두 벌이므로, 에이전트의
  // Do/Don't 항목이 판정 문서에 그대로 있는지 본다 — 한쪽만 고쳐지면 같은 이름의 패스가
  // 부르는 길에 따라 다른 기준으로 판정한다.
  const agentPath = join(AGENTS, 'correctness-reviewer.md')
  const correctnessPath = join(RULES, 'correctness.md')
  if (existsSync(agentPath) && existsSync(correctnessPath)) {
    const agentText = read(agentPath)
    const doc = read(correctnessPath)
    const items = section => (agentText.split(new RegExp(`^## ${section}\\s*$`, 'm'))[1] ?? '')
      .split(/^## /m)[0]
      .split('\n')
      .filter(line => /^\d+\.\s/.test(line))
      .map(line => line.replace(/^\d+\.\s+/, '').trim())
    const criteria = [...items('Do'), ...items("Don't")]
    if (!criteria.length) fail('agent', 'agents/correctness-reviewer.md: no Do/Don\'t items found to compare with review-rules/correctness.md')
    for (const item of criteria) {
      if (!doc.includes(item)) {
        fail('agent', `agents/correctness-reviewer.md: criterion is missing from review-rules/correctness.md, so the direct agent and the full pass judge differently — "${item.slice(0, 60)}…"`)
      }
    }
  }
}

// --------------------------------------------------- producers cannot write
//
// 판정은 `lib/producer-tools.mjs`가 한다. 여기서는 파일을 읽어 넘기기만 한다 —
// 판정 로직이 이 스크립트 안에 있으면 저장소 트리 전체를 흉내 내야만 검증할 수
// 있고, 그러면 검증이 붙지 않는다.
{
  const agents = new Map(agentFiles.map(file => {
    const front = read(join(AGENTS, file)).split('---')[1] ?? ''
    const name = front.match(/^\s*name:\s*(\S+)/m)?.[1] ?? file.replace(/\.md$/, '')
    return [name, parseAgentTools(front)]
  }))

  for (const dir of skillDirs) {
    const where = `skills/${dir}/SKILL.md`
    for (const problem of checkProducerWriteAccess({ where, text: read(join(SKILLS, dir, 'SKILL.md')), agents })) {
      fail('agent', problem)
    }
  }
}

// ------------------------------------------- structured result contract/docs

function validateStructuredProducerDocs() {
  const workflowContract = rulesFile('workflow-contract.md')
  const manifestBlock = extractMarkedBlock(workflowContract, 'REVIEW_RESULT_CONTRACT_V1', 'structured-contract', 'E_MANIFEST_BLOCK_COUNT')
  const manifest = manifestBlock ? parseJsonCodeBlock(manifestBlock, 'REVIEW_RESULT_CONTRACT_V1', 'structured-contract', 'E_MANIFEST_JSON') : null
  const forbiddenProducerPatterns = [
    { code: 'E_PRODUCER_LEGACY_EMPTY_OUTPUT', regex: /위반 없음만 출력/ },
    { code: 'E_PRODUCER_LEGACY_TABLE_OUTPUT', regex: /Markdown 표를 반환|표 형식으로 반환|표로 반환/ },
    { code: 'E_PRODUCER_LEGACY_HEADING_OUTPUT', regex: /Markdown 헤딩을 반환|헤딩으로 반환/ },
  ]
  const fullReviewAggregationStalePatterns = [
    { code: 'E_FULL_REVIEW_LEGACY_PRODUCER_HEADING_NORMALIZATION', regex: /producer heading|하위 에이전트가 만든 `#`~`###` 헤딩을 그대로 옮기면|헤딩 레벨과 섹션 이름은 골격에 맞게 정규화/ },
    { code: 'E_FULL_REVIEW_LEGACY_PRODUCER_SEVERITY_NORMALIZATION', regex: /severity 이모지.*재계산해 정정|producer severity|두 축과 어긋나면 오케스트레이터가 재계산해 정정/ },
  ]
  const unverifiedToOpenQuestionPatterns = [
    { code: 'E_PRODUCER_UNVERIFIED_ROUTED_TO_OPEN_QUESTIONS', regex: /위치 미확인 주장.*openQuestions로 보내|location\.kind.?=.?"?unverified"?.*openQuestions로 보내|unverified.*openQuestions로 보내/ },
  ]
  const canonicalManifestTokens = manifest ? [
    'REVIEW_RESULT_CONTRACT_V1_MANIFEST',
    manifest.contractName,
    'impact',
    'confidence',
    'location',
    'recommendation',
    'evidence',
    'reason',
    'renderingSafety',
    'renderBySlot',
    'escapeMarkdownControlInProseFields',
    'plain-text',
    'categoryLabels',
    'slotOrder',
    'slotLabels',
    ...manifest.topLevel.required,
    ...(manifest.topLevel.allowed ?? []),
    ...manifest.impact.enum,
    ...manifest.impact.highRequires,
    ...manifest.impact.lowForbids,
    ...manifest.impact.lowAllowsOptional,
    ...manifest.impact.categoryEnum,
    ...Object.values(manifest.impact.categoryLabels ?? {}),
    ...manifest.confidence.enum,
    ...manifest.confidence.lowRequires,
    ...Object.keys(manifest.location.variants),
    ...manifest.location.variants.verified.required,
    ...(manifest.location.variants.verified.optional ?? []),
    ...manifest.location.variants.deleted.required,
    ...(manifest.location.variants.deleted.optional ?? []),
    ...manifest.location.variants.unverified.required,
    ...manifest.location.variants.unverified.forbidden,
    ...Object.keys(manifest.renderingSafety.slots ?? {}),
  ] : []

for (const [owner, contextPaths] of Object.entries(STRUCTURED_OWNER_POLICY_BEARING_COMMON_CONTEXTS)) {
    for (const contextPath of contextPaths) {
      const context = read(join(ROOT, contextPath))
      const errors = validateEffectiveCommonContext(context, contextPath)
      for (const error of errors) {
        failCode('structured-producer', error.code, `${error.message}; injected by ${owner}`)
      }
    }
  }

  for (const relativePath of STRUCTURED_PRODUCER_FILES) {
    const text = read(join(ROOT, relativePath))
    validateMarkdownBlocks(relativePath, text, 'structured-producer')
    if (!text.includes('REVIEW_RESULT_CONTRACT_V1')) {
      failCode('structured-producer', 'E_PRODUCER_MISSING_MARKER', `${relativePath} must reference REVIEW_RESULT_CONTRACT_V1`)
      continue
    }
    if (!text.includes(STRUCTURED_PRODUCER_MARKER)) {
      failCode('structured-producer', 'E_PRODUCER_MISSING_SENTINEL', `${relativePath} must include the stable marker ${STRUCTURED_PRODUCER_MARKER}`)
    }
    const anchor = text.indexOf('REVIEW_RESULT_CONTRACT_V1')
    const section = nearestHeadingSlice(text, anchor)
    for (const pattern of forbiddenProducerPatterns) {
      if (pattern.regex.test(section)) {
        failCode('structured-producer', pattern.code, `${relativePath} still contains legacy producer output guidance in the REVIEW_RESULT_CONTRACT_V1 section`)
      }
    }
    const severityLines = section.split('\n').filter(line => /severity/i.test(line))
    for (const line of severityLines) {
      if (/내지 않|넣지 마|금지|오케스트레이터|계산|파생|포함|없이/.test(line)) continue
      failCode('structured-producer', 'E_PRODUCER_SEVERITY_INSTRUCTION', `${relativePath} contains producer severity guidance in the REVIEW_RESULT_CONTRACT_V1 section: ${line.trim()}`)
    }
    for (const pattern of unverifiedToOpenQuestionPatterns) {
      if (pattern.regex.test(section)) {
        failCode('structured-producer', pattern.code, `${relativePath} routes every unverified location to openQuestions in the REVIEW_RESULT_CONTRACT_V1 section`)
      }
    }
    if (!/location\.kind.?=.?"?unverified"?.*finding|finding.*location\.kind.?=.?"?unverified"?|exact location.*unverified|exact location만.*unverified/i.test(section)) {
      failCode('structured-producer', 'E_PRODUCER_UNVERIFIED_FINDING_GUIDANCE_MISSING', `${relativePath} must say that established defects may remain findings with location.kind="unverified"`)
    }
    if (!/00-11|absence|possibility|search scope|추가 탐색|미완료/.test(section)) {
      failCode('structured-producer', 'E_PRODUCER_OPEN_QUESTION_SCOPE_MISSING', `${relativePath} must scope openQuestions to unresolved claim truth/search scope, not all unverified locations`)
    }
    if (!/heading\/table\/raw HTML\/link|untrusted content|plain prose/.test(section)) {
      failCode('structured-producer', 'E_PRODUCER_RENDERING_SAFETY_GUIDANCE_MISSING', `${relativePath} must mention that producer strings are untrusted content and must not author report Markdown structure`)
    }
    const manifestPlaceholderPresent = text.includes('{REVIEW_RESULT_CONTRACT_V1_MANIFEST}') || text.includes('REVIEW_RESULT_CONTRACT_V1_MANIFEST')
    if (!manifestPlaceholderPresent) {
      failCode('structured-producer', 'E_PRODUCER_MANIFEST_CONTEXT_INCOMPLETE', `${relativePath} must expose the complete canonical manifest through REVIEW_RESULT_CONTRACT_V1_MANIFEST`)
      continue
    }
    const exactSourceInstructionPresent = /manifest sentinel JSON block 전문|sentinel JSON block 전문|exact manifest source|전문을 그대로 주입/.test(text)
    const missingManifestTokens = manifestPlaceholderPresent && exactSourceInstructionPresent ? [] : listMissing(text, canonicalManifestTokens)
    if (missingManifestTokens.length > 0) {
      failCode('structured-producer', 'E_PRODUCER_MANIFEST_CONTEXT_INCOMPLETE', `${relativePath} does not expose the complete canonical manifest to the effective prompt; missing ${missingManifestTokens.slice(0, 8).join(', ')}${missingManifestTokens.length > 8 ? `, … (${missingManifestTokens.length} total)` : ''}`)
    }

    if (relativePath === 'skills/code-review-full/SKILL.md') {
      const reportingAnchor = text.indexOf('## 리포팅')
      if (reportingAnchor !== -1) {
        const reportingSection = nearestHeadingSlice(text, reportingAnchor)
        for (const pattern of fullReviewAggregationStalePatterns) {
          if (pattern.regex.test(reportingSection)) {
            failCode('structured-producer', pattern.code, `${relativePath} still contains stale full-review producer/aggregation prose in the reporting section`)
          }
        }
      }
      for (const specialistPrompt of ['Props & Arguments Code Review', 'Math Code Review (linear algebra)', 'Exception Handling Code Review']) {
        if (!text.includes(specialistPrompt)) {
          failCode('structured-producer', 'E_FULL_SPECIALIST_PROMPT_MISSING', `${relativePath} must define the full-review specialist prompt for ${specialistPrompt}`)
        }
      }

      // 렌더 단계가 표기를 직접 만들지 않는지 본다. 참조만 있고 호출이 없으면
      // 모델이 형식을 기억으로 재구성하는 자리가 그대로 남는다. 파일 이름만
      // 찾는 부분 문자열 검사는 "렌더러가 있다"는 언급 한 줄로도 통과한다 —
      // 실제 호출과 지나가는 언급을 못 가른 첫 시도가 이 자리에서 실패했었다.
      //
      // 그다음 시도(`render-findings.mjs` 언급 바로 뒤 500자 창에서 필수
      // 플래그 네 개를 찾는 방식)도 리뷰에서 defeat됐다. 실행 가능한 코드
      // 블록을 통째로 지우고 "render-findings.mjs 는 --input, --rules,
      // --phase, --workflow 를 받는다"라는 산문 한 줄만 남겨도, 그 한
      // 문장이 네 플래그 이름을 전부 담고 있으므로 그대로 통과했다 — 플래그
      // 이름을 나열한 문장과 그 플래그를 받는 실제 호출문을 못 가른 것은
      // 첫 시도와 같은 결함이다. 그래서 창의 시작점을 `render-findings.mjs`
      // 언급이 아니라, `node` 토큰과 `render-findings.mjs`가 같은 줄에 있는
      // **실제 호출문** 자리로 옮긴다. `node` 없이 파일 이름만 나열한 산문은
      // 이 앵커에 걸리지 않는다.
      //
      // **이 검사가 보장하는 것**: 문서에 `render-findings.mjs`를 네 필수
      // 플래그와 함께 부르는 명령문이 존재한다는 것뿐이다.
      // **이 검사가 보장하지 않는 것**: 그 명령이 실행 시점에 실제로
      // 실행되는지, 그 실행 결과가 편집 없이 `상세 지적`/`특수 패스`
      // 섹션에 그대로 실리는지 — 둘 다 정적 텍스트 검사로는 증명할 수
      // 없다. 출력이 최종 리포트에 도달했다는 보장은 이 검사의 범위 밖이다.
      //
      // **이 검사는 `code-review-full`에만 건다.** 나머지 세 standalone
      // specialist skill(props/math/exception)은 이 renderer가 소유하는
      // 문서 골격(`상세 지적` 다음에 `특수 패스`가 오는 두 섹션 묶음)을
      // 만들지 않는다 — 그 세 skill의 공개 섹션 목록에는 `특수 패스`가
      // 없다. `loadSpecialistPasses`가 지금 `workflow`를 무시하고 항상
      // Props·수학·예외 세 패스를 다 확인하므로, 그 skill들에서 이 CLI를
      // 그대로 부르면 자기 workflow의 numbered 모듈 섹션(`상세 지적`)은
      // 비고, 선언하지 않은 `특수 패스` 헤딩 아래로 모든 finding이 몰린다
      // — 선언한 섹션은 비고 선언 안 한 섹션에 내용이 실리는, 골격이
      // 잘못된 리포트다. 세 skill이 이 호출을 하게 만들려면
      // `loadSpecialistPasses`가 `workflow`를 실제로 받게 하고, 단일
      // 패스 리포트가 finding을 어느 섹션에 실을지 정하고,
      // `prepare-verification.mjs`를 안 돌리는 이 skill들에 `candidateId`
      // 출처를 정하는 별도 변경이 먼저 있어야 한다.
      const rendererInvocations = [...text.matchAll(/\bnode\b[^\n]*render-findings\.mjs/g)]
      // `--phase`는 더 이상 유효한 플래그가 아니다 — phase는 전역이 아니라
      // impact별 설정이라(PR #85), high/low를 각각 --phase-high/--phase-low로
      // 받는다. 여기서 `--phase`만 남겨 두면 두 플래그 중 하나만 있어도(혹은
      // 둘 다 빠져도 부분 문자열로) 통과해, 문서가 새 필수 플래그 중 하나를
      // 빠뜨려도 이 검사가 잡지 못한다.
      const rendererRequiredFlags = ['--input', '--rules', '--phase-high', '--phase-low', '--verification-state', '--workflow']
      const rendererActuallyInvoked = rendererInvocations.some(invocation => {
        const window = text.slice(invocation.index, invocation.index + 500)
        return rendererRequiredFlags.every(flagName => window.includes(flagName))
      })
      if (!rendererActuallyInvoked) {
        failCode('structured-producer', 'E_RENDERER_NOT_CALLED',
          `${relativePath} must call render-findings.mjs with its required flags (${rendererRequiredFlags.join(', ')}) for the finding sections, not merely mention it`)
      }
    }
  }

  const forbiddenNeutralityPatterns = [
    { code: 'E_RULE_DOC_V1_MARKER', regex: /REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT/ },
    { code: 'E_RULE_DOC_SCHEMA_VERSION', regex: /schemaVersion/ },
    { code: 'E_RULE_DOC_RAW_JSON', regex: /raw JSON|JSON 객체 하나|코드펜스|Markdown 표나 헤딩/ },
    { code: 'E_RULE_DOC_MALFORMED_OUTPUT', regex: /malformed-output/ },
    { code: 'E_RULE_DOC_RENDER_INSTRUCTION', regex: /renderBySlot|plain-text|heading\/table\/raw HTML\/link|최종 리포트의 신뢰된 Markdown|오케스트레이터가 쓴 것처럼|field slot|renderer는|렌더러는/ },
  ]
  for (const relativePath of RULE_MODULE_NEUTRALITY_FILES) {
    const text = read(join(ROOT, relativePath))
    validateMarkdownBlocks(relativePath, text, 'structured-producer')
    for (const pattern of forbiddenNeutralityPatterns) {
      if (pattern.regex.test(text)) {
        failCode('structured-producer', pattern.code, `${relativePath} must stay workflow-neutral and must not contain structured producer contract text`)
      }
    }
  }

  for (const relativePath of LEGACY_WORKFLOW_FILES) {
    const text = read(join(ROOT, relativePath))
    validateMarkdownBlocks(relativePath, text, 'structured-producer')
    if (text.includes(STRUCTURED_PRODUCER_MARKER) || text.includes('REVIEW_RESULT_CONTRACT_V1')) {
      failCode('structured-producer', 'E_LEGACY_WORKFLOW_STRUCTURED_OWNERSHIP', `${relativePath} must remain a legacy workflow and must not claim structured-v1 ownership`)
    }
    if (!/legacy producer|기존 producer 계약|legacy workflow|기존 producer 형식/.test(text)) {
      failCode('structured-producer', 'E_LEGACY_WORKFLOW_DECLARATION_MISSING', `${relativePath} must explicitly declare that it remains a legacy workflow`)
    }
  }

  for (const relativePath of ['skills/code-review/SKILL.md', 'skills/code-review-commit/SKILL.md']) {
    const text = read(join(ROOT, relativePath))
    if (/workflow-contract\.md.*먼저 읽|workflow-contract\.md.*문서 골격/s.test(text) && !/structured manifest|structured producer instruction|effective reviewer prompt에는 structured manifest/.test(text)) {
      failCode('structured-producer', 'E_LEGACY_EFFECTIVE_CONTEXT_STRUCTURED_LEAK', `${relativePath} still imports workflow-contract.md into the effective reviewer prompt even though this workflow is registered as legacy-only`)
    }
  }

  for (const relativePath of ['skills/code-review-full/SKILL.md', 'skills/code-review-props/SKILL.md', 'skills/code-review-math/SKILL.md', 'skills/code-review-exception/SKILL.md']) {
    const text = read(join(ROOT, relativePath))
    if (/00-rule\.md.*REVIEW_RESULT_CONTRACT_V1/.test(text)) {
      failCode('structured-producer', 'E_STALE_REFERENCE_STRUCTURED_MANIFEST', `${relativePath} still points structured validation at 00-rule.md instead of workflow-contract.md C-6A`)
    }
  }

  for (const relativePath of ['skills/code-review-props/SKILL.md', 'skills/code-review-math/SKILL.md', 'skills/code-review-exception/SKILL.md']) {
    const text = read(join(ROOT, relativePath))
    if (/검증을 통과한 JSON만 최종 결과로 전달/.test(text)) {
      failCode('structured-producer', 'E_STANDALONE_PUBLIC_JSON_LEAK', `${relativePath} still says validated producer JSON is the final result instead of a rendered public Markdown report`)
    }
    const missingPublicContract = listMissing(text, ['판정', '요약', '도구 실행 결과', '실행 타임라인', '미해결 / 후속 확인'])
    if (missingPublicContract.length > 0) {
      failCode('structured-producer', 'E_STANDALONE_PUBLIC_MARKDOWN_CONTRACT_MISSING', `${relativePath} does not define the historical public Markdown surface for standalone specialist output; missing ${missingPublicContract.join(', ')}`)
    }
  }

  for (const [relativePath, headingPattern] of [
    ['skills/code-review/SKILL.md', /^# 코드 리뷰 리포트$/m],
    ['skills/code-review-commit/SKILL.md', /^# 커밋 코드 리뷰 리포트$/m],
  ]) {
    const text = read(join(ROOT, relativePath))
    if (headingPattern.test(text)) {
      failCode('structured-producer', 'E_LEGACY_PUBLIC_H1_MISSING_TARGET', `${relativePath} still documents a public H1 without the C-7 target placeholder`)
    }
    const missingSections = listMissing(text, ['## 리뷰 기준', '## 판정', '## 상세 지적', '## 도구 실행 결과', '## 실행 타임라인', '## 미해결 / 후속 확인'])
    if (missingSections.length > 0) {
      failCode('structured-producer', 'E_LEGACY_PUBLIC_SKELETON_CONTRADICTION', `${relativePath} cites C-7 but its documented public template still omits ${missingSections.join(', ')}`)
    }
  }

  for (const relativePath of ['skills/code-review/SKILL.md', 'skills/code-review-commit/SKILL.md', 'skills/code-review-fast/SKILL.md']) {
    const text = read(join(ROOT, relativePath))
    for (const match of text.matchAll(/(^##\s+[🔴🟡🔵]\s+.*$|🟡로 지적|severity.*(?:copy|raise|더 높은 쪽|올려))/gm)) {
      failCode('structured-producer', 'E_FIXED_GRADE_DIRECTIVE', `${relativePath} still contains a fixed-grade directive: ${match[0].trim()}`)
    }
  }
}

function validateContractManifestAndFixtures() {
  const workflowContract = rulesFile('workflow-contract.md')
  const manifest = getContractManifest()
  if (!manifest) return

  if (manifest.contractName !== 'REVIEW_RESULT_CONTRACT_V1') failCode('structured-contract', 'E_MANIFEST_CONTRACT_NAME', 'manifest.contractName must be REVIEW_RESULT_CONTRACT_V1')
  if (manifest.schemaVersion !== 1) failCode('structured-contract', 'E_MANIFEST_SCHEMA_VERSION', 'manifest.schemaVersion must be 1')
  if (!sameMembers(manifest.topLevel?.required ?? [], ['schemaVersion', 'findings', 'openQuestions'])) failCode('structured-contract', 'E_MANIFEST_TOPLEVEL_REQUIRED', 'manifest.topLevel.required must be exactly schemaVersion, findings, openQuestions')
  if (!sameMembers(manifest.topLevel?.forbidden ?? [], ['severity'])) failCode('structured-contract', 'E_MANIFEST_TOPLEVEL_FORBIDDEN', 'manifest.topLevel.forbidden must be exactly severity')
  if (!sameMembers(manifest.impact?.enum ?? [], ['high', 'low'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_ENUM', 'manifest.impact.enum must be exactly high, low')
  if (!sameMembers(manifest.impact?.highRequires ?? [], ['category', 'evidence'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_HIGH_REQUIRES', 'manifest.impact.highRequires must be exactly category and evidence')
  if (!sameMembers(manifest.impact?.lowForbids ?? [], ['category'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_LOW_FORBIDS', 'manifest.impact.lowForbids must be exactly category')
  if (!sameMembers(manifest.impact?.lowAllowsOptional ?? [], ['evidence'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_LOW_OPTIONAL', 'manifest.impact.lowAllowsOptional must be exactly evidence')
  const categoryEnum = manifest.impact?.categoryEnum ?? []
  const categoryLabels = manifest.impact?.categoryLabels ?? {}
  if (!Array.isArray(categoryEnum) || categoryEnum.length !== 5 || new Set(categoryEnum).size !== 5 || categoryEnum.some(id => typeof id !== 'string' || id.trim() === '' || !isLowerKebabCase(id))) {
    failCode('structured-contract', 'E_MANIFEST_CATEGORY_ENUM', 'manifest.impact.categoryEnum must contain exactly five unique non-empty stable lowercase-kebab IDs')
  }
  if (!sameMembers(manifest.confidence?.enum ?? [], ['high', 'low'])) failCode('structured-contract', 'E_MANIFEST_CONFIDENCE_ENUM', 'manifest.confidence.enum must be exactly high, low')
  if (!sameMembers(manifest.confidence?.lowRequires ?? [], ['reason'])) failCode('structured-contract', 'E_MANIFEST_CONFIDENCE_LOW_REQUIRES', 'manifest.confidence.lowRequires must be exactly reason')
  const commonRules = rulesFile('00-rule.md')
  const closedListLabels = parseClosedListLabelsFromCommonRules(commonRules)
  if (!sameMembers(Object.keys(categoryLabels), categoryEnum) || Object.values(categoryLabels).some(label => typeof label !== 'string' || label.trim() === '')) {
    failCode('structured-contract', 'E_MANIFEST_CATEGORY_LABELS', 'manifest.impact.categoryLabels must have exactly the same keys as categoryEnum and every label must be a non-empty string')
  }
  if (!sameMembers(Object.values(categoryLabels), closedListLabels)) failCode('structured-contract', 'E_MANIFEST_CATEGORY_LABELS', 'manifest.impact.categoryLabels must stay synchronized with the closed-list Korean labels in 00-rule.md')
  if (manifest.location?.kindField !== 'kind') failCode('structured-contract', 'E_MANIFEST_LOCATION_KIND_FIELD', 'manifest.location.kindField must be kind')

  const variants = manifest.location?.variants ?? {}
  if (!sameMembers(Object.keys(variants), ['verified', 'deleted', 'unverified'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_VARIANTS', 'manifest.location.variants must define exactly verified, deleted, unverified')
  if (!sameMembers(variants.verified?.required ?? [], ['path', 'line', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_VERIFIED', 'manifest.location.variants.verified.required must be path, line, quote')
  if (!sameMembers(variants.verified?.optional ?? [], ['endLine'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_VERIFIED_OPTIONAL', 'manifest.location.variants.verified.optional must be exactly endLine')
  if (!sameMembers(variants.deleted?.required ?? [], ['path', 'lineBefore', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_DELETED', 'manifest.location.variants.deleted.required must be path, lineBefore, quote')
  if (!sameMembers(variants.deleted?.optional ?? [], ['endLine'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_DELETED_OPTIONAL', 'manifest.location.variants.deleted.optional must be exactly endLine')
  if (!sameMembers(variants.unverified?.required ?? [], ['reason'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_UNVERIFIED_REQUIRED', 'manifest.location.variants.unverified.required must be reason only')
  if (!sameMembers(variants.unverified?.forbidden ?? [], ['path', 'line', 'lineBefore', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_UNVERIFIED_FORBIDDEN', 'manifest.location.variants.unverified.forbidden must be path, line, lineBefore, quote')
  if (variants.verified?.constraints?.endLine !== 'positive-and-gte-line') failCode('structured-contract', 'E_MANIFEST_LOCATION_VERIFIED_ENDLINE_CONSTRAINT', 'manifest.location.variants.verified.constraints.endLine must be positive-and-gte-line')
  if (variants.deleted?.constraints?.endLine !== 'positive-and-gte-lineBefore') failCode('structured-contract', 'E_MANIFEST_LOCATION_DELETED_ENDLINE_CONSTRAINT', 'manifest.location.variants.deleted.constraints.endLine must be positive-and-gte-lineBefore')
  if (!sameMembers(manifest.findingsItem?.required ?? [], ['ruleId', 'title', 'body', 'impact', 'confidence', 'location'])) failCode('structured-contract', 'E_MANIFEST_FINDINGS_REQUIRED', 'manifest.findingsItem.required must match the approved finding envelope')
  if (!sameMembers(manifest.findingsItem?.forbidden ?? [], ['severity'])) failCode('structured-contract', 'E_MANIFEST_FINDINGS_FORBIDDEN', 'manifest.findingsItem.forbidden must be exactly severity')
  if (!sameMembers(manifest.openQuestionsItem?.required ?? [], ['title', 'body', 'location', 'reason'])) failCode('structured-contract', 'E_MANIFEST_OPEN_QUESTIONS_REQUIRED', 'manifest.openQuestionsItem.required must be exactly title, body, location, reason')
  if (!sameMembers(manifest.topLevel?.allowed ?? [], ['schemaVersion', 'findings', 'openQuestions'])) failCode('structured-contract', 'E_MANIFEST_TOPLEVEL_ALLOWED', 'manifest.topLevel.allowed must be exactly schemaVersion, findings, openQuestions')
  if (!sameMembers(manifest.findingsItem?.allowed ?? [], ['ruleId', 'title', 'body', 'impact', 'confidence', 'location', 'category', 'evidence', 'reason', 'recommendation'])) failCode('structured-contract', 'E_MANIFEST_FINDINGS_ALLOWED', 'manifest.findingsItem.allowed must enumerate the validator-approved finding fields')
  if (!sameMembers(manifest.openQuestionsItem?.allowed ?? [], ['ruleId', 'title', 'body', 'location', 'reason', 'recommendation'])) failCode('structured-contract', 'E_MANIFEST_OPEN_QUESTIONS_ALLOWED', 'manifest.openQuestionsItem.allowed must enumerate the validator-approved openQuestion fields')
  if (!sameMembers(variants.verified?.allowed ?? [], ['kind', 'path', 'line', 'endLine', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_VERIFIED_ALLOWED', 'manifest.location.variants.verified.allowed must enumerate kind, path, line, endLine, quote')
  if (!sameMembers(variants.deleted?.allowed ?? [], ['kind', 'path', 'lineBefore', 'endLine', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_DELETED_ALLOWED', 'manifest.location.variants.deleted.allowed must enumerate kind, path, lineBefore, endLine, quote')
  if (!sameMembers(variants.unverified?.allowed ?? [], ['kind', 'reason'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_UNVERIFIED_ALLOWED', 'manifest.location.variants.unverified.allowed must enumerate kind, reason')
  if (manifest.renderingSafety?.renderBySlot !== true) failCode('structured-contract', 'E_MANIFEST_RENDER_BY_SLOT', 'manifest.renderingSafety.renderBySlot must be true')
  if (manifest.renderingSafety?.escapeMarkdownControlInProseFields !== true) failCode('structured-contract', 'E_MANIFEST_RENDER_ESCAPE_PROSE', 'manifest.renderingSafety.escapeMarkdownControlInProseFields must be true')
  if (!sameMembers(manifest.renderingSafety?.codeFields ?? [], ['location.path', 'location.quote'])) failCode('structured-contract', 'E_MANIFEST_RENDER_CODE_FIELDS', 'manifest.renderingSafety.codeFields must be exactly location.path and location.quote')
  if (manifest.renderingSafety?.urlsRenderAs !== 'plain-text') failCode('structured-contract', 'E_MANIFEST_RENDER_URLS', 'manifest.renderingSafety.urlsRenderAs must be plain-text')
  if (manifest.renderingSafety?.staticValidatorScope !== 'doc-sync-only') failCode('structured-contract', 'E_MANIFEST_RENDER_VALIDATOR_SCOPE', 'manifest.renderingSafety.staticValidatorScope must be doc-sync-only')
  if (!sameMembers(Object.keys(manifest.renderingSafety?.slots ?? {}), ['body', 'evidence', 'recommendation', 'findingConfidenceReason', 'locationUnverifiedReason', 'openQuestionReason'])) failCode('structured-contract', 'E_MANIFEST_RENDER_SLOTS', 'manifest.renderingSafety.slots must define exactly body, evidence, recommendation, findingConfidenceReason, locationUnverifiedReason, openQuestionReason')
  if (!sameMembers(manifest.renderingSafety?.slotOrder ?? [], ['body', 'evidence', 'recommendation', 'findingConfidenceReason', 'locationUnverifiedReason', 'openQuestionReason'])) failCode('structured-contract', 'E_MANIFEST_RENDER_SLOT_ORDER', 'manifest.renderingSafety.slotOrder must preserve the canonical renderer slot order')
  if (!sameEntries(manifest.renderingSafety?.slotLabels ?? {}, {
    body: '본문',
    evidence: '근거',
    recommendation: '개선 제안',
    findingConfidenceReason: '확신 근거',
    locationUnverifiedReason: '위치 미확인 사유',
    openQuestionReason: '추가 확인 이유',
  })) failCode('structured-contract', 'E_MANIFEST_RENDER_SLOT_LABELS', 'manifest.renderingSafety.slotLabels must map every renderer slot to the canonical Korean label')

  const derived = getManifestDerivedSchema()
  if (!sameMembers([...derived.topLevelAllowed], manifest.topLevel?.allowed ?? [])) failCode('structured-contract', 'E_VALIDATOR_TOPLEVEL_ALLOWLIST_DRIFT', 'validator top-level allowlist must be derivable from manifest.topLevel.allowed')
  if (!sameMembers([...derived.findingAllowed], manifest.findingsItem?.allowed ?? [])) failCode('structured-contract', 'E_VALIDATOR_FINDING_ALLOWLIST_DRIFT', 'validator finding allowlist must be derivable from manifest.findingsItem.allowed')
  if (!sameMembers([...derived.openQuestionAllowed], manifest.openQuestionsItem?.allowed ?? [])) failCode('structured-contract', 'E_VALIDATOR_OPEN_QUESTION_ALLOWLIST_DRIFT', 'validator openQuestion allowlist must be derivable from manifest.openQuestionsItem.allowed')
  if (!sameMembers([...derived.locationAllowed.verified], variants.verified?.allowed ?? [])) failCode('structured-contract', 'E_VALIDATOR_LOCATION_VERIFIED_ALLOWLIST_DRIFT', 'validator verified-location allowlist must match the manifest allowed fields')
  if (!sameMembers([...derived.locationAllowed.deleted], variants.deleted?.allowed ?? [])) failCode('structured-contract', 'E_VALIDATOR_LOCATION_DELETED_ALLOWLIST_DRIFT', 'validator deleted-location allowlist must match the manifest allowed fields')
  if (!sameMembers([...derived.locationAllowed.unverified], variants.unverified?.allowed ?? [])) failCode('structured-contract', 'E_VALIDATOR_LOCATION_UNVERIFIED_ALLOWLIST_DRIFT', 'validator unverified-location allowlist must match the manifest allowed fields')

  for (const token of ['schemaVersion', 'findings', 'openQuestions', 'verified', 'deleted', 'unverified', 'lowAllowsOptional', 'renderingSafety', 'renderBySlot', 'escapeMarkdownControlInProseFields', 'plain-text', 'doc-sync-only', ...(manifest.impact?.categoryEnum ?? []), ...Object.values(manifest.impact?.categoryLabels ?? {})]) {
    if (!workflowContract.includes(token)) failCode('structured-contract', 'E_MANIFEST_PROSE_TOKEN_SYNC', `workflow-contract.md prose must mention token ${token}`)
  }
  for (const token of ['workflow-contract.md', 'impact × confidence', 'external-breakage']) {
    if (!commonRules.includes(token)) failCode('structured-contract', 'E_COMMON_RULE_REFERENCE_SYNC', `00-rule.md must mention token ${token}`)
  }
  for (const token of ['schemaVersion', 'findings', 'openQuestions', 'unverified', 'renderBySlot', 'plain text', 'source/pass label', '2.4.0', 'default', 'commit', 'fast']) {
    if (!workflowContract.includes(token)) failCode('structured-contract', 'E_WORKFLOW_TOKEN_SYNC', `workflow-contract.md must mention token ${token}`)
  }

  const ownerMatrixRows = workflowContract
    .split('\n')
    .filter(line => /^\|\s*`[^`]+`\s*\|/.test(line))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
  const structuredOwnersFromMatrix = ownerMatrixRows
    .filter(([, , ownership]) => /^structured-v1\b/.test(ownership ?? ''))
    .map(([owner]) => owner.replace(/^`|`$/g, ''))
    .sort()
  const registeredStructuredOwners = Object.keys(STRUCTURED_OWNER_CONSUMERS).sort()
  if (!sameMembers(structuredOwnersFromMatrix, registeredStructuredOwners)) {
    failCode('structured-contract', 'E_STRUCTURED_OWNER_MATRIX_SYNC', `workflow-contract.md ownership matrix structured-v1 owners must match validator registry exactly; expected [${registeredStructuredOwners.join(', ')}], got [${structuredOwnersFromMatrix.join(', ')}]`)
  }

  // README carries a second copy of the ownership split, written as commands rather than
  // paths. It drifted: the 2.6.0 revert corrected the contract matrix and this registry but
  // left README claiming `/code-review` was still a structured owner, and nothing caught it
  // because the sync check above only reads workflow-contract.md. A summary that no check
  // compares is a second source of truth, and the stale one is the one people read first.
  const commandOf = ownerPath => `/${ownerPath.replace(/^skills\//, '').replace(/\/SKILL\.md$/, '')}`
  const readmeOwnershipRow = read(join(ROOT, 'README.md'))
    .split('\n')
    .find(line => /^\|\s*`\/code-review[^|]*\|[^|]*`\/code-review[^|]*\|\s*$/.test(line))
  if (!readmeOwnershipRow) {
    failCode('structured-contract', 'E_README_OWNERSHIP_TABLE_MISSING', 'README.md must carry an ownership table row listing structured-v1 owners and legacy producers as commands')
  } else {
    const [structuredCell = '', legacyCell = ''] = readmeOwnershipRow.split('|').slice(1, -1)
    const commandsIn = cell => (cell.match(/`\/[\w-]+`/g) ?? []).map(token => token.replace(/`/g, '')).sort()
    const expectedStructured = registeredStructuredOwners.map(commandOf).sort()
    const expectedLegacy = LEGACY_WORKFLOW_FILES.map(commandOf).sort()
    if (!sameMembers(commandsIn(structuredCell), expectedStructured)) {
      failCode('structured-contract', 'E_README_OWNERSHIP_SYNC', `README.md ownership table structured-v1 owners must match the validator registry exactly; expected [${expectedStructured.join(', ')}], got [${commandsIn(structuredCell).join(', ')}]`)
    }
    if (!sameMembers(commandsIn(legacyCell), expectedLegacy)) {
      failCode('structured-contract', 'E_README_OWNERSHIP_SYNC', `README.md ownership table legacy producers must match the validator registry exactly; expected [${expectedLegacy.join(', ')}], got [${commandsIn(legacyCell).join(', ')}]`)
    }
  }

  for (const [owner, consumers] of Object.entries(STRUCTURED_OWNER_CONSUMERS)) {
    if (!Array.isArray(consumers) || consumers.length === 0) {
      failCode('structured-contract', 'E_STRUCTURED_OWNER_CONSUMER_REGISTRY', `${owner} must declare at least one structured-v1 consumer in STRUCTURED_OWNER_CONSUMERS`)
    }
  }

  const correctnessStructuredClaimSources = [
    ['workflow-contract.md ownership matrix', /\|\s*`agents\/correctness-reviewer\.md`\s*\|\s*`[^`]+`\s*\|\s*[^|]*structured-v1[^|]*\|/],
    ['README structured owner list', /(^|\n)-\s+`agents\/correctness-reviewer\.md`(?=\n|$)/],
    ['agents/correctness-reviewer.md', /REVIEW_RESULT_CONTRACT_V1|REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT/],
  ]
  const correctnessDeclaresStructuredV1 = correctnessStructuredClaimSources.some(([label, pattern]) => {
    const sourceText = label === 'workflow-contract.md ownership matrix'
      ? workflowContract
      : label === 'README structured owner list'
        ? read(join(ROOT, 'README.md'))
        : read(join(ROOT, 'agents', 'correctness-reviewer.md'))
    return pattern.test(sourceText)
  })
  if (correctnessDeclaresStructuredV1 && !STRUCTURED_OWNER_CONSUMERS['agents/correctness-reviewer.md']) {
    failCode('structured-contract', 'E_CONSUMERLESS_STRUCTURED_OWNER', 'correctness-reviewer must not declare structured-v1 ownership until a validation/render consumer is registered for it')
  }

  const fixtureRoot = join(ROOT, 'tests', 'review-result-contract')
  if (!existsSync(fixtureRoot)) {
    failCode('fixtures', 'E_FIXTURE_DIR_MISSING', 'tests/review-result-contract is missing')
    return
  }
  const fixtureFiles = walkFiles(fixtureRoot).filter(path => path.endsWith('.json'))
  if (fixtureFiles.length === 0) failCode('fixtures', 'E_FIXTURE_FILES_MISSING', 'tests/review-result-contract must contain JSON fixtures')
  const coverage = {
    validVerified: false,
    validDeleted: false,
    validUnverified: false,
    validUnverifiedFinding: false,
    validNonEmptyOpenQuestions: false,
    invalidDeletedMissingFields: false,
    invalidUnverifiedForbiddenPath: false,
    invalidUnverifiedForbiddenLineQuote: false,
    invalidFindingUnknownKey: false,
    invalidOpenQuestionUnknownKey: false,
    validLowImpactWithEvidence: false,
    validVerifiedRange: false,
    validDeletedRange: false,
    invalidVerifiedRange: false,
    invalidDeletedRange: false,
    categoryCoverage: new Set(),
  }
  for (const path of fixtureFiles) {
    let payload
    try {
      payload = JSON.parse(read(path))
    } catch (error) {
      failCode('fixtures', 'E_FIXTURE_INVALID_JSON', `${path.slice(ROOT.length + 1)} is not valid JSON: ${error.message}`)
      continue
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      failCode('fixtures', 'E_FIXTURE_INVALID_SHAPE', `${path.slice(ROOT.length + 1)} must contain an object fixture envelope`)
      continue
    }
    const resultErrors = validateReviewResultContract(payload.input)
    const actualCodes = [...new Set(resultErrors.map(error => error.code))].sort()
    const expectedCodes = [...new Set(payload.expectedErrorCodes ?? [])].sort()
      if (payload.expected === 'valid') {
        const findings = Array.isArray(payload.input?.findings) ? payload.input.findings : []
        const openQuestions = Array.isArray(payload.input?.openQuestions) ? payload.input.openQuestions : []
        if (findings.some(item => item?.location?.kind === 'verified')) coverage.validVerified = true
        if (findings.some(item => item?.location?.kind === 'deleted')) coverage.validDeleted = true
        if (findings.some(item => item?.location?.kind === 'verified' && hasOwn(item.location, 'endLine'))) coverage.validVerifiedRange = true
        if (findings.some(item => item?.location?.kind === 'deleted' && hasOwn(item.location, 'endLine'))) coverage.validDeletedRange = true
        if (findings.some(item => item?.location?.kind === 'unverified') || openQuestions.some(item => item?.location?.kind === 'unverified')) coverage.validUnverified = true
        if (findings.some(item => item?.location?.kind === 'unverified')) coverage.validUnverifiedFinding = true
        if (openQuestions.length > 0) coverage.validNonEmptyOpenQuestions = true
        if (findings.some(item => item?.impact === 'low' && hasOwn(item, 'evidence'))) coverage.validLowImpactWithEvidence = true
        for (const finding of findings) if (typeof finding?.category === 'string') coverage.categoryCoverage.add(finding.category)
        if (resultErrors.length > 0) failCode('fixtures', 'E_FIXTURE_EXPECTED_VALID', `${path.slice(ROOT.length + 1)} should be valid but failed with ${actualCodes.join(', ')}`)
    } else if (payload.expected === 'invalid') {
      if (expectedCodes.includes('E_LOCATION_DELETED_REQUIRES_PATH') && expectedCodes.includes('E_LOCATION_DELETED_REQUIRES_LINE_BEFORE') && expectedCodes.includes('E_LOCATION_DELETED_REQUIRES_QUOTE')) {
        coverage.invalidDeletedMissingFields = true
      }
        if (expectedCodes.includes('E_LOCATION_UNVERIFIED_FORBIDS_PATH')) coverage.invalidUnverifiedForbiddenPath = true
        if (expectedCodes.includes('E_LOCATION_UNVERIFIED_FORBIDS_LINE') && expectedCodes.includes('E_LOCATION_UNVERIFIED_FORBIDS_QUOTE')) coverage.invalidUnverifiedForbiddenLineQuote = true
        if (expectedCodes.includes('E_FINDING_UNKNOWN_KEY')) coverage.invalidFindingUnknownKey = true
        if (expectedCodes.includes('E_OPEN_QUESTION_UNKNOWN_KEY')) coverage.invalidOpenQuestionUnknownKey = true
        if (expectedCodes.includes('E_LOCATION_VERIFIED_INVALID_END_LINE')) coverage.invalidVerifiedRange = true
        if (expectedCodes.includes('E_LOCATION_DELETED_INVALID_END_LINE')) coverage.invalidDeletedRange = true
        if (resultErrors.length === 0) failCode('fixtures', 'E_FIXTURE_EXPECTED_INVALID', `${path.slice(ROOT.length + 1)} should be invalid but passed`)
      if (actualCodes.join('|') !== expectedCodes.join('|')) {
        failCode('fixtures', 'E_FIXTURE_ERROR_CODES', `${path.slice(ROOT.length + 1)} expected error codes [${expectedCodes.join(', ')}] but got [${actualCodes.join(', ')}]`)
      }
    } else {
      failCode('fixtures', 'E_FIXTURE_EXPECTED_FIELD', `${path.slice(ROOT.length + 1)} must declare expected as valid or invalid`)
    }
  }
  if (!coverage.validVerified) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_VERIFIED', 'fixture set must include a valid result with a verified location')
  if (!coverage.validDeleted) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_DELETED', 'fixture set must include a valid result with a deleted location')
  if (!coverage.validUnverified) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_UNVERIFIED', 'fixture set must include a valid result with an unverified location')
  if (!coverage.validUnverifiedFinding) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_UNVERIFIED_FINDING', 'fixture set must include a valid finding with an unverified location to distinguish it from openQuestions')
  if (!coverage.validNonEmptyOpenQuestions) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_OPEN_QUESTIONS', 'fixture set must include a valid result with non-empty openQuestions')
  if (!coverage.invalidDeletedMissingFields) failCode('fixtures', 'E_FIXTURE_COVERAGE_INVALID_DELETED', 'fixture set must include an invalid deleted-location missing-fields case')
  if (!coverage.invalidUnverifiedForbiddenPath) failCode('fixtures', 'E_FIXTURE_COVERAGE_INVALID_UNVERIFIED_PATH', 'fixture set must include an invalid unverified-location path-forbidden case')
  if (!coverage.invalidUnverifiedForbiddenLineQuote) failCode('fixtures', 'E_FIXTURE_COVERAGE_INVALID_UNVERIFIED_LINE_QUOTE', 'fixture set must include an invalid unverified-location line/quote-forbidden case')
  if (!coverage.invalidFindingUnknownKey) failCode('fixtures', 'E_FIXTURE_COVERAGE_INVALID_FINDING_UNKNOWN_KEY', 'fixture set must include an invalid finding unknown-key case')
  if (!coverage.invalidOpenQuestionUnknownKey) failCode('fixtures', 'E_FIXTURE_COVERAGE_INVALID_OPEN_QUESTION_UNKNOWN_KEY', 'fixture set must include an invalid openQuestion unknown-key case')
  if (!coverage.validLowImpactWithEvidence) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_LOW_IMPACT_EVIDENCE', 'fixture set must include a valid low-impact finding carrying evidence to pin the current policy')
  if (!coverage.validVerifiedRange) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_VERIFIED_RANGE', 'fixture set must include a valid verified-location range case using endLine')
  if (!coverage.validDeletedRange) failCode('fixtures', 'E_FIXTURE_COVERAGE_VALID_DELETED_RANGE', 'fixture set must include a valid deleted-location range case using endLine')
  if (!coverage.invalidVerifiedRange) failCode('fixtures', 'E_FIXTURE_COVERAGE_INVALID_VERIFIED_RANGE', 'fixture set must include an invalid verified-location reversed/zero range case')
  if (!coverage.invalidDeletedRange) failCode('fixtures', 'E_FIXTURE_COVERAGE_INVALID_DELETED_RANGE', 'fixture set must include an invalid deleted-location reversed/zero range case')
  if (!sameMembers([...coverage.categoryCoverage], categoryEnum)) failCode('fixtures', 'E_FIXTURE_COVERAGE_CATEGORY_ENUM', 'fixture set must exercise every manifest category ID at least once through valid findings')
}

// ---------------------------------------------------------- verdict contract

let VERDICT_MANIFEST_CACHE = null

function getVerdictManifest() {
  if (VERDICT_MANIFEST_CACHE) return VERDICT_MANIFEST_CACHE
  const workflowContract = rulesFile('workflow-contract.md')
  const block = extractMarkedBlock(workflowContract, 'REVIEW_VERDICT_CONTRACT_V1', 'verdict-contract', 'E_VERDICT_MANIFEST_BLOCK_COUNT')
  if (!block) return null
  const manifest = parseJsonCodeBlock(block, 'REVIEW_VERDICT_CONTRACT_V1', 'verdict-contract', 'E_VERDICT_MANIFEST_JSON')
  if (!manifest) return null
  VERDICT_MANIFEST_CACHE = manifest
  return VERDICT_MANIFEST_CACHE
}

function validateReviewVerdictContract(value) {
  const errors = []
  const manifest = getVerdictManifest()
  if (!manifest) {
    addError(errors, 'E_VERDICT_MANIFEST_MISSING', 'REVIEW_VERDICT_CONTRACT_V1 manifest is unavailable')
    return errors
  }
  // 실행 중 판정을 검사하는 tally-verdicts.mjs --validate와 같은 함수다.
  return validateVerdictPayload(value, manifest, getContractManifest())
}

function validateVerdictContractAndFixtures() {
  const fixtureRoot = join(ROOT, 'tests', 'review-verdict-contract')
  if (!existsSync(fixtureRoot)) {
    failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_DIR_MISSING', 'tests/review-verdict-contract is missing')
    return
  }
  const fixtureFiles = walkFiles(fixtureRoot).filter(path => path.endsWith('.json'))
  if (fixtureFiles.length === 0) {
    failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_FILES_MISSING', 'tests/review-verdict-contract must contain JSON fixtures')
  }
  for (const path of fixtureFiles) {
    const where = path.slice(ROOT.length + 1)
    let payload
    try {
      payload = JSON.parse(read(path))
    } catch (error) {
      failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_INVALID_JSON', `${where} is not valid JSON: ${error.message}`)
      continue
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_INVALID_SHAPE', `${where} must contain an object fixture envelope`)
      continue
    }
    const errors = validateReviewVerdictContract(payload.input)
    const actualCodes = [...new Set(errors.map(error => error.code))].sort()
    const expectedCodes = [...new Set(payload.expectedErrorCodes ?? [])].sort()
    if (payload.expected === 'valid') {
      if (errors.length > 0) failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_EXPECTED_VALID', `${where} should be valid but failed with ${actualCodes.join(', ')}`)
    } else if (payload.expected === 'invalid') {
      if (errors.length === 0) failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_EXPECTED_INVALID', `${where} should be invalid but passed`)
      else if (actualCodes.join('|') !== expectedCodes.join('|')) {
        failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_ERROR_CODES', `${where} expected error codes [${expectedCodes.join(', ')}] but got [${actualCodes.join(', ')}]`)
      }
    } else {
      failCode('verdict-fixtures', 'E_VERDICT_FIXTURE_EXPECTED_FIELD', `${where} must declare expected as valid or invalid`)
    }
  }
}

validateVerdictContractAndFixtures()

function validateVerdictOwnerSync() {
  const manifest = getVerdictManifest()
  if (!manifest) return

  // A contract nobody injects drifts silently. The owner must carry the runtime
  // placeholder, the same way the structured-result owners carry theirs.
  //
  // 검증자 지시문의 정본은 SKILL이 아니라 이 템플릿이다. 2.15.0부터
  // prepare-verification.mjs가 이 파일의 VERIFIER_PROMPT 블록을 읽어 작업마다
  // 프롬프트 파일을 만든다 — 오케스트레이터가 지시를 자기 말로 다시 쓰던
  // 2026-09-30 실행의 실패를 막으려는 것이다. 그래서 검사도 그 블록을 본다.
  const OWNER = 'review-rules/verifier-prompt.md'
  const ownerPath = join(ROOT, OWNER)
  if (!existsSync(ownerPath)) {
    failCode('verdict-contract', 'E_VERDICT_OWNER_MISSING', `${OWNER} is missing`)
    return
  }
  const block = markedBlock(read(ownerPath), 'VERIFIER_PROMPT')
  if (block.error) {
    failCode('verdict-contract', 'E_VERDICT_OWNER_BLOCK', `${OWNER}: ${block.error}`)
    return
  }
  const owner = block.value
  // 스크립트는 중괄호까지 포함한 자리 표시를 정확히 한 번 바꾼다. 이름만 있고 자리
  // 표시가 없으면 manifest 없는 프롬프트가 나간다.
  if (owner.split('{REVIEW_VERDICT_CONTRACT_V1_MANIFEST}').length - 1 !== 1) {
    failCode('verdict-contract', 'E_VERDICT_OWNER_NO_MANIFEST_INJECTION', `${OWNER} must carry the {REVIEW_VERDICT_CONTRACT_V1_MANIFEST} placeholder exactly once — a verdict contract with no producer instruction cannot be reached at runtime`)
  }

  // The closed lists live in the manifest. Guessing which words are contract tokens by
  // their shape misses the ones that look like ordinary prose, so read only the token the
  // owner actually attaches to each field name.
  // Field names are not values. A required-field list reads `disposition`, `evidence` —
  // taking the next token as disposition's value flags a correct sentence. The manifest
  // says which strings are field names, so skip exactly those rather than loosening the
  // shape heuristic, which exists because contract tokens can look like ordinary prose.
  const FIELD_NAMES = new Set([
    ...(manifest.topLevel?.allowed ?? []),
    ...(manifest.verdictsItem?.allowed ?? []),
    ...(manifest.rebuttal?.allowed ?? []),
    ...(manifest.observedAxes?.fields ?? []),
  ])

  const firstTokenAfter = (text, marker, limit = 40) => {
    const found = new Set()
    let at = text.indexOf(marker)
    while (at !== -1) {
      const window = text.slice(at + marker.length, at + marker.length + limit)
      for (const hit of window.matchAll(/`([a-z][a-zA-Z-]*)`/g)) {
        // The field name repeats near itself in prose; it is not a value.
        if (hit[1] === marker.split('.').pop() || FIELD_NAMES.has(hit[1])) continue
        found.add(hit[1])
        break
      }
      at = text.indexOf(marker, at + 1)
    }
    return found
  }

  const dispositions = manifest.disposition?.enum ?? []
  const kinds = manifest.rebuttal?.kindEnum ?? []
  const ORCHESTRATOR_ASSIGNED = new Set(['not-eligible', 'verification-disabled', 'verification-unavailable', 'scope-open'])

  for (const token of firstTokenAfter(owner, 'rebuttal.kind')) {
    if (kinds.includes(token)) continue
    failCode('verdict-contract', 'E_VERDICT_OWNER_UNKNOWN_REBUTTAL_KIND', `${OWNER} names rebuttal kind "${token}" which is not in the manifest kindEnum`)
  }
  for (const token of firstTokenAfter(owner, 'disposition')) {
    if (dispositions.includes(token) || ORCHESTRATOR_ASSIGNED.has(token)) continue
    failCode('verdict-contract', 'E_VERDICT_OWNER_UNKNOWN_DISPOSITION', `${OWNER} names disposition "${token}" which is neither in the manifest enum nor orchestrator-assigned`)
  }

  // The prompt must name every required field, not just leave them in the injected JSON.
  //
  // 실제로 그러지 않은 실행에서 verifier verdict 18건 중 16건이 최초 schema를 위반했고,
  // 같은 실행의 producer 22건은 전부 통과했다. 차이는 producer prompt가 필수 top-level
  // 필드를 문장으로 못 박은 반면, verifier prompt는 `evidence`를 한 번도 말하지 않고
  // `location`은 `rebuttal` 문맥에서만 언급한 것이었다. **manifest는 주입돼 있었다** —
  // JSON은 보이는데 산문이 그 둘을 빠뜨리면 산문이 이긴다.
  for (const field of manifest.verdictsItem?.required ?? []) {
    if (owner.includes(`\`${field}\``)) continue
    failCode('verdict-contract', 'E_VERDICT_OWNER_REQUIRED_FIELD_UNSTATED', `${OWNER} never names required verdict field "${field}" — injecting the manifest is not enough when the prose omits it`)
  }
}

validateVerdictOwnerSync()

function validateClauseReferences() {
  const contract = rulesFile('workflow-contract.md')
  const defined = new Set([...contract.matchAll(/^## (C-\d+[A-Z]?)\./gm)].map(m => m[1]))
  if (defined.size === 0) return
  const sources = [
    ...skillDirs.map(dir => [`skills/${dir}/SKILL.md`, read(join(SKILLS, dir, 'SKILL.md'))]),
    ['review-rules/workflow-contract.md', contract],
  ]
  for (const [where, text] of sources) {
    for (const match of text.matchAll(/(?<![\w-])(C-\d+[A-Z]?)(?![\w-])/g)) {
      const clause = match[1]
      if (defined.has(clause)) continue
      failCode('clause-refs', 'E_UNKNOWN_CONTRACT_CLAUSE', `${where} references ${clause}, which workflow-contract.md does not define`)
    }
  }
}

validateClauseReferences()

const KNOWN_MODULE_PHASES = new Set(['consolidated', 'module', 'post-verification-synthesis'])

function validatePhaseByWorkflow() {
  let catalog
  try {
    catalog = JSON.parse(rulesFile('catalog.json'))
  } catch {
    return
  }
  const contract = rulesFile('workflow-contract.md')
  const modules = Object.values(catalog.modules ?? {})
  for (const module of modules) {
    const phases = module.phaseByWorkflow
    if (!phases) continue
    const declared = new Set(module.workflows ?? [])
    for (const [workflow, phase] of Object.entries(phases)) {
      if (!declared.has(workflow)) {
        failCode('catalog', 'E_PHASE_WORKFLOW_NOT_DECLARED', `module ${module.id} declares phaseByWorkflow.${workflow} but ${workflow} is not in its workflows list`)
      }
      if (!KNOWN_MODULE_PHASES.has(phase)) {
        failCode('catalog', 'E_PHASE_UNKNOWN', `module ${module.id} declares unknown phase "${phase}" for ${workflow}`)
      }
      if (phase === 'module' || phase === 'consolidated') continue
      // The skill that runs this workflow decides the candidate set. If it does not name the
      // deferred phase, it will either dispatch the module twice or count its absence as a failure.
      const skillDir = workflow === 'default' ? 'code-review' : `code-review-${workflow}`
      const skillPath = join(SKILLS, skillDir, 'SKILL.md')
      if (existsSync(skillPath) && !read(skillPath).includes(phase)) {
        failCode('catalog', 'E_PHASE_NOT_IN_SKILL', `module ${module.id} is scheduled as "${phase}" for ${workflow}, but skills/${skillDir}/SKILL.md does not exclude it from the normal fan-out`)
      }
      // A module scheduled out of the normal fan-out changes the module count. If C-2 does
      // not say so, the orchestrator reads the gap as a missing module and fails the run.
      const mentionsModule = contract.includes('`' + module.id + '`')
      if (!contract.includes(phase) || !mentionsModule) {
        failCode('catalog', 'E_PHASE_NOT_IN_C2', `module ${module.id} is scheduled as "${phase}" for ${workflow}, but workflow-contract.md C-2 does not declare it — the module count would silently disagree`)
      }
    }
  }
}

validatePhaseByWorkflow()

function validateFixtureIdUniqueness() {
  const fixturePath = join(ROOT, 'tests', 'workflow-fixtures.md')
  if (!existsSync(fixturePath)) return
  const block = extractMarkedBlock(read(fixturePath), 'WORKFLOW_FIXTURES_JSON', 'fixtures', 'E_FIXTURE_JSON_BLOCK_COUNT')
  if (!block) return
  const parsed = parseJsonCodeBlock(block, 'WORKFLOW_FIXTURES_JSON', 'fixtures', 'E_FIXTURE_JSON_PARSE')
  if (!parsed) return
  for (const [group, cases] of Object.entries(parsed)) {
    if (!Array.isArray(cases)) continue
    const seen = new Set()
    for (const item of cases) {
      const id = item?.id
      if (id === undefined) continue
      // Two scenarios sharing an id cannot be told apart when one of them regresses.
      if (seen.has(id)) failCode('fixtures', 'E_FIXTURE_DUPLICATE_ID', `${group} has more than one case with id ${id}`)
      seen.add(id)
    }
  }
}

validateFixtureIdUniqueness()

function validateCrossVerificationRenderTokens() {
  const contract = rulesFile('workflow-contract.md')
  const block = extractMarkedBlock(contract, 'CROSS_VERIFICATION_RENDER_TOKENS', 'render-tokens', 'E_RENDER_TOKEN_BLOCK_COUNT')
  if (!block) {
    failCode('render-tokens', 'E_RENDER_TOKENS_MISSING', 'workflow-contract.md must declare the public 교차검증 render tokens — without them a report invents its own wording and producer enums leak into public output')
    return
  }
  const declared = parseJsonCodeBlock(block, 'CROSS_VERIFICATION_RENDER_TOKENS', 'render-tokens', 'E_RENDER_TOKENS_JSON')
  if (!declared) return
  const allowed = new Set(Object.values(declared.tokens ?? {}))
  if (allowed.size === 0) {
    failCode('render-tokens', 'E_RENDER_TOKENS_EMPTY', 'CROSS_VERIFICATION_RENDER_TOKENS declares no tokens')
    return
  }
  // A non-empty map is not the same as a complete one. Drop a single key and the
  // renderer's label for that state becomes undefined, which it renders the same
  // way as "this workflow has no 교차검증 axis at all" — the axis line disappears
  // and the report still looks well-formed. The reader cannot tell a run that
  // disabled verification from a workflow that never had it.
  const missing = CROSS_VERIFICATION_TOKEN_KEYS
    .filter(key => typeof declared.tokens?.[key] !== 'string' || !declared.tokens[key])
  if (missing.length) {
    failCode('render-tokens', 'E_RENDER_TOKENS_INCOMPLETE', `CROSS_VERIFICATION_RENDER_TOKENS is missing a non-empty string for: ${missing.join(', ')} — a missing key silently drops the 교차검증 axis instead of failing`)
  }
  for (const dir of skillDirs) {
    const text = read(join(SKILLS, dir, 'SKILL.md'))
    for (const match of text.matchAll(/교차검증:[ 	]+`([^`s][^`]*)`/g)) {
      if (allowed.has(match[1])) continue
      failCode('render-tokens', 'E_RENDER_TOKEN_UNKNOWN', `skills/${dir}/SKILL.md renders 교차검증 value "${match[1]}", which C-7 does not declare`)
    }
  }
}

validateCrossVerificationRenderTokens()

function validateOwnerRestatements() {
  const contract = rulesFile('workflow-contract.md')
  const block = extractMarkedBlock(contract, 'CROSS_VERIFICATION_OWNER_RESTATEMENTS', 'restatements', 'E_RESTATEMENT_BLOCK_COUNT')
  if (!block) {
    failCode('restatements', 'E_RESTATEMENTS_MISSING', 'workflow-contract.md must declare which C-6B rules the owner skill has to restate — a rule that lives only in the contract is invisible to an orchestrator reading the skill')
    return
  }
  const declared = parseJsonCodeBlock(block, 'CROSS_VERIFICATION_OWNER_RESTATEMENTS', 'restatements', 'E_RESTATEMENTS_JSON')
  if (!declared) return
  const OWNER = 'skills/code-review-full/SKILL.md'
  const ownerPath = join(ROOT, OWNER)
  if (!existsSync(ownerPath)) return
  const owner = read(ownerPath)
  for (const [id, phrase] of Object.entries(declared.mustAppearInOwner ?? {})) {
    if (owner.includes(phrase)) continue
    failCode('restatements', 'E_RESTATEMENT_MISSING', `${OWNER} does not restate "${id}" — the contract requires the phrase ${JSON.stringify(phrase)}`)
  }
}

validateOwnerRestatements()

// ------------------------------------------------------- workflow fixtures

{
  const fixturePath = join(ROOT, 'tests', 'workflow-fixtures.md')
  if (!existsSync(fixturePath)) {
    fail('fixtures', 'tests/workflow-fixtures.md is missing')
  } else {
    const contract = rulesFile('workflow-contract.md')
    const clauses = new Set([...contract.matchAll(/^## (C-\d+[A-Z]?)\./gm)].map(m => m[1]))
    const fixtureText = read(fixturePath)
    const block = extractMarkedBlock(fixtureText, 'WORKFLOW_FIXTURES_JSON', 'fixtures', 'E_WORKFLOW_FIXTURE_BLOCK_COUNT')
    const payload = block ? parseJsonCodeBlock(block, 'WORKFLOW_FIXTURES_JSON', 'fixtures', 'E_WORKFLOW_FIXTURE_JSON') : null
    validateMarkdownBlocks('tests/workflow-fixtures.md', fixtureText, 'fixtures')
    const referenced = new Set()
    for (const entry of payload?.contractCases ?? []) {
      for (const clause of entry.clauses ?? []) referenced.add(clause)
    }
    if (!Array.isArray(payload?.semanticPreservationCases) || payload.semanticPreservationCases.length === 0) {
      failCode('fixtures', 'E_WORKFLOW_SEMANTIC_CASES_MISSING', 'workflow-fixtures.md must include semanticPreservationCases for public-output regression checks')
    } else {
      const requiredAssertionKeys = ['findingCount', 'wordingBody', 'axes', 'ids', 'sourceLabels', 'categoryMeanings', 'recommendationEvidenceReason', 'locations', 'openQuestions']
      for (const entry of payload.semanticPreservationCases) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          failCode('fixtures', 'E_WORKFLOW_SEMANTIC_CASE_SHAPE', 'semanticPreservationCases entries must be objects')
          continue
        }
        const missingCaseKeys = ['id', 'workflow', 'scenario', 'preserves'].filter(key => !entry[key])
        if (missingCaseKeys.length > 0) {
          failCode('fixtures', 'E_WORKFLOW_SEMANTIC_CASE_FIELDS', `semanticPreservationCases entry is missing ${missingCaseKeys.join(', ')}`)
          continue
        }
        const missingAssertionKeys = requiredAssertionKeys.filter(key => !Array.isArray(entry.preserves?.[key]) || entry.preserves[key].length === 0)
        if (missingAssertionKeys.length > 0) {
          failCode('fixtures', 'E_WORKFLOW_SEMANTIC_ASSERTIONS', `semanticPreservationCases[${entry.id}] must preserve ${missingAssertionKeys.join(', ')}`)
        }
      }
    }
    for (const clause of clauses) {
      if (!referenced.has(clause)) {
        fail('fixtures', `workflow-fixtures.md: contract clause ${clause} has no scenario`)
      }
    }
    for (const clause of referenced) {
      if (!clauses.has(clause)) {
        fail('fixtures', `workflow-fixtures.md: scenario cites ${clause}, which is not a contract clause`)
      }
    }
    for (const manualId of ['M-1', 'M-2', 'M-3']) {
      if (!fixtureText.includes(`| ${manualId} |`)) {
        failCode('fixtures', 'E_WORKFLOW_MANUAL_CASE_MISSING', `workflow-fixtures.md must include manual scenario ${manualId}`)
      }
    }
    const correctnessDirectCase = (payload?.contractCases ?? []).find(entry => entry?.id === 54)
    if (!correctnessDirectCase) {
      failCode('fixtures', 'E_WORKFLOW_CORRECTNESS_DIRECT_CASE_MISSING', 'workflow-fixtures.md must include contract case 54 for correctness remaining direct-only until a consumer exists')
    } else {
      const expectedClauses = ['C-6A', 'C-7']
      if (!sameMembers(correctnessDirectCase.clauses ?? [], expectedClauses)) {
        failCode('fixtures', 'E_WORKFLOW_CORRECTNESS_DIRECT_CASE_CLAUSES', `workflow-fixtures.md case 54 must cite exactly ${expectedClauses.join(', ')}`)
      }
      if (!/not V1 until an orchestrator consumer exists|direct-only until a consumer exists/i.test(`${correctnessDirectCase.scenario ?? ''} ${correctnessDirectCase.expected ?? ''}`)) {
        failCode('fixtures', 'E_WORKFLOW_CORRECTNESS_DIRECT_CASE_WORDING', 'workflow-fixtures.md case 54 must assert that correctness is not structured-v1 until an orchestrator consumer exists')
      }
    }
    const structuredLocationLifecycleCase = (payload?.contractCases ?? []).find(entry => entry?.id === 55)
    if (!structuredLocationLifecycleCase) {
      failCode('fixtures', 'E_WORKFLOW_STRUCTURED_LOCATION_LIFECYCLE_CASE_MISSING', 'workflow-fixtures.md must include contract case 55 for raw structured versus public/legacy unverified-location output')
    } else {
      const expectedClauses = ['C-6A', 'C-7']
      if (!sameMembers(structuredLocationLifecycleCase.clauses ?? [], expectedClauses)) {
        failCode('fixtures', 'E_WORKFLOW_STRUCTURED_LOCATION_LIFECYCLE_CASE_CLAUSES', `workflow-fixtures.md case 55 must cite exactly ${expectedClauses.join(', ')}`)
      }
      const lifecycleText = `${structuredLocationLifecycleCase.scenario ?? ''} ${structuredLocationLifecycleCase.expected ?? ''}`
      if (!/marker|machine token|absence guard|allow block/i.test(lifecycleText) || !/location\.kind=unverified/i.test(lifecycleText) || !/위치 미확인/.test(lifecycleText)) {
        failCode('fixtures', 'E_WORKFLOW_STRUCTURED_LOCATION_LIFECYCLE_CASE_WORDING', 'workflow-fixtures.md case 55 must describe the marker-driven absence guard, location.kind=unverified raw output, and the explicit 위치 미확인 allow block')
      }
    }
  }
}

/**
 * 두 축 줄이 헤딩 바로 다음 줄이라는 것을, 예시와 산문 양쪽에서 확인한다.
 *
 * 왜 있는가: 계약은 이 모양을 **예시로만** 보여줬고, 한 실행이 48개 지적 전부에
 * 헤딩과 축 줄 사이 빈 줄을 넣어 렌더한 뒤 리포트 전체를 다시 썼다. 보여주는
 * 것과 말하는 것은 다른 일이다 — verifier prompt에서 필수 필드를 주입해 놓고
 * 산문이 빠뜨려 준수율이 무너진 것과 같은 실패다.
 *
 * 산문이 있는지와 **예시가 그 산문을 지키는지**를 함께 본다. 예시가 드리프트하면
 * 읽는 쪽은 예시를 따라간다.
 */
function validateAxisLinePlacement() {
  const workflowContract = rulesFile('workflow-contract.md')
  if (!/헤딩 바로 다음 줄이다/.test(workflowContract)) {
    failCode('workflow-contract', 'E_AXIS_LINE_PLACEMENT_UNSTATED', 'workflow-contract.md must state in prose that the two-axis line is the line immediately after the finding heading, not only show it in an example')
  }
  // 지적 헤딩은 severity 이모지로 시작한다. 목차나 설명용 `####`와 구분된다.
  //
  // 축 줄이 **없는** 예시는 이 규칙의 대상이 아니다 — 같은 규칙 ID의 순번 표기처럼
  // 헤딩 줄만 나란히 보여주는 예시가 있고, 거기에 축 줄을 요구하면 다른 것을
  // 가르치는 예시를 망가뜨린다. 그래서 축 줄을 담은 예시 블록 안에서만 인접을 본다.
  const lines = workflowContract.split('\n')
  const blocks = []
  let current = null
  lines.forEach((line, at) => {
    if (line.startsWith('```')) {
      if (current) { blocks.push(current); current = null }
      else current = { from: at, lines: [] }
      return
    }
    if (current) current.lines.push({ line, at })
  })
  for (const block of blocks) {
    if (!block.lines.some(entry => entry.line.startsWith('영향:'))) continue
    block.lines.forEach((entry, index) => {
      if (!/^#### [🔴🟡🔵]/.test(entry.line)) return
      const next = block.lines[index + 1]?.line ?? ''
      if (!next.startsWith('영향:')) {
        failCode('workflow-contract', 'E_AXIS_LINE_NOT_ADJACENT', `workflow-contract.md:${entry.at + 1} shows a finding heading whose next line is not the 영향 axis line — the example must obey the rule it teaches`)
      }
    })
  }
}

function validateVersionPolicySync() {
  const readme = read(join(ROOT, 'README.md'))
  const script = read(join(ROOT, 'scripts', 'check-version-bump.mjs'))
  if (readme.includes('intentionally accepted internal producer→orchestrator interface change for registered structured owners') && !script.includes('internal producer') && !script.includes('structured owners')) {
    failCode('readme', 'E_VERSION_POLICY_SYNC_INTERNAL_INTERFACE', 'README allows a MINOR bump for registered structured-owner internal interface changes, but scripts/check-version-bump.mjs does not describe that policy')
  }
}

validateContractManifestAndFixtures()
validateStructuredProducerDocs()
validateAxisLinePlacement()
validateVersionPolicySync()

// ------------------------------------------------------------------ report

const byCheck = new Map()
for (const p of problems) {
  if (!byCheck.has(p.check)) byCheck.set(p.check, [])
  byCheck.get(p.check).push(p.message)
}

if (problems.length === 0) {
  console.log(`OK — ${moduleFiles.length} numbered modules, ${ruleMeta.size} rules, ${skillDirs.length} skills, ${agentFiles.length} agent(s)`)
  process.exit(0)
}

for (const [check, messages] of byCheck) {
  console.error(`\n[${check}] ${messages.length} problem(s)`)
  for (const m of messages) console.error(`  - ${m}`)
}
console.error(`\n${problems.length} problem(s) found.`)
process.exit(1)
