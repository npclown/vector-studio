// E26-A09 (E26 contract, section 4.3): in every unit test, each change-scoped projection also
// runs the whole-page path from the same state and throws when the two differ, so every command
// of the editor's tests checks the scoped path. Both module instances are switched: the sources
// most tests import and the built package that `@vector-studio/editor-core` resolves to. The
// built package must be current (`pnpm build`): a dist from before E26-U4 has no such seam, and
// every test then fails here with a TypeError rather than run without the check.
import { checkScopedProjectionForTesting } from '../../packages/editor-core/src/projector.js';
import { checkScopedProjectionForTesting as checkBuilt } from '../../packages/editor-core/dist/projector.js';

checkScopedProjectionForTesting(true);
checkBuilt(true);
