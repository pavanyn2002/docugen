import { Router } from 'express';
const router = Router();
router.get('/shared', (_request, response) => response.send('b'));
export default router;
