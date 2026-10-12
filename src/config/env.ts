/**
 * Environment configuration: reads and validates the settings the application uses.
 */

interface EnvironmentConfig {
  nodeEnv: 'development' | 'staging' | 'production';

  port: number;
  /** Client company name shown to candidates and in invitations. Empty means no name is shown. */
  clientName: string;
  /** Shared admin password (HTTP Basic authentication for the admin portal and admin API) */
  adminPassword: string;
  /** Public address used in candidate links, e.g. https://interviews.example.com */
  publicBaseUrl: string;
  /** How long a candidate link can be used to join, in minutes (never more than 30) */
  linkLifetimeMinutes: number;

  openaiApiKey: string;
  openaiModelScoring: string;
  openaiModelQuick: string;

  /** Mode B and C: follow-ups per main question */
  maxFollowUpsPerQuestion: number;
  /** Across the whole interview, so follow-ups cannot grow the interview without limit */
  maxFollowUpsPerInterview: number;
  /** Mode B: extra CV-specific questions planned at the start of an interview */
  cvProbeLimit: number;
  /** Mode C: number of questions generated from the CV and job description */
  generatedQuestionCount: number;
  /** Interview time limit from start, in minutes */
  interviewTimeoutMinutes: number;

  /** Interview data is deleted this many days after the decision (or after creation) */
  dataRetentionDays: number;
}

function validateEnvironment(): EnvironmentConfig {
  const requiredVars = ['OPENAI_API_KEY', 'ADMIN_PASSWORD'];
  const missing = requiredVars.filter((variable) => !process.env[variable]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
      'Please check .env file or environment configuration.'
    );
  }

  const port = parseInt(process.env.PORT || '3000', 10);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${port}. Must be between 1 and 65535.`);
  }

  const interviewTimeoutMinutes = parseInt(process.env.INTERVIEW_TIMEOUT_MINUTES || '60', 10);
  if (interviewTimeoutMinutes < 1) {
    throw new Error('INTERVIEW_TIMEOUT_MINUTES must be at least 1');
  }

  return {
    nodeEnv: (process.env.NODE_ENV || 'development') as 'development' | 'staging' | 'production',

    port,
    clientName: (process.env.CLIENT_NAME || '').trim(),
    adminPassword: process.env.ADMIN_PASSWORD!,
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    linkLifetimeMinutes: Math.min(30, parseInt(process.env.LINK_LIFETIME_MINUTES || '30', 10)),

    openaiApiKey: process.env.OPENAI_API_KEY!,
    openaiModelScoring: process.env.OPENAI_MODEL_SCORING || 'gpt-6-luna',
    openaiModelQuick: process.env.OPENAI_MODEL_QUICK || 'gpt-6-luna',

    maxFollowUpsPerQuestion: parseInt(process.env.MAX_FOLLOW_UPS_PER_QUESTION || '3', 10),
    maxFollowUpsPerInterview: parseInt(process.env.MAX_FOLLOW_UPS_PER_INTERVIEW || '5', 10),
    cvProbeLimit: parseInt(process.env.CV_PROBE_LIMIT || '2', 10),
    generatedQuestionCount: parseInt(process.env.GENERATED_QUESTION_COUNT || '8', 10),
    interviewTimeoutMinutes,

    dataRetentionDays: parseInt(process.env.DATA_RETENTION_DAYS || '30', 10),
  };
}

let config: EnvironmentConfig | null = null;

export function getConfig(): EnvironmentConfig {
  if (!config) {
    config = validateEnvironment();
  }
  return config;
}

export type { EnvironmentConfig };
