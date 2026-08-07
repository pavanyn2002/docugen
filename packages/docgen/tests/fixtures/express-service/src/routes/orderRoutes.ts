import { Router } from 'express';
import { auth } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { CreateOrderSchema } from '../schemas';

const router = Router();

/**
 * @swagger
 * /orders:
 *   get:
 *     summary: List orders
 */
router.get('/', auth, listOrders);
router.post('/', auth, validate(CreateOrderSchema), createOrder);
router.get('/:orderId', auth, getOrder);
router.delete('/:orderId', auth, deleteOrder);

export default router;
