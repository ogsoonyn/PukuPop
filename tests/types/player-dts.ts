/**
 * Player の手書きの型定義(packages/player/index.d.ts。ライブラリの .tgz に入る)が、実装(src/player)の型と食い違わないことを、
 * 型検査(npm run typecheck)で確かめる。食い違うと、下の Checks の行で型エラーになる。
 *
 * 比べ方(Same): 双方向に代入できる・キーの集まりが同じ・Required にしても双方向に代入できる・型として同一(Exact)。
 * extends だけでは、オプションのプロパティを片方に足し忘れても通ってしまうので、キーと同一性も見る。
 * Exact は any も見分けるので、d.ts の中の書き間違い(解決できない型が any になる)も見つける
 * (このリポジトリの型検査は skipLibCheck なので、d.ts の中のエラーそのものは scripts/player-check-pack.mjs が見る)。
 *
 * 入口が出す名前の一覧(型だけのものも含む)の一致は tests/unit/playerDts.test.ts が見る(型の上では型の名前を数えられないため)。
 * このファイルは型検査だけで使い、Vitest では流さない。
 */
import type * as Src from '../../src/player';
import type * as Dts from '../../packages/player/index';

type Exact<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Same<A, B> =
  Mutual<A, B> extends true
    ? Mutual<keyof A, keyof B> extends true
      ? Mutual<Required<A>, Required<B>> extends true
        ? Exact<A, B>
        : false
      : false
    : false;
type Assert<T extends true> = T;

type SrcModule = typeof Src;
type DtsModule = typeof Dts;

export type Checks = [
  // 値として出している名前(createPlayer・PlayerError)
  Assert<Same<keyof SrcModule, keyof DtsModule>>,
  Assert<Same<SrcModule['createPlayer'], DtsModule['createPlayer']>>,
  Assert<Same<Parameters<SrcModule['createPlayer']>, Parameters<DtsModule['createPlayer']>>>,
  Assert<Same<ReturnType<SrcModule['createPlayer']>, ReturnType<DtsModule['createPlayer']>>>,
  // PlayerError: コンストラクタ(引数)とインスタンス(code・name・message・cause)
  Assert<Same<SrcModule['PlayerError'], DtsModule['PlayerError']>>,
  Assert<Same<ConstructorParameters<SrcModule['PlayerError']>, ConstructorParameters<DtsModule['PlayerError']>>>,
  Assert<Same<Src.PlayerError, Dts.PlayerError>>,
  // 型
  Assert<Same<Src.Player, Dts.Player>>,
  Assert<Same<Src.PlayerOptions, Dts.PlayerOptions>>,
  Assert<Same<Src.PlayerInfo, Dts.PlayerInfo>>,
  Assert<Same<Src.PlayerFavorite, Dts.PlayerFavorite>>,
  Assert<Same<Src.PlayerInteraction, Dts.PlayerInteraction>>,
  Assert<Same<Src.PlayerErrorCode, Dts.PlayerErrorCode>>,
];

// 比べ方そのものの確かめ: 食い違いを見逃さない(ここが true になったら Same が甘くなっている)
interface WithOptional { a: number; b?: string }
interface WithoutOptional { a: number }
interface WithReadonly { readonly a: number }
interface WithoutReadonly { a: number }
export type SelfChecks = [
  Assert<Mutual<Same<WithOptional, WithoutOptional>, false>>,
  Assert<Mutual<Same<WithReadonly, WithoutReadonly>, false>>,
  Assert<Mutual<Same<'a' | 'b', 'a'>, false>>,
  Assert<Mutual<Same<{ a: unknown }, { a: any }>, false>>,
  Assert<Mutual<Same<(x?: number) => void, (x: number) => void>, false>>,
  Assert<Same<WithOptional, { a: number; b?: string }>>,
];
