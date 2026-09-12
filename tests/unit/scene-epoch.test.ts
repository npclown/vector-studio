import type { RenderSceneSnapshot } from '@vector-studio/contracts';
import { describe, expect, it } from 'vitest';
import { RetainedSceneMirror } from '../../packages/renderer-core/src/scene-mirror.js';

describe('private scene epoch ownership', () => {
  it('changes only on accepted snapshot replacement, including identity round trips', () => {
    const mirror = new RetainedSceneMirror();
    const initial: RenderSceneSnapshot = {
      identity: { documentId: 'epoch', pageId: 'a' },
      revision: 0,
      nodes: [],
      rootOrder: [],
    };
    expect(mirror.replaceSnapshot(initial).status).toBe('applied');
    const first = mirror.readRetainedScene()!;
    expect(typeof first.sceneEpoch).toBe('symbol');
    expect(mirror.replaceSnapshot(initial).status).toBe('replayed');
    expect(mirror.readRetainedScene()!.sceneEpoch).toBe(first.sceneEpoch);
    expect(
      mirror.applyChanges({
        ...initial,
        baseRevision: 0,
        revision: 1,
        inserted: [],
        updated: [],
        removed: [],
        orders: [],
      }).status,
    ).toBe('invalid-scene');
    expect(mirror.readRetainedScene()!.sceneEpoch).toBe(first.sceneEpoch);
    expect(
      mirror.applyChanges({
        identity: initial.identity,
        baseRevision: 0,
        revision: 1,
        inserted: [],
        updated: [],
        removed: [],
        orders: [],
      }).status,
    ).toBe('applied');
    expect(mirror.readRetainedScene()!.sceneEpoch).toBe(first.sceneEpoch);
    mirror.setCamera({ position: { x: 5, y: 3 }, zoom: 2 });
    expect(mirror.readRetainedScene()!.sceneEpoch).toBe(first.sceneEpoch);
    expect(mirror.replaceSnapshot({ ...initial, revision: 2 }).status).toBe('applied');
    const replacement = mirror.readRetainedScene()!.sceneEpoch;
    expect(replacement).not.toBe(first.sceneEpoch);
    expect(
      mirror.replaceSnapshot({ ...initial, identity: { ...initial.identity, pageId: 'b' } }).status,
    ).toBe('applied');
    const other = mirror.readRetainedScene()!.sceneEpoch;
    expect(mirror.replaceSnapshot(initial).status).toBe('applied');
    const returned = mirror.readRetainedScene()!.sceneEpoch;
    expect(new Set([first.sceneEpoch, replacement, other, returned]).size).toBe(4);
    expect(first.version.revision).toBe(0);
    mirror.dispose();
    expect(mirror.readRetainedScene()).toBeNull();
  });
});
