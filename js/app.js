'use strict';

// ── constants ───────────────────────────────────────────────────────────────
const MODELS = {
  'Xenova/whisper-tiny':  { label: 'whisper-tiny',  size: '~150 MB' },
  'Xenova/whisper-small': { label: 'whisper-small', size: '~460 MB' },
};
const SK               = 'fu_';       // localStorage key prefix
const DEFAULT_MODEL    = 'Xenova/whisper-tiny';
const DEFAULT_THRESH   = 80;          // % correct to pass
const DEFAULT_TTS_RATE = 0.8;
const COMP_STATS_KEY     = SK + 'compstats'; // [[recSec, computeSec], ...] last 25
const COMP_STATS_MAX     = 25;
const COMP_RATIO_DEFAULT = 2.0;              // fallback: 2s compute per 1s audio

// ── state ───────────────────────────────────────────────────────────────────
let appState      = 'setup';          // setup | loading | idle | recording | processing | feedback

// Per-file byte tracking for smooth overall progress (reset on each load)
const _fileBytes  = new Map();        // file → { loaded, total, status }
let   _lastTextTs = 0;                // throttle text updates
let   _stallTimer = null;             // stall-detection timeout handle
let selectedModel = DEFAULT_MODEL;
let passThreshold = DEFAULT_THRESH;
let ttsRate       = DEFAULT_TTS_RATE;
let gpuPref       = 'high-performance';  // 'high-performance' | 'auto' | 'low-power' | 'wasm'
let allSentences  = [];           // flat list of all sentences from all chapters
let currentIdx    = -1;           // current index into allSentences
let _procTimerInterval = null;    // setInterval handle for the processing timer
let _procStart    = 0;            // timestamp when processing started
let _recStart     = 0;            // timestamp when recording started
let _recDuration  = 0;            // seconds of last recording
let _procBarTimer = null;         // setInterval for deterministic proc progress bar
let _analyser     = null;         // AnalyserNode for volume metering
let _volAnimId    = null;         // requestAnimationFrame handle for volume meter
let mediaRecorder = null;
let audioChunks   = [];
let worker        = null;
let session       = { practiced: 0, passed: 0, streak: 0 };

// ── DOM refs ─────────────────────────────────────────────────────────────────
const setupScreen     = document.getElementById('setup-screen');
const appScreen       = document.getElementById('app-screen');
const modelRadios     = document.querySelectorAll('input[name="model"]');
const loadModelBtn    = document.getElementById('load-model-btn');
const modelProgress   = document.getElementById('model-progress');
const progressFill    = document.getElementById('progress-fill');
const progressText    = document.getElementById('progress-text');
const fileListEl      = document.getElementById('file-list');
const settingsBtn     = document.getElementById('settings-btn');
const settingsPanel   = document.getElementById('settings-panel');
const thresholdInput  = document.getElementById('threshold-input');
const ttsRateSelect   = document.getElementById('tts-rate');
const changeModelBtn  = document.getElementById('change-model-btn');
const gpuPrefSetup    = document.getElementById('gpu-pref-setup');
const gpuPrefSettings = document.getElementById('gpu-pref-settings');
const sentenceDisplay = document.getElementById('sentence-display');
const sentenceMeta    = document.getElementById('sentence-meta');
const listenBtn       = document.getElementById('listen-btn');
const speakBtn        = document.getElementById('speak-btn');
const skipBtn         = document.getElementById('skip-btn');
const feedbackArea    = document.getElementById('feedback-area');
const processingEl    = document.getElementById('processing-indicator');
const wordFeedback    = document.getElementById('word-feedback');
const scoreRow        = document.getElementById('score-row');
const fluencyRow      = document.getElementById('fluency-row');
const replayBtn       = document.getElementById('replay-btn');
const retryBtn        = document.getElementById('retry-btn');
const nextBtn         = document.getElementById('next-btn');
const actionButtons   = document.getElementById('action-buttons');
const streakEl        = document.getElementById('streak-count');
const practicedEl     = document.getElementById('practiced-count');

// ── preferences ──────────────────────────────────────────────────────────────
function loadPrefs() {
  selectedModel = localStorage.getItem(SK + 'model')     || DEFAULT_MODEL;
  passThreshold = parseInt(localStorage.getItem(SK + 'threshold')) || DEFAULT_THRESH;
  ttsRate       = parseFloat(localStorage.getItem(SK + 'ttsRate')) || DEFAULT_TTS_RATE;
  gpuPref       = localStorage.getItem(SK + 'gpuPref') || 'high-performance';

  modelRadios.forEach(r => { r.checked = (r.value === selectedModel); });
  if (thresholdInput) thresholdInput.value = passThreshold;
  if (ttsRateSelect)  ttsRateSelect.value  = ttsRate;
  if (gpuPrefSetup)    gpuPrefSetup.value    = gpuPref;
  if (gpuPrefSettings) gpuPrefSettings.value = gpuPref;
}

function savePrefs() {
  localStorage.setItem(SK + 'model',     selectedModel);
  localStorage.setItem(SK + 'threshold', passThreshold);
  localStorage.setItem(SK + 'ttsRate',   ttsRate);
  localStorage.setItem(SK + 'gpuPref',   gpuPref);
}

// ── sentence progress (best score per sentence) ───────────────────────────────
function getBestScore(idx) {
  return parseInt(localStorage.getItem(SK + `s_${idx}`)) || 0;
}
function saveBestScore(idx, score) {
  if (score > getBestScore(idx)) {
    localStorage.setItem(SK + `s_${idx}`, score);
  }
}

// ── worker ───────────────────────────────────────────────────────────────────
function initWorker() {
  worker = new Worker('./js/whisper-worker.js', { type: 'module' });
  worker.onmessage = handleWorkerMsg;
  worker.onerror   = e => {
    console.error('Worker error:', e);
    showError('Worker-fout: ' + e.message);
    goToSetup();
  };
}

let _gpuAdapterDesc = '';

function handleWorkerMsg({ data: msg }) {
  switch (msg.type) {
    case 'progress':
      onProgress(msg.data);
      break;
    case 'ready':
      onModelReady(msg.device);
      break;
    case 'gpuInfo':
      _gpuAdapterDesc = msg.data.description || msg.data.device || msg.data.vendor || '';
      // Warn if Intel was selected despite high-performance preference
      if (gpuPref === 'high-performance') {
        const lower = _gpuAdapterDesc.toLowerCase();
        if (lower.includes('intel')) {
          progressText.textContent =
            `⚠️ GPU: ${_gpuAdapterDesc} — voor Nvidia: stel in Nvidia-instellingen de browser in op de discrete GPU.`;
        } else if (_gpuAdapterDesc) {
          progressText.textContent = `GPU: ${_gpuAdapterDesc}`;
        }
      }
      break;
    case 'result':
      handleTranscription(msg.data);
      break;
    case 'error':
      showError(msg.data);
      setState('idle');
      break;
  }
}

function onProgress({ status, file, loaded, total, progress }) {
  modelProgress.hidden = false;
  armStallDetector();

  if (status === 'initiate') {
    if (file) _fileBytes.set(file, { loaded: 0, total: total || 0, status: 'pending' });
    renderFileList();
    return;
  }

  if (status === 'downloading' || status === 'progress') {
    if (file) {
      const entry = _fileBytes.get(file) || { loaded: 0, total: total || 0, status: 'pending' };
      entry.loaded = (loaded != null) ? loaded : (entry.total * (progress || 0) / 100);
      if (total > 0) entry.total = total;
      entry.status = 'downloading';
      _fileBytes.set(file, entry);
    }

    // Compute overall progress across all tracked files
    let sumLoaded = 0, sumTotal = 0;
    for (const e of _fileBytes.values()) { sumLoaded += e.loaded; sumTotal += e.total; }
    const overallPct = sumTotal > 0 ? Math.round(100 * sumLoaded / sumTotal) : Math.round(progress || 0);

    // Bar only moves forward, capped at 99 until the model signals 'ready'
    const prevWidth  = parseFloat(progressFill.style.width) || 0;
    const newWidth   = Math.max(prevWidth, Math.min(99, overallPct));
    progressFill.style.width = newWidth + '%';

    // Throttle text to at most once per second
    const now = Date.now();
    if (now - _lastTextTs >= 900) {
      _lastTextTs = now;
      const nDone = [..._fileBytes.values()].filter(e => e.status === 'done').length;
      progressText.textContent = `Downloaden… ${newWidth}% (${nDone}/${_fileBytes.size} bestanden)`;
    }
    renderFileList();
    return;
  }

  if (status === 'done' && file) {
    const entry = _fileBytes.get(file);
    if (entry) {
      if (entry.total > 0) entry.loaded = entry.total;
      entry.status = 'done';
      _fileBytes.set(file, entry);
    }
    // Update done count in text immediately
    const nDone = [..._fileBytes.values()].filter(e => e.status === 'done').length;
    const w     = parseFloat(progressFill.style.width) || 0;
    if (nDone === _fileBytes.size && _fileBytes.size > 0) {
      progressText.textContent = 'Model initialiseren… (kan 1–2 min duren)';
      armStallDetector();
    } else {
      progressText.textContent = `Downloaden… ${Math.round(w)}% (${nDone}/${_fileBytes.size} bestanden)`;
    }
    renderFileList();
    return;
  }

  if (status === 'ready' || status === 'loaded') {
    clearTimeout(_stallTimer);
    progressFill.style.width = '100%';
    progressText.textContent  = 'Gereed!';
    renderFileList();
  }
}

// ── per-file list rendering ───────────────────────────────────────────────────
function formatBytes(b) {
  if (!b || b < 1024)        return b + ' B';
  if (b < 1024 * 1024)       return (b / 1024).toFixed(0) + ' kB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderFileList() {
  if (!fileListEl || !_fileBytes.size) return;
  fileListEl.innerHTML = '';
  for (const [path, entry] of _fileBytes.entries()) {
    const name  = path.split('/').pop() || path;
    const icon  = entry.status === 'done'        ? '✅'
                : entry.status === 'downloading' ? '🔄'
                :                                  '⏺️';
    const pct   = entry.total > 0
      ? Math.round(100 * entry.loaded / entry.total) + '%'
      : (entry.status === 'done' ? '100%' : '—');
    const size  = entry.total > 0 ? ' · ' + formatBytes(entry.total) : '';

    const li     = document.createElement('li');
    li.className = 'file-item ' + entry.status;

    const iconEl = document.createElement('span');
    iconEl.className = 'file-icon';
    iconEl.textContent = icon;

    const nameEl = document.createElement('span');
    nameEl.className = 'file-name';
    nameEl.textContent = name + size;
    nameEl.title = path;

    const pctEl = document.createElement('span');
    pctEl.className = 'file-pct';
    pctEl.textContent = pct;

    li.append(iconEl, nameEl, pctEl);
    fileListEl.appendChild(li);
  }
}

// ── stall detector ────────────────────────────────────────────────────────────
function armStallDetector() {
  clearTimeout(_stallTimer);
  _stallTimer = setTimeout(() => {
    if (appState === 'loading') {
      progressText.textContent =
        '⚠️ Geen activiteit gedurende 60s — download lijkt vastgelopen. Ververs de pagina en probeer opnieuw.';
    }
  }, 60_000);
}

function onModelReady(device) {
  savePrefs();
  setupScreen.hidden = true;
  appScreen.hidden   = false;
  // Show which device + adapter was used in the settings panel label
  if (gpuPrefSettings) {
    const label = device === 'wasm' ? 'WASM (CPU)'
                : device === 'webgpu'
                  ? ('WebGPU ✔' + (_gpuAdapterDesc ? ` (${_gpuAdapterDesc})` : ''))
                : device || 'onbekend';
    const parent = gpuPrefSettings.closest('label');
    if (parent) parent.title = `Actief: ${label}`;
  }
  buildSentenceList();
  pickRandom();
  loadSentence();
  setState('idle');
}

// ── model loading ─────────────────────────────────────────────────────────────
function startLoadModel() {
  modelRadios.forEach(r => { if (r.checked) selectedModel = r.value; });

  loadModelBtn.disabled    = true;
  loadModelBtn.textContent = 'Laden…';
  modelProgress.hidden     = false;
  progressFill.style.width = '0%';
  progressText.textContent = 'Model downloaden…';
  _fileBytes.clear();
  _lastTextTs = 0;
  clearTimeout(_stallTimer);
  if (fileListEl) fileListEl.innerHTML = '';

  if (!worker) initWorker();
  worker.postMessage({ type: 'load', data: { model: selectedModel, gpuPref } });
  setState('loading');
}

function goToSetup() {
  appScreen.hidden   = true;
  setupScreen.hidden = false;
  loadModelBtn.disabled    = false;
  loadModelBtn.textContent = 'Model laden';
  modelProgress.hidden     = true;
  modelRadios.forEach(r => { r.checked = (r.value === selectedModel); });
}

// ── sentence helpers (flat random selection) ─────────────────────────────────
function buildSentenceList() {
  allSentences = (window.CHAPTERS || []).flatMap(ch => ch.sentences || []).filter(Boolean);
}

function pickRandom() {
  if (!allSentences.length) return;
  if (allSentences.length === 1) { currentIdx = 0; return; }
  let idx;
  do { idx = Math.floor(Math.random() * allSentences.length); }
  while (idx === currentIdx);
  currentIdx = idx;
}

function currentSentence() { return allSentences[currentIdx] ?? null; }

function loadSentence() {
  const s = currentSentence();
  if (!s) return;

  sentenceDisplay.textContent = s;
  sentenceDisplay.classList.remove('pop');
  requestAnimationFrame(() => sentenceDisplay.classList.add('pop'));

  if (sentenceMeta) {
    sentenceMeta.textContent = `${session.practiced} geoefend · ${allSentences.length} zinnen`;
  }
}

function advanceSentence() {
  pickRandom();
  hideFeedback();
  loadSentence();
  setState('idle');
}

function hideFeedback() {
  stopProcTimer();
  feedbackArea.hidden     = true;
  processingEl.hidden     = true;
  wordFeedback.innerHTML  = '';
  scoreRow.innerHTML      = '';
  fluencyRow.hidden       = true;
  fluencyRow.innerHTML    = '';
  actionButtons.hidden    = true;
}

// ── audio recording ───────────────────────────────────────────────────────────
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioChunks  = [];

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(t => MediaRecorder.isTypeSupported(t)) || '';

    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      processAudio();
    };
    mediaRecorder.start();
    _recStart = Date.now();
    startVolumeMeter(stream);
    setState('recording');
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'Microfoon toegang geweigerd. Sta toegang toe in de browserinstellingen.'
      : 'Microfoon niet beschikbaar: ' + err.message;
    showError(msg);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    _recDuration = (Date.now() - _recStart) / 1000;
    stopVolumeMeter();
    mediaRecorder.stop();
    setState('processing');
  }
}

async function processAudio() {
  const mimeType = audioChunks[0]?.type || 'audio/webm';
  const blob     = new Blob(audioChunks, { type: mimeType });

  try {
    const arrayBuffer = await blob.arrayBuffer();

    // Decode audio with the browser's native decoder
    const tempCtx = new AudioContext();
    const decoded = await tempCtx.decodeAudioData(arrayBuffer);
    await tempCtx.close();

    // Resample to 16 kHz mono via OfflineAudioContext (what Whisper expects)
    const targetSR   = 16000;
    const numFrames  = Math.ceil(decoded.duration * targetSR);
    const offCtx     = new OfflineAudioContext(1, numFrames, targetSR);
    const src        = offCtx.createBufferSource();
    src.buffer       = decoded;
    src.connect(offCtx.destination);
    src.start(0);
    const rendered   = await offCtx.startRendering();
    const float32    = rendered.getChannelData(0);

    // Transfer buffer ownership to worker (zero-copy)
    worker.postMessage(
      { type: 'transcribe', data: { audio: float32 } },
      [float32.buffer]
    );
  } catch (err) {
    showError('Audio verwerking mislukt: ' + err.message);
    setState('idle');
  }
}

// ── transcription result ──────────────────────────────────────────────────────
function handleTranscription(result) {
  // Save timing stat and complete the progress bar
  const actualCompute = (Date.now() - _procStart) / 1000;
  saveComputeStat(_recDuration, actualCompute);
  stopProcBar(true);

  const sentence = currentSentence();
  if (!sentence) { setState('idle'); return; }

  const fluency = result.chunks?.length ? computeFluency(result.chunks) : null;

  // ── DEV: log raw Whisper output ──────────────────────────────────────────
  console.group('[Whisper result]');
  console.log('text:', result.text);
  console.log('chunks:', result.chunks);
  if (result.chunks?.length) {
    const rows = result.chunks.map(c => ({
      word:     c.text.trim(),
      start:    c.timestamp?.[0]?.toFixed(3),
      end:      c.timestamp?.[1]?.toFixed(3),
      dur_ms:   c.timestamp ? Math.round((c.timestamp[1] - c.timestamp[0]) * 1000) : '?',
    }));
    console.table(rows);
    console.log('fluency:', fluency);
  }
  console.groupEnd();

  const transcript = (result.text || '').trim();
  const expWords   = tokenize(sentence);
  const hrdWords   = tokenize(transcript);

  const { aligned, scoreInclClose } = alignWords(expWords, hrdWords);

  // Update session stats
  session.practiced++;
  const passed = scoreInclClose >= passThreshold;
  if (passed) { session.passed++; session.streak++; }
  else        { session.streak = 0; }

  saveBestScore(currentIdx, scoreInclClose);
  updateHeaderStats();
  showFeedback(aligned, scoreInclClose, transcript, passed, fluency);
  setState('feedback');
}

/** Split a sentence into word tokens, removing punctuation. */
function tokenize(sentence) {
  return sentence
    .split(/\s+/)
    .map(w => w.replace(/^[«"'–—\-]+|[.!?,»"':;]+$/g, '').trim())
    .filter(Boolean);
}

// ── small HTML-escape helper (used when inserting user/AI text into innerHTML) ─
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── feedback display ──────────────────────────────────────────────────────────
function showFeedback(aligned, score, transcript, passed, fluency) {
  feedbackArea.hidden  = false;
  processingEl.hidden  = true;
  actionButtons.hidden = false;

  // Word chips (expected sentence, coloured by accuracy)
  wordFeedback.innerHTML = '';
  for (const item of aligned) {
    if (item.status === 'extra') continue;
    const chip = document.createElement('span');
    chip.className   = `word word-${item.status}`;
    chip.textContent = item.expected;
    if (item.heard && item.status !== 'correct') {
      chip.title = `Gehoord: "${item.heard}"`;
    }
    wordFeedback.appendChild(chip);
  }

  // Score row — transcript shown here only when no fluency timing is available
  const emoji      = passed ? '✅' : score >= 60 ? '⚠️' : '❌';
  const badgeClass = passed ? 'score-pass' : score >= 60 ? 'score-warn' : 'score-fail';
  const scoreLabel = passed ? 'Geslaagd!' : `Drempel: ${passThreshold}%`;
  const noFluency  = !fluency?.details?.length;
  scoreRow.innerHTML = `
    <span class="score-badge ${badgeClass}">${emoji} ${score}%</span>
    <span class="score-label">${scoreLabel}</span>
    ${noFluency ? `<span class="transcript-hint">Gehoord: <em>${escapeHtml(transcript || '(niets herkend)')}</em></span>` : ''}
    <button class="score-help-btn" onclick="openModal('scoring')" title="Hoe wordt de score berekend?">?</button>
  `;

  // Fluency row — speed bar + heard words coloured by timing + legend
  if (fluency?.syllablesPerSec != null && fluency.details?.length) {
    const sps      = fluency.syllablesPerSec;
    const spsLabel = sps >= 4.5 ? 'Snel' : sps >= 3.0 ? 'Normaal' : sps >= 2.0 ? 'Langzaam' : 'Zeer langzaam';
    const lit      = Math.min(5, Math.max(1, Math.round(sps)));
    const barCls   = sps >= 3.0 ? 'active-ok' : 'active-slow';
    const bars     = Array.from({length: 5}, (_, i) =>
      `<span${i < lit ? ` class="${barCls}"` : ''}></span>`).join('');

    const n = fluency.details.length;
    const wordsHtml = fluency.details.map((d, i) => {
      const isEdge   = (i === 0 || i === n - 1);
      const hasPause = !isEdge && d.absorbed_ms > 150;

      // Word colour: edge words = grey; paused words = green (pause shown separately);
      // otherwise colour by dur_ratio (how slow the word itself was)
      let wordCls;
      if (isEdge)              wordCls = 'speed-edge';
      else if (hasPause)       wordCls = 'speed-fast';  // pause block handles the signal
      else if (d.dur_ratio > 2.5) wordCls = 'speed-vslow';
      else if (d.dur_ratio > 1.5) wordCls = 'speed-slow';
      else                        wordCls = 'speed-fast';

      const pauseSec  = (d.absorbed_ms / 1000).toFixed(1);
      const pauseCls  = d.absorbed_ms > 800 ? ' pause-long' : d.absorbed_ms > 400 ? ' pause-medium' : '';
      const pauseHtml = hasPause
        ? `<span class="pause-block${pauseCls}" title="Geschatte pauze ~${pauseSec}s">⏸ ${pauseSec}s</span>`
        : '';

      return `${pauseHtml}<span class="heard-word ${wordCls}" title="${d.dur_ms}ms (${d.dur_ratio}× verwacht)">${escapeHtml(d.word)}</span>`;
    }).join('');

    fluencyRow.innerHTML = `
      <div class="fluency-header">
        <span class="fluency-label">🗣 Vloeiendheid:</span>
        <span class="fluency-speed">
          <span class="speed-bar">${bars}</span>
          <b>${spsLabel}</b> <span class="fluency-sps">${sps.toFixed(1)} lgrp/s</span>
        </span>
      </div>
      <div class="fluency-words-row">
        <span class="fluency-words-label">Gehoord:</span>
        <div class="fluency-words">${wordsHtml}</div>
      </div>
      <div class="fluency-legend">
        <span class="fl-item"><span class="fl-dot speed-fast-dot"></span>Vlot</span>
        <span class="fl-item"><span class="fl-dot speed-slow-dot"></span>Aarzelend</span>
        <span class="fl-item"><span class="fl-dot speed-vslow-dot"></span>Traag</span>
        <span class="fl-item"><span class="fl-dot pause-dot"></span>Pauze</span>
        <span class="fl-item"><span class="fl-dot edge-dot"></span>Niet gescoord</span>
      </div>
    `;
    fluencyRow.hidden = false;
  } else {
    fluencyRow.hidden = true;
  }
}

// ── TTS ───────────────────────────────────────────────────────────────────────
function speak(text, onEnd) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.lang   = 'fr-FR';
  utt.rate   = ttsRate;
  if (onEnd) utt.onend = onEnd;
  window.speechSynthesis.speak(utt);
}

// ── volume meter ──────────────────────────────────────────────────────────────
function startVolumeMeter(stream) {
  stopVolumeMeter();
  const volWrap    = document.getElementById('vol-bar-wrap');
  const volInner   = document.getElementById('vol-bar-inner');
  const volWarning = document.getElementById('vol-warning');
  if (!volInner) return;

  try {
    const audioCtx = new AudioContext();
    const source   = audioCtx.createMediaStreamSource(stream);
    _analyser = audioCtx.createAnalyser();
    _analyser.fftSize = 256;
    source.connect(_analyser);
  } catch (_) { return; }

  const buf = new Float32Array(_analyser.fftSize);
  let silentFrames = 0;

  function tick() {
    if (appState !== 'recording') { stopVolumeMeter(); return; }
    _analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);
    const pct = Math.min(100, rms * 400);

    volInner.style.width = pct + '%';
    volInner.classList.toggle('loud',     pct > 60);
    volInner.classList.toggle('clipping', pct > 90);

    silentFrames = rms < 0.015 ? silentFrames + 1 : 0;
    if (volWarning) volWarning.hidden = silentFrames < 45; // ~0.75s silence at 60fps

    _volAnimId = requestAnimationFrame(tick);
  }
  _volAnimId = requestAnimationFrame(tick);
}

function stopVolumeMeter() {
  if (_volAnimId) { cancelAnimationFrame(_volAnimId); _volAnimId = null; }
  if (_analyser)  { try { _analyser.disconnect(); } catch(_){} _analyser = null; }
  const volWrap  = document.getElementById('vol-bar-wrap');
  const volInner = document.getElementById('vol-bar-inner');
  const volWarn  = document.getElementById('vol-warning');
  if (volWrap)  volWrap.hidden  = true;
  if (volInner) volInner.style.width = '0%';
  if (volWarn)  volWarn.hidden  = true;
}

// ── compute-time estimation & deterministic proc progress bar ───────────────────
function getComputeRatio() {
  try {
    const stats = JSON.parse(localStorage.getItem(COMP_STATS_KEY) || '[]');
    if (!stats.length) return COMP_RATIO_DEFAULT;
    const ratios = stats.map(([rec, comp]) => comp / rec).filter(r => isFinite(r) && r > 0);
    if (!ratios.length) return COMP_RATIO_DEFAULT;
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    return median * 1.1;  // +10% safety margin
  } catch { return COMP_RATIO_DEFAULT; }
}

function saveComputeStat(recDur, computeTime) {
  if (recDur <= 0 || computeTime <= 0) return;
  try {
    const stats = JSON.parse(localStorage.getItem(COMP_STATS_KEY) || '[]');
    stats.push([Math.round(recDur * 100) / 100, Math.round(computeTime * 100) / 100]);
    if (stats.length > COMP_STATS_MAX) stats.splice(0, stats.length - COMP_STATS_MAX);
    localStorage.setItem(COMP_STATS_KEY, JSON.stringify(stats));
  } catch { /* quota */ }
}

function startProcBar() {
  const fill = document.getElementById('proc-progress-fill');
  if (!fill) return;
  // No real data yet (first ever exercise) — skip deterministic animation
  const stats = JSON.parse(localStorage.getItem(COMP_STATS_KEY) || '[]');
  if (!stats.length) return;
  // Reset to 0, force reflow, then animate to 99% over estimated duration.
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetWidth;  // force reflow
  const estimatedSec = Math.max(1, getComputeRatio() * Math.max(0.1, _recDuration));
  fill.style.transition = `width ${estimatedSec.toFixed(2)}s linear`;
  fill.style.width = '99%';
}

function stopProcBar(jumpToFull) {
  const fill = document.getElementById('proc-progress-fill');
  if (!fill) return;
  if (jumpToFull) {
    // Snap to 100% with a quick ease-out
    fill.style.transition = 'width 0.2s ease-out';
    fill.style.width = '100%';
  } else {
    // Freeze at current animated position (e.g. on error / cleanup)
    fill.style.transition = 'none';
    fill.style.width = getComputedStyle(fill).width;
  }
}

// ── processing timer ─────────────────────────────────────────────────────────
function startProcTimer() {
  stopProcTimer();
  _procStart = Date.now();
  const timerEl = document.getElementById('proc-timer');
  _procTimerInterval = setInterval(() => {
    const secs = ((Date.now() - _procStart) / 1000).toFixed(1);
    if (timerEl) timerEl.textContent = secs + 's';
  }, 100);
}

function stopProcTimer() {
  clearInterval(_procTimerInterval);
  _procTimerInterval = null;
  const timerEl = document.getElementById('proc-timer');
  if (timerEl) timerEl.textContent = '';
}

// ── state machine ─────────────────────────────────────────────────────────────
function setState(newState) {
  appState = newState;

  // Reset interactive controls to a safe default
  speakBtn.disabled  = true;
  listenBtn.disabled = true;
  skipBtn.hidden     = true;
  speakBtn.classList.remove('recording');
  speakBtn.textContent = '🎤 Spreek';
  listenBtn.textContent = '▶ Luister';

  processingEl.hidden = true;

  switch (newState) {
    case 'idle':
      stopProcTimer();
      stopProcBar(false);
      speakBtn.disabled  = false;
      listenBtn.disabled = false;
      skipBtn.hidden     = false;
      break;

    case 'recording':
      speakBtn.disabled    = false;
      speakBtn.classList.add('recording');
      speakBtn.textContent = '⏹ Stop';
      // Cancel TTS if it was playing
      window.speechSynthesis?.cancel();
      document.getElementById('vol-bar-wrap').hidden = false;
      break;

    case 'processing':
      processingEl.hidden  = false;
      feedbackArea.hidden  = true;
      fluencyRow.hidden    = true;
      actionButtons.hidden = true;
      startProcTimer();
      startProcBar();
      break;

    case 'feedback':
      stopProcTimer();
      speakBtn.disabled  = false;
      listenBtn.disabled = false;
      skipBtn.hidden     = false;
      break;

    case 'loading':
    case 'setup':
      // setup screen is shown; nothing to configure in app controls
      break;
  }
}

// ── fluency analysis ──────────────────────────────────────────────────────────
// Estimates speaking fluency from Whisper word-level timestamps.
//
// KEY INSIGHT: Whisper word timestamps do NOT produce gaps between words.
// Silence is absorbed into the *next* word's timestamp window, inflating its
// duration. Pause detection therefore uses duration excess:
//   absorbed_ms ≈ actual_dur_ms − expected_dur_ms
//
// Penalty thresholds (inner words only; first/last excluded for onset silence):
//   > 150 ms absorbed → slight hesitation  −2 pts
//   > 400 ms absorbed → clear pause        −6 pts
//   > 800 ms absorbed → significant break  −12 pts
//
// Returns: { score, syllablesPerSec, pauseCount, longPauseCount, pauses[], details[] }
function computeFluency(chunks) {
  if (!chunks?.length) return null;

  const words = chunks.filter(c => c.timestamp?.[0] != null && c.timestamp?.[1] != null);
  if (words.length < 2) return { score: null, reason: 'te weinig woorden met timestamps' };

  const SYLLABLE_MS  = 220;  // expected ms per syllable
  const ABS_MILD     = 150;  // absorbed ms → slight hesitation
  const ABS_MODERATE = 400;  // absorbed ms → clear pause
  const ABS_LONG     = 800;  // absorbed ms → significant break

  function countSyllables(w) {
    const clean = w.toLowerCase().replace(/[^a-zàâéèêëîïôùûüœ]/g, '');
    const vowels = clean.match(/[aeiouyàâéèêëîïôùûüœ]+/g) || [];
    let count = vowels.length;
    if (count > 1 && clean.endsWith('e') && !clean.endsWith('ee')) count--;
    return Math.max(1, count);
  }

  let penalties = 0;
  const details = [];

  for (let i = 0; i < words.length; i++) {
    const w      = words[i];
    const text   = w.text.trim();
    const dur    = w.timestamp[1] - w.timestamp[0];       // seconds
    const sylls  = countSyllables(text);
    const expDur = (sylls * SYLLABLE_MS) / 1000;          // seconds
    const durRatio    = expDur > 0 ? dur / expDur : 1;
    const absorbed_ms = Math.max(0, Math.round((dur - expDur) * 1000));

    // Skip first and last word — they include onset/trailing silence
    let pausePenalty = 0;
    const isEdge = (i === 0 || i === words.length - 1);
    if (!isEdge) {
      if (absorbed_ms > ABS_LONG)         pausePenalty = 12;
      else if (absorbed_ms > ABS_MODERATE) pausePenalty = 6;
      else if (absorbed_ms > ABS_MILD)     pausePenalty = 2;
      penalties += pausePenalty;
    }

    details.push({
      word: text, dur_ms: Math.round(dur * 1000),
      exp_ms: Math.round(expDur * 1000), dur_ratio: +durRatio.toFixed(2),
      absorbed_ms, pause_pen: pausePenalty,
    });
  }

  // Rate: inner words only; cap duration at 2.5× expected so absorbed pauses
  // don't collapse the speed estimate
  const rateWords = words.length > 2 ? words.slice(1, -1) : words;
  let rateSylls = 0, rateSec = 0;
  for (const w of rateWords) {
    const sylls  = countSyllables(w.text.trim());
    const expSec = (sylls * SYLLABLE_MS) / 1000;
    const actSec = w.timestamp[1] - w.timestamp[0];
    rateSylls += sylls;
    rateSec   += Math.min(actSec, expSec * 2.5);
  }
  const syllablesPerSec = rateSec > 0 ? rateSylls / rateSec : 0;
  if (syllablesPerSec < 1.5)      penalties += 10;
  else if (syllablesPerSec < 2.5) penalties += 4;

  const innerDetails   = details.slice(1, -1);
  const pauses         = innerDetails.filter(d => d.absorbed_ms > ABS_MILD);
  const longPauseCount = pauses.filter(d => d.absorbed_ms > ABS_LONG).length;
  const score = Math.max(0, Math.min(100, Math.round(100 - penalties)));

  return { score, syllablesPerSec: +syllablesPerSec.toFixed(2),
           pauseCount: pauses.length, longPauseCount, pauses, details };
}

// ── header stats ──────────────────────────────────────────────────────────────
function updateHeaderStats() {
  if (streakEl) {
    streakEl.textContent = session.streak > 0 ? `🔥 ${session.streak}` : '';
  }
  if (practicedEl) {
    practicedEl.textContent = session.practiced > 0 ? `${session.practiced} geoefend` : '';
  }
}

// ── error display ─────────────────────────────────────────────────────────────
function showError(msg) {
  feedbackArea.hidden  = false;
  processingEl.hidden  = true;
  actionButtons.hidden = false;
  wordFeedback.innerHTML = '';
  fluencyRow.hidden    = true;
  scoreRow.innerHTML = `<span class="score-badge score-fail">⚠️ ${msg}</span>`;
  setState('feedback');
}

// ── settings panel ────────────────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => {
  settingsPanel.hidden = !settingsPanel.hidden;
});

changeModelBtn?.addEventListener('click', () => {
  settingsPanel.hidden = true;
  goToSetup();
});

thresholdInput?.addEventListener('change', () => {
  passThreshold = Math.min(100, Math.max(0, parseInt(thresholdInput.value) || DEFAULT_THRESH));
  thresholdInput.value = passThreshold;
  savePrefs();
});

ttsRateSelect?.addEventListener('change', () => {
  ttsRate = parseFloat(ttsRateSelect.value) || DEFAULT_TTS_RATE;
  savePrefs();
});

[gpuPrefSetup, gpuPrefSettings].forEach(el => {
  el?.addEventListener('change', () => {
    gpuPref = el.value;
    // Sync both selects
    if (gpuPrefSetup)    gpuPrefSetup.value    = gpuPref;
    if (gpuPrefSettings) gpuPrefSettings.value = gpuPref;
    savePrefs();
  });
});

// ── main button events ────────────────────────────────────────────────────────
loadModelBtn.addEventListener('click', startLoadModel);

speakBtn.addEventListener('click', () => {
  if (appState === 'idle' || appState === 'feedback') startRecording();
  else if (appState === 'recording')                  stopRecording();
});

listenBtn.addEventListener('click', () => {
  const s = currentSentence();
  if (!s) return;

  if (window.speechSynthesis?.speaking) {
    window.speechSynthesis.cancel();
    listenBtn.textContent = '▶ Luister';
    return;
  }
  listenBtn.textContent = '⏸ Stop';
  speak(s, () => { listenBtn.textContent = '▶ Luister'; });
});

skipBtn.addEventListener('click', advanceSentence);

replayBtn.addEventListener('click', () => {
  const s = currentSentence();
  if (s) speak(s);
});

retryBtn.addEventListener('click', () => {
  hideFeedback();
  setState('idle');
});

nextBtn.addEventListener('click', advanceSentence);

// ── init ──────────────────────────────────────────────────────────────────────
function init() {
  if (typeof window.CHAPTERS === 'undefined' || !window.CHAPTERS.length) {
    // sentences.js failed to load or is empty — show setup anyway
    console.warn('CHAPTERS not found. Run the extraction script.');
  }

  loadPrefs();
  detectGPU();

  // Auto-load the previously used model
  const savedModel = localStorage.getItem(SK + 'model');
  if (savedModel && MODELS[savedModel]) {
    selectedModel = savedModel;
    modelRadios.forEach(r => { r.checked = (r.value === selectedModel); });
    startLoadModel();
  }
}

init();

// ── GPU detection & model recommendation ────────────────────────────────────
async function detectGPU() {
  const banner      = document.getElementById('webgpu-banner');
  const msgEl       = document.getElementById('webgpu-msg');
  const recEl       = document.getElementById('gpu-rec');
  if (!banner || !msgEl || !recEl) return;

  const isMobile    = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const hasSaved    = !!localStorage.getItem(SK + 'model');

  // Mobile OS: warn regardless of GPU
  if (isMobile) {
    banner.classList.add('mobile');
    msgEl.textContent = '📱 Mobiel toestel gedetecteerd. Herkenning zal trager zijn; WebGPU is vaak niet beschikbaar. Voor de beste ervaring gebruik je een desktop of laptop.';
    banner.hidden = false;
    recommendModel('tiny', 'Mobiel toestel — whisper-tiny aanbevolen voor snelheid.', recEl, hasSaved);
    return;
  }

  if (gpuPref !== 'wasm' && !('gpu' in navigator)) {
    msgEl.textContent = '⚠️ WebGPU niet beschikbaar in deze browser. Herkenning via WebAssembly (trager). Gebruik Chrome 113+ of Edge 113+.';
    banner.hidden = false;
    recommendModel('tiny', 'Geen WebGPU — whisper-tiny aanbevolen voor snelheid.', recEl, hasSaved);
    return;
  }

  // Probe adapter (skip if user explicitly chose WASM)
  if (gpuPref === 'wasm') {
    recommendModel('tiny', 'WASM (CPU) geselecteerd — whisper-tiny aanbevolen voor snelheid.', recEl, hasSaved);
    return;
  }

  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (_) {}

  if (!adapter) {
    msgEl.textContent = '⚠️ Geen GPU-adapter gevonden (ontbrekende Vulkan-drivers?). Herkenning via WASM.';
    banner.hidden = false;
    recommendModel('tiny', 'Geen GPU-adapter — whisper-tiny aanbevolen.', recEl, hasSaved);
    return;
  }

  let info = { vendor: '', device: '', description: '' };
  try { info = await adapter.requestAdapterInfo(); } catch (_) {}

  const tier = classifyAdapter(info);
  const name = info.description || info.vendor || 'GPU';

  if (tier === 'discrete') {
    recommendModel('small',
      `Dedicated GPU gedetecteerd (${name}) — whisper-small aanbevolen voor hogere nauwkeurigheid.`,
      recEl, hasSaved);
  } else {
    recommendModel('tiny',
      `Geïntegreerde GPU (${name}) — whisper-tiny aanbevolen voor snelheid.`,
      recEl, hasSaved);
  }
}

function classifyAdapter({ vendor = '', device = '', description = '' }) {
  const s = (vendor + ' ' + device + ' ' + description).toLowerCase();
  if (s.includes('nvidia') || s.includes('geforce') || s.includes('quadro') || s.includes('tesla')) return 'discrete';
  if (/radeon.{0,10}rx\s?[5-9]/.test(s) || /rx\s?[5-9]/.test(s)) return 'discrete'; // Radeon RX 5xxx/6xxx/7xxx
  if (s.includes('intel arc')) return 'discrete'; // Intel Arc A/B-series
  return 'integrated'; // Intel UHD/Iris, AMD Vega/680M, Apple, etc.
}

function recommendModel(which, message, recEl, hasSaved) {
  const targetValue = which === 'tiny' ? 'Xenova/whisper-tiny' : 'Xenova/whisper-small';
  document.querySelectorAll('.model-option').forEach(label => {
    const radio = label.querySelector('input[type="radio"]');
    if (radio && radio.value === targetValue) label.classList.add('recommended');
    else label.classList.remove('recommended');
  });
  // Auto-select only on first visit (no saved model)
  if (!hasSaved) {
    modelRadios.forEach(r => { r.checked = (r.value === targetValue); });
  }
  recEl.textContent = '💡 ' + message;
  recEl.hidden = false;
}

// ── modal ────────────────────────────────────────────────────────────────────
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle   = document.getElementById('modal-title');
const modalBody    = document.getElementById('modal-body');
const modalClose   = document.getElementById('modal-close');

const modalContents = {
  data: {
    title: 'ℹ️ Gegevensgebruik',
    html: `
      <p><strong>Spraakopnames</strong> worden verwerkt <em>volledig lokaal</em> in je browser
      via het Whisper-model. Er wordt <strong>geen audio</strong> doorgestuurd naar externe servers.</p>
      <p>Het Whisper-model wordt bij het eerste gebruik gedownload van
      <strong>Hugging Face</strong> en daarna gecached in je browser. Na de eerste download
      werkt de app volledig offline.</p>
      <p>Oefenvoortgang (beste score per zin) wordt opgeslagen in
      <strong>localStorage</strong> van je eigen browser — enkel op dit apparaat, niet in de cloud.</p>
      <p>Daarnaast worden <strong>anonieme gebruiksstatistieken</strong> verzameld via
      <strong>Cloudflare Web Analytics</strong>: er worden <strong>geen cookies</strong> geplaatst
      en <strong>geen persoonlijke gegevens</strong> opgeslagen.</p>
    `
  },
  auteur: {
    title: '✉️ Auteur',
    html: `
      <p><strong>Geert Vandeweyer</strong><br>
      <a href="mailto:geertvandeweyer@gmail.com">geertvandeweyer@gmail.com</a></p>
      <p>Gemaakt in mei 2026</p>
      <p>Ontwikkeld met behulp van Claude Sonnet 4.6</p>
    `
  },
  licentie: {
    title: '📄 Licentie',
    html: `
      <p>Deze app is <strong>vrij te gebruiken, te kopiëren en aan te passen</strong>.</p>
      <p>Gepubliceerd onder de
      <strong><a href="https://opensource.org/licenses/MIT" target="_blank" rel="noopener">MIT-licentie</a></strong>:
      je mag de broncode vrij hergebruiken, ook voor commerciële doeleinden, zolang de
      oorspronkelijke auteursnaam vermeld blijft.</p>
      <p>Geen garanties van welke aard dan ook.</p>
    `
  },
  scoring: {
    title: '📊 Hoe wordt de score berekend?',
    html: `
      <h4 style="margin:0 0 6px">Woordkleuren (bovenste rij)</h4>
      <p>Elk <em>verwacht</em> woord wordt vergeleken met het gehoorde woord via
      <strong>Levenshtein-afstand</strong> (aantal karakter-bewerkingen om van het ene woord naar
      het andere te gaan):</p>
      <ul style="margin:6px 0 12px;padding-left:1.2em">
        <li><strong style="color:#166534">Groen</strong> — gelijkenis ≥ 85 % → correct</li>
        <li><strong style="color:#92400e">Oranje</strong> — gelijkenis 60–85 % → bijna goed</li>
        <li><strong style="color:#991b1b">Rood</strong> — gelijkenis &lt; 60 % of woord gemist</li>
      </ul>
      <h4 style="margin:0 0 6px">Totaalscore</h4>
      <p><code>(correcte + bijna&nbsp;goede woorden) ÷ totaal verwachte woorden × 100 %</code></p>
      <p>De drempel voor "geslaagd" is instelbaar (standaard 80 %).</p>
      <h4 style="margin:0 0 6px">Uitlijning (Needleman-Wunsch)</h4>
      <p>Bij verkeerde volgorde of weggelaten woorden gebruikt de app een
      <strong>globale sequentie-uitlijning</strong> om verwachte en gehoorde woorden zo goed
      mogelijk te koppelen voor het scoren.</p>
      <h4 style="margin:0 0 6px">Vloeiendheid (onderste rij)</h4>
      <p>Whisper geeft per woord een tijdstempel terug. Woorden waarbij Whisper meer tijd
      registreerde dan verwacht op basis van het aantal lettergrepen (±&nbsp;220&nbsp;ms/lgrp)
      worden gekleurd als <strong>aarzelend</strong> of <strong>traag</strong>.
      Grotere overschrijdingen worden als blauwe <em>pauzeblokken</em> getoond.</p>
    `
  },
  koffie: {
    title: '☕ Buy me a coffee',
    html: `
      <p style="text-align:center">
        <a href="https://buymeacoffee.com/geertvandeweyer" target="_blank" rel="noopener">
          <img src="assets/img/qr-code.png" alt="QR-code Buy Me a Coffee"
               style="width:200px;height:200px;border-radius:8px">
        </a>
      </p>
      <p style="text-align:center;margin-top:12px">
        <a href="https://buymeacoffee.com/geertvandeweyer" target="_blank" rel="noopener"
           style="font-weight:bold">buymeacoffee.com/geertvandeweyer</a>
      </p>
      <p style="margin-top:12px;font-size:.9em;color:#555">
        Scan de QR-code of klik de link hierboven om een kleine bijdrage te geven — als bedankje,
        zonder verplichtingen.
      </p>
    `
  }
};

function openModal(key) {
  const content = modalContents[key];
  if (!content || !modalOverlay) return;
  modalTitle.textContent = content.title;
  modalBody.innerHTML    = content.html;
  modalOverlay.hidden    = false;
  modalClose.focus();
}

function closeModal() {
  if (modalOverlay) modalOverlay.hidden = true;
}

document.querySelectorAll('.disc-btn[data-modal]').forEach(btn => {
  btn.addEventListener('click', () => openModal(btn.dataset.modal));
});

if (modalClose) modalClose.addEventListener('click', closeModal);

if (modalOverlay) {
  modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeModal();
  });
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modalOverlay && !modalOverlay.hidden) closeModal();
});
