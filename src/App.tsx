import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useApp } from './AppContext';
import type { VocabularyItem, StudySession, AnswerType, Category } from './types';
import { getGlobalStats, getCategoryStats, shuffleArray, speakEnglish, getStressedParts, formatDate } from './utils';
import { isDue, isWeak, isLearned, isLearning, getAccuracy, prioritizeForSmartReview } from './srs';
import { parseImportText } from './parser';

type Screen = 'home' | 'categories' | 'import' | 'studySetup' | 'study' | 'sessionEnd' | 'backup' | 'settings' | 'search' | 'wordDetail' | 'quiz';

export default function App() {
  const { data, loading, error, storageWarning, importCategory, createCategory, updateCategory, deleteCategory, updateSettings, answerCard, toggleStar, startSession, endSession, resetProgress, restoreBackup, getBackupJson } = useApp();
  const [screen, setScreen] = useState<Screen>('home');
  const [selectedCats, setSelectedCats] = useState<string[]>([]);
  const [studyMode, setStudyMode] = useState('smart');
  const [direction, setDirection] = useState<'en-fa' | 'fa-en' | 'random'>('en-fa');
  const [cardOrder, setCardOrder] = useState<'sequential' | 'shuffled'>('shuffled');
  const [flipped, setFlipped] = useState(false);
  const [currentDir, setCurrentDir] = useState<'en-fa' | 'fa-en'>('en-fa');
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<ReturnType<typeof parseImportText> | null>(null);
  const [importEnName, setImportEnName] = useState('');
  const [importFaName, setImportFaName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [backupText, setBackupText] = useState('');
  const [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge');
  const [message, setMessage] = useState<{ type: string; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [detailWord, setDetailWord] = useState<VocabularyItem | null>(null);
  const [filter, setFilter] = useState('all');
  const [editingCat, setEditingCat] = useState<Category | null>(null);
  const [newCatOpen, setNewCatOpen] = useState(false);
  const [newCatEn, setNewCatEn] = useState('');
  const [newCatFa, setNewCatFa] = useState('');
  const [quizMode, setQuizMode] = useState<'mc' | 'type'>('mc');
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizDeck, setQuizDeck] = useState<string[]>([]);
  const [quizOptions, setQuizOptions] = useState<string[]>([]);
  const [quizSelected, setQuizSelected] = useState<string | null>(null);
  const [quizTyped, setQuizTyped] = useState('');
  const [quizAnswered, setQuizAnswered] = useState(false);
  const [quizCorrectCount, setQuizCorrectCount] = useState(0);
  const spokenRef = useRef<string | null>(null);
  const [showResume, setShowResume] = useState(false);

  useEffect(() => { if (data?.currentSession?.isActive) setShowResume(true); }, [data?.currentSession?.isActive]);

  const stats = useMemo(() => data ? getGlobalStats(data) : null, [data]);
  const showMsg = (type: string, text: string) => { setMessage({ type, text }); setTimeout(() => setMessage(null), 4000); };

  const buildDeck = useCallback((catIds: string[], mode: string, order: string) => {
    if (!data) return [];
    let words = data.vocabulary.filter(v => v.categoryIds.some(id => catIds.includes(id)));
    if (mode === 'continue') {
      // Resume sequential study from the first never-studied word of each
      // selected category, preserving category and word order.
      const ids: string[] = [];
      const added = new Set<string>();
      for (const catId of catIds) {
        const category = data.categories.find(c => c.categoryId === catId);
        if (!category) continue;
        for (const wordId of category.wordIds) {
          if (added.has(wordId)) continue;
          const word = data.vocabulary.find(v => v.wordId === wordId);
          if (!word || word.learning.totalReviews > 0) continue;
          added.add(wordId);
          ids.push(wordId);
        }
      }
      return ids;
    }
    if (mode === 'unknown') words = words.filter(w => w.learning.lastAnswer === 'unknown' || w.learning.incorrectCount > 0);
    else if (mode === 'weak') words = words.filter(isWeak);
    else if (mode === 'due') words = words.filter(w => isDue(w));
    else if (mode === 'starred') words = words.filter(w => w.learning.starred);
    else if (mode === 'smart') { words = prioritizeForSmartReview(words); return words.map(w => w.wordId); }
    let ids = words.map(w => w.wordId);
    if (order === 'shuffled') ids = shuffleArray(ids);
    else ids = words.sort((a,b) => a.creationOrder - b.creationOrder).map(w => w.wordId);
    return ids;
  }, [data]);

  const startStudy = async () => {
    if (!selectedCats.length) { showMsg('error', 'Select a category'); return; }
    const deck = buildDeck(selectedCats, studyMode, cardOrder);
    if (!deck.length) { showMsg('warning', 'No words available'); return; }
    const session: StudySession = { sessionId: crypto.randomUUID(), selectedCategoryIds: selectedCats, mode: studyMode, direction, cardOrder, deck, currentIndex: 0, answers: {}, correct: 0, unsure: 0, incorrect: 0, startTime: Date.now(), lastUpdated: Date.now(), isActive: true };
    await startSession(session);
    setFlipped(false); spokenRef.current = null;
    setCurrentDir(direction === 'random' ? (Math.random()>0.5?'en-fa':'fa-en') : direction);
    setScreen('study');
  };

  const handleAnswer = async (answer: AnswerType) => {
    if (!data?.currentSession) return;
    const wordId = data.currentSession.deck[data.currentSession.currentIndex];
    const isLastCard = data.currentSession.currentIndex + 1 >= data.currentSession.deck.length;
    await answerCard(wordId, answer);
    setFlipped(false); spokenRef.current = null;
    if (isLastCard) { setScreen('sessionEnd'); }
    else if (direction === 'random') setCurrentDir(Math.random()>0.5?'en-fa':'fa-en');
  };

  const startQuiz = () => {
    if (!selectedCats.length) { showMsg('error', 'Select a category'); return; }
    const deck = buildDeck(selectedCats, studyMode, cardOrder);
    if (!deck.length) { showMsg('warning', 'No words available'); return; }
    setQuizDeck(deck);
    setQuizIndex(0);
    setQuizCorrectCount(0);
    setQuizSelected(null);
    setQuizTyped('');
    setQuizAnswered(false);
    setScreen('quiz');
  };

  useEffect(() => {
    if (screen !== 'quiz' || quizMode !== 'mc' || !data) return;
    const wordId = quizDeck[quizIndex];
    if (!wordId) return;
    const correct = data.vocabulary.find(v => v.wordId === wordId);
    if (!correct) return;
    const pool = data.vocabulary.filter(v => v.wordId !== wordId && v.categoryIds.some(id => selectedCats.includes(id)));
    const distractors = shuffleArray(pool.map(v => v.persianMeaning)).slice(0, 3);
    setQuizOptions(shuffleArray([correct.persianMeaning, ...distractors]));
  }, [screen, quizMode, quizIndex, quizDeck, data, selectedCats]);

  const quizWord = useMemo(() => {
    if (screen !== 'quiz' || !data) return null;
    return data.vocabulary.find(v => v.wordId === quizDeck[quizIndex]) || null;
  }, [screen, data, quizDeck, quizIndex]);

  const submitMcAnswer = async (choice: string) => {
    if (quizAnswered || !quizWord) return;
    setQuizSelected(choice);
    setQuizAnswered(true);
    const isCorrect = choice === quizWord.persianMeaning;
    if (isCorrect) setQuizCorrectCount(c => c + 1);
    await answerCard(quizWord.wordId, isCorrect ? 'known' : 'unknown');
  };

  const submitTypeAnswer = async () => {
    if (quizAnswered || !quizWord) return;
    setQuizAnswered(true);
    const isCorrect = quizTyped.trim() === quizWord.persianMeaning.trim();
    if (isCorrect) setQuizCorrectCount(c => c + 1);
    await answerCard(quizWord.wordId, isCorrect ? 'known' : 'unknown');
  };

  const nextQuizWord = () => {
    setQuizIndex(i => i + 1);
    setQuizSelected(null);
    setQuizTyped('');
    setQuizAnswered(false);
  };

  const onFlip = () => {
    if (flipped) return;
    setFlipped(true);
    if (data?.settings.autoPronounce && data.currentSession) {
      const wordId = data.currentSession.deck[data.currentSession.currentIndex];
      const word = data.vocabulary.find(v => v.wordId === wordId);
      if (word && spokenRef.current !== wordId) { speakEnglish(word.english); spokenRef.current = wordId; }
    }
  };

  const currentWord = useMemo(() => {
    if (!data?.currentSession || screen !== 'study') return null;
    return data.vocabulary.find(v => v.wordId === data.currentSession!.deck[data.currentSession!.currentIndex]) || null;
  }, [data, screen]);

  const searchResults = useMemo(() => {
    if (!data || !searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return data.vocabulary.filter(v => {
      if (filter === 'learned' && !isLearned(v)) return false;
      if (filter === 'weak' && !isWeak(v)) return false;
      if (filter === 'starred' && !v.learning.starred) return false;
      return v.english.toLowerCase().includes(q) || v.persianMeaning.includes(q);
    }).slice(0, 80);
  }, [data, searchQuery, filter]);

  if (loading) return <div className="app-container"><div className="loading-screen"><div className="spinner"/><div>Loading...</div></div></div>;
  if (error && !data) return <div className="app-container"><div className="error-box">{error}</div></div>;
  if (showResume && data?.currentSession?.isActive) return (
    <div className="app-container"><div className="card" style={{marginTop:40}}>
      <h2 className="card-title">Resume study?</h2>
      <p>{data.currentSession.currentIndex} of {data.currentSession.deck.length}</p>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => { setShowResume(false); setScreen('study'); }}>Resume</button>
        <button className="btn btn-ghost" onClick={async () => { setShowResume(false); await endSession(); }}>New</button>
      </div>
    </div></div>
  );

  const showNav = ['home','categories','search','settings'].includes(screen);

  return (
    <div className={`app-container ${showNav ? 'has-bottom-nav' : ''}`}>
      {message && <div className={`${message.type}-box`}>{message.text}</div>}
      {screen === 'home' && <>
        <div className="app-header"><div className="app-title">Vocabulary Flashcards</div></div>
        {storageWarning && <div className="warning-box">{storageWarning}</div>}
        {stats && <div className="stats-grid">
          <div className="stat-box"><div className="stat-value">{stats.dueToday}</div><div className="stat-label">Review today</div></div>
          <div className="stat-box"><div className="stat-value">{stats.learned}</div><div className="stat-label">Learned</div></div>
          <div className="stat-box"><div className="stat-value">{stats.learning}</div><div className="stat-label">Learning</div></div>
          <div className="stat-box"><div className="stat-value">{stats.weak}</div><div className="stat-label">Weak</div></div>
          <div className="stat-box"><div className="stat-value">{stats.accuracy}%</div><div className="stat-label">Accuracy</div></div>
          <div className="stat-box"><div className="stat-value">{stats.streak}</div><div className="stat-label">Streak</div></div>
        </div>}
        <button className="btn btn-primary mb-2" onClick={() => { setStudyMode('due'); setSelectedCats(data?.categories.map(c=>c.categoryId)||[]); setScreen('studySetup'); }}>Review today</button>
        <button className="btn btn-secondary mb-1" onClick={() => setScreen('categories')}>Start study</button>
        <button className="btn btn-ghost mb-1" onClick={() => setScreen('import')}>Import category</button>
        <button className="btn btn-ghost mb-1" onClick={() => setScreen('backup')}>Backup</button>
        <button className="btn btn-ghost" onClick={() => setScreen('settings')}>Settings</button>
      </>}
      {screen === 'categories' && <>
        <div className="app-header">
          <button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('home')}>←</button>
          <div className="app-title">Categories</div>
        </div>
        {data?.categories.map(cat => {
          const s = getCategoryStats(cat, data.vocabulary);
          return (
            <div key={cat.categoryId} className="category-item">
              <input type="checkbox" checked={selectedCats.includes(cat.categoryId)} onChange={() => setSelectedCats(p => p.includes(cat.categoryId) ? p.filter(id=>id!==cat.categoryId) : [...p, cat.categoryId])} />
              <div className="category-info" onClick={() => setEditingCat(cat)}>
                <div className="category-name-fa">{cat.persianName}</div>
                <div className="category-name-en">{cat.englishName}</div>
                <div className="category-meta"><span className="badge">{s.total}</span><span className="badge">{s.learned} Learned</span>{s.due>0 && <span className="badge badge-due">{s.due}</span>}</div>
              </div>
            </div>
          );
        })}
        {selectedCats.length > 0 && <button className="btn btn-primary" onClick={() => setScreen('studySetup')}>Study</button>}
        <button className="btn btn-ghost mt-1" onClick={() => { setNewCatEn(''); setNewCatFa(''); setNewCatOpen(true); }}>+ New category</button>
        {newCatOpen && <div className="modal-overlay" onClick={() => setNewCatOpen(false)}><div className="modal" onClick={e=>e.stopPropagation()}>
          <input className="form-input mb-1" placeholder="Persian name" value={newCatFa} onChange={e => setNewCatFa(e.target.value)} />
          <input className="form-input ltr mb-1" placeholder="English name" value={newCatEn} onChange={e => setNewCatEn(e.target.value)} />
          <button className="btn btn-primary" onClick={async () => {
            if (!newCatEn.trim() || !newCatFa.trim()) { showMsg('error', 'Enter both names'); return; }
            await createCategory(newCatEn.trim(), newCatFa.trim());
            setNewCatOpen(false);
            showMsg('success', 'Category created');
          }}>Create</button>
        </div></div>}
        {editingCat && <div className="modal-overlay" onClick={() => setEditingCat(null)}><div className="modal" onClick={e=>e.stopPropagation()}>
          <input className="form-input mb-1" value={editingCat.persianName} onChange={e => setEditingCat({...editingCat, persianName: e.target.value})} />
          <input className="form-input ltr mb-1" value={editingCat.englishName} onChange={e => setEditingCat({...editingCat, englishName: e.target.value})} />
          <button className="btn btn-primary" onClick={async () => { await updateCategory(editingCat.categoryId, editingCat.englishName, editingCat.persianName); setEditingCat(null); }}>Save</button>
          <button className="btn btn-danger mt-1" onClick={() => { setConfirmDelete(editingCat.categoryId); setEditingCat(null); }}>Delete</button>
        </div></div>}
        {confirmDelete && <div className="modal-overlay"><div className="modal"><p>Delete?</p><button className="btn btn-danger" onClick={async () => { await deleteCategory(confirmDelete); setConfirmDelete(null); }}>Yes</button><button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>No</button></div></div>}
      </>}
      {screen === 'import' && <>
        <div className="app-header"><button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('home')}>←</button><div className="app-title">Import</div></div>
        <textarea className="form-textarea" value={importText} onChange={e => setImportText(e.target.value)} />
        <button className="btn btn-secondary" onClick={() => { const p = parseImportText(importText); setImportPreview(p); setImportEnName(p.categoryEnglish); setImportFaName(p.categoryPersian); }}>Preview</button>
        {importPreview && <div className="card">
          <input className="form-input mb-1" value={importFaName} onChange={e => setImportFaName(e.target.value)} />
          <input className="form-input ltr mb-1" value={importEnName} onChange={e => setImportEnName(e.target.value)} />
          <p>{importPreview.words.length} words</p>
          <button className="btn btn-primary" onClick={async () => { const r = await importCategory(importText, {en: importEnName, fa: importFaName}); showMsg(r.success?'success':'error', r.message); if(r.success){ setImportPreview(null); setScreen('categories'); } }}>Import</button>
        </div>}
      </>}
      {screen === 'studySetup' && <>
        <div className="app-header"><button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('categories')}>←</button><div className="app-title">Study</div></div>
        <select className="form-select mb-1" value={studyMode} onChange={e => setStudyMode(e.target.value)}>
          <option value="all">All</option><option value="continue">Continue</option><option value="due">Today</option><option value="weak">Weak</option><option value="starred">Starred</option><option value="smart">Smart</option><option value="unknown">Unknown</option>
        </select>
        <select className="form-select mb-1" value={direction} onChange={e => setDirection(e.target.value as any)}>
          <option value="en-fa">EN→FA</option><option value="fa-en">FA→EN</option><option value="random">Random</option>
        </select>
        <select className="form-select mb-1" value={cardOrder} onChange={e => setCardOrder(e.target.value as any)}>
          <option value="shuffled">Random</option><option value="sequential">Sequential</option>
        </select>
        <button className="btn btn-primary" onClick={startStudy}>Start</button>
        <button className="btn btn-secondary mt-1" onClick={startQuiz}>Start quiz</button>
      </>}
      {screen === 'study' && currentWord && data?.currentSession && <>
        <div className="session-stats"><span>{data.currentSession.currentIndex+1}/{data.currentSession.deck.length}</span><span>✓{data.currentSession.correct} ~{data.currentSession.unsure} ✗{data.currentSession.incorrect}</span></div>
        <div className="progress-bar-outer"><div className="progress-bar-inner" style={{width: `${(data.currentSession.currentIndex/data.currentSession.deck.length)*100}%`}}/></div>
        <div className="flashcard-wrapper">
          <div className={`flashcard ${flipped?'flipped':''}`} onClick={onFlip}>
            <div className="flashcard-face front">
              {currentDir==='en-fa' ? <div className="flashcard-word">{currentWord.english}</div> : <div className="flashcard-meaning" style={{fontSize:'1.5rem'}}>{currentWord.persianMeaning}</div>}
              <div className="flashcard-hint">Tap to reveal</div>
            </div>
            <div className="flashcard-face back">
              <button className="speaker-btn" onClick={e => { e.stopPropagation(); speakEnglish(currentWord.english); }}>🔊</button>
              <button className="star-btn" onClick={async e => { e.stopPropagation(); await toggleStar(currentWord.wordId); }}>{currentWord.learning.starred?'⭐':'☆'}</button>
              <div className="flashcard-word">{currentWord.english}</div>
              <div className="flashcard-pron">{(() => { const p=getStressedParts(currentWord.persianPronunciation, currentWord.stressedSyllable); return <>{p.before}{p.stress&&<span className="stress">{p.stress}</span>}{p.after}</>; })()}</div>
              <div className="flashcard-meaning">{currentWord.persianMeaning}</div>
              {(currentWord.v2||currentWord.irregularPlural) && <div className="flashcard-irregular">{currentWord.irregularPlural&&<div>Plural: {currentWord.irregularPlural}</div>}{currentWord.v2&&<div>V2: {currentWord.v2}</div>}{currentWord.v3&&<div>V3: {currentWord.v3}</div>}</div>}
            </div>
          </div>
        </div>
        {flipped && <div className="answer-row">
          <button className="answer-btn answer-unknown" onClick={() => handleAnswer('unknown')}>❌ Unknown</button>
          <button className="answer-btn answer-unsure" onClick={() => handleAnswer('unsure')}>~ Unsure</button>
          <button className="answer-btn answer-known" onClick={() => handleAnswer('known')}>✓ Known</button>
        </div>}
        <button className="btn btn-ghost mt-2" onClick={async () => { await endSession(); setScreen('home'); }}>Exit</button>
      </>}
      {screen === 'quiz' && <>
        <div className="app-header"><button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('home')}>←</button><div className="app-title">Quiz</div></div>
        <select className="form-select mb-1" value={quizMode} onChange={e => { setQuizMode(e.target.value as 'mc' | 'type'); setQuizSelected(null); setQuizTyped(''); setQuizAnswered(false); }}>
          <option value="mc">Multiple choice</option>
          <option value="type">Type answer</option>
        </select>
        {quizWord ? <>
          <div className="session-stats"><span>{quizIndex+1}/{quizDeck.length}</span><span>✓{quizCorrectCount}</span></div>
          <div className="progress-bar-outer"><div className="progress-bar-inner" style={{width: `${(quizIndex/quizDeck.length)*100}%`}}/></div>
          <div className="card">
            <div className="flashcard-word">{quizWord.english}</div>
            <button className="speaker-btn" onClick={() => speakEnglish(quizWord.english)}>🔊</button>
          </div>
          {quizMode === 'mc' ? <div className="btn-row" style={{flexDirection:'column'}}>
            {quizOptions.map(opt => {
              const isCorrectOpt = opt === quizWord.persianMeaning;
              const cls = !quizAnswered ? 'btn btn-secondary mb-1' : (isCorrectOpt ? 'btn btn-primary mb-1' : (opt === quizSelected ? 'btn btn-danger mb-1' : 'btn btn-secondary mb-1'));
              return <button key={opt} className={cls} disabled={quizAnswered} onClick={() => submitMcAnswer(opt)}>{opt}</button>;
            })}
          </div> : <>
            <input className="form-input mb-1" value={quizTyped} onChange={e => setQuizTyped(e.target.value)} disabled={quizAnswered} placeholder="Enter the Persian meaning" />
            {!quizAnswered && <button className="btn btn-primary mb-1" onClick={submitTypeAnswer}>Submit</button>}
            {quizAnswered && <p className={quizTyped.trim() === quizWord.persianMeaning.trim() ? 'success-box' : 'error-box'}>Correct answer: {quizWord.persianMeaning}</p>}
          </>}
          {quizAnswered && <button className="btn btn-secondary mt-1" onClick={nextQuizWord}>Next</button>}
        </> : <div className="card" style={{marginTop:40}}>
          <h2 className="card-title">Quiz complete</h2>
          <p>{quizCorrectCount} of {quizDeck.length} correct</p>
          <button className="btn btn-primary mt-1" onClick={() => setScreen('home')}>Home</button>
        </div>}
      </>}
      {screen === 'sessionEnd' && data?.currentSession && <>
        <div className="app-header"><div className="app-title">Summary</div></div>
        <div className="stats-grid">
          <div className="stat-box"><div className="stat-value">{data.currentSession.correct}</div><div className="stat-label">Correct</div></div>
          <div className="stat-box"><div className="stat-value">{data.currentSession.incorrect}</div><div className="stat-label">Incorrect</div></div>
        </div>
        <button className="btn btn-primary" onClick={() => setScreen('home')}>Home</button>
      </>}
      {screen === 'backup' && <>
        <div className="app-header"><button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('home')}>←</button><div className="app-title">Backup</div></div>
        <button className="btn btn-secondary mb-1" onClick={() => setBackupText(getBackupJson())}>Generate</button>
        <textarea className="form-textarea" value={backupText} onChange={e => setBackupText(e.target.value)} />
        <button className="btn btn-primary mb-1" onClick={async () => { try { await navigator.clipboard.writeText(backupText||getBackupJson()); showMsg('success','Copied'); } catch { showMsg('error','Error'); } }}>Copy</button>
        <select className="form-select" value={restoreMode} onChange={e => setRestoreMode(e.target.value as any)}><option value="merge">Merge</option><option value="replace">Replace</option></select>
        <button className="btn btn-warning mt-1" onClick={async () => {
          if (restoreMode==='replace' && !confirmReplace) { setConfirmReplace(true); return; }
          const r = await restoreBackup(backupText, restoreMode); setConfirmReplace(false); showMsg(r.success?'success':'error', r.message); if(r.success) setScreen('home');
        }}>Restore</button>
        {confirmReplace && <div className="modal-overlay"><div className="modal"><p>Replace all data?</p><button className="btn btn-danger" onClick={async () => { setConfirmReplace(false); const r=await restoreBackup(backupText,'replace'); showMsg(r.success?'success':'error',r.message); if(r.success) setScreen('home'); }}>Yes</button><button className="btn btn-ghost" onClick={() => setConfirmReplace(false)}>No</button></div></div>}
      </>}
      {screen === 'settings' && data && <>
        <div className="app-header"><button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('home')}>←</button><div className="app-title">Settings</div></div>
        <div className="card">
          <div className="toggle-row"><span>Auto pronunciation</span><div className={`toggle ${data.settings.autoPronounce?'on':''}`} onClick={() => updateSettings({autoPronounce: !data.settings.autoPronounce})} /></div>
          <div className="toggle-row"><span>Repeat difficult</span><div className={`toggle ${data.settings.repeatDifficult?'on':''}`} onClick={() => updateSettings({repeatDifficult: !data.settings.repeatDifficult})} /></div>
        </div>
        <button className="btn btn-danger mt-2" onClick={() => setConfirmReset(true)}>Reset progress</button>
        {confirmReset && <div className="modal-overlay"><div className="modal"><p>Reset progress?</p><button className="btn btn-danger" onClick={async () => { await resetProgress('all'); setConfirmReset(false); showMsg('success','Done'); }}>Yes</button><button className="btn btn-ghost" onClick={() => setConfirmReset(false)}>No</button></div></div>}
      </>}
      {screen === 'search' && <>
        <div className="app-header"><button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('home')}>←</button><div className="app-title">Search</div></div>
        <input className="search-input" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search..." />
        <div className="btn-row mb-1">
          {(['all','learned','weak','starred'] as const).map(f => (
            <button key={f} className={`btn ${filter===f?'btn-primary':'btn-ghost'}`} onClick={() => setFilter(f)}>
              {f==='all'?'All':f==='learned'?'Learned':f==='weak'?'Weak':'Starred'}
            </button>
          ))}
        </div>
        {searchResults.map(w => <div key={w.wordId} className="category-item" onClick={() => { setDetailWord(w); setScreen('wordDetail'); }}><div className="category-info"><div className="category-name-fa ltr" style={{textAlign:'left'}}>{w.english}</div><div className="category-name-en">{w.persianMeaning}</div></div></div>)}
      </>}
      {screen === 'wordDetail' && detailWord && <>
        <div className="app-header"><button className="btn btn-ghost" style={{width:'auto'}} onClick={() => setScreen('search')}>←</button><div className="app-title">Details</div></div>
        <div className="card">
          <div className="flashcard-word">{detailWord.english}</div>
          <div className="flashcard-meaning">{detailWord.persianMeaning}</div>
          <div className="detail-row"><span>Reviews</span><span>{detailWord.learning.totalReviews}</span></div>
          <div className="detail-row"><span>Level</span><span>{detailWord.learning.learningLevel}</span></div>
          <div className="detail-row"><span>Accuracy</span><span>{getAccuracy(detailWord)}%</span></div>
          <div className="detail-row"><span>Last review</span><span>{formatDate(detailWord.learning.lastReviewed)}</span></div>
          <div className="detail-row"><span>Status</span><span>{isLearned(detailWord) ? 'Learned' : isLearning(detailWord) ? 'Learning' : 'New'}</span></div>
          <button className="btn btn-secondary" onClick={async () => { await toggleStar(detailWord.wordId); setDetailWord({...detailWord, learning:{...detailWord.learning, starred:!detailWord.learning.starred}}); }}>{detailWord.learning.starred?'Unstar':'Starred'}</button>
        </div>
      </>}
      {showNav && <nav className="bottom-nav">
        <button className={`nav-item ${screen==='home'?'active':''}`} onClick={() => setScreen('home')}><span className="icon">🏠</span>Home</button>
        <button className={`nav-item ${screen==='categories'?'active':''}`} onClick={() => setScreen('categories')}><span className="icon">📚</span>Categories</button>
        <button className={`nav-item ${screen==='search'?'active':''}`} onClick={() => setScreen('search')}><span className="icon">🔍</span>Search</button>
        <button className={`nav-item ${screen==='settings'?'active':''}`} onClick={() => setScreen('settings')}><span className="icon">⚙️</span>Settings</button>
      </nav>}
    </div>
  );
}
