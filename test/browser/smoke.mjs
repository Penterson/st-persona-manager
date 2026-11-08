// Browser smoke test. Boots the extension against the SillyTavern mock in
// host.html, drives every screen at phone and desktop widths, and fails on any
// console error, page error, or scenario that does not end in the expected
// state. Screenshots land in test/browser/out for a visual check.
//
//   npm run smoke          (needs `npm i -D playwright` and a Chromium it can launch)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Playwright is the one development dependency. A missing install is said in
// one line instead of a module-resolution stack trace.
let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    console.error('smoke: playwright is not installed. Run `npm install` (or `npm i -D playwright && npx playwright install chromium`) first.');
    process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..', '..');
const OUT = path.join(here, 'out');
const PORT = 8765;
fs.mkdirSync(OUT, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
// Serves the extension under /ext/ and this folder at the root, and nothing
// else: a raw request for /ext/../../ must not read files outside the repo.
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const server = http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    const file = url.startsWith('/ext/') ? path.resolve(EXT, `.${url.slice(4)}`)
        : (url === '/' || url === '/host.html') ? path.join(here, 'host.html')
            : path.resolve(here, `.${url}`);
    const allowed = url.startsWith('/ext/') ? inside(EXT, file) : inside(here, file);
    if (!allowed || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});

const failures = [];
function expect(label, condition, detail) {
    if (!condition) failures.push(`${label}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

const ALICE = '1700000000000-alice.png';
const ctxEval = page => page.evaluate(() => window.SillyTavern.getContext());

async function openPanel(page) {
    await page.click('#pm-quickbar');
    await page.waitForTimeout(150);
}

// Opens a fold head if it is closed. The open state is a stored setting, so a
// second tap in a later scene would close what the first one opened.
async function ensureOpen(page, index) {
    const head = page.locator('.pm-quickbar-foldhead').nth(index);
    if ((await head.getAttribute('aria-expanded')) !== 'true') {
        await head.click();
        await page.waitForTimeout(100);
    }
}

async function adopt(page) {
    await ensureOpen(page, 0);
    const row = page.locator('.pm-quickbar-row', { hasText: '관리 시작' }).first();
    if (await row.count()) { await row.click(); await page.waitForTimeout(150); }
}

async function openManager(page, tab = '편집') {
    await page.locator('.pm-quickbar-footer .pm-quickbar-btn', { hasText: tab }).click();
    await page.waitForTimeout(250);
}

// A press that takes a human amount of time. Playwright's click is faster than
// a frame; the bugs this guards against only appear when a frame can pass
// between mousedown and mouseup.
async function slowClick(page, locator) {
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(250);
}

// PW_CHANNEL=chrome or msedge runs on an installed browser, so the smoke works
// without downloading Playwright's own Chromium.
const LAUNCH = process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {};

async function tour(width, label, light) {
    const browser = await chromium.launch(LAUNCH);
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: width < 600, isMobile: width < 600 });
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    const shot = name => page.screenshot({ path: path.join(OUT, `${label}-${name}.png`) });

    await page.goto(`http://127.0.0.1:${PORT}/host.html`);
    if (light) await page.evaluate(() => document.body.classList.add('light'));
    await page.waitForTimeout(400);
    expect(`${label} icon mounted`, await page.evaluate(() => !!document.getElementById('pm-quickbar')));
    expect(`${label} chat tag rendered`, await page.evaluate(() => !!document.querySelector('#chat img.pm-asset')));
    const macros = await page.evaluate(() => ({ list: window.__macros.persona_assets?.(), prompt: window.__macros.persona_asset_prompt?.() }));
    expect(`${label} asset macro hides backups`, macros.list === 'Walk, 포즈 1.5', macros.list);
    expect(`${label} prompt macro expands`, macros.prompt?.includes('Walk, 포즈 1.5'));
    await shot('00-boot');

    /* Quick panel */
    await openPanel(page);
    expect(`${label} panel opens`, await page.evaluate(() => !!document.getElementById('pm-quickbar-panel')));
    await shot('01-panel');
    await adopt(page);
    const root = await page.evaluate(() => window.SillyTavern.getContext().extensionSettings['persona-manager']);
    const alice = root?.personas?.[ALICE];
    const itemNames = (alice?.sections ?? []).map(section => section.name);
    expect(`${label} adopt keeps the description's own items and names`,
        alice?.headingFormat === 'own' && JSON.stringify(itemNames) === '["외모","성격"]', [alice?.headingFormat, itemNames]);
    const described = (await ctxEval(page)).powerUserSettings.persona_descriptions[ALICE].description;
    expect(`${label} adopt leaves the description untouched`, described === '## 외모\n검은 머리, 큰 키\n\n## 성격\n조용하고 침착함', described);
    await page.evaluate(() => window.__popupAnswers.push('v1'));
    await page.locator('.pm-quickbar-row', { hasText: '현재 구성을 버전으로 저장' }).first().click();
    await page.waitForTimeout(200);
    expect(`${label} version saved`, (await ctxEval(page)).extensionSettings['persona-manager'].personas[ALICE].versions.length === 1);
    await shot('02-panel-versions');

    // A label typed and added with a slow click: the blur-released redraw must
    // wait for the gesture.
    await page.locator('.pm-quickbar-rosterhead-controls .pm-quickbar-btn', { hasText: '그룹' }).click();
    await page.waitForTimeout(100);
    await page.locator('.pm-quickbar-row[data-pm-avatar]').first().click();
    await page.waitForTimeout(100);
    await page.fill('.pm-quickbar-newlabel-input', '친구');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('pm:changed')));
    await page.waitForTimeout(50);
    await slowClick(page, page.locator('.pm-quickbar-newlabel .pm-quickbar-btn'));
    const labels = (await ctxEval(page)).extensionSettings['persona-manager'].labels;
    expect(`${label} slow click on [추가] creates the group`, labels.length === 1 && labels[0].members.includes(ALICE), labels);
    // The group toggle keeps its label and shows that it is on as pressed.
    const groupToggle = page.locator('.pm-quickbar-rosterhead-controls .pm-quickbar-btn[aria-pressed="true"]', { hasText: '그룹' });
    expect(`${label} the group toggle reads as pressed while on`, await groupToggle.count() === 1);
    await groupToggle.click();
    await page.waitForTimeout(100);
    await shot('03-panel-group');

    await page.locator('.pm-quickbar-rosterhead-controls .pm-quickbar-btn', { hasText: '검색' }).first().click();
    await page.waitForTimeout(100);
    await page.fill('.pm-search-input', 'bob');
    await page.waitForTimeout(150);
    expect(`${label} search filters`, await page.locator('[data-pm-avatar]').count() === 1);
    await page.selectOption('.pm-quickbar-rosterhead-controls select >> nth=1', 'tilesNamed');
    await page.waitForTimeout(150);
    await shot('04-panel-tiles');
    const controls = await page.evaluate(() => { const c = document.querySelector('.pm-quickbar-rosterhead-controls'); return [c.scrollWidth, c.clientWidth]; });
    expect(`${label} roster controls fit on one line`, controls[0] <= controls[1], controls);

    /* Manager: editor save with a slow click */
    await openManager(page);
    expect(`${label} manager opens`, await page.evaluate(() => !!document.getElementById('pm-manager-panel')));
    await shot('05-manager');
    await page.locator('.pm-manager-section .pm-manager-rowname').first().click();
    await page.waitForTimeout(100);
    await page.locator('.pm-manager-variantrow .pm-manager-btn', { hasText: '편집' }).first().click();
    await page.waitForTimeout(100);
    await page.fill('.pm-manager-editor-text', '새 본문입니다.');
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('pm:changed')));
    await page.waitForTimeout(50);
    await slowClick(page, page.locator('.pm-manager-editorfoot .pm-manager-btn', { hasText: '저장' }));
    const after = await ctxEval(page);
    expect(`${label} slow click on [저장] writes the body`, after.powerUserSettings.persona_description === '## 외모\n새 본문입니다.\n\n## 성격\n조용하고 침착함', after.powerUserSettings.persona_description);
    expect(`${label} singular and map agree`, after.powerUserSettings.persona_description === after.powerUserSettings.persona_descriptions[ALICE].description);
    await shot('06-editor-saved');
    await page.locator('.pm-manager-editorfoot .pm-manager-btn', { hasText: '목록으로' }).click();
    await page.waitForTimeout(100);

    for (const t of ['페르소나', '언어별 이름', '프롬프트 배치']) {
        await page.locator('.pm-manager-fold .pm-manager-rowname', { hasText: t }).first().click();
        await page.waitForTimeout(80);
    }
    await shot('07-folds');

    /* Image replacement: the picked file is framed first, then written with the
       crop, and every picture of the persona follows at once. */
    const iconBefore = await page.evaluate(() => document.querySelector('#pm-quickbar .pm-quickbar-img')?.getAttribute('src'));
    await page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 300; canvas.height = 200;
        canvas.getContext('2d').fillRect(0, 0, 300, 200);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const input = document.querySelector('.pm-manager-file');
        const transfer = new DataTransfer();
        transfer.items.add(new File([blob], 'new.png', { type: 'image/png' }));
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(900);
    expect(`${label} picked image opens the framing editor`, await page.locator('.pm-framing .pm-framing-frame').count() === 1);
    await shot('07b-framing-upload');
    await page.locator('.pm-framing .pm-manager-btn', { hasText: '현재 위치로 적용' }).click();
    await page.waitForTimeout(400);
    const uploads = await page.evaluate(() => window.__fetches.filter(u => u.startsWith('/api/avatars/upload')));
    expect(`${label} framed upload sends a crop`, uploads.some(u => u.includes('crop=')), uploads);
    expect(`${label} editor closes after the upload`, await page.locator('.pm-framing').count() === 0);
    const iconAfter = await page.evaluate(() => document.querySelector('#pm-quickbar .pm-quickbar-img')?.getAttribute('src'));
    expect(`${label} send-bar icon shows the new picture at once`, iconAfter && iconAfter !== iconBefore && iconAfter.includes('pmv='), [iconBefore, iconAfter]);
    const hostThumb = await page.evaluate(() => document.getElementById('host-alice-thumb')?.getAttribute('src'));
    expect(`${label} SillyTavern's own persona image follows`, hostThumb?.includes('pmv='), hostThumb);
    await page.locator('.pm-manager-btn', { hasText: '전문' }).first().click();
    await page.waitForTimeout(150);
    await shot('08-fulltext');
    // The joined view: edited as one text, saved back into the items along the title lines.
    await page.locator('.pm-full .pm-manager-actions .pm-manager-btn', { hasText: '전문' }).click();
    await page.waitForTimeout(150);
    const raw = page.locator('.pm-full-raw-text');
    expect(`${label} joined full text is an editable box`, await raw.count() === 1);
    if (await raw.count() === 1) {
        const before = await raw.inputValue();
        const readDescription = () => page.evaluate(a => window.SillyTavern.getContext().powerUserSettings.persona_descriptions[a].description, ALICE);
        await raw.fill(`${before}\nPM-SMOKE-RAW`);
        await shot('08b-fulltext-raw');
        await page.locator('.pm-full .pm-manager-editorfoot .pm-manager-btn', { hasText: '전체 저장' }).click();
        await page.waitForTimeout(250);
        const saved = await readDescription();
        expect(`${label} joined edit reaches the description`, saved.trimEnd().endsWith('PM-SMOKE-RAW'), saved);
        expect(`${label} joined view stays open after saving`, await page.locator('.pm-full-raw-text').count() === 1);
        // Titles stripped: the text cannot be divided, so the view keeps it rather than switch.
        const lines = before.split('\n');
        await page.locator('.pm-full-raw-text').fill(lines.filter((line, i) => i === 0 || !/^(##|\S+:$|<|\[)/.test(line.trim())).join('\n'));
        await page.locator('.pm-full .pm-manager-actions .pm-manager-btn', { hasText: '항목별' }).click();
        await page.waitForTimeout(150);
        expect(`${label} undividable joined text keeps the joined view`, await page.locator('.pm-full-raw-text').count() === 1);
        await page.locator('.pm-full-raw-text').fill(before);
        await page.locator('.pm-full .pm-manager-editorfoot .pm-manager-btn', { hasText: '전체 저장' }).click();
        await page.waitForTimeout(250);
        expect(`${label} joined edit undone`, (await readDescription()) === saved.replace(/\nPM-SMOKE-RAW\s*$/, ''), await readDescription());
        // Clear-all asks nothing; its undo brings the text back, even after a save.
        const kept = await readDescription();
        const fullBtn = text => page.locator('.pm-full .pm-manager-btn', { hasText: text });
        await fullBtn('전체 비우기').click();
        await page.waitForTimeout(150);
        expect(`${label} clear-all empties the joined box`, (await page.locator('.pm-full-raw-text').inputValue()) === '');
        await fullBtn('전체 저장').click();
        await page.waitForTimeout(250);
        expect(`${label} saved clear-all empties the description`, (await readDescription()) === '', await readDescription());
        await fullBtn('되돌리기').click();
        await page.waitForTimeout(150);
        expect(`${label} undo refills the joined box`, (await page.locator('.pm-full-raw-text').inputValue()) === kept);
        await shot('08c-fulltext-undo');
        await fullBtn('전체 저장').click();
        await page.waitForTimeout(250);
        expect(`${label} undone clear saves back`, (await readDescription()) === kept, await readDescription());
        expect(`${label} undo is spent once used`, await fullBtn('되돌리기').count() === 0);
        await page.locator('.pm-full .pm-manager-actions .pm-manager-btn', { hasText: '항목별' }).click();
        await page.waitForTimeout(150);
        expect(`${label} joined view returns to the item boxes`, await page.locator('.pm-full-raw-text').count() === 0);
        const boxes = () => page.locator('.pm-full-text').evaluateAll(areas => areas.map(area => area.value));
        const filled = await boxes();
        await page.locator('.pm-full .pm-manager-btn', { hasText: '전체 비우기' }).click();
        await page.waitForTimeout(150);
        expect(`${label} clear-all empties every item box`, (await boxes()).every(value => value === ''), await boxes());
        await page.locator('.pm-full .pm-manager-btn', { hasText: '되돌리기' }).click();
        await page.waitForTimeout(150);
        expect(`${label} undo refills every item box`, JSON.stringify(await boxes()) === JSON.stringify(filled), [filled, await boxes()]);
    }
    await page.locator('.pm-manager-editorfoot .pm-manager-btn', { hasText: '목록으로' }).click();
    await page.waitForTimeout(100);

    for (const [i, name] of ['versions', 'history', 'assets', 'labels'].entries()) {
        await page.locator('.pm-manager-tab').nth(i + 1).click();
        await page.waitForTimeout(250);
        if (name === 'versions') { await page.locator('.pm-manager-version .pm-manager-rowname').first().click(); await page.waitForTimeout(150); }
        if (name === 'history') {
            await page.locator('.pm-manager-tabbody select').first().selectOption({ index: 1 });
            await page.waitForTimeout(150);
            const row = page.locator('.pm-manager-historyrow').first();
            if (await row.count()) { await row.click(); await page.waitForTimeout(150); }
        }
        await shot(`1${i}-${name}`);
    }
    await page.locator('.pm-manager-tab').nth(3).click();
    await page.waitForTimeout(250);
    expect(`${label} asset rows exclude the backup`, await page.locator('.pm-manager-assetrow').count() === 2);

    await page.locator('.pm-manager-target').click();
    await page.waitForTimeout(150);
    await shot('14-picker');
    await page.locator('.pm-manager-personarow').nth(1).click();
    await page.waitForTimeout(200);
    await page.locator('.pm-manager-header .pm-manager-btn', { hasText: '닫기' }).click();
    await page.waitForTimeout(200);
    expect(`${label} closing the manager returns to the panel`, await page.evaluate(() => !!document.getElementById('pm-quickbar-panel')));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect(`${label} escape closes the panel`, await page.evaluate(() => !document.getElementById('pm-quickbar-panel')));

    /* Outside edit on a persona whose text sits in several items: each item takes
       its own part back, and an edit that lost a title is refused untouched. */
    await page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        const p = c.extensionSettings['persona-manager'].personas['1700000000000-alice.png'];
        for (const s of p.sections) p.variants[s.id][0].text = '';
        p.variants[p.sections[0].id][0].text = '검은 머리';
        p.variants[p.sections[1].id][0].text = '조용함';
        p.headingFormat = 'markdown';
    });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('pm:changed')));
    await openPanel(page);
    await ensureOpen(page, 0);
    await page.locator('.pm-quickbar-row', { hasText: 'v1' }).first().click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    const outside = async text => page.evaluate(async t => {
        const c = window.SillyTavern.getContext();
        c.powerUserSettings.persona_descriptions['1700000000000-alice.png'].description = t;
        c.powerUserSettings.persona_description = t;
        await c.eventSource.emit(c.event_types.PERSONA_UPDATED, '1700000000000-alice.png');
    }, text);
    const liveTexts = () => page.evaluate(() => {
        const p = window.SillyTavern.getContext().extensionSettings['persona-manager'].personas['1700000000000-alice.png'];
        return p.sections.map(s => p.variants[s.id].find(v => v.id === p.activePicks[s.id])?.text ?? '');
    });
    await outside('## 외모\n검은 머리\n\n성격 제목이 지워진 글');
    await openPanel(page);
    await page.waitForTimeout(100);
    await page.locator('.pm-quickbar-banner .pm-quickbar-btn', { hasText: '가져오기' }).click();
    await page.waitForTimeout(200);
    const refused = await liveTexts();
    expect(`${label} absorb refuses an edit that lost a title`, refused[0] === '검은 머리' && refused[1] === '조용함', refused);
    expect(`${label} a refused absorb keeps the banner`, await page.locator('.pm-quickbar-banner', { hasText: '외부' }).count() === 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await outside('## 외모\n검은 머리\n\n## 성격\n조용하고 다정함');
    await openPanel(page);
    await page.waitForTimeout(100);
    await page.locator('.pm-quickbar-banner .pm-quickbar-btn', { hasText: '가져오기' }).click();
    await page.waitForTimeout(200);
    const split = await liveTexts();
    expect(`${label} absorb gives every item its own part`, split[0] === '검은 머리' && split[1] === '조용하고 다정함', split);
    expect(`${label} a split absorb clears the banner`, await page.locator('.pm-quickbar-banner', { hasText: '외부' }).count() === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    /* Outside edit, absorbed into the item that holds the text */
    await page.evaluate(() => {
        const c = window.SillyTavern.getContext();
        const p = c.extensionSettings['persona-manager'].personas['1700000000000-alice.png'];
        // One item holds everything, as after a whole-text adopt.
        for (const s of p.sections) p.variants[s.id][0].text = '';
        p.variants[p.sections[0].id][0].text = '원래 본문';
        p.headingFormat = 'none';
    });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('pm:changed')));
    await openPanel(page);
    await ensureOpen(page, 0);
    await page.locator('.pm-quickbar-row', { hasText: 'v1' }).first().click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        c.powerUserSettings.persona_descriptions['1700000000000-alice.png'].description = '밖에서 고친 본문';
        c.powerUserSettings.persona_description = '밖에서 고친 본문';
        await c.eventSource.emit(c.event_types.PERSONA_UPDATED, '1700000000000-alice.png');
    });
    await openPanel(page);
    await page.waitForTimeout(100);
    expect(`${label} outside edit shows the banner`, await page.locator('.pm-quickbar-banner', { hasText: '외부' }).count() === 1);
    await shot('15-diverged');
    await page.locator('.pm-quickbar-banner .pm-quickbar-btn', { hasText: '가져오기' }).click();
    await page.waitForTimeout(200);
    const absorbed = await page.evaluate(() => {
        const p = window.SillyTavern.getContext().extensionSettings['persona-manager'].personas['1700000000000-alice.png'];
        // The live pick of each item, in item order, with its index kept.
        return p.sections.map((s, i) => [i, p.variants[s.id].find(v => v.id === p.activePicks[s.id])?.text ?? '']).filter(([, t]) => t);
    });
    expect(`${label} absorb lands in the first item, which held the text`, absorbed.length === 1 && absorbed[0][0] === 0 && absorbed[0][1] === '밖에서 고친 본문', absorbed);
    expect(`${label} absorb clears the banner`, await page.locator('.pm-quickbar-banner', { hasText: '외부' }).count() === 0);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    /* Several items deleted at once; deleting all of them leaves one empty item */
    await openPanel(page);
    await openManager(page);
    await page.locator('.pm-manager-tabbody .pm-manager-btn', { hasText: '항목 선택' }).click();
    await page.waitForTimeout(150);
    const checks = page.locator('.pm-manager-itemcheck');
    const itemCount = await checks.count();
    expect(`${label} select mode puts a checkbox on every item`, itemCount >= 2, itemCount);
    await checks.first().check();
    await page.waitForTimeout(150);
    expect(`${label} delete button counts the checked items`, await page.locator('.pm-manager-btn', { hasText: '선택 항목 삭제 (1)' }).count() === 1);
    await page.locator('.pm-manager-btn', { hasText: '전체 선택' }).click();
    await page.waitForTimeout(150);
    await shot('15b-item-select');
    await page.locator('.pm-manager-btn', { hasText: `선택 항목 삭제 (${itemCount})` }).click();
    await page.waitForTimeout(250);
    const afterDrop = await page.evaluate(a => {
        const c = window.SillyTavern.getContext();
        const p = c.extensionSettings['persona-manager'].personas[a];
        return { names: p.sections.map(s => s.name), text: c.powerUserSettings.persona_descriptions[a].description };
    }, ALICE);
    expect(`${label} deleting every item leaves one empty item`, afterDrop.names.length === 1 && afterDrop.names[0] === '본문' && afterDrop.text === '', afterDrop);
    expect(`${label} select mode ends after deleting`, await page.locator('.pm-manager-itemcheck').count() === 0);
    await page.locator('.pm-manager-header .pm-manager-btn', { hasText: '닫기' }).click();
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    /* Duplicate names without a direct source: every write locks */
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        c.powerUserSettings.personas['1700000000001-bob.png'] = 'Alice';
        document.getElementById('user_avatar_block').innerHTML = '';
        await c.eventSource.emit(c.event_types.PERSONA_CHANGED);
    });
    await openPanel(page);
    expect(`${label} duplicate names lock editing`, await page.locator('.pm-quickbar-banner', { hasText: '이름이 같은' }).count() === 1);
    expect(`${label} switching stays enabled while locked`, await page.locator('[data-pm-avatar]:not(.pm-disabled):not([disabled])').count() === 3);
    await shot('16-ambiguous');
    await page.keyboard.press('Escape');

    /* Read-only root from a newer build */
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        c.powerUserSettings.personas['1700000000001-bob.png'] = 'Bob';
        c.extensionSettings['persona-manager'].schemaVersion = 99;
        await c.eventSource.emit(c.event_types.PERSONA_CHANGED);
    });
    await openPanel(page);
    expect(`${label} newer schema is read-only`, await page.locator('.pm-quickbar-banner', { hasText: '읽기 전용' }).count() === 1);
    await shot('17-readonly');
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        c.extensionSettings['persona-manager'].schemaVersion = 3;
        await c.eventSource.emit(c.event_types.PERSONA_CHANGED);
    });

    /* Greeting swipe after a rename: the baked {{user}} follows, the cat keeps
       her name because the card wrote it literally. */
    const greeting = await page.evaluate(async () => {
        const c = window.SillyTavern.getContext();
        const saved = c.chat.splice(0, c.chat.length, {
            name: 'Char', is_user: false, mes: 'Hello Alice!', swipe_id: 0,
            swipes: ['Hello Alice!', 'Alice, welcome back. Alice the cat says hi.'], swipe_info: [{}, {}],
        });
        c.powerUserSettings.personas['1700000000000-alice.png'] = 'Alicia';
        window.__setName1('Alicia');
        await c.eventSource.emit(c.event_types.PERSONA_RENAMED, { avatarId: '1700000000000-alice.png' });
        const first = window.SillyTavern.getContext().chat[0];
        first.swipe_id = 1;
        first.mes = first.swipes[1];
        await c.eventSource.emit(c.event_types.MESSAGE_SWIPED, 0);
        const result = { mes: first.mes, swipes: [...first.swipes] };
        c.chat.splice(0, c.chat.length, ...saved);
        c.powerUserSettings.personas['1700000000000-alice.png'] = 'Alice';
        window.__setName1('Alice');
        await c.eventSource.emit(c.event_types.PERSONA_RENAMED, { avatarId: '1700000000000-alice.png' });
        return result;
    });
    expect(`${label} swiped greeting shows the current {{user}}`, greeting.mes === 'Alicia, welcome back. Alice the cat says hi.', greeting);
    expect(`${label} every greeting swipe follows the rename`, greeting.swipes[0] === 'Hello Alicia!', greeting);
    await page.waitForTimeout(200);

    /* Settings drawer and teardown */
    await page.locator('#persona-manager_settings .pm-settings-header').click();
    await page.waitForTimeout(150);
    await page.evaluate(() => document.getElementById('persona-manager_settings')?.scrollIntoView());
    await shot('18-settings');
    expect(`${label} settings drawer opens`, await page.evaluate(() => document.getElementById('persona-manager_settings_content')?.style.display === 'block'));
    expect(`${label} settings has section captions`, await page.locator('.pm-settings-section').count() === 6);
    expect(`${label} destroy hook runs`, await page.evaluate(() => { try { globalThis.__personaManagerDestroy(); return true; } catch { return false; } }));
    const leftovers = await page.evaluate(() => [...document.querySelectorAll('[id^="pm-"], [id^="persona-manager"]')].map(n => n.id));
    expect(`${label} teardown leaves no nodes`, leftovers.length === 0, leftovers);
    expect(`${label} no console or page errors`, errors.length === 0, errors);
    await browser.close();
}

await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));
try {
    await tour(411, 'phone', false);
    await tour(1280, 'desktop', true);
} finally {
    server.close();
}
if (failures.length) {
    console.error(`smoke: ${failures.length} failure(s)`);
    for (const f of failures) console.error(' -', f);
    process.exit(1);
}
console.log('smoke: ok (screenshots in test/browser/out)');
