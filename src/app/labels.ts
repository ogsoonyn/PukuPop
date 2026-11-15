/** 履歴とアンドゥのメニューに出す、操作の名前の作り方 */

/** 複数のレイヤーにまとめてかけた操作の名前(履歴とアンドゥのメニューに出す) */
export function countLabel(label: string, n: number): string { return n > 1 ? `${label}(${n}枚)` : label; }
