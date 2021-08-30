import * as lib from '@chookscord/lib';
import * as types from '../../../types';
import * as utils from '../../../utils';
import { Client, Interaction } from 'discord.js';

const logger = lib.createLogger('[cli] Commands');

// Duplicated from /scripts/dev/modules/commands
function createListener(
  client: Client,
  store: lib.CommandStore<lib.BaseSlashCommand>,
) {
  logger.success('Slash command listener created.');
  return async (interaction: Interaction) => {
    logger.debug('Interaction received.');
    if (!interaction.isCommand()) {
      logger.debug('Interaction is not a command.');
      return;
    }

    const commandName = interaction.commandName;
    const command = store.get(commandName);

    if (!command) {
      logger.warn(`Command "${commandName}" was recieved, but no handler was present!`);
      return;
    }

    try {
      logger.info(`Executing command "${commandName}"...`);
      const stopTimer = utils.createTimer();
      await command.execute({
        client,
        fetch: lib.fetch,
        logger: lib.createLogger(`[commands] ${commandName}`),
        interaction,
      });

      logger.success(`Finished executing command "${commandName}". Time took: ${stopTimer().toLocaleString()}ms`);
    } catch (error) {
      logger.error(`Failed to execute command "${commandName}"!`);
      logger.error(error);
    }
  };
}

export async function init(
  config: Omit<types.ModuleConfig, 'output'>,
): Promise<void> {
  const client: Client = config.ctx.client;
  const store = new lib.CommandStore<lib.BaseSlashCommand>();
  const files = await lib.loadDir(config.input);

  logger.trace('Checking loaded dir.');
  if (!files) {
    logger.error(new Error(`Could not load directory "${config.input}"!`));
    return;
  }

  const loadCommand = async (filePath: string) => {
    const path = filePath.slice(config.input.length);
    logger.info(`Loading command file "${path}"...`);
    const endTimer = utils.createTimer();
    const command = await utils.importDefault<lib.BaseSlashCommand>(filePath);

    if (JSON.stringify(command) === '{}') {
      logger.error(new Error(`"${path}" has no exported command!`));
      return;
    }

    const validateError = lib.validateBaseCommand(command);
    if (validateError) {
      logger.error(new Error(validateError));
      return;
    }

    store.set(command.name, command);
    logger.success(`Loaded command "${command.name}". Time took: ${endTimer().toLocaleString()}ms`);
  };

  logger.trace('Loading files.');
  for await (const file of files) {
    if (file.isDirectory) continue;
    loadCommand(file.path);
  }

  client.on('interactionCreate', createListener(client, store));
}
