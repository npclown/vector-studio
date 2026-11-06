export declare const GEOMETRY_FREE: readonly (string | RegExp)[];
export declare function geometryFree(file: string): boolean;
export declare function needsGeometry(files: readonly string[]): boolean;
export declare function diffArgs(base: string, head: string): string[];
