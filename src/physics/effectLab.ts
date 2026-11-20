/**
 * 膨らんだ瞬間のエフェクトの出し方を試すための設定(実験用のテストページ、?fxlab)。DOM に依存しない。
 * mode: push = 今の方式(揺らし方が押し出す時刻から受け付ける。膨らむ揺らし方だけ)、
 *       forward = 揺らし方を問わず、揺れの結果の「手前への膨らみ」だけで決める(手で揺らしたときも出る)
 * forward の決め方(effect.ts の stepForward):
 *   膨らみの量 I(手前へのずれ / ポップ量 + 広がり)が増え始めてから減り始めるまでを1回の「突き出し」とみなし、1回につき1度だけ決める。
 *   burst: 傾き(I/秒)が、下限と「前の突き出しの一番の傾き × rebound」の両方を越えた瞬間に出す(減衰中の揺れ返しは前より弱いので出ない)。
 *   peak: 一番膨らんだ所で、量が下限と「前に出したときの量 × rebound」の両方を越えたら出す。
 *   前の強さは decay 秒ごとに 1/e へ薄れる。
 */
export interface EffectLab {
  mode: 'push' | 'forward';
  /** burst の下限: 膨らみの量の傾き(I/秒) */
  vmin: number;
  /** peak の下限: 一番膨らんだときの量(I) */
  amin: number;
  /** 前の突き出し(peak は前に出したとき)の強さに対する割合。これを越えないと出さない */
  rebound: number;
  /** 前に出した強さが薄れる時間(秒) */
  decay: number;
  /** 記録を取るか(グラフ用) */
  trace: boolean;
}

export const effectLab: EffectLab = { mode: 'push', vmin: 1.2, amin: 0.12, rebound: 1, decay: 4, trace: false };

/** グラフ用の記録(レイヤーごと) */
/** S と ref は突き出しの強さを測った刻みだけ(そのときの強さと、跳ね返りとみなす境目 = 前の強さ × 割合) */
export interface LabSample { t: number; I: number; v: number; fire: boolean; S?: number; ref?: number }
export const labTrace = new Map<string, LabSample[]>();
export const LAB_KEEP = 4;
