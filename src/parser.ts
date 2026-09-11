import type { VocabularyItem, LearningRecord } from './types';

function createEmptyLearning(): LearningRecord {
  return {
    totalReviews: 0,
    correctCount: 0,
    incorrectCount: 0,
    unsureCount: 0,
    lastReviewed: null,
    lastAnswer: null,
    consecutiveCorrect: 0,
    learningLevel: 0,
    currentInterval: 0,
    nextReviewDate: null,
    reviewHistory: [],
    starred: false,
  };
}

function generateId(): string {
  return crypto.randomUUID();
}

function cleanLatex(text: string): string {
  if (!text) return '';
  let t = text;
  // Common LaTeX cleanups
  t = t.replace(/\\&/g, '&');
  t = t.replace(/\\'/g, ''); // remove \' before letter, handle specifically
  t = t.replace(/\\'e/g, 'é');
  t = t.replace(/\\'E/g, 'É');
  t = t.replace(/\\`e/g, 'è');
  t = t.replace(/\\"e/g, 'ë');
  t = t.replace(/\\~n/g, 'ñ');
  t = t.replace(/\\c\{c\}/g, 'ç');
  t = t.replace(/\\small/g, '');
  t = t.replace(/\\large/g, '');
  t = t.replace(/\\textbf\{([^}]*)\}/g, '$1');
  t = t.replace(/\\textit\{([^}]*)\}/g, '$1');
  t = t.replace(/\\emph\{([^}]*)\}/g, '$1');
  t = t.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1'); // generic command with arg
  t = t.replace(/\\[a-zA-Z]+/g, ''); // remaining commands
  t = t.replace(/\{|\}/g, '');
  return t.trim();
}

function parseEnglishWord(raw: string): {
  english: string;
  irregularPlural?: string;
  v2?: string;
  v3?: string;
} {
  const cleaned = cleanLatex(raw).trim();
  const match = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) {
    return { english: cleaned };
  }
  const base = match[1].trim();
  const inside = match[2].trim();
  if (inside.includes(',')) {
    const parts = inside.split(',').map((p) => p.trim());
    if (parts.length >= 2) {
      return { english: base, v2: parts[0], v3: parts[1] };
    }
  }
  // assume plural
  return { english: base, irregularPlural: inside };
}

function parsePronunciation(raw: string): {
  pronunciation: string;
  stressed: string;
} {
  const cleaned = cleanLatex(raw).trim();
  // Look for (stressed)
  const match = cleaned.match(/^(.*?)\(([^)]+)\)(.*?)$/);
  if (match) {
    const before = match[1] || '';
    const stressed = match[2];
    const after = match[3] || '';
    const full = (before + stressed + after).replace(/\s+/g, ' ').trim();
    return { pronunciation: full, stressed };
  }
  return { pronunciation: cleaned, stressed: '' };
}

export interface ParsedImport {
  categoryEnglish: string;
  categoryPersian: string;
  words: Omit<VocabularyItem, 'wordId' | 'categoryIds' | 'creationOrder' | 'createdAt' | 'learning'>[];
  errors: string[];
  linesProcessed: number;
}

export function parseImportText(text: string): ParsedImport {
  const lines = text.split(/\r?\n/);
  let categoryEnglish = '';
  let categoryPersian = '';
  const words: ParsedImport['words'] = [];
  const errors: string[] = [];
  let linesProcessed = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;
    linesProcessed++;

    // \voccategory{En}{Fa}
    const catMatch = line.match(/\\voccategory\s*\{([^}]*)\}\s*\{([^}]*)\}/);
    if (catMatch) {
      categoryEnglish = cleanLatex(catMatch[1]);
      categoryPersian = cleanLatex(catMatch[2]);
      continue;
    }

    // \vwordpair{w1}{p1}{m1}{w2}{p2}{m2}
    const pairMatch = line.match(
      /\\vwordpair\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/
    );
    if (pairMatch) {
      try {
        const [ , e1, p1, m1, e2, p2, m2 ] = pairMatch;
        const eng1 = parseEnglishWord(e1);
        const pron1 = parsePronunciation(p1);
        words.push({
          english: eng1.english,
          persianPronunciation: pron1.pronunciation,
          stressedSyllable: pron1.stressed,
          persianMeaning: cleanLatex(m1),
          irregularPlural: eng1.irregularPlural,
          v2: eng1.v2,
          v3: eng1.v3,
        });
        const eng2 = parseEnglishWord(e2);
        const pron2 = parsePronunciation(p2);
        words.push({
          english: eng2.english,
          persianPronunciation: pron2.pronunciation,
          stressedSyllable: pron2.stressed,
          persianMeaning: cleanLatex(m2),
          irregularPlural: eng2.irregularPlural,
          v2: eng2.v2,
          v3: eng2.v3,
        });
      } catch (e) {
        errors.push(`خط ${i + 1}: خطای پردازش جفت واژه - ${line.slice(0, 60)}`);
      }
      continue;
    }

    // \vword{w}{p}{m}
    const wordMatch = line.match(/\\vword\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/);
    if (wordMatch) {
      try {
        const [, e, p, m] = wordMatch;
        const eng = parseEnglishWord(e);
        const pron = parsePronunciation(p);
        words.push({
          english: eng.english,
          persianPronunciation: pron.pronunciation,
          stressedSyllable: pron.stressed,
          persianMeaning: cleanLatex(m),
          irregularPlural: eng.irregularPlural,
          v2: eng.v2,
          v3: eng.v3,
        });
      } catch (e) {
        errors.push(`خط ${i + 1}: خطای پردازش واژه - ${line.slice(0, 60)}`);
      }
      continue;
    }

    // Ignore other lines or mark as possible error if looks like command
    if (line.startsWith('\\')) {
      errors.push(`خط ${i + 1}: دستور ناشناخته یا ناقص - ${line.slice(0, 80)}`);
    }
  }

  return {
    categoryEnglish: categoryEnglish || 'دسته‌بندی بدون نام',
    categoryPersian: categoryPersian || 'Unnamed Category',
    words,
    errors,
    linesProcessed,
  };
}

export function createVocabularyItems(
  parsedWords: ParsedImport['words'],
  categoryId: string,
  startOrder: number
): VocabularyItem[] {
  const now = Date.now();
  return parsedWords.map((w, idx) => ({
    wordId: generateId(),
    english: w.english,
    persianPronunciation: w.persianPronunciation,
    stressedSyllable: w.stressedSyllable,
    persianMeaning: w.persianMeaning,
    irregularPlural: w.irregularPlural,
    v2: w.v2,
    v3: w.v3,
    categoryIds: [categoryId],
    creationOrder: startOrder + idx,
    createdAt: now + idx,
    learning: createEmptyLearning(),
  }));
}
