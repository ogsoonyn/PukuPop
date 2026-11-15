/** E2E: 書き出し */
import { test, expect } from '@playwright/test';
import { watchGlErrors, boot } from './helpers';

watchGlErrors();

for (const format of ['mp4', 'webm', 'webm-alpha', 'png', 'gif'] as const) {
  test(`書き出し: ${format}`, async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async (format) => {
      const a = (window as any).popstage;
      const path = '/src/export/encoders.ts';
      const { availableFormats } = await import(/* @vite-ignore */ path);
      const avail = await availableFormats(160, 120);
      if (!avail[format]) return { skipped: true };
      const res = await a.exportMedia({ format, width: 160, height: 120, fps: 30, duration: 1, background: format === 'mp4' || format === 'webm' ? '#ffffff' : null, motion: 'auto' }, () => {}, new AbortController().signal);
      const head = new Uint8Array(await res.blob.slice(0, 12).arrayBuffer());
      return { skipped: false, size: res.blob.size, frames: res.frames, head: [...head], name: res.filename };
    }, format);
    test.skip(r.skipped === true, `${format} はこのブラウザで使えない`);
    expect(r.frames).toBe(30);
    expect(r.size).toBeGreaterThan(500);
    const h = r.head!;
    if (format === 'mp4') expect(String.fromCharCode(...h.slice(4, 8))).toBe('ftyp');
    if (format.startsWith('webm')) expect(h.slice(0, 4)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    if (format === 'png') expect(h.slice(0, 2)).toEqual([0x50, 0x4b]);
    if (format === 'gif') expect(String.fromCharCode(...h.slice(0, 6))).toBe('GIF89a');
  });
}

test('書き出し: 連番PNG で大きく長いときは、メモリの目安を示して確認する', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exportDialog')).toBeVisible();
  await page.locator('#exFormat').selectOption('png');
  await page.locator('#exW').fill('3840');
  await page.locator('#exH').fill('3840');
  await page.locator('#exLoop').uncheck();
  await page.locator('#exDur').fill('60');
  await page.locator('#exDur').dispatchEvent('change');
  await page.locator('#exStart').click();
  await expect(page.locator('#askTitle')).toHaveText('書き出すデータが大きくなります');
  await expect(page.locator('#askBody')).toContainText('GB');
  await page.locator('#askNo').click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).popstage.exporting)).toBe(false);
  await expect(page.locator('#exportDialog')).toBeVisible();
});

test('書き出し: 直前の操作を再生', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.setPaused(false);
    // 1秒ぶん、記録しながら進める
    a.world.grab = { x: 0.2, y: 0, z: 0 };
    for (let i = 0; i < 60; i++) a.frame(1 / 60);
    a.world.grab = null;
    for (let i = 0; i < 60; i++) a.frame(1 / 60);
    const res = await a.exportMedia({ format: 'png', width: 64, height: 48, fps: 30, duration: 1.5, background: null, motion: 'replay' }, () => {}, new AbortController().signal);
    return res.frames;
  });
  expect(r).toBe(45);
});

test('書き出し: 読み出しバッファを使い回し・手放しても、描いた中身は変わらない', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const a = (window as any).popstage, s = a.stage;
    const draw = (w: number, h: number) => Array.from(s.renderFrame(w, h, a.project.camera, '#336699') as Uint8ClampedArray);
    const first = draw(64, 48);
    const again = draw(64, 48); // 同じ大きさ: バッファを使い回す
    draw(32, 24); // 大きさが入れ替わる
    const swapped = draw(64, 48);
    s.releaseExportBuffers();
    const released = draw(64, 48); // 手放したあと: 作り直す
    const same = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i]);
    return { len: first.length, nonBlank: first.some((v, i) => i % 4 !== 3 && v !== first[0]), again: same(first, again), swapped: same(first, swapped), released: same(first, released) };
  });
  expect(r.len).toBe(64 * 48 * 4);
  expect(r.nonBlank).toBe(true);
  expect(r.again && r.swapped && r.released).toBe(true);
});

test('書き出し: APNG は全フレームを1つの PNG に入れ、無限ループにする', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    const res = await a.exportMedia({ format: 'apng', width: 48, height: 32, fps: 30, duration: 0.5, background: null, motion: 'auto' }, () => {}, new AbortController().signal);
    const b = new Uint8Array(await res.blob.arrayBuffer()), dv = new DataView(b.buffer);
    const types: string[] = [];
    let actl: number[] = [];
    for (let p = 8; p < b.length; p += 12 + dv.getUint32(p)) {
      const type = String.fromCharCode(...b.subarray(p + 4, p + 8));
      types.push(type);
      if (type === 'acTL') actl = [dv.getUint32(p + 8), dv.getUint32(p + 12)];
    }
    return { frames: res.frames, name: res.filename, type: res.blob.type, sig: [...b.subarray(0, 8)], actl, fctl: types.filter(t => t === 'fcTL').length, first: types.slice(0, 4) };
  });
  expect(r.frames).toBe(15);
  expect(r.name).toMatch(/\.png$/);
  expect(r.type).toBe('image/png');
  expect(r.sig).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(r.first).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT']);
  expect(r.actl).toEqual([15, 0]);
  expect(r.fctl).toBe(15);
});

test('書き出し: 静止画 PNG は今の視点で1枚だけ撮り、画面の揺れの状態を変えない', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    const time = a.world.time;
    const res = await a.exportMedia({ format: 'still', width: 64, height: 40, fps: 60, duration: 3, background: null, motion: 'auto' }, () => {}, new AbortController().signal);
    const b = new Uint8Array(await res.blob.arrayBuffer()), dv = new DataView(b.buffer);
    const types: string[] = [];
    for (let p = 8; p < b.length; p += 12 + dv.getUint32(p)) types.push(String.fromCharCode(...b.subarray(p + 4, p + 8)));
    return { frames: res.frames, name: res.filename, sig: [...b.subarray(0, 8)], size: [dv.getUint32(16), dv.getUint32(20)], colorType: b[25], types, timeKept: a.world.time === time, exporting: a.exporting };
  });
  expect(r.frames).toBe(1);
  expect(r.name).toMatch(/\.png$/);
  expect(r.sig).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(r.size).toEqual([64, 40]);
  expect(r.colorType).toBe(6); // RGBA
  expect(r.types).toEqual(['IHDR', 'IDAT', 'IEND']);
  expect(r.timeKept).toBe(true);
  expect(r.exporting).toBe(false);
});

test('書き出し: 静止画 PNG では長さ・fps・動きの元・ループが使えず、覚えた形式と fps は戻る', async ({ page }) => {
  // 新しい形式(静止画)を覚えていても、ほかの覚えた値(fps)が戻ること
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('popstage.prefs.v1', JSON.stringify({ export: { exFormat: 'still', 'radio:exFps': '30' } }));
    }
  });
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exportDialog')).toBeVisible();
  await expect(page.locator('#exFormat')).toHaveValue('still');
  await expect(page.locator('input[name=exFps][value="30"]')).toBeChecked();
  await expect(page.locator('#exDur')).toBeDisabled();
  await expect(page.locator('#exLoop')).toBeDisabled();
  await expect(page.locator('input[name=exFps][value="60"]')).toBeDisabled();
  await expect(page.locator('input[name=exMotion][value=auto]')).toBeDisabled();
  await expect(page.locator('input[name=exBg][value=alpha]')).toBeEnabled();
  await expect(page.locator('#exW')).toBeEnabled();
  await page.locator('#exFormat').selectOption('apng');
  await expect(page.locator('#exDur')).toBeEnabled();
  await expect(page.locator('input[name=exMotion][value=auto]')).toBeEnabled();
  await expect(page.locator('#exNote')).toContainText('対応していないアプリでは1枚目だけが出ます');
  await expect(page.locator('#exNote')).toContainText('メモリ');
});

test('書き出し: 覚えた形式が知らない値なら、既定の形式で開く', async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('popstage.prefs.v1', JSON.stringify({ export: { exFormat: 'avif-anim' } }));
    }
  });
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exportDialog')).toBeVisible();
  await expect(page.locator('#exFormat')).toHaveValue(/^(mp4|webm|png)$/);
});
