import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
const rows = (page: Page) => page.locator('#favList > li');

test('お気に入り: K で残し、設定を変えても「適用」で戻せる。適用はアンドゥでき、名前の変更・上書き・削除もできる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  await expect(page.locator('#favEmpty')).toBeVisible();
  await expect(page.locator('#favCount')).toHaveText('0/30');

  // 残す(K)
  await page.locator('#view').focus();
  await page.keyboard.press('k');
  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('#favEmpty')).toBeHidden();
  await expect(rows(page).first().locator('[data-act=name]')).toHaveValue('お気に入り 1');
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
  const saved = await app(page, a => ({ physics: structuredClone(a.doc.layers[0].physics), pop: a.doc.layers[0].pop, period: a.project.autoSwing.period, yaw: a.project.camera.yaw }));

  // 設定を変えると印が消える
  await openTab(page, 'layer');
  await page.locator('#pPreset').selectOption('tame');
  await app(page, a => { a.store.patchLayer(a.doc.layers[0].id, { pop: 500 }); a.project.camera.yaw += 1; });
  await openTab(page, 'anim');
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'false');

  // 適用すると戻る(視点も)
  await rows(page).first().locator('[data-act=apply]').click();
  expect(await app(page, a => ({ physics: a.doc.layers[0].physics, pop: a.doc.layers[0].pop, period: a.project.autoSwing.period, yaw: a.project.camera.yaw }))).toEqual(saved);
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');

  // 適用はアンドゥで戻せる(視点は戻さない)
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  expect(await app(page, a => [a.doc.layers[0].physics.preset, a.doc.layers[0].pop])).toEqual(['tame', 500]);
  expect(await app(page, a => a.project.camera.yaw)).toBeCloseTo(saved.yaw);

  // 今の状態で上書きすると、印が付く
  await rows(page).first().locator('[data-act=set]').click();
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
  expect(await app(page, a => a.project.favorites[0].layers[0].pop)).toBe(500);

  // 名前はその場で変える(Enter で確定。空にしたら元に戻る)
  const name = rows(page).first().locator('[data-act=name]');
  await name.fill('ぼよん最高');
  await name.press('Enter');
  expect(await app(page, a => a.project.favorites[0].name)).toBe('ぼよん最高');
  await name.fill('  ');
  await name.press('Enter');
  await expect(name).toHaveValue('ぼよん最高');
  // 名前の入力中は K でお気に入りが増えない
  await name.focus();
  await page.keyboard.press('k');
  await name.press('Escape');
  await expect(name).toHaveValue('ぼよん最高');
  await expect(rows(page)).toHaveCount(1);

  // 左のツールバーからも残せる。2件目は次の番号になる
  await page.locator('#toolNav [data-cmd=addFavorite]').click();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1).locator('[data-act=name]')).toHaveValue('お気に入り 2');

  // 消す(アンドゥで戻る)
  await rows(page).first().locator('[data-act=del]').click();
  await expect(rows(page)).toHaveCount(1);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('#favCount')).toHaveText('2/30');
});

test('お気に入り: 記録を再生しているときに残すと、適用で記録と再生まで戻る', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  // キーフレームから動きを作って再生する
  await app(page, a => {
    a.project.camera.yaw = 0; a.addKey();
    a.project.camera.yaw = 0.8; a.addKey();
    a.makeKeyTake();
  });
  expect(await app(page, a => a.takeState)).toBe('playing');
  await page.locator('#favAdd').click();
  expect(await app(page, a => a.project.favorites[0].playing)).toBe(true);
  await expect(rows(page).first().locator('.fav-sub')).toContainText('キーフレーム');

  // 記録を消し、視点を変えてから適用する
  await app(page, a => { a.clearTake(); a.project.camera.zoom = 3; });
  expect(await app(page, a => [a.project.take, a.takeState])).toEqual([null, 'idle']);
  await rows(page).first().locator('[data-act=apply]').click();
  expect(await app(page, a => [a.project.take === a.project.favorites[0].take, a.takeState])).toEqual([true, 'playing']);
  expect(await app(page, a => a.project.camera.zoom)).toBeCloseTo(1);

  // 記録中は残せない
  await app(page, a => a.startRecording());
  await expect(page.locator('#favAdd')).toBeDisabled();
  await expect(rows(page).first().locator('[data-act=apply]')).toBeDisabled();
  await app(page, a => a.stopRecording());
  await expect(page.locator('#favAdd')).toBeEnabled();
});

test('お気に入り: 画角と視点を両方変えても適用で戻る。アンドゥで画角・自動揺らしは戻り、視点は戻らない', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  const saved = await app(page, a => {
    Object.assign(a.project.camera, { fov: 30, yaw: 0.3, pitch: 0.2, zoom: 1.5, target: { x: 20, y: 0, z: 0 } });
    a.addFavorite();
    const c = a.project.camera;
    return { fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, x: c.target.x, period: a.project.autoSwing.period };
  });
  const changed = await app(page, a => {
    a.store.patchProject({ camera: { ...a.project.camera, fov: 60, yaw: -1, pitch: -0.3, zoom: 3, target: { x: -50, y: 0, z: 0 } } });
    a.store.patchProject({ autoSwing: { ...a.project.autoSwing, period: 4 } });
    const c = a.project.camera;
    return { fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, x: c.target.x, period: a.project.autoSwing.period };
  });
  await rows(page).first().locator('[data-act=apply]').click();
  expect(await app(page, a => ({ ...((c: any) => ({ fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, x: c.target.x }))(a.project.camera), period: a.project.autoSwing.period }))).toEqual(saved);
  // アンドゥ: 画角と自動揺らしは変える前に戻り、視点は適用したまま
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  const undone = await app(page, a => { const c = a.project.camera; return { fov: c.fov, yaw: c.yaw, period: a.project.autoSwing.period }; });
  expect(undone).toEqual({ fov: changed.fov, yaw: saved.yaw, period: changed.period });
  // リドゥで適用し直せる
  await page.keyboard.press('Control+Shift+z');
  expect(await app(page, a => [a.project.camera.fov, a.project.autoSwing.period])).toEqual([saved.fov, saved.period]);
});

test('お気に入り: 残したあとに消したレイヤーは飛ばして適用し、知らせる。プレビュー中は使えない', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  // 足したレイヤー(選択中)ごと残してから、そのレイヤーを消す
  const pop0 = await app(page, a => { a.addLayer(); a.addFavorite(); return a.doc.layers[0].pop; });
  await app(page, a => { a.store.patchLayer(a.doc.layers[0].id, { pop: 321 }); a.deleteLayer(); });
  expect(await app(page, a => a.doc.layers.length)).toBe(1);
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'false');
  await rows(page).first().locator('[data-act=apply]').click();
  await expect(page.locator('#toasts')).toContainText('1 枚は、もう無いので飛ばしました');
  expect(await app(page, a => a.doc.layers[0].pop)).toBe(pop0);

  // 全体ぼかしのプレビュー中は、残す・適用・名前の変更ができない
  await app(page, a => a.beginBlurPreview());
  await expect(page.locator('#favAdd')).toBeDisabled();
  await expect(page.locator('#toolNav [data-cmd=addFavorite]')).toBeDisabled();
  await expect(rows(page).first().locator('[data-act=apply]')).toBeDisabled();
  await expect(rows(page).first().locator('[data-act=name]')).toBeDisabled();
  await app(page, a => a.endBlurPreview(false, 0));
  await expect(page.locator('#favAdd')).toBeEnabled();
  await expect(rows(page).first().locator('[data-act=apply]')).toBeEnabled();
  await expect(rows(page).first().locator('[data-act=name]')).toBeEnabled();
});

test('お気に入り: 保存したファイルを開き直しても残っている', async ({ page }) => {
  await boot(page);
  await app(page, a => { a.addFavorite(); a.addFavorite(); a.renameFavorite(a.project.favorites[1].id, 'ふたつめ'); });
  await app(page, a => a.openProjectBytes(a.serialize(), 'x.pukupop', null));
  await openTab(page, 'anim');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1).locator('[data-act=name]')).toHaveValue('ふたつめ');
  await expect(rows(page).first()).toHaveAttribute('aria-current', 'true');
});
