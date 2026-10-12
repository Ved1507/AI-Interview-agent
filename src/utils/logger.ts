/**
 * Logger Utility
 * Structured JSON logging with levels
 */

interface LogContext {
  [key: string]: any;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Logger class for structured logging
 */
export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  /**
   * Log debug message
   */
  debug(message: string, meta?: LogContext): void {
    if (process.env.LOG_LEVEL === 'debug') {
      this.log('debug', message, meta);
    }
  }

  /**
   * Log info message
   */
  info(message: string, meta?: LogContext): void {
    this.log('info', message, meta);
  }

  /**
   * Log warning message
   */
  warn(message: string, meta?: LogContext): void {
    this.log('warn', message, meta);
  }

  /**
   * Log error message
   */
  error(message: string, meta?: LogContext): void {
    this.log('error', message, meta);
  }

  /**
   * Internal log function
   */
  private log(
    level: LogLevel,
    message: string,
    meta?: LogContext
  ): void {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      context: this.context,
      message,
      ...meta,
    };

    // Always log to console in development
    const output = JSON.stringify(logEntry);

    switch (level) {
      case 'debug':
        console.log(output);
        break;
      case 'info':
        console.log(output);
        break;
      case 'warn':
        console.warn(output);
        break;
      case 'error':
        console.error(output);
        break;
    }

    // TODO: In production, send to external logging service
  }
}
