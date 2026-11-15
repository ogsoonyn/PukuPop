/** 新しい画像を開くときの既定(編集アプリだけの機能)。ブラウザに覚えた値(prefs の newImage。main.ts で覚える)を確かめて使う */
import { LIMITS, type Project } from '../model/project';

/**
 * 新しい画像に使う背景・自動揺らし・画角。saved(ブラウザに覚えた値)にあれば、それを使う。
 * 無い・おかしい値の項目は、今の作業(prev)の値を引き継ぐ
 */
export function newImageDefaults(prev: Project, saved: Record<string, unknown> | null | undefined): Pick<Project, 'background' | 'autoSwing'> & { fov: number } {
  const d = saved ?? {};
  const num = (v: unknown, lim: { min: number; max: number }, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lim.min, Math.min(lim.max, v)) : def);
  const a = (d.autoSwing && typeof d.autoSwing === 'object' ? d.autoSwing : {}) as Record<string, unknown>;
  const bg = d.background === null || (typeof d.background === 'string' && /^#[0-9a-f]{6}$/i.test(d.background)) ? d.background as string | null : prev.background;
  return {
    background: 'background' in d ? bg : prev.background,
    autoSwing: {
      enabled: typeof a.enabled === 'boolean' ? a.enabled : prev.autoSwing.enabled,
      period: num(a.period, LIMITS.period, prev.autoSwing.period),
      strength: num(a.strength, { min: 0, max: 1 }, prev.autoSwing.strength),
    },
    fov: num(d.fov, LIMITS.fov, prev.camera.fov),
  };
}
