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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function extractMarkedBlock(text, label, check, code) {
  const begin = `<!-- ${label}:BEGIN -->`
  const end = `<!-- ${label}:END -->`
  const beginCount = text.split(begin).length - 1
  const endCount = text.split(end).length - 1
  if (beginCount !== 1 || endCount !== 1) {
    failCode(check, code, `${label} block must appear exactly once (found BEGIN=${beginCount}, END=${endCount})`)
    return null
  }
  const start = text.indexOf(begin)
  const finish = text.indexOf(end)
  if (finish <= start) {
    failCode(check, code, `${label} block end appears before begin`)
    return null
  }
  return text.slice(start + begin.length, finish).trim()
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

function addError(target, code, message) {
  target.push({ code, message })
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

const CONTRACT_CATEGORY_IDS = [
  'user-malfunction',
  'data-loss',
  'security-exposure',
  'verification-failure',
  'external-breakage',
]

const CONTRACT_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'findings', 'openQuestions'])
const FINDING_ALLOWED_KEYS = new Set(['ruleId', 'title', 'body', 'impact', 'confidence', 'location', 'category', 'evidence', 'reason', 'recommendation'])
const OPEN_QUESTION_ALLOWED_KEYS = new Set(['ruleId', 'title', 'body', 'location', 'reason', 'recommendation'])
const STRUCTURED_PRODUCER_MARKER = 'REVIEW_RESULT_CONTRACT_V1_PRODUCER_OUTPUT'
const LOCATION_ALLOWED_KEYS = {
  verified: new Set(['kind', 'path', 'line', 'quote']),
  deleted: new Set(['kind', 'path', 'lineBefore', 'quote']),
  unverified: new Set(['kind', 'reason']),
}

function validatePlainObject(value, errors, code, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    addError(errors, code, `${where} must be an object`)
    return false
  }
  return true
}

function scanForbiddenSeverity(value, errors, where) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenSeverity(item, errors, `${where}[${index}]`))
    return
  }
  if (hasOwn(value, 'severity')) addError(errors, 'E_FORBIDDEN_SEVERITY', `${where} must not contain severity`)
  for (const [key, nested] of Object.entries(value)) scanForbiddenSeverity(nested, errors, `${where}.${key}`)
}

function validateRequiredString(object, key, errors, code, where) {
  if (!hasOwn(object, key) || typeof object[key] !== 'string' || object[key].trim() === '') {
    addError(errors, code, `${where}.${key} must be a non-empty string`)
  }
}

function validateUnknownKeys(object, allowedKeys, errors, code, where, ignoredKeys = new Set()) {
  for (const key of Object.keys(object)) {
    if (ignoredKeys.has(key)) continue
    if (!allowedKeys.has(key)) addError(errors, code, `${where} contains unknown key "${key}"`)
  }
}

function validateLocation(location, errors, where) {
  if (!validatePlainObject(location, errors, 'E_LOCATION_NOT_OBJECT', where)) return
  if (typeof location.kind !== 'string') {
    addError(errors, 'E_LOCATION_MISSING_KIND', `${where}.kind must be a string`)
    return
  }
  const allowed = LOCATION_ALLOWED_KEYS[location.kind]
  if (!allowed) {
    addError(errors, 'E_LOCATION_INVALID_KIND', `${where}.kind must be one of verified, deleted, unverified`)
    return
  }
  const ignoreSeverity = new Set(['severity'])
  if (location.kind === 'verified') {
    validateUnknownKeys(location, allowed, errors, 'E_LOCATION_UNKNOWN_KEY', where, ignoreSeverity)
    validateRequiredString(location, 'path', errors, 'E_LOCATION_VERIFIED_REQUIRES_PATH', where)
    if (!Number.isInteger(location.line) || location.line < 1) addError(errors, 'E_LOCATION_VERIFIED_REQUIRES_LINE', `${where}.line must be a positive integer`)
    validateRequiredString(location, 'quote', errors, 'E_LOCATION_VERIFIED_REQUIRES_QUOTE', where)
    return
  }
  if (location.kind === 'deleted') {
    validateUnknownKeys(location, allowed, errors, 'E_LOCATION_UNKNOWN_KEY', where, ignoreSeverity)
    validateRequiredString(location, 'path', errors, 'E_LOCATION_DELETED_REQUIRES_PATH', where)
    if (!Number.isInteger(location.lineBefore) || location.lineBefore < 1) addError(errors, 'E_LOCATION_DELETED_REQUIRES_LINE_BEFORE', `${where}.lineBefore must be a positive integer`)
    validateRequiredString(location, 'quote', errors, 'E_LOCATION_DELETED_REQUIRES_QUOTE', where)
    return
  }
  validateUnknownKeys(location, new Set(['kind', 'reason', 'path', 'line', 'lineBefore', 'quote']), errors, 'E_LOCATION_UNKNOWN_KEY', where, ignoreSeverity)
  validateRequiredString(location, 'reason', errors, 'E_LOCATION_UNVERIFIED_REQUIRES_REASON', where)
  if (hasOwn(location, 'path')) addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_PATH', `${where}.path is forbidden when kind is unverified`)
  if (hasOwn(location, 'line') || hasOwn(location, 'lineBefore')) addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_LINE', `${where}.line and .lineBefore are forbidden when kind is unverified`)
  if (hasOwn(location, 'quote')) addError(errors, 'E_LOCATION_UNVERIFIED_FORBIDS_QUOTE', `${where}.quote is forbidden when kind is unverified`)
}

function validateFinding(item, errors, where) {
  if (!validatePlainObject(item, errors, 'E_FINDING_NOT_OBJECT', where)) return
  validateUnknownKeys(item, FINDING_ALLOWED_KEYS, errors, 'E_FINDING_UNKNOWN_KEY', where)
  for (const key of ['ruleId', 'title', 'body']) validateRequiredString(item, key, errors, `E_FINDING_REQUIRES_${key.toUpperCase()}`, where)
  if (!['high', 'low'].includes(item.impact)) addError(errors, 'E_FINDING_INVALID_IMPACT', `${where}.impact must be high or low`)
  if (!['high', 'low'].includes(item.confidence)) addError(errors, 'E_FINDING_INVALID_CONFIDENCE', `${where}.confidence must be high or low`)
  validateLocation(item.location, errors, `${where}.location`)
  if (item.impact === 'high') {
    if (!hasOwn(item, 'category')) addError(errors, 'E_FINDING_HIGH_REQUIRES_CATEGORY', `${where}.category is required when impact is high`)
    else if (!CONTRACT_CATEGORY_IDS.includes(item.category)) addError(errors, 'E_FINDING_INVALID_CATEGORY', `${where}.category must be one of the five approved IDs`)
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
  if (!validatePlainObject(item, errors, 'E_OPEN_QUESTION_NOT_OBJECT', where)) return
  validateUnknownKeys(item, OPEN_QUESTION_ALLOWED_KEYS, errors, 'E_OPEN_QUESTION_UNKNOWN_KEY', where)
  for (const key of ['title', 'body', 'reason']) validateRequiredString(item, key, errors, `E_OPEN_QUESTION_REQUIRES_${key.toUpperCase()}`, where)
  validateLocation(item.location, errors, `${where}.location`)
}

function validateReviewResultContract(value) {
  const errors = []
  if (!validatePlainObject(value, errors, 'E_TOPLEVEL_NOT_OBJECT', 'result')) return errors
  scanForbiddenSeverity(value, errors, 'result')
  validateUnknownKeys(value, CONTRACT_TOP_LEVEL_KEYS, errors, 'E_TOPLEVEL_UNKNOWN_KEY', 'result')
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
  'agents/correctness-reviewer.md',
  'review-rules/props.md',
  'review-rules/math.md',
  'review-rules/exception.md',
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
const STRUCTURED_PRODUCER_FILES = [
  ...moduleFiles.filter(file => file !== '00-rule.md').map(file => `review-rules/${file}`),
  ...EXPLICIT_STRUCTURED_PRODUCER_FILES,
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

  for (const file of allFiles.filter(f => f.endsWith('.md') && f !== 'workflow-contract.md')) {
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

      for (const specialist of ['props', 'math', 'exception']) {
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
    const prefixes = [...new Set([...text.matchAll(/\b([A-Z]{2,3})-\{/g)].map(m => m[1]))]
    if (prefixes.length === 0) {
      fail('agent', `${where}: declares no finding ID prefix`)
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

// ------------------------------------------- structured result contract/docs

function validateStructuredProducerDocs() {
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

  for (const relativePath of STRUCTURED_PRODUCER_FILES) {
    const text = read(join(ROOT, relativePath))
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
    }
  }
}

function validateContractManifestAndFixtures() {
  const commonRules = rulesFile('00-rule.md')
  const block = extractMarkedBlock(commonRules, 'REVIEW_RESULT_CONTRACT_V1', 'structured-contract', 'E_MANIFEST_BLOCK_COUNT')
  if (!block) return
  const manifest = parseJsonCodeBlock(block, 'REVIEW_RESULT_CONTRACT_V1', 'structured-contract', 'E_MANIFEST_JSON')
  if (!manifest) return

  const sameMembers = (actual, expected) => actual.length === expected.length && expected.every(value => actual.includes(value))
  if (manifest.contractName !== 'REVIEW_RESULT_CONTRACT_V1') failCode('structured-contract', 'E_MANIFEST_CONTRACT_NAME', 'manifest.contractName must be REVIEW_RESULT_CONTRACT_V1')
  if (manifest.schemaVersion !== 1) failCode('structured-contract', 'E_MANIFEST_SCHEMA_VERSION', 'manifest.schemaVersion must be 1')
  if (!sameMembers(manifest.topLevel?.required ?? [], ['schemaVersion', 'findings', 'openQuestions'])) failCode('structured-contract', 'E_MANIFEST_TOPLEVEL_REQUIRED', 'manifest.topLevel.required must be exactly schemaVersion, findings, openQuestions')
  if (!sameMembers(manifest.topLevel?.forbidden ?? [], ['severity'])) failCode('structured-contract', 'E_MANIFEST_TOPLEVEL_FORBIDDEN', 'manifest.topLevel.forbidden must be exactly severity')
  if (!sameMembers(manifest.impact?.enum ?? [], ['high', 'low'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_ENUM', 'manifest.impact.enum must be exactly high, low')
  if (!sameMembers(manifest.impact?.highRequires ?? [], ['category', 'evidence'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_HIGH_REQUIRES', 'manifest.impact.highRequires must be exactly category and evidence')
  if (!sameMembers(manifest.impact?.lowForbids ?? [], ['category'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_LOW_FORBIDS', 'manifest.impact.lowForbids must be exactly category')
  if (!sameMembers(manifest.impact?.lowAllowsOptional ?? [], ['evidence'])) failCode('structured-contract', 'E_MANIFEST_IMPACT_LOW_OPTIONAL', 'manifest.impact.lowAllowsOptional must be exactly evidence')
  if (!sameMembers(manifest.impact?.categoryEnum ?? [], CONTRACT_CATEGORY_IDS)) failCode('structured-contract', 'E_MANIFEST_CATEGORY_ENUM', 'manifest.impact.categoryEnum must contain exactly the five approved IDs')
  if (!sameMembers(manifest.confidence?.enum ?? [], ['high', 'low'])) failCode('structured-contract', 'E_MANIFEST_CONFIDENCE_ENUM', 'manifest.confidence.enum must be exactly high, low')
  if (!sameMembers(manifest.confidence?.lowRequires ?? [], ['reason'])) failCode('structured-contract', 'E_MANIFEST_CONFIDENCE_LOW_REQUIRES', 'manifest.confidence.lowRequires must be exactly reason')
  if (manifest.location?.kindField !== 'kind') failCode('structured-contract', 'E_MANIFEST_LOCATION_KIND_FIELD', 'manifest.location.kindField must be kind')

  const variants = manifest.location?.variants ?? {}
  if (!sameMembers(Object.keys(variants), ['verified', 'deleted', 'unverified'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_VARIANTS', 'manifest.location.variants must define exactly verified, deleted, unverified')
  if (!sameMembers(variants.verified?.required ?? [], ['path', 'line', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_VERIFIED', 'manifest.location.variants.verified.required must be path, line, quote')
  if (!sameMembers(variants.deleted?.required ?? [], ['path', 'lineBefore', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_DELETED', 'manifest.location.variants.deleted.required must be path, lineBefore, quote')
  if (!sameMembers(variants.unverified?.required ?? [], ['reason'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_UNVERIFIED_REQUIRED', 'manifest.location.variants.unverified.required must be reason only')
  if (!sameMembers(variants.unverified?.forbidden ?? [], ['path', 'line', 'lineBefore', 'quote'])) failCode('structured-contract', 'E_MANIFEST_LOCATION_UNVERIFIED_FORBIDDEN', 'manifest.location.variants.unverified.forbidden must be path, line, lineBefore, quote')
  if (!sameMembers(manifest.findingsItem?.required ?? [], ['ruleId', 'title', 'body', 'impact', 'confidence', 'location'])) failCode('structured-contract', 'E_MANIFEST_FINDINGS_REQUIRED', 'manifest.findingsItem.required must match the approved finding envelope')
  if (!sameMembers(manifest.findingsItem?.forbidden ?? [], ['severity'])) failCode('structured-contract', 'E_MANIFEST_FINDINGS_FORBIDDEN', 'manifest.findingsItem.forbidden must be exactly severity')
  if (!sameMembers(manifest.openQuestionsItem?.required ?? [], ['title', 'body', 'location', 'reason'])) failCode('structured-contract', 'E_MANIFEST_OPEN_QUESTIONS_REQUIRED', 'manifest.openQuestionsItem.required must be exactly title, body, location, reason')
  if (manifest.renderingSafety?.renderBySlot !== true) failCode('structured-contract', 'E_MANIFEST_RENDER_BY_SLOT', 'manifest.renderingSafety.renderBySlot must be true')
  if (manifest.renderingSafety?.escapeMarkdownControlInProseFields !== true) failCode('structured-contract', 'E_MANIFEST_RENDER_ESCAPE_PROSE', 'manifest.renderingSafety.escapeMarkdownControlInProseFields must be true')
  if (!sameMembers(manifest.renderingSafety?.codeFields ?? [], ['location.path', 'location.quote'])) failCode('structured-contract', 'E_MANIFEST_RENDER_CODE_FIELDS', 'manifest.renderingSafety.codeFields must be exactly location.path and location.quote')
  if (manifest.renderingSafety?.urlsRenderAs !== 'plain-text') failCode('structured-contract', 'E_MANIFEST_RENDER_URLS', 'manifest.renderingSafety.urlsRenderAs must be plain-text')
  if (manifest.renderingSafety?.staticValidatorScope !== 'doc-sync-only') failCode('structured-contract', 'E_MANIFEST_RENDER_VALIDATOR_SCOPE', 'manifest.renderingSafety.staticValidatorScope must be doc-sync-only')

  for (const token of ['schemaVersion', 'findings', 'openQuestions', 'verified', 'deleted', 'unverified', 'lowAllowsOptional', 'renderingSafety', 'renderBySlot', 'escapeMarkdownControlInProseFields', 'plain-text', 'doc-sync-only', ...CONTRACT_CATEGORY_IDS]) {
    if (!commonRules.includes(token)) failCode('structured-contract', 'E_MANIFEST_PROSE_TOKEN_SYNC', `00-rule.md prose must mention token ${token}`)
  }
  const workflowContract = rulesFile('workflow-contract.md')
  for (const token of ['schemaVersion', 'findings', 'openQuestions', 'unverified', 'renderBySlot', 'plain text', 'source/pass label']) {
    if (!workflowContract.includes(token)) failCode('structured-contract', 'E_WORKFLOW_TOKEN_SYNC', `workflow-contract.md must mention token ${token}`)
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
      if (findings.some(item => item?.location?.kind === 'unverified') || openQuestions.some(item => item?.location?.kind === 'unverified')) coverage.validUnverified = true
      if (findings.some(item => item?.location?.kind === 'unverified')) coverage.validUnverifiedFinding = true
      if (openQuestions.length > 0) coverage.validNonEmptyOpenQuestions = true
      if (findings.some(item => item?.impact === 'low' && hasOwn(item, 'evidence'))) coverage.validLowImpactWithEvidence = true
      if (resultErrors.length > 0) failCode('fixtures', 'E_FIXTURE_EXPECTED_VALID', `${path.slice(ROOT.length + 1)} should be valid but failed with ${actualCodes.join(', ')}`)
    } else if (payload.expected === 'invalid') {
      if (expectedCodes.includes('E_LOCATION_DELETED_REQUIRES_PATH') && expectedCodes.includes('E_LOCATION_DELETED_REQUIRES_LINE_BEFORE') && expectedCodes.includes('E_LOCATION_DELETED_REQUIRES_QUOTE')) {
        coverage.invalidDeletedMissingFields = true
      }
      if (expectedCodes.includes('E_LOCATION_UNVERIFIED_FORBIDS_PATH')) coverage.invalidUnverifiedForbiddenPath = true
      if (expectedCodes.includes('E_LOCATION_UNVERIFIED_FORBIDS_LINE') && expectedCodes.includes('E_LOCATION_UNVERIFIED_FORBIDS_QUOTE')) coverage.invalidUnverifiedForbiddenLineQuote = true
      if (expectedCodes.includes('E_FINDING_UNKNOWN_KEY')) coverage.invalidFindingUnknownKey = true
      if (expectedCodes.includes('E_OPEN_QUESTION_UNKNOWN_KEY')) coverage.invalidOpenQuestionUnknownKey = true
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
}

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
    const referenced = new Set()
    for (const entry of payload?.contractCases ?? []) {
      for (const clause of entry.clauses ?? []) referenced.add(clause)
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
  }
}

validateContractManifestAndFixtures()
validateStructuredProducerDocs()

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
