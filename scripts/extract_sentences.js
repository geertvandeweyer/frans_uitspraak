// Extract French sentences from En action 5 PDFs
// Usage: cd scripts && npm install && node extract_sentences.js
//
// NOTE: Requires text-based PDFs (not scanned images).
// If extraction yields garbage text, the PDFs may need OCR first.
// Output: ../js/sentences.js (overwritten each run — backup manual edits first)

'use strict';

const pdfParse = require('pdf-parse');
const fs       = require('fs');
const path     = require('path');

const INPUT_DIR   = path.join(__dirname, '..', 'input');
const OUTPUT_FILE = path.join(__dirname, '..', 'js', 'sentences.js');

// Map PDF filename fragments → chapter group titles
// Dictionaries and grammar are skipped (no useful sentences)
const CHAPTER_MAP = [
  { match: '00 p01',    title: 'Introductie' },
  { match: '01-08 p10', title: 'Hoofdstukken 1–8' },
  { match: '09-16 p39', title: 'Hoofdstukken 9–16' },
  { match: '17-20 p71', title: 'Hoofdstukken 17–20' },
];

// ── helpers ────────────────────────────────────────────────────────────────

// French-specific words that don't appear in Dutch — used to detect French sentences
const FRENCH_WORDS = new Set([
  'avec', 'dans', 'mais', 'très', 'aussi', 'après', 'avant', 'encore', 'toujours',
  'jamais', 'souvent', 'parfois', 'maintenant', 'puis', 'donc', 'voici', 'voilà',
  'bonjour', 'bonsoir', 'bonne', 'merci', 'monsieur', 'madame', 'mademoiselle',
  'suis', 'sommes', 'êtes', 'sont', 'avoir', 'faites', 'dites', 'regardez',
  'écoutez', 'lisez', 'écrivez', 'répondez', 'prenez', 'allons', 'parce',
  'quand', 'parler', 'faire', 'aller', 'venir', 'voir', 'pouvoir', 'vouloir',
  'savoir', 'partir', 'prendre', 'comprendre', 'apprendre', 'français',
  'française', 'toute', 'tous', 'beaucoup', 'peu', 'assez', 'trop', 'bien',
  'mal', 'mieux', 'peux', 'peut', 'veux', 'veut', 'dois', 'doit', 'vas',
  'elle', 'elles', 'nous', 'vous', 'leur', 'leurs', 'mon', 'ton', 'son',
  'notre', 'votre', 'mes', 'tes', 'ses', 'nos', 'vos', 'une', 'les', 'des',
  'est', 'une', 'sur', 'sous', 'entre', 'chez', 'depuis', 'pendant', 'sans',
  "c'est", "j'ai", "j'habite", "j'aime", "tu es", "il est", "elle est",
  "qu'est", "n'est", "il y", "qu'il", "qu'elle",
]);

// Dutch-specific words that are rare/absent in French — used to reject Dutch
const DUTCH_WORDS = new Set([
  'ik', 'jij', 'hij', 'zij', 'wij', 'jullie',
  'het', 'zijn', 'wordt', 'worden', 'hebben', 'heeft',
  'niet', 'ook', 'maar', 'want', 'omdat', 'waarbij',
  'dit', 'dat', 'die', 'deze', 'door', 'naar',
  'voor', 'achter', 'naast', 'tussen', 'boven', 'onder',
  'kunnen', 'mogen', 'moeten', 'zullen', 'horen',
  'leren', 'kennen', 'staan', 'liggen', 'zien', 'gaan',
  'boek', 'bladzijde', 'leerjaar', 'klas', 'school',
  'woorden', 'zinnen', 'tekst', 'oefening',
]);

function hasFrenchWord(tokens) {
  for (const tok of tokens) {
    if (FRENCH_WORDS.has(tok)) return true;
    // Apostrophe contractions like j', c', l', d', n', s', m', t'
    if (/^[jclndsmtJCLNDSMT]'/.test(tok)) return true;
  }
  return false;
}

function hasDutchWord(tokens) {
  for (const tok of tokens) {
    if (DUTCH_WORDS.has(tok)) return true;
  }
  return false;
}

/** Return true if the trimmed line looks like a French sentence. */
function isSentence(line) {
  const t = line.trim();
  if (t.length < 10 || t.length > 280) return false;
  // Skip lines that are all digits (page numbers, exercise numbers)
  if (/^\d[\d\s.]*$/.test(t)) return false;
  // Skip ALL-CAPS headings
  if (/[A-Z]{5,}/.test(t) && t === t.toUpperCase()) return false;
  // Must contain at least one lowercase letter
  if (!/[a-zàâäéèêëîïôùûüç]/.test(t)) return false;
  // Must start with a capital, quote, or dialogue dash
  if (!/^[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜÇ«"–—\-]/.test(t)) return false;
  // Skip vocabulary entries like "word — translation"
  if (/^\w+\s+[–—]\s+\w+$/.test(t)) return false;
  // Skip copyright / ISBN lines
  if (/ISBN|©|www\.|NUR \d|D\/\d/.test(t)) return false;

  // Tokenize for language detection
  const tokens = t.toLowerCase()
    .replace(/['']/g, "'")
    .split(/[\s,;:!?.«»"()\[\]]+/)
    .filter(Boolean);

  // Must look French; must not be clearly Dutch
  return hasFrenchWord(tokens) && !hasDutchWord(tokens);
}

/**
 * Split a block of extracted PDF text into individual sentences.
 * Handles line wrapping, soft hyphens, and common PDF artefacts.
 */
function extractSentences(rawText) {
  // Normalize line endings; collapse multiple blank lines
  const text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    // Soft hyphen at end of line → join with next line
    .replace(/-\n([a-zàâäéèêëîïôùûüç])/g, '$1');

  const results = [];

  // Process paragraph by paragraph
  for (const para of text.split('\n\n')) {
    // Join wrapped lines within a paragraph
    const joined = para.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // Split on sentence-ending punctuation followed by whitespace + capital
    // Handles "Bonjour ! Comment..." and "Il part. Elle reste."
    const parts = joined.split(/(?<=[.!?»])\s+(?=[A-ZÀÂÄÉÈÊËÎÏÔÙÛÜÇ«"–—])/);

    for (const part of parts) {
      const t = part.trim();
      if (isSentence(t)) results.push(t);
    }
  }

  // Deduplicate while preserving order
  return [...new Map(results.map(s => [s.toLowerCase(), s])).values()];
}

// ── main ───────────────────────────────────────────────────────────────────

async function processPDF(filePath) {
  const data   = fs.readFileSync(filePath);
  const parsed = await pdfParse(data);
  return extractSentences(parsed.text);
}

async function main() {
  const allFiles = fs.readdirSync(INPUT_DIR)
    .filter(f => f.endsWith('.pdf'))
    .sort();

  const chapters = [];

  for (const file of allFiles) {
    const entry = CHAPTER_MAP.find(e => file.includes(e.match));
    if (!entry) {
      console.log(`Skipping: ${file}`);
      continue;
    }

    console.log(`Processing: ${file}`);
    try {
      const sentences = await processPDF(path.join(INPUT_DIR, file));
      console.log(`  → ${sentences.length} sentences`);
      chapters.push({
        id:        `ch${chapters.length}`,
        title:     entry.title,
        sentences,
      });
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  if (!chapters.length) {
    console.error('No chapters extracted. Check PDF filenames match CHAPTER_MAP.');
    process.exit(1);
  }

  const total  = chapters.reduce((n, c) => n + c.sentences.length, 0);
  const output = [
    '// Auto-generated by scripts/extract_sentences.js',
    `// ${new Date().toISOString().slice(0, 10)} — ${total} sentences in ${chapters.length} chapter groups`,
    '// Manual edits welcome. Re-running this script will OVERWRITE this file.',
    '/* global window */',
    `window.CHAPTERS = ${JSON.stringify(chapters, null, 2)};`,
    '',
  ].join('\n');

  fs.writeFileSync(OUTPUT_FILE, output, 'utf8');
  console.log(`\nWrote ${OUTPUT_FILE}`);
  console.log(`Total: ${total} sentences across ${chapters.length} chapters`);
}

main().catch(err => { console.error(err); process.exit(1); });
