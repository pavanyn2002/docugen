import { Router } from 'express';
const router = Router();
router.get('/relative', (_request, response) => response.send('b'));
export default router;
