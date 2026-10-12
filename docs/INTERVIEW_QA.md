# Interview Q&A: Technical Interview Agent

Five areas: **architecture**, **implementation**, **code navigation**, **debugging**, and **system design**. For each question there's a short spoken answer, the code it refers to, and the follow-ups to expect. Practise saying the short answer out loud, then use the details if asked.

---

## 1. Architecture: why did you build it this way?

### Q1.1 Give me the architecture in one minute.

**Short answer:** One Node.js and Express server does everything: it serves two plain HTML pages, exposes an API, and runs background timers. Records are stored as JSON files, one per interview. The OpenAI API is called from one service module. The rule that shapes the design is that the AI proposes and the code decides: the model writes questions, follow-ups, dimension scores, and narrative, but the code enforces access, order, limits, quote checks, the weighted score, and the recommendation, and a person makes the final decision.

**Where:** `src/index.ts` (wiring), `src/api/routes/*` (HTTP), `src/database/models/*` (record rules), `src/storage/JsonStorage.ts` (files), `src/services/OpenAIService.ts` (all model calls), `public/*` (pages).

**Follow-ups:**
- *Why not microservices?* One team, one pilot. One process is simpler to run and debug. The modules are separated so they can be split later.
- *Why plain JavaScript on the frontend?* Few screens, no shared state across pages. A framework would add a build step without a clear gain.

### Q1.2 Why JSON files instead of a database?

**Short answer:** Zero setup, the records are readable, and backups are simple copies. The volume is small and there is one writer at a time. The costs are real and I can name them: no transactions, no locks, read-modify-write races, and listing reads every file. The next step is PostgreSQL with transactions and a job queue.

**Where:** `JsonStorage.save` (writes the whole file, copying the old one to a backup first), `update` (load, merge, save), `query` (loads every file, then filters).

**Follow-ups:**
- *What breaks first?* Two concurrent writes to one interview can overwrite each other. Listing gets slow with thousands of records. The token lookup (`findByLinkTokenHash`) reads every interview file.
- *How would you migrate?* Keep the model methods as the interface, so only the storage layer changes. Move one collection at a time.

### Q1.3 Why is the candidate side separate from the admin side?

**Short answer:** They have different trust levels. Admins are trusted staff with a password. Candidates are outsiders with only a link. So candidate routes are mounted under a token path, and every request resolves the token to exactly one session. Only a short list of steps is allowed, and each allowed step is forwarded to the same handler the admin uses. The logic exists once, and the access rules live in one place.

**Where:** `src/api/routes/candidateRoutes.ts`: the `router.use` gate (token → session → link state), the `forward(target, allowedStates)` helper, and the list of routes with their allowed states. `src/index.ts`: candidate routes are mounted before the admin-protected routes.

**Follow-ups:**
- *Why forward instead of duplicating handlers?* So a fix in the interview logic applies to both sides. The trade-off is that the forwarding rewrites the request URL, which is a little unusual and needs care.
- *What happens if someone adds an admin route to the interview router?* It stays admin-only, because the admin gate is applied when the router is mounted. A candidate can reach a route only if it is in the allowlist.

### Q1.4 Why does the AI never make the final decision?

**Short answer:** Model output varies between runs, and the model can be manipulated by the text it reads. So the code computes the weighted score and the recommendation from fixed numbers, checks every quote against the transcript, enforces the limits, and records everything. A person approves or overrides the recommendation, and the reason is kept. This makes the decision explainable and accountable.

**Where:** `ScoringEngine.generateRecommendation` (thresholds 80/70/60), `ScoringEngine.calculateWeightedScore`, `verifyQuotes`, `humanReviewRoutes.ts` (`/approve`, `/override`).

### Q1.5 Why use RAG?

**Short answer:** I didn't. A CV is a few thousand characters, so the whole CV fits in one prompt, and retrieval would only add failure modes. RAG would make sense with many long documents per candidate or a large searchable question bank.

**Where:** `ScoringEngine` passes the CV to `scoreResponseDimension` (capped at 20,000 characters by `cvForModel`). `ReportService.callModel` does the same.

---

## 2. Implementation: how does a feature actually work?

### Q2.1 Walk me through a candidate's interview, end to end.

**Short answer:** The admin creates a session and a link. The candidate opens the link, and the browser calls the status endpoint. The gate resolves the token to a session and returns the link state. The candidate gives consent, optionally uploads a CV, and starts. Starting sets the status to in-progress and starts the 60-minute clock; in Mode C it also generates the questions. For each question the candidate submits an answer. The server records it, asks the follow-up engine whether a follow-up is needed (Modes B and C), then picks the next item with `nextItem`. On submit, `finishSession` marks the interview completed and starts scoring in the background. A timer submits interviews whose time has run out.

**Where, in order:**
1. `public/candidate.js` `loadStatus` → `GET /api/v1/candidate/:token/status` → `candidateRoutes.ts` `router.use` gate → `findSessionByLinkToken` (`src/invitations/candidateLink.ts`) → `linkState`.
2. `handleConsent` → `POST .../consent` → `InterviewSessionModel.addConsent`.
3. `handleStart` → `POST .../start` (forwarded to `interviewRoutes.ts` `router.post('/:sessionId/start')`) → `generateInterviewQuestions` in Mode C → `InterviewSessionModel.start`.
4. `handleAnswer` → `POST .../submit-answer` → `InterviewSessionModel.addResponse` → `planNextFollowUp` (`followUpEngine.ts`) → `nextItem` (`InterviewFlow.ts`).
5. `handleFinish` → `POST .../complete` → `finishSession` → `runScoring` → `ScoringEngine.scoreInterview`.

**Follow-ups:**
- *What if the candidate reloads the page?* The state comes from the server: `loadStatus` reads the session and resumes the right step. Nothing is kept in the browser.
- *What if the server restarts during an interview?* The state is in the session file, so the candidate continues from the same link. A restart during scoring loses that background job, and the admin retries.

### Q2.2 How does the follow-up decision work?

**Short answer:** It's a two-step decision. If the answer has under 8 words, it's treated as vague, with no model call. Otherwise one model call classifies the answer as none, vague, incomplete, or contradicting. A contradiction must name a real CV claim, or it's ignored. Follow-up answers can only trigger contradiction checks, which stops chains. There are limits: 3 per question and 5 per interview, both checked before any call. A new follow-up is dropped if it's too similar to one already planned.

**Where:** `followUpEngine.ts`: `planNextFollowUp` (gates and orchestration), `decideTrigger` (the model call and its validation), `writeFollowUp` (generates the question and checks it with `isSafeQuestion`), `similarity` (word-overlap score, threshold 0.6). `InterviewFlow.ts`: `planFollowUp` (places the follow-up after its parent or after the last follow-up).

**Follow-ups:**
- *Why not let the model decide everything?* It over-triggers on generic answers, and it costs money. The rules handle the cheap cases.
- *What if the model is down?* The decision function throws, `planNextFollowUp` catches it, logs `follow_up_check_unavailable` in the audit trail, and returns null. The interview continues.

### Q2.3 How is the score produced?

**Short answer:** The injection scanner runs first. Then four model calls run in parallel, one per dimension, each returning a 1–5 score, a confidence, reasoning, and quotes. The code converts each score to 0–100, keeps only quotes that appear in the candidate's own words, caps the confidence of a dimension with no verified quote at 0.5, and computes the weighted score with fixed weights (40/20/20/10). The recommendation comes from fixed thresholds, and the confidence from the spread of the four scores.

**Where:** `ScoringEngine.scoreInterview`. Constants: `DIMENSION_WEIGHTS`. Helpers: `getRubricForDimension`, `buildTranscript`, `buildQuestionGuide`, `calculateWeightedScore`, `generateRecommendation`, `calculateConfidence`. Model call: `OpenAIService.scoreResponseDimension`.

**Follow-ups:**
- *Why is the transcript separate from the guides?* Quotes are checked against the transcript. If the scoring guides were in the transcript, the model could quote a guide and pass the check. So guides are sent separately.
- *Why does the same answer score differently across runs?* The model accepts only its default temperature, so output varies. The fix (not built yet) is to score several times and take the median.

### Q2.4 How does the report get generated?

**Short answer:** The admin clicks "Generate report". `ReportService.generate` checks the scoring finished, then makes one model call for the narrative with the decided scores passed in as fixed input. Then code adds checks the model can't override: answers under 8 words and missing answers are flagged and make the evidence insufficient; each per-question quote is checked against that question's answer; injection flags are listed with their location; a truncated CV is noted. The result is stored, and the JSON, Markdown, and PDF exports are rendered from it.

**Where:** `reporting/ReportService.ts`: `generate`, `callModel`, `assemble`, `decorate` (approval status follows the human decision), `get`. Exports: `markdownExporter.ts`, `pdfExporter.ts`. Routes: `reportRoutes.ts`.

### Q2.5 How does the link work?

**Short answer:** When the link is created, the server generates 32 random bytes, encodes them as base64url, and stores only the SHA-256 hash in the session. The plain token is returned once, in the URL. Each candidate request hashes the token it receives and looks for the session with that hash. The link is valid for 30 minutes from creation until the candidate joins. After joining, the 60-minute interview limit applies. Regenerating is refused after joining.

**Where:** `invitations/candidateLink.ts`: `newLinkToken`, `hashLinkToken`, `issueCandidateLink`, `findSessionByLinkToken`. `interviewRoutes.ts` `router.post('/:sessionId/link')`. `candidateRoutes.ts` `linkState`.

**Follow-ups:**
- *Why hash the token?* If the data file leaks, the attacker gets hashes, not working links.
- *What if someone guesses a token?* 256 bits of randomness can't be guessed in practice. There's no rate limit, which is a gap I'd close.

### Q2.6 How are CVs handled?

**Short answer:** The uploaded file is checked by its signature bytes, not its extension. A PDF or DOCX is converted to text, and only the text is stored. The text goes through the injection scanner in chunks. In Modes B and C, contact details are removed and the model extracts claims, and every claim must quote a sentence that appears in the redacted CV, so a claim can't be invented. The model sees at most 20,000 characters of the CV.

**Where:** `cv/cvExtractor.ts`: `detectCvType`, `extractCvText`, `pdfText`. `interviewRoutes.ts`: `storeCv`, `router.post('/:sessionId/cv/upload')`. `interview/cvClaims.ts`: `redactContactDetails`, `extractClaims`. `security/InjectionScanner.ts`: `scanCv`.

### Q2.7 How does Mode C generate questions?

**Short answer:** The model writes the configured number of questions, each with a skill area, difficulty, purpose, and a 1/3/5 rubric. Each item is checked against a schema with ajv and against a protected-topic filter, and near-duplicates are dropped. Then the code checks coverage: every job skill with importance 4 or higher must be covered by at least one question, judged by keywords. Missing skills trigger up to two repair passes. The final set keeps one question per uncovered skill first. If fewer than four valid questions remain, the interview doesn't start.

**Where:** `interview/questionGenerator.ts`: `generateInterviewQuestions`, `isValidGeneratedQuestion`, `skillCovered`, `selectFinal`. Triggered from `candidateRoutes.ts` → `interviewRoutes.ts` `router.post('/:sessionId/start')`.

---

## 3. Code navigation: which files would you change for a new requirement?

Give the change as a list of files, in the order you'd edit them, and say why. This is what interviewers want to see.

### Q3.1 Add a new settings value, for example a maximum number of CV probes per candidate.

1. `src/config/env.ts`: add the field to the interface, read it in `validateEnvironment` with a default.
2. `.env`: add the variable with its value.
3. The file that uses it, for example `src/interview/followUpEngine.ts` `planCvProbes`, reading it through `getConfig()`.

**Why this order:** the config file is the only place that reads environment variables, so the rest of the code uses typed values from `getConfig()`.

### Q3.2 Add a new scoring dimension, for example "Leadership".

1. `src/scoring/ScoringEngine.ts`: add it to `DIMENSION_WEIGHTS`, to the `dimensions` array in `scoreInterview`, and to `getRubricForDimension`. Adjust the weights so they still sum to 1.
2. `src/types/interview.types.ts`: add the key to `ScoringData.dimensions`.
3. `src/reporting/markdownExporter.ts` and `pdfExporter.ts`: add labels to their dimension maps.
4. `src/reporting/ReportService.ts`: the dimension scores are copied generically, so check the `FeedbackReport` type.
5. `public/admin.js`: add a label to `DIMENSION_LABELS`.

**Follow-up:** *Is that all?* The stored records keep whatever keys they were given, so existing interviews will show only the dimensions they were scored with. Mention that old records need no migration.

### Q3.3 Add a new candidate step, for example a short "availability" question before the interview starts.

1. `src/api/routes/candidateRoutes.ts`: add a route with `forward` or a custom handler, and list the link states it's allowed in. Without this, the step is refused.
2. `src/database/models/InterviewSession.ts`: add a method to store the answer.
3. `src/types/interview.types.ts`: add the field to `InterviewSession`.
4. `public/candidate.html` and `public/candidate.js`: add the view, and add a step to the `loadStatus` switch.
5. `src/api/routes/candidateRoutes.ts` `/status`: return whatever the page needs to decide.

**Why this matters:** the candidate router is an allowlist, so a new step is closed by default. That's on purpose.

### Q3.4 Add a new interview mode.

1. `src/types/interview.types.ts`: add the letter to the `mode` type.
2. `src/api/routes/interviewRoutes.ts` `router.post('/initialize')`: accept it, and decide where its questions come from.
3. `src/interview/questionGenerator.ts` or a new module: produce the questions if they're generated.
4. `src/interview/followUpEngine.ts`: decide whether follow-ups apply (`planNextFollowUp` checks the mode).
5. `src/reporting/ReportService.ts`: add a `QUESTION_SOURCE` entry, so the report states where the questions came from.
6. `public/admin.html` and `public/admin.js`: add the radio button and the notice text.

### Q3.5 Change the link lifetime.

`LINK_LIFETIME_MINUTES` in `.env`. The cap of 30 is in `src/config/env.ts` (`Math.min(30, …)`). The expiry is computed in `src/invitations/candidateLink.ts` `issueCandidateLink`, and checked in `src/api/routes/candidateRoutes.ts` `linkState`. Change the cap there if the business rule changes.

### Q3.6 Add a new admin page or action.

1. Backend: add a route file, or a route in an existing one, and mount it behind `requireAdmin` in `src/index.ts`.
2. `public/admin.html`: add the view and the button.
3. `public/admin.js`: add the handler, using `api()` for the request and `show()` for the view.

**Gotcha to mention:** every admin API needs the `requireAdmin` mount in `src/index.ts`. Forgetting it leaves the route open.

### Q3.7 Find where a particular behaviour lives.

Use the search tool for the message text or the audit action name. Every important action writes an audit entry with a name such as `scoring_failed`, `follow_up_planned`, or `candidate_link_created`. Searching for the name finds the code that does it and the test that checks it. Then read `docs/TRACE_FIRST_CLICK.md` for an example path, and `docs/PROJECT_OVERVIEW.md` for the map.

---

## 4. Debugging: how would you investigate and fix an issue?

Give a method, not just a guess. Say: reproduce, read the evidence, narrow down, fix, check. Then give an example. The evidence in this system is in three places: the **audit trail** inside the session record, the **server log** (JSON lines printed to the console), and the **session file itself** in `data/storage/interviews/`.

### Q4.1 How do you investigate a bug in general?

1. **Reproduce.** Use the same mode, job, and steps, through the API if possible.
2. **Read the evidence.** Check the session's status and audit trail first. They show what happened and in what order. Then check the server log for the time of the event.
3. **Narrow down.** Find the first wrong value, then find the code that wrote it. The audit action names point straight to the function.
4. **Fix at the root.** Change the function that produces the wrong value, not the page that shows it.
5. **Check.** Re-run the relevant test, then the end-to-end test, and check the logs for new errors.

### Q4.2 A candidate says "This link is not valid" but the admin says the link was sent.

**Investigate:**
- Did the admin regenerate the link after sending it? The old token stops working, which is intended. Check the session's `candidate_link.created_at`.
- Did the candidate copy the whole URL? Check the `/i/` prefix and the token length.
- Is the server running on the address in `PUBLIC_BASE_URL`? A link built for `localhost` won't work on another machine.
- Check the server log: `GET /i/...` requests log as `[candidate link]` with the status code.

**Likely fix:** usually operational (the wrong link or the wrong address), not a code bug. If the link was regenerated, the admin sends the new one.

### Q4.3 A candidate's interview shows "This link has expired" straight after they consented.

**Investigate:**
- Consent doesn't reset the window, so check when the link was created (`candidate_link.created_at`). The 30 minutes start at creation.
- The server and the candidate's clock may disagree. The countdown comes from the server's `expires_at`, so check the value in the status response.
- If the candidate had joined before the window ended, the link state is `in_progress`, not expired. Check `status` in the session.

### Q4.4 Scoring failed.

**Investigate:**
- The session shows `scoring_status: error`. Read the audit entry `scoring_failed`, which holds the message from the model call. In practice this has been an invalid key (401), an unsupported parameter (400), or no credits (429).
- Check the server log for the same time: the `OpenAIService` entries show the status and the error code.
- An interview with no answers is also recorded as a scoring error, with the message "No answers were recorded". That's not an API problem.

**Fix:** correct the cause (key, parameter, billing), then use "Retry scoring". The retry route is `POST /interviews/:id/rescore`, and it refuses interviews with no answers.

**Follow-up:** *How did you find the unsupported parameter?* The error message named it (`max_tokens` should be `max_completion_tokens`), and the fix was in `OpenAIService.ts`.

### Q4.5 The report page shows "No report has been generated yet" after scoring finished.

**Investigate:**
- Report generation is manual. The admin must click the button. Check whether it was clicked, by looking for a `report_generated` audit entry.
- If it was clicked and failed, the response's error message is shown in the report area. Common causes: scoring not complete (409), or no answers (409).
- Check the report file: `data/storage/reports/report_<sessionId>.json`.

### Q4.6 A follow-up question never appeared in a Mode B interview.

**Investigate:**
- Check the audit trail for `follow_up_planned`, `follow_up_skipped`, `follow_up_duplicate`, or `follow_up_check_unavailable`. Each one answers the question.
- If the answer was under 8 words, the rule should give a vague follow-up with no model call. If it wasn't planned, check whether the per-question or per-interview limit had been reached.
- If the model was unavailable, the audit trail shows `follow_up_check_unavailable`.

**Fix:** depends on the cause. If the check is too strict, tune the prompt in `decideTrigger`. Don't change the limits without agreeing it.

### Q4.7 The interview didn't submit after 60 minutes.

**Investigate:**
- The timer runs every minute, so check that the process is running and that the log shows `Interviews past their time limit were submitted`.
- Check `started_at` in the session. The limit is measured from start, not from creation.
- A candidate in the middle of a request is handled by the gate; a candidate who left is handled by the timer.

**Fix:** if the timer doesn't run, check the two `setInterval` calls in `src/index.ts` `start()` (retention purge and time-limit check), and their `.unref()` calls. Each one also runs once at startup.

### Q4.8 A CV upload fails with "The CV could not be read".

**Investigate:**
- The message comes from `extractCvText`, which returns a 422. Check the file: it must be a text-based PDF or a DOCX. Scanned PDFs have no text, and the message says so.
- Check the file signature: a renamed file is rejected because the bytes don't match.
- If the admin's upload failed after the session was created, a second click creates a second session. Mention this as a known issue.

### Q4.9 A bug only happens with real data. How do you reproduce it?

Copy the session record from `data/storage/interviews/` into a scratch folder, point `DATA_DIRECTORY` at it, and run the function on that record in a small script. This is how the test scripts in this project were written: they build records in a scratch storage directory and stub the model, so the logic runs without cost.

**Caution:** the records contain personal data. Work on a copy, and delete it afterwards.

### Q4.10 How do you check a fix didn't break something else?

Run the offline checks (they stub the model, so they cost nothing), then the live end-to-end checks against the running server: the link lifecycle, the time limit, and scoring with the real model. Then look at the server log for new error lines.

---

## 5. System design: how would you improve, scale, or secure the application?

Structure the answer as: what breaks first, what to change, and what it costs.

### Q5.1 How would you scale this to thousands of interviews a day?

**Short answer, in order of what breaks first:**
1. **Storage.** JSON files with read-modify-write races, and listing that reads every file. Move to PostgreSQL with proper tables, indexes on `candidate_link.token_hash` and `status`, and transactions around each step.
2. **Scoring and background work.** These run in the web process, in memory. A restart loses them, and they compete with requests for CPU. Move scoring to a job queue (such as BullMQ with Redis, or a managed queue) with worker processes. Each job is retryable and survives restarts.
3. **File uploads.** CVs are kept in memory during upload. Store the raw file in object storage (such as S3) and keep only the extracted text in the database, with a retention rule on the file too.
4. **Model calls.** Cache results that don't change (for example, the claim extraction for a CV), batch where the API allows, and rate-limit calls so bursts don't hit provider limits.
5. **Timers.** The per-minute timer should be a scheduled job in the queue, not a timer inside each web process, or several web instances would each run it.

### Q5.2 How would you make the admin access secure for many users?

**Short answer:** Replace the shared password with individual accounts. Use a standard identity provider (SSO through OAuth or OpenID Connect, or the company's directory), with roles such as admin, reviewer, and viewer. Every action in the audit trail then records the real user. Add a CSRF defence (a token on every state-changing request, or `SameSite` cookies), since Basic credentials are sent automatically by the browser. Add a Content-Security-Policy header, and enforce HTTPS at the hosting layer.

**Where it would change:** `src/auth/adminAuth.ts` (replace with a session or token check), `src/index.ts` (the mounts), and every `user_id` in the audit calls, which currently says `system` or `admin`.

### Q5.3 How would you secure the candidate links?

**Short answer:** The token is already random and stored as a hash, and it expires. Add three things: rate limiting on the candidate endpoints, so a token can't be guessed in bulk; one-time use, where the link works only from the first device that opens it, or needs a short code sent by email or SMS; and a server-side session cookie after the first open, so the token isn't needed on every request.

### Q5.4 How would you make the AI scoring more reliable and fair?

**Short answer:** Three changes, in priority order:
1. **Measure fairness.** Build the bias tests the README describes: score anonymized and name-varied copies of the same interview and flag differences. Until this exists, fairness is a claim, not a result.
2. **Reduce variance.** Score each dimension several times and use the median. Store the spread, and show the reviewer when the model is unsure.
3. **Calibrate the rules.** Tune the follow-up threshold and the short-answer rule on real interviews, and record reviewer overrides to see which recommendations people disagree with most.

### Q5.5 How would you handle the model being unavailable or too expensive?

**Short answer:** Degrade in layers. Follow-ups are skipped and the injection check falls back to pattern rules, which is already the behaviour. Scoring is queued and retried with backoff, and the admin is told when it's done. For cost, use the cheaper model for the simple decisions (already done for follow-up checks and the injection check), cap the transcript length, and track cost per interview, which the project declared but never built.

### Q5.6 How would you improve observability?

**Short answer:** The logs are JSON lines, but they go to the console and nothing collects them. Send them to a log service, add request IDs so one interview can be followed across requests, and track metrics: scoring time, scoring failure rate, model cost per interview, follow-up rate, and link expiry rate. Alert on scoring failures and on the timer not running.

### Q5.7 How would you improve the data model?

**Short answer:** Split the session record into tables: interviews, questions, responses, follow-ups, scores, and reviews, with foreign keys. That makes queries like "all overrides for this job" possible, and it lets the retention purge delete by rows rather than by file names. Keep the audit trail as an append-only table, which is also what an auditor would expect.

### Q5.8 What is the biggest risk in the current design?

**Short answer:** Data loss and concurrent writes in the JSON storage, combined with personal data (CVs and answers) and sending it to an external AI provider. The first fix is a database with transactions; the second is making sure the consent text, the retention rule, and the provider's data terms all say the same thing.

### Q5.9 What would you do first with two weeks and one engineer?

1. Move storage to PostgreSQL, keeping the model methods as the interface.
2. Add individual admin accounts with the audit trail recording real users.
3. Move scoring to a queue with retries.
4. Build the bias tests and run them on the existing interviews.

Those four give the largest gain in reliability, security, and trust.

---

## Practice list

Try answering these out loud before the interview, without notes.

1. Explain the architecture in one minute, then in three.
2. Walk through a candidate's interview from the link to the thank-you page, naming the function at each step.
3. Which files change if the business wants a fifth scoring dimension? In what order?
4. A candidate reports they got "This link has expired" after joining. What do you check, in what order?
5. Scoring failed with "no credits". What did you see, and how do you recover?
6. How would you scale storage, and what would you do first?
7. Why does the candidate router use an allowlist?
8. Why is the token stored as a hash, and what does that protect against?
9. Why does the model never decide the final outcome?
10. What is the biggest weakness in the current design, and what would you fix first?
