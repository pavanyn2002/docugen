import { afterEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ calls: new Map<string, ReturnType<typeof vi.fn>>() }));
function handler(name: string) { const fn = vi.fn(async (_options: unknown) => {}); handlers.calls.set(name, fn); return fn; }
vi.mock('../src/commands/session.js', () => ({ runSessionStartCommand: handler('session start'), runSessionAfterEditCommand: handler('session after-edit'), runSessionEndCommand: handler('session end') }));
vi.mock('../src/commands/extract.js', () => ({ runExtractCommand: handler('extract') }));
vi.mock('../src/commands/report.js', () => ({ runReportCommand: handler('report') }));
vi.mock('../src/commands/bootstrap.js', () => ({ runBootstrapCommand: handler('bootstrap') }));
vi.mock('../src/commands/ask.js', () => ({ runAskCommand: handler('ask') }));
vi.mock('../src/commands/answer.js', () => ({ runAnswerCommand: handler('answer') }));
vi.mock('../src/commands/init.js', () => ({ runInitCommand: handler('init') }));
vi.mock('../src/commands/triage.js', () => ({ runTriageCommand: handler('triage') }));
vi.mock('../src/commands/sync.js', () => ({ runSyncCommand: handler('sync') }));
vi.mock('../src/commands/check.js', () => ({ runCheckCommand: handler('check') }));
vi.mock('../src/commands/trace.js', () => ({ runTraceCommand: handler('trace') }));
vi.mock('../src/commands/status.js', () => ({ runStatusCommand: handler('status') }));
vi.mock('../src/commands/fleet.js', () => ({ runFleetCommand: handler('fleet') }));
vi.mock('../src/commands/index-graph.js', () => ({ runIndexGraphCommand: handler('index') }));
vi.mock('../src/commands/impact.js', () => ({ runImpactCommand: handler('impact') }));
vi.mock('../src/commands/feature.js', () => ({ runFeatureAddCommand: handler('feature add'), runFeatureListCommand: handler('feature list'), runFeatureShowCommand: handler('feature show') }));
vi.mock('../src/commands/plan.js', () => ({ runPlanCreateCommand: handler('plan create'), runPlanListCommand: handler('plan list'), runPlanShowCommand: handler('plan show'), runPlanStatusCommand: handler('plan status') }));
vi.mock('../src/commands/handoff.js', () => ({ runHandoffCommand: handler('handoff') }));
vi.mock('../src/commands/change.js', () => ({ runChangeRecordCommand: handler('change record') }));
vi.mock('../src/commands/legacy.js', () => ({ runLegacyApproveCommand: handler('legacy approve'), runLegacyArchiveCommand: handler('legacy archive'), runLegacyClassifyCommand: handler('legacy classify'), runLegacyInventoryCommand: handler('legacy inventory'), runLegacyPlanCommand: handler('legacy plan') }));
vi.mock('../src/commands/query-graph.js', () => ({ runGraphExplainCommand: handler('explain'), runGraphPathCommand: handler('path'), runGraphSearchCommand: handler('query') }));
vi.mock('../src/mcp/server.js', () => ({ runMcpServer: handler('mcp') }));
vi.mock('../src/commands/policy.js', () => ({ runPolicyCheckCommand: handler('policy check'), runPolicyExceptionAddCommand: handler('policy exception add'), runPolicyExceptionListCommand: handler('policy exception list') }));
vi.mock('../src/commands/security.js', () => ({ runSecuritySbomCommand: handler('security sbom'), runSecurityScanCommand: handler('security scan') }));
vi.mock('../src/commands/doctor.js', () => ({ runDoctorCommand: handler('doctor') }));
vi.mock('../src/commands/migrate.js', () => ({ runMigrateCommand: handler('migrate') }));
vi.mock('../src/commands/pilot.js', () => ({ runPilotCommand: handler('pilot') }));

import { buildCli, main } from '../src/cli.js';
import { DocgenError } from '../src/util/errors.js';
import path from 'node:path';
import { checkNodeVersion } from '../src/cli.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const cases = [
  ['mcp', [], []], ['session start', [], ['--json']], ['session after-edit', [], ['--base', 'HEAD~1', '--json']], ['session end', [], ['--base', 'HEAD~1', '--strict', '--json']],
  ['index', [], ['--out', '.docgen/custom.json', '--no-symbols', '--dry-run', '--json']],
  ['query', ['needle'], ['--kinds', 'file', '--limit', '3', '--json']], ['explain', ['file:a.ts'], ['--json']],
  ['path', ['file:a.ts', 'file:b.ts'], ['--direction', 'both', '--edge-kinds', 'imports', '--max-depth', '4', '--json']],
  ['impact', [], ['--base', 'HEAD~1', '--max-depth', '2', '--limit', '3', '--json']],
  ['feature add', ['feature', '--title', 'Feature'], ['--description', 'Purpose', '--aliases', 'old', '--files', 'src/**', '--nodes', 'file:a.ts', '--owners', 'team', '--status', 'planned', '--criticality', 'high', '--json']],
  ['feature list', [], ['--json']], ['feature show', ['feature'], ['--json']],
  ['plan create', ['plan', '--feature', 'feature', '--title', 'Plan', '--summary', 'Change'], ['--status', 'approved', '--acceptance', 'Works', '--risk', 'Risk', '--test-note', 'Check', '--json']],
  ['plan list', [], ['--json']], ['plan show', ['plan'], ['--json']], ['plan status', ['plan', 'approved'], ['--note', 'Reviewed', '--json']],
  ['handoff', [], ['--base', 'HEAD~1', '--out', 'docs/handoff.md', '--max-depth', '3', '--dry-run', '--json']],
  ['change record', ['change', '--summary', 'Change', '--features', 'feature'], ['--plans', 'plan', '--kind', 'fix', '--base', 'HEAD~1', '--json']],
  ['legacy inventory', [], ['--write', '--json']], ['legacy classify', ['docs/old.md', 'current', '--reason', 'Reviewed'], ['--action', 'retain', '--replacements', 'docs/new.md', '--json']],
  ['legacy plan', [], ['--json']], ['legacy approve', ['docs/old.md', '--reason', 'Reviewed'], ['--json']], ['legacy archive', ['docs/old.md'], ['--json']],
  ['extract', [], ['--only', 'routes', '--out', 'docs/custom', '--dry-run', '--json']], ['report', [], ['--full', '--json']],
  ['bootstrap', [], ['--force', '--limit', '2', '--dry-run']], ['ask', [], ['--mine', '--surface', 'home', '--limit', '1', '--json']],
  ['answer', ['home', 'q1', 'yes'], ['--note', 'Context']], ['sync', [], ['--dry-run', '--json']],
  ['check', [], ['--base', 'HEAD', '--as-of', '2026-09-30', '--strict', '--json']], ['doctor', [], ['--fix', '--json']],
  ['migrate', [], ['--rollback', 'migration-id', '--dry-run', '--json']], ['pilot', [], ['--manifest', 'pilot.json', '--out', 'docs/pilot.md', '--json']],
  ['security scan', [], ['--strict', '--json']], ['security sbom', [], ['--out', 'docs/sbom.json', '--dry-run', '--json']],
  ['policy check', [], ['--base', 'HEAD', '--as-of', '2026-09-30', '--json']], ['policy exception list', [], ['--as-of', '2026-09-30', '--json']],
  ['policy exception add', ['exception', '--policy', 'feature-owner-required', '--owner', 'team', '--reason', 'Migration', '--expires', '2027-01-01'], ['--subject', 'feature', '--json']],
  ['triage', [], ['--list', '--json']], ['trace', [], ['--strict', '--json']], ['status', [], ['--json']], ['fleet', ['repo'], ['--out', 'fleet.md', '--json']], ['init', [], ['--all', '--hooks']],
] as const;

describe('CLI dispatch contract', () => {
  it.each(cases)('dispatches %s with defaults and explicit options', async (name, args, flags) => {
    for (const configured of [false, true]) {
      const cli = buildCli().exitOverride();
      await cli.parseAsync(['node', 'docgen', ...(configured ? ['--cwd', 'target', '--config', 'custom.json', '--verbose'] : []), ...name.split(' '), ...args, ...(configured ? flags : [])]);
      const fn = handlers.calls.get(name)!;
      expect(fn).toHaveBeenCalledOnce();
      const options = fn.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      if (name !== 'fleet') expect(options).toMatchObject({ cwd: configured ? 'target' : process.cwd() });
      if (!['fleet', 'migrate', 'pilot', 'security scan', 'security sbom'].includes(name)) {
        expect(options.configFile).toBe(configured ? 'custom.json' : undefined);
      }
      if (flags.includes('--json' as never)) expect(options.json).toBe(configured);
      fn.mockClear();
    }
  });

  it('records all triage positional arguments and its note', async () => {
    await buildCli().parseAsync(['node', 'docgen', 'triage', 'home', 'q1', 'bug', '--note', 'Reproduce']);
    expect(handlers.calls.get('triage')).toHaveBeenCalledWith(expect.objectContaining({ surface: 'home', questionId: 'q1', kind: 'bug', note: 'Reproduce' }));
  });

  it('dispatches quietly with the current directory default', async () => {
    expect(await main(['node', 'docgen', '--quiet', 'impact'])).toBe(0);
    expect(handlers.calls.get('impact')).toHaveBeenCalledWith(expect.objectContaining({ cwd: process.cwd() }));
  });

  it.each([
    new DocgenError({ code: 'test', message: 'Controlled failure', remedy: 'Repair it', file: 'input.json' }),
    new Error('Unexpected failure'), 'non-error rejection', Object.assign(new Error('No stack'), { stack: undefined }),
  ])('returns a nonzero exit for handler failures', async (error) => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    handlers.calls.get('status')!.mockRejectedValueOnce(error);
    expect(await main(['node', 'docgen', 'status'])).toBe(1);
  });

  it('rejects an unsupported runtime before invoking a command', async () => {
    const version = Object.getOwnPropertyDescriptor(process, 'version')!;
    Object.defineProperty(process, 'version', { ...version, value: 'v18.0.0' });
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try { expect(await main(['node', 'docgen', 'status'])).toBe(1); }
    finally { Object.defineProperty(process, 'version', version); }
    expect(write).toHaveBeenCalledWith(expect.stringContaining('requires Node 20.11'));
    expect(handlers.calls.get('status')).not.toHaveBeenCalled();
  });

  it('tolerates an unparseable embedding runtime version string', () => {
    expect(checkNodeVersion('unknown')).toBeUndefined();
    expect(checkNodeVersion('v20.11.0')).toBeUndefined();
    expect(checkNodeVersion('v20.10.0')).toContain('requires Node');
  });

  it('imports without self-execution when Node supplies no script path', async () => {
    const argv = process.argv;
    process.argv = [argv[0]!];
    try { vi.resetModules(); await import('../src/cli.js'); }
    finally { process.argv = argv; }
    expect(handlers.calls.get('status')).not.toHaveBeenCalled();
  });

  it.each([false, true])('self-executes the CLI and reports top-level failures (stderr failure: %s)', async (stderrFailure) => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    const version = Object.getOwnPropertyDescriptor(process, 'version')!;
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    if (stderrFailure) {
      Object.defineProperty(process, 'version', { ...version, value: 'v18.0.0' });
      write.mockImplementationOnce(() => { throw new Error('Diagnostic stream unavailable'); });
    }
    process.argv = [argv[0]!, path.resolve('src/cli.ts'), 'status'];
    try {
      vi.resetModules();
      await import('../src/cli.js');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(process.exitCode).toBe(stderrFailure ? 1 : 0);
      if (stderrFailure) expect(write).toHaveBeenLastCalledWith('Diagnostic stream unavailable\n');
      else expect(handlers.calls.get('status')).toHaveBeenCalledOnce();
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      Object.defineProperty(process, 'version', version);
    }
  });
});
