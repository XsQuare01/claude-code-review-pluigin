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

const read = p => readFileSync(p, 'utf8')
const rulesFile = name => read(join(RULES, name))

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
    if (!/^\d+\.\d+\.\d+$/.test(plugin.version ?? '')) {
      fail('manifest', `plugin.json: version must be MAJOR.MINOR.PATCH, got "${plugin.version}"`)
    }
  }

  // package smoke check: the pieces a working install needs
  for (const required of ['review-rules', 'skills', '.claude-plugin/plugin.json', 'README.md']) {
    if (!existsSync(join(ROOT, required))) fail('manifest', `packaged plugin is missing ${required}`)
  }
  for (const dir of skillDirs) {
    const front = read(join(SKILLS, dir, 'SKILL.md')).split('---')[1] ?? ''
    if (!/^\s*name:\s*\S+/m.test(front)) fail('manifest', `skills/${dir}/SKILL.md: frontmatter has no name`)
    if (!/^\s*description:\s*\S+/m.test(front)) fail('manifest', `skills/${dir}/SKILL.md: frontmatter has no description`)
  }
}

// ------------------------------------------------------- workflow fixtures

{
  const fixturePath = join(ROOT, 'tests', 'workflow-fixtures.md')
  if (!existsSync(fixturePath)) {
    fail('fixtures', 'tests/workflow-fixtures.md is missing')
  } else {
    const contract = rulesFile('workflow-contract.md')
    const clauses = new Set([...contract.matchAll(/^## (C-\d+)\./gm)].map(m => m[1]))
    const referenced = new Set([...read(fixturePath).matchAll(/\bC-\d+\b/g)].map(m => m[0]))
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
  }
}

// ------------------------------------------------------------------ report

const byCheck = new Map()
for (const p of problems) {
  if (!byCheck.has(p.check)) byCheck.set(p.check, [])
  byCheck.get(p.check).push(p.message)
}

if (problems.length === 0) {
  console.log(`OK — ${moduleFiles.length} numbered modules, ${ruleMeta.size} rules, ${skillDirs.length} skills`)
  process.exit(0)
}

for (const [check, messages] of byCheck) {
  console.error(`\n[${check}] ${messages.length} problem(s)`)
  for (const m of messages) console.error(`  - ${m}`)
}
console.error(`\n${problems.length} problem(s) found.`)
process.exit(1)
