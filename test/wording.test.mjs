// The UI copy rules, checked mechanically over every string the user can read.
//
// A visible string ends on a real noun in software-manual register (실패, 완료,
// 불가, 없음). It does not end on a conjugated verb (없다, 사라졌다), nor on a
// verb bent into a noun shape (읽지 못함, 옮김, 엶). It says 현재/해당, not the
// demonstrative 이. And it lives in strings.js, where these tests can see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { STRINGS } from '../modules/strings.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Positional samples for the formatter strings: a count, a name, an error.
const SAMPLES = [3, '메모', '오류'];

// Nouns that end on ㅁ without being a verb in noun shape.
const LEXICAL = new Set([
    '없음', '있음', '잠금', '숨김', '새로고침', '이름', '다음', '지금', '미포함',
    '미확인', '미저장', '미보관', '미구현', '처럼', '이력', '항목', '포함',
]);

// Final consonant 16 is ㅁ and 10 is ㄻ (엶). Judged on the trailing hangul run,
// so 타일+이름 or 버전) is read as 이름 and 버전.
function isNominalised(token) {
    // The last hangul run, punctuation after it allowed: 복사됨) and 건너뜀:
    // end on the same ㅁ as 복사됨.
    const run = /[가-힣]+(?=[^가-힣]*$)/.exec(token)?.[0];
    if (!run) return false;
    const jong = (run.charCodeAt(run.length - 1) - 0xAC00) % 28;
    return (jong === 16 || jong === 10) && !LEXICAL.has(run);
}

// Text addressed to a language model, not to the reader. Named one by one so
// the exemption cannot grow to cover screen copy.
const MODEL_FACING = ['settings.assetPromptDefault', 'settings.legacyAssetPrompts'];
const modelFacing = path => MODEL_FACING.some(p => path === p || path.startsWith(`${p}.`));

function renderAll() {
    const out = [];
    (function walk(node, path) {
        for (const [key, value] of Object.entries(node)) {
            const p = path ? `${path}.${key}` : key;
            if (modelFacing(p)) continue;
            if (typeof value === 'string') out.push([p, value]);
            else if (typeof value === 'function') out.push([`${p}()`, String(value(...SAMPLES.slice(0, value.length)))]);
            else if (value && typeof value === 'object') walk(value, p);
        }
    })(STRINGS, '');
    return out;
}

const clausesOf = text => text.split(/(?<=[.?])\s+/).filter(Boolean);

test('no visible string ends on a conjugated verb', () => {
    const bad = renderAll()
        .filter(([, text]) => clausesOf(text).some(c => /다$/.test(c.trim().replace(/[.]$/, ''))))
        .map(([path, text]) => `${path}: ${text}`);
    assert.deepEqual(bad, [], `한다체로 끝나는 문자열:\n${bad.join('\n')}`);
});

test('no visible string ends on a nominalised verb', () => {
    const bad = [];
    for (const [path, text] of renderAll()) {
        for (const clause of clausesOf(text)) {
            const words = clause.trim().replace(/[.?]$/, '').split(/\s+/);
            const last = words[words.length - 1] ?? '';
            if (isNominalised(last)) bad.push(`${path}: ${text}  << ${last}`);
        }
    }
    assert.deepEqual(bad, [], `명사형으로 끝나는 문자열:\n${bad.join('\n')}`);
});

test('no visible string uses the demonstrative 이 or the spelling 아니오', () => {
    const bad = renderAll()
        .filter(([, text]) => /(^|[\s"'(])이 [가-힣{]/.test(text) || /아니오/.test(text))
        .map(([path, text]) => `${path}: ${text}`);
    assert.deepEqual(bad, [], `지시어 "이" 또는 "아니오" (현재/해당, 아니요로):\n${bad.join('\n')}`);
});

const MODULE_FILES = ['index.js', ...readdirSync(join(ROOT, 'modules'))
    .filter(f => f.endsWith('.js') && f !== 'strings.js')
    .map(f => `modules/${f}`)];

// Quoted runs per line. A scan, not a parser: a comment line that quotes Korean
// is reported like a string, and the answer is to drop the quotes from the
// comment. Skipping comments would need regex-literal awareness, and a scanner
// that misreads `/[/*]/` goes blind for the rest of the file with the suite green.
function codeLiterals(source) {
    const out = [];
    source.split(/\r?\n/).forEach((line, i) => {
        if (/^\s*[*/]/.test(line)) return;
        const code = line.replace(/\/\/.*$/, '');
        for (const m of code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) out.push([i + 1, m[2]]);
    });
    return out;
}

test('no module hard codes a Korean sentence outside strings.js', () => {
    // Data, not prose: section name aliases and the default section names.
    const ALLOWED = /^(외형|외모|기본정보|기본 정보|배경|성격|버릇 & 습관|능력 & 기술|관계|숨겨진 욕망|말투 & 대사|NSFW 외모|성적 취향|AI 가이드라인|캐릭터 노트)$/;
    const bad = [];
    for (const f of MODULE_FILES) {
        for (const [line, text] of codeLiterals(readFileSync(join(ROOT, f), 'utf8'))) {
            if (!/[가-힣]/.test(text) || ALLOWED.test(text)) continue;
            if (f === 'modules/store.js' && text.includes('{{persona_assets}}')) continue;
            // A file-name prefix on the server that 0.1.12 to 0.1.14 wrote; it must
            // stay spelled exactly as it was, so it is not copy.
            if (f === 'modules/assets.js' && text === 'pm-원본-') continue;
            bad.push(`${f}:${line}  ${text.slice(0, 60)}`);
        }
    }
    assert.deepEqual(bad, [], `strings.js 밖의 한글 문장:\n${bad.join('\n')}`);
});

// The test above passes by finding nothing, so a scan that stopped reading would
// look the same as a clean codebase. Both floors sit far under today's counts.
test('the module scan actually reads the modules', () => {
    let total = 0;
    let indented = 0;
    for (const f of MODULE_FILES) {
        const source = readFileSync(join(ROOT, f), 'utf8');
        const lines = source.split(/\r?\n/);
        for (const [line] of codeLiterals(source)) {
            total++;
            if (/^ {8}/.test(lines[line - 1] ?? '')) indented++;
        }
    }
    assert.ok(total > 1200, `only ${total} quoted runs read`);
    assert.ok(indented > 300, `only ${indented} quoted runs read on indented lines`);
});
