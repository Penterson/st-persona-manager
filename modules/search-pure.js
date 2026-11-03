// Search (chosung, sparse and typo-tolerant, graded ranking), language detection and
// list paging. Pure: no DOM, no getContext, so Node tests can import it.

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const SYL_FIRST = 0xAC00;
const SYL_LAST = 0xD7A3;
const JAMO_RE = /[ㄱ-ㅎ]/;

// Mac-made archives deliver hangul NFD-decomposed, which matches neither typed text
// nor the precomposed-only chosung table.
function nfc(s) {
    try { return s.normalize('NFC'); } catch { return s; }
}

function normalize(s) {
    return nfc(String(s ?? '')).toLowerCase().replace(/\s+/g, '');
}

/* Normalised position -> original position, for highlighting. Lowercasing can grow a
   character (Turkish İ becomes two code units), so only each character's lowercase length
   is used; context-dependent lowercasing (Greek final sigma) preserves length. */
function buildMap(src, normalized) {
    const map = [];
    let j = 0;
    for (let i = 0; i < src.length && j < normalized.length; i++) {
        const ch = src[i];
        if (/\s/.test(ch)) continue;
        const grown = ch.toLowerCase().length;
        for (let k = 0; k < grown && j < normalized.length; k++) { map.push(i); j++; }
    }
    return map;
}

// Precomposed hangul becomes its initial consonant, everything else passes
// through; length stays 1:1 with the input.
export function toChosung(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out += (c >= SYL_FIRST && c <= SYL_LAST) ? CHO[Math.floor((c - SYL_FIRST) / 588)] : s[i];
    }
    return out;
}

function isSubsequence(text, q) {
    let i = 0;
    for (let j = 0; j < text.length && i < q.length; j++) if (text[j] === q[i]) i++;
    return i === q.length;
}

// Substring-style edit distance (leading and trailing text free), reusing row buffers.
let dpPrev = [];
let dpCur = [];
function approxDistance(text, q) {
    const n = text.length;
    const m = q.length;
    if (m === 0) return 0;
    if (n === 0) return m;
    if (dpPrev.length < n + 1) { dpPrev = new Array(n + 1); dpCur = new Array(n + 1); }
    let prev = dpPrev;
    let cur = dpCur;
    for (let j = 0; j <= n; j++) prev[j] = 0;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = q[i - 1] === text[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        const swap = prev; prev = cur; cur = swap;
    }
    let best = prev[0];
    for (let j = 1; j <= n; j++) if (prev[j] < best) best = prev[j];
    return best;
}

// Per-text cache (cleared past 5000 entries) and a last-query-only cache, which is
// what a per-keystroke filter re-asks.
const textCache = new Map();
/* Three forms of one text; only the normalised one is built up front. The chosung form
   and position table are built on first use, as body searches rarely need them. */
function prepText(text) {
    let c = textCache.get(text);
    if (!c) {
        if (textCache.size > 5000) textCache.clear();
        const src = nfc(String(text ?? ''));
        // Exactly what normalize() does to the query, in the same order.
        c = { src, t: src.toLowerCase().replace(/\s+/g, ''), map: null, tc: null };
        textCache.set(text, c);
    }
    return c;
}

function chosungOf(p) {
    if (p.tc === null) p.tc = toChosung(p.t);
    return p.tc;
}

// The position table, needed only by highlights (names, never bodies); built from p.t,
// so the two cannot describe different strings.
function mapOf(p) {
    if (p.map === null) p.map = buildMap(p.src, p.t);
    return p.map;
}

let lastQuery = null;
function prepQuery(term) {
    if (!lastQuery || lastQuery.raw !== term) {
        const qn = normalize(term);
        lastQuery = { raw: term, qn, qc: toChosung(qn) };
    }
    return lastQuery;
}

// Match grades, 10 apart; rankOf multiplies by 1000 and adds at most 900 of
// bonus, so a bonus can never flip a grade.
const S_HEAD = 100;      // the text starts with the query
const S_IN = 90;         // the query sits inside the text as is
const S_CHO_HEAD = 80;   // the chosung form starts with the query
const S_CHO_IN = 70;     // the query sits inside the chosung form
const S_CHO_GAP = 60;    // chosung matches sparsely
const S_GAP = 50;        // characters match sparsely
const S_TYPO = 40;       // one or two typos, minus 5 per edit

export function scoreOf(text, term) {
    const p = prepText(text);
    const q = prepQuery(term);
    const t = p.t;
    const qn = q.qn;
    if (!qn) return 0;
    if (t.startsWith(qn)) return S_HEAD;
    if (t.includes(qn)) return S_IN;
    if (JAMO_RE.test(qn)) {
        const tc = chosungOf(p);
        const qc = q.qc;
        if (tc.startsWith(qc)) return S_CHO_HEAD;
        if (tc.includes(qc)) return S_CHO_IN;
        if (isSubsequence(tc, qc)) return S_CHO_GAP;
    }
    if (isSubsequence(t, qn)) return S_GAP;
    const limit = qn.length >= 5 ? 2 : (qn.length >= 2 ? 1 : 0);
    if (limit > 0 && qn.length <= t.length + limit) {
        const d = approxDistance(t, qn);
        if (d <= limit) return S_TYPO - d * 5;
    }
    return 0;
}

// Grade first, then coverage, then earlier position. Sparse matches use their first
// hit; typo matches have no meaningful position.
export function rankOf(text, term) {
    const base = scoreOf(text, term);
    if (base <= 0) return 0;
    const p = prepText(text);
    const q = prepQuery(term);
    const t = p.t;
    const qn = q.qn;
    const cover = Math.min(1, qn.length / Math.max(1, t.length));
    let at = t.indexOf(qn);
    if (at < 0 && JAMO_RE.test(qn)) at = chosungOf(p).indexOf(q.qc);
    if (at < 0 && (base === S_CHO_GAP || base === S_GAP)) {
        at = base === S_CHO_GAP ? chosungOf(p).indexOf(q.qc[0]) : t.indexOf(qn[0]);
    }
    const near = at < 0 ? 0 : 1 - Math.min(1, at / Math.max(1, t.length));
    return base * 1000 + Math.round(cover * 600) + Math.round(near * 300);
}

function spanOf(p, at, len) {
    if (at < 0 || !len) return [];
    const map = mapOf(p);
    const from = map[at];
    const to = map[at + len - 1];
    return (from == null || to == null) ? [] : [[from, to]];
}

function subsequenceHits(text, q) {
    const hits = [];
    let i = 0;
    for (let j = 0; j < text.length && i < q.length; j++) {
        if (text[j] === q[i]) { hits.push(j); i++; }
    }
    return i === q.length ? hits : null;
}

// Groups hit positions into original-string ranges, bridging whitespace-only gaps.
function rangesOf(p, hits) {
    const out = [];
    const map = mapOf(p);
    for (const h of hits) {
        const at = map[h];
        if (at == null) continue;
        const last = out.length ? out[out.length - 1] : null;
        const gap = last ? p.src.slice(last[1] + 1, at) : null;
        if (last && !/\S/.test(gap)) last[1] = at;
        else out.push([at, at]);
    }
    return out;
}

// Inclusive [start, end] ranges over the original string; typo matches get none.
// Callers must render the NFC form the ranges index into (srcOf).
export function matchRanges(text, term) {
    const p = prepText(text);
    const q = prepQuery(term);
    if (!q.qn) return [];
    let at = p.t.indexOf(q.qn);
    if (at >= 0) return spanOf(p, at, q.qn.length);
    const useCho = JAMO_RE.test(q.qn);
    if (useCho) {
        at = chosungOf(p).indexOf(q.qc);
        if (at >= 0) return spanOf(p, at, q.qc.length);
        const hits = subsequenceHits(chosungOf(p), q.qc);
        if (hits) return rangesOf(p, hits);
    }
    const hits = subsequenceHits(p.t, q.qn);
    if (hits) return rangesOf(p, hits);
    return [];
}

// The NFC form matchRanges indexes into; NFD originals would skew every highlight.
export function srcOf(text) {
    return prepText(text).src;
}

// For body-sized text: substring or chosung substring only. The sparse and typo tiers
// match almost any long prose, so a filter would pass everything, slowly.
export function textContains(text, term) {
    const p = prepText(text);
    const q = prepQuery(term);
    if (!q.qn) return false;
    if (p.t.includes(q.qn)) return true;
    return JAMO_RE.test(q.qn) && chosungOf(p).includes(q.qc);
}

/* Language detection */

// ko/ja/zh/en by character counts, or null. Kana at a twentieth of the letters means
// Japanese, which is mostly kanji. Memoised: filters re-ask unchanged bodies per keystroke.
const langCache = new Map();
export function detectLanguage(text) {
    const s = String(text ?? '');
    if (langCache.has(s)) return langCache.get(s);
    const answer = detectLanguageUncached(s);
    if (langCache.size > 500) langCache.clear();
    langCache.set(s, answer);
    return answer;
}

/* Per-speaker scan budget, newest first: enough that one quoted line cannot flip the
   language, small enough that a switch registers within a few turns. */
const CHAT_LANGUAGE_SCAN_CHARS = 800;
const CHAT_LANGUAGE_SCAN_MESSAGES = 6;

/* ── Context-aware language ──────────────────────────────────────────────────
   Each source votes with its weight, scaled by how much text backs it (FULL_AT); the
   top language wins with at least MIN_EVIDENCE. Macros, markup and links never vote. */
const LANGUAGE_WEIGHTS = Object.freeze({
    user: 5,
    reply: 3,
    greeting: 1.5,
    card: 1.5,
    name: 1,
    persona: 0.5,
});

// Letters at which a source counts in full. Names are short by nature.
const FULL_AT = Object.freeze({ user: 30, reply: 40, greeting: 60, card: 80, name: 2, persona: 60 });
const MIN_EVIDENCE = 1;

// Only tag shapes go (a letter right after < or </): a bare <[^>]*> would also eat
// prose between a "<3" and a later "->".
export function stripMarkup(text) {
    return String(text ?? '')
        .replace(/\{\{[^{}]*\}\}/g, ' ')
        .replace(/<\/?[a-z][^<>]*>/gi, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ');
}

// A hangul syllable, kana or kanji carries about what three Latin letters do.
const CJK_LETTER_WEIGHT = 3;

function letterCount(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x3130 && c <= 0x318F) || (c >= 0x3040 && c <= 0x30FF)
            || (c >= 0x4E00 && c <= 0x9FFF)) n += CJK_LETTER_WEIGHT;
        else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) n++;
    }
    return n;
}

/* Splits a chat into user, reply and greeting (character messages before the user's
   first). System messages, SillyTavern's own text, never count. Each speaker has its own
   budget, so one long reply cannot crowd out the user's messages. */
export function chatSources(chat) {
    const out = { user: [], reply: [], greeting: '' };
    if (!Array.isArray(chat)) return out;
    const firstUser = chat.findIndex(m => m && !m.is_system && m.is_user);
    const budget = { user: { used: 0, total: 0 }, reply: { used: 0, total: 0 } };
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        const text = typeof message.mes === 'string' ? message.mes.trim() : '';
        if (!text) continue;
        const beforeUser = firstUser === -1 || i < firstUser;
        if (!message.is_user && beforeUser) {
            // A group chat can open with several greetings.
            out.greeting = out.greeting ? `${text} ${out.greeting}` : text;
            continue;
        }
        const role = message.is_user ? 'user' : 'reply';
        const spent = budget[role];
        if (spent.used >= CHAT_LANGUAGE_SCAN_MESSAGES || spent.total >= CHAT_LANGUAGE_SCAN_CHARS) continue;
        out[role].push(text);
        spent.used++;
        spent.total += text.length;
    }
    return out;
}

// Letters per script, fullwidth Latin and kana included.
function scriptCounts(text) {
    let hangul = 0;
    let kana = 0;
    let han = 0;
    let latin = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x3130 && c <= 0x318F) || (c >= 0x1100 && c <= 0x11FF)) hangul++;
        else if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) || (c >= 0xFF66 && c <= 0xFF9D)) kana++;
        else if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)) han++;
        else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0xFF21 && c <= 0xFF3A) || (c >= 0xFF41 && c <= 0xFF5A)) latin++;
    }
    return { hangul, kana, han, latin, letters: hangul + kana + han + latin };
}

/* Like detectLanguage, but weighing CJK characters as three Latin letters, the unit
   confidence is measured in; raw counts let a few Latin names outvote a Korean sentence. */
function sourceLanguage(text) {
    const { hangul, kana, han, latin, letters } = scriptCounts(text);
    if (!letters) return null;
    if (kana > 0 && kana * 20 >= letters) return 'ja';
    const ko = hangul * CJK_LETTER_WEIGHT;
    const zh = han * CJK_LETTER_WEIGHT;
    if (hangul > 0 && ko >= zh && ko >= latin) return 'ko';
    if (han > 0 && zh >= latin) return 'zh';
    if (latin > 0) return 'en';
    return null;
}

/* sources: { user, reply, greeting, card, name, persona }, each a string or array; a
   missing one does not vote. Returns { lang, scores }, lang null on thin evidence. */
export function contextLanguage(sources = {}) {
    const scores = {};
    for (const [key, weight] of Object.entries(LANGUAGE_WEIGHTS)) {
        const raw = sources[key];
        // Per message, so a stray < in one cannot pair with a > in the next.
        const text = (Array.isArray(raw) ? raw : [raw]).map(stripMarkup).join(' ');
        if (!text.trim()) continue;
        const letters = letterCount(text);
        if (!letters) continue;
        const lang = sourceLanguage(text);
        if (!lang) continue;
        const confidence = Math.min(1, letters / FULL_AT[key]);
        scores[lang] = (scores[lang] ?? 0) + weight * confidence;
    }
    let best = null;
    for (const [lang, score] of Object.entries(scores)) {
        if (!best || score > scores[best]) best = lang;
    }
    return { lang: best && scores[best] >= MIN_EVIDENCE ? best : null, scores };
}

// Both caches hold whole description bodies, so resetState (state.js) clears them:
// no module state outlives teardown.
export function clearSearchCaches() {
    textCache.clear();
    langCache.clear();
}

function detectLanguageUncached(s) {
    const { hangul, kana, han, latin, letters } = scriptCounts(s);
    if (!letters) return null;
    if (kana > 0 && kana * 20 >= letters) return 'ja';
    if (hangul >= kana && hangul >= han && hangul >= latin && hangul > 0) return 'ko';
    if (han >= latin && han > 0) return 'zh';
    if (latin > 0) return 'en';
    return null;
}

/* List paging */

// One page of a list; size 0 or less means one page. The page is clamped, so a filter
// that shrank the list never strands the user past the end.
export function pageOf(list, page, size) {
    const items = Array.isArray(list) ? list : [];
    const n = Number.isInteger(size) && size > 0 ? size : 0;
    if (!n || items.length <= n) return { slice: items, page: 1, pages: 1 };
    const pages = Math.ceil(items.length / n);
    const clamped = Math.min(Math.max(1, Number.isInteger(page) ? page : 1), pages);
    return { slice: items.slice((clamped - 1) * n, clamped * n), page: clamped, pages };
}
