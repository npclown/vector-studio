import { createCounterIdSource, createEditor } from '@vector-studio/editor-core';
import { describe, expect, it } from 'vitest';
import { pathDebugText } from '../../apps/next-host/src/v25-path-debug.js';

// V-25 slice 8 debugging aid: the selected path's node as JSON, for the user to pass on.

describe('V-25 path debug text', () => {
  it('is the stored path node as JSON, with its verbs, points and stroke', () => {
    const editor = createEditor({ ids: createCounterIdSource('n') });
    const result = editor.execute({
      type: 'createPath',
      verbs: ['move', 'cubic'],
      points: [0, 0, 1, 1, 9, 9, 10, 10],
    });
    if (!result.ok) throw new Error(result.code);
    const node = editor.getSnapshot().document.nodes[result.ids[0]!]!;
    const text = pathDebugText(node);
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(node)));
    expect(text).toContain('"verbs"');
    expect(text).toContain('"stroke"');
  });
});
