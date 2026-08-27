import { WebGpuBackend, type WebGpuSurface } from '@vector-studio/renderer-webgpu';

const app = document.querySelector<HTMLElement>('#app');

if (!app) {
  throw new Error('Playground root element is missing.');
}

const canvas = document.createElement('canvas');
canvas.id = 'webgpu-surface';
canvas.style.width = '640px';
canvas.style.height = '360px';
canvas.style.display = 'block';
app.append(canvas);

const backend = new WebGpuBackend();
const diagnostics: unknown[] = [];
backend.subscribeDiagnostics((diagnostic) => diagnostics.push(diagnostic));

const initialSurface: WebGpuSurface = {
  canvas,
  cssSize: { width: 640, height: 360 },
  devicePixelRatio: 1,
};
const capability = await backend.initialize(initialSurface);

const api = Object.freeze({
  snapshot: () => ({
    capability,
    diagnostics,
    presentationFormat: backend.presentationFormat,
    state: backend.state,
    surfaceRevision: backend.surfaceRevision,
    surfaceSize: backend.surfaceSize,
    statistics: backend.getStatistics(),
  }),
  dispose: () => backend.dispose(),
  getFrameMeasurements: () => backend.getFrameMeasurements(),
  invalidate: () => backend.invalidate({ reason: 'scene' }),
  resetFrameMeasurements: () => backend.resetFrameMeasurements(),
  resize: (width: number, height: number, devicePixelRatio: number) =>
    backend.resize({ width, height }, devicePixelRatio),
  setMode: (mode: 'on-demand' | 'continuous') => backend.setMode(mode),
});

Object.assign(globalThis, { __vectorStudioP0: api });
globalThis.dispatchEvent(new Event('vector-studio-ready'));
