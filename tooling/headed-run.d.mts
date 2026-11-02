import type { ReporterDescription } from '@playwright/test';

export declare const headedReporter: ReporterDescription[];
export declare function headedWorkers(options?: { serial?: boolean }): number;
