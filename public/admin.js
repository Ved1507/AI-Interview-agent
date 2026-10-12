/* Interview admin portal */
(function () {
  'use strict';

  const API = '/api/v1';
  const REVIEWER_KEY = 'tia.reviewerId';
  const DIMENSION_LABELS = {
    technical_skills: 'Technical skills',
    domain_understanding: 'Domain understanding',
    problem_solving: 'Problem solving',
    communication: 'Communication',
  };
  const LEVEL_LABELS = { strong_hire: 'Strong hire', hire: 'Hire', hold: 'Hold', no_hire: 'No hire' };
  const views = ['view-list', 'view-setup', 'view-link', 'view-queue', 'view-results'];

  const $ = (id) => document.getElementById(id);
  const state = { detailId: null, link: null, pollId: null, clientName: '' };

  /* ---------- helpers ---------- */

  async function api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (res.status === 401) {
      throw new Error('The admin password is required. Reload the page and enter it.');
    }
    if (!res.ok) {
      throw new Error((data && (data.error || data.message)) || `Request failed (${res.status})`);
    }
    return data;
  }

  function show(viewId) {
    views.forEach((v) => { $(v).hidden = v !== viewId; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function stopPolling() {
    clearInterval(state.pollId);
    state.pollId = null;
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2800);
  }

  function showError(id, message) {
    const el = $(id);
    el.textContent = message;
    el.hidden = !message;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString();
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function storeGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function storeSet(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* storage unavailable */ }
  }

  /** Copy with a fallback for pages not served over HTTPS, where the clipboard API is unavailable */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const field = document.createElement('textarea');
      field.value = text;
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand('copy');
      field.remove();
      return ok;
    }
  }

  /* ---------- interviews list ---------- */

  async function showList() {
    stopPolling();
    show('view-list');
    showError('list-error', '');
    const list = $('list-items');
    list.innerHTML = '';
    $('list-empty').hidden = true;
    try {
      const { interviews } = await api('GET', '/interviews?limit=100');
      if (interviews.length === 0) {
        $('list-empty').hidden = false;
        return;
      }
      interviews.forEach((i) => list.appendChild(renderListItem(i)));
    } catch (err) {
      showError('list-error', err.message);
    }
  }

  function renderListItem(i) {
    const item = el('div', 'queue-item');
    const info = el('div', 'queue-info');
    info.appendChild(el('strong', null, `${i.candidate_id} · ${i.job_title}`));
    const when = i.joined
      ? `Joined · scoring ${i.scoring_status}`
      : i.link_expires_at
        ? `Not joined · link until ${fmtTime(i.link_expires_at)}`
        : 'No link yet';
    info.appendChild(el('div', 'subtle', `Mode ${i.mode} · created ${fmtDate(i.created_at)} · ${when}`));

    const meta = el('div', 'queue-meta');
    meta.appendChild(el('span', 'status ' + i.status, i.status.replace(/_/g, ' ')));

    const actions = el('div', 'queue-meta');
    if (!i.joined) {
      const regen = el('button', 'btn ghost', i.link_expires_at ? 'New link' : 'Create link');
      regen.type = 'button';
      regen.addEventListener('click', () => createLinkFor(i.session_id, i.candidate_id));
      actions.appendChild(regen);
    }
    if (i.joined) {
      const open = el('button', 'btn ghost', 'Open');
      open.type = 'button';
      open.addEventListener('click', () => showResults(i.session_id));
      actions.appendChild(open);
    }

    item.appendChild(info);
    item.appendChild(meta);
    item.appendChild(actions);
    return item;
  }

  /* ---------- new interview and link ---------- */

  async function loadJobs() {
    const select = $('job-select');
    try {
      const { jobs } = await api('GET', '/jobs');
      select.innerHTML = '';
      const placeholder = el('option', null, jobs.length ? 'Select a job…' : 'No jobs found');
      placeholder.value = '';
      select.appendChild(placeholder);
      jobs.forEach((job) => {
        const opt = el('option', null, `${job.title} (${job.question_count} questions)`);
        opt.value = job.id;
        select.appendChild(opt);
      });
    } catch (err) {
      showError('setup-error', err.message);
    }
  }

  function selectedMode() {
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : 'A';
  }

  async function handleCreate(event) {
    event.preventDefault();
    showError('setup-error', '');

    const candidateId = $('candidate-id').value.trim();
    const jobId = $('job-select').value;
    const cvFile = $('cv-file').files[0];
    const cvText = $('cv-text').value.trim();
    if (!candidateId) return showError('setup-error', 'Enter the candidate ID or name.');
    if (!jobId) return showError('setup-error', 'Select a job.');
    if (cvFile) {
      if (!/\.(pdf|docx)$/i.test(cvFile.name)) return showError('setup-error', 'The CV must be a PDF or DOCX file.');
      if (cvFile.size > 5 * 1024 * 1024) return showError('setup-error', 'The CV file is larger than 5 MB.');
    }

    const btn = $('create-btn');
    btn.disabled = true;
    try {
      const init = await api('POST', '/interviews/initialize', {
        candidate_id: candidateId,
        job_id: jobId,
        mode: selectedMode(),
        cv_text: cvText || undefined,
      });
      if (cvFile) {
        const form = new FormData();
        form.append('file', cvFile);
        const upload = await fetch(`${API}/interviews/${init.session_id}/cv/upload`, { method: 'POST', body: form });
        const data = await upload.json().catch(() => ({}));
        if (!upload.ok) throw new Error(data.error || 'The CV could not be read.');
      }
      await createLinkFor(init.session_id, candidateId);
      $('setup-form').reset();
    } catch (err) {
      showError('setup-error', err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function createLinkFor(sessionId, candidateId) {
    showError('link-error', '');
    try {
      const link = await api('POST', `/interviews/${sessionId}/link`);
      state.link = { ...link, candidate_id: candidateId };
      showLink();
    } catch (err) {
      toast(err.message);
      await showList();
    }
  }

  function invitationText() {
    const link = state.link;
    const who = state.clientName ? `${state.clientName} interview` : 'interview';
    return [
      `Hello ${link.candidate_id}, please complete your ${who} using this link:`,
      link.url,
      '',
      `The link is valid for ${link.lifetime_minutes} minutes from when it was created (until ${fmtTime(link.expires_at)}).`,
      'Once you join, the interview has its own time limit. You will be asked for consent before it starts.',
    ].join('\n');
  }

  function showLink() {
    const link = state.link;
    $('link-candidate').textContent = `For ${link.candidate_id}`;
    $('link-url').value = link.url;
    $('link-expiry').textContent =
      `Valid until ${fmtTime(link.expires_at)} (${link.lifetime_minutes} minutes from creation). ` +
      'Regenerating replaces the link and starts a new 30-minute window. It is blocked once the candidate has joined.';
    show('view-link');
  }

  /* ---------- review queue ---------- */

  async function showQueue() {
    stopPolling();
    show('view-queue');
    showError('queue-error', '');
    const list = $('queue-list');
    list.innerHTML = '';
    $('queue-empty').hidden = true;
    try {
      const { sessions } = await api('GET', '/human-review/pending?limit=50');
      if (sessions.length === 0) {
        $('queue-empty').hidden = false;
        return;
      }
      sessions.forEach((s) => list.appendChild(renderQueueItem(s)));
    } catch (err) {
      showError('queue-error', err.message);
    }
  }

  function renderQueueItem(s) {
    const item = el('div', 'queue-item');
    const info = el('div', 'queue-info');
    info.appendChild(el('strong', null, `Candidate ${s.candidate_id}`));
    info.appendChild(el('div', 'subtle', `Mode ${s.mode} · completed ${fmtDate(s.completed_at)}`));
    const meta = el('div', 'queue-meta');
    if (s.weighted_score !== null) meta.appendChild(el('span', 'pill', `${s.weighted_score}/100`));
    if (s.recommendation) meta.appendChild(el('span', 'pill muted', LEVEL_LABELS[s.recommendation] || s.recommendation));
    if (s.injection_flags > 0) meta.appendChild(el('span', 'pill danger', `${s.injection_flags} injection flag(s)`));
    const open = el('button', 'btn primary', 'Review');
    open.type = 'button';
    open.addEventListener('click', () => showResults(s.session_id));
    item.appendChild(info);
    item.appendChild(meta);
    item.appendChild(open);
    return item;
  }

  /* ---------- interview detail: scores, review, report ---------- */

  function renderScoring(detail) {
    const scoring = detail.scoring;
    const rec = detail.recommendation;
    const block = $('res-scores-block');
    if (!scoring || !scoring.dimensions) {
      block.hidden = true;
      return;
    }
    block.hidden = false;

    const level = rec ? rec.level : null;
    $('res-rec-level').textContent = level ? (LEVEL_LABELS[level] || level) : 'No recommendation';
    $('res-rec-level').className = 'rec-level ' + (level || '');
    $('res-rec-meta').textContent = rec ? `Confidence: ${rec.confidence}` : '';
    $('res-rec-reasoning').textContent = rec && rec.reasoning ? rec.reasoning : '';
    $('res-overall').textContent = scoring.weighted_score ?? '—';

    const dims = $('res-dimensions');
    dims.innerHTML = '';
    Object.entries(scoring.dimensions).forEach(([key, dim]) => {
      if (!dim) return;
      const card = el('div', 'dimension');
      const head = el('div', 'dim-head');
      head.appendChild(el('strong', null, DIMENSION_LABELS[key] || key));
      head.appendChild(el('span', 'dim-score', `${Math.round(dim.score)}/100`));
      card.appendChild(head);
      const bar = el('div', 'bar');
      const fill = el('div', 'bar-fill');
      fill.style.width = Math.max(0, Math.min(100, dim.score)) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
      if (dim.reasoning) card.appendChild(el('p', 'dim-reason', dim.reasoning));
      (dim.evidence_quotes || []).forEach((q) => card.appendChild(el('blockquote', 'quote', q)));
      card.appendChild(el('div', 'subtle small', `Model confidence ${Math.round((dim.confidence || 0) * 100)}%`));
      dims.appendChild(card);
    });
  }

  function renderSecurity(detail) {
    const flags = (detail.security_flags && detail.security_flags.injection_attempts_detected) || [];
    const block = $('security-block');
    block.hidden = flags.length === 0;
    if (!flags.length) return;
    $('security-summary').textContent =
      `${flags.length} flag(s). Scores were not changed automatically. Check these answers before deciding.`;
    const list = $('security-list');
    list.innerHTML = '';
    flags.forEach((f) => {
      const where = f.location || 'unknown location';
      list.appendChild(el('li', null, `${where} · ${f.severity} · ${f.pattern_matched} · ${f.layer || 'pattern'} check: "${f.flagged_text}"`));
    });
  }

  function renderReviewState(detail) {
    const review = detail.human_review;
    const canReview = detail.status === 'under_review';
    $('review-block').hidden = !(canReview || review);
    $('review-forms').hidden = !canReview;

    const outcome = $('review-outcome');
    if (review) {
      outcome.hidden = false;
      const original = LEVEL_LABELS[review.original_recommendation] || review.original_recommendation || '—';
      const final = LEVEL_LABELS[review.final_recommendation] || review.final_recommendation || '—';
      const verb = review.status === 'overridden' ? 'Overridden' : 'Approved';
      outcome.textContent = `${verb} by ${review.reviewer_id} on ${fmtDate(review.review_timestamp)}. ` +
        `AI: ${original} → Final: ${final}.` +
        (review.override_reason ? ` Reason: ${review.override_reason}` : '');
    } else {
      outcome.hidden = true;
    }

    if (canReview) {
      $('reviewer-id').value = storeGet(REVIEWER_KEY) || '';
      const rec = detail.recommendation;
      if (rec && rec.level) $('override-level').value = rec.level;
    }
  }

  function renderStatusNote(detail) {
    const note = $('res-scoring-note');
    const scoringStatus = detail.scoring_status;
    let text = '';
    if (scoringStatus === 'in_progress' || (scoringStatus === 'pending' && detail.status === 'completed')) {
      text = 'Scoring is in progress. This page refreshes automatically.';
    } else if (scoringStatus === 'error') {
      text = 'Scoring failed. The AI scoring service could not be reached or returned an error. Check the server log and the audit trail below.';
    } else if (detail.status === 'initialized') {
      text = 'The candidate has not joined yet. The link is still open until its expiry time.';
    } else if (detail.status === 'in_progress') {
      text = 'The candidate is taking the interview.';
    }
    note.textContent = text;
    note.hidden = !text;

    const retry = $('rescore-btn');
    retry.hidden = !(scoringStatus === 'error' && detail.status === 'completed');
    retry.disabled = false;
  }

  function renderTranscript(detail) {
    const list = $('res-transcript');
    list.innerHTML = '';
    const byId = new Map((detail.responses || []).map((r) => [r.question_instance_id, r]));
    (detail.questions || []).filter((q) => q.generated_by_mode !== 'follow_up').forEach((q) => {
      const li = el('li');
      li.appendChild(el('div', 'q', q.text));
      const response = byId.get(q.id);
      li.appendChild(el('div', 'a', response ? response.transcript : 'Not answered'));
      (response?.follow_ups || []).forEach((f) => {
        li.appendChild(el('div', 'q followup', `Follow-up (${f.trigger || 'probe'}): ${f.text}`));
        li.appendChild(el('div', 'a', f.transcript));
      });
      list.appendChild(li);
    });
  }

  function renderAudit(detail) {
    const list = $('res-audit');
    list.innerHTML = '';
    const entries = detail.audit_trail || [];
    if (entries.length === 0) {
      list.appendChild(el('li', 'subtle', 'No audit entries yet.'));
      return;
    }
    entries.forEach((entry) => {
      const li = el('li');
      li.appendChild(el('strong', null, entry.action.replace(/_/g, ' ')));
      li.appendChild(el('span', 'subtle', ` · ${fmtDate(entry.timestamp)} · ${entry.user_id}`));
      list.appendChild(li);
    });
  }

  async function showResults(sessionId) {
    state.detailId = sessionId;
    const detail = await api('GET', `/human-review/${sessionId}`);

    $('res-title').textContent = `Mode ${detail.mode} interview · ${detail.candidate_id}`;
    $('res-session').textContent = detail.session_id;
    const status = $('res-status');
    status.textContent = detail.status.replace(/_/g, ' ');
    status.className = 'status ' + detail.status;

    renderStatusNote(detail);
    renderScoring(detail);
    renderSecurity(detail);
    renderReviewState(detail);
    renderTranscript(detail);
    renderAudit(detail);
    loadReport(detail).catch((err) => showError('report-error', err.message));
    show('view-results');

    stopPolling();
    if (detail.scoring_status === 'in_progress' || (detail.scoring_status === 'pending' && detail.status === 'completed')) {
      state.pollId = setInterval(() => {
        if ($('view-results').hidden) return stopPolling();
        showResults(sessionId).catch(() => stopPolling());
      }, 4000);
    }
  }

  async function handleRescore() {
    if (!state.detailId) return;
    const btn = $('rescore-btn');
    btn.disabled = true;
    try {
      await api('POST', `/interviews/${state.detailId}/rescore`);
      toast('Scoring restarted');
      await showResults(state.detailId);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  }

  /* ---------- report (generated on request) ---------- */

  function reportLink(id, format) {
    return `${API}/reports/${id}/${format}`;
  }

  function setReportLinks(sessionId, visible) {
    [['report-pdf', 'pdf'], ['report-md', 'markdown'], ['report-json', 'json']].forEach(([id, format]) => {
      const link = $(id);
      link.hidden = !visible;
      link.href = visible ? reportLink(sessionId, format) : '#';
    });
  }

  function renderListItems(container, items) {
    container.innerHTML = '';
    if (!items.length) {
      container.appendChild(el('li', 'subtle', 'None recorded'));
      return;
    }
    items.forEach((text) => container.appendChild(el('li', null, text)));
  }

  function renderReport(report) {
    const es = report.executive_summary;
    const body = $('report-body');
    body.innerHTML = '';

    const warning = $('report-warning');
    warning.hidden = es.evidence_sufficient;
    warning.textContent = 'Evidence is insufficient. Some answers are too short or do not address the question. ' +
      'Treat the scores and the recommendation with caution.';
    $('report-meta').textContent = `Generated ${fmtDate(report.generated_at)} · Approval: ${report.approval_status.replace(/_/g, ' ')}`;

    body.appendChild(el('p', null, es.summary));

    const strengths = el('div', 'report-cols');
    const sCol = el('div');
    sCol.appendChild(el('h4', null, 'Strengths'));
    const sList = el('ul', 'plain');
    renderListItems(sList, es.key_strengths);
    sCol.appendChild(sList);
    const gCol = el('div');
    gCol.appendChild(el('h4', null, 'Gaps'));
    const gList = el('ul', 'plain');
    renderListItems(gList, es.key_gaps);
    gCol.appendChild(gList);
    strengths.appendChild(sCol);
    strengths.appendChild(gCol);
    body.appendChild(strengths);

    if (es.next_steps) body.appendChild(el('p', 'subtle', `Next steps: ${es.next_steps}`));

    if (report.integrity_notes && report.integrity_notes.length) {
      body.appendChild(el('h4', null, 'Integrity notes'));
      const notes = el('ul', 'plain');
      renderListItems(notes, report.integrity_notes);
      body.appendChild(notes);
    }

    body.appendChild(el('h4', null, 'CV alignment'));
    body.appendChild(el('p', 'subtle', report.cv_alignment.summary || 'No summary'));
    if (report.cv_alignment.claims.length) {
      const claims = el('ul', 'plain');
      report.cv_alignment.claims.forEach((c) => {
        claims.appendChild(el('li', null, `${c.claim} — ${c.status.replace(/_/g, ' ')}${c.evidence ? `: ${c.evidence}` : ''}`));
      });
      body.appendChild(claims);
    }

    body.appendChild(el('h4', null, 'Job fit'));
    body.appendChild(el('p', 'subtle', report.job_fit.summary || 'No summary'));
    if (report.job_fit.requirements.length) {
      const reqs = el('ul', 'plain');
      report.job_fit.requirements.forEach((r) => {
        reqs.appendChild(el('li', null, `${r.requirement} — ${r.status.replace(/_/g, ' ')}${r.note ? `: ${r.note}` : ''}`));
      });
      body.appendChild(reqs);
    }

    body.appendChild(el('h4', null, 'Per-question assessment'));
    const qList = el('ul', 'plain');
    report.detailed_feedback.questions.forEach((q) => {
      qList.appendChild(el('li', null, `Q${q.question_number} (${q.answer_quality}, ${q.word_count} words): ${q.assessment}`));
    });
    body.appendChild(qList);
  }

  async function loadReport(detail) {
    const canHaveReport = detail.status === 'under_review' || detail.status === 'finalized';
    $('report-block').hidden = !canHaveReport;
    if (!canHaveReport) return;

    showError('report-error', '');
    const btn = $('report-generate-btn');
    btn.disabled = false;

    try {
      const report = await api('GET', `/reports/${detail.session_id}/json`);
      renderReport(report);
      $('report-body').hidden = false;
      setReportLinks(detail.session_id, true);
      btn.textContent = 'Regenerate report';
    } catch (_) {
      $('report-body').innerHTML = '';
      $('report-body').hidden = true;
      $('report-warning').hidden = true;
      setReportLinks(detail.session_id, false);
      $('report-meta').textContent = detail.scoring_status === 'completed'
        ? 'No report has been generated yet. Click "Generate report" when you are ready.'
        : 'The report can be generated once scoring has finished.';
      btn.textContent = 'Generate report';
      btn.disabled = detail.scoring_status !== 'completed';
    }
  }

  async function generateReport() {
    if (!state.detailId) return;
    showError('report-error', '');
    const btn = $('report-generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    try {
      await api('POST', `/reports/${state.detailId}/generate`);
      toast('Report generated');
      await showResults(state.detailId);
    } catch (err) {
      showError('report-error', err.message);
      btn.textContent = 'Generate report';
      btn.disabled = false;
    }
  }

  /* ---------- human review ---------- */

  async function submitReview(path, body, errorId) {
    showError(errorId, '');
    try {
      await api('POST', `/human-review/${state.detailId}/${path}`, body);
      toast(path === 'approve' ? 'Recommendation approved' : 'Recommendation overridden');
      await showResults(state.detailId);
    } catch (err) {
      showError(errorId, err.message);
    }
  }

  function handleApprove(event) {
    event.preventDefault();
    const reviewer = $('reviewer-id').value.trim();
    if (!reviewer) return showError('approve-error', 'Enter your reviewer ID first.');
    storeSet(REVIEWER_KEY, reviewer);
    const notes = $('approve-notes').value.trim();
    submitReview('approve', { reviewer_id: reviewer, notes: notes || undefined }, 'approve-error');
  }

  function handleOverride(event) {
    event.preventDefault();
    const reviewer = $('reviewer-id').value.trim();
    if (!reviewer) return showError('override-error', 'Enter your reviewer ID first.');
    const reason = $('override-reason').value.trim();
    if (reason.length < 10) return showError('override-error', 'Give a reason of at least 10 characters.');
    storeSet(REVIEWER_KEY, reviewer);
    submitReview('override', {
      reviewer_id: reviewer,
      new_recommendation: $('override-level').value,
      reasoning: reason,
    }, 'override-error');
  }

  /* ---------- wiring ---------- */

  async function loadBranding() {
    try {
      const { client_name } = await (await fetch(API + '/branding')).json();
      state.clientName = client_name || '';
      if (state.clientName) {
        $('client-line').textContent = `${state.clientName} · Interview administration`;
        $('client-line').hidden = false;
      }
    } catch (_) { /* branding is optional */ }
  }

  function init() {
    loadBranding();
    loadJobs();

    $('nav-list').addEventListener('click', showList);
    $('nav-new').addEventListener('click', () => { loadJobs(); show('view-setup'); });
    $('nav-queue').addEventListener('click', showQueue);
    $('list-refresh').addEventListener('click', showList);
    $('queue-refresh').addEventListener('click', showQueue);
    $('back-list-btn').addEventListener('click', showList);

    $('setup-form').addEventListener('submit', handleCreate);
    $('copy-link-btn').addEventListener('click', async () => {
      const ok = await copyText(state.link.url);
      toast(ok ? 'Link copied' : 'Could not copy. Select the link and copy it.');
    });
    $('copy-invite-btn').addEventListener('click', async () => {
      const ok = await copyText(invitationText());
      toast(ok ? 'Invitation text copied' : 'Could not copy. Select the text and copy it.');
    });
    $('regenerate-link-btn').addEventListener('click', () => createLinkFor(state.link.session_id, state.link.candidate_id));
    $('open-session-btn').addEventListener('click', () => showResults(state.link.session_id));

    $('rescore-btn').addEventListener('click', handleRescore);
    $('report-generate-btn').addEventListener('click', generateReport);
    $('approve-form').addEventListener('submit', handleApprove);
    $('override-form').addEventListener('submit', handleOverride);

    showList();
  }

  init();
})();
