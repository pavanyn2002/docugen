import express, { type Express } from 'express';
import { config } from './config.js';
import healthRoutes from './routes/healthRoutes.js';
import paymentRoutes from './routes/paymentRoutes.js';
import { webhookRoutes } from './routes/webhookRoutes.js';

const apiPath = `/api/${config.server.apiVersion}`;

export class PaymentApp {
  private app: Express.Application;

  constructor() {
    this.app = express();
    this.initializeRoutes();
  }

  private initializeRoutes(): void {
    this.app.use(apiPath, healthRoutes);
    this.app.use(apiPath, paymentRoutes);
    this.app.use(apiPath, webhookRoutes);
    const applicationAlias = this.app;
    applicationAlias.get('/', (_request, response) => response.send('payment'));
  }
}

export class MetricsApp {
  private app: Express.Application = express();

  constructor() {
    this.app.get('/', (_request, response) => response.send('metrics'));
  }
}
