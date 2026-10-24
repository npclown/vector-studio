// The path mesh failure notices the playground pages list (docs/requirements.md, "Path rendering
// failures"; D9 E11-U4 addendum). One filter for every page, so a page cannot drift from the
// renderer's code.
import { DIAGNOSTIC_CODES } from '@vector-studio/contracts';

export const PATH_NOTICE_CODE = DIAGNOSTIC_CODES.PATH_MESH_FAILURE;

export function isPathNotice(event: Readonly<{ code: string }>): boolean {
  return event.code === PATH_NOTICE_CODE;
}
