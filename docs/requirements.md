# Vector Studio requirements v0.1

Status: Accepted product baseline for prototype planning

This document is the source of truth for product goals, behavior, scope, and deferrals. System boundaries belong in `ARCHITECTURE.md`; execution and validation details belong in the active plan and validation documents.

## Product goal

Vector Studio is an embeddable vector-editor SDK for React and Next.js applications. Its core must remain framework-independent so Vue, Svelte, and vanilla bindings can be added later.

The long-term direction is a precise and extensible editor comparable to Figma. The initial experience and UI should stay small and approachable, closer to Excalidraw. The first deliverable is an in-repository prototype, not a production application or public package.

The MVP requirements below describe the intended editor, not a claim that the graphics prototype implements them. The narrower P0-P5 validation slice and remaining coverage are tracked in [the prototype roadmap](prototype-plan.md#requirement-coverage). Deferral from that slice does not remove an MVP requirement.

## SDK model

- The editor engine owns live editing state.
- Host applications execute commands, subscribe to changes, and read stable snapshots.
- React provides a provider, hooks, and headless primitives.
- A minimal UI exists only to validate the public headless API.
- The core does not depend on React or browser DOM types.
- Next.js support requires reliable client-component usage; SSR rendering is not required.

## Document

- A document contains multiple pages.
- Each page owns an infinite canvas and a scene-graph root.
- The canonical format is versioned, JSON-serializable application data.
- SVG is a future interchange format, not the internal source of truth.
- Stable opaque string identifiers are used for all persistent entities.
- Animation and collaboration are excluded initially, but the format must be migratable to support them later.

## MVP node types

- Rectangle and rounded rectangle
- Ellipse
- Line and arrow
- Open and closed cubic Bezier path
- Rich text
- Group
- Frame
- Mask group
- Simplified symbol and symbol instance

Images are deferred.

## Path editing

- Straight and cubic Bezier segments
- Anchor and control-handle editing
- Open and closed subpaths
- Node insertion and removal
- Butt, round, and square caps
- Miter, round, and bevel joins

Boolean operations, stroke outlining, and path simplification are deferred.

## Text

- Multiple styled runs in a text node
- Font family, size, and color per run
- Wrapping and auto width/height
- Letter spacing, line height, and paragraph alignment
- Normal caret and selection behavior
- Korean IME composition
- System fonts and host-provided web fonts
- External rich-text paste is normalized to plain text initially

## Containers

Frames can contain nested children, have background and border, clip their content, act as future export or animation-scene boundaries, and support basic resize constraints. Auto layout is deferred.

Groups scale their children proportionally when resized.

A mask group uses its first path as the mask for its remaining children.

## Symbols

- Source changes propagate to instances.
- Instances have independent placement and size.
- Instance text content may differ from the source.
- Instances can be detached.
- Nested instances, variants, and general property overrides are deferred.

## Initial appearance model

- Solid fill
- One linear or radial gradient
- Stroke color and width
- Dash pattern
- Stroke join and cap
- Opacity
- Independent rectangle corner radii

Multiple fills, shadows, blur, and blend modes are deferred.

## Editing behavior

- Click, additive, and marquee selection
- Move, resize, and rotate
- Grouping and layer reordering
- Align and distribute
- Snapping to object/frame edges and centers, equal spacing, and rotation angles
- Zoom and pan
- Copy and paste
- Undo and redo
- Configurable shortcuts
- Alt-drag duplication and keyboard nudging
- Overlap-selection cycling and frame-entry editing
- Minimal layer and property panels

All persistent changes occur through commands and transactions. Continuous pointer movement and text input are merged into useful history steps. Selection, hover, viewport, and panel state are not document history.

## Persistence

- JSON serialization and deserialization
- Host-controlled persistence
- Optional IndexedDB adapter with autosave
- Restore document content and the last open page
- Do not restore transient selection, hover, zoom, or panel state initially

## Platform and performance

- Current desktop Chrome and Edge are the prototype target.
- A document may contain 10,000 nodes.
- In a worst-case scene, all 10,000 nodes may be visible.
- Typical editing targets 60 frames per second.
- A 10,000-simple-node stress scene targets at least 30 frames per second.
- Pointer responsiveness has priority over background or nonessential work.

## Extension direction

Initially, trusted extensions are registered by the host at build time. They may contribute node definitions, tools, commands, shortcuts, and UI panels. Extensions use commands, queries, and events rather than mutating the store or renderer directly.

Untrusted plugins, sandbox execution, a marketplace, import/export, raster editing, animation, and real-time collaboration are deferred.
