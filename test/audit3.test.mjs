// Regression tests for the 0.3.3 audit: each one reproduces a defect found in
// 0.3.2 and fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, cropFromView, validCrop } from '../modules/framing.js';
import { chatSources, contextLanguage, stripMarkup } from '../modules/search-pure.js';
import { migrate, SCHEMA_VERSION } from '../modules/store.js';
import { selectedNames, groupLabelOf } from '../modules/assets.js';
import { assetSelected, toggleAssetSelection, versionsBindingAsset } from '../modules/manager-pure.js';
import { describeSelection } from '../modules/quickbar-pure.js';
import { compose, splitByComposition } from '../modules/compose.js';
import { cardGreetings, syncGreetingUser } from '../modules/greeting.js';
import { setContextProvider, adoptFor, getRoot, saveAndComposeFor, KEEP_DESCRIPTION_KINDS } from '../modules/state.js';

/* framing */

test('a frame pushed against the left or top edge gives a crop at 0, never a hair below it', () => {
    const view = clampView(1200, 800, { zoom: 1.15, cx: -5, cy: 0.5 });
    const crop = cropFromView(1200, 800, view);
    assert.equal(crop.x, 0);
    assert.ok(validCrop(crop));
    // A crop already stored a hair below zero is read as the edge, not as no crop.
    assert.deepEqual(validCrop({ x: -2e-17, y: 0.1, w: 0.5, h: 0.5 }), { x: 0, y: 0.1, w: 0.5, h: 0.5 });
    assert.equal(validCrop({ x: -0.01, y: 0, w: 0.5, h: 0.5 }), null);
});

/* conversation language */

test('a long character reply no longer crowds the user out of the language vote', () => {
    const chat = [
        { is_user: false, mes: 'Hello there, welcome.' },
        { is_user: true, mes: '안녕하세요 만나서 반갑습니다 잘 부탁드립니다' },
        { is_user: false, mes: 'x '.repeat(450) },
    ];
    const sources = chatSources(chat);
    assert.equal(sources.user.length, 1);
    assert.equal(sources.reply.length, 1);
});

test('hangul weighs as three Latin letters in the decision too, not only in the confidence', () => {
    assert.equal(contextLanguage({ user: 'Seraphina와 Gregory가 마을에 도착했다' }).lang, 'ko');
});

test('markup stripping leaves a heart and a Korean aside alone', () => {
    const kept = stripMarkup('I <3 this place -> go home');
    assert.match(kept, /this place/);
    assert.match(stripMarkup('<이게 뭐지?> 그녀는 중얼거렸다'), /이게 뭐지/);
    assert.doesNotMatch(stripMarkup('<b>굵게</b>'), /<b>/);
});

/* data model */

test('schema 3: a version saved before an item existed gets that item\'s current choice, once', () => {
    assert.equal(SCHEMA_VERSION, 3);
    const root = migrate({
        schemaVersion: 2,
        personas: {
            a: {
                sections: [{ id: 's1', name: '외모' }, { id: 's2', name: '배경' }],
                variants: { s1: [{ id: 'v1', text: 'tall' }], s2: [{ id: 'v2', text: 'story' }] },
                activePicks: { s1: 'v1', s2: 'v2' },
                // The null first, so finding V has to step over it.
                versions: [null, { id: 'V', name: 'V', picks: { s1: 'v1' } }],
            },
        },
    });
    assert.equal(root.schemaVersion, 3);
    assert.deepEqual(root.personas.a.versions[1].picks, { s1: 'v1', s2: 'v2' });
    // A null entry left by a hand edit does not take the icon label down.
    assert.equal(describeSelection({ ...root.personas.a, activeVersionId: 'V' }), 'V');
});

test('KEEP_DESCRIPTION_KINDS answers has() and cannot be added to', () => {
    assert.equal(KEEP_DESCRIPTION_KINDS.has('tag-add'), true);
    assert.equal(KEEP_DESCRIPTION_KINDS.has('pick'), false);
    assert.equal(typeof KEEP_DESCRIPTION_KINDS.add, 'undefined');
});

/* assets */

test('a 0.2.0 group label in a selection covers every file of the group, a file name covers only itself', () => {
    const all = ['pose-1', 'pose-2', 'Smile'];
    assert.equal(groupLabelOf('pose-1'), 'pose');
    assert.deepEqual([...selectedNames(['pose', 'smile'], all)].sort(), ['Smile', 'pose-1', 'pose-2']);
    assert.equal(assetSelected({ assetSelection: ['pose'] }, 'pose-1', ['pose', 'pose-1']), false);
    assert.equal(assetSelected({ assetSelection: ['pose'] }, 'pose', ['pose', 'pose-1']), true);
    // Unticking one file of a legacy group keeps the rest of it.
    const version = { assetSelection: ['pose', 'smile'] };
    assert.deepEqual(toggleAssetSelection(version, 'pose-1', all), ['pose-2', 'Smile']);
});

test('the delete warning counts versions bound under the old lowercased label', () => {
    const persona = { versions: [{ id: 'a', avatarAsset: 'smile' }, null, { id: 'b', avatarAsset: 'Walk' }] };
    assert.deepEqual(versionsBindingAsset(persona, 'Smile', ['Smile', 'Walk']).map(v => v.id), ['a']);
});

/* outside edit taken back into several items */

function persona(format, template, untitled) {
    return {
        headingFormat: format,
        headingTemplate: template,
        sections: [...(untitled ? [{ id: 'u', name: '머리말', untitled: true }] : []), { id: 'a', name: '외모' }, { id: 'b', name: '성격' }, { id: 'c', name: '빈칸' }],
        variants: { u: [{ id: 'u1', text: '소개' }], a: [{ id: 'a1', text: '검은 머리\n큰 키' }], b: [{ id: 'b1', text: '조용함' }], c: [{ id: 'c1', text: '' }] },
        activePicks: { u: 'u1', a: 'a1', b: 'b1', c: 'c1' },
    };
}

test('an outside edit divides back into the items it was composed from, in every title format', () => {
    const cases = [['markdown', null, false], ['plain', null, false], ['own', { open: '<{name}>', close: '</{name}>' }, true], ['own', { open: '[{name}]' }, true]];
    for (const [format, template, untitled] of cases) {
        const p = persona(format, template, untitled);
        const edited = compose(p).text.replace('조용함', '조용하고 침착함');
        const parts = splitByComposition(p, edited);
        assert.ok(parts, `${format} ${JSON.stringify(template)}`);
        assert.equal(parts.find(part => part.sectionId === 'b').text, '조용하고 침착함');
        assert.equal(parts.find(part => part.sectionId === 'a').text, '검은 머리\n큰 키');
    }
    const md = persona('markdown', null, false);
    assert.equal(splitByComposition(md, '## 외모\n검은 머리\n\n조용함'), null, 'a removed title');
    assert.equal(splitByComposition(md, '서문\n## 외모\nx\n\n## 성격\ny'), null, 'text with no item to hold it');
});

/* greeting */

test('a generated swipe after the card greetings is left alone, and the card\'s own words keep their names', () => {
    const card = { data: { first_mes: '{{user}}, welcome back. Alice the cat says hi.', alternate_greetings: [] } };
    const message = {
        mes: 'Alice, welcome back. Alice the cat says hi.',
        swipes: ['Alice, welcome back. Alice the cat says hi.', 'Alice looks up. Alice the cat purrs.'],
        swipe_id: 0,
    };
    const templates = cardGreetings(card, message);
    assert.equal(templates.length, 1);
    syncGreetingUser(message, ['Alice'], 'Alicia', templates);
    assert.equal(message.mes, 'Alicia, welcome back. Alice the cat says hi.');
    assert.equal(message.swipes[1], 'Alice looks up. Alice the cat purrs.');
});

/* state: writes against a fake SillyTavern */

function fakeContext(description) {
    let n = 0;
    return {
        name1: 'Mina',
        extensionSettings: {},
        powerUserSettings: {
            personas: { 'mina.png': 'Mina' },
            persona_descriptions: { 'mina.png': { description } },
            persona_description: description,
        },
        chatMetadata: {},
        saveSettingsDebounced() {},
        eventSource: { emit() { return Promise.resolve(); } },
        event_types: { PERSONA_UPDATED: 'persona_updated' },
        uuidv4: () => `id-${++n}`,
    };
}

test('with an outside edit pending, a write that changes nothing of ours leaves SillyTavern\'s text alone', () => {
    const ctx = fakeContext('## 외모\n키 큼\n\n## 성격\n착함');
    setContextProvider(() => ctx);
    try {
        const p = adoptFor('mina.png');
        assert.equal(p.sections.length, 2);
        ctx.powerUserSettings.persona_descriptions['mina.png'].description = 'OUTSIDE';
        ctx.powerUserSettings.persona_description = 'OUTSIDE';
        // An empty item added: the composition is what SillyTavern was last given.
        p.sections.push({ id: 'e', name: '빈 항목' });
        p.variants.e = [{ id: 'e1', text: '' }];
        p.activePicks.e = 'e1';
        const kept = saveAndComposeFor('mina.png');
        assert.equal(kept.kept, true);
        assert.equal(ctx.powerUserSettings.persona_description, 'OUTSIDE');
        assert.equal(p.variants[p.sections[0].id].length, 1, 'no hidden 외부 수정 choice');
        // Applying a version asks for its text on purpose.
        const forced = saveAndComposeFor('mina.png', { force: true });
        assert.equal(forced.kept, undefined);
        assert.match(ctx.powerUserSettings.persona_description, /^## 외모/);
        assert.ok(forced.keptOutside, 'the outside text is kept as a choice');
    } finally {
        setContextProvider();
    }
});

test('right after 관리 시작, a metadata-only write does not rewrite a description that differs only in blank lines', () => {
    const original = '## 외모\n키 큼\n\n\n## 성격\n착함\n';
    const ctx = fakeContext(original);
    setContextProvider(() => ctx);
    try {
        adoptFor('mina.png');
        const result = saveAndComposeFor('mina.png', { write: false });
        assert.equal(result.kept, true);
        assert.equal(ctx.powerUserSettings.persona_descriptions['mina.png'].description, original);
    } finally {
        setContextProvider();
    }
});

test('a save while no persona can be confirmed active says so instead of reporting a plain success', () => {
    const ctx = fakeContext('본문');
    setContextProvider(() => ctx);
    try {
        const p = adoptFor('mina.png');
        ctx.name1 = 'Somebody else';
        p.variants[p.sections[0].id][0].text = '고친 본문';
        const result = saveAndComposeFor('mina.png');
        assert.equal(result.activeUnknown, true);
        assert.equal(ctx.powerUserSettings.persona_description, '본문', 'the prompt field was not guessed at');
        assert.equal(ctx.powerUserSettings.persona_descriptions['mina.png'].description, '고친 본문');
    } finally {
        setContextProvider();
    }
});

test('a stored root that is not an object is replaced once, so every read sees the same root', () => {
    const ctx = fakeContext('');
    ctx.extensionSettings['persona-manager'] = [];
    setContextProvider(() => ctx);
    try {
        const first = getRoot();
        assert.equal(first, getRoot());
        assert.equal(Array.isArray(ctx.extensionSettings['persona-manager']), false);
    } finally {
        setContextProvider();
    }
});
