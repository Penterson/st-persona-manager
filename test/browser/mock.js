// Minimal SillyTavern mock: enough surface for the extension to boot and run.
(function () {
    const listeners = new Map();
    const eventSource = {
        on(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        removeListener(type, fn) { const l = listeners.get(type) ?? []; const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1); },
        async emit(type, ...args) { for (const fn of [...(listeners.get(type) ?? [])]) await fn(...args); },
    };
    const event_types = {
        APP_READY: 'app_ready', PERSONA_CHANGED: 'persona_changed', SETTINGS_UPDATED: 'settings_updated',
        PERSONA_UPDATED: 'persona_updated', PERSONA_RENAMED: 'persona_renamed', PERSONA_CREATED: 'persona_created',
        PERSONA_DELETED: 'persona_deleted', CHAT_CHANGED: 'chat_changed', USER_MESSAGE_RENDERED: 'user_message_rendered',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered', MESSAGE_UPDATED: 'message_updated',
    };
    const powerUserSettings = {
        personas: {
            '1700000000000-alice.png': 'Alice',
            '1700000000001-bob.png': 'Bob',
            '1700000000002-carol.png': 'Carol Alexandra Whitmore-Longname',
        },
        persona_descriptions: {
            '1700000000000-alice.png': { description: '## 외모\n검은 머리, 큰 키\n\n## 성격\n조용하고 침착함', lorebook: '', title: '', position: 0, depth: 2, role: 0 },
            '1700000000001-bob.png': { description: 'Bob is a cheerful guy.', lorebook: '', title: '' },
        },
        persona_description: '## 외모\n검은 머리, 큰 키\n\n## 성격\n조용하고 침착함',
        default_persona: '1700000000000-alice.png',
        never_resize_avatars: false,
    };
    const extensionSettings = {};
    const chat = [
        { name: 'Alice', is_user: true, mes: '안녕하세요. 오늘 날씨가 참 좋네요. 산책하러 나가볼까요?' },
        { name: 'Char', is_user: false, mes: '좋은 생각이에요. 공원까지 같이 걸어가요. {{pimg::walk}} 그리고 사진도 찍어요.' },
    ];
    let name1 = 'Alice';
    const macros = {};
    const popupAnswers = window.__popupAnswers = [];
    const saveCalls = window.__saveCalls = [];
    const slash = window.__slash = [];
    const ctxOf = () => ({
        eventSource, event_types, powerUserSettings, extensionSettings, chat, name1, name2: 'Char',
        chatMetadata: {},
        saveSettingsDebounced() { saveCalls.push(Date.now()); },
        uuidv4() { return 'u-' + Math.random().toString(36).slice(2, 10); },
        getThumbnailUrl(type, file) { return `/thumb/${type}/${encodeURIComponent(file)}`; },
        getRequestHeaders() { return { 'Content-Type': 'application/json' }; },
        registerMacro(name, fn) { macros[name] = fn; },
        unregisterMacro(name) { delete macros[name]; },
        POPUP_TYPE: { CONFIRM: 1, INPUT: 2 },
        async callGenericPopup(message, type, initial) {
            window.__lastPopup = { message, type, initial };
            const next = popupAnswers.length ? popupAnswers.shift() : (type === 1 ? true : (initial ?? ''));
            await new Promise(r => setTimeout(r, 5));
            return next;
        },
        SlashCommandParser: { commands: { 'persona-set': {}, 'persona-update': {}, 'persona-duplicate': {} } },
        async executeSlashCommandsWithOptions(text) {
            slash.push(text);
            const m = /^\/persona-set\s+"(.*)"$/.exec(text);
            if (m) { name1 = m[1].replace(/\\(.)/g, '$1'); return; }
            const u = /^\/persona-update persona="(.*)" name="(.*)"$/.exec(text);
            if (u) {
                for (const [k, v] of Object.entries(powerUserSettings.personas)) if (v === u[1]) powerUserSettings.personas[k] = u[2];
                if (name1 === u[1]) name1 = u[2];
            }
        },
        getTokenCount(text) { return Math.ceil(String(text).length / 3); },
    });
    window.SillyTavern = { getContext: ctxOf };
    window.__macros = macros;
    window.__setName1 = v => { name1 = v; };
    window.__selectAvatar = id => {
        for (const n of document.querySelectorAll('#user_avatar_block [data-avatar-id]')) n.classList.toggle('selected', n.dataset.avatarId === id);
        name1 = powerUserSettings.personas[id];
    };
    window.toastr = (() => {
        const log = window.__toasts = [];
        const show = kind => msg => { log.push([kind, msg]); const t = document.createElement('div'); t.className = 'toast'; t.textContent = `${kind}: ${msg}`; document.getElementById('toast-container')?.append(t); setTimeout(() => t.remove(), 3000); };
        return { info: show('info'), success: show('success'), warning: show('warning'), error: show('error') };
    })();
    // Intercept network calls the extension makes.
    const realFetch = window.fetch.bind(window);
    window.__fetches = [];
    window.fetch = async (url, opts) => {
        const u = String(url);
        window.__fetches.push(u);
        if (u.startsWith('/api/sprites/get')) {
            const name = decodeURIComponent(u.split('name=')[1] ?? '');
            if (name === 'persona_1700000000000-alice') return new Response(JSON.stringify([{ label: 'walk', path: '/sprite/walk.png' }, { label: 'pm-backup-1', path: '/sprite/b.png' }, { label: '포즈 1.5', path: '/sprite/p.png' }]), { status: 200 });
            return new Response('[]', { status: 200 });
        }
        if (u.startsWith('/api/sprites/upload')) return new Response('{}', { status: 200 });
        if (u.startsWith('/api/sprites/delete')) return new Response('{}', { status: 200 });
        if (u.startsWith('/api/avatars/upload')) return new Response('{}', { status: 200 });
        if (u.startsWith('/thumb/') || u.startsWith('/sprite/')) {
            const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
            return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
        }
        return realFetch(url, opts);
    };
    document.addEventListener('DOMContentLoaded', () => {
        const chatEl = document.getElementById('chat');
        chat.forEach((m, i) => { const d = document.createElement('div'); d.className = 'mes'; d.setAttribute('mesid', i); const t = document.createElement('div'); t.className = 'mes_text'; t.textContent = m.mes; d.append(t); chatEl.append(d); });
        setTimeout(() => eventSource.emit(event_types.APP_READY), 20);
    });
})();
