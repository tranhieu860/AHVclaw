import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

/**
 * Both AHV patches send the AHV route straight to AHV AI with the machine's own
 * AHV_API_KEY. The router on #1 ignored the caller's key and spent its own, so
 * one revoked key stopped the whole fleet (#976). ahv-qwen38 lived only behind
 * that router; a default still naming it must run on AHV-Holding.
 */
const LOADER_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (text: string) => ({ js: text }) }),
])

interface Row { id?: string; name?: string; config?: Record<string, unknown>; insert?: Row[] }
interface Provider { apiKeyEnv?: string; baseURL?: string; models?: { id: string }[] }

const PATCHES = ['../cordis.patch.yml', '../cordis.patch.web.yml']

function rows(path: string): Row[] {
  return yaml.load(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'), { schema: LOADER_SCHEMA }) as Row[]
}

/** Evaluate a `!!js` default-model expression against the given environment. */
function evaluate(expression: { js: string }, env: Record<string, string>): unknown {
  return new Function('process', `return (${expression.js})`)({ env })
}

describe.each(PATCHES)('%s', (path) => {
  const patch = rows(path)
  const provider = (patch.find(row => row.id === 'llm-pi-ai')?.config?.providers as Record<string, Provider> | undefined)?.['ahv-router'] ?? {}
  const model = patch.find(row => row.id === 'agent-default-model')?.config?.model as { js: string }

  it('calls AHV AI directly with the machine key', () => {
    expect(provider.baseURL).toBe('https://auto.ahvchat.com/v1')
    expect(provider.apiKeyEnv).toBe('AHV_API_KEY')
  })

  it('lists the AHV models without the retired ahv-qwen38', () => {
    expect(provider.models?.map(m => m.id)).toEqual(['AHV-Holding', 'AHV-Holding-TroLy', 'AHV-Holding-DEV', 'Grok-SuperHeavy'])
  })

  it('mounts the listener that moves restored retired-model requests', () => {
    const inserted = patch.flatMap(row => row.insert ?? [])
    expect(inserted).toContainEqual({ id: 'ahv-retired-models', name: '@ahvclaw/dsh-bundle-ahv/retired-models' })
  })

  it('defaults to AHV-Holding and moves a retired choice there', () => {
    expect(evaluate(model, {})).toBe('AHV-Holding')
    expect(evaluate(model, { AHV_DEFAULT_MODEL: '' })).toBe('AHV-Holding')
    expect(evaluate(model, { AHV_DEFAULT_MODEL: 'ahv-qwen38' })).toBe('AHV-Holding')
    expect(evaluate(model, { AHV_DEFAULT_MODEL: 'grok-4.7' })).toBe('grok-4.7')
  })
})
