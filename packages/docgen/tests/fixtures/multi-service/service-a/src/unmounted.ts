import { Router } from 'express';
const router = Router();
router.get('/relative', (_request, response) => response.send('a'));
export default router;
