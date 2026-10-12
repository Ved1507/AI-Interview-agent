# Trace: from the first button click to the database record

**Scope:** the first click in the product that writes data, the admin's **"Create interview and link"** button. It covers the optional CV branch and the link step.
**Code version:** the current project. Line numbers are as of this writing and may move when the code changes.

## 0. Before you read: three facts

1. **There is no React in this project.** The pages are plain HTML and JavaScript (`public/admin.html`, `public/admin.js`). The "button" is a form submit button, and the click is handled by a JavaScript function.
2. **There is no SQL database.** The "database" is JSON files: one file per record in `data/storage/<collection>/<id>.json`. For this trace the only collection written is `interviews`.
3. **Every write rewrites the whole record file.** There are no partial updates, and no transactions. Each write is a separate operation.

---

## 1. Overview

```
Browser                       Express server                           Storage (data/storage)
-------                       --------------                           ----------------------
click #create-btn
  handleCreate()
    POST /interviews/initialize ─> requireAdmin
                                  router.post('/initialize')
                                    loadQuestionsForJob ─────────────> data/job_descriptions/*.md
                                                                       data/question_banks/*.json
                                    InterviewSessionModel.create
                                      JsonStorage.save ──────────────> interviews/<id>.json  (new)
                                    setQuestions (update) ─────────> interviews/<id>.json  (rewritten)
                                    [CV text in form?] storeCv ────> interviews/<id>.json  (rewritten)
                                    appendAudit (update) ──────────> interviews/<id>.json  (rewritten)
                              <── 201 { session_id, questions_count }
    [CV file chosen?]
    POST /interviews/:id/cv/upload ─> multer ─> extractCvText
                                    storeCv ──────────────────────> interviews/<id>.json  (rewritten)
                                    appendAudit (update) ─────────> interviews/<id>.json  (rewritten)
    createLinkFor()
    POST /interviews/:id/link ─────> requireAdmin
                                  router.post('/:sessionId/link')
                                    getById ──────────────────────> interviews/<id>.json  (read)
                                    issueCandidateLink
                                      setCandidateLink (update) ──> interviews/<id>.json  (rewritten)
                                      appendAudit (update) ───────> interviews/<id>.json  (rewritten)
                              <── 201 { url, expires_at, lifetime_minutes }
    showLink()  ── shows the URL and expiry
```

---

## 2. Step by step

### Step 1: The click

| Item | Detail |
|---|---|
| UI element | `<button type="submit" id="create-btn">Create interview and link</button>` in `public/admin.html:89` |
| Event | The form `#setup-form` fires `submit`. |
| Handler | `handleCreate(event)` in `public/admin.js:185`, registered at `admin.js:655` (`$('setup-form').addEventListener('submit', handleCreate)`) |
| Client checks | Candidate ID not empty; job selected; CV file type is PDF or DOCX and at most 5 MB (`admin.js:189-198`) |
| Side effect in the UI | The button is disabled while the request runs (`admin.js:201`). |

### Step 2: Create the session

| Item | Detail |
|---|---|
| Function | `handleCreate` calls `api('POST', '/interviews/initialize', {...})` |
| HTTP helper | `api()` in `public/admin.js:21`. It sends JSON and throws if the status is not OK. A 401 produces "The admin password is required". |
| Endpoint | `POST /api/v1/interviews/initialize` |
| Body | `{ candidate_id, job_id, mode, cv_text? }` (no consent: the candidate gives it later) |

**Server side, in order:**

| # | Layer | Function (file:line) | What it does |
|---|---|---|---|
| 2a | Body parser | `bodyParser.json({ limit: '10mb' })` (`src/index.ts:35`) | Parses the JSON body |
| 2b | Admin check | `requireAdmin` (`src/auth/adminAuth.ts:20`), mounted at `src/index.ts:102` | Reads the `Authorization: Basic` header and compares the password with `ADMIN_PASSWORD` using a constant-time comparison. Returns 401 with `WWW-Authenticate` if it fails. |
| 2c | Route | `router.post('/initialize')` (`src/api/routes/interviewRoutes.ts:129`) | Checks the required fields and mode (A, B, or C); checks the CV text length (50,000 characters). |
| 2d | Job and question bank | `loadQuestionsForJob` (`src/api/routes/jobRoutes.ts:92`) | Lists job files (`listJobFiles`, line 31), reads each with `readJob` (line 27) and `parseJobDescription` (`src/jobs/jobDescriptionFile.ts:102`), finds the job by ID, then reads its question bank `data/question_banks/<name>_questions.json`. Returns `null` for an unknown job, which gives a 400. |

**Database write 1: create the session record**

| Item | Detail |
|---|---|
| Function | `InterviewSessionModel.create` (`src/database/models/InterviewSession.ts:29`) |
| What it builds | `id` (UUID v4), `candidate_id`, `job_id`, `mode`, `status: 'initialized'`, empty `consent`, empty `questions` and `responses`, `created_at`, `updated_at`, and `retention_until` (30 days from now, from `src/retention/retentionPolicy.ts`) |
| Storage call | `JsonStorage.save('interviews', session)` (`src/storage/JsonStorage.ts:68`) |
| File written | `data/storage/interviews/<id>.json`. The file is new, so no backup is made. |

**Consent:** the admin request has no `consent` field, so `addConsent` is not called (`interviewRoutes.ts:167`).

**Database write 2: attach the questions**

| Item | Detail |
|---|---|
| Mapping | `interviewRoutes.ts:173-184`. For Mode A and B, each bank question becomes a `QuestionInstance` with ID `qi_<sessionId>_<n>`, its text, skill areas, difficulty, scoring rubric, and `generated_by_mode: 'question_bank'`. For Mode C the list is empty, because questions are generated when the interview starts. |
| Model call | `InterviewSessionModel.setQuestions` (`InterviewSession.ts:181`) |
| Storage call | `JsonStorage.update` (`JsonStorage.ts:205`), which calls `load` (line 110) and then `save` (line 68) |
| File written | `interviews/<id>.json`, rewritten. The previous version is copied to `interviews/<id>.backup.<timestamp>.json` first. |

**Optional: CV text from the form** (only if the admin pasted text into the CV box)

| Item | Detail |
|---|---|
| Function | `storeCv` (`interviewRoutes.ts:92`) |
| Steps | (1) `InterviewSessionModel.setCv` (`InterviewSession.ts:252`) saves the text; (2) `InjectionScanner.scanCv` (`src/security/InjectionScanner.ts:122`) runs the pattern rules and asks the model to classify each piece of the CV, then calls `setInjectionFlags` (`InterviewSession.ts:310`); (3) for Mode B and C only, `extractClaims` (`src/interview/cvClaims.ts:37`) asks the model for CV claims, then `setCvClaims` saves them and an audit entry is added. |
| Model calls | OpenAI, via `OpenAIService.detectInjection` and `OpenAIService.chatJson`. Mode A makes no claim-extraction call. |
| Failures | Injection-check failures are logged and do not stop the request. Claim-extraction failures are logged and recorded as `cv_claims_unavailable`. |

**Database write 3: audit entry**

| Item | Detail |
|---|---|
| Function | `InterviewSessionModel.appendAudit` (`InterviewSession.ts:262`) |
| Entry | `{ action: 'interview_initialized', user_id: 'system', details: { mode, job_id, questions } }` |
| Storage | `JsonStorage.update` → `save`. The file is rewritten and backed up again. |

**Response:** `res.status(201).json({ session_id, questions_count, estimated_duration_minutes })` (`interviewRoutes.ts:205`). The browser receives `session_id`.

### Step 3: Upload the CV file (only if a file was chosen)

| Item | Detail |
|---|---|
| Function | `handleCreate` (`admin.js:209-215`) builds a `FormData` and calls `fetch` directly, because `api()` only sends JSON. |
| Endpoint | `POST /api/v1/interviews/:sessionId/cv/upload` |
| Server steps | `requireAdmin` (index.ts:102) → multer keeps the file in memory, with a 5 MB limit (`interviewRoutes.ts`, `cvUpload`) → `extractCvText` (`src/cv/cvExtractor.ts:57`) checks the file signature, then reads text with `pdf-parse` (PDF) or `mammoth` (DOCX) → `storeCv` (same steps as above) → `appendAudit('cv_uploaded')` with the file type and size, not the name or content. |
| Database writes | Each step rewrites `interviews/<id>.json`. |
| Failure | Returns 400 (size or missing file) or 422 (unreadable file). The browser shows the message. **The session already exists at this point, with no link.** See section 4. |

### Step 4: Create the candidate link

| Item | Detail |
|---|---|
| Function | `createLinkFor(sessionId, candidateId)` (`admin.js:225`), called at `admin.js:216` |
| Endpoint | `POST /api/v1/interviews/:sessionId/link` |
| Server route | `router.post('/:sessionId/link')` (`interviewRoutes.ts:622`) |
| Route steps | (1) `InterviewSessionModel.getById` reads the record; (2) if status is not `initialized` the route returns 409; (3) `issueCandidateLink` (below); (4) `appendAudit('candidate_link_created', user_id 'admin')`; (5) returns `201` with the URL. |

**`issueCandidateLink`** (`src/invitations/candidateLink.ts:21`):

| Step | Function (line) | Result |
|---|---|---|
| Generate the token | `newLinkToken` (line 12) | `crypto.randomBytes(32)`, encoded as base64url. About 43 characters. |
| Hash the token | `hashLinkToken` (line 16) | SHA-256, hex. **Only this hash is stored.** |
| Compute expiry | inline (line 24) | now + `min(30, LINK_LIFETIME_MINUTES)` minutes |
| Store | `InterviewSessionModel.setCandidateLink` (`InterviewSession.ts:226`) → `JsonStorage.update` | `candidate_link: { token_hash, created_at, expires_at }` is written to the record. |

**Response:** `{ session_id, url: "<PUBLIC_BASE_URL>/i/<token>", expires_at, lifetime_minutes }`. **The plain token exists only in this response.** It is never written to disk.

**Browser:** `state.link` is set and `showLink()` (`admin.js:248`) shows the URL and expiry. The form is reset (`admin.js:217`).

### Step 5: What the browser does with the URL

Nothing is stored in the browser. The admin copies the URL and sends it to the candidate. The candidate's first request later looks the token up by its hash.

---

## 3. What the record looks like afterwards

Example of `data/storage/interviews/<id>.json` after a Mode A interview is created with a link and no CV (values shortened):

```json
{
  "id": "97c1d951-1304-4187-a91c-443d032e722c",
  "candidate_id": "cand-link-test",
  "job_id": "job_003_data_scientist",
  "mode": "A",
  "interviewer_id": null,
  "status": "initialized",
  "consent": { "data_storage": false, "timestamp": null },
  "candidate_link": {
    "token_hash": "3f9c…(64 hex characters)…",
    "created_at": "2026-10-11T09:00:00.000Z",
    "expires_at": "2026-10-11T09:30:00.000Z"
  },
  "questions": [
    { "id": "qi_97c1…_1", "question_id": "q_003_001", "text": "…", "order": 1,
      "skill_area": ["technical_skills"], "difficulty": "mid",
      "rubric": { "1": "…", "3": "…", "5": "…" },
      "generated_by_mode": "question_bank", "timestamp": "…" }
  ],
  "responses": [],
  "audit_trail": [
    { "action": "interview_initialized", "user_id": "system", "details": { "mode": "A", "questions": 4 } },
    { "action": "candidate_link_created", "user_id": "admin", "details": { "expires_at": "…" } }
  ],
  "retention_until": "2026-11-10T09:00:00.000Z",
  "created_at": "2026-10-11T09:00:00.000Z",
  "updated_at": "2026-10-11T09:00:00.000Z"
}
```

Points to notice:
- The token is **not** in the record. Only `token_hash` is.
- `consent` is empty until the candidate gives consent.
- `status` is `initialized` until the candidate starts the interview.

---

## 4. Writes, backups, and failure points

### Number of writes

For one click with no CV file, the server makes **five saves** to the same file:

| Save | Operation | Backup made? |
|---|---|---|
| 1 | Create the record | No (new file) |
| 2 | Attach questions | Yes |
| 3 | Initialize audit entry | Yes |
| 4 | Store the link hash | Yes |
| 5 | Link audit entry | Yes |

That leaves **four backup files** for each interview created this way. Every CV upload adds more saves and more backups. Backups are removed with the record when retention runs.

### Failure points

| Situation | What happens | Effect |
|---|---|---|
| Server stops between save 1 and save 4 | The record exists but may have no questions or no link | The list shows "No link yet". The admin can create a link for it. |
| CV upload fails after initialize | The error appears, but the session already exists with no link | If the admin clicks the button again, **a second session is created**. The first one stays in the list with no link. |
| Link creation fails | The error appears and the list is shown | The session exists with no link. "Create link" in the list fixes it. |
| Two writes at the same moment | Each write reads the whole file and writes it back, with no lock | One write can overwrite the other. Safe with one admin at a time. |

### Audit identity

Most entries record `user_id: 'system'`, including the initialize and CV-upload entries from this click. Only the link entry records `'admin'`. The system does not record which admin acted, because there are no individual admin accounts.

### Cost of listing

`GET /api/v1/interviews` reads every file in the `interviews` folder and sorts them. The candidate token lookup does the same. This is fine for a pilot, but it grows with the number of interviews.

---

## 5. Code map for this click

| Piece | File | Lines |
|---|---|---|
| Submit button | `public/admin.html` | 89 |
| Submit handler and registration | `public/admin.js` | 185, 655 |
| Client HTTP helper | `public/admin.js` | 21 |
| Link creation on the client | `public/admin.js` | 225 |
| Link screen | `public/admin.js` | 248 |
| JSON body parser | `src/index.ts` | 35 |
| Static pages and admin routes | `src/index.ts` | 79, 84, 102–105 |
| Admin password check | `src/auth/adminAuth.ts` | 20 |
| Initialize route | `src/api/routes/interviewRoutes.ts` | 129 |
| CV storage helper | `src/api/routes/interviewRoutes.ts` | 92 |
| CV upload route | `src/api/routes/interviewRoutes.ts` | 700 |
| Link route | `src/api/routes/interviewRoutes.ts` | 622 |
| Job and question-bank loader | `src/api/routes/jobRoutes.ts` | 27–36, 92 |
| Job Markdown parser | `src/jobs/jobDescriptionFile.ts` | 102 |
| Session model: create, questions, link, CV, audit | `src/database/models/InterviewSession.ts` | 29, 181, 226, 237, 252, 262, 310 |
| File storage: save, load, update, query | `src/storage/JsonStorage.ts` | 68, 110, 205, 234 |
| Link token and hash | `src/invitations/candidateLink.ts` | 12, 16, 21 |
| CV text extraction | `src/cv/cvExtractor.ts` | 57 |
| Injection scan of the CV | `src/security/InjectionScanner.ts` | 122 |
| CV claim extraction | `src/interview/cvClaims.ts` | 37 |
| Retention deadline | `src/retention/retentionPolicy.ts` | — |

---

## 6. What happens at the next click

The next click the candidate makes is **"Continue"** on the consent step. The path is:

1. `handleConsent` in `public/candidate.js` sends `POST /api/v1/candidate/<token>/consent`.
2. The candidate router's first middleware (`src/api/routes/candidateRoutes.ts`) computes the hash of the token and calls `findSessionByLinkToken` (`candidateLink.ts:33`). That calls `InterviewSessionModel.findByLinkTokenHash` (`InterviewSession.ts:237`), which reads every interview file and keeps the one with a matching hash.
3. The route checks the link state (open or expired) and the three consent fields.
4. `InterviewSessionModel.addConsent` (`InterviewSession.ts:108`) updates the record with the consent values and a timestamp, and `appendAudit('consent_recorded')` adds an entry. Both are file rewrites.

The candidate's request is served without any admin password. It is the token that identifies the session.
