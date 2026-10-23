export const FREEZE_NOTE: string;
export const MANIFEST: string;
export const GENERATOR: string;
export const ORACLE: string;
export interface FreezeNote {
  version: string;
  frozenOn: string;
  corpusSha256: string;
  generatorSha256: string;
  oracleSha256: string;
  freezeCheck: {
    checked: number;
    ok: number;
    oracleWork: number;
    oracleUnsupported: number;
    oracleInconsistent: number;
  };
}
export interface FreezeResult {
  frozen: boolean;
  problems: string[];
  freeze: FreezeNote | null;
  manifest: {
    version: string;
    corpusSha256: string;
    cases: number;
    counts: Record<string, number>;
    generator: { path: string; sha256: string };
  } | null;
}
export function checkFreeze(root: string): FreezeResult;
