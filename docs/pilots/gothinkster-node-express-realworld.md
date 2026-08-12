# Docgen pilot: gothinkster/node-express-realworld-example-app

- Upstream commit: [`30b68e1e881462b2f4164ea09ab4c4f5699c7b0b`](https://github.com/gothinkster/node-express-realworld-example-app/commit/30b68e1e881462b2f4164ea09ab4c4f5699c7b0b)
- Repository class: backend
- Review status: approved
- Reviewed by: pavanyn2002 with Codex-assisted source audit
- Reviewed at: 2026-08-12T13:00:00.000+05:30
- Graph: 191 nodes, 297 edges
- Technologies: express, prisma, sql-migrations, typescript
- Unsupported technologies: none
- Explicit graph gaps: config:env-read-never-declared, deps:import-cycle

## Human-reviewed quality

| Surface | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Technologies | 4 | 0 | 1 | 100.0% | 80.0% |
| Graph gaps | 2 | 0 | 0 | 100.0% | 100.0% |
| Overall | 6 | 0 | 1 | 100.0% | 85.7% |

The false negative is the Node.js runtime: the repository has no explicit
`engines.node` declaration, so Docugen conservatively leaves it unstated. The
pilot initially exposed a false `router-not-mounted` warning for controllers
composed through imported `Router.use()` chains. That issue was fixed before
release; endpoint tests now cover ESM, dynamic import, CommonJS, and nested
router composition, and the rerun reports no false graph gaps.

The attributed evaluation input is
[`manifests/gothinkster-node-express-realworld.json`](manifests/gothinkster-node-express-realworld.json).
