/**
 * Interview Agent TypeScript Type Definitions
 * Shared types for interview sessions, questions, responses, scoring and reports
 */

// ============================================================================
// JOB DESCRIPTION TYPES
// ============================================================================

export interface Skill {
  name: string;
  category: 'technical' | 'domain' | 'soft';
  level: 'fundamental' | 'intermediate' | 'advanced' | 'expert';
  importance: 1 | 2 | 3 | 4 | 5; // 1=nice-to-have, 5=critical
}

export interface Responsibility {
  title: string;
  description: string;
}

// ============================================================================
// QUESTION BANK TYPES
// ============================================================================

export interface FollowUpSuggestion {
  trigger: 'vague' | 'incomplete' | 'contradicting';
  text: string;
}

export interface ScoringRubric {
  [key: string]: string; // "1": "...", "2": "...", etc.
}

export interface Question {
  id: string;
  text: string;
  skill_area: ('technical_skills' | 'domain_understanding' | 'problem_solving' | 'communication')[];
  difficulty: 'entry' | 'junior' | 'mid' | 'senior' | 'lead';
  mode: ('A' | 'B' | 'C')[];
  follow_up_suggestions?: FollowUpSuggestion[];
  scoring_rubric?: ScoringRubric;
}

// ============================================================================
// CANDIDATE CV TYPES
// ============================================================================

export interface ExperienceEntry {
  company: string;
  title: string;
  start_year?: number;
  end_year?: number;
  duration_years: number;
  description?: string;
  achievements?: string[];
  technologies_used?: string[];
}

export interface CandidateSkill {
  name: string;
  proficiency?: 'fundamental' | 'intermediate' | 'advanced' | 'expert';
  years_of_experience?: number;
  category?: 'programming' | 'framework' | 'tool' | 'methodology' | 'domain' | 'soft_skill';
}

export interface Education {
  degree?: string;
  field_of_study?: string;
  institution?: string;
  graduation_year?: number;
  gpa?: number;
}

export interface Certification {
  name: string;
  issuer?: string;
  date?: string;
}

export interface Project {
  name: string;
  description?: string;
  technologies?: string[];
  role?: string;
  outcome?: string;
}

export interface CVLinks {
  github?: string;
  linkedin?: string;
  portfolio?: string;
}

export interface ExtractedClaim {
  claim: string;
  source: string; // CV section
  verifiable: boolean;
}

export interface ExtractionMetadata {
  source_format: 'pdf' | 'docx';
  extraction_timestamp: string;
  extraction_confidence: number; // 0-1
  manual_review_needed: boolean;
}

// ============================================================================
// INTERVIEW SESSION TYPES
// ============================================================================

export interface ConsentInfo {
  data_storage: boolean;
  /** Consent to send the CV and answers to OpenAI, an external service, for scoring and the report */
  third_party_ai?: boolean;
  /** Acknowledged that an AI agent runs the interview and a human makes the final decision */
  ai_agent_notice?: boolean;
  timestamp?: string | null;
  consent_version?: string;
}

export interface QuestionInstance {
  id: string;
  question_id: string;
  text: string;
  order: number;
  skill_area?: string[];
  difficulty?: string;
  generated_by_mode?: 'question_bank' | 'cv_driven' | 'follow_up';
  timestamp?: string;
  /** Scoring guide from the question bank (1 = weak, 5 = strong) */
  rubric?: Record<string, string>;
  /** For follow-ups: the main question this follows up on */
  parent_question_id?: string;
  /** For follow-ups: why it was asked */
  trigger?: 'vague' | 'incomplete' | 'contradicting';
  /** For generated questions: the CV claim or job requirement the question tests */
  purpose?: string;
}

export interface FollowUpResponse {
  id: string;
  /** The follow-up question text */
  text: string;
  trigger?: 'vague' | 'incomplete' | 'contradicting';
  transcript: string;
  duration_seconds: number;
  order: number;
  question_instance_id?: string;
}

export interface ResponseData {
  id: string;
  question_instance_id: string;
  transcript: string;
  duration_seconds: number;
  timestamp: string;
  follow_ups?: FollowUpResponse[];
}

export interface DimensionScore {
  score: number; // 0-100
  confidence: number; // 0-1
  evidence_quotes: string[];
  reasoning: string;
}

export interface ScoringData {
  status?: 'pending' | 'in_progress' | 'completed' | 'error';
  dimensions?: {
    technical_skills?: DimensionScore;
    domain_understanding?: DimensionScore;
    problem_solving?: DimensionScore;
    communication?: DimensionScore;
    overall_fit?: DimensionScore;
  };
  weighted_score?: number;
  scoring_timestamp?: string;
}

export interface RecommendationData {
  level: 'strong_hire' | 'hire' | 'hold' | 'no_hire';
  confidence: 'high' | 'medium' | 'low';
  reasoning?: string;
  strengths?: string[];
  growth_areas?: string[];
  timestamp?: string;
}

export interface InjectionFlag {
  response_id: string;
  pattern_matched: string;
  severity: 'low' | 'medium' | 'high';
  flagged_text: string;
  timestamp: string;
  layer?: 'pattern' | 'semantic';
  confidence?: number;
  /** Where the text came from, for the reviewer: "Question 2", "CV" or "CV (part 3 of 5)" */
  location?: string;
}

export interface HumanReviewData {
  status?: 'pending' | 'in_review' | 'approved' | 'overridden';
  reviewer_id?: string;
  original_recommendation?: 'strong_hire' | 'hire' | 'hold' | 'no_hire';
  final_recommendation?: 'strong_hire' | 'hire' | 'hold' | 'no_hire';
  override_reason?: string;
  review_timestamp?: string;
  review_notes?: string;
}

export interface AuditEntry {
  action: string;
  timestamp: string;
  user_id: string;
  details?: Record<string, any>;
}

/** A professional claim from the CV, used for Mode B follow-ups and CV probes */
export interface CvClaim {
  id: string;
  claim: string;
  skill_area: string;
  claimed_years: number | null;
  /** Exact sentence from the CV (after contact details are removed); verified against the CV text */
  source_sentence: string;
}

export interface InterviewSession {
  id: string;
  /** The candidate's join link. Only a hash of the token is stored. */
  candidate_link?: { token_hash: string; created_at: string; expires_at: string };
  cv_claims?: CvClaim[];
  candidate_id: string;
  job_id: string;
  interviewer_id?: string | null;
  mode: 'A' | 'B' | 'C';
  status: 'initialized' | 'in_progress' | 'paused' | 'completed' | 'under_review' | 'finalized';
  consent: ConsentInfo;
  questions: QuestionInstance[];
  responses: ResponseData[];
  scoring?: ScoringData;
  recommendation?: RecommendationData;
  security_flags?: {
    injection_attempts_detected?: InjectionFlag[];
  };
  human_review?: HumanReviewData;
  audit_trail?: AuditEntry[];
  candidate_cv?: { text: string; updated_at: string };
  retention_until?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string;
  total_duration_minutes?: number;
}

// ============================================================================
// FEEDBACK REPORT TYPES
// ============================================================================

export interface ExecutiveSummary {
  recommendation?: 'strong_hire' | 'hire' | 'hold' | 'no_hire';
  confidence?: 'high' | 'medium' | 'low';
  overall_score?: number;
  key_strengths?: string[];
  key_gaps?: string[];
  next_steps?: string;
}

export interface EvidenceQuote {
  quote: string;
  context?: string;
  question_number?: number;
}

export interface DimensionFeedback {
  score: number;
  confidence?: number;
  description?: string;
  evidence?: EvidenceQuote[];
  suggestions_for_improvement?: string[];
}

export interface QuestionFeedback {
  question_number: number;
  question_text: string;
  skill_areas?: string[];
  answer_quality?: 'excellent' | 'good' | 'satisfactory' | 'weak' | 'poor';
  assessment?: string;
  follow_ups_given?: number;
  follow_up_details?: Array<{
    trigger?: 'vague' | 'incomplete' | 'contradicting';
    question?: string;
    response?: string;
  }>;
}

export interface BiasCheckData {
  performed?: boolean;
  anonymized_score?: number;
  identified_score?: number;
  variance?: number;
  bias_detected?: boolean;
  notes?: string;
}

export interface SecurityNotes {
  injection_attempts_found?: boolean;
  injection_details?: Array<{
    pattern?: string;
    location?: string;
    severity?: string;
  }>;
  impact_on_scoring?: string;
}

export interface FeedbackReport {
  id: string;
  interview_session_id: string;
  candidate_id: string;
  candidate_anonymized?: boolean;
  job_id: string;
  generated_at: string;
  generated_by?: string;
  report_type?: 'executive_summary' | 'detailed_feedback' | 'full_transcript';
  executive_summary?: ExecutiveSummary;
  dimension_scores?: {
    technical_skills?: DimensionFeedback;
    domain_understanding?: DimensionFeedback;
    problem_solving?: DimensionFeedback;
    communication?: DimensionFeedback;
    overall_fit?: DimensionFeedback;
  };
  detailed_feedback?: {
    questions?: QuestionFeedback[];
  };
  full_transcript?: {
    include_in_report?: boolean;
    anonymized?: boolean;
    transcript_text?: string;
    with_timestamps?: boolean;
  };
  bias_check?: BiasCheckData;
  security_notes?: SecurityNotes;
  reviewer_notes?: string;
  approval_status?: 'draft' | 'under_review' | 'approved' | 'rejected';
  approval_timestamp?: string;
  exported_formats?: ('json' | 'pdf' | 'markdown')[];
}

// ============================================================================
// API REQUEST/RESPONSE TYPES
// ============================================================================

export interface InitializeInterviewRequest {
  candidate_id: string;
  job_id: string;
  mode: 'A' | 'B' | 'C';
  consent: ConsentInfo;
  cv_text?: string;
}

export interface InitializeInterviewResponse {
  session_id: string;
  session_token?: string;
  questions_count: number;
  estimated_duration_minutes: number;
  first_question?: QuestionInstance;
}

export interface SubmitAnswerRequest {
  question_id: string;
  transcript: string;
  duration_seconds: number;
}

export interface SubmitAnswerResponse {
  recorded: boolean;
  follow_ups_available: number;
  follow_up_question?: string;
  next_question?: QuestionInstance;
}

export interface OverrideRecommendationRequest {
  new_recommendation: 'strong_hire' | 'hire' | 'hold' | 'no_hire';
  reasoning: string;
  reviewer_id: string;
}
