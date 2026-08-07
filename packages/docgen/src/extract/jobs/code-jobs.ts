import type { Gap } from '../../types/core.js';
import type { JobEntry, JobKind } from '../../types/entries.js';
import { literalString, parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';

/**
 * Queue workers and scheduled tasks declared in code.
 *
 * Covers BullMQ, Bull, Agenda, node-cron, and node-schedule. Each library has a
 * different call shape but the same question behind it: what runs, on what
 * trigger. A schedule or queue name that is not a literal is reported rather
 * than approximated — "runs hourly" is a behavioural claim, and a wrong one is
 * worse than none.
 */

/** `new Worker('queue', handler)` — BullMQ. */
const WORKER_CLASSES = new Set(['Worker']);
/** `new Queue('name')` / `new Bull('name')` — declares a queue, not a consumer. */
const QUEUE_CLASSES = new Set(['Queue', 'Bull', 'QueueScheduler']);

export function parseCodeJobs(
  file: string,
  contents: string,
): { entries: readonly JobEntry[]; gaps: readonly Gap[] } {
  const source = parseSourceFile(file, contents);
  const entries: JobEntry[] = [];
  const gaps: Gap[] = [];
  /** Queues declared as producer handles, and the workers that consume them. */
  const declaredQueues = new Map<string, ReturnType<typeof positionOf>>();
  const workerQueues = new Set<string>();

  const push = (entry: JobEntry): void => {
    entries.push(entry);
  };

  const unresolved = (kindLabel: string, node: ts.Node, expression: string): void => {
    gaps.push({
      extractor: 'jobs',
      kind: 'job-trigger-not-literal',
      message:
        `A ${kindLabel} is registered with the expression '${expression.slice(0, 60)}', which docgen ` +
        'cannot resolve statically. The job exists but its trigger is unknown.',
      source: positionOf(source, node, file),
    });
  };

  walk(source, (node) => {
    // ── BullMQ / Bull: new Worker(...) and new Queue(...) ────────────────────
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const className = node.expression.text;
      const isWorker = WORKER_CLASSES.has(className);
      const isQueue = QUEUE_CLASSES.has(className);
      if (!isWorker && !isQueue) return;

      const nameArgument = node.arguments?.[0];
      if (nameArgument === undefined) return;

      const position = positionOf(source, node, file);
      const queue = literalString(nameArgument);

      if (queue === undefined) {
        unresolved(isWorker ? 'queue worker' : 'queue', node, nameArgument.getText(source));
        return;
      }

      // Only a Worker runs anything. A Queue is a producer handle: recording
      // it as a job would tell a reader that code executes where none does.
      // It is still tracked, because a queue with no worker in this repo means
      // the consumer lives in another service — worth knowing in a fleet.
      if (!isWorker) {
        declaredQueues.set(queue, position);
        return;
      }

      workerQueues.add(queue);
      push({
        id: `job:worker:${queue}`,
        source: position,
        extractionMethod: 'ast',
        certainty: 'high',
        name: queue,
        kind: 'queue-consumer',
        channel: queue,
        handler: position,
        runtime: className === 'Bull' ? 'bull' : 'bullmq',
      });
      return;
    }

    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const methodName =
      ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
    if (methodName === undefined) return;

    const position = positionOf(source, node, file);
    const first = node.arguments[0];
    const second = node.arguments[1];

    // ── node-cron: cron.schedule('*/5 * * * *', handler) ─────────────────────
    // ── node-schedule: schedule.scheduleJob('0 0 * * *', handler) ────────────
    if (methodName === 'schedule' || methodName === 'scheduleJob') {
      if (first === undefined) return;
      const runtime = methodName === 'scheduleJob' ? 'node-schedule' : 'node-cron';

      // node-schedule accepts both scheduleJob(spec, fn) and
      // scheduleJob(name, spec, fn), so the schedule is whichever argument
      // actually looks like one — not simply the first literal.
      const firstLiteral = literalString(first);
      const secondLiteral = second === undefined ? undefined : literalString(second);

      let spec: string | undefined;
      let explicitName: string | undefined;

      if (firstLiteral !== undefined && looksLikeSchedule(firstLiteral)) {
        spec = firstLiteral;
      } else if (secondLiteral !== undefined && looksLikeSchedule(secondLiteral)) {
        spec = secondLiteral;
        explicitName = firstLiteral;
      }

      if (spec === undefined) {
        // A computed schedule is a job whose trigger is unknown; a literal that
        // is not schedule-shaped means this is some other `schedule` method.
        if (firstLiteral === undefined && secondLiteral === undefined) {
          unresolved('scheduled task', node, first.getText(source));
        }
        return;
      }

      push({
        id: `job:cron:${explicitName ?? spec}:${position.line ?? 0}`,
        source: position,
        extractionMethod: 'ast',
        certainty: 'high',
        name: explicitName ?? spec,
        kind: 'cron',
        schedule: spec,
        handler: position,
        runtime,
      });
      return;
    }

    // ── Agenda: agenda.define('send digest', handler) ────────────────────────
    if (methodName === 'define' && first !== undefined) {
      const name = literalString(first);
      if (name === undefined || !isAgendaContext(contents)) return;

      push({
        id: `job:agenda:${name}`,
        source: position,
        extractionMethod: 'ast',
        certainty: 'high',
        name,
        kind: 'scheduled-task',
        handler: position,
        runtime: 'agenda',
      });
      return;
    }

    // ── Agenda: agenda.every('1 hour', 'send digest') ────────────────────────
    if (methodName === 'every' && first !== undefined && second !== undefined) {
      const interval = literalString(first);
      const name = literalString(second);
      if (interval === undefined || name === undefined || !isAgendaContext(contents)) return;

      push({
        id: `job:agenda:${name}`,
        source: position,
        extractionMethod: 'ast',
        certainty: 'high',
        name,
        kind: 'scheduled-task',
        schedule: interval,
        handler: position,
        runtime: 'agenda',
      });
      return;
    }

    // ── Bull: queue.process(handler) ─────────────────────────────────────────
    if (methodName === 'process' && ts.isPropertyAccessExpression(callee)) {
      if (!/\bBull\b|bullmq/.test(contents)) return;
      const queueVariable = ts.isIdentifier(callee.expression) ? callee.expression.text : undefined;
      if (queueVariable === undefined) return;

      push({
        id: `job:processor:${queueVariable}:${position.line ?? 0}`,
        source: position,
        extractionMethod: 'ast',
        certainty: 'high',
        name: queueVariable,
        kind: 'queue-consumer' as JobKind,
        handler: position,
        runtime: 'bull',
      });
    }
  });

  // A queue nobody consumes here is not necessarily wrong — in a microservice
  // fleet the worker usually lives in another repo — but a reader needs to be
  // told, or they will assume the messages are handled by this service.
  for (const [queue, position] of declaredQueues) {
    if (workerQueues.has(queue)) continue;
    gaps.push({
      extractor: 'jobs',
      kind: 'queue-without-local-worker',
      message:
        `Queue '${queue}' is declared here for publishing, but no worker consuming it was found in ` +
        'this repository. Its consumer is presumably another service.',
      source: position,
    });
  }

  return { entries, gaps };
}

/** Cron expressions have 5 or 6 fields; intervals read like '30 seconds'. */
function looksLikeSchedule(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length >= 5 && fields.length <= 6) return true;
  return /^\d+\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|weeks?|months?)$/i.test(
    value.trim(),
  );
}

/** `define` and `every` are common method names; require Agenda to be in scope. */
function isAgendaContext(contents: string): boolean {
  return /\bagenda\b/i.test(contents);
}
