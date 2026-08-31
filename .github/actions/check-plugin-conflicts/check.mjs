import { runCli } from '../../../scripts/plugin-registry.mjs'

function actionRegistryUrl() {
  const repository = process.env.DSH_ACTION_REPOSITORY
  const ref = process.env.DSH_REGISTRY_REF || 'main'
  if (!repository) throw new Error('registry-url is required outside a published GitHub Action')
  return `https://raw.githubusercontent.com/${repository}/${ref}/registry/index.json`
}

const strict = /^(1|true|yes|on)$/i.test(process.env.DSH_REGISTRY_STRICT ?? '')
const args = ['check', '--manifest', process.env.DSH_REGISTRY_MANIFEST || 'dsh-plugin.registry.json', '--format', 'github']
if (process.env.DSH_REGISTRY_INDEX) args.push('--index', process.env.DSH_REGISTRY_INDEX)
else args.push('--registry-url', process.env.DSH_REGISTRY_URL || actionRegistryUrl())
if (strict) args.push('--strict')

try {
  const code = await runCli(args)
  process.exitCode = code
} catch (error) {
  const message = String(error?.message ?? error).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  if (strict) {
    console.log(`::error::DSH registry check unavailable: ${message}`)
    process.exitCode = 1
  } else {
    console.log(`::warning::DSH registry check unavailable: ${message}; advisory mode keeps the workflow green`)
    process.exitCode = 0
  }
}
