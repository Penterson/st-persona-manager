// Search, language detection and list paging.
// Pure: no DOM, no getContext, so 검사/search.test.mjs can import it in Node.
//
// The matching core is ported from the user's own 월드인포검색.js (v3.10):
// Korean initial-consonant (chosung) search, sparse and typo-tolerant fuzzy
// matching, accuracy-graded ranking, and highlight ranges mapped back onto the
// original string through a normalisation position table. Only the matching
// functions travel; the lorebook script's stores, DOM and deep search stay
// behind. Chosung and fuzzy search are always on here (the source script's
// CHOSUNG_SEARCH/FUZZY_SEARCH flags, hardcoded true).

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const SYL_FIRST = 0xAC00;
const SYL_LAST = 0xD7A3;
const JAMO_RE = /[ㄱ-ㅎ]/;

// Mac-made archives deliver hangul NFD-decomposed; decomposed syllables share
// no code points with what the user types, and the chosung table only knows
// precomposed ones, so without this such names are unfindable.
function nfc(s) {
    try { return s.normalize('NFC'); } catch { return s; }
}

export function normalize(s) {
    return nfc(String(s ?? '')).toLowerCase().replace(/\s+/g, '');
}

// Normalise while building a normalised-position -> original-position table for
// highlighting. Lowercasing can grow a character (Turkish İ); every grown piece
// maps to the same source index so the two sides can never drift apart.
function normalizeWithMap(s) {
    let out = '';
    const map = [];
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) continue;
        const lc = ch.toLowerCase();
        for (let k = 0; k < lc.length; k++) { out += lc[k]; map.push(i); }
    }
    return { n: out, map };
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

// Bounded edit distance with reusable row buffers, exactly as the source
// script measures typos: substring-style (free leading/trailing text).
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

// Per-text and per-query caches, same shape as the source script. The text
// cache clears itself past 5000 entries; the query cache is the last query
// only, which is what a keystroke-by-keystroke filter re-asks.
const textCache = new Map();
function prepText(text) {
    let c = textCache.get(text);
    if (!c) {
        if (textCache.size > 5000) textCache.clear();
        const src = nfc(String(text ?? ''));
        const nm = normalizeWithMap(src);
        c = { src, t: nm.n, map: nm.map, tc: toChosung(nm.n) };
        textCache.set(text, c);
    }
    return c;
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
        const tc = p.tc;
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

// Relevance rank: same grade, then more coverage wins, then an earlier match
// position wins. Sparse matches take their first hit position; typo matches
// have no meaningful position and take none.
export function rankOf(text, term) {
    const base = scoreOf(text, term);
    if (base <= 0) return 0;
    const p = prepText(text);
    const q = prepQuery(term);
    const t = p.t;
    const qn = q.qn;
    const cover = Math.min(1, qn.length / Math.max(1, t.length));
    let at = t.indexOf(qn);
    if (at < 0 && JAMO_RE.test(qn)) at = p.tc.indexOf(q.qc);
    if (at < 0 && (base === S_CHO_GAP || base === S_GAP)) {
        at = base === S_CHO_GAP ? p.tc.indexOf(q.qc[0]) : t.indexOf(qn[0]);
    }
    const near = at < 0 ? 0 : 1 - Math.min(1, at / Math.max(1, t.length));
    return base * 1000 + Math.round(cover * 600) + Math.round(near * 300);
}

function spanOf(p, at, len) {
    if (at < 0 || !len) return [];
    const from = p.map[at];
    const to = p.map[at + len - 1];
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

// Group scattered hit positions into original-position ranges, bridging gaps
// that are whitespace only, so 북부왕국 marks 북부 왕국 as one chunk.
function rangesOf(p, hits) {
    const out = [];
    for (const h of hits) {
        const at = p.map[h];
        if (at == null) continue;
        const last = out.length ? out[out.length - 1] : null;
        const gap = last ? p.src.slice(last[1] + 1, at) : null;
        if (last && !/\S/.test(gap)) last[1] = at;
        else out.push([at, at]);
    }
    return out;
}

// Highlight ranges over the ORIGINAL string ([start, end] inclusive pairs).
// Contiguous matches come back as one chunk, sparse matches per character
// chunk, typo matches as nothing (there is no place to honestly point at).
// Callers must render the NFC form the ranges index into (srcOf below).
export function matchRanges(text, term) {
    const p = prepText(text);
    const q = prepQuery(term);
    if (!q.qn) return [];
    let at = p.t.indexOf(q.qn);
    if (at >= 0) return spanOf(p, at, q.qn.length);
    const useCho = JAMO_RE.test(q.qn);
    if (useCho) {
        at = p.tc.indexOf(q.qc);
        if (at >= 0) return spanOf(p, at, q.qc.length);
        const hits = subsequenceHits(p.tc, q.qc);
        if (hits) return rangesOf(p, hits);
    }
    const hits = subsequenceHits(p.t, q.qn);
    if (hits) return rangesOf(p, hits);
    return [];
}

// The NFC form matchRanges indexes into. Drawing the raw original under NFD
// names would skew every highlight by the decomposed length difference.
export function srcOf(text) {
    return prepText(text).src;
}

// Body-sized text takes the source script's deep-search rule instead of the
// full grade ladder: a plain normalized substring, or a chosung substring.
// The sparse and typo tiers match almost any long prose (a two-jamo query is a
// subsequence of nearly every Korean paragraph), which turns a filter into a
// no-op and pays an edit-distance table per body per keystroke on top.
export function textContains(text, term) {
    const p = prepText(text);
    const q = prepQuery(term);
    if (!q.qn) return false;
    if (p.t.includes(q.qn)) return true;
    return JAMO_RE.test(q.qn) && p.tc.includes(q.qc);
}

/* Language detection */

// Counts writing-system characters and answers ko/ja/zh/en, or null when there
// is nothing to judge by. Kana wins early because Japanese prose is mostly
// kanji plus kana, so a plain majority vote would misread it as Chinese: any
// kana presence at one twentieth of the letters is decisive. The thresholds
// are data, pinned by tests, not tuned per call.
//
// Memoised by the exact text, capped like textCache: the filter chips ask the
// same unchanged bodies once per keystroke, and a multi-KB scan per persona per
// key press is measurable jank on the phone.
const langCache = new Map();
export function detectLanguage(text) {
    const s = String(text ?? '');
    if (langCache.has(s)) return langCache.get(s);
    const answer = detectLanguageUncached(s);
    if (langCache.size > 500) langCache.clear();
    langCache.set(s, answer);
    return answer;
}

/* What language the conversation is being held in (user request: 언어별 이름
   자동 적용). The chat, not the description: the description is what the persona
   IS, and it does not change when the user starts typing English.

   Read from the newest messages backwards until there is enough text to judge
   by, because the answer decides whether to rename a persona and a two word
   reply is not evidence. System messages are skipped: they are SillyTavern's
   own text, in SillyTavern's language, and counting them would let the UI
   language outvote the conversation. */
export const CHAT_LANGUAGE_MIN_CHARS = 40;
export const CHAT_LANGUAGE_SCAN_CHARS = 800;
// Six, so a block of the old language stops counting within a few turns of the
// user switching. Judging one message alone would flip the name on a single
// quoted line; judging the whole chat would never notice the switch at all.
export const CHAT_LANGUAGE_SCAN_MESSAGES = 6;

export function chatLanguage(chat, minChars = CHAT_LANGUAGE_MIN_CHARS) {
    if (!Array.isArray(chat) || !chat.length) return null;
    const parts = [];
    let total = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (total >= CHAT_LANGUAGE_SCAN_CHARS || parts.length >= CHAT_LANGUAGE_SCAN_MESSAGES) break;
        const message = chat[i];
        if (!message || message.is_system) continue;
        const text = typeof message.mes === 'string' ? message.mes.trim() : '';
        if (!text) continue;
        parts.push(text);
        total += text.length;
    }
    const joined = parts.join(' ');
    // Not enough to be sure. Answering null here is what keeps a rename from
    // happening on the strength of one 응 or one ok.
    if (joined.length < minChars) return null;
    return detectLanguage(joined);
}

// Both caches key on the description bodies themselves: textCache keeps the source
// string, its normalised form and a position array with one entry per character,
// and langCache keeps up to 500 whole bodies. Neither entry cap can trip before the
// memory does on a roster of long personas, and resetState()'s rule is that no
// module state outlives teardown. state.js calls this from resetState.
export function clearSearchCaches() {
    textCache.clear();
    langCache.clear();
}

function detectLanguageUncached(s) {
    let hangul = 0;
    let kana = 0;
    let han = 0;
    let latin = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if ((c >= 0xAC00 && c <= 0xD7A3) || (c >= 0x3130 && c <= 0x318F) || (c >= 0x1100 && c <= 0x11FF)) hangul++;
        else if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) || (c >= 0xFF66 && c <= 0xFF9D)) kana++;
        else if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)) han++;
        else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0xFF21 && c <= 0xFF3A) || (c >= 0xFF41 && c <= 0xFF5A)) latin++;
    }
    const letters = hangul + kana + han + latin;
    if (!letters) return null;
    if (kana > 0 && kana * 20 >= letters) return 'ja';
    if (hangul >= kana && hangul >= han && hangul >= latin && hangul > 0) return 'ko';
    if (han >= latin && han > 0) return 'zh';
    if (latin > 0) return 'en';
    return null;
}

/* List paging */

// One window of a list. size 0 (or less) means everything on one page. The
// requested page is clamped into range, so a filter that shrank the list never
// leaves the user stranded past the end.
export function pageOf(list, page, size) {
    const items = Array.isArray(list) ? list : [];
    const n = Number.isInteger(size) && size > 0 ? size : 0;
    if (!n || items.length <= n) return { slice: items, page: 1, pages: 1 };
    const pages = Math.ceil(items.length / n);
    const clamped = Math.min(Math.max(1, Number.isInteger(page) ? page : 1), pages);
    return { slice: items.slice((clamped - 1) * n, clamped * n), page: clamped, pages };
}
