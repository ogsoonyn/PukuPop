import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const setCam = (page: Page, c: { yaw?: number; zoom?: number; x?: number; y?: number }) => page.evaluate(c => {
  const cam = (window as any).popstage.project.camera;
  cam.yaw = c.yaw ?? 0; cam.pitch = 0; cam.zoom = c.zoom ?? 1.5; cam.target = { x: c.x ?? 0, y: c.y ?? 0, z: 0 };
}, c);

test('キーフレームの経路: 枠・番号・矢印・秒数を重ね、番号でその視点へ移る。再生中・別のタブ・オフでは消える', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  const overlay = page.locator('#keyPath');
  await expect(overlay).toBeHidden();
  await setCam(page, { zoom: 2.5 });
  await page.locator('#keyAdd').click();
  await setCam(page, { zoom: 2.5, x: 400, y: 250 });
  await page.locator('#keyAdd').click();
  await setCam(page, { zoom: 2.5, x: -350, y: -200 });
  await page.locator('#keyAdd').click();
  await page.locator('#keyList > li.key-gap').nth(1).locator('[data-act=sec]').fill('2.5');
  await page.locator('#keyList > li.key-gap').nth(1).locator('[data-act=sec]').dispatchEvent('change');
  // 全体が見える視点から確かめる
  await setCam(page, { zoom: 4 });
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.kp-mark')).toHaveCount(3);
  await expect(overlay.locator('.kp-mark text')).toHaveText(['1', '2', '3']);
  await expect(overlay.locator('.kp-frame:not(.kp-halo)')).toHaveCount(3);
  await expect(overlay.locator('.kp-arrow:not(.kp-halo)')).toHaveCount(3);
  await expect(overlay.locator('.kp-path.back:not(.kp-halo)')).toHaveCount(1);
  await expect(overlay.locator('.kp-sec text')).toHaveText(['1.0秒', '2.5秒', '1.0秒']);
  // 1番の視点を止めたまま画像が動くとみなすので、番号は各フレームでの画像の中心。2番は視点を右上へ動かした所なので、画像は1番より左・下に来る
  const marks = () => overlay.locator('.kp-mark').evaluateAll(gs => gs.map(g => { const r = g.getBoundingClientRect(); return [r.x, r.y]; }));
  await expect.poll(async () => { const p = await marks(); return p[1][0] < p[0][0] && p[1][1] > p[0][1]; }).toBe(true);
  // 1番の枠は、元の置き場所の画像の輪郭そのもの(空間に置いてあるので、今の視点から見た画像の四隅に重なる)
  const outline = () => page.evaluate(() => {
    const a = (window as any).popstage, { width: w, height: h } = a.doc.image;
    return [[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2], [-w / 2, -h / 2]].map(([x, y]) => a.stage.toMainScreen({ x, y, z: 0 }));
  });
  const framePts = async (i: number) => (await overlay.locator('.kp-frame:not(.kp-halo)').nth(i).getAttribute('points'))!.split(' ').map(p => p.split(',').map(Number));
  await expect.poll(async () => {
    const f = await framePts(0), o = await outline();
    return f.every(([x, y], k) => Math.abs(x - o[k].x) < 1 && Math.abs(y - o[k].y) < 1);
  }).toBe(true);
  await page.screenshot({ path: test.info().outputPath('keypath.png') });

  // 番号を押すとその視点へ。今の視点のフレームは強める
  await overlay.locator('.kp-mark').nth(1).click();
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBe(400);
  await expect(overlay.locator('.kp-mark').nth(1)).toHaveClass(/strong/);
  // 視点を動かしても、枠は空間に置いたまま(移った視点でも、1番の枠は画像の輪郭に重なる)
  await expect.poll(async () => {
    const f = await framePts(0), o = await outline();
    return f.every(([x, y], k) => Math.abs(x - o[k].x) < 1 && Math.abs(y - o[k].y) < 1);
  }).toBe(true);

  // ゴースト: オンにすると、各フレームの画像を主ビューに半透明で重ねる(強めたフレームは濃い)。1番は画像そのものと重なるので出さない。経路をオフにしても出せる
  const ghosts = () => page.evaluate(() => {
    const g = (window as any).popstage.stage.ghosts;
    return g.visible ? g.children.filter((m: any) => m.visible).map((m: any) => m.material.opacity) : null;
  });
  expect(await ghosts()).toBeNull();
  await page.locator('#keyGhostShow').check();
  await expect.poll(ghosts).toEqual([0.55, 0.28]);
  await page.locator('#keyPathShow').uncheck();
  await expect(overlay.locator('.kp-mark')).toHaveCount(0);
  await expect.poll(async () => (await ghosts())?.length).toBe(2);
  await page.locator('#keyPathShow').check();

  // 番号の形は通り方で変わる(なめらかは丸、弾むはひし形)
  await expect(overlay.locator('.kp-mark .kp-shape')).toHaveCount(3);
  await expect(overlay.locator('.kp-mark circle')).toHaveCount(3);
  await page.locator('#keyList > li.key-row:not(.key-back)').nth(1).locator('[data-act=mode]').selectOption('bounce');
  await expect(overlay.locator('.kp-mark').nth(1)).toHaveAttribute('data-mode', 'bounce');
  await expect(overlay.locator('.kp-mark').nth(1).locator('polygon')).toHaveCount(1);
  await expect(overlay.locator('.kp-mark circle')).toHaveCount(2);
  await expect(overlay.locator('.kp-mark').nth(1).locator('title')).toHaveText('2(弾む): この視点を見る');

  // 一覧の行に乗せたフレームを強める
  await page.locator('#keyList > li.key-row:not(.key-back)').nth(2).hover();
  await expect(overlay.locator('.kp-mark').nth(2)).toHaveClass(/strong/);

  // 再生中は消える(ゴーストも)
  await page.locator('#keyMake').click();
  await expect(overlay).toBeHidden();
  await expect.poll(ghosts).toBeNull();
  await page.evaluate(() => (window as any).popstage.stopTake());
  await expect(overlay).toBeVisible();

  // 書き出し中は消える
  await page.evaluate(() => { const a = (window as any).popstage; a.exporting = true; a.emit('status', undefined); });
  await expect(overlay).toBeHidden();
  await page.evaluate(() => { const a = (window as any).popstage; a.exporting = false; a.emit('status', undefined); });
  await expect(overlay).toBeVisible();

  // 番号の上のホイールでもズームする
  const z0 = await page.evaluate(() => (window as any).popstage.project.camera.zoom);
  await overlay.locator('.kp-mark').nth(0).hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => (window as any).popstage.project.camera.zoom)).not.toBe(z0);

  // 別のタブでは消える
  await openTab(page, 'view');
  await expect(overlay).toBeHidden();
  await openTab(page, 'anim');
  await expect(overlay).toBeVisible();

  // オフにすると消え、ブラウザに覚える
  await page.locator('#keyPathShow').uncheck();
  await expect(overlay).toBeHidden();
  await page.reload();
  await page.waitForFunction(() => (window as any).popstage?.doc);
  await expect(page.locator('#keyPathShow')).not.toBeChecked();
});

test('キーフレームの経路: 回転・ズームだけのフレームは、1番の視点から見ると番号を横に並べ、秒数を番号の下に出す。横から見ると前後の動きが見える', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  await setCam(page, { yaw: 0 });
  await page.locator('#keyAdd').click();
  await setCam(page, { yaw: 0.4, zoom: 2 });
  await page.locator('#keyAdd').click();
  const overlay = page.locator('#keyPath');
  // 1番の視点から外れて見ると、ズームで画像が前後に動く道すじが見える
  await setCam(page, { yaw: 1.2, zoom: 3 });
  await expect(overlay.locator('.kp-arrow:not(.kp-halo)')).not.toHaveCount(0);
  // 1番の視点(撮影カメラ)から見ると、画像の中心は同じ所に重なる
  await setCam(page, { yaw: 0 });
  await expect(overlay.locator('.kp-mark')).toHaveCount(2);
  await expect(overlay.locator('.kp-arrow:not(.kp-halo)')).toHaveCount(0);
  await expect(overlay.locator('.kp-sec')).toHaveCount(2);
  const marks = () => overlay.locator('.kp-mark').evaluateAll(gs => gs.map(g => { const r = g.getBoundingClientRect(); return [r.x, r.y]; }));
  await expect.poll(async () => { const p = await marks(); return p[1][0] - p[0][0] > 15 && Math.abs(p[1][1] - p[0][1]) < 1; }).toBe(true);
});

test('左のツールバー: キーフレームの再生・停止と、経路・ゴーストの切り替え。入れるとアニメーションのタブを開く', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const play = page.locator('#toolNav [data-cmd=toggleKeyPlay]'), path = page.locator('#toolNav [data-cmd=toggleKeyPath]'), ghost = page.locator('#toolNav [data-cmd=toggleKeyGhost]');
  // フレームが2つ以上なければ再生できない(ツールオプションの欄の右端の再生も)
  await expect(play).toBeDisabled();
  await expect(page.locator('#quickActs [data-cmd=toggleKeyPlay]')).toBeDisabled();
  await openTab(page, 'anim');
  await setCam(page, { zoom: 2.5 });
  await page.locator('#keyAdd').click();
  await setCam(page, { zoom: 2.5, x: 300, y: 100 });
  await page.locator('#keyAdd').click();
  await expect(play).toBeEnabled();
  await expect(play).toHaveText(/再生/);
  await play.click();
  expect(await app(a => [a.takeState, !!a.project.take?.keys])).toEqual(['playing', true]);
  await expect(play).toHaveText(/停止/);
  await play.click();
  expect(await app(a => a.takeState)).toBe('idle');
  await expect(play).toHaveText(/再生/);
  // ツールオプションの欄の右端の再生ボタンも同じ動きで、再生中は停止のボタンになる
  const quick = page.locator('#quickActs [data-cmd=toggleKeyPlay]');
  await expect(quick).toHaveAccessibleName('キーフレームを再生');
  await quick.click();
  expect(await app(a => a.takeState)).toBe('playing');
  await expect(quick).toHaveAccessibleName('再生を止める');
  await expect(play).toHaveText(/停止/);
  await quick.click();
  expect(await app(a => a.takeState)).toBe('idle');
  await expect(quick).toHaveAccessibleName('キーフレームを再生');

  // 経路・ゴースト: 右パネルのチェックボックスと同じ設定を切り替え、入・切を aria-pressed とメニューの ✓ に映す
  await expect(path).toHaveAttribute('aria-pressed', 'true');
  await path.click();
  await expect(path).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#keyPathShow')).not.toBeChecked();
  await page.locator('#keyGhostShow').check();
  await expect(ghost).toHaveAttribute('aria-pressed', 'true');
  await ghost.click();
  await expect(page.locator('#keyGhostShow')).not.toBeChecked();
  // 別のタブを開いていても、入れたらアニメーションのタブを開いて重ねる
  await openTab(page, 'layer');
  await path.click();
  await expect(page.locator('#keySection')).toBeVisible();
  await expect(page.locator('#keyPath .kp-mark')).toHaveCount(2);
  await expect(page.locator('#menubar [data-check=keyPath]')).toHaveText('✓');
});
