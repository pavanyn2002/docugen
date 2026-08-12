# Docgen pilot: vercel/nextjs-postgres-auth-starter

- Upstream commit: [`fde8ecf1da9337223081f70cf88b420060039d6e`](https://github.com/vercel/nextjs-postgres-auth-starter/commit/fde8ecf1da9337223081f70cf88b420060039d6e)
- Repository class: frontend
- Review status: approved
- Reviewed by: pavanyn2002 with Codex-assisted source audit
- Reviewed at: 2026-08-12T13:00:00.000+05:30
- Graph: 71 nodes, 97 edges
- Technologies: drizzle, next, postgres, typescript
- Unsupported technologies: drizzle
- Explicit graph gaps: config:env-declared-never-read, endpoints:route-handler-no-methods

## Human-reviewed quality

| Surface | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Technologies | 4 | 0 | 1 | 100.0% | 80.0% |
| Graph gaps | 2 | 0 | 0 | 100.0% | 100.0% |
| Overall | 6 | 0 | 1 | 100.0% | 85.7% |

The false negative is the Node.js runtime: this repository has no explicit
`engines.node` declaration, and Docugen does not infer runtime solely from the
presence of JavaScript tooling. The NextAuth handler re-exports `GET` and
`POST`; v1 reports that unsupported form as an explicit gap rather than
inventing endpoint handlers. Drizzle is detected and clearly reported as an
unsupported schema source.

The attributed evaluation input is
[`manifests/vercel-nextjs-postgres-auth-starter.json`](manifests/vercel-nextjs-postgres-auth-starter.json).
