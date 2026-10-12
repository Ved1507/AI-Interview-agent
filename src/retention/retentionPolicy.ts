/**
 * Retention policy: interview data is deleted DATA_RETENTION_DAYS after the decision
 * (or after creation, if no decision is made).
 */

import { getConfig } from '../config/env';

export function retentionDays(): number {
  return getConfig().dataRetentionDays;
}

export function retentionDeadline(from: Date = new Date()): string {
  return new Date(from.getTime() + retentionDays() * 24 * 60 * 60 * 1000).toISOString();
}
