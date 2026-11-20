/**
 * 膨らんだ瞬間のエフェクトの出し方を試すための設定(実験用のテストページ、?fxlab)。DOM に依存しない。
 * mode: push = 今の方式(揺らし方が押し出す時刻から受け付ける。膨らむ揺らし方だけ)、
 *       forward = 揺らし方を問わず、揺れの結果の「手前への膨らみ」だけで決める(手で揺らしたときも出る)
 * forward の決め方:
 *   膨らみの量 I(手前へのずれ / ポップ量 + 広がり)が増え始めてから減り始めるまでを1回の「突き出し」とみなし、
 *   1回の突き出しにつき1回だけ出す。burst は膨らむ速さが一番速い所、peak は一番膨らんだ所。
 *   強さ(burst は速さ、peak はそのときの膨らみの量)が下限を越え、さらに前に出したときの強さ × 跳ね返りの割合
 *   (前に出してからの時間で decay 秒ごとに 1/e へ薄れる)を越えたときだけ出す。バネの跳ね返りは前より小さいので出ない。
 */
export interface EffectLab {
  mode: 'push' | 'forward';
  /** burst の下限: 膨らむ速さ(I/秒) */
  vmin: number;
  /** peak の下限: 一番膨らんだときの量(I) */
  amin: number;
  /** 跳ね返りとみなす割合(前に出した強さに対して) */
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
