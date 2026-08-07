import { Queue, Worker } from 'bullmq';

export const emailQueue = new Queue('email-notifications');
export const reportQueue = new Queue('nightly-reports');

new Worker('email-notifications', async (job) => { await send(job); });
