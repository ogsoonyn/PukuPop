/**
 * メモリの使用量の見積もり(ステータスバーに出す)。
 * ブラウザからはページが実際に使うメモリを正確には測れないので、アプリが抱えているデータの量を数える。
 * 小さなもの(レイヤーの設定・操作の記録など)は数えない。
 */
import type { Project } from './project';

/** 1つのタブの見積もり(バイト) */
export interface TabMemory {
  name: string;
  active: boolean;
  /** 読み込んだ画像のファイル・ウェイト・自動保存用のウェイト PNG */
  data: number;
  /** アンドゥの積み */
  history: number;
  /** 表示用にデコードした画像と、GPU へ送ったもの(表のタブだけ) */
  render: number;
}

export interface MemoryUsage {
  tabs: TabMemory[];
  data: number;
  history: number;
  render: number;
  total: number;
  /** JS のヒープ(Chrome 系のみ。ほかのブラウザでは null) */
  heap: { used: number; limit: number } | null;
}

/** プロジェクトが持つデータ(画像のファイルとウェイト)。pngBytes は自動保存用に取っておいた PNG の合計 */
export function projectDataBytes(project: Project, pngBytes = 0): number {
  let n = pngBytes;
  for (const d of project.documents) {
    n += d.image.bytes.byteLength;
    for (const l of d.layers) n += l.weights.data.byteLength;
  }
  return n;
}

export function sumMemory(tabs: TabMemory[], heap: MemoryUsage['heap']): MemoryUsage {
  const sum = (k: 'data' | 'history' | 'render') => tabs.reduce((a, t) => a + t[k], 0);
  const data = sum('data'), history = sum('history'), render = sum('render');
  return { tabs, data, history, render, total: data + history + render, heap };
}

/** 1.2GB / 320MB / 4.5MB / 800KB のように短く書く */
export function formatBytes(n: number): string {
  const MB = 1024 * 1024, GB = MB * 1024;
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)}GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)}MB`;
  return `${Math.max(0, Math.round(n / 1024))}KB`;
}
