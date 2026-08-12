import { Router } from 'express';
const router = Router();
router.get('/internal/debug', debugHandler);
export default router;
