import { Command } from 'commander';
import CommandService from './services/commands';

const commandService = new CommandService();
const program = new Command();

program
  .name('backup-tool')
  .description('A tool for managing backups')
  .version('1.0.0');

program
  .command('snapshot <target>')
  .description('Snapshot a target directory')
  .action((name: string) => {
    commandService.handleSnapshot(name);
  });

program
  .command('list')
  .description('List all snapshots in order of creation')
  .action(() => {
    commandService.handleList();
  });

program
  .command('restore <id> <target>')
  .description('Restore a snapshot to the target directory')
  .action((id: string, target: string) => {
    commandService.handleRestore(id, target);
  });

program
  .command('prune <id>')
  .description('Snapshot a target directory')
  .action((id: string) => {
    commandService.handlePrune(id);
  });

program.parse(process.argv);