/**
 * Admin access: one shared password, checked with HTTP Basic authentication.
 * The browser asks once and sends the password with each request. Any username is accepted.
 * Use HTTPS in deployment, because Basic authentication sends the password on every request.
 */

import crypto from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { getConfig } from '../config/env';

function digest(text: string): Buffer {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

/** Compare two passwords without leaking their length or content through timing */
function samePassword(given: string, expected: string): boolean {
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = getConfig().adminPassword;
  const header = req.headers.authorization || '';

  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const given = decoded.slice(decoded.indexOf(':') + 1);
    if (decoded.includes(':') && samePassword(given, expected)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Interview admin"');
  res.status(401).json({ error: 'Admin password required' });
}
