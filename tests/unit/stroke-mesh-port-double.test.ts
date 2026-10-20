import { createFillMeshPortDouble } from '../support/fill-mesh-port-double.js';
import { describeStrokeMeshPortConformance } from '../support/stroke-mesh-port-conformance.js';
import { createStrokeMeshPortDouble } from '../support/stroke-mesh-port-double.js';

// P3 B2 ST-A8: the shared stroke conformance suite SC01-SC22 against the test double.
describeStrokeMeshPortConformance('test double', createStrokeMeshPortDouble, {
  operationId: 'test/stroke-mesh-double',
  createFillPort: createFillMeshPortDouble,
});
