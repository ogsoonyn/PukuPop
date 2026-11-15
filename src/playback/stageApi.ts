/**
 * 再生のつなぎ(src/playback)が使う、描画(Stage)のメソッドだけを並べたもの。
 * Stage の実物(three.js)を import しないので、DOM も three.js も無いところで単体テストできる。Stage はこの形をそのまま満たす。
 */
import type { CameraState, Vec3 } from '../model/project';

export interface PlaybackStage {
  /** レイヤー index の揺れ(元画像のピクセル)。visible が false なら揺らさない */
  setSwing(index: number, s: Vec3, visible: boolean): void;
  /** レイヤー index の塗った範囲の広がり(中心は画像のローカル座標) */
  setSpread(index: number, center: { x: number; y: number }, r: number, visible: boolean): void;
  /** 画像全体のずれ(ピストン、元画像のピクセル) */
  setBaseOffset(v: Vec3): void;
  /** 画像全体のずれの届く大きさ(元画像のピクセル) */
  setBaseReach(px: number): void;
  /** 記録の再生中に、視点が from から to へ動いて見えるのと同じだけ画像を動かす。null で外す */
  setRig(from: CameraState | null, to?: CameraState | null): void;
  /** 視点をカメラへ当てる(描画を待たずに当たり判定をその視点で行えるように) */
  applyCamera(cam: CameraState): void;
}
