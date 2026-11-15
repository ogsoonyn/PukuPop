/**
 * Player の確認用のページ(player.html)。開発用のサーバーでだけ開き、本番のビルドには入らない。
 * サンプルのプロジェクトをその場で作って直列化し(編集アプリと同じ serializeProject)、Player に渡す。
 * Player は埋め込み先と同じく、使うときに import() で読む(読み込んだだけで window などに触らないかを確かめられるように)。
 * ?preserve を付けると、WebGL の描画を読み出せるよう preserveDrawingBuffer を入れる(E2E で画素を比べるため。Player は関わらない)。
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { createProject, type CameraState } from '../model/project';
import { createSampleDocument } from '../ui/sample';
import { serializeProject } from '../storage/popstage';
import { takeFromKeys } from '../physics/take';
import { captureFavorite } from '../model/favorites';

if (new URLSearchParams(location.search).has('preserve')) {
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

const demo = {
  load: () => import('./index'),
  sample,
  withFormatVersion,
  withBrokenImage,
  canvas: () => document.getElementById('c') as HTMLCanvasElement,
};
(window as unknown as { playerDemo: typeof demo }).playerDemo = demo;
