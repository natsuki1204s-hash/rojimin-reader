// ==UserScript==
// @name         ロジみん読み上げ（きりたん×VOICEVOX）
// @namespace    rojimin
// @version      0.11
// @description  claude.ai で Claude の返信が出終わったら、VOICEVOX で読み上げる（キャラ切り替え付き）
// @match        https://claude.ai/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ===== 設定 =====
  const ENGINE = 'http://127.0.0.1:50021'; // VOICEVOXエンジンの場所
  const SPEAKER_NAME = '東北きりたん';      // 最初のキャラ（メニューで選んだらそっちを覚える）
  const STYLE_NAME = 'ノーマル';            // 最初のスタイル（無ければ最初のスタイル）
  // ↓VOICEVOXアプリ側の調整は反映されないので、ここで決める
  const SPEED = 1.1;        // 話速        （標準 1.0／0.5〜2.0）
  const PITCH = 0.0;        // 音高        （標準 0.0／-0.15〜0.15くらいが無難）
  const INTONATION = 1.0;   // 抑揚        （標準 1.0／0〜2.0）
  const VOLUME = 1.0;       // 音量        （標準 1.0）
  // ※ユーザー辞書はVOICEVOXアプリで登録したものがそのまま効く
  const MAX_CHUNK = 120;                    // 1回で合成する最大文字数
  const LOG = (...a) => console.log('[ロジみん読み上げ]', ...a);

  let enabled = GM_getValue('enabled', true);       // ON/OFFは再読み込みしても覚えている
  let speakerId = GM_getValue('speakerId', null);   // メニューで選んだキャラ
  let speakerShort = GM_getValue('speakerShort', shortName(SPEAKER_NAME));
  // ===== 声の調整（キャラごとに保存。初期値は上の数字） =====
  const DEFAULTS = { speed: SPEED, pitch: PITCH, intonation: INTONATION, volume: VOLUME };
  const SLIDERS = [
    { key: 'speed',      label: '話速', min: 0.5,   max: 2.0,  step: 0.05 },
    { key: 'pitch',      label: '音高', min: -0.15, max: 0.15, step: 0.01 },
    { key: 'intonation', label: '抑揚', min: 0,     max: 2.0,  step: 0.05 },
    { key: 'volume',     label: '音量', min: 0,     max: 2.0,  step: 0.05 },
  ];
  function getSettings() {
    return Object.assign({}, DEFAULTS, GM_getValue(`settings_${speakerId}`, {}));
  }
  function saveSetting(key, value) {
    const cur = GM_getValue(`settings_${speakerId}`, {});
    cur[key] = value;
    GM_setValue(`settings_${speakerId}`, cur);
  }
  let session = 0;          // 新しい読み上げが始まったら古いのを止めるための番号
  let currentAudio = null;

  // ===== VOICEVOX 通信 =====
  function gmRequest(method, url, { data, headers, binary } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, data, headers,
        responseType: binary ? 'arraybuffer' : 'text',
        onload: (r) => (r.status >= 200 && r.status < 300)
          ? resolve(binary ? r.response : r.responseText)
          : reject(new Error(`HTTP ${r.status} ${url}`)),
        onerror: () => reject(new Error('VOICEVOXに繋がりません（起動してますか？）')),
      });
    });
  }

  async function getSpeakerId() {
    if (speakerId !== null) return speakerId;
    const speakers = JSON.parse(await gmRequest('GET', `${ENGINE}/speakers`));
    const sp = speakers.find((s) => s.name === SPEAKER_NAME);
    if (!sp) throw new Error(`話者「${SPEAKER_NAME}」が見つかりません`);
    const st = sp.styles.find((s) => s.name === STYLE_NAME) || sp.styles[0];
    speakerId = st.id;
    speakerShort = shortName(sp.name);
    setBadge();
    LOG(`話者: ${sp.name} / ${st.name} (id=${speakerId})`);
    return speakerId;
  }

  async function synth(text) {
    const id = await getSpeakerId();
    const q = await gmRequest('POST',
      `${ENGINE}/audio_query?speaker=${id}&text=${encodeURIComponent(text)}`);
    const query = JSON.parse(q);
    const cfg = getSettings();
    query.speedScale = cfg.speed;
    query.pitchScale = cfg.pitch;
    query.intonationScale = cfg.intonation;
    query.volumeScale = cfg.volume;
    return gmRequest('POST', `${ENGINE}/synthesis?speaker=${id}`, {
      data: JSON.stringify(query),
      headers: { 'Content-Type': 'application/json' },
      binary: true,
    });
  }

  function play(buf, mySession) {
    return new Promise((resolve) => {
      if (mySession !== session) return resolve();
      const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      const audio = new Audio(url);
      currentAudio = audio;
      const done = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onended = done;
      audio.onerror = done;
      audio.play().catch((e) => { LOG('再生できません', e); done(); });
    });
  }

  function stopSpeaking() {
    session++;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  }

  // ===== 文章の下ごしらえ =====
  function extractText(el) {
    const root = el.querySelector('.font-claude-response') || el;
    const clone = root.cloneNode(true);
    // コードブロック・表・ボタン類は読まない
    // .sr-only = 画面には出ない読み上げ用ラベル（「Claudeの応答」等）、time = 「いま」等の時刻表示
    clone.querySelectorAll('pre, table, svg, button, img, script, style, time, .sr-only, [aria-hidden="true"], details, summary, [role="button"], [data-testid*="tool"]')
      .forEach((n) => n.remove());
    // 本文（段落・箇条書き・見出し・引用）だけを拾う。
    // 「ファイルを編集しました」等の作業表示や添付ファイル名のカードは段落ではないので拾わない
    const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, blockquote';
    const blocks = [...clone.querySelectorAll(BLOCK)]
      .filter((n) => !n.parentElement || !n.parentElement.closest(BLOCK)); // 入れ子は外側だけ
    let t;
    if (blocks.length) {
      blocks.forEach((n) => n.querySelectorAll('li, p, br').forEach((c) => c.append('\n')));
      t = blocks.map((n) => n.textContent.trim())
        // 作業表示（「ウェブを検索しました」等）は句読点なしの短い「〜しました」なので除外
        .filter((s) => !(s.length < 40 && /しました$/.test(s) && !/[。！？!?]/.test(s)))
        .join('\n');
    } else {
      t = clone.textContent || '';
    }
    t = t.replace(/^\s*(Claude|クロード)の応答\s*/i, '')
         .replace(/\s*(いま|今|たった今)\s*$/, '')
         .replace(/https?:\/\/\S+/g, 'リンク')
         .replace(/[*#`>|_~]/g, '')
         .replace(/\p{Extended_Pictographic}/gu, '')
         .replace(/[ \t]+/g, ' ')
         .replace(/\n{2,}/g, '\n')
         .trim();
    return t;
  }

  function splitChunks(text) {
    const parts = text.split(/(?<=[。！？!?\n])/).map((s) => s.trim()).filter(Boolean);
    const chunks = [];
    let buf = '';
    for (const p of parts) {
      if ((buf + p).length > MAX_CHUNK && buf) { chunks.push(buf); buf = ''; }
      if (p.length > MAX_CHUNK) {               // 句点なしの長文は強制分割
        for (let i = 0; i < p.length; i += MAX_CHUNK) chunks.push(p.slice(i, i + MAX_CHUNK));
      } else {
        buf += p;
      }
    }
    if (buf) chunks.push(buf);
    // 出だしを早くするため、最初のかたまりは1文目だけ（短いほど合成が速い）
    if (chunks.length && parts.length && chunks[0].length > parts[0].length && parts[0].length <= MAX_CHUNK) {
      chunks[0] = chunks[0].slice(parts[0].length);
      chunks.unshift(parts[0]);
    }
    return chunks;
  }

  async function speak(text) {
    stopSpeaking();
    const mySession = session;
    const chunks = splitChunks(text);
    if (!chunks.length) return;
    LOG(`読み上げ開始（${chunks.length}分割）`);
    try {
      let next = synth(chunks[0]);
      for (let i = 0; i < chunks.length; i++) {
        const buf = await next;
        if (mySession !== session) return;
        if (i + 1 < chunks.length) next = synth(chunks[i + 1]); // 再生中に次を先に作る
        await play(buf, mySession);
        if (mySession !== session) return;
      }
    } catch (e) {
      LOG('エラー:', e.message);
      setBadge('ERR');
    }
  }

  // ===== 返信の完了を見張る =====
  // 「生成中(true)」を見たメッセージが「完了(false)」になった瞬間だけ読む。
  // → ページを開いた時やチャット切り替え時の過去ログは読まない。
  const SEL = '[data-is-streaming]';
  const seenStreaming = new WeakSet();
  const spoken = new WeakSet();
  // 1つの返信で「完了」が何度も来ることがあるので、
  // 少し待ってまとめ、いちばん長い文章を1回だけ読む
  const SETTLE_MS = 400;
  let pending = [];
  let settleTimer = null;
  let lastSpokenText = '';

  function flush() {
    settleTimer = null;
    const cands = pending; pending = [];
    if (!enabled || !cands.length) return;
    let best = '';
    for (const el of cands) {
      if (!el.isConnected) continue;
      const t = extractText(el);
      if (t.length > best.length) best = t;
    }
    // 同じ返信の「遅れてきた完了合図」（ほぼ同じ文章）は読み直さない
    const head = (s) => s.slice(0, 40);
    if (!best || (lastSpokenText && head(best) === head(lastSpokenText))) {
      LOG('同じ返信なのでスキップ'); return;
    }
    lastSpokenText = best;
    LOG(`取得した文章（候補${cands.length}件）:`, best.slice(0, 80) + (best.length > 80 ? '…' : ''));
    speak(best);
  }

  function check(el) {
    const v = el.getAttribute('data-is-streaming');
    if (v === 'true') { seenStreaming.add(el); return; }
    if (v === 'false' && seenStreaming.has(el) && !spoken.has(el)) {
      spoken.add(el);
      pending.push(el);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(flush, SETTLE_MS);
    }
  }

  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        check(m.target);
      } else {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.matches(SEL)) check(n);
          n.querySelectorAll(SEL).forEach(check);
        });
      }
    }
  }).observe(document.body, {
    subtree: true, childList: true,
    attributes: true, attributeFilter: ['data-is-streaming'],
  });

  // ===== 画面右下：キャラ選択メニュー＋ON/OFFボタン =====
  // 「東北きりたん」→「きりたん」のように苗字を省いた短い名前（ボタン表示用）
  function shortName(name) {
    const m = name.match(/^(東北|四国|九州|中国|中部|春日部|雨晴|波音|玄野|白上|青山|冥鳴|剣崎|猫使)(.+)$/);
    return m ? m[2] : name;
  }

  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', right: '12px', bottom: '80px', zIndex: 99999,
    display: 'flex', gap: '6px', alignItems: 'center', opacity: '0.9',
  });

  // ブラウザ標準のプルダウンはclaude.ai上だと開かないことがあるので、自前のメニューにする
  const sel = document.createElement('button');
  sel.textContent = '▲ キャラ';
  Object.assign(sel.style, {
    fontSize: '12px', padding: '6px 10px', borderRadius: '16px', border: '1px solid #ccc',
    background: '#fff', color: '#333', cursor: 'pointer', whiteSpace: 'nowrap',
  });
  sel.title = '読み上げるキャラを選ぶ（選ぶと試し読みします）';

  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed', right: '12px', bottom: '118px', zIndex: 100000,
    display: 'none', width: '240px', maxHeight: '70vh', overflowY: 'auto',
    background: '#fff', color: '#333', border: '1px solid #ccc', borderRadius: '10px',
    boxShadow: '0 4px 16px rgba(0,0,0,.2)', fontSize: '13px', padding: '4px 0',
  });
  function setPanelMessage(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.padding = '8px 12px';
    list.replaceChildren(d);
  }

  // --- 調整エリア（スライダー） ---
  const tune = document.createElement('div');
  Object.assign(tune.style, { padding: '8px 12px', borderBottom: '1px solid #eee' });
  const tuneTitle = document.createElement('div');
  Object.assign(tuneTitle.style, { fontWeight: 'bold', fontSize: '12px', marginBottom: '4px' });
  tune.appendChild(tuneTitle);
  const sliderEls = {};
  for (const def of SLIDERS) {
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' });
    const lab = document.createElement('span');
    lab.textContent = def.label;
    lab.style.width = '28px';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = def.min; input.max = def.max; input.step = def.step;
    input.style.flex = '1';
    const val = document.createElement('span');
    Object.assign(val.style, { width: '38px', textAlign: 'right', fontFamily: 'monospace' });
    input.oninput = () => {
      const v = Number(input.value);
      val.textContent = v.toFixed(2);
      saveSetting(def.key, v);
    };
    row.append(lab, input, val);
    tune.appendChild(row);
    sliderEls[def.key] = { input, val };
  }
  const tuneBtns = document.createElement('div');
  Object.assign(tuneBtns.style, { display: 'flex', gap: '6px', marginTop: '6px' });
  function smallBtn(text, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    Object.assign(b.style, {
      flex: '1', fontSize: '12px', padding: '4px', borderRadius: '8px',
      border: '1px solid #ccc', background: '#fafafa', color: '#333', cursor: 'pointer',
    });
    b.onclick = onClick;
    return b;
  }
  tuneBtns.append(
    smallBtn('▶ 試し読み', () => speak('我が名はめぐみん！ふふん、あなたにはまだ早かったようですね。')),
    smallBtn('↺ 初期値', () => { GM_setValue(`settings_${speakerId}`, {}); refreshSliders(); }),
  );
  tune.appendChild(tuneBtns);

  function refreshSliders() {
    const cfg = getSettings();
    tuneTitle.textContent = `声の調整：${speakerShort}`;
    for (const def of SLIDERS) {
      sliderEls[def.key].input.value = cfg[def.key];
      sliderEls[def.key].val.textContent = Number(cfg[def.key]).toFixed(2);
    }
  }

  // --- キャラ一覧エリア ---
  const list = document.createElement('div');
  panel.append(tune, list);
  setPanelMessage('読み込み中…');

  const btn = document.createElement('button');
  Object.assign(btn.style, {
    padding: '6px 10px', borderRadius: '16px', border: 'none',
    color: '#fff', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
  });
  function setBadge(extra) {
    btn.textContent = `${speakerShort} ${enabled ? 'ON' : 'OFF'}${extra ? ' ' + extra : ''}`;
    btn.style.background = enabled ? '#c0392b' : '#777';
  }
  btn.title = 'クリック: ON/OFF切替（OFFにすると読み上げ中も止まる）';
  btn.onclick = () => {
    enabled = !enabled; GM_setValue('enabled', enabled);
    if (!enabled) stopSpeaking();
    setBadge();
  };

  let speakersLoaded = false;
  async function loadSpeakers() {
    try {
      const speakers = JSON.parse(await gmRequest('GET', `${ENGINE}/speakers`));
      const nodes = [];
      let count = 0;
      for (const sp of speakers) {
        // 歌唱専用スタイルだけ除外（それ以外は全部出す）
        const styles = sp.styles.filter((st) => !['sing', 'singing_teacher', 'frame_decode'].includes(st.type));
        if (!styles.length) continue;
        const h = document.createElement('div');
        h.textContent = sp.name;
        Object.assign(h.style, { padding: '6px 12px 2px', fontWeight: 'bold', color: '#888', fontSize: '11px' });
        nodes.push(h);
        for (const st of styles) {
          const item = document.createElement('div');
          item.textContent = `${shortName(sp.name)}（${st.name}）`;
          item.dataset.id = st.id;
          Object.assign(item.style, { padding: '4px 20px', cursor: 'pointer' });
          item.onmouseenter = () => { item.style.background = '#f3e0dd'; };
          item.onmouseleave = () => { item.style.background = item.dataset.id == speakerId ? '#fbeeed' : ''; };
          item.onclick = () => choose(st.id, shortName(sp.name));
          nodes.push(item);
          count++;
        }
      }
      list.replaceChildren(...nodes);
      await getSpeakerId();
      markCurrent();
      refreshSliders();
      speakersLoaded = true;
      LOG(`キャラ一覧を読み込みました（${speakers.length}キャラ／${count}スタイル）`, '例:', JSON.stringify(speakers[0] && speakers[0].styles[0]));
    } catch (e) {
      setPanelMessage('VOICEVOX未起動（起動してからもう一度開いてください）');
      LOG('キャラ一覧を取れません:', e.message);
    }
  }

  function markCurrent() {
    panel.querySelectorAll('[data-id]').forEach((it) => {
      const cur = it.dataset.id == speakerId;
      it.style.background = cur ? '#fbeeed' : '';
      it.style.fontWeight = cur ? 'bold' : '';
    });
  }

  async function choose(id, short) {
    speakerId = Number(id);
    speakerShort = short;
    GM_setValue('speakerId', speakerId);
    GM_setValue('speakerShort', speakerShort);
    markCurrent();
    refreshSliders();
    setBadge();
    stopSpeaking();
    try {
      await gmRequest('POST', `${ENGINE}/initialize_speaker?speaker=${speakerId}&skip_reinit=true`);
    } catch (e) { /* 試し読みで分かるので無視 */ }
    speak(`${speakerShort}の声でいきます。`);
  }

  sel.onclick = (e) => {
    e.stopPropagation();
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open) refreshSliders();
    if (open && !speakersLoaded) loadSpeakers();
  };
  // メニューの外をクリックしたら閉じる
  document.addEventListener('click', (e) => {
    if (panel.style.display !== 'none' && !panel.contains(e.target) && e.target !== sel) {
      panel.style.display = 'none';
    }
  });

  setBadge();
  box.append(sel, btn);
  document.body.appendChild(box);
  document.body.appendChild(panel);

  // Escキーでいま喋ってるのだけ止める
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') stopSpeaking(); });

  // 起動時にキャラ一覧を読み込み、選択中の声を先に起こしておく（初回の待ちを減らす）
  loadSpeakers()
    .then(() => getSpeakerId())
    .then((id) => gmRequest('POST', `${ENGINE}/initialize_speaker?speaker=${id}&skip_reinit=true`))
    .then(() => LOG('声の準備完了'))
    .catch((e) => LOG('準備できず（VOICEVOX起動後に再読み込みしてください）:', e.message));

  LOG('起動しました');
})();
