/**
 * Player の確認用のページ(player.html)。開発用のサーバーでだけ開き、本番のビルドには入らない。
 * サンプルのプロジェクトをその場で作って直列化し(編集アプリと同じ serializeProject)、Player に渡す。
 * Player は埋め込み先と同じく、使うときに import() で読む(読み込んだだけで window などに触らないかを確かめられるように)。
 *
 * 開くとサンプルを読み込んで再生し、ボタンで再生・停止、お気に入り、作り直し、操作の切り替え、手持ちのファイルの読み込みを試せる。
 * 作り直しは dispose() のあと新しい <canvas> に差し替える(キャンバスは使い回さない、の手本)。
 * ?e2e を付けると自動では読み込まず、ドロップの受け口も付けない(E2E は window.playerDemo で自分で作る)。
 * ?preserve を付けると、WebGL の描画を読み出せるよう preserveDrawingBuffer を入れる(E2E で画素を比べるため。Player は関わらない)。
 * ?dist を付けると、ソース(./index)ではなく、ライブラリとしてビルドした1本(/dist-player/pukupop-player.js。npm run build:player で作る)を読む
 * (tests/e2e/playerDist.spec.ts)。そのときは中身を覗く口(inspect)は使えない。
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { createProject, type CameraState } from '../model/project';
import { createSampleDocument } from '../ui/sample';
import { serializeProject } from '../storage/popstage';
import { takeFromKeys } from '../physics/take';
import { captureFavorite } from '../model/favorites';
import type { Player, PlayerInteraction } from './index';

const params = new URLSearchParams(location.search);

if (params.has('preserve')) {
  const get = HTMLCanvasElement.prototype.getContext as (this: HTMLCanvasElement, type: string, attrs?: object) => RenderingContext | null;
  (HTMLCanvasElement.prototype as unknown as { getContext: typeof get }).getContext = function (type, attrs) {
    return get.call(this, type, type === 'webgl2' || type === 'webgl' ? { ...attrs, preserveDrawingBuffer: true } : attrs);
  };
}

export interface SampleOptions {
  /** 自動で揺らす(既定 true) */
  autoSwing?: boolean;
  /** 視点を左右に振る記録を入れる */
  take?: boolean;
  /** お気に入りを2つ入れる: 「大きく」(ポップ量を上げ、記録を再生していた)と「静か」(自動揺らしを切り、記録無し、視点を右へ回す) */
  favorites?: boolean;
  /** 背景色(省くと透過) */
  background?: string | null;
}

const view = (yaw: number): Omit<CameraState, 'fov'> => ({ yaw, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } });

async function sample(o: SampleOptions = {}): Promise<Uint8Array> {
  const doc = await createSampleDocument(), p = createProject(doc);
  p.background = o.background ?? null;
  p.autoSwing = { ...p.autoSwing, enabled: o.autoSwing ?? true, strength: 1 };
  const take = takeFromKeys([{ view: view(-0.5), seconds: 1, mode: 'smooth' }, { view: view(0.5), seconds: 1, mode: 'smooth' }], p.camera.fov);
  if (o.take) p.take = take;
  if (o.favorites) {
    const keep = { pop: doc.layers[0].pop, auto: p.autoSwing, take: p.take, camera: p.camera };
    doc.layers[0].pop = 600;
    p.autoSwing = { enabled: true, period: 0.8, strength: 1 };
    p.take = take;
    const big = captureFavorite(p, doc, { name: '大きく', playing: true });
    doc.layers[0].pop = keep.pop;
    p.autoSwing = { ...keep.auto, enabled: false };
    p.take = null;
    p.camera = { ...keep.camera, yaw: 0.7 };
    const calm = captureFavorite(p, doc, { name: '静か', playing: false });
    p.autoSwing = keep.auto; p.take = keep.take; p.camera = keep.camera;
    p.favorites = [big, calm];
  }
  return serializeProject(p);
}

/** project.json の formatVersion を書き換えたファイル(新しい版のファイルの確かめ用) */
function withFormatVersion(bytes: Uint8Array, v: number): Uint8Array {
  const files = unzipSync(bytes), json = JSON.parse(strFromU8(files['project.json']));
  json.formatVersion = v;
  files['project.json'] = strToU8(JSON.stringify(json));
  return zipSync(files);
}

/** 画像のファイルを壊したファイル(デコードに失敗する所の確かめ用。読み込みは通り、描画を作ってから失敗する) */
function withBrokenImage(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes), json = JSON.parse(strFromU8(files['project.json']));
  const path = json.documents[0].image.path as string;
  files[path] = files[path].slice(0, 64);
  return zipSync(files);
}

type PlayerModule = typeof import('./index');
let inspectFn: ((p: Player) => unknown) | null = null;

/** ライブラリとしてビルドした1本(?dist のときに読む) */
const DIST_URL = '/dist-player/pukupop-player.js';

/** Player の入口を読む。中身を覗く口(player.ts の inspect。入口からは出さない)も一緒に読んでおく。?dist ならビルドした1本を読む */
async function load(): Promise<PlayerModule> {
  if (params.has('dist')) return (await import(/* @vite-ignore */ DIST_URL)) as PlayerModule;
  const [m, internal] = await Promise.all([import('./index'), import('./player')]);
  inspectFn = internal.inspect;
  return m;
}

const demo = {
  load,
  sample,
  withFormatVersion,
  withBrokenImage,
  canvas: () => document.getElementById('c') as HTMLCanvasElement,
  /** Player の中身(描画・物理・プロジェクト・ループ再生)。E2E が確かめるためだけに使う。load() のあとで呼ぶ */
  inspect: (p: Player) => inspectFn?.(p),
};
(window as unknown as { playerDemo: typeof demo }).playerDemo = demo;

if (params.has('e2e')) {
  // ただのホイールでページがスクロールできるかを確かめるための余白
  const pad = document.createElement('div');
  pad.style.height = '3000px';
  document.body.append(pad);
} else void interactive();

/** 人が開いて触る確認用の画面 */
async function interactive(): Promise<void> {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const playBtn = $<HTMLButtonElement>('play'), favBox = $('favorites'), state = $('state'), error = $('error');
  const interactionSel = $<HTMLSelectElement>('interaction'), file = $<HTMLInputElement>('file'), box = $('box');
  const m = await load();
  let bytes: Uint8Array = await sample({ autoSwing: true, take: true, favorites: true });
  let player: Player | null = null;
  let loading: AbortController | null = null;
  let favorite: string | null = null;

  const show = () => {
    playBtn.disabled = !player;
    playBtn.textContent = player?.playing ? '停止' : '再生';
    favBox.replaceChildren(...(player?.info.favorites ?? []).map(f => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = f.name;
      b.setAttribute('aria-pressed', String(f.id === favorite));
      b.onclick = () => { if (player?.setFavorite(f.id)) { favorite = f.id; show(); } };
      return b;
    }));
    const i = player?.info;
    state.textContent = i
      ? `${i.width}×${i.height} / 記録 ${i.takeSeconds.toFixed(1)} 秒 / お気に入り ${i.favorites.length} / playing: ${player!.playing}`
      : '読み込み中…';
  };

  /** 今の Player を捨て、新しい <canvas> に作り直す(dispose したキャンバスは使えないので、差し替える) */
  const rebuild = async () => {
    loading?.abort();
    player?.dispose();
    player = null; favorite = null;
    const canvas = document.createElement('canvas');
    canvas.id = 'c';
    box.replaceChildren(canvas);
    const ac = loading = new AbortController();
    error.textContent = '';
    show();
    try {
      player = await m.createPlayer(canvas, bytes, { interaction: interactionSel.value as PlayerInteraction, signal: ac.signal });
    } catch (e) {
      if (e instanceof m.PlayerError && e.code === 'aborted') return; // 次の作り直しに追い越された
      error.textContent = e instanceof m.PlayerError ? `${e.code}: ${e.message}` : String(e);
    } finally {
      if (loading === ac) loading = null;
    }
    show();
  };

  const open = async (f: File) => {
    bytes = new Uint8Array(await f.arrayBuffer());
    await rebuild();
  };

  playBtn.onclick = () => {
    if (!player) return;
    if (player.playing) player.pause(); else player.play();
    show();
  };
  $<HTMLButtonElement>('rebuild').onclick = () => void rebuild();
  interactionSel.onchange = () => void rebuild();
  file.onchange = () => { const f = file.files?.[0]; if (f) void open(f); };
  // ドロップの受け口はこのページのもの(Player 本体の「キャンバスの外に触らない」約束とは別)
  document.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drop'); });
  document.addEventListener('dragleave', () => box.classList.remove('drop'));
  document.addEventListener('drop', e => {
    e.preventDefault();
    box.classList.remove('drop');
    const f = e.dataTransfer?.files[0];
    if (f) void open(f);
  });
  await rebuild();
}
