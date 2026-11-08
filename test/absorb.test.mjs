// The automatic pass over edits made in SillyTavern's own persona box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setContextProvider, getRoot, refresh, autoAbsorbOutside } from '../modules/state.js';
import { compose, markComposed } from '../modules/compose.js';

const AVATAR = 'me.png';

function world(format = 'markdown') {
    const persona = {
        headingFormat: format,
        sections: [{ id: 'a', name: '외모' }, { id: 'b', name: '성격' }],
        variants: { a: [{ id: 'a1', label: '기본', text: '검은 머리' }], b: [{ id: 'b1', label: '기본', text: '조용함' }] },
        activePicks: { a: 'a1', b: 'b1' },
        versions: [],
    };
    markComposed(persona, compose(persona).text);
    const pu = {
        personas: { [AVATAR]: 'Me' },
        persona_descriptions: { [AVATAR]: { description: compose(persona).text } },
        persona_description: compose(persona).text,
    };
    let saves = 0;
    const ctx = {
        name1: 'Me',
        powerUserSettings: pu,
        extensionSettings: { 'persona-manager': { schemaVersion: 3, personas: { [AVATAR]: persona }, labels: [], settings: {} } },
        saveSettingsDebounced() { saves++; },
        eventSource: { emit() {} },
        event_types: {},
    };
    setContextProvider(() => ctx);
    refresh();
    const typeInST = text => { pu.persona_descriptions[AVATAR].description = text; pu.persona_description = text; };
    const live = () => {
        const p = getRoot().personas[AVATAR];
        return p.sections.map(s => p.variants[s.id].find(v => v.id === p.activePicks[s.id]).text);
    };
    return { pu, typeInST, live, saves: () => saves };
}

test('an edit typed in SillyTavern lands in the items and is left as typed there', () => {
    const w = world();
    const typed = '## 외모\n검은 머리, 큰 키\n\n## 성격\n조용하고 다정함\n';
    w.typeInST(typed);
    const result = autoAbsorbOutside();
    assert.deepEqual(result, { ok: true, changed: ['외모', '성격'] });
    assert.deepEqual(w.live(), ['검은 머리, 큰 키', '조용하고 다정함']);
    // Nothing written back into SillyTavern's box, and the edit no longer reads as outside.
    assert.equal(w.pu.persona_descriptions[AVATAR].description, typed);
    assert.equal(refresh().diverged, false);
    assert.equal(autoAbsorbOutside(), null);
    // The previous bodies are in history.
    assert.equal(getRoot().personas[AVATAR].history.a1.at(-1).text, '검은 머리');
});

test('an edit that cannot be divided is left for the banner, and the switch turns the pass off', () => {
    const w = world();
    w.typeInST('## 외모\n검은 머리\n\n성격 제목이 지워진 글');
    assert.deepEqual(autoAbsorbOutside(), { ok: false, reason: 'noMatch' });
    assert.deepEqual(w.live(), ['검은 머리', '조용함']);
    assert.equal(refresh().diverged, true);

    const off = world();
    getRoot().settings.autoAbsorbOutside = false;
    off.typeInST('## 외모\nx\n\n## 성격\ny');
    assert.equal(autoAbsorbOutside(), null);
    assert.deepEqual(off.live(), ['검은 머리', '조용함']);
});
