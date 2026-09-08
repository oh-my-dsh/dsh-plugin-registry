import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  REGISTRY_CONTRACT,
  REGISTRY_INDEX_SCHEMA,
  checkManifestAgainstIndex,
  checkResultExitCode,
  compareSemver,
  createIndex,
  detectClaimConflicts,
  harnessRangesOverlap,
  loadRegistry,
  parseSemver,
  readIndexSource,
  searchIndex,
  validateIndex,
  validateManifest,
  validateRegistry,
  verifyManifestSource,
} from './plugin-registry.mjs'

function manifest(owner, slug, overrides = {}) {
  const base = {
    schemaVersion: 2,
    plugin: {
      id: `${owner}/${slug}`,
      repository: `https://github.com/${owner}/dsh-${slug}`,
      package: `@${owner}/dsh-${slug}`,
      status: 'active',
    },
    source: {
      commit: '0123456789abcdef0123456789abcdef01234567',
      namingManifest: 'dsh-plugin.naming.json',
    },
    compatibility: {
      harness: { min: '0.1.2-alpha.2', maxExclusive: '0.2.0' },
    },
    claims: {
      pluginNames: [slug],
      loaderIds: [{ name: 'shared-loader', composition: 'root', layer: 0, overrideIntent: 'none' }],
      services: [{ name: 'sharedService', scope: 'root' }],
      tools: [{ name: 'shared_tool', scope: 'root' }],
      commands: [{ name: 'shared-command', scope: 'root' }],
      skills: [{ name: 'shared-skill', scope: 'root', provider: `${owner}-provider`, rank: 0 }],
      skillProviders: [{ name: 'shared-provider', scope: 'root' }],
      events: [{ name: 'shared/ready', scope: 'root', role: 'publisher', schema: `urn:${owner}:ready:v1` }],
      settingsNamespaces: [{ name: 'shared-settings', scope: 'root' }],
      routes: [{ kind: 'exact', path: '/api/shared', scope: 'root' }],
    },
  }
  return {
    ...base,
    ...overrides,
    plugin: { ...base.plugin, ...(overrides.plugin ?? {}) },
    source: { ...base.source, ...(overrides.source ?? {}) },
    compatibility: {
      ...base.compatibility,
      ...(overrides.compatibility ?? {}),
      harness: { ...base.compatibility.harness, ...(overrides.compatibility?.harness ?? {}) },
    },
    claims: { ...base.claims, ...(overrides.claims ?? {}) },
  }
}

function namingManifest(registration) {
  const claims = registration.claims
  return {
    schemaVersion: 1,
    policy: 'dsh-plugin-naming/v1',
    plugin: {
      namespace: registration.plugin.id.split('/')[0],
      name: registration.plugin.id.split('/')[1],
      coordinate: registration.plugin.id,
      packageName: registration.plugin.package,
    },
    names: {
      pluginNames: claims.pluginNames,
      loaderIds: claims.loaderIds.map((claim) => claim.name),
      services: claims.services.map((claim) => claim.name),
      tools: claims.tools.map((claim) => claim.name),
      commands: claims.commands.map((claim) => claim.name),
      skills: claims.skills.map((claim) => claim.name),
      skillProviders: claims.skillProviders.map((claim) => claim.name),
      events: claims.events.map((claim) => claim.name),
      settingsNamespaces: claims.settingsNamespaces.map((claim) => claim.name),
      routes: claims.routes.map(({ kind, path }) => ({ kind, path })),
    },
  }
}

async function writeEntry(registryRoot, value) {
  const [owner, slug] = value.plugin.id.split('/')
  const file = join(registryRoot, 'entries', owner, `${slug}.json`)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function response(value, status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export async function runPluginRegistryChecks() {
  assert(parseSemver('0.1.2-alpha.2'))
  assert.equal(parseSemver('0.1.2-alpha.01'), undefined)
  assert.equal(compareSemver('0.1.2-alpha.2', '0.1.2'), -1)
  assert.equal(compareSemver('0.1.2-alpha.10', '0.1.2-alpha.2'), 1)
  assert.equal(compareSemver('9007199254740993.0.0', '9007199254740992.0.0'), 1)
  assert.equal(compareSemver('1.0.0+build.1', '1.0.0+build.2'), 0)
  assert.equal(
    harnessRangesOverlap(
      { min: '0.1.0', maxExclusive: '0.2.0' },
      { min: '0.2.0', maxExclusive: '0.3.0' },
    ),
    false,
  )

  const root = await mkdtemp(join(tmpdir(), 'dsh-plugin-registry-'))
  const registryRoot = join(root, 'registry')
  try {
    await mkdir(join(registryRoot, 'entries'), { recursive: true })
    const alice = manifest('alice', 'search')
    const bob = manifest('bob', 'search', {
      claims: {
        loaderIds: [{ name: 'shared-loader', composition: 'root', layer: 1, overrideIntent: 'replace' }],
        tools: [{ name: 'shared_tool', scope: 'agent' }],
        skills: [{ name: 'shared-skill', scope: 'root', provider: 'bob-provider', rank: 10 }],
      },
    })
    await writeEntry(registryRoot, alice)
    await writeEntry(registryRoot, bob)

    const loaded = await loadRegistry(registryRoot)
    assert.deepEqual(loaded.errors, [])
    const index = createIndex(loaded.records)
    assert.equal(index.$schema, REGISTRY_INDEX_SCHEMA)
    assert.equal(index.contract, REGISTRY_CONTRACT)
    assert.deepEqual(index.plugins.map((entry) => entry.plugin.id), ['alice/search', 'bob/search'])
    assert.deepEqual(validateIndex(index), [])

    const invalidIndexes = [
      ['contract', { ...structuredClone(index), contract: 'dsh-plugin-registry/v3' }],
      ['source', { ...structuredClone(index), source: 'discovery/candidates.json' }],
      ['schema', { ...structuredClone(index), $schema: 'https://example.invalid/index.schema.json' }],
      ['unknown field', { ...structuredClone(index), unexpected: true }],
    ]
    for (const [label, invalidIndex] of invalidIndexes) {
      assert(validateIndex(invalidIndex).length > 0, `expected invalid index ${label} to be rejected`)
      await assert.rejects(
        readIndexSource({ registryUrl: 'https://registry.invalid/index.json', fetchImpl: async () => response(invalidIndex) }),
      )
    }

    const duplicateIdentityIndex = structuredClone(index)
    duplicateIdentityIndex.plugins.push(structuredClone(index.plugins[0]))
    assert(validateIndex(duplicateIdentityIndex).some((entry) => entry.message.includes('duplicates index.plugins[0].plugin.id')))
    assert.throws(
      () => createIndex([...loaded.records, loaded.records[0]]),
      /cannot create invalid registry index/,
    )

    const duplicatePathIndex = structuredClone(index)
    duplicatePathIndex.plugins[1].manifestPath = duplicatePathIndex.plugins[0].manifestPath
    const duplicatePathErrors = validateIndex(duplicatePathIndex)
    assert(duplicatePathErrors.some((entry) => entry.path.endsWith('.manifestPath') && entry.message.includes('duplicates')))

    const legacyIndex = structuredClone(index)
    delete legacyIndex.$schema
    legacyIndex.plugins[0].manifestPath = 'snapshots/alice-search.json'
    legacyIndex.plugins[0].$schema = 'https://example.invalid/registration-v2.schema.json'
    assert.deepEqual(validateIndex(legacyIndex), [], 'legacy v2 indexes may omit index $schema and include entry $schema')

    const malformedEntryIndex = structuredClone(index)
    malformedEntryIndex.plugins[0].plugin.status = 'unknown'
    malformedEntryIndex.plugins[0].plugin.repository = 'http://github.com/alice/dsh-search'
    malformedEntryIndex.plugins[0].plugin.package = 'https://registry.invalid/package.tgz'
    malformedEntryIndex.plugins[0].source.namingManifest = '../dsh-plugin.naming.json'
    malformedEntryIndex.plugins[0].claims.services = [{ name: 123, scope: 'root', extra: true }]
    malformedEntryIndex.plugins[0].unexpected = true
    const malformedEntryErrors = validateIndex(malformedEntryIndex)
    for (const suffix of ['.plugin.status', '.plugin.repository', '.plugin.package', '.source.namingManifest']) {
      assert(malformedEntryErrors.some((entry) => entry.path.endsWith(suffix)), `expected ${suffix} error`)
    }
    assert(malformedEntryErrors.some((entry) => entry.path.endsWith('.claims.services[0].extra')))
    assert(malformedEntryErrors.some((entry) => entry.path.endsWith('.unexpected')))

    const conflicts = detectClaimConflicts(index.plugins)
    for (const kind of ['commands', 'events', 'loaderIds', 'routes', 'services', 'skillProviders', 'skills', 'settingsNamespaces']) {
      assert(conflicts.some((entry) => entry.kind === kind), `expected ${kind} contextual result`)
    }
    assert(!conflicts.some((entry) => entry.kind === 'tools'), 'root and agent tool scopes must not collide')
    assert.equal(conflicts.find((entry) => entry.kind === 'loaderIds').severity, 'notice')
    assert.equal(conflicts.find((entry) => entry.kind === 'skills').severity, 'notice')
    assert.equal(conflicts.find((entry) => entry.kind === 'events').severity, 'warning')
    assert(!conflicts.some((entry) => entry.kind === 'pluginNames'), 'plugin module names are not global claims')

    const unicodeAlice = manifest('alice', 'unicode', {
      claims: {
        loaderIds: [{ name: 'alice-unicode-loader', composition: 'root', layer: 0, overrideIntent: 'none' }],
        services: [{ name: '\u4e2d', scope: 'root' }, { name: '\u03a9', scope: 'root' }],
        tools: [],
        commands: [],
        skills: [],
        skillProviders: [],
        events: [],
        settingsNamespaces: [],
        routes: [],
      },
    })
    const unicodeBob = manifest('bob', 'unicode', {
      claims: {
        loaderIds: [{ name: 'bob-unicode-loader', composition: 'root', layer: 0, overrideIntent: 'none' }],
        services: [{ name: '\u03a9', scope: 'root' }, { name: '\u4e2d', scope: 'root' }],
        tools: [],
        commands: [],
        skills: [],
        skillProviders: [],
        events: [],
        settingsNamespaces: [],
        routes: [],
      },
    })
    assert.deepEqual(
      detectClaimConflicts([unicodeAlice, unicodeBob]).filter((entry) => entry.kind === 'services').map((entry) => entry.claim),
      ['\u03a9', '\u4e2d'],
      'conflict ordering must use deterministic UTF-16 code-unit order, independent of host locale',
    )

    const compatibleEvent = manifest('carol', 'search', {
      claims: {
        events: [{ name: 'shared/ready', scope: 'root', role: 'consumer', schema: null }],
        services: [],
        tools: [],
        commands: [],
        skills: [],
        skillProviders: [],
        settingsNamespaces: [],
        routes: [],
        loaderIds: [{ name: 'carol-loader', composition: 'root', layer: 0, overrideIntent: 'none' }],
      },
    })
    assert(!detectClaimConflicts([alice, compatibleEvent]).some((entry) => entry.kind === 'events'))

    const laterHarness = manifest('dora', 'search', {
      plugin: { package: alice.plugin.package },
      compatibility: { harness: { min: '0.2.0', maxExclusive: '0.3.0' } },
    })
    const laterHarnessConflicts = detectClaimConflicts([alice, laterHarness])
    assert(!laterHarnessConflicts.some((entry) => entry.kind !== 'packages'))
    assert(laterHarnessConflicts.some((entry) => entry.kind === 'packages'), 'package ownership is version-independent')

    await writeFile(join(registryRoot, 'index.json'), `${JSON.stringify(index, null, 2)}\n`)
    const valid = await validateRegistry({ registryRoot, checkIndex: true })
    assert.deepEqual(valid.errors, [])

    const stale = JSON.parse(await readFile(join(registryRoot, 'index.json'), 'utf8'))
    stale.plugins = []
    await writeFile(join(registryRoot, 'index.json'), `${JSON.stringify(stale, null, 2)}\n`)
    const staleReport = await validateRegistry({ registryRoot, checkIndex: true })
    assert(staleReport.errors.some((entry) => entry.message.includes('generated index is stale')))

    const candidate = manifest('carol', 'other', {
      claims: {
        loaderIds: [{ name: 'carol-loader', composition: 'root', layer: 0, overrideIntent: 'none' }],
        tools: [{ name: 'shared_tool', scope: 'agent' }],
      },
    })
    const candidateReport = await checkManifestAgainstIndex(candidate, index, { file: 'dsh-plugin.registry.json' })
    assert.equal(candidateReport.errors.length, 0)
    assert(candidateReport.conflicts.some((entry) => entry.kind === 'services'))
    assert.equal(checkResultExitCode(candidateReport), 0)
    assert.equal(checkResultExitCode(candidateReport, { strict: true }), 2)

    const aliceUpdate = manifest('alice', 'search', {
      plugin: { release: '2.0.0' },
      claims: {
        services: [{ name: 'aliceSearchV2', scope: 'root' }],
        tools: [{ name: 'alice_search_v2', scope: 'root' }],
        commands: [{ name: 'alice-search-v2', scope: 'root' }],
      },
    })
    const updateReport = await checkManifestAgainstIndex(aliceUpdate, index, { file: 'dsh-plugin.registry.json' })
    assert(!updateReport.conflicts.some((entry) => entry.plugins.filter((plugin) => plugin.id === 'alice/search').length > 1))

    const hijack = manifest('alice', 'search', { plugin: { repository: 'https://github.com/alice/not-the-owner-repo' } })
    const hijackReport = await checkManifestAgainstIndex(hijack, index, { file: 'dsh-plugin.registry.json' })
    assert(hijackReport.conflicts.some((entry) => entry.kind === 'pluginIds' && entry.severity === 'error'))
    assert.equal(checkResultExitCode(hijackReport), 1)

    const search = searchIndex(index, 'service', 'sharedService')
    assert.equal(search.count, 2)
    assert.deepEqual(search.matches.map((entry) => entry.id), ['alice/search', 'bob/search'])
    assert.equal(searchIndex(index, 'route', 'exact /api/shared').count, 2)

    const duplicateClaims = manifest('erin', 'search', {
      claims: { services: [{ name: 'same', scope: 'root' }, { name: 'same', scope: 'root' }] },
    })
    assert(validateManifest(duplicateClaims).some((entry) => entry.message.includes('duplicates')))
    const invalidRange = manifest('erin', 'search', {
      compatibility: { harness: { min: '0.2.0', maxExclusive: '0.1.0' } },
    })
    assert(validateManifest(invalidRange).some((entry) => entry.message.includes('greater than min')))
    for (const invalidManifest of [
      manifest('erin', 'search', { plugin: { package: 'https://example.invalid/plugin.tgz' } }),
      manifest('erin', 'search', { plugin: { release: '1.0.0-alpha.01' } }),
      manifest('erin', 'search', { compatibility: { harness: { min: '0.1.2-alpha.01' } } }),
      manifest('erin', 'search', { source: { namingManifest: './dsh-plugin.naming.json' } }),
      manifest('erin', 'search', { plugin: { status: 'pending' } }),
    ]) assert(validateManifest(invalidManifest).length > 0)

    const source = namingManifest(alice)
    assert.deepEqual(
      await verifyManifestSource(alice, { fetchImpl: async () => response(source), file: 'alice.json' }),
      [],
    )
    const tampered = structuredClone(source)
    tampered.names.tools = ['different_tool']
    const sourceErrors = await verifyManifestSource(alice, {
      fetchImpl: async () => response(tampered),
      file: 'alice.json',
    })
    assert(sourceErrors.some((entry) => entry.path.endsWith('.claims.tools')))
    const unavailable = await verifyManifestSource(alice, {
      fetchImpl: async () => response('not found', 404),
      file: 'alice.json',
    })
    assert(unavailable.some((entry) => entry.message.includes('HTTP 404')))
    const malformedSource = namingManifest(alice)
    malformedSource.unexpected = true
    malformedSource.names.tools = [123]
    const malformedSourceErrors = await verifyManifestSource(alice, {
      fetchImpl: async () => response(malformedSource),
      file: 'alice.json',
    })
    assert(malformedSourceErrors.some((entry) => entry.path.endsWith('.unexpected')))
    assert(malformedSourceErrors.some((entry) => entry.path.endsWith('.names.tools[0]')))
    const oversizedSourceErrors = await verifyManifestSource(alice, {
      fetchImpl: async () => response(' '.repeat(1024 * 1024 + 1)),
      file: 'alice.json',
    })
    assert(oversizedSourceErrors.some((entry) => entry.message.includes('exceeds 1048576 bytes')))

    const oversizedPath = join(root, 'oversized-index.json')
    await writeFile(oversizedPath, ' '.repeat(5 * 1024 * 1024 + 1))
    await assert.rejects(readIndexSource({ indexPath: oversizedPath }), /exceeds 5242880 bytes/)
    await assert.rejects(
      readIndexSource({
        registryUrl: 'https://registry.invalid/index.json',
        fetchImpl: async () => response(' '.repeat(5 * 1024 * 1024 + 1)),
      }),
      /exceeds 5242880 bytes/,
    )
    for (const contentLength of ['not-a-number', '-1', '9007199254740992']) {
      await assert.rejects(
        readIndexSource({
          registryUrl: 'https://registry.invalid/index.json',
          fetchImpl: async () => response(index, 200, { 'content-length': contentLength }),
        }),
        /invalid Content-Length header/,
      )
    }
    const invalidUtf8Path = join(root, 'invalid-utf8-index.json')
    await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]))
    await assert.rejects(readIndexSource({ indexPath: invalidUtf8Path }), /encoded data was not valid/)
    let unsafeFallbackRead = false
    await assert.rejects(
      readIndexSource({
        registryUrl: 'https://registry.invalid/index.json',
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => null },
          body: null,
          text: async () => {
            unsafeFallbackRead = true
            return JSON.stringify(index)
          },
        }),
      }),
      /bounded fallback refused/,
    )
    assert.equal(unsafeFallbackRead, false, 'non-stream responses must fail closed without unbounded buffering')

    const examplesRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'registry', 'examples')
    const exampleRegistration = JSON.parse(await readFile(join(examplesRoot, 'plugin-registration.example.json'), 'utf8'))
    const exampleNaming = JSON.parse(await readFile(join(examplesRoot, 'plugin-naming.example.json'), 'utf8'))
    assert.deepEqual(
      await verifyManifestSource(exampleRegistration, {
        fetchImpl: async () => response(exampleNaming),
        file: 'registry/examples/plugin-registration.example.json',
      }),
      [],
      'phase-one and phase-two examples must remain contract-compatible',
    )

    await mkdir(join(registryRoot, 'entries', 'broken'), { recursive: true })
    await writeFile(join(registryRoot, 'entries', 'broken', 'manifest.json'), '{"schemaVersion":2}\n')
    const malformedRegistry = await validateRegistry({ registryRoot })
    assert(malformedRegistry.errors.some((entry) => entry.message === 'must be an object'))

    const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'registry', 'schema', 'plugin-registration.schema.json')
    const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
    assert.equal(schema.properties.schemaVersion.const, 2)
    assert.equal(schema.$id, 'https://raw.githubusercontent.com/oh-my-dsh/dsh-plugin-registry/main/registry/schema/plugin-registration.schema.json')
    assert.deepEqual(schema.properties.claims.required, sourceSurfaceNamesForTest())
    assert.deepEqual(schema.properties.claims.properties.routes.items.properties.kind.enum, ['exact', 'prefix', 'upgrade'])
    assert(!Object.hasOwn(schema.properties.claims.properties, 'ports'))
    const indexSchema = JSON.parse(await readFile(join(dirname(schemaPath), 'plugin-index.schema.json'), 'utf8'))
    assert.equal(indexSchema.$id, REGISTRY_INDEX_SCHEMA)
    assert(!indexSchema.required.includes('$schema'), 'index $schema remains optional for legacy v2 clients')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function sourceSurfaceNamesForTest() {
  return [
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
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  await runPluginRegistryChecks()
  console.log('Plugin registry checks OK: v2 schema, SemVer overlap, scoped conflicts, Loader intent, Skill rank, event schemas, source proof, index, identity, search')
}
