import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { logger } from './logger.js';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-bioaccess-token'];
  let expected: string;

  try {
    expected = config.bioaccessToken;
  } catch {
    logger.error('BIOACCESS_TOKEN not configured');
    res.status(500).json({ error: 'Service misconfigured — token not set' });
    return;
  }

  if (!token || token !== expected) {
    logger.warn('Rejected request with invalid token', { path: req.path, ip: req.ip });
    res.status(401).json({ error: 'Unauthorized', error_code: 'INVALID_TOKEN' });
    return;
  }

  next();
}
