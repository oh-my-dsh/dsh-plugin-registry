#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_DISCOVERY_QUERIES = [
  'topic:dsh topic:dsh-plugin',
  'topic:deepseek-harness topic:dsh-plugin',
]
export const DEFAULT_CODE_QUERIES = ['"dsh.bundle" filename:package.json']

const API_ROOT = 'https://api.github.com'
const MAX_API_RESPONSE_BYTES = 10 * 1024 * 1024

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function githubHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-plugin-registry-discovery',
    'x-github-api-version': '2022-11-28',
  }
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function readBoundedJson(response) {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > MAX_API_RESPONSE_BYTES) throw new Error('GitHub response is too large')
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_API_RESPONSE_BYTES) throw new Error('GitHub response is too large')
  return JSON.parse(text)
}

async function requestJson(path, { fetchImpl, token, optional = false }) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(15_000),
  })
  if (optional && response.status === 404) return undefined
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    const suffix = remaining === null ? '' : `; rate limit remaining: ${remaining}`
    throw new Error(`GitHub API ${path} returned HTTP ${response.status}${suffix}`)
  }
  return readBoundedJson(response)
}

function repositoryKey(repository) {
  return repository.full_name.toLowerCase()
}

function mergeRepository(target, repository, query) {
  const key = repositoryKey(repository)
  const existing = target.get(key)
  if (existing) {
    existing.matchedQueries.add(query)
    return existing
  }
  const value = { ...repository, matchedQueries: new Set([query]), candidatePaths: new Set() }
  target.set(key, value)
  return value
}

function topicEvidenceTier(repository) {
  if (repository.candidatePaths.size) return 2
  const topics = new Set(repository.topics ?? [])
  const pluginTopic = topics.has('dsh-plugin')
  const harnessTopic = topics.has('dsh') || topics.has('deepseek-harness') || topics.has('dsh-plugin-desktop')
  return pluginTopic && harnessTopic ? 1 : 0
}

export async function discoverRepositories({
  fetchImpl = fetch,
  token,
  queries = DEFAULT_DISCOVERY_QUERIES,
  codeQueries = DEFAULT_CODE_QUERIES,
  maxResults = 200,
} = {}) {
  const repositories = new Map()
  const queryEvidence = []
  const pages = Math.max(1, Math.ceil(maxResults / 100))
  for (const query of queries) {
    let totalCount = 0
    let incompleteResults = false
    let received = 0
    for (let page = 1; page <= pages; page += 1) {
      const search = new URLSearchParams({
        q: query,
        sort: 'stars',
        order: 'desc',
        per_page: '100',
        page: String(page),
      })
      const result = await requestJson(`/search/repositories?${search}`, { fetchImpl, token })
      if (!Array.isArray(result.items)) throw new Error(`GitHub search returned no items for ${JSON.stringify(query)}`)
      totalCount = Number(result.total_count) || 0
      incompleteResults ||= result.incomplete_results === true
      received += result.items.length
      for (const repository of result.items) mergeRepository(repositories, repository, query)
      if (result.items.length < 100) break
    }
    queryEvidence.push({ source: 'repository-search', query, totalCount, received, incompleteResults })
  }
  for (const query of codeQueries) {
    let totalCount = 0
    let incompleteResults = false
    let received = 0
    for (let page = 1; page <= pages; page += 1) {
      const search = new URLSearchParams({ q: query, per_page: '100', page: String(page) })
      const result = await requestJson(`/search/code?${search}`, { fetchImpl, token })
      if (!Array.isArray(result.items)) throw new Error(`GitHub code search returned no items for ${JSON.stringify(query)}`)
      totalCount = Number(result.total_count) || 0
      incompleteResults ||= result.incomplete_results === true
      received += result.items.length
      for (const item of result.items) {
        const fullName = item.repository?.full_name
        if (typeof fullName !== 'string' || typeof item.path !== 'string') continue
        let repository = repositories.get(fullName.toLowerCase())
        if (!repository && Number.isFinite(item.repository.stargazers_count)) {
          repository = mergeRepository(repositories, item.repository, `code:${query}`)
        } else if (!repository || !Number.isFinite(repository.stargazers_count)) {
          const hydrated = await requestJson(`/repos/${fullName}`, { fetchImpl, token })
          repository = mergeRepository(repositories, hydrated, `code:${query}`)
        } else {
          repository.matchedQueries.add(`code:${query}`)
        }
        repository.candidatePaths.add(item.path)
      }
      if (result.items.length < 100) break
    }
    queryEvidence.push({
      source: 'code-search',
      query,
      totalCount,
      received,
      incompleteResults,
    })
  }
  const ranked = [...repositories.values()]
    .filter((repository) => topicEvidenceTier(repository) > 0)
    .sort((left, right) =>
      topicEvidenceTier(right) - topicEvidenceTier(left) ||
      right.stargazers_count - left.stargazers_count ||
      left.full_name.localeCompare(right.full_name),
    )
    .slice(0, maxResults)
  return { repositories: ranked, queryEvidence }
}

export function selectTopPercent(repositories, coveragePercent) {
  if (!Number.isFinite(coveragePercent) || coveragePercent <= 0 || coveragePercent > 100) {
    throw new Error('coveragePercent must be greater than 0 and at most 100')
  }
  if (!repositories.length) return []
  const count = Math.max(1, Math.ceil(repositories.length * coveragePercent / 100))
  return repositories.slice(0, count)
}

function decodeContent(payload) {
  if (!isObject(payload) || payload.type !== 'file' || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
    throw new Error('GitHub contents response is not a base64 file')
  }
  return Buffer.from(payload.content.replaceAll('\n', ''), 'base64').toString('utf8')
}

async function optionalJsonFile(fullName, path, commit, options) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  const payload = await requestJson(`/repos/${fullName}/contents/${encodedPath}?ref=${commit}`, {
    ...options,
    optional: true,
  })
  if (!payload) return undefined
  try {
    return { value: JSON.parse(decodeContent(payload)), blobSha: payload.sha }
  } catch (error) {
    return { error: `invalid ${path}: ${error.message}`, blobSha: payload.sha }
  }
}

function namingEvidence(file) {
  const manifest = file?.value
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || manifest.policy !== 'dsh-plugin-naming/v1') return undefined
  if (!isObject(manifest.plugin) || !isObject(manifest.names)) return undefined
  const declaredNames = {}
  for (const [surface, values] of Object.entries(manifest.names)) {
    if (!Array.isArray(values)) continue
    declaredNames[surface] = surface === 'routes'
      ? values.filter(isObject).map(({ kind, path }) => ({ kind, path }))
      : values.filter((value) => typeof value === 'string')
  }
  return {
    blobSha: file.blobSha,
    coordinate: manifest.plugin.coordinate,
    packageName: manifest.plugin.packageName,
    declaredNames,
  }
}

function packageEvidence(file) {
  const manifest = file?.value
  if (!isObject(manifest)) return undefined
  return {
    blobSha: file.blobSha,
    name: typeof manifest.name === 'string' ? manifest.name : null,
    hasDshBundle: isObject(manifest.dsh) && Object.hasOwn(manifest.dsh, 'bundle'),
  }
}

export async function inspectRepository(repository, { fetchImpl = fetch, token } = {}) {
  const fullName = repository.full_name
  const branch = encodeURIComponent(repository.default_branch)
  const commitResponse = await requestJson(`/repos/${fullName}/commits/${branch}`, { fetchImpl, token })
  if (typeof commitResponse.sha !== 'string' || !/^[0-9a-f]{40}$/.test(commitResponse.sha)) {
    throw new Error(`GitHub returned no immutable commit for ${fullName}`)
  }
  const commit = commitResponse.sha
  const candidatePaths = new Set(['package.json', ...(repository.candidatePaths ?? [])])
  const pluginPackages = await mapLimit([...candidatePaths].sort(), 5, async (path) => {
    const separator = path.lastIndexOf('/')
    const directory = separator === -1 ? '' : path.slice(0, separator + 1)
    const namingPath = `${directory}dsh-plugin.naming.json`
    const [packageFile, namingFile] = await Promise.all([
      optionalJsonFile(fullName, path, commit, { fetchImpl, token }),
      optionalJsonFile(fullName, namingPath, commit, { fetchImpl, token }),
    ])
    return {
      path,
      package: packageEvidence(packageFile) ?? null,
      namingManifest: namingEvidence(namingFile) ?? null,
      errors: [packageFile?.error, namingFile?.error].filter(Boolean),
    }
  })
  const root = pluginPackages.find((entry) => entry.path === 'package.json')
  const classification = pluginPackages.some((entry) => entry.namingManifest)
    ? 'declared'
    : pluginPackages.some((entry) => entry.package?.hasDshBundle)
      ? 'bundle'
      : 'topical'
  return {
    repository: repository.html_url,
    fullName,
    description: repository.description ?? null,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    archived: repository.archived === true,
    pushedAt: repository.pushed_at,
    defaultBranch: repository.default_branch,
    topics: [...(repository.topics ?? [])].sort(),
    matchedQueries: [...repository.matchedQueries].sort(),
    classification,
    evidence: {
      commit,
      rootPackage: root?.package ?? null,
      namingManifest: root?.namingManifest ?? null,
      pluginPackages,
    },
  }
}

async function mapLimit(values, limit, mapper) {
  const results = new Array(values.length)
  let next = 0
  async function worker() {
    while (next < values.length) {
      const index = next
      next += 1
      results[index] = await mapper(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()))
  return results
}

export async function buildDiscoveryCatalog({
  fetchImpl = fetch,
  token,
  queries = DEFAULT_DISCOVERY_QUERIES,
  codeQueries = DEFAULT_CODE_QUERIES,
  coveragePercent = 10,
  maxResults = 200,
  now = () => new Date(),
} = {}) {
  const discovery = await discoverRepositories({ fetchImpl, token, queries, codeQueries, maxResults })
  const selected = selectTopPercent(discovery.repositories, coveragePercent)
  const candidates = await mapLimit(selected, 5, (repository) => inspectRepository(repository, { fetchImpl, token }))
  const classificationRank = { declared: 2, bundle: 1, topical: 0 }
  candidates.sort((left, right) =>
    classificationRank[right.classification] - classificationRank[left.classification] ||
    right.stars - left.stars ||
    left.fullName.localeCompare(right.fullName),
  )
  return {
    schemaVersion: 1,
    kind: 'dsh-plugin-discovery-candidates',
    generatedAt: now().toISOString(),
    formalRegistryEffect: 'none',
    notice: 'Automated candidates are unreviewed discovery evidence. They do not reserve IDs or participate in conflict blocking.',
    selection: {
      coveragePercent,
      maxResults,
      discoveredRepositories: discovery.repositories.length,
      selectedRepositories: selected.length,
      queryEvidence: discovery.queryEvidence,
    },
    candidates,
  }
}

function parseArgs(args) {
  const options = {
    coveragePercent: 10,
    maxResults: 200,
    output: 'discovery/candidates.json',
    queries: [],
    codeQueries: [],
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--help' || argument === '-h') return { help: true }
    if (!['--coverage', '--max-results', '--output', '--query', '--code-query'].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`)
    }
    const value = args[++index]
    if (!value) throw new Error(`${argument} requires a value`)
    if (argument === '--coverage') options.coveragePercent = Number(value)
    else if (argument === '--max-results') options.maxResults = Number(value)
    else if (argument === '--output') options.output = value
    else if (argument === '--query') options.queries.push(value)
    else options.codeQueries.push(value)
  }
  if (!Number.isInteger(options.maxResults) || options.maxResults < 1 || options.maxResults > 1000) {
    throw new Error('--max-results must be an integer from 1 to 1000')
  }
  if (!Number.isFinite(options.coveragePercent) || options.coveragePercent <= 0 || options.coveragePercent > 100) {
    throw new Error('--coverage must be greater than 0 and at most 100')
  }
  if (!options.queries.length) options.queries = DEFAULT_DISCOVERY_QUERIES
  if (!options.codeQueries.length) options.codeQueries = DEFAULT_CODE_QUERIES
  return options
}

function usage() {
  return `Usage: node scripts/discover-plugins.mjs [--coverage 10|20|100] [--max-results 200] [--query <repository-query>] [--code-query <code-query>] [--output discovery/candidates.json]

Searches public GitHub metadata and root manifests only. It never clones or executes candidate code.
The selected percentage is calculated over the discovered, capped sample, not the entire GitHub universe.
`
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(usage())
    } else {
      const catalog = await buildDiscoveryCatalog({
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
        queries: options.queries,
        codeQueries: options.codeQueries,
        coveragePercent: options.coveragePercent,
        maxResults: options.maxResults,
      })
      const output = resolve(options.output)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, stableStringify(catalog))
      process.stdout.write(`Wrote ${output}: ${catalog.candidates.length} unreviewed candidates from ${catalog.selection.discoveredRepositories} discovered repositories\n`)
    }
  } catch (error) {
    process.stderr.write(`plugin-discovery: ${error.message}\n${usage()}`)
    process.exitCode = 1
  }
}
