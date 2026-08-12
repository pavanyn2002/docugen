import { Router } from 'express';
const router = Router();

/**
 * @swagger
 * /payments:
 *   get:
 *     summary: List payments
 */
/**
 * @swagger
 * /payments:
 *   post:
 *     summary: Create payment
 */
router.get('/payments', listPayments);
router.get('/payments', duplicateListPayments);
router.post('/payments', authenticate, validate(CreatePayment), createPayment);
export default router;
