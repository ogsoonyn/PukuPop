/**
 * スマホで、膨らませるのプレビュー中に範囲を描き直すかどうか(パネルの「描き直す」、ui/mobile.ts)。
 * スマホでは描いたあとに枠の外を触ると視点が回るので、描き直すときだけこれを入れてから描く(ui/input.ts)。
 * プレビューの途中だけの一時的な状態なので、モデルにも App にも置かない
 */
let armed = false;
const subs = new Set<(on: boolean) => void>();

export function isRedrawArmed(): boolean { return armed; }
export function setRedrawArmed(on: boolean): void {
  if (armed === on) return;
  armed = on;
  for (const f of subs) f(on);
}
export function onRedrawArmed(f: (on: boolean) => void): void { subs.add(f); }
