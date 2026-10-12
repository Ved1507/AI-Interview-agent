/* Candidate interview page. The link token in the address is the only credential. */
(function () {
  'use strict';

  const token = decodeURIComponent(location.pathname.replace(/^\/i\//, '').split('/')[0] || '');
  const BASE = `/api/v1/candidate/${encodeURIComponent(token)}`;
  const MAX_ANSWER = 10000;
  const views = ['view-loading', 'view-message', 'view-consent', 'view-cv', 'view-start', 'view-preparing', 'view-interview', 'view-done'];

  const $ = (id) => document.getElementById(id);
  const state = {
    status: null,
    question: null,
    kind: null,
    questionStartedAt: 0,
    bannerTimer: null,
    expiresAt: null,
    interviewEndsAt: null,
    client: '',
  };

  /* ---------- helpers ---------- */

  function show(viewId) {
    views.forEach((v) => { $(v).hidden = v !== viewId; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showError(id, message) {
    const el = $(id);
    el.textContent = message;
    el.hidden = !message;
  }

  function fmtClock(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /** One request to the candidate API. Returns the parsed body, and throws with the server's message. */
  async function call(method, path, options = {}) {
    const res = await fetch(BASE + path, {
      method,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : options.form,
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty */ }
    if (res.status === 410 || res.status === 404) {
      const err = new Error(data.error || 'This link is not valid.');
      err.state = data.state;
      throw err;
    }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  /* ---------- banner: link expiry, then time left in the interview ---------- */

  function renderBanner() {
    const banner = $('banner');
    const text = $('banner-text');
    if (state.expiresAt) {
      const left = (new Date(state.expiresAt).getTime() - Date.now()) / 1000;
      banner.hidden = false;
      banner.classList.toggle('urgent', left < 300);
      text.textContent = left > 0
        ? `This link is valid until ${fmtTime(state.expiresAt)}. Time left to join: ${fmtClock(left)}.`
        : 'This link has expired.';
      if (left <= 0) {
        clearInterval(state.bannerTimer);
        state.bannerTimer = null;
        loadStatus();
      }
      return;
    }
    if (state.interviewEndsAt) {
      const left = (new Date(state.interviewEndsAt).getTime() - Date.now()) / 1000;
      banner.hidden = false;
      banner.classList.toggle('urgent', left < 300);
      text.textContent = left > 0
        ? `Time left in your interview: ${fmtClock(left)}.`
        : 'Your interview time has ended. Your answers are being submitted.';
      if (left <= 0) {
        clearInterval(state.bannerTimer);
        state.bannerTimer = null;
        loadStatus();
      }
      return;
    }
    banner.hidden = true;
  }

  function startBanner() {
    clearInterval(state.bannerTimer);
    renderBanner();
    state.bannerTimer = setInterval(renderBanner, 1000);
  }

  /* ---------- client personalization (name only; no logos) ---------- */

  function applyClient(clientName) {
    state.client = clientName || '';
    const initial = state.client ? state.client.charAt(0).toUpperCase() : 'TI';
    $('monogram').textContent = initial;
    $('client-line').textContent = state.client
      ? `${state.client} · Please complete the steps below in one sitting.`
      : 'Please complete the steps below in one sitting.';
    const job = state.status && state.status.job_title ? `${state.status.job_title} ` : '';
    const welcome = $('welcome');
    welcome.textContent = state.client ? `Welcome. You are about to begin your ${job}interview with ${state.client}.` : '';
    welcome.hidden = !state.client;
  }

  /* ---------- entry: decide what to show from the link's state ---------- */

  function thankYouText() {
    const base = 'Your interview has been submitted. You can close this page.';
    return state.client ? `${base} Thank you for interviewing with ${state.client}.` : base;
  }

  function message(title, text) {
    $('msg-title').textContent = title;
    $('msg-text').textContent = text;
    show('view-message');
  }

  async function loadStatus() {
    let status;
    try {
      status = await call('GET', '/status');
    } catch (err) {
      return message('This link is not valid', err.message);
    }
    state.status = status;
    state.expiresAt = status.state === 'open' ? status.expires_at : null;
    state.interviewEndsAt = status.state === 'in_progress' ? status.interview_ends_at : null;
    if (status.job_title) $('job-title').textContent = `${status.job_title} interview`;
    applyClient(status.client_name);

    switch (status.state) {
      case 'not_found':
        return message('This link is not valid', status.message || 'Please check the link you were sent.');
      case 'expired':
        return message('This link has expired', 'Please ask for a new link.');
      case 'submitted':
        return message('Thank you', thankYouText());
      case 'in_progress':
        startBanner();
        return loadQuestion();
      case 'open':
        startBanner();
        if (!status.consented) return showConsent();
        if (!status.has_cv) return showCv(status);
        return showStart(status);
      default:
        return message('This link is not valid', 'Please check the link you were sent.');
    }
  }

  /* ---------- consent ---------- */

  function showConsent() {
    show('view-consent');
  }

  async function handleConsent() {
    showError('consent-error', '');
    const ok = $('c-ai-notice').checked && $('c-ai-processing').checked && $('c-data').checked;
    if (!ok) return showError('consent-error', 'Please agree to all three statements to continue.');
    $('consent-btn').disabled = true;
    try {
      await call('POST', '/consent', {
        body: { ai_agent_notice: true, third_party_ai: true, data_storage: true },
      });
      await loadStatus();
    } catch (err) {
      showError('consent-error', err.message);
    } finally {
      $('consent-btn').disabled = false;
    }
  }

  /* ---------- CV ---------- */

  function showCv(status) {
    const required = status.mode === 'B' || status.mode === 'C';
    $('cv-note').textContent = required
      ? 'Your interview needs your CV. Upload it or paste the text.'
      : 'Your CV is optional for this interview. Upload it or paste the text, or skip this step.';
    $('cv-skip-btn').hidden = required;
    show('view-cv');
  }

  function handleCvSkip() {
    showStart(state.status);
  }

  async function handleCv() {
    showError('cv-error', '');
    const file = $('cv-file').files[0];
    const text = $('cv-text').value.trim();
    if (!file && !text) return showError('cv-error', 'Upload your CV or paste its text.');
    if (file) {
      if (!/\.(pdf|docx)$/i.test(file.name)) return showError('cv-error', 'The CV must be a PDF or DOCX file.');
      if (file.size > 5 * 1024 * 1024) return showError('cv-error', 'The CV file is larger than 5 MB.');
    }
    $('cv-btn').disabled = true;
    try {
      if (file) {
        const form = new FormData();
        form.append('file', file);
        await call('POST', '/cv/upload', { form });
      } else {
        await call('PUT', '/cv', { body: { cv_text: text } });
      }
      await loadStatus();
    } catch (err) {
      showError('cv-error', err.message);
    } finally {
      $('cv-btn').disabled = false;
    }
  }

  /* ---------- start ---------- */

  function showStart(status) {
    $('start-note').textContent = `You will have ${status.time_limit_minutes} minutes from when you start to answer all questions and submit.`;
    showError('start-error', '');
    show('view-start');
  }

  async function handleStart() {
    showError('start-error', '');
    $('start-btn').disabled = true;
    show('view-preparing');
    try {
      await call('POST', '/start');
      await loadStatus();
    } catch (err) {
      if (err.state) return loadStatus();
      show('view-start');
      showError('start-error', err.message + ' Please try again.');
    } finally {
      $('start-btn').disabled = false;
    }
  }

  /* ---------- questions ---------- */

  async function loadQuestion() {
    let data;
    try {
      data = await call('GET', '/next-question');
    } catch (err) {
      if (err.state) return loadStatus();
      return message('Something went wrong', err.message);
    }

    if (!data.question) {
      $('q-number').textContent = `${data.answered} of ${data.total_questions} answered`;
      $('q-kind').textContent = '';
      $('q-text').textContent = '';
      $('answer').closest('label').hidden = true;
      $('answer-btn').hidden = true;
      $('answer-error').hidden = true;
      $('finish-card').hidden = false;
      $('view-interview').querySelector('.question-card').hidden = true;
      show('view-interview');
      return;
    }

    state.question = data.question;
    state.kind = data.kind;
    state.questionStartedAt = Date.now();
    $('q-number').textContent = data.kind === 'follow_up'
      ? 'Follow-up question'
      : `Question ${data.answered + 1} of ${data.total_questions}`;
    $('q-kind').textContent = data.kind === 'follow_up' ? 'Please answer in more detail' : '';
    $('q-text').textContent = data.question.text;
    $('answer').value = '';
    $('answer-count').textContent = '0';
    $('answer').closest('label').hidden = false;
    $('answer-btn').hidden = false;
    $('finish-card').hidden = true;
    $('view-interview').querySelector('.question-card').hidden = false;
    showError('answer-error', '');
    show('view-interview');
    $('answer').focus();
  }

  async function handleAnswer() {
    showError('answer-error', '');
    const transcript = $('answer').value.trim();
    if (!transcript) return showError('answer-error', 'Please write your answer before continuing.');

    const duration = Math.round((Date.now() - state.questionStartedAt) / 1000);
    const path = state.kind === 'follow_up' ? '/submit-follow-up' : '/submit-answer';
    $('answer-btn').disabled = true;
    try {
      await call('POST', path, { body: { question_id: state.question.id, transcript, duration_seconds: duration } });
      await loadQuestion();
    } catch (err) {
      if (err.state) return loadStatus();
      showError('answer-error', err.message);
    } finally {
      $('answer-btn').disabled = false;
    }
  }

  async function handleFinish() {
    showError('finish-error', '');
    $('finish-btn').disabled = true;
    try {
      await call('POST', '/complete');
      message('Thank you', thankYouText());
    } catch (err) {
      if (err.state) return loadStatus();
      showError('finish-error', err.message);
    } finally {
      $('finish-btn').disabled = false;
    }
  }

  /* ---------- wiring ---------- */

  function init() {
    $('consent-btn').addEventListener('click', handleConsent);
    $('cv-btn').addEventListener('click', handleCv);
    $('cv-skip-btn').addEventListener('click', handleCvSkip);
    $('start-btn').addEventListener('click', handleStart);
    $('answer-btn').addEventListener('click', handleAnswer);
    $('finish-btn').addEventListener('click', handleFinish);
    $('answer').setAttribute('maxlength', String(MAX_ANSWER));
    $('answer').addEventListener('input', (e) => {
      $('answer-count').textContent = String(e.target.value.length);
    });

    if (!token) return message('This link is not valid', 'Please check the link you were sent.');
    loadStatus();
  }

  init();
})();
