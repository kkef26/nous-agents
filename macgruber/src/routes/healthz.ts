import { Router } from 'express';

export const healthzRouter = Router();

healthzRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
