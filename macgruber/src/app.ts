import express, { type Express } from 'express';
import { circuitBreakerMiddleware } from './middleware/circuitBreaker.js';
import { healthzRouter } from './routes/healthz.js';
import { intakeRouter } from './routes/intake.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(healthzRouter);
  app.use(circuitBreakerMiddleware);
  app.use(intakeRouter);
  return app;
}
