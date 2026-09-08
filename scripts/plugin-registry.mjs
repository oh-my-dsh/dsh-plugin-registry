#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultRegistryRoot = join(repoRoot, 'registry')
const MAX_INDEX_BYTES = 5 * 1024 * 1024
const MAX_SOURCE_MANIFEST_BYTES = 1024 * 1024

export const REGISTRY_CONTRACT = 'dsh-plugin-registry/v2'
export const REGISTRY_INDEX_SCHEMA = 'https://raw.githubusercontent.com/oh-my-dsh/dsh-plugin-registry/main/registry/schema/plugin-index.schema.json'
export const scopedClaimKinds = ['services', 'tools', 'commands', 'skillProviders', 'settingsNamespaces']
export const searchKinds = [
  'pluginIds',
  'packages',
  'pluginNames',
  'loaderIds',
  ...scopedClaimKinds,
  'skills',
  'events',
  'routes',
]

const coordinatePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/
const namePattern = /^[^\s\u0000-\u001f\u007f]{1,192}$/u
const scopePattern = /^(?:root|agent|unknown|isolated:[a-z0-9]+(?:-[a-z0-9]+)*)$/
const sourcePathPattern = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[^\u0000-\u001f\u007f\\?#]+\.json$/u
const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const routeKinds = new Set(['exact', 'prefix', 'upgrade'])
const pluginStatuses = new Set(['active', 'deprecated', 'archived'])
const sourceSurfaceNames = [
  'pluginNames',
  'loaderIds',
  'services',
  'tools',
  'commands',
  'skills',
  'skillProviders',
  'events',
  'settingsNamespaces',
  'routes',
]

function posixPath(value) {
  return value.replaceAll('\\', '/')
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function normalizeNewlines(value) {
  return value.replaceAll('\r\n', '\n')
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareText)
}

function addError(errors, path, message) {
  errors.push({ path, message })
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function checkObject(value, path, errors) {
  if (!isObject(value)) {
    addError(errors, path, 'must be an object')
    return false
  }
  return true
}

function checkUnknownKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, `${path}.${key}`, 'unknown field')
  }
}

function checkString(value, path, errors, { pattern, maxLength = 512, optional = false } = {}) {
  if (value === undefined && optional) return false
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    addError(errors, path, `must be a non-empty string up to ${maxLength} characters`)
    return false
  }
  if (pattern && !pattern.test(value)) {
    addError(errors, path, 'has an invalid format')
    return false
  }
  return true
}

function checkArray(value, path, errors) {
  if (!Array.isArray(value)) {
    addError(errors, path, 'must be an array')
    return false
  }
  return true
}

function checkSemver(value, path, errors, { optional = false } = {}) {
  const validString = checkString(value, path, errors, { maxLength: 128, optional })
  if (!validString) return false
  if (!parseSemver(value)) {
    addError(errors, path, 'must be a valid semantic version')
    return false
  }
  return true
}

function repositoryParts(repository) {
  try {
    const url = new URL(repository)
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== 'github.com' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) return undefined
    const segments = url.pathname.replace(/^\/|\/$/g, '').split('/')
    if (
      segments.length !== 2 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(segments[0]) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(segments[1]) ||
      segments[1] === '.' ||
      segments[1] === '..'
    ) return undefined
    return { owner: segments[0].toLowerCase(), repository: segments[1].toLowerCase() }
  } catch {
    return undefined
  }
}

function normalizedRepository(repository) {
  return repository.replace(/\/$/, '').toLowerCase()
}

export function parseSemver(value) {
  if (typeof value !== 'string') return undefined
  const match = semverPattern.exec(value)
  if (!match) return undefined
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0'))) {
    return undefined
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease,
  }
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0
  if (!left.length) return 1
  if (!right.length) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    const leftNumber = /^\d+$/.test(left[index]) ? BigInt(left[index]) : undefined
    const rightNumber = /^\d+$/.test(right[index]) ? BigInt(right[index]) : undefined
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber < rightNumber ? -1 : 1
    }
    if (leftNumber !== undefined && rightNumber === undefined) return -1
    if (leftNumber === undefined && rightNumber !== undefined) return 1
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

export function compareSemver(leftValue, rightValue) {
  const left = typeof leftValue === 'string' ? parseSemver(leftValue) : leftValue
  const right = typeof rightValue === 'string' ? parseSemver(rightValue) : rightValue
  if (!left || !right) throw new Error('compareSemver requires valid semantic versions')
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function harnessRangesOverlap(left, right) {
  const leftBeforeRightEnd = !right.maxExclusive || compareSemver(left.min, right.maxExclusive) < 0
  const rightBeforeLeftEnd = !left.maxExclusive || compareSemver(right.min, left.maxExclusive) < 0
  return leftBeforeRightEnd && rightBeforeLeftEnd
}

function validateNamedArray(value, path, errors) {
  if (!checkArray(value, path, errors)) return
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`
    const name = value[index]
    if (!checkString(name, itemPath, errors, { pattern: namePattern, maxLength: 192 })) continue
    if (seen.has(name)) addError(errors, itemPath, `duplicates ${JSON.stringify(name)} in this entry`)
    seen.add(name)
  }
}

function validateScopedArray(value, path, errors) {
  if (!checkArray(value, path, errors)) return
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const itemPath = `${path}[${index}]`
    const claim = value[index]
    if (!checkObject(claim, itemPath, errors)) continue
    checkUnknownKeys(claim, new Set(['name', 'scope']), itemPath, errors)
    const nameOk = checkString(claim.name, `${itemPath}.name`, errors, { pattern: namePattern, maxLength: 192 })
    const scopeOk = checkString(claim.scope, `${itemPath}.scope`, errors, { pattern: scopePattern, maxLength: 128 })
    if (nameOk && scopeOk) {
      const key = `${claim.name}\u0000${claim.scope}`
      if (seen.has(key)) addError(errors, itemPath, 'duplicates the same name and scope in this entry')
      seen.add(key)
    }
  }
}

function validateClaims(claims, path, errors) {
  if (!checkObject(claims, path, errors)) return
  const allowed = new Set(sourceSurfaceNames)
  checkUnknownKeys(claims, allowed, path, errors)
  for (const surface of sourceSurfaceNames) {
    if (!Object.hasOwn(claims, surface)) addError(errors, `${path}.${surface}`, 'is required')
  }

  validateNamedArray(claims.pluginNames, `${path}.pluginNames`, errors)
  if (Array.isArray(claims.pluginNames) && claims.pluginNames.length === 0) {
    addError(errors, `${path}.pluginNames`, 'must contain at least one item')
  }
  for (const kind of scopedClaimKinds) validateScopedArray(claims[kind], `${path}.${kind}`, errors)

  if (checkArray(claims.loaderIds, `${path}.loaderIds`, errors)) {
    if (claims.loaderIds.length === 0) addError(errors, `${path}.loaderIds`, 'must contain at least one item')
    const seen = new Set()
    for (let index = 0; index < claims.loaderIds.length; index += 1) {
      const itemPath = `${path}.loaderIds[${index}]`
      const claim = claims.loaderIds[index]
      if (!checkObject(claim, itemPath, errors)) continue
      checkUnknownKeys(claim, new Set(['name', 'composition', 'layer', 'overrideIntent']), itemPath, errors)
      const nameOk = checkString(claim.name, `${itemPath}.name`, errors, { pattern: namePattern, maxLength: 192 })
      const compositionOk = checkString(claim.composition, `${itemPath}.composition`, errors, {
        pattern: scopePattern,
        maxLength: 128,
      })
      if (!Number.isInteger(claim.layer) || claim.layer < 0 || claim.layer > 1024) {
        addError(errors, `${itemPath}.layer`, 'must be an integer from 0 to 1024')
      }
      if (!['none', 'replace'].includes(claim.overrideIntent)) {
        addError(errors, `${itemPath}.overrideIntent`, 'must be none or replace')
      }
      if (nameOk && compositionOk && Number.isInteger(claim.layer)) {
        const key = `${claim.name}\u0000${claim.composition}\u0000${claim.layer}`
        if (seen.has(key)) addError(errors, itemPath, 'duplicates the same Loader name, composition, and layer')
        seen.add(key)
      }
    }
  }

  if (checkArray(claims.skills, `${path}.skills`, errors)) {
    const seen = new Set()
    for (let index = 0; index < claims.skills.length; index += 1) {
      const itemPath = `${path}.skills[${index}]`
      const claim = claims.skills[index]
      if (!checkObject(claim, itemPath, errors)) continue
      checkUnknownKeys(claim, new Set(['name', 'scope', 'provider', 'rank']), itemPath, errors)
      const nameOk = checkString(claim.name, `${itemPath}.name`, errors, { pattern: namePattern, maxLength: 192 })
      const scopeOk = checkString(claim.scope, `${itemPath}.scope`, errors, { pattern: scopePattern, maxLength: 128 })
      const providerOk = checkString(claim.provider, `${itemPath}.provider`, errors, { pattern: namePattern, maxLength: 192 })
      if (!Number.isInteger(claim.rank) || claim.rank < -1000000 || claim.rank > 1000000) {
        addError(errors, `${itemPath}.rank`, 'must be an integer from -1000000 to 1000000')
      }
      if (nameOk && scopeOk && providerOk && Number.isInteger(claim.rank)) {
        const key = `${claim.name}\u0000${claim.scope}\u0000${claim.provider}\u0000${claim.rank}`
        if (seen.has(key)) addError(errors, itemPath, 'duplicates the same Skill selection claim')
        seen.add(key)
      }
    }
  }

  if (checkArray(claims.events, `${path}.events`, errors)) {
    const seen = new Set()
    for (let index = 0; index < claims.events.length; index += 1) {
      const itemPath = `${path}.events[${index}]`
      const claim = claims.events[index]
      if (!checkObject(claim, itemPath, errors)) continue
      checkUnknownKeys(claim, new Set(['name', 'scope', 'role', 'schema']), itemPath, errors)
      const nameOk = checkString(claim.name, `${itemPath}.name`, errors, { pattern: namePattern, maxLength: 192 })
      const scopeOk = checkString(claim.scope, `${itemPath}.scope`, errors, { pattern: scopePattern, maxLength: 128 })
      if (!['publisher', 'consumer', 'both'].includes(claim.role)) {
        addError(errors, `${itemPath}.role`, 'must be publisher, consumer, or both')
      }
      if (claim.schema !== null) checkString(claim.schema, `${itemPath}.schema`, errors, { maxLength: 512 })
      if (nameOk && scopeOk) {
        const key = `${claim.name}\u0000${claim.scope}\u0000${claim.role}`
        if (seen.has(key)) addError(errors, itemPath, 'duplicates the same event name, scope, and role')
        seen.add(key)
      }
    }
  }

  if (checkArray(claims.routes, `${path}.routes`, errors)) {
    const seen = new Set()
    for (let index = 0; index < claims.routes.length; index += 1) {
      const itemPath = `${path}.routes[${index}]`
      const claim = claims.routes[index]
      if (!checkObject(claim, itemPath, errors)) continue
      checkUnknownKeys(claim, new Set(['kind', 'path', 'scope']), itemPath, errors)
      if (!routeKinds.has(claim.kind)) addError(errors, `${itemPath}.kind`, 'must be exact, prefix, or upgrade')
      const routeOk = checkString(claim.path, `${itemPath}.path`, errors, {
        pattern: /^\/[^?#\s]*[^/?#\s]$/,
        maxLength: 256,
      })
      const scopeOk = checkString(claim.scope, `${itemPath}.scope`, errors, { pattern: scopePattern, maxLength: 128 })
      if (routeOk && scopeOk && routeKinds.has(claim.kind)) {
        const key = `${claim.kind}\u0000${claim.path}\u0000${claim.scope}`
        if (seen.has(key)) addError(errors, itemPath, 'duplicates the same route kind, path, and scope')
        seen.add(key)
      }
    }
  }
}

export function validateManifest(manifest, { file = 'manifest', expectedId, allowManifestPath = false } = {}) {
  const errors = []
  if (!checkObject(manifest, file, errors)) return errors
  const topLevel = new Set(['$schema', 'schemaVersion', 'plugin', 'source', 'compatibility', 'claims'])
  if (allowManifestPath) topLevel.add('manifestPath')
  checkUnknownKeys(manifest, topLevel, file, errors)
  if (manifest.schemaVersion !== 2) addError(errors, `${file}.schemaVersion`, 'must be 2')
  if (Object.hasOwn(manifest, '$schema')) checkString(manifest.$schema, `${file}.$schema`, errors)
  if (allowManifestPath) {
    checkString(manifest.manifestPath, `${file}.manifestPath`, errors, {
      pattern: sourcePathPattern,
      maxLength: 512,
    })
  }

  if (checkObject(manifest.plugin, `${file}.plugin`, errors)) {
    const path = `${file}.plugin`
    checkUnknownKeys(manifest.plugin, new Set(['id', 'displayName', 'repository', 'package', 'release', 'status']), path, errors)
    const idOk = checkString(manifest.plugin.id, `${path}.id`, errors, { pattern: coordinatePattern, maxLength: 127 })
    if (expectedId && manifest.plugin.id !== expectedId) addError(errors, `${path}.id`, `must match the entry path (${expectedId})`)
    checkString(manifest.plugin.displayName, `${path}.displayName`, errors, { maxLength: 128, optional: true })
    const repositoryOk = checkString(manifest.plugin.repository, `${path}.repository`, errors)
    const parts = repositoryOk ? repositoryParts(manifest.plugin.repository) : undefined
    if (repositoryOk && !parts) addError(errors, `${path}.repository`, 'must be a canonical https://github.com/<owner>/<repo> URL')
    const namespace = idOk ? manifest.plugin.id.split('/')[0] : undefined
    if (parts && namespace && parts.owner !== namespace) {
      addError(errors, `${path}.repository`, `GitHub owner must match plugin namespace ${JSON.stringify(namespace)}`)
    }
    checkString(manifest.plugin.package, `${path}.package`, errors, { pattern: packagePattern, maxLength: 214 })
    checkSemver(manifest.plugin.release, `${path}.release`, errors, { optional: true })
    if (!pluginStatuses.has(manifest.plugin.status)) addError(errors, `${path}.status`, 'must be active, deprecated, or archived')
  }

  if (checkObject(manifest.source, `${file}.source`, errors)) {
    const path = `${file}.source`
    checkUnknownKeys(manifest.source, new Set(['commit', 'namingManifest']), path, errors)
    checkString(manifest.source.commit, `${path}.commit`, errors, { pattern: /^[0-9a-f]{40}$/, maxLength: 40 })
    checkString(manifest.source.namingManifest, `${path}.namingManifest`, errors, {
      pattern: sourcePathPattern,
      maxLength: 512,
    })
  }

  if (checkObject(manifest.compatibility, `${file}.compatibility`, errors)) {
    const path = `${file}.compatibility`
    checkUnknownKeys(manifest.compatibility, new Set(['harness']), path, errors)
    if (checkObject(manifest.compatibility.harness, `${path}.harness`, errors)) {
      const harness = manifest.compatibility.harness
      checkUnknownKeys(harness, new Set(['min', 'maxExclusive']), `${path}.harness`, errors)
      const minOk = checkSemver(harness.min, `${path}.harness.min`, errors)
      const maxOk = checkSemver(harness.maxExclusive, `${path}.harness.maxExclusive`, errors, { optional: true })
      if (minOk && maxOk && compareSemver(harness.min, harness.maxExclusive) >= 0) {
        addError(errors, `${path}.harness.maxExclusive`, 'must be greater than min')
      }
    }
  }

  validateClaims(manifest.claims, `${file}.claims`, errors)
  return errors
}

async function walkJsonFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walkJsonFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(path)
  }
  return files.sort()
}

function expectedIdForEntry(entriesRoot, file) {
  const path = posixPath(relative(entriesRoot, file))
  const match = /^([^/]+)\/([^/]+)\.json$/.exec(path)
  return match ? `${match[1]}/${match[2]}` : undefined
}

export async function loadRegistry(registryRoot = defaultRegistryRoot) {
  const root = resolve(registryRoot)
  const entriesRoot = join(root, 'entries')
  const files = await walkJsonFiles(entriesRoot)
  const errors = []
  const records = []
  const identities = new Map()
  for (const file of files) {
    const entryPath = `registry/entries/${posixPath(relative(entriesRoot, file))}`
    const expectedId = expectedIdForEntry(entriesRoot, file)
    if (!expectedId) addError(errors, entryPath, 'entry path must be registry/entries/<github-owner>/<plugin-slug>.json')
    let manifest
    try {
      manifest = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      addError(errors, entryPath, `invalid JSON: ${error.message}`)
      continue
    }
    const manifestErrors = validateManifest(manifest, { file: entryPath, expectedId })
    errors.push(...manifestErrors)
    if (manifestErrors.length) continue
    if (identities.has(manifest.plugin.id)) {
      addError(errors, entryPath, `duplicates plugin identity already declared by ${identities.get(manifest.plugin.id)}`)
      continue
    }
    identities.set(manifest.plugin.id, entryPath)
    records.push({ manifest, manifestPath: entryPath })
  }
  return { records, errors }
}

function publicManifest(record) {
  const { $schema: _schema, ...manifest } = record.manifest
  return { ...manifest, manifestPath: record.manifestPath }
}

export function createIndex(records) {
  const index = {
    $schema: REGISTRY_INDEX_SCHEMA,
    schemaVersion: 2,
    contract: REGISTRY_CONTRACT,
    source: 'registry/entries',
    plugins: records.map(publicManifest).sort((left, right) => compareText(left.plugin.id, right.plugin.id)),
  }
  const errors = validateIndex(index)
  if (errors.length) {
    throw new Error(`cannot create invalid registry index: ${errors.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`)
  }
  return index
}

export function validateIndex(index, { file = 'index' } = {}) {
  const errors = []
  if (!checkObject(index, file, errors)) return errors
  checkUnknownKeys(index, new Set(['$schema', 'schemaVersion', 'contract', 'source', 'plugins']), file, errors)
  if (index.$schema !== undefined && index.$schema !== REGISTRY_INDEX_SCHEMA) {
    addError(errors, `${file}.$schema`, `must be ${REGISTRY_INDEX_SCHEMA}`)
  }
  if (index.schemaVersion !== 2) addError(errors, `${file}.schemaVersion`, 'must be 2')
  if (index.contract !== REGISTRY_CONTRACT) addError(errors, `${file}.contract`, `must be ${REGISTRY_CONTRACT}`)
  if (index.source !== 'registry/entries') addError(errors, `${file}.source`, 'must be registry/entries')
  if (!checkArray(index.plugins, `${file}.plugins`, errors)) return errors

  const identities = new Map()
  const manifestPaths = new Map()
  let previousId
  for (let offset = 0; offset < index.plugins.length; offset += 1) {
    const path = `${file}.plugins[${offset}]`
    const plugin = index.plugins[offset]
    errors.push(...validateManifest(plugin, { file: path, allowManifestPath: true }))
    const id = plugin?.plugin?.id
    const manifestPath = plugin?.manifestPath
    if (typeof id === 'string') {
      if (identities.has(id)) addError(errors, `${path}.plugin.id`, `duplicates ${identities.get(id)}`)
      else identities.set(id, `${file}.plugins[${offset}].plugin.id`)
      if (previousId !== undefined && compareText(id, previousId) < 0) {
        addError(errors, `${path}.plugin.id`, 'plugins must be sorted by plugin.id')
      }
      previousId = id
    }
    if (typeof manifestPath === 'string') {
      if (manifestPaths.has(manifestPath)) addError(errors, `${path}.manifestPath`, `duplicates ${manifestPaths.get(manifestPath)}`)
      else manifestPaths.set(manifestPath, `${file}.plugins[${offset}].manifestPath`)
    }
  }
  return errors
}

function scopesOverlap(left, right) {
  return left === 'unknown' || right === 'unknown' || left === right
}

function conflictSeverity(left, right, base) {
  return left.plugin.status === 'archived' || right.plugin.status === 'archived' ? 'notice' : base
}

function pluginRef(plugin, claim) {
  return {
    id: plugin.plugin.id,
    repository: plugin.plugin.repository,
    status: plugin.plugin.status,
    manifestPath: plugin.manifestPath,
    claim,
  }
}

function addRows(groups, plugin, kind, claims, keyForClaim, displayForClaim = keyForClaim) {
  for (const claim of claims ?? []) {
    const key = keyForClaim(claim)
    const groupKey = `${kind}\u0000${key}`
    const rows = groups.get(groupKey) ?? []
    rows.push({ plugin, claim, display: displayForClaim(claim) })
    groups.set(groupKey, rows)
  }
}

function pairwise(rows, visit, { requireHarnessOverlap = true } = {}) {
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const left = rows[leftIndex]
      const right = rows[rightIndex]
      if (left.plugin.plugin.id === right.plugin.plugin.id) continue
      if (requireHarnessOverlap && !harnessRangesOverlap(left.plugin.compatibility.harness, right.plugin.compatibility.harness)) continue
      visit(left, right)
    }
  }
}

export function detectClaimConflicts(plugins) {
  const groups = new Map()
  for (const plugin of plugins) {
    addRows(groups, plugin, 'packages', [plugin.plugin.package], (claim) => claim)
    addRows(groups, plugin, 'loaderIds', plugin.claims.loaderIds, (claim) => claim.name)
    for (const kind of scopedClaimKinds) addRows(groups, plugin, kind, plugin.claims[kind], (claim) => claim.name)
    addRows(groups, plugin, 'skills', plugin.claims.skills, (claim) => claim.name)
    addRows(groups, plugin, 'events', plugin.claims.events, (claim) => claim.name)
    addRows(
      groups,
      plugin,
      'routes',
      plugin.claims.routes,
      (claim) => `${claim.kind}\u0000${claim.path}`,
      (claim) => `${claim.kind} ${claim.path}`,
    )
  }

  const conflicts = []
  for (const [groupKey, rows] of groups) {
    const kind = groupKey.slice(0, groupKey.indexOf('\u0000'))
    pairwise(rows, (left, right) => {
      let severity
      let reason
      if (kind === 'packages') {
        severity = normalizedRepository(left.plugin.plugin.repository) === normalizedRepository(right.plugin.plugin.repository)
          ? 'notice'
          : 'warning'
        reason = severity === 'notice'
          ? 'one repository publishes multiple registered coordinates from the same package'
          : 'the same package coordinate is attributed to different repositories'
      } else if (kind === 'loaderIds') {
        if (!scopesOverlap(left.claim.composition, right.claim.composition)) return
        const later = left.claim.layer > right.claim.layer ? left : right.claim.layer > left.claim.layer ? right : undefined
        const intentional = later && later.claim.overrideIntent === 'replace'
        severity = intentional ? 'notice' : 'warning'
        reason = intentional
          ? 'a later Loader layer explicitly declares replacement intent'
          : left.claim.layer === right.claim.layer
            ? 'the same Loader ID is declared in an overlapping composition and layer'
            : 'a later Loader layer would replace the same ID without explicit replacement intent'
      } else if (kind === 'skills') {
        if (!scopesOverlap(left.claim.scope, right.claim.scope)) return
        severity = left.claim.rank === right.claim.rank ? 'warning' : 'notice'
        reason = left.claim.rank === right.claim.rank
          ? 'the same Skill name and rank overlap; provider and local order may select the winner'
          : 'the same Skill name overlaps, but declared rank provides deterministic precedence'
      } else if (kind === 'events') {
        if (!scopesOverlap(left.claim.scope, right.claim.scope)) return
        const leftPublishes = left.claim.role === 'publisher' || left.claim.role === 'both'
        const rightPublishes = right.claim.role === 'publisher' || right.claim.role === 'both'
        if (!leftPublishes || !rightPublishes || !left.claim.schema || !right.claim.schema) return
        if (left.claim.schema === right.claim.schema) return
        severity = 'warning'
        reason = 'multiple publishers declare incompatible schemas on the same shared event channel'
      } else {
        if (!scopesOverlap(left.claim.scope, right.claim.scope)) return
        severity = 'warning'
        reason = kind === 'routes'
          ? 'the same route kind and path are registered in overlapping router scopes'
          : `the same ${kind} name is registered in overlapping scopes`
      }
      severity = conflictSeverity(left.plugin, right.plugin, severity)
      conflicts.push({
        severity,
        kind,
        claim: left.display,
        reason,
        plugins: [pluginRef(left.plugin, left.claim), pluginRef(right.plugin, right.claim)]
          .sort((a, b) => compareText(a.id, b.id)),
      })
    }, { requireHarnessOverlap: kind !== 'packages' })
  }
  return conflicts.sort((left, right) =>
    compareText(left.kind, right.kind) ||
    compareText(left.claim, right.claim) ||
    compareText(left.plugins[0].id, right.plugins[0].id),
  )
}

function sourceUrl(manifest) {
  const parts = repositoryParts(manifest.plugin.repository)
  if (!parts) throw new Error('registration repository is not a canonical GitHub URL')
  const path = manifest.source.namingManifest.split('/').map(encodeURIComponent).join('/')
  return `https://raw.githubusercontent.com/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repository)}/${manifest.source.commit}/${path}`
}

async function readBoundedResponse(response, limit) {
  const header = response.headers.get('content-length')
  let length
  if (header !== null) {
    if (!/^\d+$/.test(header)) throw new Error('response has an invalid Content-Length header')
    length = Number(header)
    if (!Number.isSafeInteger(length)) throw new Error('response has an invalid Content-Length header')
  }
  if (length !== undefined && length > limit) throw new Error(`response exceeds ${limit} bytes`)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  const append = (value) => {
    if (!(value instanceof Uint8Array)) throw new Error('response body yielded a non-byte chunk')
    bytes += value.byteLength
    if (bytes > limit) throw new Error(`response exceeds ${limit} bytes`)
    text += decoder.decode(value, { stream: true })
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        append(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
  } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    for await (const value of response.body) {
      append(value)
    }
  } else {
    throw new Error('response body is not stream-readable; bounded fallback refused')
  }
  text += decoder.decode()
  return text
}

async function readBoundedFile(path, limit) {
  const details = await stat(path)
  if (details.size > limit) throw new Error(`response exceeds ${limit} bytes`)
  const bytes = await readFile(path)
  if (bytes.byteLength > limit) throw new Error(`response exceeds ${limit} bytes`)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function comparableSourceClaimsFromRegistration(manifest) {
  const claims = manifest.claims
  return {
    pluginNames: sortedUnique(claims.pluginNames),
    loaderIds: sortedUnique(claims.loaderIds.map((claim) => claim.name)),
    services: sortedUnique(claims.services.map((claim) => claim.name)),
    tools: sortedUnique(claims.tools.map((claim) => claim.name)),
    commands: sortedUnique(claims.commands.map((claim) => claim.name)),
    skills: sortedUnique(claims.skills.map((claim) => claim.name)),
    skillProviders: sortedUnique(claims.skillProviders.map((claim) => claim.name)),
    events: sortedUnique(claims.events.map((claim) => claim.name)),
    settingsNamespaces: sortedUnique(claims.settingsNamespaces.map((claim) => claim.name)),
    routes: claims.routes
      .map((claim) => `${claim.kind}\u0000${claim.path}`)
      .sort(),
  }
}

function validateNamingManifest(manifest, path) {
  const errors = []
  if (!checkObject(manifest, path, errors)) return errors
  checkUnknownKeys(manifest, new Set(['$schema', 'schemaVersion', 'policy', 'plugin', 'names']), path, errors)
  if (Object.hasOwn(manifest, '$schema')) checkString(manifest.$schema, `${path}.$schema`, errors)
  if (manifest.schemaVersion !== 1) addError(errors, `${path}.schemaVersion`, 'must be 1')
  if (manifest.policy !== 'dsh-plugin-naming/v1') addError(errors, `${path}.policy`, 'must be dsh-plugin-naming/v1')

  if (checkObject(manifest.plugin, `${path}.plugin`, errors)) {
    const pluginPath = `${path}.plugin`
    checkUnknownKeys(manifest.plugin, new Set(['namespace', 'name', 'coordinate', 'packageName']), pluginPath, errors)
    const namespaceOk = checkString(manifest.plugin.namespace, `${pluginPath}.namespace`, errors, {
      pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      maxLength: 63,
    })
    const nameOk = checkString(manifest.plugin.name, `${pluginPath}.name`, errors, {
      pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      maxLength: 63,
    })
    checkString(manifest.plugin.coordinate, `${pluginPath}.coordinate`, errors, { pattern: coordinatePattern, maxLength: 127 })
    checkString(manifest.plugin.packageName, `${pluginPath}.packageName`, errors, { pattern: packagePattern, maxLength: 214 })
    if (namespaceOk && nameOk && manifest.plugin.coordinate !== `${manifest.plugin.namespace}/${manifest.plugin.name}`) {
      addError(errors, `${pluginPath}.coordinate`, 'must match namespace and name')
    }
  }

  if (!checkObject(manifest.names, `${path}.names`, errors)) return errors
  checkUnknownKeys(manifest.names, new Set(sourceSurfaceNames), `${path}.names`, errors)
  let arraysOk = true
  for (const surface of sourceSurfaceNames) {
    if (!Array.isArray(manifest.names[surface])) {
      addError(errors, `${path}.names.${surface}`, 'must be an array')
      arraysOk = false
    }
  }
  if (!arraysOk) return errors
  for (const surface of sourceSurfaceNames.filter((name) => name !== 'routes')) {
    validateNamedArray(manifest.names[surface], `${path}.names.${surface}`, errors)
  }
  const routes = manifest.names.routes
  const seenRoutes = new Set()
  for (let offset = 0; offset < routes.length; offset += 1) {
    const routePath = `${path}.names.routes[${offset}]`
    const route = routes[offset]
    if (!checkObject(route, routePath, errors)) continue
    checkUnknownKeys(route, new Set(['kind', 'path']), routePath, errors)
    if (!routeKinds.has(route.kind)) addError(errors, `${routePath}.kind`, 'must be exact, prefix, or upgrade')
    const validPath = checkString(route.path, `${routePath}.path`, errors, {
      pattern: /^\/[^?#\s]*[^/?#\s]$/,
      maxLength: 256,
    })
    if (validPath && routeKinds.has(route.kind)) {
      const key = `${route.kind}\u0000${route.path}`
      if (seenRoutes.has(key)) addError(errors, routePath, 'duplicates the same route kind and path')
      seenRoutes.add(key)
    }
  }
  return errors
}

function comparableSourceClaimsFromNaming(manifest) {
  return {
    plugin: {
      coordinate: manifest.plugin.coordinate,
      packageName: manifest.plugin.packageName,
    },
    claims: {
      ...Object.fromEntries(sourceSurfaceNames.filter((surface) => surface !== 'routes').map((surface) => [
        surface,
        sortedUnique(manifest.names[surface]),
      ])),
      routes: manifest.names.routes
        .map((claim) => isObject(claim) ? `${claim.kind}\u0000${claim.path}` : JSON.stringify(claim))
        .sort(),
    },
  }
}

export async function verifyManifestSource(manifest, { fetchImpl = fetch, timeoutMs = 10_000, file = 'manifest' } = {}) {
  const errors = []
  let response
  try {
    response = await fetchImpl(sourceUrl(manifest), {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-registry-source-verifier' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    addError(errors, `${file}.source`, `cannot fetch pinned naming manifest: ${error.message}`)
    return errors
  }
  if (!response.ok) {
    addError(errors, `${file}.source`, `pinned naming manifest returned HTTP ${response.status}`)
    return errors
  }
  let naming
  try {
    naming = JSON.parse(await readBoundedResponse(response, MAX_SOURCE_MANIFEST_BYTES))
  } catch (error) {
    addError(errors, `${file}.source`, `cannot parse pinned naming manifest: ${error.message}`)
    return errors
  }
  const namingPath = `${file}.source.namingManifest`
  errors.push(...validateNamingManifest(naming, namingPath))
  if (errors.length) return errors
  const comparable = comparableSourceClaimsFromNaming(naming)
  if (comparable.plugin.coordinate !== manifest.plugin.id) {
    addError(errors, `${file}.source.namingManifest.plugin.coordinate`, 'does not match plugin.id')
  }
  if (comparable.plugin.packageName !== manifest.plugin.package) {
    addError(errors, `${file}.source.namingManifest.plugin.packageName`, 'does not match plugin.package')
  }
  const registeredClaims = comparableSourceClaimsFromRegistration(manifest)
  for (const surface of sourceSurfaceNames) {
    if (JSON.stringify(comparable.claims[surface]) !== JSON.stringify(registeredClaims[surface])) {
      addError(errors, `${file}.claims.${surface}`, 'does not match the pinned naming manifest')
    }
  }
  return errors
}

export async function validateRegistry({ registryRoot = defaultRegistryRoot, checkIndex = false, verifySources = false } = {}) {
  const root = resolve(registryRoot)
  const { records, errors } = await loadRegistry(root)
  if (verifySources) {
    for (const record of records) errors.push(...(await verifyManifestSource(record.manifest, { file: record.manifestPath })))
  }
  const index = createIndex(records)
  if (checkIndex) {
    const indexPath = join(root, 'index.json')
    try {
      const actual = await readFile(indexPath, 'utf8')
      if (normalizeNewlines(actual) !== stableStringify(index)) {
        addError(errors, posixPath(relative(repoRoot, indexPath)), 'generated index is stale; run build-index')
      }
    } catch (error) {
      addError(errors, posixPath(relative(repoRoot, indexPath)), `cannot read generated index: ${error.message}`)
    }
  }
  return { errors, conflicts: detectClaimConflicts(index.plugins), index }
}

export async function readIndexSource({ indexPath, registryUrl, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let text
  if (indexPath) {
    text = await readBoundedFile(resolve(indexPath), MAX_INDEX_BYTES)
  } else {
    if (!registryUrl) throw new Error('provide --index or --registry-url')
    const response = await fetchImpl(registryUrl, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-conflict-check' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`registry request failed: HTTP ${response.status} ${response.statusText}`)
    text = await readBoundedResponse(response, MAX_INDEX_BYTES)
  }
  const index = JSON.parse(text)
  const errors = validateIndex(index)
  if (errors.length) throw new Error(errors.map((entry) => `${entry.path}: ${entry.message}`).join('; '))
  return index
}

export async function checkManifestAgainstIndex(manifest, index, { file = 'manifest' } = {}) {
  const indexErrors = validateIndex(index)
  if (indexErrors.length) throw new Error(indexErrors.map((entry) => `${entry.path}: ${entry.message}`).join('; '))
  const errors = validateManifest(manifest, { file })
  if (errors.length) return { candidate: manifest?.plugin?.id, errors, conflicts: [] }
  const candidateId = manifest.plugin.id
  const existing = index.plugins.find((plugin) => plugin.plugin.id === candidateId)
  const identityConflict = existing && normalizedRepository(existing.plugin.repository) !== normalizedRepository(manifest.plugin.repository)
    ? {
        severity: 'error',
        kind: 'pluginIds',
        claim: candidateId,
        reason: 'the plugin identity is already registered by a different repository',
        plugins: [pluginRef(existing, existing.plugin.id), pluginRef({ ...manifest, manifestPath: file }, candidateId)],
      }
    : undefined
  const candidate = { ...manifest, manifestPath: file }
  const base = existing && !identityConflict ? index.plugins.filter((plugin) => plugin.plugin.id !== candidateId) : index.plugins
  const conflicts = detectClaimConflicts([...base, candidate]).filter((conflict) =>
    conflict.plugins.some((plugin) => plugin.id === candidateId && plugin.manifestPath === file),
  )
  if (identityConflict) conflicts.unshift(identityConflict)
  return { candidate: candidateId, errors: [], conflicts }
}

function normalizedSearchKind(kind) {
  const aliases = {
    id: 'pluginIds',
    plugin: 'pluginIds',
    package: 'packages',
    pluginName: 'pluginNames',
    loader: 'loaderIds',
    service: 'services',
    tool: 'tools',
    command: 'commands',
    skill: 'skills',
    skillProvider: 'skillProviders',
    event: 'events',
    settings: 'settingsNamespaces',
    route: 'routes',
  }
  return aliases[kind] ?? kind
}

export function searchIndex(index, kindInput, name) {
  const kind = normalizedSearchKind(kindInput)
  if (!searchKinds.includes(kind)) throw new Error(`unknown kind ${JSON.stringify(kindInput)}; use ${searchKinds.join(', ')}`)
  const matches = []
  for (const plugin of index.plugins) {
    let claims = []
    if (kind === 'pluginIds' && plugin.plugin.id === name) claims = [plugin.plugin.id]
    else if (kind === 'packages' && plugin.plugin.package === name) claims = [plugin.plugin.package]
    else if (kind === 'pluginNames') claims = plugin.claims.pluginNames.filter((claim) => claim === name)
    else if (kind === 'routes') claims = plugin.claims.routes.filter((claim) => `${claim.kind} ${claim.path}` === name)
    else if (kind !== 'pluginIds' && kind !== 'packages') claims = plugin.claims[kind].filter((claim) => claim.name === name)
    if (claims.length) {
      matches.push({
        id: plugin.plugin.id,
        repository: plugin.plugin.repository,
        status: plugin.plugin.status,
        manifestPath: plugin.manifestPath,
        claims,
      })
    }
  }
  return { kind, name, count: matches.length, matches }
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function renderConflicts(conflicts) {
  if (!conflicts.length) return ['- No contextual conflicts found.']
  const lines = ['| Severity | Kind | Claim | Registered plugins | Reason |', '|---|---|---|---|---|']
  for (const conflict of conflicts) {
    lines.push(`| ${conflict.severity} | ${conflict.kind} | \`${escapeCell(conflict.claim)}\` | ${escapeCell(conflict.plugins.map((plugin) => plugin.id).join(', '))} | ${escapeCell(conflict.reason)} |`)
  }
  return lines
}

function renderErrors(errors) {
  return errors.length ? errors.map((entry) => `- \`${entry.path}\`: ${entry.message}`) : ['- None.']
}

export function renderCheckMarkdown(report) {
  return `${[
    '# DSH plugin conflict check',
    '',
    `- Candidate: \`${report.candidate ?? 'unknown'}\``,
    `- Result: ${report.errors.length ? 'invalid manifest' : report.conflicts.some((conflict) => conflict.severity === 'error') ? 'blocking identity conflict' : report.conflicts.some((conflict) => conflict.severity === 'warning') ? 'contextual conflicts found' : report.conflicts.length ? 'informational overlaps found' : 'no contextual conflicts found'}`,
    '- Warnings are advisory unless strict mode is enabled; notices never block.',
    '',
    '## Manifest errors',
    '',
    ...renderErrors(report.errors),
    '',
    '## Contextual conflicts',
    '',
    ...renderConflicts(report.conflicts),
  ].join('\n')}\n`
}

export function checkResultExitCode(report, { strict = false } = {}) {
  if (report.errors.length || report.conflicts.some((conflict) => conflict.severity === 'error')) return 1
  if (strict && report.conflicts.some((conflict) => conflict.severity === 'warning')) return 2
  return 0
}

function renderRegistryMarkdown(report) {
  return `${[
    '# DSH plugin registry validation',
    '',
    `- Contract: \`${REGISTRY_CONTRACT}\``,
    `- Registered plugins: ${report.index.plugins.length}`,
    `- Manifest or source errors: ${report.errors.length}`,
    `- Contextual warnings: ${report.conflicts.filter((conflict) => conflict.severity === 'warning').length}`,
    `- Informational notices: ${report.conflicts.filter((conflict) => conflict.severity === 'notice').length}`,
    '',
    '## Errors',
    '',
    ...renderErrors(report.errors),
    '',
    '## Contextual overlaps',
    '',
    ...renderConflicts(report.conflicts),
  ].join('\n')}\n`
}

function renderSearchMarkdown(result) {
  const lines = [
    '# DSH plugin registry search',
    '',
    `- Kind: \`${result.kind}\``,
    `- Name: \`${result.name}\``,
    `- Matches: ${result.count}`,
    '',
  ]
  if (!result.matches.length) lines.push('- No reviewed registration uses this value.')
  else {
    lines.push('| Plugin | Status | Repository |', '|---|---|---|')
    for (const match of result.matches) lines.push(`| ${match.id} | ${match.status} | ${match.repository} |`)
  }
  return `${lines.join('\n')}\n`
}

function annotationText(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

async function emit(value, format, kind) {
  const markdown = kind === 'check'
    ? renderCheckMarkdown(value)
    : kind === 'search'
      ? renderSearchMarkdown(value)
      : renderRegistryMarkdown(value)
  if (format === 'json') process.stdout.write(stableStringify(value))
  else if (format === 'markdown') process.stdout.write(markdown)
  else if (format === 'github') {
    for (const error of value.errors ?? []) {
      process.stdout.write(`::error file=${annotationText(error.path)}::${annotationText(error.message)}\n`)
    }
    for (const conflict of value.conflicts ?? []) {
      const command = conflict.severity === 'notice' ? 'notice' : conflict.severity
      process.stdout.write(`::${command}::${annotationText(`${conflict.kind} ${conflict.claim}: ${conflict.reason}; plugins: ${conflict.plugins.map((plugin) => plugin.id).join(', ')}`)}\n`)
    }
    process.stdout.write(markdown)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
  } else throw new Error('--format must be json, markdown, or github')
}

function parseOptions(args, booleanFlags = new Set()) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`)
    if (booleanFlags.has(flag)) {
      options[flag.slice(2)] = true
      continue
    }
    const value = args[++index]
    if (value === undefined) throw new Error(`missing value for ${flag}`)
    options[flag.slice(2)] = value
  }
  return options
}

function usage() {
  return `Usage:
  node scripts/plugin-registry.mjs validate [--registry registry] [--check-index] [--verify-sources] [--strict-claims] [--format markdown|json|github]
  node scripts/plugin-registry.mjs verify-source --manifest <entry.json> [--format markdown|json|github]
  node scripts/plugin-registry.mjs build-index [--registry registry] [--output registry/index.json] [--check]
  node scripts/plugin-registry.mjs search --kind service --name <value> [--index registry/index.json | --registry-url <url>] [--format markdown|json]
  node scripts/plugin-registry.mjs check --manifest <entry.json> [--index registry/index.json | --registry-url <url>] [--strict] [--format markdown|json|github]

Warnings are advisory by default. --strict exits with code 2 for contextual warnings; notices never block.
`
}

export async function runCli(argv) {
  const [command, ...args] = argv
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(usage())
    return 0
  }
  if (command === 'validate') {
    const options = parseOptions(args, new Set(['--check-index', '--verify-sources', '--strict-claims']))
    const report = await validateRegistry({
      registryRoot: options.registry ?? defaultRegistryRoot,
      checkIndex: options['check-index'] ?? false,
      verifySources: options['verify-sources'] ?? false,
    })
    await emit(report, options.format ?? 'markdown', 'registry')
    if (report.errors.length) return 1
    if (options['strict-claims'] && report.conflicts.some((conflict) => conflict.severity === 'warning')) return 2
    return 0
  }
  if (command === 'verify-source') {
    const options = parseOptions(args)
    if (!options.manifest) throw new Error('verify-source requires --manifest')
    const manifestPath = resolve(options.manifest)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    const validationErrors = validateManifest(manifest, { file: posixPath(relative(process.cwd(), manifestPath)) })
    const errors = validationErrors.length
      ? validationErrors
      : await verifyManifestSource(manifest, { file: posixPath(relative(process.cwd(), manifestPath)) })
    const report = { errors, conflicts: [], index: createIndex([]) }
    await emit(report, options.format ?? 'markdown', 'registry')
    return errors.length ? 1 : 0
  }
  if (command === 'build-index') {
    const options = parseOptions(args, new Set(['--check']))
    const registryRoot = resolve(options.registry ?? defaultRegistryRoot)
    const report = await validateRegistry({ registryRoot })
    if (report.errors.length) {
      await emit(report, 'markdown', 'registry')
      return 1
    }
    const output = resolve(options.output ?? join(registryRoot, 'index.json'))
    const expected = stableStringify(report.index)
    if (options.check) {
      let actual
      try {
        actual = await readFile(output, 'utf8')
      } catch {
        actual = undefined
      }
      if (actual === undefined || normalizeNewlines(actual) !== expected) {
        process.stderr.write(`plugin-registry: stale index at ${output}; run build-index without --check\n`)
        return 1
      }
      process.stdout.write(`Plugin registry index is current: ${report.index.plugins.length} plugins\n`)
      return 0
    }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, expected)
    process.stdout.write(`Wrote ${output}: ${report.index.plugins.length} plugins\n`)
    return 0
  }
  if (command === 'search') {
    const options = parseOptions(args)
    if (!options.kind || !options.name) throw new Error('search requires --kind and --name')
    const index = await readIndexSource({ indexPath: options.index, registryUrl: options['registry-url'] })
    const result = searchIndex(index, options.kind, options.name)
    await emit(result, options.format ?? 'markdown', 'search')
    return 0
  }
  if (command === 'check') {
    const options = parseOptions(args, new Set(['--strict']))
    if (!options.manifest) throw new Error('check requires --manifest')
    const manifestPath = resolve(options.manifest)
    let manifest
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      const report = {
        candidate: undefined,
        errors: [{ path: posixPath(relative(process.cwd(), manifestPath)), message: `cannot read manifest: ${error.message}` }],
        conflicts: [],
      }
      await emit(report, options.format ?? 'markdown', 'check')
      return 1
    }
    const index = await readIndexSource({ indexPath: options.index, registryUrl: options['registry-url'] })
    const report = await checkManifestAgainstIndex(manifest, index, { file: posixPath(relative(process.cwd(), manifestPath)) })
    await emit(report, options.format ?? 'markdown', 'check')
    return checkResultExitCode(report, { strict: options.strict })
  }
  throw new Error(`unknown command: ${command}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = await runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`plugin-registry: ${error.message}\n${usage()}`)
    process.exitCode = 1
  }
}
