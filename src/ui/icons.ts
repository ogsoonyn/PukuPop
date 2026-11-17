/**
 * 線のアイコン(24×24、線の色は文字の色)。PC の左のツールバーとスマホの下のバーで同じものを使う。
 * 値は <svg> の中身だけを持ち、icon() で <svg> に包む。
 */
export const ICONS = {
  brush: '<path d="M18 3 9.5 11.5"/><path d="M7 13c-2 0-3 1.5-3 3.5S3 20 3 20s3 .5 5-1 2-4 2-4"/><path d="m9 11 4 4"/><path d="M13 15 21 7l-4-4-8 8"/>',
  erase: '<path d="m7 21-4-4 10-10 7 7-7 7z"/><path d="M8 10l6 6"/><path d="M14 21h7"/>',
  smooth: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="2 3"/>',
  inflate: '<path d="M3 18h18"/><path d="M5 18c0-6 3-10 7-10s7 4 7 10"/>',
  grab: '<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6"/><path d="M11 10V4a1.5 1.5 0 0 1 3 0v6"/><path d="M14 10V5.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 4 16l-1-3a1.5 1.5 0 0 1 2.6-1.4L8 14"/>',
  shake: '<path d="M4 8c2-2 4-2 6 0s4 2 6 0 3-2 4-1"/><path d="M4 14c2-2 4-2 6 0s4 2 6 0 3-2 4-1"/>',
  view: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  pan: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  // その場で効く操作
  // 開く(フォルダ)・保存(下向きの矢印)・書き出し(箱から出る矢印)
  open: '<path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.5H12L10 5H4.5A1.5 1.5 0 0 0 3 6.5z"/>',
  save: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 16v3.5h16V16"/>',
  export: '<path d="M12 15V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M8 11H5v9h14v-9h-3"/>',
  // 最近開いたファイル(時計)
  recent: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  multi: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16M3 12h18"/>',
  overlay: '<path d="m12 4 9 4.5-9 4.5-9-4.5z"/><path d="m3 12.5 9 4.5 9-4.5"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  fade: '<rect x="3" y="4" width="18" height="16" rx="1.5" stroke-dasharray="3 2.5"/><path d="m6 17 4-5 3 3 2-2 3 4"/>',
  grid: '<path d="M4 9h16M4 15h16M9 4v16M15 4v16"/>',
  // 背景を透過(市松模様)
  transparent: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><path d="M3 3h6v6H3zM15 3h6v6h-6zM9 9h6v6H9zM3 15h6v6H3zM15 15h6v6h-6z" fill="currentColor" stroke="none" opacity=".45"/>',
  // 視点リセット: 正面を向いた四角(画像)と、戻る矢印
  resetView: '<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M3 12a9 9 0 0 1 15.5-6.2"/><path d="M19 2v4h-4"/>',
  // 回転だけリセット: 傾いた四角を戻す矢印(ズームは保つ)
  resetRotation: '<path d="M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4"/><path d="M20 12a8 8 0 0 1-14 5.3"/><path d="M6 21v-4h4"/><circle cx="12" cy="12" r="2"/>',
  cleanView: '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 15l.8 1.7L21.5 17.5l-1.7.8L19 20l-.8-1.7-1.7-.8 1.7-.8z"/>',
  smoothAll: '<path d="M3 8c3-2 6 2 9 0s6-2 9 0"/><path d="M3 13c3-2 6 2 9 0s6-2 9 0"/><path d="M3 18c3-2 6 2 9 0s6-2 9 0"/>',
  normalize: '<path d="M5 4h14"/><path d="M12 20V8"/><path d="m7 13 5-5 5 5"/>',
  invert: '<path d="M7 4v16"/><path d="m3 8 4-4 4 4"/><path d="M17 20V4"/><path d="m13 16 4 4 4-4"/>',
  // キーフレームを今の視点で上書きする(カメラ)
  keySet: '<path d="M4 8h3l1.5-2.5h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  // アニメーションの再生・停止
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  // キーフレームの経路: 2つの枠を結ぶ点線の矢印
  keyPath: '<rect x="3" y="14" width="6" height="6" rx="1"/><rect x="15" y="4" width="6" height="6" rx="1"/><path d="M8 13c1-4 3-6 6-7" stroke-dasharray="2 2.2"/><path d="m11.5 5 2.8 1-1.4 2.6"/>',
  // キーフレームのゴースト: ずれて重なった画像(後ろは点線)
  keyGhost: '<rect x="3" y="3" width="12" height="12" rx="1.5" stroke-dasharray="2.5 2"/><rect x="9" y="9" width="12" height="12" rx="1.5"/>',
  // 自動で揺らす(波)。スマホの上のバーの #mAuto と同じ形
  autoSwing: '<path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/>',
  // ポップを一時OFF(膨らみを点線にして、平らな線を引く)
  flat: '<path d="M3 18h18"/><path d="M5 18c0-6 3-10 7-10s7 4 7 10" stroke-dasharray="2.5 2.5"/>',
  // 揺れを一時停止(波と一時停止の印)
  pause: '<path d="M2 12c2-4 4-4 6 0s3 3 4 0"/><path d="M16 7v10"/><path d="M21 7v10"/>',
  // お気に入りに追加(星)
  favorite: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>',
  // お気に入りを今の状態で上書きする(下向きの矢印を受け皿へ)
  favSet: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  // 膨らませるパネルをたたむ・広げる
  panelShrink: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>',
  panelExpand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, className = ''): string {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
