import type { DocgenUserConfig } from './schema.js';

/**
 * Identity helper that gives target repos type-checking and autocomplete in
 * `docgen.config.ts`:
 *
 *   import { defineConfig } from '@pavanyn/docugen/config';
 *   export default defineConfig({ outDir: 'docs/generated' });
 */
export function defineConfig(config: DocgenUserConfig): DocgenUserConfig {
  return config;
}
