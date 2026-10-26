import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

/**
 * The AHV web patch replaces the `connection` row's config whole, so it must
 * repeat web-app's trust-fence expression. dsh 0.2.1 moved that expression
 * from `ctx.webRuntime` (gone) to `ctx.webStartup`; a stale copy throws while
 * the Loader resolves the row, and `ahv web` serves no API.
 */
const LOADER_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (text: string) => ({ js: text }) }),
])

interface Row { id?: string; inject?: string[]; config?: Record<string, unknown>; insert?: Row[] }

function load(path: string): Row[] {
  return yaml.load(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'), { schema: LOADER_SCHEMA }) as Row[]
}

function find(rows: readonly Row[], id: string): Row | undefined {
  for (const row of rows) {
    if (row.id === id) return row
    const nested = find([...row.insert ?? [], ...Array.isArray(row.config) ? row.config as Row[] : []], id)
    if (nested !== undefined) return nested
  }
  return undefined
}

describe('AHV web connection row', () => {
  it('repeats web-app\'s trustedHosts expression over a service web-app injects', () => {
    const upstream = find(load('../../web-app/cordis.patch.yml'), 'connection')
    const ahv = find(load('../cordis.patch.web.yml'), 'connection')
    expect(upstream?.config?.trustedHosts).toBeDefined()
    expect(ahv?.config?.trustedHosts).toEqual(upstream?.config?.trustedHosts)
    const service = /ctx\.(\w+)\./.exec((upstream?.config?.trustedHosts as { js: string }).js)?.[1]
    expect(upstream?.inject).toContain(service)
  })
})
