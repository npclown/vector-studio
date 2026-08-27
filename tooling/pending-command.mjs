import process from 'node:process';

const [, , command, milestone] = process.argv;

console.error(
  `${command ?? 'Command'} is NOT IMPLEMENTED. Its validation runner is scheduled for ${milestone ?? 'a later milestone'}.`,
);
process.exitCode = 1;
