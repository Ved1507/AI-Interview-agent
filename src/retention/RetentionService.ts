/**
 * Retention Service
 * Deletes interview data once its retention deadline has passed.
 *
 * JsonStorage keeps a .backup copy on every save, and those copies also hold personal data,
 * so the purge removes them too. It deletes files directly rather than through JsonStorage.delete,
 * which would create a new .deleted copy.
 */

import fs from 'fs';
import path from 'path';
import { JsonStorage } from '../storage/JsonStorage';
import { InterviewSession } from '../types/interview.types';
import { retentionDays } from './retentionPolicy';
import { Logger } from '../utils/logger';

const logger = new Logger('RetentionService');
const DAY_MS = 24 * 60 * 60 * 1000;

function dataDirectory(): string {
  return process.env.DATA_DIRECTORY || './data/storage';
}

export class RetentionService {
  /**
   * Remove every session whose retention deadline has passed, along with its
   * scoring, report, recommendation and backup files.
   * Returns counts only, so the log holds no personal data.
   */
  static purgeExpired(now: Date = new Date()): { sessions: number; files: number } {
    const expired = JsonStorage.query<InterviewSession>('interviews', (s) => {
      // Sessions created before this policy have no retention_until; use creation + policy period
      const deadline = s.retention_until
        ? new Date(s.retention_until).getTime()
        : new Date((s as any).created_at || 0).getTime() + retentionDays() * DAY_MS;
      return deadline < now.getTime();
    });

    let files = 0;
    for (const session of expired) {
      const recommendations = JsonStorage.query<{ id: string }>(
        'recommendations',
        (r: any) => r.session_id === session.id
      ).map((r) => r.id);

      const targets: Array<[string, string]> = [
        ['interviews', session.id],
        ['scoring', session.id],
        ['reports', `report_${session.id}`],
        ...recommendations.map((id): [string, string] => ['recommendations', id]),
      ];

      for (const [collection, id] of targets) {
        files += this.removeOwnedFiles(collection, id);
      }
    }

    if (expired.length > 0) {
      logger.info('Expired interview data purged', { sessions: expired.length, files });
    }
    return { sessions: expired.length, files };
  }

  /**
   * Delete the record file and every backup belonging to this record ID.
   * Matches on the full ID so other records are never touched.
   */
  private static removeOwnedFiles(collection: string, id: string): number {
    const dir = path.join(dataDirectory(), collection);
    if (!fs.existsSync(dir)) return 0;

    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      const owned =
        name === `${id}.json` ||
        name.startsWith(`${id}.backup.`) ||
        name.startsWith(`${id}.deleted.`);
      if (owned) {
        fs.unlinkSync(path.join(dir, name));
        removed++;
      }
    }
    return removed;
  }
}
