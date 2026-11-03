// The context-aware language vote, the sprite listing normalisation and the
// greeting {{user}} sync: the three behaviours 0.3.0 added or replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextLanguage, chatSources, stripMarkup } from '../modules/search-pure.js';
import { languageContextOf, conversationLanguage } from '../modules/quickbar-pure.js';
import { assetNameFromPath, normalizeListing, findAsset, lookupLabel, withoutBackups, markFolderChanged, resetAssetProbes } from '../modules/assets.js';
import { versionImageState } from '../modules/manager-pure.js';
import { greetingNeedsUserSync, syncGreetingUser } from '../modules/greeting.js';

const KO_CARD = '유나는 조용한 도서관 사서다. 책을 좋아하고 말수가 적지만 다정하다.';
const EN_CARD = 'Yuna is a quiet librarian who loves books. She speaks little but is kind.';

test('a lone English greeting no longer outvotes a Korean card and name', () => {
    const chat = [{ is_user: false, mes: 'Welcome to the library. Can I help you?' }];
    // The old rule read the greeting alone.
    const ctx = { chat, characterId: 0, characters: [{ name: '유나', description: KO_CARD }] };
    assert.equal(conversationLanguage(ctx), 'ko');
});

test('the user writing Korean switches an English card to Korean', () => {
    const chat = [
        { is_user: false, mes: 'Welcome to the library. Can I help you find something today?' },
        { is_user: true, mes: '안녕하세요, 판타지 소설 좀 추천해 주세요.' },
    ];
    const ctx = { chat, characterId: 0, characters: [{ name: 'Yuna', description: EN_CARD }] };
    assert.equal(conversationLanguage(ctx), 'ko');
});

test('the user writing English switches a Korean card to English', () => {
    const chat = [
        { is_user: false, mes: '어서 오세요. 무엇을 찾으세요?' },
        { is_user: true, mes: 'Hi, could you recommend me a good fantasy novel?' },
    ];
    const ctx = { chat, characterId: 0, characters: [{ name: '유나', description: KO_CARD }] };
    assert.equal(conversationLanguage(ctx), 'en');
});

test('a fresh chat with a short greeting is still decided by the card', () => {
    const ctx = { chat: [{ is_user: false, mes: '...안녕.' }], characterId: 0, characters: [{ name: 'ユナ', description: '図書館で働く静かな司書。本が大好きで、口数は少ないが優しい。' }] };
    assert.equal(conversationLanguage(ctx), 'ja');
});

test('macros, markup and links do not vote', () => {
    assert.equal(stripMarkup('{{user}}에게 <b>인사</b> https://x.y/z').trim().replace(/\s+/g, ' '), '에게 인사');
    const { lang } = contextLanguage({ user: '{{user}} {{char}} <img src="a.png"> 응 그래 알았어 고마워 정말로' });
    assert.equal(lang, 'ko');
});

test('thin evidence answers null, and system messages never count', () => {
    assert.equal(contextLanguage({ user: 'ok' }).lang, null);
    const sources = chatSources([{ is_system: true, mes: 'System text in English' }, { is_user: false, mes: '첫 인사' }]);
    assert.equal(sources.greeting, '첫 인사');
    assert.deepEqual(sources.user, []);
});

test('group chats read every member card', () => {
    const ctx = {
        chat: [], groupId: 'g1', groups: [{ id: 'g1', members: ['a.png', 'b.png'] }],
        characters: [{ avatar: 'a.png', name: '민수', description: '' }, { avatar: 'b.png', name: '지은', description: '밝고 수다스러운 대학생이다.' }, { avatar: 'c.png', name: 'Other', description: EN_CARD }],
    };
    const sources = languageContextOf(ctx);
    assert.equal(sources.name, '민수 지은');
    assert.ok(!sources.card.includes('librarian'));
    assert.equal(conversationLanguage(ctx), 'ko');
});

test('sprite listing: names come from the file, not the grouped label', () => {
    // What current SillyTavern answers for these files.
    const listing = normalizeListing([
        { label: 'pm', path: '/characters/persona_a/pm-backup-1730000000000.png?t=20261103' },
        { label: 'smile', path: '/characters/persona_a/Smile.png?t=20261103' },
        { label: '포즈', path: '/characters/persona_a/포즈-1.png' },
        { label: '포즈', path: '/characters/persona_a/포즈-2.png' },
    ], 'persona_a');
    assert.deepEqual(listing.map(a => a.label), ['pm-backup-1730000000000', 'Smile', '포즈-1', '포즈-2']);
    assert.deepEqual(withoutBackups(listing).map(a => a.label), ['Smile', '포즈-1', '포즈-2']);
    assert.equal(assetNameFromPath('/characters/x/%ED%8F%AC%EC%A6%88.png'), '포즈');
    // Old bindings stored the lowercased label; one file answers, two do not.
    assert.equal(findAsset(listing, 'smile')?.label, 'Smile');
    assert.equal(findAsset(listing, '포즈'), null);
    assert.equal(findAsset(listing, '포즈-2')?.label, '포즈-2');
    assert.equal(lookupLabel(new Map([['Smile', '/s.png']]), 'smile'), '/s.png');
    assert.equal(versionImageState({ avatarAsset: 'smile' }, ['Smile', '포즈-1'], true).state, 'ok');
    assert.equal(versionImageState({ avatarAsset: 'smile' }, ['Smile', '포즈-1'], true).label, 'Smile');
});

test('a folder written this session gets a fresh address for every file', () => {
    resetAssetProbes();
    const before = normalizeListing([{ label: 'a', path: '/characters/f/a.png' }], 'f')[0].path;
    assert.equal(before, '/characters/f/a.png');
    markFolderChanged('f');
    const after = normalizeListing([{ label: 'a', path: '/characters/f/a.png?t=1' }], 'f')[0].path;
    assert.match(after, /^\/characters\/f\/a\.png\?t=1&pmv=\d+$/);
    resetAssetProbes();
});

test('greeting {{user}} sync: only untouched greetings, every swipe, exact name', () => {
    const message = {
        is_user: false,
        mes: 'Hello Alice, welcome.',
        swipe_id: 1,
        swipes: ['Hi Alice!', 'Hello Alice, welcome.', 'Alicea is not Alice.'],
    };
    const chat = [message];
    assert.equal(greetingNeedsUserSync(chat, 0), true);
    const changed = syncGreetingUser(message, 'Alice', 'Bob');
    assert.equal(changed, true);
    assert.deepEqual(message.swipes, ['Hi Bob!', 'Hello Bob, welcome.', 'Alicea is not Bob.']);
    assert.equal(message.mes, 'Hello Bob, welcome.');
    assert.equal(syncGreetingUser(message, 'Bob', 'Bob'), false);
    // Once the user has spoken, the greeting is history and is left alone.
    assert.equal(greetingNeedsUserSync([message, { is_user: true, mes: 'hi' }], 0), false);
    assert.equal(greetingNeedsUserSync(chat, 1), false);
});
