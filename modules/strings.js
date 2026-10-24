// Every sentence, label and title the user can read, in one place.
//
// The four renames the user chose (2026-08-27) live here and nowhere else:
// 구획 -> 항목, 변형 -> 선택지, 라벨 -> 그룹, and the 구성 tab is now 편집.
// Only the WORDS changed. Data keys (sections, variants, versions, labels), log
// kind values, CSS class names, element ids and function names are untouched on
// purpose: renaming any of those would rewrite a user's settings.json for a
// vocabulary change, and a vocabulary change is not worth a migration.
//
// WRITING RULE (2026-08-26, from the user, and it applies to every string below).
// Three passes got this wrong before it landed, so the rule is written out in full:
//
// 1. Do not end on a conjugated verb or adjective. 읽지 못했다, 버전이 없다, 사라졌다.
// 2. Do not fix that by bending the verb into a noun shape either. 읽지 못함, 사라짐,
//    내려받음, and worst of all 엶 are 명사형, not 명사, and the user rejected them
//    by name: "엶 말고 명사로 끝내라고 명사형 말고".
// 3. End on a real noun, in the register a Korean software manual uses: 실패, 완료,
//    불가, 취소, 없음, 오류, 잠금, 미확인, 삭제, 병합, 유지. 목록 불러오기 실패, not
//    목록을 읽지 못함. 삭제 불가, not 지울 수 없음. 없음 and 있음 are the exception
//    that stays, because Korean UI lexicalised them into nouns long ago.
//
// Demonstratives follow the same register: 이 브라우저 / 이 항목 reads light and
// spoken, so a manual writes 현재 브라우저 and 해당 항목, and names the extension
// (APP_NAME) instead of saying 이 확장.
//
// Empty states are a bare negation, and a gesture may use an arrow (드래그 → [수정])
// instead of a sentence.
//
// CONFIRM DIALOGS name the act and stop (2026-08-27, from the user, with their own
// example): 변경 기록 13줄 삭제, not 변경 기록 13줄을 전부 지울까? 선택지 본문과
// 이력은 그대로 유지. 지웠다는 줄 하나만 기록. The two buttons already ask; what
// cannot be undone goes in brackets and nothing else goes in at all. 검사/wording
// holds both halves: no 까? anywhere, and nothing in the confirm family past 60
// characters.
//
// Pure data plus a few formatters. Nothing here reads the DOM, a context or the
// state, so importing it from every screen keeps no reference alive past its
// moment, and 검사 can read it in plain Node.

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const inner of Object.values(value)) deepFreeze(inner);
    }
    return value;
}

// The one place the extension's own name is written. Three screens carry it and
// a fourth copy in the map would be a fourth chance for them to disagree.
const APP_NAME = '페르소나 관리자';

/* Particle selection. A Korean particle changes with the last
   syllable of the word it attaches to, and several sentences here attach one to
   a name the user typed, where a fixed particle reads wrong half the time
   ("메모"을). jong answers the final consonant index of that syllable, 0 for
   none, or null when the word does not end in hangul, in which case the
   sentence carries both forms the way printed forms do.

   The 을/를 and 과/와 helpers went with the confirm rewrite of 2026-08-27: those
   dialogs name an act now (선택지 "기본" 삭제) and a noun phrase takes no object
   particle. What is left is used by the sentences that report a result. */
function jong(word) {
    const last = String(word ?? '').slice(-1);
    if (last < '가' || last > '힣') return null;
    return (last.charCodeAt(0) - 0xAC00) % 28;
}

function iRaneun(word) {
    const j = jong(word);
    return j === null ? '(이)라는' : (j ? '이라는' : '라는');
}

// Counts the user reads. A four digit character count is the normal size of one
// of these descriptions, and 4021 next to 2679 is harder to compare at a glance
// than 4,021 next to 2,679. The locale is named rather than left to the host:
// this screen is Korean, and node and the browser disagree about the default.
function num(value) {
    return (typeof value === 'number' && Number.isFinite(value))
        ? value.toLocaleString('ko-KR')
        : String(value);
}

// 으로 keeps its 으 after a consonant EXCEPT ㄹ (하늘로, not 하늘으로), which is
// why this cannot share eulReul's two way split. ㄹ is jong index 8.
function euRo(word) {
    const j = jong(word);
    return j === null ? '(으)로' : (j === 0 || j === 8 ? '로' : '으로');
}

export const STRINGS = deepFreeze({
    /* Shared by more than one screen. A second copy of a sentence is a second
       chance for the two screens to say different things about the same rule. */
    common: {
        add: '추가',
        apply: '적용',
        cancel: '취소',
        close: '닫기',
        duplicate: '복제',
        rename: '이름 변경',
        remove: '삭제',
        save: '저장',
        create: '만들기',
        more: '더 보기',
        // The count is what the user acts on, so it leads.
        emptyItems: n => `빈 항목 ${n}개`,
        cannotSaveNow: '현재 저장 불가',
        personaChanged: '페르소나 변경으로 패널 새로고침',
        personaChangedNotSaved: '페르소나 변경으로 저장 취소',
        readOnly: '더 새로운 판이 만든 데이터라 읽기 전용',
        versionNotApplicable: '해당 버전은 현재 페르소나에 적용 불가',
        // After 관리 시작 split the description by its titles.
        adoptSplit: n => `기존 설명문을 항목 ${n}개로 나눠 가져오기 완료`,
        confirmVersionOverOutsideEdit: '버전 변경 (외부 수정분 소실)',
        newVersionName: '새 버전 이름',
        // A pick left naming a choice that was deleted. Never snapped to the first
        // option: that would draw a combination the prompt does not contain.
        deletedChoiceOption: '(삭제된 선택지)',
        popupBlocked: '현재 브라우저에서 확인 창 차단 또는 취소. 변경 사항 없음',
        // Boot time warning from index.js, the one screenless place that talks.
        noRegisterMacro: '현재 빌드에 매크로 등록 기능이 없어 에셋 매크로 사용 불가. 나머지 기능은 정상 동작',
        copySuffix: name => `${name} 복사본`,
        // One separator for every list this extension prints on a single line, so
        // the version names in the persona list and a version's combination in the
        // manager read the same way.
        dotSeparator: ' · ',
        /* Search and paging, shared by every list. */
        search: '검색',
        searchClose: '검색 닫기',
        searchNoHits: '검색 결과 없음',
        pagePrev: '이전',
        pageNext: '다음',
        pageOf: (page, pages) => `${page}/${pages}`,
        // The detected languages, keyed by detectLanguage's answers.
        languageNames: {
            ko: '한국어',
            ja: '일본어',
            zh: '중국어',
            en: '영어',
        },
    },

    /* The quick switch panel. */
    quick: {
        iconAria: title => `${APP_NAME}: ${title}`,
        // What the icon label reads when no version is selected, and what is
        // appended when the live combination has moved off the selected one.
        // The changed state must be visible.
        iconNoVersion: '버전 없음',
        iconModifiedSuffix: ' (수정 있음)',
        // The diverged banner's three controls.
        divergeRevert: '되돌리기',
        divergeAbsorb: '가져오기',
        divergeLater: '나중에',
        // The four sort keys, indexed by the stored sortBy value.
        sortNames: {
            name: '이름순',
            nameDesc: '이름 역순',
            recent: '최근 사용순',
            recentOld: '오래된 사용순',
            modified: '최근 수정순',
            modifiedOld: '오래된 수정순',
            created: '최근 만든 순',
            createdOld: '오래전 만든 순',
        },
        // The two view modes, indexed by the stored rosterViewMode.
        viewCaption: '보기:',
        viewNames: {
            list: '목록',
            tiles: '타일',
            tilesNamed: '타일+이름',
        },
        autoNameApplied: name => `채팅 언어에 맞춰 이름 변경: ${name}`,
        headCurrent: '현재',
        headVersion: '버전',
        headPersona: '페르소나',
        unknownName: '(미확인)',
        adoptRow: '현재 페르소나 관리 시작',
        noVersions: '저장된 버전 없음',
        // 언어별 이름, in the quick panel (user request). Simpler than the manager's:
        // this panel is always looking at the persona being PLAYED, and for that
        // one the list-only scope is not a legal choice at all, so
        // there is nothing to choose between. A language, a name, one tap.
        headNames: '언어별 이름',
        noLocalNames: '등록된 이름 없음',
        localNamesElsewhere: '편집 탭에서 이름 등록',
        autoNameRow: '채팅 언어에 맞춰 자동 적용',
        confirmNameClash: (name, who) => `이름 "${name}" 적용 (대화 속 "${who}"와 동명)`,
        namesNeedWritable: '현재 상태에서 이름 변경 불가',
        saveCurrentAsVersion: '+ 현재 구성을 버전으로 저장',
        // [⋯] beside a version row: the screen reader hears which version's tools.
        versionToolsAria: name => `버전 "${name}" 관리`,
        chipAll: '전체',
        // Named for what it opens: the checkboxes that put this persona in groups.
        // Plain 편집 would now read as the manager's 편집 tab.
        groupEditToggle: on => (on ? '완료' : '그룹'),
        // Multi select (user request). A dedicated button turns it on, the same
        // way 그룹 편집 does, rather than a long press: a long press on a list of
        // portraits is also how a phone starts a text selection or an image save.
        selectToggle: on => (on ? '선택 완료' : '선택'),
        selectedCount: n => `${n}개 선택`,
        selectNone: '선택 해제',
        selectAll: '전체 선택',
        bulkDelete: '관리 데이터 삭제',
        bulkGroup: '그룹에 넣기',
        bulkTagAdd: '태그 추가',
        bulkTagRemove: '태그 삭제',
        bulkNothing: '선택한 페르소나 없음',
        bulkTagPrompt: '추가할 태그',
        bulkTagRemovePrompt: '삭제할 태그',
        bulkTagAdded: n => `페르소나 ${n}개에 태그 추가`,
        bulkTagRemoved: n => `페르소나 ${n}개에서 태그 삭제`,
        bulkNoManaged: n => `선택한 ${n}개 모두 관리 데이터 없음`,
        bulkGrouped: (name, n) => `${name}에 페르소나 ${n}개 추가`,
        bulkTagNoChange: '바뀐 페르소나 없음',
        confirmBulkDelete: n => `페르소나 ${n}개의 관리 데이터 삭제 (복구 불가, SillyTavern 페르소나는 유지)`,
        bulkDeleted: n => `페르소나 ${n}개 관리 데이터 삭제 완료`,
        bulkGroupPrompt: '넣을 그룹 고르기',
        choiceNoMatch: '목록에 없는 값',
        newGroupPlaceholder: '새 그룹',
        sortCaption: '정렬:',
        rosterUnavailable: '페르소나 목록 불러오기 실패',
        footerAssets: '에셋',
        // User request: the panel's foot reaches every manager
        // tab directly, not only the tab the manager happens to open on.
        footerCompose: '편집',
        footerVersions: '버전',
        footerHistory: '이력',
        footerGroups: '그룹',
        footerSearch: '검색',
        managerMissing: '관리자 화면 미구현',
        stateUnread: '상태 미확인',
        ambiguous: '이름이 같은 페르소나가 여럿이라 대상 판별 불가. 편집 잠금',
        divergedBanner: '외부에서 설명문 직접 수정. 관리자 내용과 불일치',
        absorbNoItem: '가져올 항목 없음',
        absorbNotOnly: '다른 항목에 본문이 있어 가져오기 불가. 되돌리기 또는 직접 편집',
        switchAmbiguous: name => `${name}${iRaneun(name)} 이름이 여럿이라 전환 대상 확정 불가`,
        noSwitchCommand: '현재 빌드에 페르소나 전환 슬래시 커맨드 없음',
        switchFailed: name => `${name}${euRo(name)} 페르소나 전환 실패`,
        // Two independent toggles, so the badge and the name line
        // are two separate sentences and neither implies the other.
        versionBadge: n => `버전 ${n}`,
    },

    /* The manager screen. */
    manager: {
        screenAria: APP_NAME,
        // The tab name says what the tab is, the line under it
        // says what the user does there, and it is always drawn. A title attribute
        // needs a hover, and a phone has none.
        tabs: {
            compose: '편집',
            versions: '버전',
            history: '이력',
            assets: '에셋',
            labels: '그룹',
        },
        tabDescriptions: {
            compose: '항목을 나누고 각 항목의 선택지 관리',
            versions: '현재 구성을 버전으로 저장 및 선택 적용',
            history: '선택지 본문의 지난 저장본 비교 및 복구',
            assets: '현재 페르소나의 이미지 보관과 채팅 삽입',
            labels: '그룹으로 페르소나 분류',
        },
        // The structure log stores a machine kind, and these are only how it reads.
        // The keys are the stored values and never change.
        logKinds: {
            import: '가져오기',
            'persona-create': '페르소나 생성',
            'image-bind': '이미지 바인딩',
            'image-apply': '이미지 교체',
            'image-restore': '원본 되돌리기',
            'section-add': '항목 추가',
            'section-rename': '항목 이름 변경',
            'section-move': '항목 이동',
            'section-delete': '항목 삭제',
            'variant-add': '선택지 추가',
            'variant-rename': '선택지 이름 변경',
            'variant-duplicate': '선택지 복제',
            'variant-delete': '선택지 삭제',
            'variant-edit': '내용 편집',
            pick: '활성 선택지 변경',
            'pick-moved': '활성 선택지 이동',
            'version-create': '버전 생성',
            'version-apply': '버전 적용',
            'version-rename': '버전 이름 변경',
            'version-duplicate': '버전 복제',
            'version-overwrite': '버전 덮어쓰기',
            'version-repick': '버전 구성 수정',
            'version-delete': '버전 삭제',
            'version-move': '버전 순서 변경',
            restore: '되돌리기',
            'history-evicted': '이력 정리',
            'history-expired': '이력 기간 만료',
            'history-clear': '이력 전체 삭제',
            'compose-missing': '빈 항목',
            'diverge-revert': '외부 수정 되돌리기',
            'diverge-absorb': '외부 수정 가져오기',
            'tag-add': '태그 추가',
            'tag-remove': '태그 삭제',
            'heading-format': '제목 형식 변경',
            'asset-upload': '에셋 올리기',
            'asset-delete': '에셋 삭제',
            'asset-select': '버전 에셋 선택',
            'image-crop': '이미지 위치 조절',
            'split-headings': '제목별 분류',
            placement: '프롬프트 배치 변경',
            lorebook: '월드인포 연결',
            'name-local': '언어별 이름 변경',
            'persona-copy': '페르소나 복사',
            'name-apply': '페르소나 이름 변경',
            'name-auto': '언어별 이름 자동 적용',
        },
        // The detail line a log row carries next to its kind, rendered by the 변경
        // 기록 list. These live here and not next to their addLog calls because
        // history.js and state.js are the only two modules that used to hard code a
        // Korean sentence, and being outside this table is exactly how they missed
        // the writing rule three rounds running (이력 …정리됨 / …되돌림 / 가져옴).
        logDetails: {
            evicted: n => `총량 상한으로 이력 ${n}건 정리`,
            // The kind beside it already reads 이력 기간 만료, so the detail says the
            // number and not the cause a second time. It used to borrow the line
            // above, which named the wrong reason.
            expired: n => `${n}건 정리`,
            restored: n => `${n}번째 이력으로 복원`,
            imported: '기존 설명문에서 가져오기',
            importedSplit: n => `기존 설명문에서 가져오기 (항목 ${n}개로 분류)`,
            resplit: n => `본문 ${n}개`,
        },

        /* Shell and guards */
        confirmCloseDirty: '편집 임시 보관 후 닫기',
        targetMovedNotSaved: '대상 페르소나 변경으로 저장 취소',
        noSettings: '설정 불러오기 실패로 관리자에서 저장 불가',
        notAdopted: '아직 관리를 시작하지 않은 페르소나',
        refusalNoRoot: '설정 불러오기 실패로 저장 불가',
        refusalReadOnly: '더 새로운 판이 만든 데이터라 관리자에서 저장 불가',
        refusalAmbiguous: '이름이 같은 페르소나가 여럿이라 활성 대상 판별 불가. 저장 취소',
        refusalUnknownPersona: 'SillyTavern에 존재하지 않는 페르소나',
        stateUnread: '상태 미확인',
        ambiguous: '이름이 같은 페르소나가 여럿이라 활성 대상 판별 불가. 편집 잠금',
        personaGone: 'SillyTavern에 존재하지 않는 페르소나. 위에서 다른 페르소나 고르기',
        divergedBanner: '외부에서 설명문 직접 수정. 관리자 내용과 불일치. 빠른 전환 패널에서 되돌리기나 가져오기 가능',
        missingBanner: (n, names) => `프롬프트에서 빠지는 빈 항목 ${n}개: ${names}`,
        noContext: 'SillyTavern 연결 실패',

        /* 편집 tab */
        // Tags. The chips row sits at the top of the 편집 tab.
        personaTagsHead: '태그',
        tagAdd: '+ 태그',
        tagAddPrompt: '새 태그',
        confirmDropTag: tag => `태그 "${tag}" 떼기`,
        tagDuplicate: '이미 있는 태그',
        tagGone: '이미 삭제된 태그',
        /* 제목 형식. Per persona, because the value lives on the
           persona and every existing one starts at 없음; the settings drawer only
           decides what a NEW persona starts with. The option labels show the
           result rather than naming the format, since "plain" and "markdown" say
           nothing about what lands in the prompt. */
        headingFormatLabel: '항목 제목',
        headingFormatAria: '프롬프트에 넣을 항목 제목 형식',
        headingFormatNames: {
            none: '없음',
            plain: '이름:',
            markdown: '## 이름',
        },
        headingFormatHint: '각 항목 본문 앞에 항목 이름을 넣는 형식. 없음이면 본문만 연결',
        // 기본 항목 채우기.
        fillDefaults: '기본 항목 채우기',
        confirmFillDefaults: n => `기본 항목 ${n}개 추가`,
        fillDefaultsNothing: '추가할 기본 항목 없음',
        fillDefaultsDone: n => `항목 ${n}개 추가 완료`,
        /* 제목별 분류 (user request): a description adopted whole, split by the
           titles written inside it. */
        resplit: '제목별 분류',
        resplitTitle: '본문 속 제목 줄(## 외모, [외모], 외모:)을 기준으로 각 항목에 배치',
        confirmResplit: (targets, created) => (created
            ? `제목 기준 분류: 항목 ${targets}개, 새 항목 ${created}개 (기존 본문 뒤에 추가)`
            : `제목 기준 분류: 항목 ${targets}개 (기존 본문 뒤에 추가)`),
        resplitNothing: '나눌 제목 줄 없음',
        resplitDraft: '저장하지 않은 본문 편집이 있어 분류 불가',
        resplitDone: n => `본문 ${n}개 정리 완료. 이전 내용은 이력 탭에서 복구 가능`,
        newItemName: '새 항목 이름',
        itemName: '항목 이름',
        itemGone: '삭제된 항목',
        lastItemKept: '마지막 항목은 삭제 불가',
        confirmDropItem: name => `항목 "${name}" 삭제 (선택지 전부 포함)`,
        addItem: '+ 항목 추가',
        noItems: '항목 없음',
        dragHandle: '끌어서 순서 변경',
        moveUp: '위로 이동',
        moveDown: '아래로 이동',
        // Seeded into the data when a new item is made. Visible as a choice name.
        defaultChoiceLabel: '기본',
        newChoiceName: '새 선택지 이름',
        choiceName: '선택지 이름',
        choiceGone: '삭제된 선택지',
        choiceUndeletable: '삭제할 수 없는 선택지',
        lastChoiceKept: '항목의 마지막 선택지는 삭제 불가',
        confirmDropChoice: label => `선택지 "${label}" 삭제`,
        addChoice: '+ 선택지 추가',
        activeChoice: '활성 선택지',
        activeChoiceAria: name => `${name} 활성 선택지`,
        pickMovedToFirst: '활성 선택지 삭제로 첫 선택지로 이동',
        choiceCount: n => `선택지 ${n}개`,
        // The editor: its own header, its own footer.
        editorHeading: (itemName, choiceLabel) => `${itemName} · ${choiceLabel}`,
        editorAria: label => `${label} 내용`,
        editorRestored: '임시 보관된 편집 복원. [저장]해야 실제 반영',
        editorDiscard: '임시 편집 버리기',
        editorDiscardTitle: '저장된 내용으로 되돌리기',
        editorCloseTitle: '편집기 닫기 (내용은 임시 보관)',
        // The editor's own footer button. It reads differently from the header's
        // 닫기 on purpose: while the editor is up both are on screen, and two
        // buttons with one word and two meanings ask the user to guess.
        editorBackToList: '목록으로',
        editorOpen: '편집',
        pendingDraft: '임시 편집 있음',
        nothingChanged: '변경 사항 없음',

        /* 크기 (user request). Characters are exact and cost nothing. The token
           number is SillyTavern's own when this build has a counter and is simply
           absent when it does not: a guessed tokenizer would put a confident
           wrong number next to two real ones. */
        sizeLine: (chars, bytes) => `글자 ${num(chars)} · 바이트 ${num(bytes)}`,
        sizeLineTokens: (chars, bytes, tokens) => `글자 ${num(chars)} · 바이트 ${num(bytes)} · 토큰 ${num(tokens)}`,

        /* 설명문 전문 (user request). One screen showing the whole composed
           description in the order the prompt gets it, with every body editable
           in place. The 버전 tab's 새 버전 만들기 covers the other half of the
           same need: that one never touches what exists, so this one carries the
           word 저장 and that one carries 버전. */
        fullTextOpen: '전문',
        fullTextGuide: 'SillyTavern에 들어가는 설명문 전체. 칸 하나가 항목 하나의 활성 선택지 본문',
        fullTextHeadingNote: '항목 이름 줄은 제목 형식 설정에 따라 프롬프트에 함께 전송',
        // Reachable only from a persona with no items at all. A persona that has
        // items but no text in them opens the screen: filling them in is what the
        // screen is for.
        fullTextNoSections: '항목 없음',
        fullTextAria: name => `${name} 본문`,
        fullTextSave: '전체 저장',
        fullTextSaved: n => `항목 ${n}개 저장 완료`,
        fullTextSkipped: names => `편집 중 활성 선택지 변경으로 저장 제외: ${names}`,
        fullTextConfirmLeave: n => `수정 ${n}건 버리고 나가기`,

        /* 프롬프트 배치 (user request). SillyTavern's own descriptor fields, in
           the manager because the description they place is the one composed
           here. The position and role LISTS come from SillyTavern's own selects,
           never from a mapping written here: the numbers are its enum and have
           never been measured on this build. */
        placementHead: '프롬프트 배치',
        placementHint: '설명문을 프롬프트 어디에 넣을지 정하는 SillyTavern 값. 페르소나 설정 화면의 같은 항목',
        placementSource: '항목 이름은 SillyTavern 화면에 있는 그대로',
        placementPosition: '위치',
        placementDepth: '깊이',
        placementRole: '역할',
        placementLorebook: '월드인포',
        placementUnset: '없음',
        placementRaw: value => `값 ${value}`,
        placementUnknownList: '현재 빌드에서 목록 확인 불가로 값 변경 불가',
        placementNoRecord: 'SillyTavern 설명문 기록 없음. 항목 저장 후 배치 변경 가능',
        placementPositionAria: '설명문 위치',
        placementRoleAria: '설명문 역할',
        placementDepthPrompt: '깊이 (0 이상 정수)',
        placementDepthInvalid: '0 이상 정수만 입력 가능',
        // The ceiling is SillyTavern's own, read off its depth input (접점 진단 5
        // measured min=0 max=9999), never a number written here.
        placementDepthOver: max => `깊이 상한 ${max} 초과`,
        placementSaved: '배치 변경 완료',
        placementFailed: '배치 변경 실패',
        lorebookPrompt: '연결할 월드인포 이름 (빈 칸은 연결 해제)',
        lorebookChoose: '연결할 월드인포',
        lorebookDetachOption: '연결 해제',
        lorebookSaved: '월드인포 연결 완료',
        lorebookDetached: '월드인포 연결 해제 완료',
        editValue: '수정',
        connectValue: '연결',

        /* 언어별 이름 (user request). Stored on our own record: SillyTavern's
           personas map is what the rest of it identifies a persona by, so
           rewriting a name there behind the user's back would rename the persona
           everywhere at once. */
        localNamesHead: '언어별 이름',
        localNamesEmpty: '등록된 다른 이름 없음',
        localNameEditHint: '행을 누르면 해당 언어 이름 수정',
        localNamePrompt: lang => `${lang} 이름 (빈 칸은 삭제)`,
        localNameSaved: '이름 저장 완료',
        localNameRemoved: '이름 삭제 완료',
        /* What the check on the LANGUAGE rows means, and it has to say which rows:
           the same box draws a second check, on 자동 적용, that means a switch is
           on. autoLocalName ships true and chatLanguage answers nothing under 40
           characters, so a new chat routinely shows no ticked language row at all
           and the only check on screen is that switch.

           Named as the SillyTavern name rather than 현재 적용된 이름, because the
           manager can be pointed at a persona that is not the one playing: there
           '적용' would be read against the chat, and the chat is somebody else's.
           It also borrows the wording localNameBase already prints two rows up. */
        localNameAppliedHint: '언어 행의 체크 표시는 SillyTavern 이름',
        localNameCurrent: '현재 채팅 언어',
        // A silent no-op is the failure mode this feature can have: the chat is
        // too short, or this build hands us no chat at all, and nothing happens
        // with nothing said. The row says what it sees instead.
        localNameNoChat: '판별 불가 (최근 대화 40자 미만)',
        localNameBase: name => `SillyTavern 이름 ${name}`,
        // 적용 is what carries the name into the chat. Storing an alternate changes
        // nothing by itself, and a screen that looked like it had done something
        // was the complaint (채팅에 적용되지 않음).
        /* 이름을 어디까지 반영할지 (user request 2026-08-27). 사용자 지적:
           채팅 이름과 {{user}}를 한꺼번에 바꾸면 대화 속 동명이인과 부딪힐 수 있다.
           SillyTavern에서 그 둘은 같은 값(name1)이라 서로 떼어낼 수 없다. 떼어낼 수
           있는 것은 페르소나 목록의 이름과 채팅에 반영되는 이름이고, 버튼 둘은 그
           경계에 놓았다. 어느 쪽도 지난 메시지의 글자를 고치지 않는다. */
        applyToList: '목록',
        applyToChat: '채팅',
        applyScopeHint: '[목록]은 페르소나 목록 이름만. [채팅]은 {{user}}와 새 메시지 이름까지. 지난 메시지는 어느 쪽도 변경 없음',
        applyListOnlyActive: '활성 페르소나는 목록 이름과 채팅 이름이 같아야 대상 판별 가능',
        applyChatOnlyActive: '활성 페르소나가 아니라 채팅 반영 불가. 먼저 전환 필요',
        confirmApplyNameList: (from, to) => `목록 이름 "${from}" → "${to}"`,
        confirmApplyNameChat: (from, to) => `채팅 이름 "${from}" → "${to}" ({{user}} 포함)`,
        confirmApplyNameClash: (to, who) => `채팅 이름 "${to}" 적용 (대화 속 "${who}"와 동명)`,
        listNameApplied: name => `목록 이름 "${name}" 변경 완료`,
        autoNameClashSkipped: (name, who) => `"${who}"와 동명이라 자동 적용 건너뜀: ${name}`,
        // 자동 적용의 상태와 그 상태를 뒤집는 버튼. 설정 서랍에도 같은 스위치가
        // 있지만, 이름을 적어 넣는 자리에서 바로 켜고 끌 수 있어야 한다.
        autoNameRow: '자동 적용',
        autoNameTurnOn: '켜기',
        autoNameTurnOff: '끄기',
        autoNameHint: '채팅 언어를 보고 그 언어의 이름으로 자동 변경. 등록된 이름이 있는 언어에만 작동',
        localNameNone: '해당 언어에 등록된 이름 없음',
        localNameTaken: '같은 이름의 페르소나가 이미 있음. 이름 판별 불가로 변경 취소',
        localNameApplied: name => `${name}${euRo(name)} 이름 변경 완료`,
        localNameApplyFailed: 'SillyTavern 이름 변경 실패',

        /* 페르소나 자체를 다루는 것들 (user request). 이름, 그림, 그리고 새 페르소나로
           복제. 셋 다 SillyTavern의 데이터를 바꾸므로 전부 물어보고 시작한다. */
        personaHead: '페르소나',
        renamePersona: '이름 수정',
        renamePersonaPrompt: 'SillyTavern 페르소나 이름',
        changeImage: '이미지 교체',
        imageLabel: '이미지',
        imageButton: '교체',
        changeImageAria: '페르소나 이미지로 쓸 그림 파일',
        // The upload goes through SillyTavern own controls (접점 진단 5 measured
        // both of them present). A build without one names which one, because that
        // is the fact the next round would need.
        changeImageNoControl: id => `SillyTavern 업로드 칸 없음: ${id}`,
        changeImageDone: '이미지 교체 완료. SillyTavern 화면 일부는 새로고침 후 반영',
        // The server answers the upload directly, so a failure carries its status
        // rather than a guess about what the picture looks like now.
        changeImageFailed: detail => `이미지 교체 실패: ${detail}`,
        // The fallback path ends inside SillyTavern's own crop dialog, so the rest
        // of the job is on that screen and this says so instead of claiming an
        // outcome nothing here can see.
        changeImageHandedOver: 'SillyTavern 자르기 창에서 계속 진행',
        confirmChangeImage: name => `"${name}" 이미지 교체 (기존 파일 덮어쓰기)`,
        duplicatePersona: '새 페르소나로 복제',
        confirmDuplicatePersona: name => `"${name}" 복제 (새 페르소나 생성, 관리자 구성 포함)`,
        duplicateNoCommand: '현재 빌드에 페르소나 복제 커맨드 없음',
        duplicateNotFound: '새 페르소나 확인 불가. SillyTavern 페르소나 목록 확인 필요',
        duplicateManyFound: '새 페르소나가 여럿 늘어 판별 불가. 관리자 구성 복사 취소',
        duplicateDone: name => `${name}${euRo(name)} 복제 완료`,
        /* 새 페르소나 생성 (user request). Rides the duplicate command, so the
           refusals above it apply here too; these are only the sentences that
           differ. The confirm names the two things a user cannot see coming:
           the composition starts blank, and the image is the current one's. */
        createPersona: '새 페르소나 생성',
        createNamePrompt: '새 페르소나 이름',
        createNameTaken: name => `이미 있는 이름: "${name}"`,
        confirmCreatePersona: name => `"${name}" 새 페르소나 생성 (빈 구성, 현재 페르소나 이미지 복사됨)`,
        createNoCommand: '페르소나 생성 불가: 현재 빌드에 복제 커맨드 없음',
        createManyFound: '새 페르소나가 여럿 늘어 판별 불가. 기본 구성 생략',
        createRenameFailed: name => `생성 완료. 이름 변경 실패로 "${name}" 유지`,
        createDone: name => `"${name}" 생성 완료`,

        /* 페르소나 복사 (user request). SillyTavern owns making a persona and the
           path for it is unmeasured, so the destination is always one it already
           lists, and what gets replaced is our record for it. */
        copyOpen: '다른 페르소나로 복사',
        copyHead: '복사 대상 고르기',
        copyGuide: 'SillyTavern에 이미 있는 페르소나로만 복사 가능. 새 페르소나 만들기는 미구현',
        copyCancel: '복사 취소',
        copyConfirm: (from, to) => `"${from}" 구성을 "${to}"에 복사 ("${to}"의 기존 데이터 대체)`,
        copyDone: name => `${name}${euRo(name)} 복사 완료`,
        copyFailed: '복사 실패',
        copySameTarget: '현재 편집 중인 페르소나',
        copyLogDetail: name => `${name}에서 복사`,

        /* 버전 tab */
        versionName: '버전 이름',
        versionGone: '삭제된 버전',

        /* 버전별 페르소나 이미지 (user request). A version can carry one asset
           that becomes the persona's picture when it is applied. The four states
           are separate sentences because they are separate facts: nothing bound,
           bound and present, bound but gone from the folder, and bound with the
           folder unread. The last one is not the third one. */
        versionImageHead: '페르소나 이미지',
        versionImageMark: '이미지 지정',
        versionImageNone: '지정 없음',
        versionImageMissing: label => `에셋 없음: ${label}`,
        versionImageUnknown: label => `${label} (에셋 목록 미확인)`,
        versionImagePick: '버전에 지정할 이미지',
        versionImagePickButton: '이미지 지정',
        versionImageNow: '지금 적용',
        versionImageClear: '지정 해제',
        versionImageNoBinding: '지정된 이미지 없음',
        /* 위치·크기 조절 (user request). The frame is the avatar's own 2:3 shape,
           and the dashed square is the part every list and chat icon shows. */
        versionImageFramed: label => `${label} · 위치 조절`,
        versionImageFrame: '위치·크기 조절',
        framingHint: '끌어서 위치 · 두 손가락이나 막대로 확대 → [저장]',
        framingGuide: '점선 안: 목록과 채팅 아이콘에 보이는 범위',
        framingZoom: '확대 배율',
        framingReset: '처음 위치',
        framingLoadFailed: '이미지 불러오기 실패',
        framingSavedLater: '위치·크기 저장 완료. 해당 버전 적용 시 반영',
        framingDecodeFailed: label => `이미지 크기 확인 실패로 교체 취소: ${label}`,
        // Replacing the picture overwrites SillyTavern's avatar file, so the one
        // that was there is copied into the asset folder first. Said out loud
        // because it happens once and silently changes what the folder holds.
        imageBackupMade: '기존 이미지를 에셋으로 보관 완료',
        imageBackupFailed: detail => `기존 이미지 보관 실패로 교체 취소: ${detail}`,
        imageListingFailed: detail => `에셋 목록 읽기 실패: ${detail}`,
        imageAssetMissing: label => `지정된 에셋 없음: ${label}`,
        imageApplyFailed: detail => `이미지 교체 실패: ${detail}`,
        // The picture changed but the record of it did not, so the next apply
        // will do the work again. Reported rather than passed off as a clean
        // success, which is what the caller cannot see from the outside.
        imageAppliedUnrecorded: '이미지 교체 완료. 기록 저장 실패',
        // The backup is taken automatically the first time a bound version
        // overwrites the avatar, so the way back has to be somewhere the user
        // can find without knowing that happened.
        imageRestore: '원본 되돌리기',
        imageNoBackup: '보관된 원본 없음',
        confirmRestoreImage: '보관된 원본 이미지로 되돌리기',
        imageRestored: '원본 이미지 복원 완료',
        confirmOverwriteVersion: name => `버전 "${name}" 덮어쓰기 (이전 내용 복구 불가)`,
        confirmDropVersion: name => `버전 "${name}" 삭제 (태그·이미지 지정 포함, 복구 불가)`,
        overwrite: '덮어쓰기',
        overwriteTitle: '현재 구성을 해당 버전에 덮어쓰기',
        // What a version's slot reads when its pick names nothing that still
        // exists, and equally a section the version never picked: in both cases
        // the version selects nothing there.
        noPick: '없음',
        // Rule 6 says a disabled control explains itself, and rule 4 says the
        // explanation names the next action: the repair select is inside this
        // row's own drawer, so the sentence says how to get there.
        versionNotApplicableReason: '지정된 선택지 없음. [⋯]를 열어 다시 고르기',
        noItemsInVersion: '항목 없음',
        // An empty state is a bare negation; the button standing right under it is
        // already the statement of the next action, so the sentence does not
        // narrate what will appear here once the user presses it.
        noVersionsHere: '아직 저장한 버전 없음',
        saveCurrentAsVersion: '현재 구성을 버전으로 저장',
        pickChoiceAria: name => `${name} 선택지 고르기`,

        /* 고쳐서 새 버전 */
        reviseOpen: '새 버전 만들기',
        reviseGuide: '바꿀 부분 드래그 → [수정]',
        reviseOneItemOnly: '한 항목 안에서만 선택 가능',
        revisePopup: '수정',
        reviseBoxAria: '선택한 부분의 새 내용',
        reviseListHead: '수정한 내용',
        reviseDeleted: '(삭제)',
        reviseRow: (from, to) => `${from} → ${to}`,
        reviseUndo: '마지막 수정 취소',
        reviseSaveVersion: '버전으로 저장',
        reviseConfirmLeave: n => `수정 ${n}건 버리고 나가기`,
        reviseNothing: '수정할 본문 없음. 편집 탭에서 내용 먼저 쓰기',
        reviseSkipped: names => `삭제된 항목이라 반영 실패: ${names}`,

        /* 이력 tab */
        evictionNotice: '이력 총량 상한 초과. 오래된 기록 자동 정리. 설정에서 상한 조정 가능',
        historyChoiceLabel: '선택지',
        historyChoicePlaceholder: '선택지 고르기',
        historyChoiceAria: '이력을 볼 선택지',
        historyPickFirst: '이력을 볼 선택지 고르기',
        historyEmpty: '해당 선택지에 저장된 이력 없음',
        historyModeBefore: '이전',
        historyModeNow: '지금',
        historyModeDiff: '차이',
        // A snapshot whose body is empty still needs a row the eye can land on.
        previewEmpty: '(빈 내용)',
        historyRestore: '해당 시점으로 되돌리기',
        historyRestoreNote: '되돌리기 전 내용도 이력에 보관되므로 되돌린 작업의 재취소 가능',
        confirmRestore: '해당 시점으로 되돌리기 (현재 내용도 이력 보관)',
        snapshotGone: '삭제된 이력',
        diffLineOnly: '본문이 길어 줄 단위로만 비교',
        diffWholeOnly: '본문이 길어 줄 단위 비교도 불가. 전체 교체로 표시',
        logHead: '변경 기록',
        logEmpty: '기록 없음',
        // 일괄 삭제. 지운 뒤 한 줄이 남는 것은 기록 만료와 같은 이유다. 기록이
        // 아무 말 없이 사라지면 데이터 손실과 구별되지 않는다.
        logClear: '기록 전체 삭제',
        confirmClearLog: n => `변경 기록 ${n}줄 삭제`,
        logCleared: n => `변경 기록 ${n}줄 삭제 완료`,

        /* 에셋 tab */
        assetFolder: key => `폴더: ${key}`,
        assetLoading: '에셋 목록을 읽는 중',
        assetListFailed: error => `에셋 목록 불러오기 실패: ${error}`,
        assetRetry: '다시 시도',
        assetRefresh: '목록 새로고침',
        assetUpload: '이미지 업로드',
        assetUploadAria: '올릴 이미지 파일',
        assetNone: '등록된 이미지 없음',
        assetUploadFailed: (name, error) => `${name} 올리기 실패: ${error}`,
        assetFileFallback: '파일',
        assetUploaded: n => `${n}개 올리기 완료`,
        assetUploadedLog: n => `${n}개`,
        assetDeleteFailed: error => `지우기 실패: ${error}`,
        confirmDropAsset: label => `에셋 "${label}" 삭제 (서버 파일 삭제)`,
        // The count is the part the user cannot see from the asset row, so it
        // leads the bracket. What follows it is the same warning as above.
        confirmDropAssetBound: (label, n) => `에셋 "${label}" 삭제 (버전 ${n}개 그림 해제 · 서버 파일 삭제)`,
        targetMovedNotDeleted: '대상 페르소나 변경으로 삭제 취소',
        assetInsert: '채팅에 넣기',
        assetInsertTitle: '입력창 커서 자리에 태그 삽입 후 현재 화면 닫기',
        assetVersionNote: '버전마다 쓸 에셋은 버전 탭에서 고르기. 아무것도 고르지 않으면 전체 사용',
        assetSelectionAll: '에셋: 전체',
        assetSelectionSome: n => `에셋: ${n}개 선택`,
        assetOpenTabFirst: '에셋 탭에서 목록 먼저 열기',
        assetListLoading: '에셋 목록 준비 중',
        assetNoneForPersona: '해당 페르소나에 등록된 에셋 없음',
        sendBoxMissing: '입력창 찾기 실패',
        sendBoxInserted: '입력창에 삽입 완료',

        /* 그룹 tab */
        groupName: '그룹 이름',
        groupGone: '삭제된 그룹',
        confirmDropGroup: name => `그룹 "${name}" 삭제 (페르소나는 유지)`,
        groupsEmpty: '아직 만든 그룹 없음',
        newGroupPlaceholder: '새 그룹',
        newGroupAria: '새 그룹 이름',
        groupMemberCount: n => `${n}개`,
        groupAttach: '붙이기',
        groupDetach: '떼기',
        groupAttachTitle: '현재 선택한 페르소나에 해당 그룹 붙이기/떼기',
        groupPickPersonaFirst: '페르소나 먼저 고르기',
        groupRefusalNoState: '상태 미확인으로 그룹 변경 불가',
        groupRefusalReadOnly: '더 새로운 판이 만든 데이터라 그룹 변경 불가',
        groupRefusalAmbiguous: '이름이 같은 페르소나가 여럿이라 그룹 변경 취소',
        groupRefusalOther: '현재 그룹 변경 불가',

        /* Header and persona picker */
        pickerTitle: '페르소나 고르기',
        noPersona: '(페르소나 없음)',
        pickPersonaHere: '위에서 페르소나 고르기',
        personasUnavailable: 'SillyTavern 페르소나 목록 응답 없음',
        notAdoptedTag: '미등록',
        confirmAdopt: '현재 페르소나 관리 시작 (기존 설명문 보존)',
        adoptButton: '기존 설명문 가져오기',
        targetMovedNotAdopted: '대상 페르소나 변경으로 가져오기 취소',
    },

    /* The settings drawer. */
    settings: {
        title: APP_NAME,
        // The word the drawer's band repeats. Short on purpose: the band sets it
        // large three times and the app name would not fit a phone at that size.
        bandWord: '설정',
        readOnlyBanner: '더 새로운 판이 만든 데이터라 읽기 전용. 설정 변경 불가',
        showQuickBar: '입력창 아이콘 표시',
        showQuickBarHint: '끄면 입력창의 페르소나 아이콘과 빠른 전환 패널 숨김. 저장한 내용은 그대로 유지',
        // Two switches, not one three way choice: the user asked
        // to be able to turn either on by itself.
        rosterShowVersionCount: '목록에 버전 개수 표시',
        rosterShowVersionCountHint: '페르소나 목록의 이름 옆에 "버전 3"처럼 개수 표시. 관리자 데이터가 없는 페르소나는 제외',
        rosterShowVersionNames: '목록에 버전 이름 표시',
        rosterShowVersionNamesHint: '페르소나 목록의 이름 아래에 저장된 버전 이름을 한 줄로 표시',
        historyPerVariant: '이력 보관 개수',
        historyPerVariantHint: '선택지 하나가 보관하는 스냅샷 수. 0이면 이력 미보관 (0~50)',
        historyMaxBytes: '이력 총량 상한 (바이트)',
        historyMaxDays: '이력 보관 기간 (일)',
        historyMaxDaysHint: '설정 기간이 지난 이력은 자동 삭제. 0이면 기간 제한 없음 (0~3650)',
        historyMaxBytesHint: '전체 이력이 설정 크기를 넘으면 오래된 것부터 자동 정리 (64KB~2MB)',
        historyCoalesceMinutes: '편집 병합 시간 (분)',
        historyCoalesceMinutesHint: '설정 시간 안의 연속 편집은 이력 한 건으로 병합 (1~30)',
        defaultHeadingFormat: '새 페르소나의 항목 제목',
        defaultHeadingFormatHint: '관리를 새로 시작하는 페르소나가 쓸 형식. 이미 만든 페르소나는 편집 탭에서 각각 변경',
        splitOnAdopt: '가져올 때 항목별 분류',
        splitOnAdoptHint: '관리 시작 시 설명문의 제목 줄(## 외모, 외모:, [외모] 등)을 항목 이름과 맞춰 각 항목에 배치. 이름이 없는 제목은 새 항목. 끄면 설명문 전체를 첫 항목에 보관',
        autoLocalName: '언어별 이름 자동 적용',
        autoLocalNameHint: '채팅에 쓰인 언어를 보고 그 언어의 이름으로 페르소나 이름 자동 변경. 등록된 이름이 없거나 같은 이름의 페르소나가 있으면 그대로 유지',
        injectAssetMacros: '에셋 매크로 주입',
        injectAssetMacrosHint: '끄면 {{persona_assets}}와 {{persona_asset_prompt}} 모두 빈 문자열',
        assetTemplate: '에셋 지시문 템플릿',
        assetTemplateHint: '{{persona_asset_prompt}} 매크로가 출력하는 글. {{persona_assets}} 자리에 파일 목록 삽입',
        assetStyle: '에셋 표시 스타일',
        assetStyleHint: '채팅에 그려지는 이미지의 테두리 모양',
        assetStylePlain: '기본',
        assetStyleBordered: '테두리',
        assetStylePolaroid: '폴라로이드',
        // The display settings.
        rosterTileColumns: '타일 열 수',
        rosterTileColumnsHint: '타일 보기에서 한 줄에 놓는 개수. 자동은 화면 폭 기준',
        tileColumnsAuto: '자동',
        rosterTileRows: '타일 행 수',
        rosterTileRowsHint: '한 화면에 놓는 줄 수. 열 수 곱하기 행 수가 한 페이지 개수. 0이면 페르소나 목록 개수 설정 적용 (0~20)',
        rosterTileShape: '타일 모양',
        rosterTileShapeHint: '타일 보기에서 아바타를 자르는 모양',
        tileShapeNames: {
            circle: '원형',
            rounded: '둥근 사각',
            square: '사각',
        },
        pageSizeRoster: '페르소나 목록 한 화면 개수',
        pageSizeAssets: '에셋 한 화면 개수',
        pageSizeVersions: '버전 한 화면 개수',
        pageSizeHint: '초과분은 페이지로 분할. 0이면 전부 한 화면에 (0~200)',
        /* 페르소나 식별 방식 (device: Termux라 콘솔을 볼 수 없음). Which route
           named the active persona is what decides whether two same-named personas
           can be edited, so it belongs on the screen rather than in a console line
           nobody on a phone can open. */
        identify: '페르소나 식별',
        identifySources: {
            precise: '정밀 (파일 직접)',
            dom: '화면 (파일 직접)',
            lock: '채팅 고정',
            name: '이름 역추적',
            none: '판별 불가',
        },
        identifyLine: (how, detail) => `페르소나 식별: ${how}${detail ? ` · ${detail}` : ''}`,
        identifyTiles: (n, classes) => `아바타 칸 ${n}개 · ${classes}`,
        identifyNoTiles: '아바타 목록 미발견',
        usage: '저장 사용량',
        usageBytes: kb => `저장 사용량 ${kb}KB`,
        refreshUsage: '사용량 새로고침',
        // 빈 페르소나, not 빈 항목: what this removes is persona entries with no
        // data of ours, and 항목 is the fixed word for a section.
        /* Every asset instruction this extension has ever SHIPPED as the default.

           The template is a stored setting, and migrate only fills a key that is
           missing, so changing the default changed nothing for anybody who already
           had one: the user upgraded and went on seeing the first version of this
           text, which is exactly what they reported. Shipping a new default and
           leaving every existing install on the old one is not shipping it.

           What must not happen is overwriting an instruction the user wrote. So
           the test is exact equality against what WE wrote: if the stored value is
           byte for byte one of ours, it was never touched and is replaced with the
           current one; anything else is theirs and is left alone. Every retired
           default has to stay on this list for that comparison to keep working. */
        legacyAssetPrompts: Object.freeze([
            '아래는 {{user}}의 이미지 목록이다. 장면에 어울리면 {{pimg::파일명}} 형태로 한 번만 넣어라.\n{{persona_assets}}',
            '{{user}}의 이미지는 아래 목록이 전부다.\n'
            + '{{persona_assets}}\n'
            + '\n'
            + '넣는 방법:\n'
            + '- 형태는 {{pimg::이름}} 하나뿐이다. 목록에 적힌 이름을 그대로 쓴다.\n'
            + '- 확장자를 붙이거나 이름을 고치거나 목록에 없는 것을 지어내지 않는다.\n'
            + '- 한 응답에 최대 두 개. 문단이 끝난 자리에만 넣고 문장 중간에는 넣지 않는다.\n'
            + '- 장면의 내용이나 분위기와 맞는 것이 있을 때만 넣는다. 없으면 넣지 않는다.\n'
            + '- 최근 응답에서 쓴 이름은 다시 쓰지 않는다.',
        ]),
        /* 에셋 지시문 기본값 (user request). The instruction the user supplied,
           rewritten for this extension's tag format and kept in ENGLISH, which is
           the language they wrote it in and the language it is addressed to: this
           string is not read by anyone, it is sent to the model. Every other
           string in this file is the opposite and is Korean for the same reason.

           Two things in the source could not be copied. It asked for the file
           EXTENSION in every tag; our listing carries none, because labelOf strips
           it and the renderer resolves a bare label against the server's own
           listing, so a tag with an extension resolves to nothing. And it kept a
           clause about HTML <img> for external pictures, which inside a chat is an
           invitation to emit raw HTML; the rule here is one form and no other.

           The rest is the source's: a cap of two, only between paragraphs, only
           when the picture suits the scene, and no repeats from recent turns. */
        assetPromptDefault:
            "The only images {{user}} has are the ones listed here.\n"
            + '{{persona_assets}}\n'
            + '\n'
            + 'How to use them:\n'
            + '- The only form is {{pimg::name}}. Write a name exactly as it appears above.\n'
            + '- Never add a file extension, alter a name, or invent one that is not listed.\n'
            + '- At most two per response, each placed after a paragraph ends, never mid-sentence.\n'
            + "- Insert one only where it suits that paragraph's subject or mood. If none suits it, insert none.\n"
            + '- Do not reuse a name you have used in recent responses.',
        pruneEmpty: '빈 페르소나 정리',
        pruneReadOnly: '읽기 전용이라 정리 불가',
        pruneDone: n => `빈 페르소나 ${n}건 정리 완료`,
        pruneNothing: '정리할 빈 페르소나 없음',
        clearHistory: '이력 전체 비우기',
        clearHistoryReadOnly: '읽기 전용이라 비우기 불가',
        confirmClearHistory: '모든 페르소나의 수정 이력 삭제 (복구 불가)',
        confirmTightenCap: '보관 한도를 줄이면 넘치는 이력 즉시 삭제 (복구 불가)',
        historyTrimmed: n => `이력 ${n}건 정리 완료`,
        clearHistoryLog: n => `이력 ${n}건 삭제`,
        clearHistoryDone: n => `이력 ${n}건 삭제 완료`,
        clearHistoryNothing: '지울 이력 없음',
        /* The CHANGE LOG, which is a different list from the edit history above
           and the only one no budget could ever reach. Measured: 30 personas at
           the 200 line cap come to 461KB on their own, past the 512KB the usage
           figure turns red at, and the eviction the budget runs only ever drops
           snapshots. So the warning was true and there was nothing on any screen
           that could act on it. */
        clearLogs: '변경 기록 전체 비우기',
        confirmClearLogs: '모든 페르소나의 변경 기록 삭제 (복구 불가)',
        clearLogsDone: n => `변경 기록 ${n}줄 삭제 완료`,
        clearLogsNothing: '지울 변경 기록 없음',
        openManager: '관리자 열기',
        openManagerFailed: '관리자 화면 열기 실패',
        exportRegex: '정규식으로 내보내기',
        exportSettings: '설정 내보내기',
        importSettings: '설정 가져오기',
        importFileAria: '가져올 설정 파일',
        noDownload: '현재 브라우저에서 파일 내려받기 불가',
        noFileRead: '현재 브라우저에서 파일 읽기 불가',
        noRoot: '설정 불러오기 실패',
        noActivePersona: '활성 페르소나가 없어 대상 폴더 확정 불가',
        regexScriptName: (folderKey) => `페르소나 관리자 이미지 (${folderKey}, 표시 전용)`,
        regexExported: key => `${key} 폴더 기준으로 생성. 다른 페르소나에는 부적합`,
        settingsExported: '설정 내려받기 완료',
        importReadOnly: '읽기 전용이라 가져오기 불가',
        importNotApplied: '읽기 전용이라 가져오기 취소',
        importReadFailed: error => `파일 읽기 실패: ${error}`,
        // parseImportedRoot's three refusals: a failure that can only be reached
        // by a user waiting to hear about their file says why.
        importNotJson: error => `설정 파일 형식 오류: ${error}`,
        importNotShape: '설정 파일 형식 불일치',
        importBadPersonas: n => `페르소나 ${n}개의 형식 불일치. 현재 데이터 유지`,
        importNewer: (fileVersion, myVersion) => `더 새로운 판(스키마 ${fileVersion})이 만든 파일이라 가져오기 불가. 현재 판의 지원 범위는 스키마 ${myVersion}까지`,
        importNoContext: '설정 불러오기 실패로 가져오기 불가',
        confirmImport: `가져온 파일로 전체 덮어쓰기 (현재 항목·버전·이력·그룹 삭제, 복구 불가)`,
        importDone: '설정 가져오기 완료',
        regexHint: `[정규식으로 내보내기]는 현재 활성 페르소나의 폴더 하나에 고정된 표시 전용 정규식. ${APP_NAME}의 이미지 표시 기능과 병용 금지, 둘 중 하나만 사용. ST 정규식 화면에 넣은 뒤 확인 필요`,
        importHint: `[설정 가져오기]는 ${APP_NAME}가 저장한 내용을 통째로 교체. 먼저 [설정 내보내기]로 현재 상태 백업 권장`,
    },

    /* 가져오기 자동 분류 (classify.js). Words READ from a description, never shown:
       the other names a title may use for each shipped item. Keyed by the shipped
       item name exactly as store.js spells it. Spaces, case and & / · are ignored
       when matching, so each word is written once. */
    classify: {
        titleAliases: {
            '기본 정보': ['기본정보', '프로필', '개요', 'profile', 'basic info', 'basic information', 'basics', 'overview', 'info'],
            '외모': ['외형', '외관', '생김새', 'appearance', 'looks', 'physical appearance', 'physical'],
            '배경': ['배경 설정', '과거', '배경 이야기', '설정', 'background', 'backstory', 'history'],
            '성격': ['personality', 'traits', 'personality traits'],
            '버릇 & 습관': ['habits', 'quirks', 'mannerisms'],
            '능력 & 기술': ['특기', 'skills', 'abilities'],
            '관계': ['인간관계', '대인관계', 'relationships', 'relations'],
            '숨겨진 욕망': ['욕망', 'desires', 'hidden desires', 'secret desires'],
            '말투 & 대사': ['어투', 'speech', 'speech style', 'dialogue', 'voice'],
            'NSFW 외모': ['nsfw appearance'],
            // Only words that mean the sexual kind: 취향 and preferences also say
            // 커피와 영화, and that text does not belong in this item.
            '성적 취향': ['kinks', 'sexual preferences'],
            'AI 가이드라인': ['가이드라인', 'guidelines', 'ai guidelines', 'ai notes'],
            '캐릭터 노트': ['노트', '메모', 'notes', 'character notes'],
        },
    },
});
