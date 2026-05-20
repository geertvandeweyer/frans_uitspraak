'use strict';

// ── Needleman-Wunsch word-level alignment + Levenshtein scoring ────────────
// Used by app.js to compare expected sentence with Whisper transcript.
// All functions are global (loaded as plain <script> before app.js).

/**
 * Levenshtein edit distance between two strings (character level).
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  // Use two-row rolling array for memory efficiency
  let prev = new Int32Array(n + 1);
  let curr = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Normalized similarity score [0..1] between two strings.
 */
function wordSimilarity(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Normalize a word for comparison:
 * lowercase → strip diacritics → strip non-alphanumeric.
 */
function normalizeWord(w) {
  return w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .replace(/[^a-z0-9]/g, '');      // strip punctuation / apostrophes
}

/**
 * Align `expected` word array against `heard` word array using
 * Needleman-Wunsch global sequence alignment.
 *
 * Scoring:
 *   - match/mismatch: similarity * 2 - 1  → +1 (perfect) … -1 (total mismatch)
 *   - gap penalty: -0.4
 *
 * Returns:
 *   aligned  — Array<{ expected, heard, sim, status }>
 *     status: 'correct' (sim ≥ 0.85)
 *             'close'   (0.60 ≤ sim < 0.85)
 *             'wrong'   (sim < 0.60, both present)
 *             'missing' (expected word absent from transcript)
 *             'extra'   (transcript word not in expected — not shown in UI)
 *   score          — % of expected words with status 'correct'
 *   scoreInclClose — % of expected words with status 'correct' or 'close'
 */
function alignWords(expected, heard) {
  const m = expected.length;
  const n = heard.length;
  const GAP = -0.4;

  // Build (m+1) × (n+1) score and traceback matrices
  const S = Array.from({ length: m + 1 }, () => new Float32Array(n + 1));
  const T = Array.from({ length: m + 1 }, () => new Uint8Array(n + 1));
  // T values: 0 = diagonal (match/mismatch), 1 = up (gap in heard), 2 = left (gap in expected)

  for (let i = 0; i <= m; i++) { S[i][0] = i * GAP; T[i][0] = 1; }
  for (let j = 0; j <= n; j++) { S[0][j] = j * GAP; T[0][j] = 2; }
  T[0][0] = 0;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const sim       = wordSimilarity(normalizeWord(expected[i - 1]), normalizeWord(heard[j - 1]));
      const diagScore = S[i - 1][j - 1] + (sim * 2 - 1);
      const upScore   = S[i - 1][j]     + GAP;
      const leftScore = S[i][j - 1]     + GAP;

      if (diagScore >= upScore && diagScore >= leftScore) {
        S[i][j] = diagScore; T[i][j] = 0;
      } else if (upScore >= leftScore) {
        S[i][j] = upScore;   T[i][j] = 1;
      } else {
        S[i][j] = leftScore; T[i][j] = 2;
      }
    }
  }

  // Traceback from (m, n) to (0, 0)
  const aligned = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i === 0) {
      aligned.push({ expected: null, heard: heard[j - 1], sim: 0, status: 'extra' });
      j--;
    } else if (j === 0) {
      aligned.push({ expected: expected[i - 1], heard: null, sim: 0, status: 'missing' });
      i--;
    } else {
      const t = T[i][j];
      if (t === 0) {
        const expW   = expected[i - 1];
        const hrdW   = heard[j - 1];
        const sim    = wordSimilarity(normalizeWord(expW), normalizeWord(hrdW));
        const status = sim >= 0.85 ? 'correct' : sim >= 0.60 ? 'close' : 'wrong';
        aligned.push({ expected: expW, heard: hrdW, sim, status });
        i--; j--;
      } else if (t === 1) {
        aligned.push({ expected: expected[i - 1], heard: null, sim: 0, status: 'missing' });
        i--;
      } else {
        aligned.push({ expected: null, heard: heard[j - 1], sim: 0, status: 'extra' });
        j--;
      }
    }
  }
  aligned.reverse();

  // Score calculation (based on expected words only)
  const expEntries = aligned.filter(a => a.expected !== null);
  const correct    = expEntries.filter(a => a.status === 'correct').length;
  const close      = expEntries.filter(a => a.status === 'close').length;
  const total      = expEntries.length;

  return {
    aligned,
    score:          total ? Math.round(100 * correct / total) : 0,
    scoreInclClose: total ? Math.round(100 * (correct + close) / total) : 0,
  };
}
