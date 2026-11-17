/**
 * 再生・記録の進み具合のバー。主ビューの下に重ねて出す(3面図が出ているときはその左まで)。
 *
 * - 再生中: 停止・一時停止・時間・トラック・ループの印・カメラを戻す。トラックを押す・ドラッグすると、その位置へ移る
 *   (ドラッグの間は一時停止してその瞬間を見せ、離すと元の状態で続ける)。キーフレームから作った動きなら、
 *   各フレームを通る時刻に番号を出す(形は枠表示と同じで、なめらかは丸、弾むはひし形)。番号を押すとその時刻へ移る。
 * - 止まっている間: キーフレームが2つ以上あり、キーフレームの部品が見えている(アニメーションタブを開いている)ときだけ、
 *   ▶・時間・番号を出す(一覧から求める)。▶ はキーフレームの「▶ 再生」と同じ(一覧が今の記録と同じなら作り直さない)。
 *   トラック・番号を押す(キーでは矢印・Home・PageUp など)と、その時刻で一時停止した状態から再生を始める
 *   (一覧が今の記録と違えば作り直す。元に戻せる)。「重ねて表示」の「シークバー」で出さないようにできる。
 *   今の記録が手で記録した操作のとき(キーフレームから作ったものでないとき)は、押すと入れ替わってしまうので出さない。
 * - 記録中: 赤いバーで最長(60 秒)までの進みを出す。■ で記録を止める。位置は動かせない。
 * - 書き出し中は出さない(画面の部品なので、書き出した絵には入らない)。
 */
import type { App } from '../app';
import { keyCurve, TAKE_MAX_SECONDS, TAKE_MIN_SECONDS, TAKE_STEP_MULTIPLE, type KeyCurve } from '../physics/take';
import { PHYSICS_DT } from '../physics/world';
import { prefs } from '../storage/prefs';
import { ui } from './ids';
import { icon } from './icons';
import { keySectionShown } from './keyPath';

const fmt = (v: number) => v.toFixed(1);
/** ボタンの印。⏸ などの文字は絵文字で出る環境があるので、塗りの SVG にする */
const svg = (d: string) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">${d}</svg>`;
const ICON_STOP = svg('<rect x="3" y="3" width="10" height="10" rx="1"/>');
const ICON_PAUSE = svg('<rect x="3.5" y="2.5" width="3" height="11" rx=".8"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8"/>');
const ICON_PLAY = svg('<path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z"/>');
/** ←・→ で動かす秒数(Shift で細かく) */
const STEP = 0.5, FINE_STEP = 0.1;
/** 番号を押したあと、これより動かすまでは番号の時刻のまま(px) */
const DRAG_SLOP = 6;
/** 止まっている間もバーを出すか(ブラウザに覚える) */
const PREF = 'playBarIdle';

/** 1周の秒数を、記録にしたときの長さにそろえる(刻み数を TAKE_STEP_MULTIPLE の倍数に丸める。takeFromKeys と同じ) */
const takeSecondsOf = (total: number) => Math.max(TAKE_STEP_MULTIPLE, Math.round(total / PHYSICS_DT / TAKE_STEP_MULTIPLE) * TAKE_STEP_MULTIPLE) * PHYSICS_DT;

export function bindPlayBar(app: App): void {
  const { playBar: bar, playSrc: srcEl, playStart: start, playStop: stop, playPause: pause, playTime: time, playTrack: track, playKeys: keys, playLoop: loop, playCam: cam, playBarShow: toggle } = ui;
  const fill = track.querySelector<HTMLElement>('.play-fill')!, head = track.querySelector<HTMLElement>('.play-head')!;
  cam.querySelector('.play-cam-icon')!.innerHTML = icon('keySet');
  stop.innerHTML = ICON_STOP;
  start.innerHTML = ICON_PLAY;

  toggle.checked = prefs.get<boolean>(PREF) ?? true;
  toggle.addEventListener('change', () => { prefs.set(PREF, toggle.checked); refresh(); });

  /**
   * 一覧のキーフレームの曲線(2つ以上で、1周が短すぎないとき)。一覧が変わったときだけ求め直す。
   * バーが使うのは時刻(total・starts)だけで、画角によらないので、画角はキャッシュの鍵に入れない
   */
  let draftSig = '', draft: KeyCurve | null = null;
  function draftCurve(): KeyCurve | null {
    const sig = JSON.stringify(app.keyDraft);
    if (sig !== draftSig) {
      draftSig = sig;
      const c = keyCurve(app.keyDraft, app.project.camera.fov);
      draft = c && c.total >= TAKE_MIN_SECONDS - 1e-9 ? c : null;
    }
    return draft;
  }
  /** 止まっている間に出すか */
  const idleShown = () => {
    const take = app.project.take;
    if (!toggle.checked || !app.doc || app.exporting || (take && !take.keys)) return false;
    return !!draftCurve() && keySectionShown();
  };

  /**
   * 止まっているときに再生を始める。一覧が今の記録と同じならそのまま再生し、違えば作り直す(右パネルの「再生」と同じ)。
   * 始められたら true
   */
  function begin(): boolean {
    if (app.takeState === 'playing') return true;
    if (app.takeState !== 'idle' || !app.doc || app.exporting) return false;
    app.playKeys();
    return (app.takeState as string) === 'playing';
  }

  // 停止は記録中にも使う(記録を止める)ので、再生だけに効くコマンド(stopPlay)にはせず、ここで分ける。
  // 一時停止はコマンド(togglePlayPause、data-cmd)で、押したときの処理・キー・ツールチップは ui/actions.ts
  stop.addEventListener('click', () => { if (app.takeState === 'recording') app.stopRecording(); else app.stopTake(); });
  start.addEventListener('click', () => { if (begin()) pause.focus({ preventScroll: true }); });

  /** 1周の長さ(秒)。止まっている間は一覧から求めた長さ */
  const length = () => {
    if (app.takeState !== 'idle') return app.takeLength;
    const c = draftCurve();
    return c ? takeSecondsOf(c.total) : 0;
  };

  /* ---------- トラック: 押す・ドラッグで位置を移す ---------- */
  /** onKey: 番号を押して、まだ動かしていない(少しの揺れでは番号の時刻から離さない) */
  let drag: { id: number; wasPaused: boolean; x: number; onKey: boolean } | null = null;
  /** トラックの上の位置(1周に対する割合 0〜1) */
  const fracAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
  };
  const seekFrac = (f: number) => app.seekTake(Math.min(f * app.takeLength, app.takeLength - PHYSICS_DT));
  track.addEventListener('pointerdown', e => {
    if (drag || e.button !== 0 || app.takeState === 'recording') return;
    // 止まっているときは、その時刻で一時停止した状態から再生を始める(離しても一時停止のまま)
    const idle = app.takeState === 'idle';
    // 番号を押したときは、その番号の時刻ちょうどへ(始めると番号を作り直すので、先に読んでおく)
    const k = (e.target as HTMLElement).closest<HTMLElement>('.play-key'), f = k ? +k.dataset.f! : fracAt(e.clientX);
    if (idle && (bar.hidden || !begin())) return;
    e.preventDefault();
    track.focus({ preventScroll: true });
    track.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, wasPaused: idle || app.playPaused, x: e.clientX, onKey: !!k };
    app.setPlayPaused(true);
    seekFrac(f);
    refresh();
  });
  track.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.onKey && Math.abs(e.clientX - drag.x) < DRAG_SLOP) return;
    drag.onKey = false;
    seekFrac(fracAt(e.clientX));
    refresh();
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag.wasPaused;
    drag = null;
    app.setPlayPaused(was);
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('lostpointercapture', end);
  track.addEventListener('keydown', e => {
    // 修飾キー付き(Shift+Home のカメラを戻すなど)はショートカットに渡す。Shift は矢印の細かい刻みにだけ使う
    if (app.takeState === 'recording' || bar.hidden || e.ctrlKey || e.altKey || e.metaKey) return;
    const arrow = e.key.startsWith('Arrow');
    if (e.shiftKey && !arrow) return;
    if (!arrow && !['Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) return;
    // 止まっているときは、0秒で一時停止した状態から始めて動かす
    if (app.takeState === 'idle') {
      e.preventDefault(); e.stopPropagation();
      if (!begin()) return;
      app.setPlayPaused(true);
    }
    const len = length(), pos = app.takePosition, step = e.shiftKey ? FINE_STEP : STEP;
    // PageUp・PageDown は前・次のキーフレームの番号の時刻へ
    const marks = [...keys.querySelectorAll<HTMLElement>('.play-key')].map(k => +k.dataset.f! * len);
    let to: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = Math.max(0, pos - step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = Math.min(len - PHYSICS_DT, pos + step);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = len - PHYSICS_DT;
    else if (e.key === 'PageDown' && marks.length) to = marks.find(t => t > pos + 1e-6) ?? marks[0];
    else if (e.key === 'PageUp' && marks.length) to = [...marks].reverse().find(t => t < pos - 1e-6) ?? marks.at(-1)!;
    if (to === null) return;
    // 視点のリセット(Home)などのショートカットに渡さない
    e.preventDefault(); e.stopPropagation();
    app.seekTake(to);
    refresh();
  });

  /* ---------- キーフレームの番号 ---------- */
  let keysOf: KeyCurve | null | undefined;
  function buildKeys(curve: KeyCurve | null): void {
    if (curve === keysOf) return;
    keysOf = curve;
    keys.replaceChildren(...(curve ? curve.starts.map((t, i) => {
      // 記録は1周の刻み数をそろえるため少し伸び縮みしているので、時刻は1周に対する割合で置く
      const s = document.createElement('span'), f = t / curve.total;
      s.className = 'play-key';
      s.dataset.mode = curve.keys[i].mode;
      s.dataset.f = String(f);
      s.style.left = `${f * 100}%`;
      s.textContent = String(i + 1);
      s.title = `${i + 1} 番のフレーム(${curve.keys[i].mode === 'bounce' ? '弾む' : 'なめらか'})へ移る`;
      return s;
    }) : []));
  }
  /** 再生中の記録がキーフレームから作ったものなら、その曲線(記録が変わったときだけ求め直す) */
  let takeOf: unknown = undefined, takeKeys: KeyCurve | null = null;
  function takeCurve(): KeyCurve | null {
    const take = app.project.take;
    if (take !== takeOf) { takeOf = take; takeKeys = take?.keys ? keyCurve(take.keys, app.project.camera.fov) : null; }
    return takeKeys;
  }

  /* ---------- 表示 ---------- */
  // 描画のたびに呼ぶので、変わったときだけ書く
  const setText = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };
  const setAttr = (el: Element, name: string, v: string) => { if (el.getAttribute(name) !== v) el.setAttribute(name, v); };
  const setHidden = (el: HTMLElement, v: boolean) => { if (el.hidden !== v) el.hidden = v; };
  function refresh(): void {
    const s = app.takeState, idle = s === 'idle', show = idle ? idleShown() : !app.exporting;
    if (bar.hidden === show) {
      // 隠すときにバーの中にフォーカスがあれば、3Dビューへ移す(居場所が分からなくならないように)
      if (!show && bar.contains(document.activeElement)) ui.view.focus({ preventScroll: true });
      bar.hidden = !show;
    }
    if (!show) return;
    const rec = s === 'recording', len = rec ? TAKE_MAX_SECONDS : length(), pos = rec ? app.takeLength : app.takePosition;
    if (bar.classList.contains('recording') !== rec) bar.classList.toggle('recording', rec);
    if (bar.classList.contains('idle') !== idle) bar.classList.toggle('idle', idle);
    const focusedOff = idle && [stop, pause, cam].includes(document.activeElement as HTMLButtonElement);
    setHidden(start, !idle);
    setHidden(stop, idle);
    setHidden(pause, rec || idle);
    setHidden(loop, rec);
    // 止めて ■・⏸ が消えるときにフォーカスがあれば、▶ へ移す
    setHidden(cam, rec || idle);
    if (focusedOff) start.focus({ preventScroll: true });
    setAttr(stop, 'aria-label', rec ? '記録を止める' : '停止');
    setAttr(stop, 'title', rec ? '記録を止める (R)' : '再生を止める (L)');
    const paused = !rec && app.playPaused;
    if (pause.dataset.icon !== String(paused)) { pause.dataset.icon = String(paused); pause.innerHTML = paused ? ICON_PLAY : ICON_PAUSE; }
    // 名前は「一時停止」のまま、押されているかで状態を伝える
    setAttr(pause, 'aria-pressed', String(paused));
    // 今の動きの作り方の印(止まっている間はキーフレームの一覧から出すときだけなので、いつもキーフレーム)
    const src = rec ? 'rec' : idle || app.project.take?.keys ? 'key' : 'rec';
    if (srcEl.dataset.src !== src) {
      srcEl.dataset.src = src;
      srcEl.querySelector('.play-src-mark')!.textContent = src === 'key' ? '◆' : '●';
      srcEl.querySelector('.play-src-name')!.textContent = src === 'key' ? 'キーフレーム' : '記録';
      srcEl.title = src === 'key' ? 'キーフレームで作った動き' : '記録した操作';
    }
    setText(time, `${fmt(pos)} / ${fmt(len)}秒`);
    const p = len > 0 ? Math.min(1, pos / len) : 0;
    fill.style.width = `${p * 100}%`;
    head.style.left = `${p * 100}%`;
    setHidden(head, rec || idle); // 止まっている間は0秒の1番の番号に重なるので出さない
    setAttr(track, 'aria-valuemax', fmt(len));
    // 読み上げの値は、進んでいる間は1秒ごとにだけ変える(しゃべり続けないように)
    const spoken = rec || (!idle && !paused) ? Math.floor(pos).toFixed(0) : fmt(pos);
    if (track.getAttribute('aria-valuenow') !== spoken) {
      track.setAttribute('aria-valuenow', spoken);
      track.setAttribute('aria-valuetext', `${spoken}秒 / ${fmt(len)}秒`);
    }
    setAttr(track, 'aria-disabled', String(rec));
    if (track.tabIndex !== (rec ? -1 : 0)) track.tabIndex = rec ? -1 : 0;
    buildKeys(rec ? null : idle ? draftCurve() : takeCurve());
  }

  app.on('take', refresh);
  app.on('status', refresh);
  app.on('file', refresh);
  app.store.on('replace', refresh);
  app.store.on('project', ({ keys: k }) => { if (k.includes('take')) refresh(); });
  // 進み具合は描画のたびに追う。止まっている間は、タブの切り替え(キーフレームの部品が見えているか)と一覧の変化を少し間引いて追う
  let lastIdle = 0;
  app.on('frame', () => {
    if (app.takeState === 'idle') {
      const now = performance.now();
      if (now - lastIdle < 100) return;
      lastIdle = now;
    }
    refresh();
  });
  refresh();
}
