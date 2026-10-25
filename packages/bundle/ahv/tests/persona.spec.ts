import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

/**
 * The AHV persona is a prompt template: every `{{name}}` in it must be a
 * variable the core registers, or each model step fails before the request.
 * dsh 0.2.1 dropped the loop's `{{cwd}}` (the working-directory service sends
 * the directory as user context), leaving `provider` and `model`.
 */
const CORE_VARIABLES = { provider: 'ahv-router', model: 'ahv-qwen38' }

/** `!!js` values are Loader expressions; this test reads them as plain text. */
const LOADER_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (text: string) => text }),
])

interface Row { id?: string; config?: { personaPrefix?: string } }

function personaOf(file: string): string {
  const rows = yaml.load(readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8'), { schema: LOADER_SCHEMA }) as Row[]
  const persona = rows.find(row => row.id === 'system-prompt')?.config?.personaPrefix
  if (persona === undefined) throw new Error(`${file}: no system-prompt personaPrefix`)
  return persona
}

describe('AHV persona', () => {
  for (const file of ['cordis.patch.yml', 'cordis.patch.web.yml']) {
    it(`${file} renders with only the core prompt variables`, async () => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt, { personaPrefix: personaOf(file) })
      for (const [name, value] of Object.entries(CORE_VARIABLES)) ctx.systemPrompt.variable(name, () => value)
      const prompt = renderPrompt(await ctx.systemPrompt.assemble({}))
      expect(prompt).toContain('Bạn là AHV CLI')
      expect(prompt).toContain('Model hiện tại: ahv-qwen38.')
    })
  }
})
