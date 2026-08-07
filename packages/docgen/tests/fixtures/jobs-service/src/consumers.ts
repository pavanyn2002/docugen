import amqp from 'amqplib';
import { QueueName } from './constants';

export async function start(channel: amqp.Channel) {
  await channel.assertQueue('order.created');
  channel.consume('order.created', handleOrder);
  channel.consume(QueueName.DEAD_LETTER, handleDead);
}
