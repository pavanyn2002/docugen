import { Router } from 'express';
const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health
 */
/**
 * @openapi
 * /ready:
 *   get:
 *     summary: Ready
 */
router.get('/health', health);
router.get('/ready', ready);
export default router;
