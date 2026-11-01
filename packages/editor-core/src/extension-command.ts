import type { JsonValue } from '@vector-studio/model';
import type { Command } from './types.js';

// Typed extension commands (MVP M8 contract, M8-X2, M8-Q6 (a)): a pure builder with no state.
// The extension's `run` still validates `args` at run time.

/**
 * A typed builder for one extension command (MVP M8 contract, M8-X2): `command(args)` returns
 * the `runCommand` command that runs `id` with `args`.
 */
export type ExtensionCommandBuilder<Args extends JsonValue> = Readonly<{
  /** The extension command's ID. */
  id: string;
  /** The `runCommand` command for `args`, equal to one written by hand. */
  command(args: Args): Command;
}>;

/**
 * Builds a typed builder for the extension command `id` (MVP M8 contract, M8-X2): a wrong
 * argument shape is a type error, while the extension's `run` still validates `args` at run time.
 * `extensionCommand<StarCreateArgs>('ext.star.create').command({ frame })` equals
 * `{ type: 'runCommand', id: 'ext.star.create', args: { frame } }`.
 */
export function extensionCommand<Args extends JsonValue>(
  id: string,
): ExtensionCommandBuilder<Args> {
  return Object.freeze({
    id,
    command: (args: Args): Command => ({ type: 'runCommand', id, args }),
  });
}
