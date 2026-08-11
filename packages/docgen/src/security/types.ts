export type SupplyChainSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface SupplyChainComponent {
  readonly ecosystem: 'npm' | 'pypi';
  readonly name: string;
  readonly version: string;
  readonly sourceFile: string;
  readonly direct: boolean;
  readonly development: boolean;
  readonly integrity?: string;
  readonly resolved?: string;
  readonly license?: string;
}

export interface SupplyChainFinding {
  readonly id: string;
  readonly kind:
    | 'lockfile-missing'
    | 'lockfile-integrity-missing'
    | 'insecure-download'
    | 'non-registry-dependency'
    | 'install-script'
    | 'python-requirement-unpinned'
    | 'python-requirement-unhashed';
  readonly severity: SupplyChainSeverity;
  readonly message: string;
  readonly file: string;
  readonly package?: string;
}

export interface SupplyChainGap {
  readonly kind: 'unsupported-manifest' | 'unresolved-lock-entry';
  readonly message: string;
  readonly file: string;
}

export interface SupplyChainReport {
  readonly schemaVersion: 1;
  readonly components: readonly SupplyChainComponent[];
  readonly findings: readonly SupplyChainFinding[];
  readonly gaps: readonly SupplyChainGap[];
  readonly manifests: readonly string[];
  readonly lockfiles: readonly string[];
  readonly vulnerabilityCoverage: {
    readonly status: 'not-evaluated';
    readonly reason: string;
  };
}
