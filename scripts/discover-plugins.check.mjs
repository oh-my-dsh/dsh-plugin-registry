import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import {
  DEFAULT_DISCOVERY_QUERIES,
  buildDiscoveryCatalog,
  discoverRepositories,
  inspectRepository,
  selectTopPercent,
} from './discover-plugins.mjs'

function apiResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999' },
  })
}

function content(value, sha) {
  return {
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(value)).toString('base64'),
    sha,
  }
}

function repository(index) {
  return {
    full_name: `owner/plugin-${index}`,
    html_url: `https://github.com/owner/plugin-${index}`,
    description: `Candidate ${index}`,
    stargazers_count: 101 - index,
    forks_count: index,
    archived: false,
    pushed_at: '2026-08-31T00:00:00Z',
    default_branch: 'main',
    topics: ['dsh', 'dsh-plugin'],
  }
}

function namingManifest() {
  return {
    schemaVersion: 1,
    policy: 'dsh-plugin-naming/v1',
    plugin: {
      namespace: 'owner',
      name: 'plugin-1',
      coordinate: 'owner/plugin-1',
      packageName: '@owner/dsh-plugin-1',
    },
    names: {
      pluginNames: ['plugin-1'],
      loaderIds: ['owner-plugin-1'],
      services: [],
      tools: ['owner_plugin_1'],
      commands: [],
      skills: [],
      skillProviders: [],
      events: [],
      settingsNamespaces: [],
      routes: [],
    },
  }
}

function fakeFetch(input) {
  const url = new URL(input)
  if (url.pathname === '/search/repositories') {
    return Promise.resolve(apiResponse({
      total_count: 10,
      incomplete_results: false,
      items: Array.from({ length: 10 }, (_, index) => repository(index + 1)),
    }))
  }
  if (url.pathname === '/search/code') {
    return Promise.resolve(apiResponse({ total_count: 0, incomplete_results: false, items: [] }))
  }
  const commit = /^\/repos\/(owner\/plugin-\d+)\/commits\/.+$/.exec(url.pathname)
  if (commit) return Promise.resolve(apiResponse({ sha: `${commit[1].endsWith('-1') ? '1' : '2'}`.repeat(40) }))
  const packageFile = /^\/repos\/(owner\/plugin-\d+)\/contents\/package\.json$/.exec(url.pathname)
  if (packageFile) {
    if (packageFile[1].endsWith('-1')) {
      return Promise.resolve(apiResponse(content({ name: '@owner/dsh-plugin-1', dsh: { bundle: [] } }, 'a'.repeat(40))))
    }
    return Promise.resolve(apiResponse({ message: 'Not Found' }, 404))
  }
  const namingFile = /^\/repos\/(owner\/plugin-\d+)\/contents\/dsh-plugin\.naming\.json$/.exec(url.pathname)
  if (namingFile) {
    if (namingFile[1].endsWith('-1')) {
      return Promise.resolve(apiResponse(content(namingManifest(), 'b'.repeat(40))))
    }
    return Promise.resolve(apiResponse({ message: 'Not Found' }, 404))
  }
  throw new Error(`Unexpected GitHub API request: ${url}`)
}

export async function runDiscoveryChecks() {
  assert.deepEqual(DEFAULT_DISCOVERY_QUERIES, [
    'topic:dsh topic:dsh-plugin',
    'topic:deepseek-harness topic:dsh-plugin',
  ])
  const repositories = Array.from({ length: 10 }, (_, index) => repository(index + 1))
  assert.equal(selectTopPercent(repositories, 10).length, 1)
  assert.equal(selectTopPercent(repositories, 20).length, 2)
  assert.equal(selectTopPercent(repositories, 100).length, 10)
  assert.throws(() => selectTopPercent(repositories, 0), /coveragePercent/)

  const discovered = await discoverRepositories({
    fetchImpl: fakeFetch,
    queries: ['topic:dsh-plugin'],
    codeQueries: [],
    maxResults: 10,
  })
  assert.equal(discovered.repositories.length, 10)
  assert.equal(discovered.repositories[0].full_name, 'owner/plugin-1')

  const requestedCodePages = []
  const pagedCode = await discoverRepositories({
    fetchImpl: async (input) => {
      const url = new URL(input)
      if (url.pathname !== '/search/code') throw new Error(`Unexpected paged request: ${url}`)
      const page = Number(url.searchParams.get('page'))
      requestedCodePages.push(page)
      const count = page === 1 ? 100 : 1
      const offset = page === 1 ? 0 : 100
      return apiResponse({
        total_count: 101,
        incomplete_results: false,
        items: Array.from({ length: count }, (_, index) => ({
          path: 'package.json',
          repository: repository(offset + index + 1),
        })),
      })
    },
    queries: [],
    codeQueries: ['"dsh.bundle" filename:package.json'],
    maxResults: 200,
  })
  assert.deepEqual(requestedCodePages, [1, 2])
  assert.equal(pagedCode.repositories.length, 101)
  assert.equal(pagedCode.queryEvidence[0].received, 101)

  const inspected = await inspectRepository(discovered.repositories[0], { fetchImpl: fakeFetch })
  assert.equal(inspected.classification, 'declared')
  assert.equal(inspected.evidence.rootPackage.hasDshBundle, true)
  assert.equal(inspected.evidence.namingManifest.coordinate, 'owner/plugin-1')
  assert.equal(inspected.evidence.namingManifest.declaredNames.tools[0], 'owner_plugin_1')

  const catalog = await buildDiscoveryCatalog({
    fetchImpl: fakeFetch,
    queries: ['topic:dsh-plugin'],
    codeQueries: [],
    maxResults: 10,
    coveragePercent: 20,
    now: () => new Date('2026-08-31T00:00:00Z'),
  })
  assert.equal(catalog.formalRegistryEffect, 'none')
  assert.equal(catalog.selection.discoveredRepositories, 10)
  assert.equal(catalog.selection.selectedRepositories, 2)
  assert.equal(catalog.candidates.length, 2)
  assert.deepEqual(catalog.candidates.map((candidate) => candidate.classification), ['declared', 'topical'])
  assert.equal(catalog.generatedAt, '2026-08-31T00:00:00.000Z')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  await runDiscoveryChecks()
  console.log('Discovery checks OK: ranked sampling, capped percentile, immutable evidence, DSH bundle and naming classification, no formal reservations')
}
