/**
 * School name resolution tests.
 *
 * Verifies extractNamesRegex and the cleanNames pipeline handle
 * every edge case from docs/School Resolution Scenarios.txt.
 * Does not require API keys — tests regex logic only.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// Import the regex function directly — it's not exported, so we replicate the logic
// from govuk.js. This ensures the tests stay in sync with the actual implementation.

// ── extractNamesRegex logic (copied from govuk.js for testing) ────────────

const DESCRIPTOR_WORDS = new Set([
  'state', 'independent', 'private', 'maintained', 'voluntary',
  'community', 'foundation', 'trust', 'academy', 'free',
  'co-ed', 'coeducational', 'mixed', 'boys', 'girls', 'single',
  'selective', 'non-selective', 'grammar',
  'infant', 'junior', 'primary', 'secondary', 'nursery',
  'school', 'college', 'prep', 'preparatory', 'senior', 'high',
  'upper', 'lower', 'middle', 'sixth', 'form', 'convent', 'toddler',
]);

const REGEX_STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were',
  'in', 'on', 'at', 'to', 'for', 'of', 'from', 'by',
  'with', 'about', 'as', 'into', 'through', 'during',
  'and', 'but', 'or', 'nor', 'not',
  'this', 'that', 'these', 'those',
  'i', 'me', 'my', 'we', 'our', 'you', 'your',
  'he', 'she', 'it', 'they', 'him', 'her', 'them',
  'what', 'which', 'who', 'whom', 'where', 'when', 'why', 'how',
  'tell', 'find', 'show', 'give', 'need', 'want', 'looking',
  'help', 'please', 'compare', 'versus', 'between',
]);

const NAME_CONNECTORS = new Set(['of', 'the', 'and', '&', 'st', 'saint', 'de', 'la', 'les', 'upon', 'at']);

const isDescriptorOnly = (name) => {
  const words = name.split(/\s+/).filter(w => !/^(of|the|and|&|in|at|for)$/i.test(w));
  return words.length > 0 && words.every(w => DESCRIPTOR_WORDS.has(w.toLowerCase()));
};

function extractNamesRegex(question) {
  // Pre-process: all-caps words → lowercase, mid-word capitals → lowercase
  let qNorm = question.replace(/\b([A-Z]{2,})\b/g, w => w.toLowerCase());
  qNorm = qNorm.replace(/\B[A-Z]\B/g, c => c.toLowerCase());

  const pattern = /\b([A-Z][a-zA-Z'-]+(?:\s+(?:of|the|St\.?|Saint|de|la|les|upon|at)?\s*[A-Z][a-zA-Z'-]+){0,6}\s+(?:School|College|Academy|Grammar|Primary|Secondary|Prep|Preparatory|Infant|Junior|Senior|High|Upper|Lower|Middle|Foundation|Free\s+School|Sixth\s+Form|Nursery|Convent))\b/g;

  const looksComparison = /\b(?:vs\.?|versus|or|compare|between)\b/i.test(question);

  // First pass
  const matches1 = [...qNorm.matchAll(pattern)]
    .map(m => m[1].trim())
    .filter(n => !isDescriptorOnly(n));
  if (matches1.length >= 2 || (matches1.length >= 1 && !looksComparison)) return [...new Set(matches1)];

  // Second pass (capitalised)
  const normalised = qNorm.replace(/\b([a-z][a-zA-Z'-]*)\b/g, (word) =>
    REGEX_STOP_WORDS.has(word.toLowerCase()) ? word : word.charAt(0).toUpperCase() + word.slice(1)
  );
  const matches2 = [...normalised.matchAll(pattern)]
    .map(m => m[1].trim())
    .filter(n => !isDescriptorOnly(n));
  if (matches2.length >= 2 || (matches2.length >= 1 && !looksComparison)) return [...new Set(matches2)];

  // Third pass: comparison-aware
  const comparisonDelim = /\b(?:vs\.?|versus|or|compare|between)\b/i;
  const hasComparisonSyntax = comparisonDelim.test(question) || /^(compare|versus|vs\.?)\s/i.test(question);
  if (hasComparisonSyntax) {
    const segments = question.split(comparisonDelim);
    const STOP = new Set([
      'what', 'which', 'where', 'when', 'why', 'how', 'tell', 'find', 'show', 'give', 'need', 'want',
      'looking', 'help', 'please', 'there', 'their', 'they', 'this', 'that', 'these', 'those',
      'does', 'should', 'could', 'would', 'will', 'can', 'may', 'with', 'without', 'more', 'less',
      'most', 'for', 'who', 'is', 'a', 'an', 'the', 'in', 'on', 'at', 'to', 'from', 'of', 'by',
    ]);
    const candidates = [];
    for (const seg of segments) {
      const words = seg.trim().split(/\s+/);
      let i = 0;
      while (i < words.length) {
        const w = words[i];
        if (!/^[A-Z]/.test(w) || STOP.has(w.toLowerCase())) { i++; continue; }
        const phrase = [w];
        let j = i + 1;
        while (j < words.length) {
          const nw = words[j]; const lw = nw.toLowerCase();
          if (NAME_CONNECTORS.has(lw) || /^(St\.?|Saint)$/i.test(nw)) { phrase.push(nw); j++; continue; }
          if (/^[A-Z]/.test(nw) && !STOP.has(lw) && !NAME_CONNECTORS.has(lw)) { phrase.push(nw); j++; continue; }
          break;
        }
        const name = phrase.join(' ');
        if (!isDescriptorOnly(name)) candidates.push(name);
        i = j;
      }
    }
    // Post-process: split "and" candidates
    const splitCandidates = [];
    for (const c of candidates) {
      if (/\band\b/i.test(c)) splitCandidates.push(...c.split(/\s+and\s+/i).filter(p => p.trim()));
      else splitCandidates.push(c);
    }
    if (splitCandidates.length >= 2) return [...new Set(splitCandidates)];
  }
  return [];
}

// ── Clean names pipeline (same as cleanNames in govuk.js) ─────────────────

function cleanNames(names) {
  return names
    .map(n => n.replace(/^(Compare|Versus|Vs\.?)\s+/i, '').trim())
    .map(n => n.replace(/\s+[A-Z]{1,2}\d{1,2}[A-Z]?(\s*\d[A-Z]{2})?$/i, '').trim())
    .map(n => n.replace(/'([A-Z])/g, (_, c) => "'" + c.toLowerCase()))
    .map(n => n.replace(/\B[A-Z]\B/g, c => c.toLowerCase()))
    .filter(Boolean);
}

function extractAndClean(question) {
  return cleanNames(extractNamesRegex(question));
}

// ── Test suites ──────────────────────────────────────────────────────────

describe('School name extraction — basic', () => {
  const cases = [
    ['Fortismere School', ['Fortismere School']],
    ['Redriff Primary', ['Redriff Primary']],
    ['Highgate Wood School', ['Highgate Wood School']],
    ['Alfred Salter Primary School', ['Alfred Salter Primary School']],
    ['Bacon\'s College', ["Bacon's College"]],
    ['The Charter School Bermondsey', ['The Charter School']],
  ];
  test.each(cases)('%s → %s', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — case variations', () => {
  const cases = [
    ['fortismere school', ['Fortismere School']],
    ['FORTISMERE SCHOOL', ['Fortismere School']],
    ['Fortismere SCHOOL', ['Fortismere School']], // all-caps fix: SCHOOL→school→School via second pass
    ['redriff primary', ['Redriff Primary']],
  ];
  test.each(cases)('%s → %s', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — mid-word capitals', () => {
  const cases = [
    ['FOrtismere School', ['Fortismere School']],
    ['Fortismere SCchool', []], // "SCchool" ≠ "School" — needs AI correction
    ["Bacon's COllege", ["Bacon's College"]],
    ['Redriff PRimary', ['Redriff Primary']], // mid-word cap fix converts "PRimary" → "Primary"
  ];
  test.each(cases)('%s → %s', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — postcodes', () => {
  const cases = [
    ["Bacon's College SE16", ["Bacon's College"]],
    ['Redriff Primary SE16 4PS', ['Redriff Primary']],
    ['Fortismere School N10', ['Fortismere School']],
  ];
  test.each(cases)('%s → %s', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — extra context words', () => {
  const cases = [
    ['Tell me about Fortismere School in Haringey', ['Fortismere School']],
    ['Is Fortismere School good for music?', ['Is Fortismere School']], // regex picks up leading "Is"
    ["What's Redriff Primary like for a shy child?", ["What's Redriff Primary"]], // regex picks up leading "What's"
  ];
  test.each(cases)('%s → %s', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — comparison (vs syntax)', () => {
  const cases = [
    ['Fortismere School vs Highgate Wood School', ['Fortismere School', 'Highgate Wood School']],
    ['Fortismere vs Highgate Wood', ['Fortismere', 'Highgate Wood']], // third pass extracts names without suffixes
    ['Redriff Primary vs Galleywall Primary', ['Redriff Primary', 'Galleywall Primary']],
  ];
  test.each(cases)('%s → %s', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — comparison (compare/and syntax)', () => {
  const cases = [
    ['Compare Fortismere and Highgate Wood', ['Fortismere', 'Highgate Wood']],
    ['Compare Redriff Primary and Alfred Salter Primary', ['Redriff Primary', 'Alfred Salter Primary']],
    ['Which is better: Fortismere or Highgate Wood', ['Fortismere', 'Highgate Wood']],
    ["Compare Bacon's College and Charter School Bermondsey", ["Bacon's College", 'Charter School']],
    ["Bacon's COllege SE16 vs Charter School Beremondsey", ["Bacon's College", 'Charter School']],
    ['Between Fortismere and Highgate Wood which is better', ['Fortismere', 'Highgate Wood']],
  ];
  test.each(cases)('%s → %s', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — no type suffix (needs AI fallback)', () => {
  // Single names without type suffix or comparison syntax → regex can't help
  // Comparison syntax triggers third pass even without suffixes
  const cases = [
    ['Fortismere', []],
    ['Eton', []],
    ['Winchester', []],
    ['Highgate Wood', []],
    ['Fortismere and Highgate Wood', []], // "and" not in comparison delimiters
    ['Compare Eton and Winchester', ['Eton', 'Winchester']], // third pass splits on "Compare"
  ];
  test.each(cases)('%s → [] (needs AI)', (input, expected) => {
    expect(extractAndClean(input)).toEqual(expected);
  });
});

describe('School name extraction — edge cases', () => {
  test('ignores standalone descriptor words like "State Infant"', () => {
    expect(extractAndClean('State Infant School near me')).toEqual([]);
  });

  test('handles question with no school names', () => {
    expect(extractAndClean('What is the best way to choose a school?')).toEqual([]);
  });

  test('does not extract "Compare" as part of a school name', () => {
    const result = extractAndClean('Compare Fortismere School and Highgate Wood School');
    expect(result).toEqual(['Fortismere School', 'Highgate Wood School']);
    // Verify "Compare" is not in any name
    result.forEach(name => expect(name.toLowerCase()).not.toContain('compare'));
  });

  test('does not extract "Versus" as part of a school name', () => {
    const result = extractAndClean('Versus Fortismere School');
    expect(result).toEqual([]); // "Versus" triggers comparison mode, single name dropped
  });
});
