import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';

// スマホ(Android の Chrome 相当)の画面と指の操作。指は CDP でタッチを送って再現する
const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
test.use({ ...pixel, deviceScaleFactor: 1 });

async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?e2e');
  await page.waitForFunction(() => {
    const a = (window as any).popstage;
    return a?.doc && a.stage.hasDocument && a.paused;
  });
  expect(errors).toEqual([]);
}

type Pt = [number, number];
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
}
/** 指を置いて、from から to へ steps 回に分けて動かして離す。from と to は指ごとの位置 */
async function swipe(cdp: CDPSession, from: Pt[], to: Pt[], steps = 8): Promise<void> {
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', from.map((p, j) => [p[0] + (to[j][0] - p[0]) * i / steps, p[1] + (to[j][1] - p[1]) * i / steps]));
  await touch(cdp, 'touchEnd', []);
}
async function viewCenter(page: Page): Promise<Pt> {
  const b = (await page.locator('#view').boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2];
}
const weightSum = (page: Page) => page.evaluate(() => (window as any).popstage.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0));

test('スマホ幅では3Dビューが全面に出て、PC のパネルは隠れる', async ({ page }) => {
  await boot(page);
  await expect(page.locator('html')).toHaveClass(/mobile/);
  await expect(page.locator('#toolNav')).toBeHidden();
  await expect(page.locator('#menubar')).toBeHidden();
  await expect(page.locator('#mTools')).toBeVisible();
  const view = (await page.locator('#view').boundingBox())!;
  expect(view.width).toBeGreaterThan(400);
  // 塗りのツールは「塗って直す」の奥にあるので、最初はつかむ
  await expect(page.locator('#mTools [data-mtool="grab"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mTools [data-mtool="brush"]')).toBeHidden();
  await expect(page.locator('#mTools [data-mtool="inflate"]')).toBeHidden();
  await expect(page.locator('#mTools [data-mtool="pan"]')).toBeVisible();
});

test('「移動」では1本指で画像を動かし、画像の上でも外でも回転しない', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('#mTools [data-mtool="pan"]').click();
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { x: c.target.x, y: c.target.y, z: c.target.z, yaw: c.yaw, pitch: c.pitch }; });
  const before = await weightSum(page), c0 = await cam();
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx, cy]], [[cx + 80, cy + 40]]);
  const c1 = await cam();
  expect(Math.hypot(c1.x - c0.x, c1.y - c0.y, c1.z - c0.z)).toBeGreaterThan(0);
  expect([c1.yaw, c1.pitch]).toEqual([c0.yaw, c0.pitch]);
  // 画像の外(上の端)から始めても回転せず、動かす
  const b = (await page.locator('#view').boundingBox())!;
  await swipe(cdp, [[cx, b.y + 12]], [[cx - 60, b.y + 40]]);
  const c2 = await cam();
  expect(Math.hypot(c2.x - c1.x, c2.y - c1.y, c2.z - c1.z)).toBeGreaterThan(0);
  expect([c2.yaw, c2.pitch]).toEqual([c0.yaw, c0.pitch]);
  expect(await weightSum(page)).toBe(before);
  // 「移動」でも、画像の外のダブルタップで視点を戻す
  for (let i = 0; i < 2; i++) { await touch(cdp, 'touchStart', [[cx, b.y + 12]]); await touch(cdp, 'touchEnd', []); await page.waitForTimeout(60); }
  const c3 = await cam();
  expect(Math.hypot(c3.x - c0.x, c3.y - c0.y, c3.z - c0.z)).toBeLessThan(1e-6);
});

test('シートを開くと3Dビューはシートの上に縮み、シートの中身は下のバーに隠れない', async ({ page }) => {
  await boot(page);
  const closed = (await page.locator('#view').boundingBox())!.height;
  await page.locator('[data-mtab="layer"]').click();
  await page.waitForTimeout(400);
  await expect(page.locator('#mSheet #pPop')).toBeVisible();
  expect((await page.locator('#view').boundingBox())!.height).toBeLessThan(closed - 100);
  const sheet = (await page.locator('#mSheet').boundingBox())!, bar = (await page.locator('#mTools').boundingBox())!;
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(bar.y + 1);
  // 「アニメ」タブには自動揺らし・記録・キーフレームが入る。いちばん下まで送ると、最後の項目がシートの中に見える
  await page.locator('[data-mtab="anim"]').click();
  await expect(page.locator('#mSheet #pAuto')).toBeVisible();
  await page.locator('#mPanes').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const last = (await page.locator('#keyMake').boundingBox())!;
  expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
  // つまみを押すたびに 半分 → 全部 → 閉じる
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'full');
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'closed');
});

test('プリセットはシートのボタンで選べる', async ({ page }) => {
  await boot(page);
  const chip = page.locator('#mPresets button').nth(1);
  const value = await chip.getAttribute('data-value');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.physics.preset)).toBe(value);
  // ボタンの状態はモデルから決める(元に戻すと、前のプリセットのボタンが押された状態に戻る)
  const prev = await page.evaluate(() => { const a = (window as any).popstage; a.history.undo(); return a.activeLayer.physics.preset; });
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator(`#mPresets button[data-value=${prev}]`)).toHaveAttribute('aria-pressed', 'true');
  // 上のバーの「自動で揺らす」もモデルを切り替え、表示が付いてくる
  const auto = () => page.evaluate(() => (window as any).popstage.project.autoSwing.enabled);
  const before = await auto();
  await page.locator('#mAuto').click();
  expect(await auto()).toBe(!before);
  await expect(page.locator('#mAuto')).toHaveAttribute('aria-pressed', String(!before));
  // スマホの上のメニューには、PC のキー表記を付けない
  await expect(page.locator('#mTop .menu kbd')).toHaveCount(0);
});

test('上のメニューから設定を開ける。左のツールバーが無いので、その欄は出さない', async ({ page }) => {
  await boot(page);
  await page.locator('#mTop [aria-label=メニュー]').click();
  await page.locator('#mTop [data-cmd=settings]').click();
  await expect(page.locator('#settingsDialog')).toBeVisible();
  await expect(page.locator('#vAutoOverlay')).toBeVisible();
  await expect(page.locator('#setToolbarList')).toBeHidden();
});

test('2本指で平行移動とピンチズームができ、画像の外をなぞると回転する', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { zoom: c.zoom, x: c.target.x, yaw: c.yaw }; });
  const [cx, cy] = await viewCenter(page);
  const before = await cam();
  // 画像の外(上の端)を1本指でなぞると回転
  const top = (await page.locator('#view').boundingBox())!.y + 20;
  await swipe(cdp, [[cx - 60, top]], [[cx + 60, top]]);
  expect((await cam()).yaw).not.toBeCloseTo(before.yaw, 3);
  // 指を広げると近づく
  await swipe(cdp, [[cx - 40, cy], [cx + 40, cy]], [[cx - 120, cy], [cx + 120, cy]]);
  const pinched = await cam();
  expect(pinched.zoom).toBeLessThan(before.zoom * 0.6);
  // 2本指をそろえて動かすと平行移動
  await swipe(cdp, [[cx - 40, cy], [cx + 40, cy]], [[cx + 20, cy], [cx + 100, cy]]);
  expect((await cam()).x).not.toBeCloseTo(pinched.x, 5);
});

test('2本指タップで戻し、3本指タップでやり直す', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => (window as any).popstage.addLayer());
  const layers = () => page.evaluate(() => (window as any).popstage.doc.layers.length);
  expect(await layers()).toBe(2);
  const [cx, cy] = await viewCenter(page);
  // タップは 300ms 以内に離したものだけなので、起動直後の重い描画が落ち着いてから送る
  await page.waitForTimeout(1000);
  // 指が少し震えても(それぞれの指が置いた所からわずかに動いても)タップとみなす
  await touch(cdp, 'touchStart', [[cx - 60, cy], [cx + 60, cy]]);
  await touch(cdp, 'touchMove', [[cx - 58, cy + 2], [cx + 62, cy - 2]]);
  await touch(cdp, 'touchEnd', []);
  expect(await layers()).toBe(1);
  await touch(cdp, 'touchStart', [[cx - 40, cy], [cx, cy], [cx + 40, cy]]); await touch(cdp, 'touchEnd', []);
  expect(await layers()).toBe(2);
});

test('「塗って直す」の膨らみで範囲を描くと「ツール」タブで決めて適用できる', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await page.locator('#mTools [data-mtool="inflate"]').click();
  const before = await weightSum(page);
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx - 60, cy - 40]], [[cx + 60, cy + 40]]);
  expect(await page.evaluate(() => (window as any).popstage.previewingInflate)).toBe(true);
  await expect(page.locator('[data-mtab="tool"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inflApply')).toBeVisible();
  await page.locator('#inflApply').click();
  expect(await page.evaluate(() => (window as any).popstage.previewingInflate)).toBe(false);
  expect(await weightSum(page)).toBeGreaterThan(before);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'closed');
});

test('膨らみの範囲は指で枠の辺を動かして直せ、2本目の指を置くと直す前に戻る', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await page.locator('#mTools [data-mtool="inflate"]').click();
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx - 60, cy - 40]], [[cx + 60, cy + 40]]);
  const area = () => page.evaluate(() => ({ ...(window as any).popstage.inflateState.area }));
  const a0 = await area();
  // 右の辺の中点(画面上)。指は当たりが大きいので、少しずれていても掴める
  const right = await page.evaluate(() => {
    const a = (window as any).popstage, r = a.inflateState.area, p = a.stage.imageToMainScreen(r.x + r.w / 2, r.y);
    const box = document.getElementById('view')!.getBoundingClientRect(), m = a.stage.mainView();
    return [box.left + m.x + p.x, box.top + m.y + p.y] as Pt;
  });
  await swipe(cdp, [[right[0] + 8, right[1] + 6]], [[right[0] + 48, right[1] + 6]]);
  const a1 = await area();
  expect(a1.w).toBeGreaterThan(a0.w + 10);
  expect(a1.h).toBeCloseTo(a0.h, 3);
  expect(a1.x - a1.w / 2).toBeCloseTo(a0.x - a0.w / 2, 0);
  // 動かしている途中で2本目の指を置くと、動かす前の範囲に戻る
  const r2 = await page.evaluate(() => {
    const a = (window as any).popstage, r = a.inflateState.area, p = a.stage.imageToMainScreen(r.x + r.w / 2, r.y);
    const box = document.getElementById('view')!.getBoundingClientRect(), m = a.stage.mainView();
    return [box.left + m.x + p.x, box.top + m.y + p.y] as Pt;
  });
  await touch(cdp, 'touchStart', [r2]);
  for (let i = 1; i <= 4; i++) await touch(cdp, 'touchMove', [[r2[0] + i * 10, r2[1]]]);
  expect((await area()).w).toBeGreaterThan(a1.w);
  await touch(cdp, 'touchStart', [[r2[0] + 40, r2[1]], [cx - 100, cy - 100]]);
  await touch(cdp, 'touchEnd', []);
  expect(await area()).toEqual(a1);
  await page.locator('#inflCancel').click();
});

test('「塗って直す」で塗れ、2本目の指を置くと塗りは取り消される', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await expect(page.locator('#mTools [data-mtool="brush"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mModeBar')).toBeVisible();
  const [cx, cy] = await viewCenter(page);
  const before = await weightSum(page), dirty0 = await page.evaluate(() => (window as any).popstage.dirty);
  // 1本指で塗りかけてから2本目を置く → 塗った分は消え、アンドゥにも残らない
  await touch(cdp, 'touchStart', [[cx - 80, cy + 60]]);
  for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [[cx - 80 + i * 15, cy + 60]]);
  expect(await weightSum(page)).not.toBe(before);
  await touch(cdp, 'touchStart', [[cx - 80 + 90, cy + 60], [cx + 60, cy - 60]]);
  await touch(cdp, 'touchEnd', []);
  expect(await weightSum(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).popstage.history.canUndo)).toBe(false);
  // 取り消した塗りでは「未保存」にならない
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(dirty0);
  // 1本指で塗ると残る
  await swipe(cdp, [[cx - 80, cy + 60]], [[cx + 20, cy + 60]]);
  expect(await weightSum(page)).not.toBe(before);
  await page.locator('#mPaintDone').click();
  await expect(page.locator('#mTools [data-mtool="grab"]')).toHaveAttribute('aria-pressed', 'true');
});

test('幅を広げると PC の配置に戻る', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('html')).not.toHaveClass(/mobile/);
  await expect(page.locator('#toolNav')).toBeVisible();
  await expect(page.locator('#mTools')).toBeHidden();
  // 移していた部品は右のパネルへ戻る
  expect(await page.locator('#pPop').evaluate(el => !!el.closest('aside'))).toBe(true);
  expect(await page.locator('#layerList').evaluate(el => !!el.closest('aside'))).toBe(true);
  expect(await page.locator('#inflateDialog').evaluate(el => el.parentElement === document.body)).toBe(true);
});

test('PC の幅で自動で入れた重ね表示は、スマホの幅を行き来しても消えない', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('html')).not.toHaveClass(/mobile/);
  const state = () => page.evaluate(() => { const a = (window as any).popstage; return [a.tool, a.view.overlay]; });
  await page.evaluate(() => { const a = (window as any).popstage; a.setTool('grab'); a.setOverlayMode('off'); a.setTool('brush'); });
  expect(await state()).toEqual(['brush', true]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveClass(/mobile/);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('html')).not.toHaveClass(/mobile/);
  expect(await state()).toEqual(['brush', true]);
  // 戻った後も、塗るツールから離れれば切る
  await page.evaluate(() => (window as any).popstage.setTool('grab'));
  expect(await state()).toEqual(['grab', false]);
});

test("シートのタブは PC の右パネルと同じ分け方で、下のバーのアイコンは PC と同じ表から作る", async ({ page }) => {
  await boot(page);
  // 「レイヤー」: レイヤー一覧・ポップ量・揺れ(選択中のレイヤーの設定)
  await page.locator('[data-mtab="layer"]').click();
  for (const id of ["#layerList", "#pPop", "#pBlend", "#pSwing"]) await expect(page.locator(`#mPanes ${id}`)).toBeVisible();
  // 「アニメ」: 自動揺らし・記録・キーフレーム
  await page.locator('[data-mtab="anim"]').click();
  for (const id of ["#pAuto", "#takeRec", "#keyAdd"]) await expect(page.locator(`#mPanes ${id}`)).toBeVisible();
  // 「表示」: メッシュ密度・表示の切り替え・画角
  await page.locator('[data-mtab="view"]').click();
  for (const id of ["#pDensity", "#vGrid", "#pFov"]) await expect(page.locator(`#mPanes ${id}`)).toBeVisible();
  await expect(page.locator("#mPanes #vMulti")).toBeHidden();
  // 下のバー
  await expect(page.locator("#mTools [data-mtool=grab] svg")).toHaveCount(1);
  await expect(page.locator("#mTools [data-mtool=grab] span")).toHaveText("つかむ");
});

test('全体ぼかしのプレビュー中は、2本指タップで元に戻さない', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => (window as any).popstage.addLayer());
  const state = () => page.evaluate(() => { const a = (window as any).popstage; return [a.doc.layers.length, a.previewingBlur]; });
  // シートの「レイヤー」から全体ぼかしを開く(ほかの操作を止めないパネル)
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPanes [data-cmd=smoothAll]').click();
  await expect(page.locator('#blurDialog')).toHaveJSProperty('open', true);
  expect(await state()).toEqual([2, true]);
  await page.waitForTimeout(1000);
  const [cx, cy] = await viewCenter(page);
  await touch(cdp, 'touchStart', [[cx - 60, cy], [cx + 60, cy]]);
  await touch(cdp, 'touchEnd', []);
  expect(await state()).toEqual([2, true]);
  await page.locator('#blurCancel').click();
  expect(await state()).toEqual([2, false]);
});

test('キーフレームはシートの中で指でつまみをドラッグして並べ替えられる', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.keyDraft = [0.1, 0.2, 0.3].map(yaw => ({ view: { yaw, pitch: 0, zoom: 1.5, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' }));
    a.emit('take', a.takeState);
  });
  await page.locator('[data-mtab="anim"]').click();
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  const rows = page.locator('#keyList > li.key-row:not(.key-back)');
  await rows.nth(2).scrollIntoViewIfNeeded();
  const g = (await rows.nth(0).locator('[data-act=drag]').boundingBox())!, last = (await rows.nth(2).boundingBox())!;
  const scroll = () => page.locator('#mPanes').evaluate(el => el.scrollTop);
  const before = await scroll();
  const cdp = await page.context().newCDPSession(page);
  await swipe(cdp, [[g.x + g.width / 2, g.y + g.height / 2]], [[g.x + g.width / 2, last.y + last.height - 2]], 10);
  expect(await page.evaluate(() => (window as any).popstage.keyDraft.map((k: any) => k.view.yaw))).toEqual([0.2, 0.3, 0.1]);
  // つまみを動かしてもシートは流れない
  expect(await scroll()).toBe(before);
});
