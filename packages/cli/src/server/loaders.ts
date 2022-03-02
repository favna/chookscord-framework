import type { ChooksScript, Command, CommandModule, CommandStore, EmptyObject, Event, GenericHandler, Logger, MessageCommand, Option, SlashCommand, SlashSubcommand, Subcommand, SubcommandGroup, UserCommand } from 'chooksie'
import type { LoggerFactory } from 'chooksie/internals'
import type { Awaitable, Client, ClientEvents } from 'discord.js'
import { randomUUID } from 'node:crypto'
import { relative } from 'node:path'
import { createKey, getAutocompletes, timer } from '../internals'
import type { SourceMap, Store } from '../lib'

interface EventModule {
  name: keyof ClientEvents
  execute: () => Awaitable<void>
  logger: Logger
}

type EventStore = Map<string, EventModule>
type ScriptStore = Map<string, () => Awaitable<void>>

export interface Stores {
  /** Used for tracking loaded commands */
  module: Store<Command>
  /** Used for storing handlers */
  command: Store<CommandModule>
  /** Stores event listeners for unloading */
  event: Store<EventModule>
  /** Stores cleanup script functions */
  cleanup: Store<() => Awaitable<void>>
}

function hasOnLoad(mod: Record<string, unknown>): mod is Required<ChooksScript> {
  return typeof mod.chooksOnLoad === 'function'
}

function loadAutocompletes(store: CommandStore, parentKey: string, pino: LoggerFactory, options: Option[] | undefined) {
  for (const option of getAutocompletes(options)) {
    const key = createKey('auto', parentKey, option.name)
    const logger = pino('autocomplete', key)

    const setup = option.setup ?? (() => ({}))
    const execute: GenericHandler = async ctx => {
      const deps = await setup()
      await (<GenericHandler>option.autocomplete).call(deps, ctx)
    }

    store.set(key, { execute, logger })
  }
}

function loadSlashCommand(store: CommandStore, pino: LoggerFactory, command: SlashCommand): void {
  const parentKey = createKey(command.name)
  const key = createKey('cmd', parentKey)
  const logger = pino('command', key)

  const setup = command.setup ?? (() => ({}))
  const execute: GenericHandler = async ctx => {
    const deps = await setup()
    await (<GenericHandler>command.execute).call(deps, ctx)
  }

  store.set(key, { execute, logger })
  loadAutocompletes(store, parentKey, pino, command.options)
}

function loadSubcommand(store: CommandStore, parentName: string, pino: LoggerFactory, subcommand: Subcommand) {
  const parentKey = createKey(parentName, subcommand.name)
  const key = createKey('cmd', parentKey)
  const logger = pino('subcommand', key)

  const setup = subcommand.setup ?? (() => ({}))
  const execute: GenericHandler = async ctx => {
    const deps = await setup()
    await (<GenericHandler>subcommand.execute).call(deps, ctx)
  }

  store.set(key, { execute, logger })
  loadAutocompletes(store, parentKey, pino, subcommand.options)
}

function loadSubcommandGroup(store: CommandStore, parentName: string, pino: LoggerFactory, group: SubcommandGroup) {
  for (const subcommand of group.options) {
    const parentKey = createKey(parentName, group.name, subcommand.name)
    const key = createKey('cmd', parentKey)
    const logger = pino('subcommand', key)

    const setup = subcommand.setup ?? (() => ({}))
    const execute: GenericHandler = async ctx => {
      const deps = await setup() as EmptyObject
      await (<GenericHandler>subcommand.execute).call(deps, ctx)
    }

    store.set(key, { execute, logger })
    loadAutocompletes(store, parentKey, pino, subcommand.options)
  }
}

function loadSlashSubcommand(store: CommandStore, pino: LoggerFactory, command: SlashSubcommand): void {
  for (const option of command.options) {
    if (option.type === 'SUB_COMMAND') {
      loadSubcommand(store, command.name, pino, option as Subcommand)
      continue
    }

    if (option.type === 'SUB_COMMAND_GROUP') {
      loadSubcommandGroup(store, command.name, pino, option)
      continue
    }
  }
}

function loadUserCommand(store: CommandStore, pino: LoggerFactory, command: UserCommand): void {
  const key = createKey('usr', command.name)
  const logger = pino('user', key)

  const setup = command.setup ?? (() => ({}))
  const execute: GenericHandler = async ctx => {
    const deps = await setup()
    await (<GenericHandler>command.execute).call(deps, ctx)
  }

  store.set(key, { execute, logger })
}

function loadMessageCommand(store: CommandStore, pino: LoggerFactory, command: MessageCommand): void {
  const key = createKey('msg', command.name)
  const logger = pino('message', key)

  const setup = command.setup ?? (() => ({}))
  const execute: GenericHandler = async ctx => {
    const deps = await setup()
    await (<GenericHandler>command.execute).call(deps, ctx)
  }

  store.set(key, { execute, logger })
}

function unloadEvent(store: EventStore, client: Client, key: string, logger?: Logger): void {
  if (!store.has(key)) {
    logger?.warn('Tried to unload an event that wasn\'t saved!')
    return
  }

  const event = store.get(key)!
  client.off(event.name, event.execute)
  logger?.info(`Unloaded "${event.name}" listener!`)
}

// eslint-disable-next-line max-params, max-len
function loadEvent(store: EventStore, client: Client, key: string, pino: LoggerFactory, event: Event<keyof ClientEvents>): void {
  const name = event.name
  const _logger = pino('event', name)

  const setup = event.setup ?? (() => ({}))
  const execute = async (...args: ClientEvents[keyof ClientEvents]) => {
    const reqId = randomUUID()
    const logger = _logger.child({ reqId })

    try {
      const deps = await setup()
      logger.info(`Running handler for "${event.name}"...`)

      const endTimer = timer()
      // @ts-ignore: 'this' context blah blah complex type
      await event.execute.call(deps, { client, logger }, ...args)

      logger.info({
        responseTime: endTimer(),
        msg: `Successfully ran handler for "${event.name}".`,
      })
    } catch (error) {
      _logger.info(`Handler for "${event.name}" did not run successfully.`)

      logger.error('An unexpected error has occured!')
      logger.error(error)
    }
  }

  if (store.has(key)) {
    const oldListener = store.get(event.name)!
    client.off(key, oldListener.execute)
  }

  store.set(key, { name, execute, logger: _logger })
  client[event.once ? 'once' : 'on'](name, execute)
}

async function unloadScript(store: ScriptStore, logger: Logger, root: string, file: SourceMap): Promise<void> {
  const relpath = relative(root, file.source)
  if (!store.has(relpath)) return

  try {
    const cleanup = store.get(relpath)!
    await cleanup()
  } catch (error) {
    logger.error(`Cleanup function at ${relpath} threw an error!`)
    logger.error(error)
  }
}

// eslint-disable-next-line max-params, max-len
async function loadScript(store: ScriptStore, client: Client, pino: LoggerFactory, root: string, file: SourceMap): Promise<void> {
  const relpath = relative(root, file.source)

  // Scripts MUST be cached since track child dependencies from require.cache
  const mod = await import(file.target) as Record<string, unknown>
  if (!hasOnLoad(mod)) return

  const logger = pino('script', relpath)
  try {
    const cleanup = await mod.chooksOnLoad({ client, logger })
    if (cleanup) {
      store.set(relpath, cleanup)
    }
  } catch (error) {
    logger.error(error)
    logger.error('Failed to run setup script!')
  }
}

export { loadEvent, loadSlashCommand, loadSlashSubcommand, loadUserCommand, loadMessageCommand, loadScript }
export { unloadEvent, unloadScript }