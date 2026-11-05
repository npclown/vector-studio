// AR-U3 (alpha release plan): the packages of the alpha set, in dependency order. Every one is
// published together at `ALPHA_VERSION` (AR-Q2 (a)); `geometry-reference` (test oracle) and the
// apps are not published.
export const ALPHA_VERSION = '0.1.0-alpha.0';
export const ALPHA_PACKAGES = [
  'packages/contracts',
  'packages/model',
  'packages/editor-core',
  'packages/react',
  'packages/ui',
  'packages/renderer-core',
  'packages/renderer-webgpu',
  'packages/geometry-wasm',
  'packages/text-dom',
  'packages/persistence-idb',
  'packages/webgpu-host',
];
export const ALPHA_REGISTRY = 'https://npm.pkg.github.com';
export const ALPHA_REPOSITORY = 'https://github.com/npclown/vector-studio';
