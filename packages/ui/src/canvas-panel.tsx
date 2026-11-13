import {
  useActivePage,
  useEditorCommands,
  useEditorSelector,
  useSelection,
  type Command,
} from '@vector-studio/react';
import {
  backgroundCommand,
  canvasFields,
  gridColorCommand,
  gridOpacityCommand,
  gridSizeCommand,
} from './canvas-model.js';
import { ColorWell } from './color-controls.js';
import { Row, TextField } from './fields.js';

/**
 * V-41 contract, V41-U1: the property panel's Canvas section, shown while nothing is selected:
 * the active page's background colour, and its canvas grid's colour, opacity and size. Each
 * commit is one `setPageCanvas`; a field whose text is not a value or whose command is refused is
 * marked `aria-invalid`.
 */
export function CanvasSection() {
  const execute = useEditorCommands();
  const selection = useSelection();
  const activePage = useActivePage();
  const page = useEditorSelector((snapshot) =>
    snapshot.document.pages.find((entry) => entry.id === activePage),
  );
  if (selection.length > 0 || page === undefined) return null;
  const fields = canvasFields(page);
  const run = (command: Command | null) => command !== null && execute(command).ok;
  return (
    <fieldset data-testid="canvas-panel">
      <legend>Canvas</legend>
      <Row>
        <span>Background</span>
        <TextField
          identity={page.id}
          label="Canvas background"
          value={fields.background}
          commit={(text) => run(backgroundCommand(page, text))}
        />
        <ColorWell
          label="Canvas background picker"
          testId="canvas-background-picker"
          value={fields.background}
          commit={(hex) => run(backgroundCommand(page, hex))}
        />
      </Row>
      <Row>
        <span>Grid</span>
        <TextField
          identity={page.id}
          label="Canvas grid colour"
          value={fields.gridColor}
          commit={(text) => run(gridColorCommand(page, text))}
        />
        <ColorWell
          label="Canvas grid colour picker"
          testId="canvas-grid-colour-picker"
          value={fields.gridColor}
          commit={(hex) => run(gridColorCommand(page, hex))}
        />
        <TextField
          identity={page.id}
          label="Canvas grid opacity"
          value={fields.gridOpacity}
          commit={(text) => run(gridOpacityCommand(page, text))}
        />
        <span aria-hidden="true">%</span>
      </Row>
      <Row>
        <span>Grid size</span>
        <TextField
          identity={page.id}
          label="Canvas grid size"
          value={fields.gridSize}
          commit={(text) => run(gridSizeCommand(page, text))}
        />
      </Row>
    </fieldset>
  );
}
