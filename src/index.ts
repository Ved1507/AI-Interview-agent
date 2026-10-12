/**
 * Technical Interview Agent - Main Application
 * Entry point for the server
 */

import 'dotenv/config';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { getConfig } from './config/env';
import { JsonStorage } from './storage/JsonStorage';
import { Logger } from './utils/logger';
import path from 'path';
import interviewRoutes, { submitExpiredInterviews } from './api/routes/interviewRoutes';
import candidateRoutes from './api/routes/candidateRoutes';
import jobRoutes from './api/routes/jobRoutes';
import humanReviewRoutes from './api/routes/humanReviewRoutes';
import reportRoutes from './api/routes/reportRoutes';
import { RetentionService } from './retention/RetentionService';
import { requireAdmin } from './auth/adminAuth';

const logger = new Logger('App');
const app: Express = express();
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

/** Candidate paths carry the join token, so they are never logged in full */
function isCandidatePath(p: string): boolean {
  return p.startsWith('/i/') || p.startsWith('/api/v1/candidate/');
}

/**
 * Middleware
 */
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

/**
 * Request logging middleware
 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const where = isCandidatePath(req.path) ? '[candidate link]' : req.path;
    logger.debug(`${req.method} ${where} - ${res.statusCode} - ${duration}ms`);
  });

  next();
});

/**
 * Health check endpoint
 */
app.get('/health', async (req: Request, res: Response) => {
  try {
    const stats = JsonStorage.getStats();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      storage: 'json',
      storageStats: stats,
    });
  } catch (error) {
    logger.error('Health check failed', { error });
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Failed to access storage',
    });
  }
});

/**
 * Public branding for the pages (the client's name only; nothing sensitive)
 */
app.get('/api/v1/branding', (req: Request, res: Response) => {
  res.json({ client_name: getConfig().clientName || null });
});

/**
 * Static assets (CSS and JavaScript only; pages are served below)
 */
app.use(express.static(PUBLIC_DIR, { index: false }));

/**
 * Admin portal: password required
 */
app.get('/', requireAdmin, (req: Request, res: Response) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

/**
 * Candidate page: the join link. No referrer is sent, so the token is not passed to other sites.
 */
app.get('/i/:token', (req: Request, res: Response) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(PUBLIC_DIR, 'candidate.html'));
});

/**
 * API Routes
 * Candidate routes use the link token as their only credential. Everything else needs the admin password.
 */
app.use('/api/v1/candidate/:token', candidateRoutes);
app.use('/api/v1/interviews', requireAdmin, interviewRoutes);
app.use('/api/v1/jobs', requireAdmin, jobRoutes);
app.use('/api/v1/human-review', requireAdmin, humanReviewRoutes);
app.use('/api/v1/reports', requireAdmin, reportRoutes);

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    path: isCandidatePath(req.path) ? '[candidate link]' : req.path,
    method: req.method,
  });
});

/**
 * Error handler
 */
app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('Unhandled error', {
    error: error.message,
    path: isCandidatePath(req.path) ? '[candidate link]' : req.path,
  });
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : undefined,
  });
});

/**
 * Graceful shutdown
 */
async function shutdown() {
  logger.info('Shutting down gracefully...');

  try {
    logger.info('Server shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

/**
 * Start server
 */
async function start() {
  try {
    // Load configuration
    const config = getConfig();

    // Initialize JSON storage
    JsonStorage.initialize();

    // Delete interview data past its retention deadline: once at startup, then hourly
    RetentionService.purgeExpired();
    setInterval(() => RetentionService.purgeExpired(), 60 * 60 * 1000).unref();

    // Submit interviews that ran past their time limit, even if the candidate closed the page: at startup, then every minute
    submitExpiredInterviews().catch((error) => logger.error('Time limit check failed', { error }));
    setInterval(() => {
      submitExpiredInterviews().catch((error) => logger.error('Time limit check failed', { error }));
    }, 60 * 1000).unref();

    // Start server
    const server = app.listen(config.port, () => {
      logger.info(`Server started`, {
        port: config.port,
        environment: config.nodeEnv,
        storage: 'JSON',
      });
    });

    // Handle graceful shutdown
    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${config.port} is already in use`, { error });
        process.exit(1);
      } else {
        throw error;
      }
    });

  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Start the application
start();

export default app;
