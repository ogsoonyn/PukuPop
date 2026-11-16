/**
 * 1フレームの物理の組み立てのうち、編集アプリ(App)と再生専用の部品(Player、src/player)で同じになる所。
 * App は、ここの関数の間に編集アプリだけの処理(「揺らす」ツールの量・操作の記録・計測・溜めたウェイトの転送など)を
 * 今までどおりの順番で差し込む。1フレームを丸ごと1つの関数にすると App の都合がここへ漏れるので、小さい単位にとどめている。
 *
 * 1フレームの並び(App.frame と Player で同じ):
 *   advanceSwing(物理を進め、刻みごとに LoopPlayback.step か feedView で入力を入れる → 揺れを Stage へ)
 *   → (App だけ: ウェイトの転送) → LoopPlayback.applyRig → Stage.render
 */
import type { AutoSwing, CameraState, Document, Layer, Vec3 } from '../model/project';
import type { PhysicsWorld } from '../physics/world';
import type { StageSwing } from './stageSwing';

/**
 * 物理の準備。画像を差し替えたら呼ぶ。正規化座標の 1 が何ピクセルか(画像の長辺 / 2)と、レイヤーの重心の求め方
 * (StageSwing.centerOf)を物理へ渡す
 */
export function preparePhysics(world: PhysicsWorld, doc: Document, centerOf: (l: Layer) => { x: number; y: number }): void {
  world.unitPx = Math.max(doc.image.width, doc.image.height) / 2;
  world.centerOf = centerOf;
}

/**
 * 再生していないときに、今の視点を物理へ入れる(刻みごとに呼ぶ)。平行移動・回転・ズームの勢いで揺れる。
 * offset は注視点に足す量で、編集アプリの「揺らす」ツールで振った分(カメラを画像に付けたまま振る)
 */
export function feedView(world: PhysicsWorld, cam: CameraState, offset?: Vec3): void {
  const s = offset ?? ZERO;
  world.viewTarget = { x: cam.target.x + s.x, y: cam.target.y + s.y, z: cam.target.z + s.z };
  world.viewAngles = { yaw: cam.yaw, pitch: cam.pitch, roll: cam.roll, zoom: cam.zoom };
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * 物理を dt 秒進め、揺れを Stage へ当てる(画像全体のずれもならして入れる)。
 * beforeStep は刻みごとの入力(ループ再生中は LoopPlayback.step、そうでなければ feedView など)。
 * 自動揺らしの設定は、毎フレーム今のプロジェクトのものを物理へ渡す(切り替え・お気に入りの適用をすぐ効かせる)
 */
export function advanceSwing(dt: number, world: PhysicsWorld, swing: StageSwing, autoSwing: AutoSwing, doc: Document, beforeStep: () => void): void {
  world.autoSwing = autoSwing;
  world.advance(dt, doc.layers, beforeStep);
  swing.applySwing(world, doc);
  swing.showBase(dt, world, doc); // ライブ表示の画像全体のずれ(applySwing の後)
}
