/**
 * Candidate links: /i/<token>. The token is random and unguessable; the server stores only its hash.
 * A link can be used to join for LINK_LIFETIME_MINUTES (at most 30) after it is created.
 * Once the candidate has joined (interview started), the link keeps working for the interview's own time limit.
 */

import crypto from 'crypto';
import { getConfig } from '../config/env';
import { InterviewSessionModel } from '../database/models/InterviewSession';
import { InterviewSession } from '../types/interview.types';

export function newLinkToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashLinkToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Create a fresh token and expiry for a session. Replaces any earlier link. */
export function issueCandidateLink(sessionId: string): { token: string; expires_at: string } {
  const token = newLinkToken();
  const created = new Date();
  const expires = new Date(created.getTime() + getConfig().linkLifetimeMinutes * 60 * 1000);
  InterviewSessionModel.setCandidateLink(sessionId, {
    token_hash: hashLinkToken(token),
    created_at: created.toISOString(),
    expires_at: expires.toISOString(),
  });
  return { token, expires_at: expires.toISOString() };
}

export async function findSessionByLinkToken(token: string): Promise<InterviewSession | null> {
  if (!token || token.length > 200) return null;
  return InterviewSessionModel.findByLinkTokenHash(hashLinkToken(token));
}
