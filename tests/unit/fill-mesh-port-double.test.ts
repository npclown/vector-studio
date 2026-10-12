import { describeFillMeshPortConformance } from '../support/fill-mesh-port-conformance.js';
import { createFillMeshPortDouble } from '../support/fill-mesh-port-double.js';

// P3 V2 P-C1: the shared conformance suite against the test double.
describeFillMeshPortConformance('test double', createFillMeshPortDouble);
