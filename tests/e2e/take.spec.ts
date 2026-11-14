import { test, expect, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';

// ?e2e: 自動保存の復元を聞かず、揺れを止めた状態で起動する
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

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);

/** 記録を作る: 記録を始め、つかんで引っぱり、視点を回してから止める(フレームは手で進める) */
async function recordTake(page: Page): Promise<number> {
  return app(page, a => {
    a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } });
    a.startRecording();
    for (let i = 0; i < 20; i++) a.frame(1 / 60); // 何もしていない所(詰められる)
    a.world.grab = { x: 0.2, y: 0, z: 0 }; a.world.grabGains.set(a.doc.layers[0].id, 1);
    for (let i = 0; i < 40; i++) a.frame(1 / 60);
    a.world.grab = null; a.world.grabGains.clear();
    for (let i = 0; i < 60; i++) { a.project.camera.yaw += 0.01; a.frame(1 / 60); }
    for (let i = 0; i < 30; i++) a.frame(1 / 60);
    a.stopRecording();
    return a.takeLength as number;
  });
}

test('操作の記録: R で記録し、L でループ再生。画面を触ると止まり、記録はアンドゥで消せる', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await page.keyboard.press('r');
  expect(await app(page, a => [a.takeState, a.paused])).toEqual(['recording', false]);
  await expect(page.locator('#playBar')).toBeVisible();
  await expect(page.locator('#playBar')).toHaveClass(/recording/);
  // 記録中に右ドラッグで視点を回す
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 20 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(600);
  await page.locator('#view').focus();
  await page.keyboard.press('r');
  expect(await app(page, a => a.takeState)).toBe('idle');
  await expect(page.locator('#playBar')).toBeHidden();
  const len = await app(page, a => a.takeLength);
  expect(len).toBeGreaterThan(0.5);
  await expect(page.locator('#takePlay')).toBeEnabled();

  // ループ再生すると、視点は記録の初めへ動き、画像のほうが記録どおりに動く(画像から見た視点が記録の範囲を動く)
  const yaw0 = await app(page, a => a.project.take.samples[0].camera.yaw);
  await app(page, a => { a.project.camera.yaw = 2; });
  await page.keyboard.press('l');
  expect(await app(page, a => a.takeState)).toBe('playing');
  expect(await app(page, a => a.project.camera.yaw)).toBe(yaw0);
  await expect(page.locator('#playBar')).not.toHaveClass(/recording/);
  await expect(page.locator('#playTime')).toContainText('秒');
  const yaws = await app(page, a => a.project.take.samples.map((s: any) => s.camera.yaw));
  const lo = Math.min(...yaws) - 1e-6, hi = Math.max(...yaws) + 1e-6;
  await expect.poll(() => app(page, a => a.playView.yaw)).not.toBe(yaw0);
  const now = await app(page, a => a.playView.yaw);
  expect(now).toBeGreaterThanOrEqual(lo); expect(now).toBeLessThanOrEqual(hi);
  // 再生中でも、右ドラッグで回す・ホイールでズームする・視点リセットでは止まらず、見る視点だけが動く
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up({ button: 'right' });
  expect(await app(page, a => a.takeState)).toBe('playing');
  expect(await app(page, a => a.project.camera.yaw)).not.toBeCloseTo(yaw0, 3);
  const zoom0 = await app(page, a => a.project.camera.zoom);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => app(page, a => a.project.camera.zoom)).not.toBeCloseTo(zoom0, 3);
  expect(await app(page, a => a.takeState)).toBe('playing');
  await page.keyboard.press('Home');
  expect(await app(page, a => [a.takeState, a.project.camera.yaw])).toEqual(['playing', 0]);
  // ブラシで画面を触ると止まる。視点を動かしていたので、その視点のまま
  await page.mouse.click(box.x + 5, box.y + 5);
  expect(await app(page, a => [a.takeState, a.project.camera.yaw, a.playView])).toEqual(['idle', 0, null]);
  // 視点を動かさずに止めたときは、止めた所の記録の視点になる(画面はそのまま)
  await page.keyboard.press('l');
  await expect.poll(() => app(page, a => a.playView.yaw)).not.toBe(yaw0);
  const stopped = await app(page, a => { const v = a.playView.yaw; a.stopTake(); return [v, a.project.camera.yaw]; });
  expect(stopped[1]).toBe(stopped[0]);

  // 記録はアンドゥで消え、やり直しで戻る
  await page.keyboard.press('Control+z');
  expect(await app(page, a => a.project.take)).toBeNull();
  await expect(page.locator('#takePlay')).toBeDisabled();
  await page.keyboard.press('Control+Shift+z');
  expect(await app(page, a => a.takeLength)).toBeCloseTo(len, 5);
});

test('操作の記録: ボタンで記録・再生・消す。3Dビューの下のバーの停止で止められる', async ({ page }) => {
  await boot(page);
  await page.locator('#pTabs [data-ptab=anim]').click();
  await page.locator('#takeRec').click();
  expect(await app(page, a => a.takeState)).toBe('recording');
  await expect(page.locator('#takeRec')).toContainText('停止');
  await app(page, a => { a.world.grab = { x: 0.2, y: 0, z: 0 }; for (let i = 0; i < 60; i++) a.frame(1 / 60); a.world.grab = null; for (let i = 0; i < 30; i++) a.frame(1 / 60); });
  await page.locator('#playStop').click();
  expect(await app(page, a => a.takeState)).toBe('idle');
  expect(await app(page, a => !!a.project.take)).toBe(true);
  await page.locator('#takePlay').click();
  expect(await app(page, a => a.takeState)).toBe('playing');
  await page.locator('#playStop').click();
  expect(await app(page, a => a.takeState)).toBe('idle');
  await page.locator('#takeClear').click();
  expect(await app(page, a => a.project.take)).toBeNull();
  // 短すぎる記録は残さない
  await page.locator('#takeRec').click();
  await page.locator('#takeRec').click();
  expect(await app(page, a => a.project.take)).toBeNull();
});

test('操作の記録: .pukupop に保存して開き直すと戻る。別のファイルを開くと再生は止まる', async ({ page }) => {
  await boot(page);
  const len = await recordTake(page);
  expect(len).toBeGreaterThan(1);
  const r = await app(page, async a => {
    const bytes = a.serialize(await a.thumbnail());
    a.playTake();
    await a.loadSample();
    const afterLoad = [a.takeState, a.project.take];
    await a.openProjectBytes(bytes, 'take.pukupop', null);
    return { afterLoad, len: a.takeLength, n: a.project.take?.samples.length };
  });
  expect(r.afterLoad).toEqual(['idle', null]);
  expect(r.len).toBeCloseTo(len, 5);
});

test('書き出し: 記録した操作をループ再生すると、1周ぶんのコマ数で継ぎ目がつながる', async ({ page }) => {
  await boot(page);
  const len = await recordTake(page);
  // 2周ぶん書き出して、1周目の初めと2周目の初めがほぼ同じ絵になるか確かめる
  const r = await app(page, async a => {
    const L = a.takeLength, res = await a.exportMedia({ format: 'png', width: 64, height: 48, fps: 30, duration: 2 * L, background: '#ffffff', motion: 'loop' }, () => {}, new AbortController().signal);
    // 中身は base64 の文字列で受け取る(数の配列で受け取ると、要素ごとに変換するので大きいと遅い)
    const b64: string = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(res.blob); });
    return { frames: res.frames, b64 };
  });
  const bytes = Uint8Array.from(atob(r.b64), c => c.charCodeAt(0));
  const per = Math.round(len * 30);
  expect(r.frames).toBe(per * 2);
  const files = unzipSync(bytes);
  const names = Object.keys(files).filter(n => n.endsWith('.png')).sort();
  expect(names.length).toBe(per * 2);
  // PNG のバイト列がほぼ同じ(同じ視点・同じ揺れ)
  const a = files[names[0]], b = files[names[per]];
  expect(Math.abs(a.length - b.length)).toBeLessThan(a.length * 0.05);

  // 書き出しダイアログ: 記録があれば選べて、長さは1周の整数倍に丸める
  await page.keyboard.press('Control+e');
  await expect(page.locator('input[name=exMotion][value=loop]')).toBeEnabled();
  await expect(page.locator('#exTakeLen')).toContainText(len.toFixed(1));
  await app(page, a => { a.clearTake(); });
});

test('キーフレーム: 視点を追加・登録・見る・削除し、つなぎ方と時間を決めて作ると、順に通ってループ再生する。保存すると戻る', async ({ page }) => {
  await boot(page);
  await page.locator('#pTabs [data-ptab=anim]').click();
  await expect(page.locator('#keyMake')).toBeDisabled();
  await page.evaluate(() => { const c = (window as any).popstage.project.camera; c.yaw = 0; c.pitch = 0; c.zoom = 1.5; c.target = { x: 0, y: 0, z: 0 }; });
  await page.locator('#keyAdd').click();
  await page.evaluate(() => { const c = (window as any).popstage.project.camera; c.yaw = 0.8; c.target = { x: 120, y: 0, z: 0 }; });
  await page.locator('#keyAdd').click();
  await page.evaluate(() => { const c = (window as any).popstage.project.camera; c.yaw = 0.3; });
  await page.locator('#keyAdd').click();
  await expect(page.locator('#keyList > li.key-row:not(.key-back)')).toHaveCount(3);
  await expect(page.locator('#keyCount')).toHaveText('3/12');
  // 秒数はフレームの行の間。最後の後は最初へ戻るまでで、薄い「1」の行が続く
  await expect(page.locator('#keyList > li')).toHaveClass([/key-row/, /key-gap/, /key-row/, /key-gap/, /key-row/, /key-gap back/, /key-back/]);
  await expect(page.locator('#keyList > li.key-gap .key-arrow')).toHaveText(['↓', '↓', '↩']);
  await expect(page.locator('#keyList > li.key-back .key-no')).toHaveText('1');
  // 3つ目を消し、2つ目を登録し直す
  await page.locator('#keyList > li.key-row:not(.key-back)').nth(2).locator('[data-act=del]').click();
  await page.evaluate(() => { const c = (window as any).popstage.project.camera; c.yaw = 0.9; });
  await page.locator('#keyList > li.key-row:not(.key-back)').nth(1).locator('[data-act=set]').click();
  // 見る: 1つ目の視点へ
  await page.locator('#keyList > li.key-row:not(.key-back)').nth(0).locator('[data-act=go]').click();
  expect(await app(page, a => [a.project.camera.yaw, a.project.camera.target.x])).toEqual([0, 0]);
  // 時間とつなぎ方(時間は 5 秒までに丸める)
  await page.locator('#keyList > li.key-gap').nth(0).locator('[data-act=sec]').fill('9');
  await page.locator('#keyList > li.key-gap').nth(0).locator('[data-act=sec]').dispatchEvent('change');
  await expect(page.locator('#keyList > li.key-gap').nth(0).locator('[data-act=sec]')).toHaveValue('5.0');
  await page.locator('#keyList > li.key-gap').nth(1).locator('[data-act=sec]').fill('0.5');
  await page.locator('#keyList > li.key-gap').nth(1).locator('[data-act=sec]').dispatchEvent('change');
  await page.locator('#keyList > li.key-row:not(.key-back)').nth(1).locator('[data-act=mode]').selectOption('bounce');
  expect(await app(page, a => a.keyDraft.map((k: any) => [k.view.yaw, k.seconds, k.mode]))).toEqual([[0, 5, 'smooth'], [0.9, 0.5, 'bounce']]);
  await expect(page.locator('#keyTotal')).toHaveText('1周 5.5秒');
  await page.locator('#keyMake').click();
  expect(await app(page, a => [a.takeState, a.takeLength, a.project.take.keys.length])).toEqual(['playing', 5.5, 2]);
  await expect(page.locator('#takeInfo')).toHaveText('再生中');
  // 再生中は画像から見た視点がフレームの間を動き、画像が動くので揺れる
  await expect.poll(() => app(page, a => a.playView.yaw), { timeout: 8000 }).toBeGreaterThan(0.2);
  await expect.poll(() => app(page, a => Math.abs(a.world.displacement(a.doc.layers[0].id).x)), { timeout: 8000 }).toBeGreaterThan(0.001);
  // 再生中に動かした視点は「撮影カメラに戻す」で再生を始めた視点へ戻る(再生は続く)。「停止」で止まる
  await expect(page.locator('#takeCam')).toBeEnabled();
  const start = await app(page, a => a.project.take.samples[0].camera.yaw);
  await app(page, a => { a.project.camera.yaw += 1; });
  await page.locator('#takeCam').click();
  expect(await app(page, a => [a.takeState, a.project.camera.yaw])).toEqual(['playing', start]);
  await expect(page.locator('#keyStop')).toBeEnabled();
  await page.locator('#keyStop').click();
  expect(await app(page, a => a.takeState)).toBe('idle');
  await expect(page.locator('#keyStop')).toBeDisabled();
  await expect(page.locator('#takeCam')).toBeDisabled();
  await app(page, a => a.playTake());
  expect(await app(page, a => a.takeState)).toBe('playing');
  // アンドゥで記録が消えて止まる
  await app(page, a => a.history.undo());
  expect(await app(page, a => [a.takeState, a.project.take])).toEqual(['idle', null]);
  await app(page, a => a.history.redo());
  // 保存して開き直すと、キーフレームも下書きに戻る
  const r = await app(page, async a => {
    const bytes = a.serialize(await a.thumbnail());
    await a.loadSample();
    const cleared = a.keyDraft.length;
    await a.openProjectBytes(bytes, 'keys.pukupop', null);
    return { cleared, keys: a.keyDraft.map((k: any) => [k.seconds, k.mode]), len: a.takeLength };
  });
  expect(r).toEqual({ cleared: 0, keys: [[5, 'smooth'], [0.5, 'bounce']], len: 5.5 });
  await expect(page.locator('#keyList > li.key-row:not(.key-back)')).toHaveCount(2);
});

test('キーフレーム: 行の左端のつまみをドラッグで並べ替えられる。間の秒数は場所に残り、↑↓キー・Esc でも操作できる', async ({ page }) => {
  await boot(page);
  await page.locator('#pTabs [data-ptab=anim]').click();
  await app(page, a => {
    a.keyDraft = [0.1, 0.2, 0.3].map((yaw, i) => ({ view: { yaw, pitch: 0, zoom: 1.5, target: { x: 0, y: 0, z: 0 } }, seconds: i + 1, mode: i === 2 ? 'bounce' : 'smooth' }));
    a.emit('take', a.takeState);
  });
  const rows = page.locator('#keyList > li.key-row:not(.key-back)');
  await expect(rows).toHaveCount(3);
  const yaws = () => app(page, a => a.keyDraft.map((k: any) => k.view.yaw));
  // 3つ目を1つ目の上へ。動かしている間は落とす所に線が出る
  const grip = (i: number) => rows.nth(i).locator('[data-act=drag]');
  const g = (await grip(2).boundingBox())!, top = (await rows.nth(0).boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, top.y + 2, { steps: 8 });
  await expect(rows.nth(2)).toHaveClass(/dragging/);
  await expect(page.locator('#keyList .key-drop')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('#keyList .key-drop')).toHaveCount(0);
  expect(await yaws()).toEqual([0.3, 0.1, 0.2]);
  expect(await app(page, a => a.keyDraft.map((k: any) => [k.seconds, k.mode]))).toEqual([[1, 'bounce'], [2, 'smooth'], [3, 'smooth']]);
  await expect(rows.locator('.key-no')).toHaveText(['1', '2', '3']);
  await expect(rows.nth(0).locator('[data-act=mode]')).toHaveValue('bounce');
  // 動かさずに離すと、並びは変わらない。Esc で取りやめると元のまま
  const g0 = (await grip(0).boundingBox())!;
  await page.mouse.move(g0.x + g0.width / 2, g0.y + g0.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  expect(await yaws()).toEqual([0.3, 0.1, 0.2]);
  const last = (await rows.nth(2).boundingBox())!;
  await page.mouse.down();
  await page.mouse.move(g0.x + g0.width / 2, last.y + last.height - 2, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await yaws()).toEqual([0.3, 0.1, 0.2]);
  // つまみにフォーカスして ↓ で1つ下へ(フォーカスは動いた行のつまみに付いていく)
  await grip(0).focus();
  await page.keyboard.press('ArrowDown');
  expect(await yaws()).toEqual([0.1, 0.3, 0.2]);
  await expect(grip(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  expect(await yaws()).toEqual([0.3, 0.1, 0.2]);
  // 並べ替えた後に再生すると、その順で作り直す
  await page.locator('#keyMake').click();
  expect(await app(page, a => a.project.take.keys.map((k: any) => k.view.yaw))).toEqual([0.3, 0.1, 0.2]);
});
