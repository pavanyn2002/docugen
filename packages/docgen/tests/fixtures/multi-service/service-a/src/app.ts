import express from 'express';
import apiRouter from './router.js';

const app = express();
app.get('/health', (_request, response) => response.send('ok'));
app.get('/health', (_request, response) => response.send('still ok'));
app.use('/api', apiRouter);

export default app;
