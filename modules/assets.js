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

/* What a {{pimg::}} tag names, looked up in a listing keyed by the server's own
   labels.

   The tag was resolved through labelOf alone, which strips everything after the
   last dot, and a sprite label is free to contain one: an asset the server calls
   "포즈 1.5" was looked up as "포즈 1", found nothing, and the tag stayed as raw
   text forever with no way for the user to work out why. The name as written is
   what the user typed and what the picker showed them, so it is tried first;
   stripping is the fallback that lets somebody write the file name with its
   extension and still be understood. */
export function lookupLabel(map, filename) {
    if (!map || typeof map.get !== 'function') return null;
    const raw = String(filename ?? '');
    return map.get(raw) ?? map.get(labelOf(raw)) ?? null;
}

/* The avatar backups this extension writes live in the same sprite folder as
   the user's own pictures, because that is the only folder we own. They are
   bookkeeping, not content, so everything that shows or SENDS the folder has to
   be able to tell them apart: unfiltered, a backup reached the prompt through
   {{persona_assets}} and the model could draw the user's old avatar into the
   chat with {{pimg::}}. One prefix, one predicate, checked everywhere the list
   is read for the user or for the model. */
/* ASCII, deliberately.

   The sprites server runs every label through its own sanitize-filename, which
   is why sanitizeKey exists a few lines up. A Hangul prefix would mean the
   label we read back might not start with the prefix we test for, and a backup
   the filter stops recognising goes straight back into the prompt and the
   picker. The user never types this name, so there is nothing to gain by
   making it Korean and a leak to lose. */
export const BACKUP_PREFIX = 'pm-backup-';
// What 0.1.12 through 0.1.14 wrote. Still recognised, so a folder made by those
// builds keeps its backup hidden and restorable instead of surfacing as an
// ordinary picture.
const LEGACY_BACKUP_PREFIX = 'pm-원본-';

function isBackupLabel(label) {
    const name = String(label ?? '');
    return name.startsWith(BACKUP_PREFIX) || name.startsWith(LEGACY_BACKUP_PREFIX);
}

// The folder as the user and the model should see it.
export function withoutBackups(list) {
    return (list ?? []).filter(item => !isBackupLabel(typeof item === 'string' ? item : item?.label));
}

export function assetLookup(folders, folderKey, filename) {
    // Decides what a folder qualified tag can do right now, given what we have
    // listed so far. Kept pure so the rendering path stays testable.
    const listing = folders?.get(folderKey);
    if (listing instanceof Map) return { path: lookupLabel(listing, filename), fetch: false };
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
    // Same reason as the probes below: a mark left behind would tell the next
    // load that a picture was kept when nothing was written down.
    backedUpThisSession.clear();
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

/* ── 버전별 페르소나 이미지 (user request) ───────────────────────────────────

   Everything below moves bytes between two places that already exist: the
   sprite folder this extension owns, and the avatar file SillyTavern owns.
   Nothing here talks to the user; the callers decide what to say, because the
   quick panel and the manager say it differently. */

// A sprite the server is already serving, turned back into a File so it can be
// posted as an avatar. The path is the server's own, used verbatim.
export async function fetchAssetFile(path, label) {
    if (!path) return null;
    try {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) return null;
        const blob = await res.blob();
        const name = /\.[a-z0-9]+$/i.test(label ?? '') ? label : `${label || 'image'}.png`;
        return new File([blob], name, { type: blob.type || 'image/png' });
    } catch { return null; }
}

/* The persona's CURRENT picture, for the one backup taken before the first
   overwrite. The full size original is served from a path this project has
   never measured, so the thumbnail is what gets kept and the caller says so:
   a backup quietly smaller than the thing it replaces would be worse than
   none, because nobody would know to look.

   The name carries a stamp because uploadAsset derives the sprite label from
   it. A fixed name meant every backup landed on the same label, so a second
   backup would replace the first - and the first is the only one holding the
   picture that existed before this extension touched it. */
export async function captureAvatarFile(ctx, avatarId, stamp) {
    if (typeof ctx?.getThumbnailUrl !== 'function') return null;
    let url;
    try { url = ctx.getThumbnailUrl('persona', avatarId); } catch { return null; }
    if (!url) return null;
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        const blob = await res.blob();
        const label = `${BACKUP_PREFIX}${stamp}`;
        return { file: new File([blob], `${label}.png`, { type: blob.type || 'image/png' }), label };
    } catch { return null; }
}

/* One picture write at a time.

   SillyTavern has exactly one avatar upload form in the document and the
   endpoint writes one file per request. Two applies racing each other would
   interleave, and the second answer would describe the first one's upload. The
   chain also means a burst of version taps ends with the last one winning,
   which is what the taps meant. */
/* Avatars whose backup has already been taken in this session.

   persona.avatarBackup is the durable record, but the caller can only write it
   AFTER its await resolves, and the queue starts the next job one microtask
   before that. Two quick version taps therefore both saw an empty record and
   both took a backup, the second one holding the first one's replacement. This
   set closes that window; the stored record still governs across reloads. */
const backedUpThisSession = new Set();

let imageChain = Promise.resolve();
function queueImageWrite(job) {
    const run = imageChain.then(job, job);
    // Never rejects, so one failure cannot poison every later write.
    imageChain = run.then(() => undefined, () => undefined);
    return run;
}

/* Puts a version's bound asset onto the persona's avatar file.

   Answers with a code rather than a sentence, and never throws: the callers are
   a version tap in two different screens, and a version apply must not be
   undone by a picture that failed to move. Codes:
     { skipped: 'none' }      the version binds nothing
     { skipped: 'same' }      we already wrote this label to this avatar
     { error: 'listing' }     the asset folder could not be read
     { error: 'missing' }     the bound label is not in the folder
     { error: 'backup' }      the first overwrite was refused: nothing was saved
     { error: 'fetch' }       the asset itself could not be downloaded
     { error: 'upload' }      the avatar endpoint refused
     { ok: true, backedUp }   written; backedUp says a backup was made just now
*/
/* Puts a kept picture back onto the avatar.

   The other half of taking a backup. Without it the extension copies a picture
   out of the way, says so, and offers no way to ever get it back, which is a
   promise it does not keep. Shares the write queue with applyBoundImage so a
   restore cannot interleave with a version apply. */
export async function restoreAvatarBackup({ ctx, root, avatarId, label }) {
    if (!label) return { error: 'missing', detail: '' };
    return queueImageWrite(async () => {
        try {
            const key = resolveFolderKey(root, avatarId);
            let list;
            try { list = await listAssets(ctx, key); } catch (e) {
                return { error: 'listing', detail: String(e?.message ?? e) };
            }
            const hit = list.find(asset => asset?.label === label);
            if (!hit) return { error: 'missing', detail: label };
            const file = await fetchAssetFile(hit.path, label);
            if (!file) return { error: 'fetch', detail: label };
            const wrote = await uploadPersonaAvatar(ctx, avatarId, file);
            if (!wrote.ok) return { error: 'upload', detail: wrote.detail ?? wrote.reason };
            return { ok: true };
        } catch (e) {
            return { error: 'upload', detail: String(e?.message ?? e) };
        }
    });
}

export async function applyBoundImage({ ctx, root, persona, avatarId, label, force, known, now }) {
    if (!label) return { skipped: 'none' };
    if (!force && persona?.avatarWritten === label) return { skipped: 'same' };
    return queueImageWrite(async () => {
        try {
            const key = resolveFolderKey(root, avatarId);
            /* The manager already holds a listing for the persona it is showing,
               and re-fetching it per version tap was one of three round trips on
               a phone. Passed in when it is known to be current; fetched when it
               is not, which is every call from the quick panel. */
            let list = Array.isArray(known) ? known : null;
            if (!list) {
                try { list = await listAssets(ctx, key); } catch (e) {
                    return { error: 'listing', detail: String(e?.message ?? e) };
                }
            }
            // listAssets hands back the server's own entries, and .label is the name
            // every other screen here shows, so a binding stored from one of those
            // screens matches on the same field it was taken from.
            const hit = list.find(asset => asset?.label === label);
            if (!hit) return { error: 'missing', detail: label };

            /* The avatar file is overwritten, so the picture that is there now is
               about to stop existing. Kept once, before the FIRST write, and the
               write is refused outright when keeping it fails.

               The record of that backup is returned rather than written here: the
               caller owns the root, and it is the caller that re-reads the persona
               after this await. Without the record the guard below never closes,
               every apply would take another backup, and the second one would hold
               the first one's replacement instead of the original. */
            let backup = null;
            if (!persona?.avatarBackup && !backedUpThisSession.has(avatarId)) {
                backedUpThisSession.add(avatarId);
                const captured = await captureAvatarFile(ctx, avatarId, now);
                if (!captured) { backedUpThisSession.delete(avatarId); return { error: 'backup', detail: 'capture' }; }
                try {
                    // saveSettingsDebounced is handed over so a key claimed here
                    // survives a later failure on this same path.
                    const folder = claimFolderKey(root, avatarId, ctx?.saveSettingsDebounced);
                    await uploadAsset(ctx, folder ?? key, captured.file);
                } catch (e) {
                    // Not backed up after all, so the next attempt must try again.
                    backedUpThisSession.delete(avatarId);
                    return { error: 'backup', detail: String(e?.message ?? e) };
                }
                backup = { label: captured.label, at: now, source: 'thumbnail' };
            }

            /* Every exit from here on carries the backup, because by here the file
               is ON THE SERVER whatever happens next. The two failures below used
               to return without it, the caller only records what it is handed, and
               the record is what makes the guard above skip the next backup: so a
               fetch or an upload that failed left a file in the folder that nothing
               could name, and the next attempt made another one. They are hidden
               from every screen by the backup prefix, so they were unreachable as
               well as invisible. */
            const file = await fetchAssetFile(hit.path, label);
            if (!file) return { error: 'fetch', detail: label, backup };
            const wrote = await uploadPersonaAvatar(ctx, avatarId, file);
            if (!wrote.ok) return { error: 'upload', detail: wrote.detail ?? wrote.reason, backup };
            return { ok: true, backup };
        } catch (e) {
            // The contract above says this never throws, and the callers run it
            // with void: a rejection here would surface as an unhandled one with
            // nothing on screen, which is the failure mode this project forbids.
            return { error: 'upload', detail: String(e?.message ?? e) };
        }
    });
}

const MACROS = ['persona_assets', 'persona_asset_prompt'];

// A version may carry an assetSelection naming the files it uses,
// with null meaning all of them. Both macros have to go through this, or the whole
// producing half (the checkbox per file, the 에셋: N개 선택 row, the asset-select log
// kind) writes a setting the prompt never honours: the user unticks files, the row
// agrees, and every file in the folder still reaches the model. Kept here rather
// than imported from manager-pure so the macro path does not depend on the UI layer.
function activeAssetNames(s) {
    // Backups never reach the model. They are this extension's own copies of a
    // picture the user replaced, and naming one in the prompt invites the model
    // to draw it back into the chat.
    const names = withoutBackups(s.assetNames);
    const selection = (s.persona?.versions ?? [])
        .find(v => v.id === s.persona?.activeVersionId)?.assetSelection;
    if (!Array.isArray(selection)) return names;
    return names.filter(name => selection.includes(name));
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
/* Drops the browser's copy of a persona picture, the way SillyTavern does after
   its own upload. This is for SillyTavern's screens, not ours: every picture
   this extension draws goes through thumbnailUrl, which appends its own pmv
   token, so our images are already refreshed by that bump and never read the
   bare address reloaded here. Fired without being awaited for the same reason -
   nothing downstream depends on it. */
function bustPersonaImage(ctx, avatarId) {
    if (typeof ctx?.getThumbnailUrl !== 'function') return;
    let url;
    try { url = ctx.getThumbnailUrl('persona', avatarId); } catch { return; }
    if (!url) return;
    try { void fetch(url, { cache: 'reload' }).catch(() => undefined); } catch { /* the token still covers us */ }
}

/* Replaces a persona's picture through the endpoint SillyTavern's own persona
   screen posts to.

   This used to be done by putting the file into SillyTavern's hidden file input
   and firing a change event, then watching the thumbnail's byte length to find
   out whether anything happened. Both halves were wrong. The change handler
   (changeUserAvatar in personas.js) opens a CROP dialog unless the user has
   turned resizing off, so the upload does not even begin until the user answers
   it - long after any watch window closes. And the watch could not tell "no
   measurement" from "no change": on a retry the byte length it compared against
   was already the new picture's, so uploading the same file twice reported
   failure every time. That is the popup that would not stop.

   The endpoint answers the question directly instead. A 200 means the file is
   written; anything else carries a status worth putting on screen. */
export async function uploadPersonaAvatar(ctx, avatarId, file) {
    const body = new FormData();
    // The field names are SillyTavern's own form: avatar for the file, and
    // overwrite_name for the avatar being replaced. An empty overwrite_name
    // would CREATE a persona rather than replace one, so it is never omitted.
    body.append('avatar', file);
    body.append('overwrite_name', avatarId);
    let res;
    try {
        res = await fetch('/api/avatars/upload', {
            method: 'POST',
            headers: formHeaders(ctx),
            cache: 'no-cache',
            body,
        });
    } catch (e) {
        return { ok: false, reason: 'network', detail: String(e?.message ?? e) };
    }
    if (!res.ok) return { ok: false, reason: 'http', status: res.status, detail: `HTTP ${res.status}` };
    bustPersonaImage(ctx, avatarId);
    return { ok: true };
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
