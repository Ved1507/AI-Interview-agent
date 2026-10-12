/**
 * JSON Storage Layer
 * File-based JSON storage instead of SQL database
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';

const logger = new Logger('JsonStorage');

interface StorageConfig {
  dataDirectory: string;
  prettyPrint: boolean;
  backupEnabled: boolean;
}

export class JsonStorage {
  private static config: StorageConfig = {
    dataDirectory: process.env.DATA_DIRECTORY || './data/storage',
    prettyPrint: process.env.NODE_ENV !== 'production',
    backupEnabled: process.env.BACKUP_ENABLED !== 'false',
  };

  /**
   * Initialize storage directories
   */
  static initialize(): void {
    try {
      // Create main data directory
      if (!fs.existsSync(this.config.dataDirectory)) {
        fs.mkdirSync(this.config.dataDirectory, { recursive: true });
        logger.info('Storage directory created', {
          path: this.config.dataDirectory,
        });
      }

      // Create subdirectories
      const subdirs = [
        'interviews',
        'candidates',
        'jobs',
        'questions',
        'scoring',
        'recommendations',
        'audit',
      ];

      for (const subdir of subdirs) {
        const dirPath = path.join(this.config.dataDirectory, subdir);
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath, { recursive: true });
        }
      }

      logger.info('Storage initialized', {
        dataDirectory: this.config.dataDirectory,
      });
    } catch (error) {
      logger.error('Failed to initialize storage', { error });
      throw error;
    }
  }

  /**
   * Save data to JSON file
   */
  static save<T extends { id: string }>(
    collection: string,
    data: T
  ): void {
    try {
      const filePath = path.join(
        this.config.dataDirectory,
        collection,
        `${data.id}.json`
      );

      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }

      const json = this.config.prettyPrint
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data);

      // Backup existing file
      if (this.config.backupEnabled && fs.existsSync(filePath)) {
        const backupPath = filePath.replace('.json', `.backup.${Date.now()}.json`);
        fs.copyFileSync(filePath, backupPath);
      }

      fs.writeFileSync(filePath, json, 'utf-8');

      logger.debug('Data saved', {
        collection,
        id: data.id,
        filePath,
      });
    } catch (error) {
      logger.error('Failed to save data', { error, collection });
      throw error;
    }
  }

  /**
   * Load data from JSON file
   */
  static load<T>(collection: string, id: string): T | null {
    try {
      const filePath = path.join(
        this.config.dataDirectory,
        collection,
        `${id}.json`
      );

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const json = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(json) as T;

      return data;
    } catch (error) {
      logger.error('Failed to load data', { error, collection, id });
      return null;
    }
  }

  /**
   * Load all files from a collection
   */
  static loadAll<T>(collection: string): T[] {
    try {
      const dirPath = path.join(this.config.dataDirectory, collection);

      if (!fs.existsSync(dirPath)) {
        return [];
      }

      const files = fs.readdirSync(dirPath);
      const data: T[] = [];

      for (const file of files) {
        if (file.endsWith('.json') && !file.includes('backup')) {
          const filePath = path.join(dirPath, file);
          try {
            const json = fs.readFileSync(filePath, 'utf-8');
            const item = JSON.parse(json) as T;
            data.push(item);
          } catch (error) {
            logger.warn('Failed to parse file', { file, error });
          }
        }
      }

      logger.debug('Collection loaded', {
        collection,
        count: data.length,
      });

      return data;
    } catch (error) {
      logger.error('Failed to load collection', { error, collection });
      return [];
    }
  }

  /**
   * Delete a JSON file
   */
  static delete(collection: string, id: string): boolean {
    try {
      const filePath = path.join(
        this.config.dataDirectory,
        collection,
        `${id}.json`
      );

      if (!fs.existsSync(filePath)) {
        return false;
      }

      // Backup before delete
      if (this.config.backupEnabled) {
        const backupPath = filePath.replace('.json', `.deleted.${Date.now()}.json`);
        fs.copyFileSync(filePath, backupPath);
      }

      fs.unlinkSync(filePath);

      logger.info('Data deleted', { collection, id });
      return true;
    } catch (error) {
      logger.error('Failed to delete data', { error, collection, id });
      return false;
    }
  }

  /**
   * Update specific fields in a JSON file
   */
  static update<T extends { id: string }>(
    collection: string,
    id: string,
    updates: Partial<T>
  ): T | null {
    try {
      const existing = this.load<T>(collection, id);
      if (!existing) {
        return null;
      }

      const updated = {
        ...existing,
        ...updates,
        id, // Ensure ID doesn't change
        updated_at: new Date().toISOString(),
      } as T;

      this.save(collection, updated);
      return updated;
    } catch (error) {
      logger.error('Failed to update data', { error, collection, id });
      return null;
    }
  }

  /**
   * Query data with filter function
   */
  static query<T>(
    collection: string,
    predicate: (item: T) => boolean
  ): T[] {
    try {
      const allData = this.loadAll<T>(collection);
      return allData.filter(predicate);
    } catch (error) {
      logger.error('Failed to query data', { error, collection });
      return [];
    }
  }

  /**
   * Count files in a collection
   */
  static count(collection: string): number {
    try {
      const dirPath = path.join(this.config.dataDirectory, collection);

      if (!fs.existsSync(dirPath)) {
        return 0;
      }

      const files = fs.readdirSync(dirPath);
      return files.filter(
        (f) => f.endsWith('.json') && !f.includes('backup') && !f.includes('deleted')
      ).length;
    } catch (error) {
      logger.error('Failed to count collection', { error, collection });
      return 0;
    }
  }

  /**
   * Export collection as JSON array
   */
  static exportCollection<T>(collection: string): T[] {
    return this.loadAll<T>(collection);
  }

  /**
   * Import data into collection
   */
  static importCollection<T extends { id: string }>(
    collection: string,
    items: T[]
  ): void {
    try {
      for (const item of items) {
        this.save(collection, item);
      }

      logger.info('Collection imported', {
        collection,
        count: items.length,
      });
    } catch (error) {
      logger.error('Failed to import collection', { error, collection });
      throw error;
    }
  }

  /**
   * Get statistics
   */
  static getStats(): {
    dataDirectory: string;
    collections: Record<string, number>;
    totalItems: number;
  } {
    try {
      const collections: Record<string, number> = {};
      const collectionDirs = fs.readdirSync(this.config.dataDirectory);
      let totalItems = 0;

      for (const dir of collectionDirs) {
        const dirPath = path.join(this.config.dataDirectory, dir);
        if (fs.statSync(dirPath).isDirectory()) {
          const count = this.count(dir);
          collections[dir] = count;
          totalItems += count;
        }
      }

      return {
        dataDirectory: this.config.dataDirectory,
        collections,
        totalItems,
      };
    } catch (error) {
      logger.error('Failed to get stats', { error });
      return {
        dataDirectory: this.config.dataDirectory,
        collections: {},
        totalItems: 0,
      };
    }
  }
}
