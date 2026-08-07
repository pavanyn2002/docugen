import type { Gap } from '../../types/core.js';
import type { JobEntry } from '../../types/entries.js';
import { literalString, parseSourceFile, positionOf, ts, walk } from '../../util/ts-ast.js';

/**
 * RabbitMQ consumers via amqplib.
 *
 * `channel.consume(queue, handler)` is the job: it is the code that runs when a
 * message arrives. `assertQueue` merely declares a queue and is not on its own
 * a background job, so it is not reported as one.
 *
 * Queue names are frequently held in an enum or a config object rather than
 * written inline (`QueueName.DEAD_LETTER`, `queueConfig.name`). Those are
 * recorded as gaps carrying the expression text — naming the channel after the
 * expression would put a queue in the docs that does not exist.
 */
export function parseAmqpJobs(
  file: string,
  contents: string,
): { entries: readonly JobEntry[]; gaps: readonly Gap[] } {
  const source = parseSourceFile(file, contents);
  const entries: JobEntry[] = [];
  const gaps: Gap[] = [];

  walk(source, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name)) return;
    if (callee.name.text !== 'consume') return;

    const queueArgument = node.arguments[0];
    if (queueArgument === undefined) return;

    const position = positionOf(source, node, file);
    const queue = literalString(queueArgument);

    if (queue === undefined) {
      const expression = queueArgument.getText(source).slice(0, 60);
      gaps.push({
        extractor: 'jobs',
        kind: 'queue-name-not-literal',
        message:
          `A message consumer subscribes to a queue named by the expression '${expression}', ` +
          'which docgen cannot resolve statically. The consumer exists but its queue is unknown.',
        source: position,
      });

      entries.push({
        id: `job:consumer:${file}:${position.line ?? 0}`,
        source: position,
        extractionMethod: 'ast',
        certainty: 'high',
        // Named after its location, since the queue it serves is undetermined.
        name: `consumer at ${file}:${position.line ?? 0}`,
        kind: 'queue-consumer',
        handler: position,
        runtime: 'amqplib',
      });
      return;
    }

    entries.push({
      id: `job:consumer:${queue}`,
      source: position,
      extractionMethod: 'ast',
      certainty: 'high',
      name: queue,
      kind: 'queue-consumer',
      channel: queue,
      handler: position,
      runtime: 'amqplib',
    });
  });

  return { entries, gaps };
}
