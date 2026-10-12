# Technical Interview Agent: Project Overview

**Status:** working prototype for a single-server pilot. Not production-ready (see [Limitations](#14-limitations-and-gaps)).
**Last updated:** October 2026.

---

## 1. Summary

The Technical Interview Agent runs the first round of a technical interview without a recruiter in the room. A candidate receives a private link, gives consent, optionally uploads a CV, and answers questions in the browser. An AI model scores the answers against the job description and the CV. The admin generates a report on request, and a human reviewer approves or overrides the AI's recommendation.

The design principle is **the AI proposes, people decide.** The model writes questions, follow-ups, scores, and narrative. Code decides what is allowed (who can access what, in what order, for how long), checks the model's output (quotes, coverage, safety), and records everything in an audit trail. Every final hiring decision is made by a named person.

## 2. Purpose and users

| User | What they do | Access |
|---|---|---|
| **Admin / recruiter** | Creates interviews and links, watches progress, generates reports, sees scores | Admin portal, protected by a shared password |
| **Reviewer / hiring manager** | Approves or overrides the AI recommendation, with a reason | Same admin portal |
| **Candidate** | Gives consent, uploads a CV, answers questions, submits | Private link only (`/i/<token>`). No account |
| **Engineering team** | Maintains the system, adds jobs and question banks | Repository and `.env` |

## 3. Features

**Interview**
- Three interview modes: standardized (A), hybrid with CV follow-ups (B), and CV-driven with generated questions (C).
- Adaptive follow-ups in Modes B and C when an answer is vague, incomplete, or contradicts a CV claim.
- CV-specific probes in Mode B, planned when the interview starts.
- Timed interview: 60 minutes from start, submitted automatically if the candidate leaves.
- Answers must arrive in order; follow-ups are placed directly after the question they follow.

**Access and consent**
- Private links: 30 minutes to join, then the interview's own time limit. A link stops working once it's replaced or the interview is submitted.
- Admin can regenerate a link before the candidate joins. A running interview can't be cut off.
- Three consent statements recorded with timestamps: AI agent runs the interview, data goes to an external AI provider, data is stored for 30 days.

**Scoring and reporting**
- Four scored dimensions with weights: technical skills (40%), domain understanding (20%), problem solving (20%), communication (10%).
- Weighted score, recommendation (strong hire, hire, hold, no hire), and a confidence level.
- Evidence quotes, verified against the candidate's own words.
- Cumulative report generated on request: executive summary, per-question assessment, CV alignment, job fit, integrity notes, method and security notes.
- Report exports: JSON, Markdown, and PDF.

**Review and governance**
- Human review queue: approve, or override with a required written reason.
- Full audit trail per interview: every step, with timestamp and actor.
- Prompt-injection detection with flags shown to the reviewer. Scores are never changed automatically.
- Data retention: deletion 30 days after the decision (or after creation if no decision), including backup copies.

**Content**
- Job descriptions in Markdown (`data/job_descriptions/*.md`), with front-matter metadata, a skills table with importance scores, and responsibilities.
- Question banks in JSON, one per job (`data/question_banks/*.json`), with per-question scoring rubrics and follow-up suggestions.
- CV input as PDF, DOCX, or pasted text. Only the extracted text is kept; the original file is discarded.

## 4. Interview modes

| | **Mode A: Standardized** | **Mode B: Hybrid** | **Mode C: CV-driven** |
|---|---|---|---|
| Main questions | Question bank, same for every candidate | Question bank, same for every candidate | 8 questions generated from the CV and job |
| CV use | Optional; not used for questions | Claims extracted and used for probes and follow-ups | Claims and CV drive question generation |
| CV probes | None | Up to 2, planned at start, for claims the bank doesn't test | Not applicable |
| Follow-ups | None | Yes | Yes |
| Comparability | Highest: identical questions | Medium: bank questions are shared, follow-ups vary | Lowest: each candidate gets different questions |
| CV required | No | Yes | Yes |

**Follow-up rules** (apply to Modes B and C):
- A very short answer (under 8 words) is treated as vague, without a model call.
- Otherwise, one model call classifies the answer as none, vague, incomplete, or contradicting. The default is none.
- A contradiction is only raised if it names a real CV claim.
- At most 3 follow-ups per main question, and at most 5 per interview.
- A follow-up answer can only trigger a contradiction check, which stops chains of probing.
- A new follow-up is dropped if its wording overlaps 60% or more with one already planned for the same question.

**Mode C generation rules:**
- The model writes exactly the configured number of questions (default 8), each with a skill area, difficulty, purpose, and a 1/3/5 scoring rubric.
- Every item is checked against the question schema, and any touching a protected topic is dropped. Near-duplicates are dropped.
- Every job skill with importance 4 or higher must be covered by at least one question. Missing skills trigger up to two repair passes.
- At least 4 valid questions are required, or the interview doesn't start.
- Claims that no question tests are recorded in the audit trail. They are not repaired.

## 5. End-to-end workflow

```
Admin                          Server                            Candidate
-----                          ------                            ---------
1. New interview  ───────────> create session (status: initialized)
                               attach bank questions (A, B)
2. Create link    ───────────> 32-byte token, stored as SHA-256 hash
                               valid 30 min (until joined)
3. Copy link ─────────────────────────────────────────────────> open /i/<token>
                                                                 consent (3 statements)
                                                                 upload or paste CV
                               extract claims (B, C)
                                                                 Start
                               start: generate questions (C),
                               status: in_progress, 60-min clock
                                                                 answer questions
                               injection-check each answer;
                               follow-up decision (B, C)
                                                                 submit (or timer submits)
                               finishSession: mark completed,
                               start scoring in background
                                                                 (tab can close)
                               scoring: injection scan,
                               4 dimensions, quotes verified,
                               weighted score, recommendation
                               status: under_review
4. Open interview,
   Generate report ──────────> ReportService: one model call
                               + deterministic checks
                               JSON / Markdown / PDF
5. Approve or override  ─────> final decision recorded,
   (with reason)               audit entry, 30-day retention starts
```

## 6. Architecture

The system is a single Node.js process. There is no separate database, queue, or worker.

```
                    +----------------------------------------------+
Browser (admin) --> |  Express app (src/index.ts)                  |
  Basic auth        |   - requireAdmin (password)                  |
                    |   - /api/v1/interviews, /jobs,               |
Browser (candidate)|     /human-review, /reports  (admin routes)  |
  /i/<token>  ----> |   - /api/v1/candidate/:token (link routes)   |
                    |   - static pages and CSS/JS                  |
                    |                                              |
                    |  Interview logic (interview/*)               |
                    |  Scoring (scoring/*)  Reports (reporting/*)  |
                    |  Security (security/*, auth/*)               |
                    |  Model client (services/OpenAIService.ts) ---+--> OpenAI API
                    |                                              |
                    |  JsonStorage (one file per record) ---------+--> data/storage/
                    |  Retention purge, time-limit check (timers) |
                    +----------------------------------------------+
```

**Request handling:**
- Admin requests pass through `requireAdmin` (HTTP Basic, shared password).
- Candidate requests go through the candidate router. It resolves the token to one session and allows only the candidate's steps. Those steps are forwarded to the same handlers the admin uses, so the interview logic exists once.
- Candidate paths are logged without the token.

**Background work** (all in memory, in the same process):
- Scoring runs after an interview is submitted.
- Retention purge runs at startup and every hour.
- Time-limit check runs at startup and every minute.

**Data flow to the model:** the CV (redacted of contact details), the job description, and the candidate's answers are sent to OpenAI. The candidate consents to this on the link.

## 7. Technology stack

### Runtime and language

| Technology | Version (from `package.json`) | Used for |
|---|---|---|
| Node.js | Tested on 22.x (`engines` says 16+) | Runtime |
| TypeScript | ^5.2.2 | Source language; compiled to `dist/` |
| Express | ^4.18.2 | HTTP server, routing, static files |
| body-parser | ^1.20.2 | JSON and form bodies (10 MB limit) |
| cors | ^2.8.5 | CORS headers |
| dotenv | ^16.3.1 | Loads `.env` at startup |
| multer | ^1.4.5-lts.1 | Multipart CV uploads, in memory, 5 MB limit |

### Document handling

| Technology | Version | Used for |
|---|---|---|
| pdf-parse | ^2.4.5 | Extracts text from text-based PDFs |
| mammoth | ^1.6.0 | Extracts text from DOCX |
| pdfkit | ^0.13.0 | Generates the PDF report |

### AI and validation

| Technology | Version | Used for |
|---|---|---|
| openai (SDK) | ^4.28.0 | Calls the chat-completions API |
| ajv | ^8.12.0 | Validates generated questions against a schema |
| uuid | ^9.0.0 | Record IDs |

### Storage

| Technology | Used for |
|---|---|
| JSON files | All records: `data/storage/<collection>/<id>.json` |

### Frontend

Plain HTML, CSS, and JavaScript. No framework, no build step, no third-party scripts.
- `public/admin.html` and `public/admin.js`: admin portal.
- `public/candidate.html` and `public/candidate.js`: candidate page.
- `public/styles.css`: shared styles, including light and dark themes.

### Removed in the cleanup

The following were declared but never used, so they were removed from `package.json`: `pg` and `@types/pg` (PostgreSQL), `axios`, `marked`, `winston`, and `supertest`. Every remaining dependency is imported by the code or used by an npm script.

### Development tools

jest and ts-jest (tests); eslint and prettier (lint and format); ts-node (`npm run dev`).

## 8. Project structure

```
draft-3/
├── src/                              TypeScript source (35 files)
│   ├── index.ts                      Entry point: routes, pages, timers, startup
│   ├── api/routes/
│   │   ├── interviewRoutes.ts        Admin interview API, finishSession, time-limit check
│   │   ├── candidateRoutes.ts        Candidate API behind the link token
│   │   ├── jobRoutes.ts              Job list, question banks
│   │   ├── humanReviewRoutes.ts      Review queue, approve, override
│   │   └── reportRoutes.ts           Report generate, JSON, Markdown, PDF
│   ├── auth/adminAuth.ts             Admin password check (HTTP Basic)
│   ├── invitations/candidateLink.ts  Link tokens, hashing, expiry
│   ├── config/env.ts                 Settings and validation
│   ├── interview/
│   │   ├── InterviewFlow.ts          Next item, follow-up placement, limits
│   │   ├── followUpEngine.ts         Follow-up decisions, writing, CV probes
│   │   ├── cvClaims.ts               Claim extraction with contact-detail redaction
│   │   └── questionGenerator.ts      Mode C question generation and checks
│   ├── scoring/ScoringEngine.ts      Four dimensions, weights, recommendation
│   ├── services/OpenAIService.ts     All model calls
│   ├── security/
│   │   ├── InjectionScanner.ts       Three-layer injection detection
│   │   └── promptData.ts             Data-block wrapping, CV length limit
│   ├── reporting/
│   │   ├── ReportService.ts          Cumulative report
│   │   ├── markdownExporter.ts       Markdown export
│   │   └── pdfExporter.ts            PDF export
│   ├── cv/cvExtractor.ts             PDF and DOCX text extraction
│   ├── jobs/jobDescriptionFile.ts    Markdown job file parser and writer
│   ├── retention/                    Retention policy and purge
│   ├── storage/JsonStorage.ts        File-based storage with backups
│   ├── database/models/              Session, scoring, recommendation models
│   ├── types/interview.types.ts      Shared types
│   └── utils/                        Logger, quote checks
├── public/                           Frontend pages, CSS
├── data/
│   ├── job_descriptions/*.md         Three jobs: Data Scientist, Frontend Engineer, Senior Backend Engineer
│   ├── question_banks/*.json         Question banks (4, 4, and 8 questions)
│   └── storage/                      Runtime records and backups (created at run time)
├── tests/                            Two jest files (not maintained; see §19)
├── docs/                             Documentation (this file)
├── .env                              Local settings and secrets (never commit)
├── package.json, package-lock.json, tsconfig.json, jest.config.js
└── README.md                         Original requirements (partly outdated)
```

## 9. Configuration

All settings are read from `.env` (loaded at startup) or the environment. The server refuses to start if `OPENAI_API_KEY` or `ADMIN_PASSWORD` is missing.

### Required

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI key for all model calls |
| `ADMIN_PASSWORD` | Shared admin password (Basic auth, any username) |

### Common

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server port |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Host used in candidate links. Must be the public HTTPS address when deployed |
| `LINK_LIFETIME_MINUTES` | `30` | How long a link can be used to join. Capped at 30 |
| `INTERVIEW_TIMEOUT_MINUTES` | `60` | Interview time limit from start |
| `OPENAI_MODEL_SCORING` | `gpt-6-luna` (in `.env`) | Model for scoring, probes, question generation, and report |
| `OPENAI_MODEL_QUICK` | `gpt-6-luna` (in `.env`) | Model for the quick checks (follow-up decisions, injection check) |

### Interview behavior

| Variable | Default | Purpose |
|---|---|---|
| `MAX_FOLLOW_UPS_PER_QUESTION` | `3` | Follow-ups per main question |
| `MAX_FOLLOW_UPS_PER_INTERVIEW` | `5` | Follow-ups per interview |
| `CV_PROBE_LIMIT` | `2` | Mode B CV probes at start |
| `GENERATED_QUESTION_COUNT` | `8` | Mode C question count |

### Storage and data

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIRECTORY` | `./data/storage` | Where records are written |
| `BACKUP_ENABLED` | `true` | Keep a backup copy on every save (also purged with retention) |
| `DATA_RETENTION_DAYS` | `30` | Retention after the decision (or after creation) |
| `LOG_LEVEL`, `NODE_ENV` | `debug`, `development` | Logging detail and environment |

### Removed settings

Settings for features that were never built (bias checks, audit and encryption switches, speech-to-text, video, storage type, monitoring, and cost tracking) were removed from `src/config/env.ts` and from `.env`. Only settings the code reads remain.

## 10. API reference

### Public

| Method and path | Purpose |
|---|---|
| `GET /health` | Health check and storage statistics |
| `GET /i/:token` | Candidate page |

### Candidate (token in the path is the only credential)

Base: `/api/v1/candidate/:token`

| Method and path | Allowed when | Purpose |
|---|---|---|
| `GET /status` | Always | Link state, expiry, interview end time, job title, mode, consent and CV flags |
| `POST /consent` | Link open | Records the three consent statements |
| `POST /cv/upload` | Link open or in progress | Uploads PDF or DOCX |
| `PUT /cv` | Link open or in progress | Saves pasted CV text |
| `POST /start` | Link open, consent given | Starts the interview; generates questions in Mode C |
| `GET /next-question` | In progress | Current question |
| `POST /submit-answer` | In progress | Records an answer |
| `POST /submit-follow-up` | In progress | Records a follow-up answer |
| `POST /complete` | In progress | Submits the interview |

Candidate responses never include scores or reports.

### Admin (requires `ADMIN_PASSWORD`)

| Method and path | Purpose |
|---|---|
| `GET /` | Admin portal |
| `GET /api/v1/interviews` | Recent interviews for the list |
| `POST /api/v1/interviews/initialize` | Create an interview session |
| `POST /api/v1/interviews/:id/link` | Create or replace the candidate link (refused after joining) |
| `POST /api/v1/interviews/:id/cv/upload` | Admin uploads a CV |
| `GET /api/v1/interviews/:id/status`, `/results` | Progress and results |
| `POST /api/v1/interviews/:id/complete` | Submit on the candidate's behalf |
| `POST /api/v1/interviews/:id/rescore` | Retry failed scoring |
| `GET /api/v1/jobs`, `/jobs/:id/questions` | Job list and question banks |
| `GET /api/v1/human-review/pending` | Review queue |
| `GET /api/v1/human-review/:id` | Full review view |
| `POST /api/v1/human-review/:id/approve` | Approve the recommendation |
| `POST /api/v1/human-review/:id/override` | Override with a reason (at least 10 characters) |
| `POST /api/v1/reports/:id/generate` | Generate the report |
| `GET /api/v1/reports/:id/json`, `/markdown`, `/pdf` | Download the report |

Admin API paths for interview operations also include the admin-side steps used by the candidate flow, which the candidate router forwards.

## 11. AI usage

Every model call goes through `src/services/OpenAIService.ts`. Each call has a purpose label recorded in the logs.

| Purpose | Model | What it receives | What it returns |
|---|---|---|---|
| Injection check (semantic) | Quick | One answer, or a piece of the CV | Whether it looks like manipulation, with confidence |
| CV claim extraction | Scoring | CV with contact details redacted | Up to 12 claims, each quoting a source sentence |
| Follow-up decision | Quick | Question, answer, claims | none, vague, incomplete, or contradicting, with a claim ID |
| Follow-up writing | Quick | Question, answer, trigger, claim | One short follow-up question |
| CV probe planning | Scoring | Planned questions and claims | Up to 2 probe questions with rubrics |
| Mode C question generation | Scoring | Job, required skills, claims, CV | 8 questions with rubrics |
| Mode C repair | Scoring | Missing skills, existing questions | Replacement questions |
| Dimension scoring | Scoring | Transcript, CV, job, scoring guides | Score (1 to 5), confidence, reasoning, quotes (one call per dimension) |
| Report narrative | Scoring | Everything, plus decided scores | Summary, strengths, gaps, per-question assessment, CV alignment, job fit |

**Prompt safety:** candidate-supplied text (CV, answers) is wrapped in tagged data blocks. Any closing tag inside the text is neutralized. The prompts state that the content is data and must not be followed.

**Model settings:** the model accepts only its default temperature, so output varies between runs. JSON output is requested for all structured calls.

## 12. Scoring

Scoring is in `src/scoring/ScoringEngine.ts`.

1. The injection scan runs first, so flags are stored before scoring.
2. The candidate-only transcript is built: each question, its answer, and any follow-up exchange.
3. Four model calls run in parallel, one per dimension. Each receives the transcript, the job, the CV (capped at 20,000 characters), and the question scoring guides.
4. Each model score (1 to 5) is converted to 0 to 100 (multiplied by 20).
5. Evidence quotes are kept only if they appear in the transcript. A dimension with no verified quote has its confidence capped at 0.5.
6. The weighted score is computed with fixed weights: 40, 20, 20, 10.
7. The recommendation follows fixed thresholds: 80 or more is strong hire, 70 or more is hire, 60 or more is hold, below 60 is no hire.
8. Confidence is High, Medium, or Low, based on how much the four dimension scores vary.

Scoring results are stored, and the session moves to `under_review`. The report is not generated automatically.

## 13. Reports and review

**The report** (`src/reporting/ReportService.ts`) is generated on request from the admin portal.
- One model call writes the narrative, with the decided scores passed in as fixed input. The model is told not to change them.
- Deterministic checks are added in code:
  - Answers under 8 words, and missing answers, are flagged and mark the evidence as insufficient.
  - Each per-question quote is checked against that question's answer.
  - Injection flags are listed, with where they came from.
  - A CV longer than 20,000 characters is noted as truncated.
- The report records its method: question source, model, rubric version, duration.
- Exports: JSON (the full record), Markdown (for reading), and PDF (for sharing).

**The review** happens in the admin portal.
- Approve: accepts the AI recommendation, with optional notes.
- Override: chooses a different level and gives a reason of at least 10 characters.
- Each decision is final for that interview. It sets the session to `finalized` and starts the 30-day retention clock.

## 14. Security and privacy

| Area | How it works |
|---|---|
| **Admin access** | One shared password from `.env`, checked with HTTP Basic authentication using a constant-time comparison. Protects the admin page and admin API |
| **Candidate access** | A 32-byte random token in the link. Only its SHA-256 hash is stored. The token maps to one session and allows only the candidate's steps |
| **Link lifetime** | 30 minutes to join (from creation). After joining, the 60-minute interview limit applies. Regenerating is refused after joining |
| **Interview time limit** | Checked on every candidate request and every minute by a timer. Expired interviews are submitted automatically |
| **Logs** | Candidate paths are logged without the token |
| **Browser** | The candidate page sends no referrer and loads no third-party scripts |
| **Consent** | Three statements, recorded with a timestamp, before the interview can start |
| **Prompt injection** | Three layers: pattern rules, a model check, and flags for the reviewer. Scores are never changed automatically |
| **PII** | Emails, phone numbers, and links are removed from the CV before claim extraction and question generation |
| **Protected topics** | Questions about age, family, health, religion, nationality, and similar are filtered out |
| **Audit trail** | Every action is recorded with a timestamp and actor. The CV content and file name are not recorded |
| **Retention** | Data is deleted 30 days after the decision, or 30 days after creation if undecided. Backups are deleted too |

## 15. Storage

- Every record is a JSON file: `data/storage/<collection>/<id>.json`.
- Collections in use: `interviews`, `scoring`, `recommendations`, `reports`.
- Each save writes a backup file (`<id>.backup.<timestamp>.json`) when backups are enabled. Backups are purged with the record.
- Writes are read-modify-write without locks. This is safe for one server process, but two writers on the same record could overwrite each other.
- The session record holds everything for one interview: consent, link hash, CV text, claims, questions, answers, follow-ups, scoring, recommendation, security flags, review, audit trail, and timestamps.

## 16. Running the project

**Prerequisites:** Node.js (tested on 22), an OpenAI API key with access to the configured models.

```bash
# 1. Install
npm install

# 2. Configure: edit .env
#    OPENAI_API_KEY=...        (required)
#    ADMIN_PASSWORD=...        (required, choose a strong one)
#    PUBLIC_BASE_URL=http://localhost:3000   (use the public HTTPS address when deployed)

# 3. Build (prints existing type errors, but still emits dist/)
npm run build

# 4. Start
npm start
```

Then:
1. Open `http://localhost:3000`, enter any username and the admin password.
2. Create a new interview, then copy the link.
3. Open the link in a private window and go through the steps.
4. Back in the admin portal, wait for scoring, then generate the report.

**Notes:**
- `npm run dev` uses ts-node on the source. It isn't the tested path; use build and start.
- The project runs on JSON files only. The PostgreSQL scripts and Docker files from the original design were removed.
- The README's Docker and PostgreSQL setup doesn't apply to this version.

## 17. Testing

| Kind | Where | Status |
|---|---|---|
| In-process checks (interview flow, Mode C generation, injection scanning, quotes, retention, follow-up limits) | Test scripts outside the repository, run against `dist/` with the model stubbed | Passing: about 100 checks |
| End-to-end API test (link lifecycle, admin protection, expiry, regeneration, time limit, report-on-request, log redaction) | Same | Passing: 33 checks |
| Time-limit timer (automatic submission, no-answer handling, no false submissions) | Same | Passing: 6 checks |
| Live model calls (scoring, report, follow-up decisions, claim extraction) | Real API | Verified manually on several interviews |
| Browser behavior of the admin and candidate pages | Manual | Checked by hand by the project owner, not automated |
| Repository tests (`npm test`) | `tests/` | **Not maintained.** Two files; not run against the current code |
| Evaluation suite | Removed | The evaluation code and its scripts were removed in the cleanup; the consistency, bias, and injection evaluations were never built |

## 18. Design decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| AI proposes, code decides, a person approves | Accountability and fairness; the model's output is checked before use | More code to maintain; slower than fully automatic |
| JSON files, not a database | Zero setup for a single-server pilot; records are readable and easy to back up | Not safe for several servers; no query engine |
| One shared admin password | Simplest possible access control for a small team | No individual accounts, no per-user audit |
| Token links instead of candidate accounts | Candidates don't need to sign up or remember credentials | Anyone with the link can use it until it expires |
| Whole CV in the prompt, not retrieval (RAG) | A CV is a few thousand characters; it fits easily | Doesn't scale to many long documents |
| Scoring in the background, report on request | The candidate doesn't wait; the admin controls when a report exists | Restart during scoring loses that job |
| Markdown for job descriptions, JSON for everything else | Job descriptions are read by people; the rest is structured data | Two formats to maintain |
| Candidate scores hidden from candidates | Avoids gaming and keeps the decision with the reviewer | Candidates get no feedback |
| Mode C questions differ per candidate | Maximum relevance to the CV | Scores are less comparable across candidates |

## 19. Limitations and gaps

**Security and access**
- One shared admin password. No individual accounts, roles, or per-admin audit.
- No rate limiting on any endpoint.
- No built-in HTTPS. A reverse proxy or hosting platform must provide it, and it's required because the admin password is sent with every request.
- Candidate links are bearer tokens. Whoever has the link can use it until it expires.

**Data and storage**
- JSON storage is single-server only, with no locking between writers.
- Background work is held in memory. A restart during scoring loses the job; the admin can retry by hand.
- No way to delete a candidate's data on request before the retention period ends.
- Backups are created on every save, so disk use grows quickly.
- The 30-day retention applies to reports and transcripts too; the consent text says so, but this should be confirmed with counsel.

**AI quality**
- Scores vary between runs for the same answers. The model doesn't allow temperature to be set, and results are not averaged.
- The follow-up decision often labels generic answers as "incomplete". A budget limits the effect, but the threshold needs tuning on real answers.
- The injection defenses are heuristic and layered, not guaranteed. The reviewer is the real safeguard.
- Mode C coverage is keyword-based, and claims that no question tests are only recorded.
- No bias testing has been built. The README describes anonymized-variant tests, but none are implemented, so fairness is a design intention, not a measured result.
- The report's CV alignment depends on the model's reading of the CV. There's no independent check.

**Candidate experience**
- Answers are typed. No speech-to-text, no video, no recording.
- No OCR: scanned PDFs are rejected.
- No email: the admin copies and sends links by hand.
- The timer checks once a minute, so submission can be up to about one minute late.

**Admin experience**
- The interview list shows the 100 most recent entries; there's no search or paging.
- No notifications when a candidate joins or submits.

**Code and maintenance**
- `npm run build` still reports TypeScript errors (style checks, missing type declarations for `uuid`, `cors`, and `pdfkit`, and unused variables in older code). The output is still produced.
- No evaluation framework exists yet. Consistency, bias, and injection evaluations are planned, not built.
- The repository's own test suite (`tests/`) isn't maintained.
- Unused dependencies and settings were removed in the cleanup. Keep it that way: check before adding anything.
- Bias checks, audit and encryption switches, speech-to-text, and video are not built, and their settings were removed.
- No JSON schema validation is applied to stored records. Validation is done in code (for example, the Markdown job parser and the question checks).
- The outdated root-level documents from the earlier design were removed. This document and the README are the current references.
- The README still describes the original design (Docker, PostgreSQL, Claude). Parts of it are out of date.
- Unused functions, methods, and types were removed in the cleanup. Some older type fields may still describe features that were never built.
- The `paused` status exists in the type but nothing sets it, since the pause button was removed.

**Security housekeeping**
- The admin password and the original OpenAI key were shown in conversation while debugging. Change the admin password, and confirm the old OpenAI key has been revoked.

## 20. Roadmap

In rough priority order:
1. Individual admin accounts with an audit of who did what.
2. A database with proper transactions, and a job queue so scoring survives restarts.
3. Averaged scoring (several runs per dimension, median used) to reduce variance.
4. Bias testing: score anonymized and name-varied copies of the same interview, and flag differences.
5. Tuning the follow-up threshold on real interview data.
6. A candidate-data deletion request, and a manual retention override.
7. Email invitations and status notifications.
8. Fixing the remaining build errors, updating the README, and adding the repository tests back into working order.

## 21. Glossary

| Term | Meaning |
|---|---|
| **Session** | One interview for one candidate: the record that holds everything |
| **Main question** | A question on the main track: from the bank (A, B) or generated (C) |
| **Follow-up** | A question placed after a main question, asked because the answer needs more |
| **CV probe** | A Mode B question about a CV claim that the bank doesn't cover |
| **Claim** | A professional statement from the CV, extracted and quoted from the redacted text |
| **Scoring guide (rubric)** | Descriptions for scores 1, 3, and 5 for one question |
| **Quote verification** | Checking that each evidence quote really appears in the candidate's words |
| **Under review** | Scoring is done; the interview is waiting for a report and a human decision |
| **Finalized** | A reviewer has approved or overridden the recommendation |
| **Link** | The private URL `/i/<token>` sent to the candidate |
| **Integrity notes** | Warnings in the report: short answers, injection flags, truncation |
| **Retention** | How long data is kept after the decision before it's deleted |
