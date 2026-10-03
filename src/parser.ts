import type { VocabularyItem, LearningRecord } from './types';

function createEmptyLearning(): LearningRecord {
  return {
    totalReviews: 0, correctCount: 0, incorrectCount: 0, unsureCount: 0,
    lastReviewed: null, lastAnswer: null, consecutiveCorrect: 0, learningLevel: 0,
    currentInterval: 0, nextReviewDate: null, reviewHistory: [], starred: false
  };
}

function generateId(): string { return crypto.randomUUID(); }

function cleanLatex(text: string): string {
  if (!text) return '';
  let t = text;
  t = t.replace(/\\&/g, '&');
  t = t.replace(/\\'([eE])/g, (_, c) => c === 'E' ? 'É' : 'é');
  t = t.replace(/\\`([eE])/g, (_, c) => c === 'E' ? 'È' : 'è');
  t = t.replace(/\\"([eE])/g, (_, c) => c === 'E' ? 'Ë' : 'ë');
  t = t.replace(/\\~([nN])/g, (_, c) => c === 'N' ? 'Ñ' : 'ñ');
  t = t.replace(/\\c\{([cC])\}/g, (_, c) => c === 'C' ? 'Ç' : 'ç');
  t = t.replace(/\\(?:small|large)\b/g, '');
  t = t.replace(/\\(?:textbf|textit|emph)\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\[a-zA-Z]+\{([^{}]*)\}/g, '$1');
  t = t.replace(/\\[a-zA-Z]+/g, '');
  t = t.replace(/[{}]/g, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * Reads exactly `expected` top-level {...} fields after a command.
 * Whitespace and line breaks are allowed anywhere between/inside fields.
 * This is deliberately independent of clipboard line wrapping, which makes
 * imports reliable on iPhone Safari as well as desktop browsers.
 */
function extractFieldsAt(text: string, start: number, expected: number): { fields: string[]; end: number } | null {
  let i = start;
  const fields: string[] = [];

  while (i < text.length && fields.length < expected) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{') return null;

    i++;
    let depth = 1;
    let out = '';

    while (i < text.length && depth > 0) {
      const ch = text[i];

      // Preserve escaped characters literally; an escaped brace is not structural.
      if (ch === '\\' && i + 1 < text.length) {
        out += ch + text[i + 1];
        i += 2;
        continue;
      }

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          fields.push(out);
          i++;
          break;
        }
      }

      out += ch;
      i++;
    }

    if (depth !== 0) return null;
  }

  while (i < text.length && /\s/.test(text[i])) i++;
  return fields.length === expected ? { fields, end: i } : null;
}

function parseEnglishWord(raw: string): { english: string; irregularPlural?: string; v2?: string; v3?: string } {
  const cleaned = cleanLatex(raw);
  const match = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { english: cleaned };

  const base = match[1].trim();
  const inside = match[2].trim();

  if (inside.includes(',')) {
    const parts = inside.split(',').map(p => p.trim());
    if (parts.length >= 2) return { english: base, v2: parts[0], v3: parts[1] };
  }
  return { english: base, irregularPlural: inside };
}

function parsePronunciation(raw: string) {
  const cleaned = cleanLatex(raw);
  const match = cleaned.match(/^(.*?)\(([^)]+)\)(.*?)$/);
  if (!match) return { pronunciation: cleaned, stressed: '' };

  return {
    pronunciation: `${match[1] || ''}${match[2]}${match[3] || ''}`.replace(/\s+/g, ' ').trim(),
    stressed: match[2].trim(),
  };
}

export interface ParsedImport {
  categoryEnglish: string;
  categoryPersian: string;
  words: Omit<VocabularyItem, 'wordId' | 'categoryIds' | 'creationOrder' | 'createdAt' | 'learning'>[];
  errors: string[];
  linesProcessed: number;
}

/**
 * Robust command parser.
 *
 * The old implementation parsed one command per physical line. On iOS,
 * clipboard paste can normalize/wrap line endings differently from desktop,
 * causing valid commands to be missed. This implementation finds commands in
 * the whole pasted string and parses their braced fields directly, so wrapping
 * or extra whitespace cannot change the number of imported words.
 */
export function parseImportText(text: string): ParsedImport {
  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let categoryEnglish = '';
  let categoryPersian = '';
  const words: ParsedImport['words'] = [];
  const errors: string[] = [];

  const commandRegex = /\\(voccategory|vwordpair|vword)\b/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  let linesProcessed = source ? source.split('\n').filter(l => l.trim()).length : 0;

  while ((match = commandRegex.exec(source)) !== null) {
    const command = match[1];
    const start = match.index + match[0].length;
    const expected = command === 'voccategory' ? 2 : command === 'vwordpair' ? 6 : 3;
    const parsed = extractFieldsAt(source, start, expected);

    if (!parsed) {
      const line = source.slice(0, match.index).split('\n').length;
      errors.push(`Line ${line}: incomplete or malformed \\${command} command`);
      continue;
    }

    const fields = parsed.fields;

    if (command === 'voccategory') {
      categoryEnglish = cleanLatex(fields[0]);
      categoryPersian = cleanLatex(fields[1]);
    } else if (command === 'vwordpair') {
      const [e1, p1, m1, e2, p2, m2] = fields;
      for (const [e, p, m] of [[e1, p1, m1], [e2, p2, m2]] as string[][]) {
        const eng = parseEnglishWord(e);
        const pron = parsePronunciation(p);
        words.push({
          english: eng.english,
          persianPronunciation: pron.pronunciation,
          stressedSyllable: pron.stressed,
          persianMeaning: cleanLatex(m),
          irregularPlural: eng.irregularPlural,
          v2: eng.v2,
          v3: eng.v3
        });
      }
    } else {
      const [e, p, m] = fields;
      const eng = parseEnglishWord(e);
      const pron = parsePronunciation(p);
      words.push({
        english: eng.english,
        persianPronunciation: pron.pronunciation,
        stressedSyllable: pron.stressed,
        persianMeaning: cleanLatex(m),
        irregularPlural: eng.irregularPlural,
        v2: eng.v2,
        v3: eng.v3
      });
    }

    lastEnd = Math.max(lastEnd, parsed.end);
    commandRegex.lastIndex = parsed.end;
  }

  return {
    categoryEnglish: categoryEnglish || 'Unnamed category',
    categoryPersian: categoryPersian || 'Unnamed',
    words,
    errors,
    linesProcessed
  };
}

export function createVocabularyItems(
  parsedWords: ParsedImport['words'],
  categoryId: string,
  startOrder: number
): VocabularyItem[] {
  const now = Date.now();
  return parsedWords.map((w, idx) => ({
    ...w,
    wordId: generateId(),
    categoryIds: [categoryId],
    creationOrder: startOrder + idx,
    createdAt: now + idx,
    learning: createEmptyLearning()
  }));
}
