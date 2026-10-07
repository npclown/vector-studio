/**
 * P3.1p T01 pinned sources (docs/plans/p3-t01-extent-experiment-contract.md, "Implementation
 * details" 1): these files must stay byte-unchanged; core.ts re-implements their formulas.
 */
export const PINNED_SOURCES = {
  'tests/geometry/position-certificate/certificate.ts':
    'dea97bcda4c9fc1380a0f5895ef5eeee9ffffdfd2de7c8415ea05c16e8cc3767',
  'tests/geometry/position-certificate/wedge.ts':
    'd6d2e6b72c5c146627b61a769612b25a94a2887989db7dec6cc3d7ab513eb9cf',
  'tests/geometry/position-certificate/r3-window.ts':
    '463a4af1db59a1cbd6d73aeee436690c99d73218caa30b88467fdbc9d664a894',
  'tests/geometry/position-certificate/corpus.ts':
    '3b1ee5d2add5bbae7f0ff427285c06db6fb773d26d47707d5c01bb5b3834b311',
  'docs/evidence/p3.1m-position-certificate/report.json':
    '8bc1eb2d7cb38be6afee114a69817ac22f0d138f9a641024e39489d77b902351',
  'docs/evidence/p3.1m-r3-origin-window/report.json':
    '86089572da86480619b67e90b5be801a1cd29556029d187f0b33a636dd73f0a1',
  'docs/evidence/p3.1n-r0a-wedge/report.json':
    'a25b53af41db7b5600fcaba3d7a687e0ad4ce3f28cd191f4a7f8f34c7e3f77cc',
} as const;

/** The T01 contract and the main commit that integrated it FROZEN (PR #116). */
export const T01_CONTRACT = 'docs/plans/p3-t01-extent-experiment-contract.md';
export const T01_CONTRACT_COMMIT = '410027bae15cd6cbc2fe1235073a7e7f53ca7217';
