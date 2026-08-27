// Persona image assets on top of SillyTavern's sprites API.

const PREFIX = 'persona_';
// sanitize-filename truncates to 255 bytes, and the string we hand the server is
// the whole folder key, prefix included.
const MAX_KEY_BYTES = 255;

function truncateBytes(text, maxBytes) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length <= maxBytes) return text;
    // Step back to a UTF-8 boundary. A cut made mid character would decode to a
    // replacement character, which the server would then sanitize differently.
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return new TextDecoder().decode(bytes.subarray(0, end));
}

export function sanitizeKey(avatarId) {
    const base = String(avatarId ?? '').replace(/\.[^.]*$/, '');
    // Mirror the server's sanitize-filename. Being stricter than the server only
    // invents a collision that will not happen, which costs one hash suffix. Being
    // looser is unsafe: two distinct avatars then fold into a single folder on disk,
    // our collision guard never fires, and deleting one persona's assets destroys
    // the other's. So every rule the server applies has to appear here too.
    const cleaned = base
        .replace(/[/\\?%*:|"<>]/g, '')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
        // Windows drops trailing dots and spaces, and so does the server. Leading
        // whitespace is kept by the server, so we keep it as well.
        .replace(/[. ]+$/, '');
    return truncateBytes(PREFIX + (cleaned || 'unnamed'), MAX_KEY_BYTES);
}

function shortHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36).slice(0, 6);
}

export function resolveFolderKey(root, avatarId) {
    const persona = root?.personas?.[avatarId];
    if (persona?.assetFolderKey) return persona.assetFolderKey;

    const base = sanitizeKey(avatarId);
    const taken = new Set();
    for (const [id, p] of Object.entries(root?.personas ?? {})) {
        if (id !== avatarId && p.assetFolderKey) taken.add(p.assetFolderKey);
    }
    // Two different avatars can sanitize to the same string. Sharing a folder would
    // mix their assets and make deleting one wipe the other.
    return taken.has(base) ? `${base}-${shortHash(avatarId)}` : base;
}

export function claimFolderKey(root, avatarId, saveFn) {
    // Writing the key down is what makes the guard work for everybody else:
    // resolveFolderKey can only avoid a folder it can see is taken. The key is
    // stored once and never recomputed, so this is the only place that assigns
    // it, and it always persists what it assigned.
    const persona = root?.personas?.[avatarId];
    if (!persona) throw new Error(`claimFolderKey needs an existing persona entry for ${avatarId}`);
    if (persona.assetFolderKey) return persona.assetFolderKey;
    const key = resolveFolderKey(root, avatarId);
    persona.assetFolderKey = key;
    if (typeof saveFn === 'function') saveFn();
    return key;
}

export function parseTag(raw) {
    const value = String(raw ?? '').trim();
    if (!value) return null;
    const parts = value.split('/');
    if (parts.length > 2) return null;
    const filename = parts[parts.length - 1];
    const folderKey = parts.length === 2 ? parts[0] : null;
    if (!filename || filename === '.' || filename === '..') return null;
    if (folderKey !== null && (!folderKey || folderKey === '.' || folderKey === '..')) return null;
    return { folderKey, filename };
}

export function labelOf(filename) {
    return String(filename ?? '').replace(/\.[^.]*$/, '');
}

export function assetLookup(folders, folderKey, filename) {
    // Decides what a folder qualified tag can do right now, given what we have
    // listed so far. Kept pure so the rendering path stays testable.
    const listing = folders?.get(folderKey);
    if (listing instanceof Map) return { path: listing.get(labelOf(filename)) ?? null, fetch: false };
    // A key we have never seen is worth exactly one listing request. A key that is
    // present without a listing is either in flight or already known to have failed,
    // and refetching it on every render sweep would hammer the server.
    return { path: null, fetch: !(folders?.has(folderKey) ?? false) };
}

function formHeaders(ctx) {
    // FormData must set its own Content-Type so the multipart boundary is included.
    const headers = { ...ctx.getRequestHeaders() };
    delete headers['Content-Type'];
    delete headers['content-type'];
    return headers;
}

export async function listAssets(ctx, folderKey) {
    const res = await fetch(`/api/sprites/get?name=${encodeURIComponent(folderKey)}`, {
        headers: ctx.getRequestHeaders(),
    });
    if (!res.ok) throw new Error(`sprites/get ${res.status}`);
    const data = await res.json();
    // Use the path the server hands back. Rebuilding URLs ourselves would drift from
    // the server's own sanitisation for names with spaces or hangul.
    return Array.isArray(data) ? data.filter(a => a && a.path) : [];
}

/* The device reported 5.png 올리기 실패: sprites/upload 500 on 0.6.1.

   A 500 is the server reaching the handler and throwing inside it, so the
   endpoint and the folder are not the question; the shape of what it was handed
   is. The one part of that shape nobody has measured is the FIELD NAME the file
   arrives under: sprites/get was measured answering 200 in 진단 1회차, but no
   upload has ever been watched.

   So the field name is not guessed at, it is tried. Each attempt is judged by
   the status the server answers with, a rejected attempt writes nothing, and the
   name that works is remembered for the rest of the session, so the cost is one
   round of probing rather than one per file. When none of them work the LAST
   status is what the user is told, because that is the fact the next diagnostic
   needs. The first entry is what this extension has always sent. */
const SPRITE_FILE_FIELDS = Object.freeze(['file', 'avatar', 'spriteFile', 'image']);
let spriteFileField = null;

function spriteBody(field, folderKey, file) {
    const body = new FormData();
    body.append('name', folderKey);
    body.append('label', file.name.replace(/\.[^.]*$/, ''));
    body.append(field, file);
    return body;
}

export async function uploadAsset(ctx, folderKey, file) {
    const fields = spriteFileField ? [spriteFileField] : SPRITE_FILE_FIELDS;
    let lastStatus = 0;
    for (const field of fields) {
        const res = await fetch('/api/sprites/upload', {
            method: 'POST',
            headers: formHeaders(ctx),
            body: spriteBody(field, folderKey, file),
        });
        if (res.ok) {
            // Remembered only on a real success, so a build that answers 200 to
            // the first field never pays for the rest of the list again.
            spriteFileField = field;
            return field;
        }
        lastStatus = res.status;
        // A 400 or a 422 says the request was wrong, and a 500 is what the device
        // actually saw; both are worth another field name. Anything else (a 401,
        // a server that is not there) is not about the field, so the loop stops
        // rather than throwing three more uploads at it.
        if (res.status !== 400 && res.status !== 422 && res.status < 500) break;
    }
    // If a remembered field stopped working, forget it, so the next call starts
    // the list again instead of repeating one that has begun to fail.
    spriteFileField = null;
    // The folder goes in the message. Every field name failing means the problem
    // is not the field, and the next thing anybody would ask is what folder the
    // server was asked to write into. A failure the user can screenshot is worth
    // more than one that only says a number.
    throw new Error(`sprites/upload ${lastStatus} [fields=${fields.length}, folder=${folderKey}]`);
}

// Teardown leaves nothing behind, including what was learned about the server.
export function resetAssetProbes() {
    spriteFileField = null;
}

export async function deleteAsset(ctx, folderKey, label) {
    const res = await fetch('/api/sprites/delete', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ name: folderKey, spriteName: label }),
    });
    if (!res.ok) throw new Error(`sprites/delete ${res.status}`);
}

const TAG_RE = /\{\{pimg::(.*?)\}\}/gi;

export function findTags(text) {
    const hits = [];
    TAG_RE.lastIndex = 0;
    let m;
    while ((m = TAG_RE.exec(String(text ?? ''))) !== null) {
        const parsed = parseTag(m[1]);
        if (parsed) hits.push({ raw: m[0], start: m.index, end: m.index + m[0].length, parsed });
    }
    return hits;
}

export function buildImgHtml(path, style) {
    const safe = String(path).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cls = `pm-asset pm-asset-${String(style || 'plain').replace(/[^a-z]/gi, '')}`;
    return `<img class="${cls}" src="${safe}" loading="lazy" alt="" />`;
}

// What one text node should become, decided without touching the DOM so a node test
// can check it. parts alternate literal text and resolved image paths in source
// order, and resolved counts the tags that actually produced a path. A caller that
// gets resolved 0 must leave the node alone: rewriting it would be a mutation that
// changes nothing, which the #chat observer cannot tell apart from a real edit.
export function planRender(text, resolvePath) {
    const source = String(text ?? '');
    const parts = [];
    let cursor = 0;
    let resolved = 0;
    for (const hit of findTags(source)) {
        const path = typeof resolvePath === 'function' ? resolvePath(hit.parsed) : null;
        // An unresolved tag stays inside the literal text, because cursor does not
        // move past it. The user then sees the tag they wrote and can fix the name.
        if (!path) continue;
        parts.push({ type: 'text', text: source.slice(cursor, hit.start) });
        parts.push({ type: 'image', path });
        cursor = hit.end;
        resolved++;
    }
    parts.push({ type: 'text', text: source.slice(cursor) });
    return { parts, resolved };
}

export function renderInElement(el, resolvePath, style) {
    if (!el) return 0;
    const DOMPurify = globalThis.SillyTavern?.libs?.DOMPurify;
    // Without a sanitiser we inject nothing and leave every tag as text. Consuming
    // the tag and rendering an empty span instead would delete the image and the
    // source text together, leaving the user with no way to see what was lost.
    if (!DOMPurify) return 0;

    // No "already processed" flag. SillyTavern replaces .mes_text innerHTML when a
    // message is edited, which brings the raw tags back on the same element, so a
    // sticky flag would permanently skip it. Idempotence comes from the work itself:
    // once a tag becomes an <img>, findTags has nothing left to match.
    let replaced = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) if (findTags(walker.currentNode.nodeValue).length) targets.push(walker.currentNode);

    for (const node of targets) {
        const plan = planRender(node.nodeValue, resolvePath);
        // Nothing resolved, so the fragment would be a byte identical copy of this
        // node. Replacing it anyway is still a childList mutation, the #chat observer
        // in index.js maps that mutation back to this .mes_text and renders again,
        // and the next pass resolves nothing again. Measured in Chromium: one tag
        // naming an asset that does not exist kept that cycle running at frame rate
        // for as long as it was watched. Skipping the write is what ends it.
        if (!plan.resolved) continue;
        const frag = document.createDocumentFragment();
        for (const part of plan.parts) {
            if (part.type === 'text') {
                if (part.text) frag.append(part.text);
                continue;
            }
            const holder = document.createElement('span');
            holder.innerHTML = DOMPurify.sanitize(buildImgHtml(part.path, style));
            frag.append(holder);
        }
        node.replaceWith(frag);
        replaced += plan.resolved;
    }
    return replaced;
}

const MACROS = ['persona_assets', 'persona_asset_prompt'];

// A version may carry an assetSelection naming the files it uses,
// with null meaning all of them. Both macros have to go through this, or the whole
// producing half (the checkbox per file, the 에셋: N개 선택 row, the asset-select log
// kind) writes a setting the prompt never honours: the user unticks files, the row
// agrees, and every file in the folder still reaches the model. Kept here rather
// than imported from manager-pure so the macro path does not depend on the UI layer.
function activeAssetNames(s) {
    const selection = (s.persona?.versions ?? [])
        .find(v => v.id === s.persona?.activeVersionId)?.assetSelection;
    if (!Array.isArray(selection)) return s.assetNames;
    return s.assetNames.filter(name => selection.includes(name));
}

export function registerAssetMacros(ctx, getState) {
    if (typeof ctx.registerMacro !== 'function') return;
    // Always register, even when injection is off, so the raw macro text never
    // leaks into a prompt.
    ctx.registerMacro('persona_assets', () => {
        const s = getState();
        if (!s || !s.settings.injectAssetMacros) return '';
        return activeAssetNames(s).join(', ');
    });
    ctx.registerMacro('persona_asset_prompt', () => {
        const s = getState();
        if (!s || !s.settings.injectAssetMacros || !s.assetNames.length) return '';
        const active = activeAssetNames(s);
        // A version that excludes every file wants no asset block at all, not the
        // template with an empty list where the filenames should be.
        if (!active.length) return '';
        const names = active.join(', ');
        // A string pattern replaces the first occurrence only, and a filename holding
        // $& or a dollar sequence would be read as a replacement directive. A function
        // replacement is taken literally.
        return s.settings.assetPromptTemplate.replace(/\{\{persona_assets\}\}/g, () => names);
    });
}

export function unregisterAssetMacros(ctx) {
    if (typeof ctx.unregisterMacro !== 'function') return;
    for (const name of MACROS) ctx.unregisterMacro(name);
}

/* ── Persona avatars (user request: 페르소나 이미지 교체) ────────────────────
   SillyTavern's own persona picture, which is a different namespace from the
   sprites above: sprites are this extension's per-persona image library, the
   avatar is the file SillyTavern draws for the persona everywhere.

   The first version of this posted to /api/avatars/get and /api/avatars/upload.
   Those were GUESSES. 접점 진단 5 came back and neither appears anywhere in it;
   what it DID measure is SillyTavern's own pair of controls, #avatar_upload_file
   (input, type=file, accept=image/\*) and #avatar_upload_overwrite (input,
   type=hidden), sitting next to each other. So the file goes through SillyTavern's
   own uploader rather than through an endpoint nobody has ever seen answer.

   Verification is a measured URL: /thumbnail?type=persona&file=<avatar>, which
   the diagnostic read off the persona list's own img. The bytes before and after
   are compared, so the answer is what the server now serves rather than what we
   hoped the upload did. */
export async function personaThumbBytes(ctx, avatarId) {
    if (typeof ctx?.getThumbnailUrl !== 'function') return null;
    let url;
    try { url = ctx.getThumbnailUrl('persona', avatarId); } catch { return null; }
    if (!url) return null;
    // A cache buster of our own: the browser has this picture already, and the
    // whole point of the second read is to see whether the server changed it.
    const bust = url.includes('?') ? '&' : '?';
    try {
        const res = await fetch(`${url}${bust}pmcheck=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.arrayBuffer()).byteLength;
    } catch { return null; }
}

// Hands the file to SillyTavern's own uploader, with the avatar to overwrite in
// the hidden field beside it. Returns what it could not find, so the caller can
// say which half of the pair a build is missing instead of reporting a generic
// failure.
export function feedPersonaImage(doc, avatarId, file) {
    const overwrite = doc?.getElementById?.('avatar_upload_overwrite');
    const input = doc?.getElementById?.('avatar_upload_file');
    if (!overwrite) return 'avatar_upload_overwrite';
    if (!input) return 'avatar_upload_file';
    if (typeof DataTransfer !== 'function') return 'DataTransfer';
    overwrite.value = avatarId;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return null;
}
