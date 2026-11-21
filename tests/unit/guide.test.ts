import { describe, it, expect } from 'vitest';
import { MOTIONS, MOTION_PARAMS, type MotionPattern } from '../../src/model/project';
import { GUIDE } from '../../src/guide/info';

describe('揺らし方図鑑(guide.html)の説明', () => {
  it('「なし」のほかの揺らし方を残らず説明する(揺らし方を足したら図鑑にも足す)', () => {
    const motions = (Object.keys(MOTIONS) as MotionPattern[]).filter(m => m !== 'none');
    expect(Object.keys(GUIDE).sort()).toEqual([...motions].sort());
  });

  it('固有設定は残らず説明し、本体に無い項目は説明しない(足したら図鑑にも足し、名前を変えたら図鑑も直す)', () => {
    for (const [m, g] of Object.entries(GUIDE)) {
      const keys = (MOTION_PARAMS[m as MotionPattern] ?? []).map(d => d.key);
      expect(Object.keys(g.notes).sort(), m).toEqual([...keys].sort());
    }
  });
});
