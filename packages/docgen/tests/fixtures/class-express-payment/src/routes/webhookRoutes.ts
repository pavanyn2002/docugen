import { Router } from 'express';
export const webhookRoutes = Router();

/**
 * @openapi
 * /webhooks/provider:
 *   post:
 *     summary: Provider webhook
 */
/**
 * @openapi
 * /webhooks/replay:
 *   post:
 *     summary: Replay webhook
 */
webhookRoutes.post('/webhooks/provider', receiveWebhook);
webhookRoutes.post('/webhooks/replay', replayWebhook);
