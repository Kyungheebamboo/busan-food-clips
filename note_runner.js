/* note 자동 발행 러너 — 편집기 페이지에 1회 주입해 note_plan.json을 실행한다.
 *
 * 사용법:
 *   1) https://note.com/notes/new 접속 (또는 기존 글 편집기)
 *   2) 이 파일 전체를 javascript_tool로 주입  → 'runner loaded' 반환
 *   3) window.__plan = {...대본...}           → 대본이 크면 나눠서 주입
 *   4) await window.__noteRun(window.__plan)  → 결과 리포트 반환
 *   5) await window.__noteCover(plan.cover)   → 커버, 반환된 좌표를 물리 클릭
 *
 * 실측 근거·함정 = docs/superpowers/specs/2026-07-24-note-auto-publish-design.md §2·§4-3
 */

window.__noteRun = async (plan) => {
  const R = { ok: false, step: 'start', done: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 🚨 사람 속도 흉내 — note 약관에 자동화 금지 조항은 없으나 "서비스에 장애가 되는 행위"
  //    포괄 조항이 있어 지켜야 할 조건으로 격상됐다(설계 §10-①).
  const human = () => sleep(800 + Math.floor(Math.random() * 1200));

  const pm = document.querySelector('.ProseMirror');
  if (!pm) { R.error = 'ProseMirror 없음 — 편집기 페이지가 맞는지 확인'; return R; }
  const sel = window.getSelection();

  const anchorsLeft = () => (pm.innerText.match(/@@MEDIA\d+@@/g) || []).length;
  const blobsLeft = () => [...pm.querySelectorAll('img')].filter((x) => x.src.startsWith('blob:')).length;

  /* 🚨 함정① — DOM selection만 바꾸고 즉시 paste하면 ProseMirror가 옛 커서를 써서 조용히 씹는다.
   *    selectionchange를 알리고 400ms 기다려야 반영된다(2026-07-24 실측: 안 하면 h2가 0개). */
  const put = async (el) => {
    pm.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(r);
    document.dispatchEvent(new Event('selectionchange'));
    await sleep(400);
  };

  const findAnchor = (token) =>
    [...pm.querySelectorAll('p')].find((e) => e.textContent.trim() === token);

  // 1) 제목 — React가 인식하도록 value setter + input 이벤트 (form_input은 오염 사례 있음)
  const ta = document.querySelector('textarea[placeholder*="記事タイトル"]');
  if (!ta) { R.error = '제목칸 없음'; return R; }
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, plan.title);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  R.step = 'title';
  await sleep(600);

  // 2) 본문 — 앵커(@@MEDIAn@@) 포함해 통째로 1회 paste
  await put(pm.querySelector('p') || pm.firstElementChild);
  const dtBody = new DataTransfer();
  dtBody.setData('text/html', plan.body_html);
  dtBody.setData('text/plain', plan.body_html.replace(/<[^>]+>/g, ''));
  pm.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dtBody }));
  R.step = 'body';
  await sleep(1500);

  if (anchorsLeft() !== plan.media.length) {
    R.error = `본문 붙여넣기 후 앵커 ${anchorsLeft()}개 — 대본은 ${plan.media.length}개. 본문이 온전히 안 들어갔다`;
    return R;
  }

  // 3) 앵커 → 미디어
  for (const m of plan.media) {
    R.step = 'media:' + m.name;
    const before = { figures: pm.querySelectorAll('figure').length, anchors: anchorsLeft() };

    const anchor = findAnchor(m.anchor);
    if (!anchor) { R.error = `앵커 못 찾음: ${m.anchor}`; return R; }
    await put(anchor);

    const res = await fetch(m.url, { mode: 'cors' });
    if (!res.ok) { R.error = `CDN ${res.status}: ${m.url}`; return R; }
    const blob = await res.blob();
    const ext = m.kind === 'gif' ? '.gif' : '.jpg';
    const type = m.kind === 'gif' ? 'image/gif' : 'image/jpeg';
    const dt = new DataTransfer();
    dt.items.add(new File([blob], m.name + ext, { type }));
    pm.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));

    // note 서버 업로드 완료 대기 — blob: URL이 남아 있으면 아직 끝나지 않은 것
    let uploaded = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (pm.querySelectorAll('figure').length > before.figures && blobsLeft() === 0) { uploaded = true; break; }
    }
    if (!uploaded) { R.error = `업로드 안 끝남(30초): ${m.name}`; return R; }

    /* 🚨 실측(2026-07-25): paste는 앵커를 **대체하지 않고 그 아래에 삽입**한다.
     *    남은 앵커 문단을 execCommand('delete') 2번으로 지운다.
     *    ① 앵커 텍스트 제거 → 빈 문단   ② 빈 문단 제거(앞 블록과 병합)  */
    const left = findAnchor(m.anchor);
    if (left) {
      await put(left);
      document.execCommand('delete');
      await sleep(500);
      // 빈 문단이 문서 맨 앞이면 병합할 앞 블록이 없다 → 빈 문단 한 줄은 그대로 둔다(무해)
      if (left.previousElementSibling) {
        document.execCommand('delete');
        await sleep(500);
      }
    }

    if (anchorsLeft() !== before.anchors - 1) {
      R.error = `앵커가 안 줄었다: ${m.anchor} (${before.anchors} → ${anchorsLeft()}). ` +
                '그대로 두면 발행본에 앵커가 노출된다';
      return R;
    }

    if (m.caption) {
      // 사진 삽입 직후 커서는 figcaption 안 — 캡션은 바로 거기로 들어간다(함정②의 역이용)
      const dtc = new DataTransfer();
      dtc.setData('text/plain', m.caption);
      pm.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dtc }));
      await sleep(400);
    }

    R.done.push(m.name);
    await human();
  }

  R.ok = true;
  R.step = 'done';
  R.report = {
    figures: pm.querySelectorAll('figure').length,
    h2: pm.querySelectorAll('h2').length,
    anchorsLeft: anchorsLeft(),
    blobsLeft: blobsLeft(),
    hangul: /[가-힣]/.test(pm.innerText),
    labels: (pm.innerText.match(/フッター|\[地図\]|\[사진|\[영상/g) || []).length,
  };
  return R;
};

/* 커버(見出し画像) 주입 — 크롭 모달이 뜨는 데까지.
 * 🚨 모달의 `保存`은 JS .click()이 안 먹는다(React) → 반환된 좌표를 물리 클릭할 것. */
window.__noteCover = async (url) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const add = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '画像を追加');
  if (!add) return { ok: false, error: '커버 추가 버튼 없음 — 이미 커버가 있는지 확인' };
  add.click();
  await sleep(1500);

  const up = [...document.querySelectorAll('button')].find((b) => /画像をアップロード/.test(b.textContent || ''));
  if (!up) return { ok: false, error: '업로드 버튼 없음' };
  up.click();
  await sleep(1200);

  const input = document.querySelector('input[type=file][accept*="image/jpeg"]');
  if (!input) return { ok: false, error: '파일 입력칸 없음' };
  const blob = await (await fetch(url, { mode: 'cors' })).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'note_cover.png', { type: blob.type || 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(3000);

  const modal = document.querySelector('.ReactModal__Content');
  if (!modal) return { ok: false, error: '크롭 모달 안 뜸' };
  const save = [...modal.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存');
  if (!save) return { ok: false, error: '모달에 保存 버튼 없음' };
  const r = save.getBoundingClientRect();
  return { ok: true, clickSave: [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)] };
};

/* 공개설정 페이지 — 진행 중 お題와 매거진 목록을 읽어 좌표와 함께 돌려준다.
 * 고르는 판단은 사람/에이전트 몫(08 §8: 무관한 お題를 억지로 달지 말 것). */
window.__noteReadPublishPage = () => {
  const txt = (e) => (e.textContent || '').trim();
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  };
  const odai = [...document.querySelectorAll('button')]
    .filter((b) => /件/.test(txt(b)) && txt(b).length < 60)
    .map((b) => ({ label: txt(b), click: center(b) }));
  const mags = [...document.querySelectorAll('button')]
    .filter((b) => txt(b) === '追加')
    .map((b) => ({ row: txt(b.closest('div')).slice(0, 40), click: center(b) }));
  const post = [...document.querySelectorAll('button')].find((b) => txt(b) === '投稿する');
  return { odai, mags, post: post ? center(post) : null };
};

/* 발행 순서 (에이전트용 메모)
   1. `公開に進む` 물리 클릭
   2. window.__noteReadPublishPage() 로 お題·매거진·投稿する 좌표 확보
   3. 旅/グルメ/おでかけ 관련 お題 1~2개만 물리 클릭 (08 §8)
   4. plan.magazine 과 일치하는 행의 `追加` 물리 클릭
   5. 🚨 검증 게이트 전항목 통과 + 사장님 승인 후에만 `投稿する` 물리 클릭
   6. 발행본 URL을 열어 [J5]⑤ 실사 → 어긋난 건 빌더에 역반영 */

'runner loaded';
