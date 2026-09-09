import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

export interface FoundationImageSample {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly expectedForeground: boolean;
}

export interface FoundationImageMetrics {
  readonly width: number;
  readonly height: number;
  readonly foregroundPixelCount: number;
  readonly foregroundBounds?: Readonly<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>;
  readonly observedVertices?: readonly number[];
  readonly samples: readonly Readonly<{
    name: string;
    x: number;
    y: number;
    expectedForeground: boolean;
    foreground: boolean;
    maxRgb: number;
    rgba: readonly number[];
  }>[];
}

export async function inspectFoundationPng(
  page: Page,
  pngPath: string,
  samples: readonly FoundationImageSample[],
): Promise<FoundationImageMetrics> {
  const pngBase64 = (await readFile(pngPath)).toString('base64');
  return page.evaluate(
    async ({ encodedPng, requestedSamples }) => {
      const binary = atob(encodedPng);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) throw new Error('A 2D canvas is required for PNG evidence analysis.');
      context.drawImage(bitmap, 0, 0);
      bitmap.close();

      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      let foregroundPixelCount = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          const offset = (y * canvas.width + x) * 4;
          const red = data[offset] ?? 0;
          const green = data[offset + 1] ?? 0;
          const blue = data[offset + 2] ?? 0;
          if (Math.max(red, green, blue) <= 80) continue;
          foregroundPixelCount += 1;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }

      const measuredSamples = requestedSamples.map((sample) => {
        if (
          !Number.isInteger(sample.x) ||
          !Number.isInteger(sample.y) ||
          sample.x < 0 ||
          sample.y < 0 ||
          sample.x >= canvas.width ||
          sample.y >= canvas.height
        ) {
          throw new RangeError(`Image sample ${sample.name} is outside the decoded PNG.`);
        }
        const offset = (sample.y * canvas.width + sample.x) * 4;
        const rgba = Object.freeze([
          data[offset] ?? 0,
          data[offset + 1] ?? 0,
          data[offset + 2] ?? 0,
          data[offset + 3] ?? 0,
        ]);
        const maxRgb = Math.max(rgba[0] ?? 0, rgba[1] ?? 0, rgba[2] ?? 0);
        return Object.freeze({
          ...sample,
          foreground: maxRgb > 80,
          maxRgb,
          rgba,
        });
      });

      const hasForeground = foregroundPixelCount > 0;
      return Object.freeze({
        width: canvas.width,
        height: canvas.height,
        foregroundPixelCount,
        ...(hasForeground
          ? {
              foregroundBounds: Object.freeze({ minX, minY, maxX, maxY }),
              observedVertices: Object.freeze([minX, minY, maxX + 1, minY, minX, maxY + 1]),
            }
          : {}),
        samples: Object.freeze(measuredSamples),
      });
    },
    { encodedPng: pngBase64, requestedSamples: samples },
  );
}
