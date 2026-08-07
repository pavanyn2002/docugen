import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import axios from 'axios';
import { orderRoutes } from './routes';

export default async (app: Application): Promise<void> => {
  app.use(express.json());
  app.use(cors());

  app.get('/health', (req: Request, res: Response) => {
    // These must never be read as route registrations.
    const agent = req.get('User-Agent');
    res.set('Content-Length', '0');
    res.json({ ok: true, agent });
  });

  await axios.post('http://billing:8004/app-events', { type: 'boot' });

  app.use('/orders', orderRoutes);
};
