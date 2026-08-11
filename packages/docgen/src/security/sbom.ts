import { createHash } from 'node:crypto';
import type { SupplyChainComponent, SupplyChainReport } from './types.js';

interface CycloneDxComponent {
  readonly type: 'library';
  readonly 'bom-ref': string;
  readonly name: string;
  readonly version: string;
  readonly purl: string;
  readonly scope: 'required' | 'excluded';
  readonly hashes?: readonly { readonly alg: 'SHA-512' | 'SHA-256' | 'SHA-1'; readonly content: string }[];
  readonly licenses?: readonly { readonly license: { readonly name: string } }[];
  readonly properties: readonly { readonly name: string; readonly value: string }[];
}

export interface CycloneDxBom {
  readonly bomFormat: 'CycloneDX';
  readonly specVersion: '1.6';
  readonly serialNumber: string;
  readonly version: 1;
  readonly metadata: {
    readonly tools: {
      readonly components: readonly [{ readonly type: 'application'; readonly name: 'docgen' }];
    };
  };
  readonly components: readonly CycloneDxComponent[];
}

export function buildCycloneDxBom(report: SupplyChainReport): CycloneDxBom {
  const components = report.components.map(toCycloneDxComponent);
  const identity = JSON.stringify(components);
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: `urn:uuid:${deterministicUuid(identity)}`,
    version: 1,
    metadata: { tools: { components: [{ type: 'application', name: 'docgen' }] } },
    components,
  };
}

export function serialiseCycloneDxBom(bom: CycloneDxBom): string {
  return `${JSON.stringify(bom, null, 2)}\n`;
}

function toCycloneDxComponent(component: SupplyChainComponent): CycloneDxComponent {
  const namespace = component.ecosystem === 'npm' ? 'npm' : 'pypi';
  const purl = `pkg:${namespace}/${encodePackageName(component.name)}@${encodeURIComponent(component.version)}`;
  const hash = parseIntegrity(component.integrity);
  return {
    type: 'library',
    'bom-ref': purl,
    name: component.name,
    version: component.version,
    purl,
    scope: component.development ? 'excluded' : 'required',
    ...(hash === undefined ? {} : { hashes: [hash] }),
    ...(component.license === undefined
      ? {}
      : { licenses: [{ license: { name: component.license } }] }),
    properties: [
      { name: 'docgen:ecosystem', value: component.ecosystem },
      { name: 'docgen:direct', value: String(component.direct) },
      { name: 'docgen:source-file', value: component.sourceFile },
    ],
  };
}

function encodePackageName(name: string): string {
  return name.startsWith('@') ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}` : encodeURIComponent(name);
}

function parseIntegrity(value: string | undefined): { alg: 'SHA-512' | 'SHA-256' | 'SHA-1'; content: string } | undefined {
  if (value === undefined) return undefined;
  const first = value.trim().split(/\s+/, 1)[0];
  const match = /^(sha512|sha256|sha1)-(.+)$/.exec(first ?? '');
  if (match === null) return undefined;
  const algorithms = { sha512: 'SHA-512', sha256: 'SHA-256', sha1: 'SHA-1' } as const;
  let content: string;
  try {
    content = Buffer.from(match[2] as string, 'base64').toString('hex');
  } catch {
    return undefined;
  }
  if (content.length === 0) return undefined;
  return { alg: algorithms[match[1] as keyof typeof algorithms], content };
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
