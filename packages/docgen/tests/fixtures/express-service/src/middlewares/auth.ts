import { Request, Response, NextFunction } from 'express';
export function auth(req: Request, res: Response, next: NextFunction) {
  const header = req.get('Authorization');
  if (!header) return res.status(401).json({ error: 'unauthorized' });
  next();
}
