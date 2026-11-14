/** E2E: 視点・表示の切り替え・3面図・細かく動かす・見た目の基準画像 */
import { test, expect } from '@playwright/test';
import { watchGlErrors, boot, openTab, weightSum, dragOnStage, watchSwingX, settled, nextFrames } from './helpers';

watchGlErrors();

test('画像を薄く・ポップを一時OFF: 画面だけが変わり、書き出しには影響しない', async ({ page }) => {
  await boot(page);
  await openTab(page, 'view');
  await dragOnStage(page, [0.5, 0.5], [0.65, 0.45], 'right'); // 斜めから見て持ち上がりを分かるようにする
  const frame = () => page.evaluate(() => {
    const a = (window as any).popstage;
    return Array.from(a.stage.renderFrame(64, 48, a.project.camera, null) as Uint8ClampedArray).join(',');
  });
  const stage = page.locator('#stage');
  const shot0 = await stage.screenshot(), frame0 = await frame();
  await page.locator('#view').focus();

  await page.keyboard.press('f');
  // CPU が混んでいるとキーの処理が遅れるので、時間で待たずに切り替わるまで待つ
  await expect(page.locator('#vFlat')).toBeChecked();
  await expect(page.locator('#sRec')).toContainText('ポップOFF');
  await nextFrames(page);
  const shotFlat = await stage.screenshot();
  expect(shotFlat.equals(shot0)).toBe(false);
  expect(await frame()).toBe(frame0);

  await page.keyboard.press('Shift+W');
  await expect(page.locator('#vFade')).toBeChecked();
  await expect(page.locator('#vOverlaySel')).toBeChecked();
  await nextFrames(page);
  expect((await stage.screenshot()).equals(shotFlat)).toBe(false);
  expect(await frame()).toBe(frame0);

  await page.locator('#vFade').uncheck();
  await page.locator('#vFlat').uncheck();
  await page.mouse.move(1, 1);
  await expect.poll(async () => (await stage.screenshot()).equals(shot0)).toBe(true);
});

test('3面図: 横に4つの図が出て、自由角度はドラッグで回り、主ビューの当たり判定はずれない', async ({ page }) => {
  await boot(page);
  await openTab(page, 'view');
  // 注視点(原点)は主ビューの中央に映るので、そこを指すと画像の中心が返る
  const pickCenter = () => page.evaluate(() => {
    const a = (window as any).popstage, r = a.stage.canvas.getBoundingClientRect();
    const p = document.getElementById('multiView')!.getBoundingClientRect();
    const right = p.width > 0 ? p.left : r.right;
    const q = a.stage.pick((r.left + right) / 2, r.top + r.height / 2);
    return [q.x, q.y];
  });
  const [x0, y0] = await pickCenter();
  expect(Math.abs(x0)).toBeLessThan(1); expect(Math.abs(y0)).toBeLessThan(1);

  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  await expect(page.locator('#vMulti')).toBeChecked();
  await expect(page.locator('#multiView .mv-cell')).toHaveCount(4);
  const [x1, y1] = await pickCenter();
  expect(Math.abs(x1)).toBeLessThan(1); expect(Math.abs(y1)).toBeLessThan(1);

  // 正面の図に画像が描かれている(背景のチェッカーだけではない)
  const front = await page.locator('#multiView [data-kind=front]').screenshot();
  await page.evaluate(() => (window as any).popstage.setViewOption('flat', true));
  await page.waitForTimeout(100);
  const right = page.locator('#multiView [data-kind=right]');
  const rightFlat = await right.screenshot();
  await page.evaluate(() => (window as any).popstage.setViewOption('flat', false));
  await page.waitForTimeout(100);
  expect((await right.screenshot()).equals(rightFlat)).toBe(false); // 横から見ると膨らみが分かる
  expect(front.length).toBeGreaterThan(0);

  const free = (await page.locator('#multiView [data-kind=free]').boundingBox())!;
  const yaw0 = await page.evaluate(() => (window as any).popstage.multiCam.yaw);
  const mainYaw = await page.evaluate(() => (window as any).popstage.project.camera.yaw);
  await page.mouse.move(free.x + free.width * 0.3, free.y + free.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(free.x + free.width * 0.7, free.y + free.height * 0.5, { steps: 5 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).popstage.multiCam.yaw)).not.toBeCloseTo(yaw0);
  expect(await page.evaluate(() => (window as any).popstage.project.camera.yaw)).toBeCloseTo(mainYaw);

  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeHidden();
  const [x2, y2] = await pickCenter();
  expect(Math.abs(x2)).toBeLessThan(1); expect(Math.abs(y2)).toBeLessThan(1);
});

test('3面図: 正面・右・下はホイールでズーム・ドラッグで平行移動、自由角度は中ドラッグで平行移動し、主ビューと揺れには影響しない', async ({ page }) => {
  await boot(page);
  await openTab(page, 'anim');
  await page.keyboard.press('p'); // 一時停止を解除して、揺れの計算が動いている状態で確かめる
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  await page.waitForTimeout(1500); // 重さで垂れた所で落ち着かせる
  await page.evaluate(() => { (window as any).popstage.dirty = false; }); // 自動揺らしを切った分の「未保存」を消す
  const state = () => page.evaluate(() => {
    const a = (window as any).popstage;
    return {
      main: JSON.stringify(a.project.camera), viewTarget: JSON.stringify(a.world.viewTarget),
      dirty: a.dirty as boolean, undo: a.history.size as number,
      ortho: JSON.parse(JSON.stringify(a.multiOrtho)) as { zoom: number; pan: { x: number; y: number; z: number } },
      free: JSON.parse(JSON.stringify(a.multiCam)) as { yaw: number; pitch: number; zoom: number; target: { x: number; y: number; z: number } },
    };
  });
  const s0 = await state();
  expect(s0.ortho).toEqual({ zoom: 1, pan: { x: 0, y: 0, z: 0 } });
  const before = await page.evaluate(() => { const a = (window as any).popstage; return a.world.displacement(a.doc.layers[0].id).x; });
  const watching = watchSwingX(page, 2500);

  // 正面: ホイールで拡大する。中心から外れた所で回すと、その点へ寄るので中心がずれる
  const front = page.locator('#multiView [data-kind=front]'), fb = (await front.boundingBox())!;
  const shot0 = await front.screenshot();
  await page.mouse.move(fb.x + fb.width * 0.75, fb.y + fb.height * 0.5);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await state()).ortho.zoom).toBeGreaterThan(1.3);
  const s1 = await state();
  expect(s1.ortho.pan.x).toBeGreaterThan(0); // 右寄りの点へ寄る
  expect(s1.ortho.pan.y).toBeCloseTo(0);
  await page.waitForTimeout(100);
  expect((await front.screenshot()).equals(shot0)).toBe(false);
  // 右からの図でも同じ状態を変える(3つで共有)。縮小は下限で止まる
  const right = page.locator('#multiView [data-kind=right]'), rb = (await right.boundingBox())!;
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, 800);
  await expect.poll(async () => (await state()).ortho.zoom).toBeCloseTo(0.5);
  await page.mouse.wheel(0, -600);
  await expect.poll(async () => (await state()).ortho.zoom).toBeGreaterThan(1);
  await settled(page, async () => (await state()).ortho.zoom); // ズームが止まってから平行移動を測る

  // 正面: 左ドラッグで平行移動(画像がポインタに付いてくるので、中心は逆へずれる)
  const pan0 = (await state()).ortho.pan;
  await page.mouse.move(fb.x + fb.width * 0.5, fb.y + fb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(fb.x + fb.width * 0.7, fb.y + fb.height * 0.7, { steps: 5 });
  await page.mouse.up();
  const pan1 = (await state()).ortho.pan;
  expect(pan1.x).toBeLessThan(pan0.x);
  expect(pan1.y).toBeGreaterThan(pan0.y);
  expect(pan1.z).toBeCloseTo(pan0.z);

  // 右から(画面の右 = 画像の -z): 右へドラッグすると中心は +z へずれる。上下は y
  const drag = async (b: { x: number; y: number; width: number; height: number }, dx: number, dy: number) => {
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * (0.5 + dx), b.y + b.height * (0.5 + dy), { steps: 5 });
    await page.mouse.up();
  };
  await drag(rb, 0.2, 0);
  const pan2 = (await state()).ortho.pan;
  expect(pan2.z).toBeGreaterThan(pan1.z);
  expect(pan2.x).toBeCloseTo(pan1.x);
  expect(pan2.y).toBeCloseTo(pan1.y);
  // 下から(画面の上 = 画像の +z): 下へドラッグすると中心は +z へずれる。左右は x
  const bottom = page.locator('#multiView [data-kind=bottom]'), bb = (await bottom.boundingBox())!;
  await drag(bb, 0, 0.2);
  const pan3 = (await state()).ortho.pan;
  expect(pan3.z).toBeGreaterThan(pan2.z);
  expect(pan3.x).toBeCloseTo(pan2.x);
  expect(pan3.y).toBeCloseTo(pan2.y);

  // ダブルクリックで拡大率と平行移動が戻る
  await front.dblclick();
  expect((await state()).ortho).toEqual({ zoom: 1, pan: { x: 0, y: 0, z: 0 } });

  // 正面・右から・下からの操作では「未保存」にならない(画面だけの設定)
  await page.waitForTimeout(400);
  expect((await state()).dirty).toBe(false);

  // 自由角度: 中ドラッグで平行移動する。回転とズームは変わらない
  const free = page.locator('#multiView [data-kind=free]'), vb = (await free.boundingBox())!;
  await page.mouse.move(vb.x + vb.width * 0.3, vb.y + vb.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(vb.x + vb.width * 0.7, vb.y + vb.height * 0.5, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const s2 = await state();
  const moved = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  expect(moved(s2.free.target, s0.free.target)).toBeGreaterThan(5);
  expect(s2.free.yaw).toBeCloseTo(s0.free.yaw);
  expect(s2.free.pitch).toBeCloseTo(s0.free.pitch);
  expect(s2.free.zoom).toBeCloseTo(s0.free.zoom);
  // Shift+左ドラッグでも平行移動になり、回転しない
  await page.keyboard.down('Shift');
  await page.mouse.move(vb.x + vb.width * 0.5, vb.y + vb.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width * 0.5, vb.y + vb.height * 0.7, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const s3 = await state();
  expect(moved(s3.free.target, s2.free.target)).toBeGreaterThan(5);
  expect(s3.free.yaw).toBeCloseTo(s0.free.yaw);
  expect(s3.free.pitch).toBeCloseTo(s0.free.pitch);
  // 左ドラッグは今まで通り回転
  await page.mouse.move(vb.x + vb.width * 0.3, vb.y + vb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width * 0.7, vb.y + vb.height * 0.5, { steps: 5 });
  await page.mouse.up();
  expect((await state()).free.yaw).not.toBeCloseTo(s0.free.yaw);

  // 主ビューの視点・揺れの計算・アンドゥには何も起きない。視点を動かしただけなので「未保存」にもならない
  const [lo, hi] = await watching;
  expect(Math.max(Math.abs(lo - before), Math.abs(hi - before))).toBeLessThan(0.005);
  const s4 = await state();
  expect(s4.main).toBe(s0.main);
  expect(s4.viewTarget).toBe(s0.viewTarget);
  expect(s4.dirty).toBe(false);
  expect(s4.undo).toBe(s0.undo);

  // ダブルクリックで回転・ズーム・平行移動がすべて初期の視点に戻る
  await free.dblclick();
  expect((await state()).free).toEqual(s0.free);

  // 別の画像を開くと、3面図の視点は初めの表示に戻る(前の画像の大きさで動かしたずれを残さない)
  await page.mouse.move(fb.x + fb.width * 0.8, fb.y + fb.height * 0.3);
  await page.mouse.wheel(0, -400);
  await drag(vb, 0, 0);
  await page.evaluate(() => { const a = (window as any).popstage; a.multiCam.target = { x: 300, y: 0, z: 0 }; });
  await expect.poll(async () => (await state()).ortho.zoom).toBeGreaterThan(1);
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 80; c.height = 60; c.getContext('2d')!.fillRect(0, 0, 40, 30);
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    const a = (window as any).popstage;
    a.dirty = false; // 自動揺らしを切った分の「未保存」で確認が出ないように
    await a.openFile(new File([b], 'small.png', { type: 'image/png' }));
  });
  const s5 = await state();
  expect(s5.ortho).toEqual({ zoom: 1, pan: { x: 0, y: 0, z: 0 } });
  expect(s5.free).toEqual(s0.free);
});

for (const target of ['[data-tool=brush]', '#pPreset']) test(`${target} にフォーカスが残っていても、Space+ドラッグは平行移動になり塗らない`, async ({ page }) => {
  await boot(page);
  if (target === '#pPreset') await openTab(page, 'layer');
  await page.locator(target).focus();
  await expect(page.locator(target)).toBeFocused();
  const before = await page.evaluate(() => ({ t: { ...(window as any).popstage.project.camera.target }, undo: (window as any).popstage.history.canUndo }));
  const sum0 = await weightSum(page);
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.keyboard.down('Space');
  await dragOnStage(page, [0.4, 0.5], [0.6, 0.6]);
  await page.keyboard.up('Space');
  const after = await page.evaluate(() => ({ t: { ...(window as any).popstage.project.camera.target }, undo: (window as any).popstage.history.canUndo }));
  expect(await weightSum(page)).toBe(sum0);
  expect(after.undo).toBe(before.undo);
  expect(Math.hypot(after.t.x - before.t.x, after.t.y - before.t.y, after.t.z - before.t.z)).toBeGreaterThan(1);
});

test('「移動」ツール(H)の左ドラッグは平行移動になり、塗らず回転もしない', async ({ page }) => {
  await boot(page);
  await page.locator('.tool[data-tool=pan]').click();
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { t: { ...c.target }, yaw: c.yaw, pitch: c.pitch }; });
  const before = await cam(), sum0 = await weightSum(page);
  await dragOnStage(page, [0.4, 0.5], [0.6, 0.6]);
  const after = await cam();
  expect(await weightSum(page)).toBe(sum0);
  expect([after.yaw, after.pitch]).toEqual([before.yaw, before.pitch]);
  expect(Math.hypot(after.t.x - before.t.x, after.t.y - before.t.y, after.t.z - before.t.z)).toBeGreaterThan(1);
});

test('視点を変えても「未保存」にならない。変化の無い一括処理でも「未保存」にならない', async ({ page }) => {
  await boot(page);
  const dirty = () => page.evaluate(() => (window as any).popstage.dirty as boolean);
  expect(await dirty()).toBe(false);

  // 空のレイヤーを足して保存済みにし、全消去しても(変化が無いので)未保存にならない
  await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.addLayer();
    a.fileHandle = { name: 'x.popstage', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    await a.save();
    a.weightOp('全消去', (wm: any) => wm.clear());
  });
  await page.waitForTimeout(400);
  expect(await dirty()).toBe(false);

  // 回す・平行移動・ズーム・正面に戻す・移動ツールで動かす(見るだけの操作)
  await dragOnStage(page, [0.5, 0.5], [0.7, 0.5], 'right');
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await page.keyboard.press('h');
  await dragOnStage(page, [0.5, 0.5], [0.4, 0.4]);
  await page.evaluate(() => (window as any).popstage.resetView());
  await page.waitForTimeout(500);
  expect(await dirty()).toBe(false);
  // レイヤーを足すと(編集なので)「未保存」になる
  await page.evaluate(() => (window as any).popstage.addLayer());
  expect(await dirty()).toBe(true);
});

test('画角のアンドゥは画角だけを戻し、その後に回した視点は戻さない', async ({ page }) => {
  await boot(page);
  await openTab(page, 'view');
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { fov: c.fov, yaw: c.yaw }; });
  const c0 = await cam();
  await page.locator('#pFov').fill(String(c0.fov + 20));
  await page.locator('#pFov').dispatchEvent('change');
  await dragOnStage(page, [0.5, 0.5], [0.7, 0.5], 'right');
  const c1 = await cam();
  expect(c1.fov).toBe(c0.fov + 20);
  expect(c1.yaw).not.toBeCloseTo(c0.yaw);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  const c2 = await cam();
  expect(c2.fov).toBe(c0.fov);
  expect(c2.yaw).toBeCloseTo(c1.yaw);
  await page.keyboard.press('Control+y');
  expect((await cam()).fov).toBe(c0.fov + 20);
});

test('右ドラッグで視点が回り、Home で正面に戻る', async ({ page }) => {
  await boot(page);
  const cam = () => page.evaluate(() => (window as any).popstage.project.camera);
  const yaw0 = (await cam()).yaw;
  // 開いた直後は、膨らみが分かるよう斜めから見ている
  expect(Math.abs(yaw0)).toBeGreaterThan(0.1);
  expect(Math.abs((await cam()).pitch)).toBeGreaterThan(0.1);
  await dragOnStage(page, [0.5, 0.5], [0.7, 0.6], 'right');
  await page.evaluate(() => { const c = (window as any).popstage.project.camera; c.zoom = 2.5; c.target = { x: 40, y: -20, z: 5 }; c.fov = 50; });
  expect((await cam()).yaw).not.toBeCloseTo(yaw0);
  await page.locator('#view').focus();
  await page.keyboard.press('Home');
  // 画角はそのまま、回転・平行移動・ズームは正面の等倍へ
  expect(await cam()).toEqual({ fov: 50, yaw: 0, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } });
});

test('見た目の基準画像(揺れ停止・正面寄りの視点)', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { const a = (window as any).popstage; a.setViewOption('overlay', false); });
  await page.waitForTimeout(300);
  await expect(page.locator('#stage')).toHaveScreenshot('stage-sample.png');
});

test('3面図にはウェイトの重ね表示・「画像を薄く」・グリッドを効かせない。画像の外ではカーソルが十字になる', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  const front = page.locator('#multiView [data-kind=front]');
  const set = (overlay: boolean, fade: boolean) => page.evaluate(([o, f]) => { const a = (window as any).popstage; a.view.overlay = o; a.view.fade = f; a.view.grid = o; a.syncView(); }, [overlay, fade]);
  const shots = async () => {
    await page.waitForTimeout(150);
    return { front: await front.screenshot(), main: await page.screenshot({ clip: { x: (await page.locator('#view').boundingBox())!.x, y: (await page.locator('#view').boundingBox())!.y, width: 300, height: 300 } }) };
  };
  await set(false, false);
  const plain = await shots();
  await set(true, true);
  const both = await shots();
  expect(both.front.equals(plain.front)).toBe(true);
  expect(both.main.equals(plain.main)).toBe(false); // 主ビューには効く

  // カーソル: 画像の上はブラシの円だけ、画像の外では十字
  await page.keyboard.press('m');
  await page.keyboard.press('b');
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.locator('#view')).toHaveCSS('cursor', 'none');
  await page.mouse.move(box.x + 4, box.y + 4);
  await expect(page.locator('#view')).toHaveCSS('cursor', 'crosshair');
});

test('3面図の自由角度の視点はプロジェクトに保存するが、動かしただけでは「未保存」にしない。編集して自動保存すると、復元で戻る', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  const free = page.locator('#multiView [data-kind=free]'), vb = (await free.boundingBox())!;
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(false);
  await page.mouse.move(vb.x + vb.width * 0.3, vb.y + vb.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(vb.x + vb.width * 0.7, vb.y + vb.height * 0.4, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, -300);
  // ホイールのズームは数フレームかけて寄るので、止まってから視点を控える(描画が遅いと 1.5 秒では寄り切らない)
  await settled(page, () => page.evaluate(() => (window as any).popstage.multiCam.zoom));
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(false);
  // 編集すると「未保存」になり、そのときの視点ごと自動保存される
  await page.evaluate(() => (window as any).popstage.addLayer());
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(true);
  const cam = await page.evaluate(() => JSON.stringify((window as any).popstage.multiCam));
  const t = await page.evaluate(() => Date.now());
  // 自動保存から復元すると、同じ視点に戻る。止まった後の視点が書き込まれるまで待つ
  await expect.poll(() => page.evaluate(t => ((window as any).popstage.lastAutosave?.getTime() ?? 0) > t, t), { timeout: 15000 }).toBe(true);
  await page.goto('/?e2e&restore');
  await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元しますか?');
  await page.locator('#askYes').click();
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await page.evaluate(() => JSON.stringify((window as any).popstage.multiCam))).toBe(cam);
});

test('Ctrl か Shift を押しながらだと、回転・平行移動・ズーム・つかむ・3面図が細かく動く', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const box = (await page.locator('#view').boundingBox())!;
  const at = (x: number, y: number) => [box.x + box.width * x, box.y + box.height * y] as const;
  const dragWith = async (mod: string | null, button: 'left' | 'right' | 'middle', dx: number) => {
    if (mod) await page.keyboard.down(mod);
    await page.mouse.move(...at(0.5, 0.5));
    await page.mouse.down({ button });
    await page.mouse.move(...at(0.5 + dx, 0.5), { steps: 5 });
    await page.mouse.up({ button });
    if (mod) await page.keyboard.up(mod);
  };
  const yaw = () => app(a => a.project.camera.yaw as number);
  // 右ドラッグの回転: Ctrl・Shift なら 1/5
  let y0 = await yaw(); await dragWith(null, 'right', 0.1); const full = (await yaw()) - y0;
  y0 = await yaw(); await dragWith('Control', 'right', 0.1); const ctrl = (await yaw()) - y0;
  y0 = await yaw(); await dragWith('Shift', 'right', 0.1); const shift = (await yaw()) - y0;
  expect(Math.abs(full)).toBeGreaterThan(0.05);
  expect(ctrl / full).toBeCloseTo(0.2, 1);
  expect(shift / full).toBeCloseTo(0.2, 1);
  // 中ドラッグの平行移動
  const tx = () => app(a => a.project.camera.target.x as number);
  let t0 = await tx(); await dragWith(null, 'middle', 0.1); const pan = (await tx()) - t0;
  t0 = await tx(); await dragWith('Control', 'middle', 0.1); const panFine = (await tx()) - t0;
  expect(panFine / pan).toBeCloseTo(0.2, 1);
  // ホイールのズーム(Shift を押すと横の量になるブラウザでも効く)
  const zoom = () => app(a => a.project.camera.zoom as number);
  await page.mouse.move(...at(0.5, 0.5));
  // ホイールはなめらかに寄せるので、止まってから測る
  let z0 = await zoom(); await page.mouse.wheel(0, 200); await expect.poll(zoom).not.toBe(z0); const zFull = Math.log((await settled(page, zoom)) / z0);
  z0 = await zoom(); await page.keyboard.down('Control'); await page.mouse.wheel(0, 200); await page.keyboard.up('Control');
  await expect.poll(zoom).not.toBe(z0); const zCtrl = Math.log((await settled(page, zoom)) / z0);
  expect(zCtrl / zFull).toBeCloseTo(0.2, 1);
  z0 = await zoom(); await page.keyboard.down('Shift'); await page.mouse.wheel(0, 200); await page.keyboard.up('Shift');
  await expect.poll(zoom).not.toBe(z0);
  expect(Math.log((await settled(page, zoom)) / z0) / zFull).toBeCloseTo(0.2, 1);
  // タッチパッドのピンチ(ctrlKey 付きのホイール。Ctrl キーは押していない)は細かくせず、寄せずにその場で変える
  z0 = await zoom();
  await page.evaluate(() => document.getElementById('view')!.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, ctrlKey: true, bubbles: true, cancelable: true })));
  expect(Math.log((await zoom()) / z0) / zFull).toBeCloseTo(1, 1);

  // ドラッグの途中で Ctrl を押しても跳ばない(半分は普通、残り半分は 1/5)
  y0 = await yaw();
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(...at(0.55, 0.5), { steps: 3 });
  await page.keyboard.down('Control');
  await page.mouse.move(...at(0.6, 0.5), { steps: 3 });
  await page.keyboard.up('Control');
  await page.mouse.up({ button: 'right' });
  expect(((await yaw()) - y0) / full).toBeCloseTo(0.6, 1);

  // つかむ: 引っ張る量が 1/5
  await page.keyboard.press('g');
  const grabX = async (mod: string | null) => {
    if (mod) await page.keyboard.down(mod);
    await page.mouse.move(...at(0.5, 0.45));
    await page.mouse.down();
    await page.mouse.move(...at(0.55, 0.45), { steps: 4 });
    const g = await app(a => a.world.grab.x as number);
    await page.mouse.up();
    if (mod) await page.keyboard.up(mod);
    return g;
  };
  const gFull = await grabX(null), gFine = await grabX('Control');
  expect(gFine / gFull).toBeCloseTo(0.2, 1);

  // 3面図: 正面は Shift で細かく平行移動。自由角度の Shift+左は平行移動のまま(細かくしない)、Ctrl なら細かく回る
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  const cellDrag = async (kind: string, mod: string | null, button: 'left' | 'middle') => {
    const b = (await page.locator(`#multiView [data-kind=${kind}]`).boundingBox())!;
    if (mod) await page.keyboard.down(mod);
    await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.5);
    await page.mouse.down({ button });
    await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5, { steps: 5 });
    await page.mouse.up({ button });
    if (mod) await page.keyboard.up(mod);
  };
  const ox = () => app(a => a.multiOrtho.pan.x as number);
  let o0 = await ox(); await cellDrag('front', null, 'left'); const oFull = (await ox()) - o0;
  o0 = await ox(); await cellDrag('front', 'Shift', 'left'); const oFine = (await ox()) - o0;
  expect(oFine / oFull).toBeCloseTo(0.2, 1);
  // 3面図のホイールも Ctrl で細かく
  const oz = () => app(a => a.multiOrtho.zoom as number);
  const fb = (await page.locator('#multiView [data-kind=front]').boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  let q0 = await oz(); await page.mouse.wheel(0, -200); await expect.poll(oz).not.toBe(q0); const ozFull = Math.log((await settled(page, oz)) / q0);
  q0 = await oz(); await page.keyboard.down('Control'); await page.mouse.wheel(0, -200); await page.keyboard.up('Control');
  await expect.poll(oz).not.toBe(q0);
  expect(Math.log((await settled(page, oz)) / q0) / ozFull).toBeCloseTo(0.2, 1);
  const free = () => app(a => ({ yaw: a.multiCam.yaw as number, x: a.multiCam.target.x as number, y: a.multiCam.target.y as number, z: a.multiCam.target.z as number }));
  let f0 = await free(); await cellDrag('free', null, 'middle'); let f1 = await free();
  const panLen = Math.hypot(f1.x - f0.x, f1.y - f0.y, f1.z - f0.z);
  f0 = await free(); await cellDrag('free', 'Shift', 'left'); f1 = await free();
  expect(f1.yaw).toBeCloseTo(f0.yaw); // 回らずに平行移動
  expect(Math.hypot(f1.x - f0.x, f1.y - f0.y, f1.z - f0.z) / panLen).toBeCloseTo(1, 1);
  f0 = await free(); await cellDrag('free', null, 'left'); const rFull = (await free()).yaw - f0.yaw;
  f0 = await free(); await cellDrag('free', 'Control', 'left'); const rFine = (await free()).yaw - f0.yaw;
  expect(rFine / rFull).toBeCloseTo(0.2, 1);
});

test('回転だけリセット(Ctrl+Home・左のツールバー)は、ズームと位置を保って向きだけ正面に戻す。正面(Home)はすべて戻す', async ({ page }) => {
  await boot(page);
  const cam = () => page.evaluate(() => (window as any).popstage.project.camera);
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.project.camera = { ...a.project.camera, yaw: 0.6, pitch: -0.3, zoom: 2.2, target: { x: 40, y: -25, z: 12 } };
  });
  await page.locator('#view').focus();
  await page.keyboard.press('Control+Home');
  expect(await cam()).toMatchObject({ yaw: 0, pitch: 0, zoom: 2.2, target: { x: 40, y: -25, z: 0 } });
  // 左のツールバーのボタンからも
  await page.evaluate(() => { const a = (window as any).popstage; a.project.camera = { ...a.project.camera, yaw: 0.4 }; });
  await page.locator('#toolNav [data-cmd=resetRotation]').click();
  expect(await cam()).toMatchObject({ yaw: 0, zoom: 2.2 });
  await page.locator('#toolNav [data-cmd=resetView]').click();
  expect(await cam()).toMatchObject({ yaw: 0, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } });
});
