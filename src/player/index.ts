/**
 * 埋め込み用の再生専用の部品(Player、Issue #127)の入口。あとでライブラリとして出すときも、ここを入口にする。
 * ここから辿れるコードは、編集アプリの部品(App・src/app・アンドゥ・書き出し・src/ui の画面の部品・CSS・保存領域)を引き込まない。
 * 確認用のページのための inspect(player.ts)は、ここからは出さない。
 */
export { createPlayer, PlayerError } from './player';
export type { Player, PlayerOptions, PlayerInfo, PlayerFavorite, PlayerInteraction, PlayerErrorCode } from './player';
