/**
 * ahv-bot startup: the CLI provider for the AHV bot adapter runner.
 * Parses `--prompt-file`, `--cwd`, `--session-id`, `--resume`, `--output`,
 * `--no-color`, `--no-banner` from the launcher's `cmdlineArgs`, reads the
 * prompt text from the file (or `-` for stdin), and publishes the resolved
 * values via the `botStartup` service. The bot runner is a consumer of that
 * service; a missing/invalid arg fails loud here so the runner never sees a
 * half-formed config.
 * @module @ahvclaw/dsh-bundle-ahv/bot-startup
 */

import { readFileSync } from 'node:fs'
import { resolve as resolvePath, isAbsolute } from 'node:path'
import { Command, Option } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'bot-startup'

/** Services required before the args can be resolved. */
export const inject = ['cmdlineArgs']

/** Service published by this plugin. */
export const BOT_STARTUP_SERVICE = 'botStartup'

/** Machine-parseable output modes recognised by the bot adapter. */
export type OutputMode = 'jsonl' | 'text'

/** Resolved args published on {@link BOT_STARTUP_SERVICE}. */
export interface BotStartupValues {
  /** The prompt text (already read from --prompt-file). */
  readonly prompt: string
  /** Absolute working directory the agent should run inside. */
  readonly cwd: string
  /** Caller-supplied session id (mutually exclusive with resumeSessionId). */
  readonly sessionId: string | undefined
  /** Resume an existing session by id (mutually exclusive with sessionId). */
  readonly resumeSessionId: string | undefined
  /** Model to run this turn on; `provider/model` pins the provider too. */
  readonly model: string | undefined
  /** Output format: jsonl (machine) or text (legacy final-only). */
  readonly output: OutputMode
  /** Suppress ANSI escape sequences. */
  readonly noColor: boolean
  /** Suppress the launcher banner. */
  readonly noBanner: boolean
}

function botCommand(): Command {
  return new Command()
    .name('dsh --profile bot')
    .description('Non-interactive bot adapter: read prompt from file/stdin, stream JSONL.')
    .helpOption('-h, --help', 'show this help')
    .requiredOption('--prompt-file <path>', 'file containing prompt text; `-` reads stdin')
    .option('--cwd <dir>', 'absolute working directory for the agent', process.cwd())
    .option('--session-id <id>', 'caller-supplied session id (creates if new, mutually exclusive with --resume)')
    .option('--resume <id>', 'resume an existing session by id (mutually exclusive with --session-id)')
    .option('--model <id>', 'model for this turn; accepts `model` or `provider/model`')
    .addOption(new Option('--output <mode>', 'stdout format').choices(['jsonl', 'text']).default('jsonl'))
    .option('--no-color', 'suppress ANSI escape sequences')
    .option('--no-banner', 'suppress the launcher banner')
    .addHelpText('after', `
Examples:
  dsh --profile bot --prompt-file /tmp/prompt.txt --cwd /tmp
  echo "Say OK" | dsh --profile bot --prompt-file - --cwd /tmp --session-id my-run-1
`)
}

/** Read prompt text from disk or stdin; treat empty prompt as usage error. */
function readPrompt(path: string): string {
  const buf = path === '-' ? readFileSync(0) : readFileSync(resolvePath(path))
  const text = buf.toString('utf8')
  if (text.trim() === '') throw new Error(`prompt is empty (source: ${path === '-' ? 'stdin' : path})`)
  return text
}

/**
 * Mount the bot-startup provider.
 * @param ctx - plugin context carrying the launcher cmdlineArgs.
 */
export function apply(ctx: Context): void {
  const program = botCommand()
  program.action(() => {
    const opts = program.opts<{
      promptFile: string
      cwd: string
      sessionId?: string
      resume?: string
      model?: string
      output: OutputMode
      color: boolean
      banner: boolean
    }>()
    if (opts.sessionId !== undefined && opts.resume !== undefined) {
      program.error('error: --session-id and --resume are mutually exclusive')
    }
    const cwd = isAbsolute(opts.cwd) ? opts.cwd : resolvePath(opts.cwd)
    let prompt = ''
    try {
      prompt = readPrompt(opts.promptFile)
    } catch (error) {
      program.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
    const values: BotStartupValues = {
      prompt,
      cwd,
      sessionId: opts.sessionId,
      resumeSessionId: opts.resume,
      model: opts.model,
      output: opts.output,
      noColor: !opts.color,
      noBanner: !opts.banner,
    }
    ctx.provide(BOT_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
