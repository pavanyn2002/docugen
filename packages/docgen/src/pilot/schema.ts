import { z } from 'zod';

export const PILOT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PILOT_MANIFEST_FILE = 'docgen.pilot.json';

export const pilotExpectationSchema = z.object({
  id: z.string().min(1),
  expected: z.boolean(),
  owner: z.string().min(1),
  note: z.string().min(1),
}).strict();

export const pilotManifestSchema = z.object({
  schemaVersion: z.literal(PILOT_MANIFEST_SCHEMA_VERSION),
  repository: z.string().min(1),
  repositoryClass: z.enum(['frontend', 'backend', 'fullstack', 'library', 'monorepo', 'other']),
  reviewStatus: z.enum(['draft', 'approved']),
  reviewedBy: z.string().min(1),
  reviewedAt: z.string().datetime({ offset: true }),
  expectations: z.object({
    technologies: z.array(pilotExpectationSchema).readonly(),
    graphGaps: z.array(pilotExpectationSchema).readonly(),
  }).strict(),
}).strict();

export type PilotManifest = z.output<typeof pilotManifestSchema>;
export type PilotExpectation = z.output<typeof pilotExpectationSchema>;
