import type { ExtractorId } from '../types/core.js';

/**
 * The technologies docgen knows how to recognise.
 *
 * Recognising a technology and being able to parse it are deliberately
 * separate. `covers` lists the extractors that actually handle it today; an
 * empty list means docgen can see the technology but cannot document it, which
 * is reported to the user rather than passed over in silence.
 *
 * This is a data table on purpose. Supporting a new stack should be a matter of
 * adding a row and an extractor provider, not restructuring detection.
 */

export type TechCategory = 'language' | 'web-framework' | 'orm' | 'datastore' | 'runtime';

export interface TechSignature {
  readonly id: string;
  readonly name: string;
  readonly category: TechCategory;
  /** Dependency names that prove this technology, matched exactly. */
  readonly dependencies?: readonly string[];
  /** Repo-relative globs that prove it, for technologies without a dependency. */
  readonly files?: readonly string[];
  /** Extractors that can document this technology today. Empty means unsupported. */
  readonly covers: readonly ExtractorId[];
  /** Shown to the user when unsupported, explaining what will be missing. */
  readonly unsupportedNote?: string;
}

export const TECH_SIGNATURES: readonly TechSignature[] = Object.freeze([
  // ── web frameworks ────────────────────────────────────────────────────────
  {
    id: 'next',
    name: 'Next.js',
    category: 'web-framework',
    dependencies: ['next'],
    covers: ['routes'],
  },
  {
    id: 'react-router',
    name: 'React Router',
    category: 'web-framework',
    dependencies: ['react-router', 'react-router-dom'],
    covers: ['routes'],
  },
  {
    id: 'express',
    name: 'Express',
    category: 'web-framework',
    dependencies: ['express'],
    covers: ['endpoints'],
  },
  {
    id: 'nestjs',
    name: 'NestJS',
    category: 'web-framework',
    dependencies: ['@nestjs/core'],
    covers: ['endpoints'],
  },
  {
    id: 'fastify',
    name: 'Fastify',
    category: 'web-framework',
    dependencies: ['fastify'],
    covers: [],
    unsupportedNote: 'API endpoints are not extracted.',
  },
  {
    id: 'medusa',
    name: 'MedusaJS',
    category: 'web-framework',
    dependencies: ['@medusajs/medusa', '@medusajs/framework'],
    covers: [],
    unsupportedNote: 'Medusa module routes and entities are not extracted.',
  },
  {
    id: 'fastapi',
    name: 'FastAPI',
    category: 'web-framework',
    dependencies: ['fastapi'],
    covers: ['endpoints'],
  },
  {
    id: 'flask',
    name: 'Flask',
    category: 'web-framework',
    dependencies: ['flask'],
    covers: [],
    unsupportedNote: 'Python routes and endpoints are not extracted.',
  },
  {
    id: 'django',
    name: 'Django',
    category: 'web-framework',
    dependencies: ['django', 'Django'],
    covers: ['schema', 'endpoints'],
  },
  {
    id: 'rails',
    name: 'Ruby on Rails',
    category: 'web-framework',
    files: ['config/routes.rb'],
    covers: [],
    unsupportedNote: 'Routes, models, and jobs are not extracted.',
  },
  {
    id: 'laravel',
    name: 'Laravel',
    category: 'web-framework',
    dependencies: ['laravel/framework'],
    covers: [],
    unsupportedNote: 'Routes, Eloquent models, and jobs are not extracted.',
  },
  {
    id: 'spring-boot',
    name: 'Spring Boot',
    category: 'web-framework',
    files: ['**/SpringBootApplication.java', '**/application.properties', '**/application.yml'],
    covers: [],
    unsupportedNote: 'Controllers, JPA entities, and scheduled tasks are not extracted.',
  },

  // ── ORMs and schema sources ───────────────────────────────────────────────
  {
    id: 'mongoose',
    name: 'Mongoose',
    category: 'orm',
    dependencies: ['mongoose'],
    covers: ['schema'],
  },
  {
    id: 'prisma',
    name: 'Prisma',
    category: 'orm',
    dependencies: ['prisma', '@prisma/client'],
    covers: ['schema'],
  },
  {
    id: 'typeorm',
    name: 'TypeORM',
    category: 'orm',
    dependencies: ['typeorm'],
    covers: ['schema'],
  },
  {
    id: 'sequelize',
    name: 'Sequelize',
    category: 'orm',
    dependencies: ['sequelize', 'sequelize-typescript'],
    covers: ['schema'],
  },
  {
    id: 'sqlalchemy',
    name: 'SQLAlchemy',
    category: 'orm',
    dependencies: ['sqlalchemy', 'SQLAlchemy'],
    covers: ['schema'],
  },
  {
    id: 'mikro-orm',
    name: 'MikroORM',
    category: 'orm',
    dependencies: ['@mikro-orm/core'],
    covers: [],
    unsupportedNote: 'Entities are not extracted; the database schema will be missing.',
  },
  {
    id: 'drizzle',
    name: 'Drizzle ORM',
    category: 'orm',
    dependencies: ['drizzle-orm'],
    covers: [],
    unsupportedNote: 'Table definitions are not extracted.',
  },
  {
    id: 'knex',
    name: 'Knex',
    category: 'orm',
    dependencies: ['knex'],
    covers: [],
    unsupportedNote: 'Knex migrations are not parsed for schema.',
  },
  {
    id: 'gorm',
    name: 'GORM',
    category: 'orm',
    dependencies: ['gorm.io/gorm'],
    covers: [],
    unsupportedNote: 'Go structs are not extracted.',
  },
  {
    id: 'sql-migrations',
    name: 'SQL migrations',
    category: 'datastore',
    files: ['**/migrations/**/*.sql', '**/migration/**/*.sql', 'supabase/migrations/*.sql'],
    covers: ['schema'],
  },

  // ── datastores ────────────────────────────────────────────────────────────
  {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'datastore',
    dependencies: ['pg', 'postgres', 'psycopg2', 'psycopg2-binary', 'psycopg'],
    covers: [],
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'datastore',
    dependencies: ['mongodb', 'pymongo'],
    covers: [],
  },
  {
    id: 'redis',
    name: 'Redis',
    category: 'datastore',
    dependencies: ['redis', 'ioredis', '@upstash/redis'],
    covers: [],
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: 'datastore',
    dependencies: ['@supabase/supabase-js', 'supabase'],
    covers: [],
  },

  // ── languages and runtimes ────────────────────────────────────────────────
  { id: 'typescript', name: 'TypeScript', category: 'language', files: ['tsconfig.json'], covers: [] },
  { id: 'python', name: 'Python', category: 'language', files: ['requirements.txt', 'pyproject.toml'], covers: [] },
  { id: 'go', name: 'Go', category: 'language', files: ['go.mod'], covers: [] },
  { id: 'ruby', name: 'Ruby', category: 'language', files: ['Gemfile'], covers: [] },
  { id: 'php', name: 'PHP', category: 'language', files: ['composer.json'], covers: [] },
  { id: 'java', name: 'Java', category: 'language', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'], covers: [] },
  { id: 'rust', name: 'Rust', category: 'language', files: ['Cargo.toml'], covers: [] },
  { id: 'dart', name: 'Dart / Flutter', category: 'language', files: ['pubspec.yaml'], covers: [] },
]);
