const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dgn-netease-ui-'));
  const install = path.join(root, 'install');
  const packName = '自定义NPC技能包';
  const shortName = 'newitemB';
  await writeJson(path.join(root, 'local', 'Netease', 'MCStudio', 'config', 'app', 'app.conf'), {
    X64EditorPath: path.join(install, 'MCX64Editor', 'editor.exe'),
  });
  await writeJson(path.join(install, 'work', 'account', 'Cpp', 'AddOn', 'project', 'work.mcscfg'), {
    Name: '示例项目',
    UID: 'project',
  });
  await writeJson(path.join(install, 'work', 'account', 'Cpp', 'AddOn', 'project', packName, 'pack_manifest.json'), {});
  await writeJson(path.join(install, 'work', 'account', 'Cpp', 'AddOn', 'project', shortName, 'pack_manifest.json'), {});
  await writeJson(path.join(root, 'game-data', 'MinecraftPE_Netease', 'storge', 'stream', 'users', 'player', 'config', '全局按钮位置.json'), { data: { on: true } });
  const env = { ...process.env, DGN_GAME_HEADLESS: '1', DGN_GAME_DATA_DIR: root };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({ cwd: path.join(__dirname, '..'), args: ['.'], env });
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.getByRole('heading', { name: '存档', exact: true }).waitFor();
    await page.evaluate(() => window.toolkit.call('settings.update', { AppearanceMode: 'Dark' }));
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    });
    await page.locator('.sidebar').getByRole('button', { name: '网易全局配置', exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.pageAnimating);
    await page.locator('main').getByRole('heading', { name: '网易全局配置', exact: true }).waitFor();
    await page.getByRole('heading', { name: '全局按钮位置.json', exact: true }).waitFor();
    const mainBox = await page.locator('main').evaluate((element) => {
      const box = element.getBoundingClientRect();
      const heading = element.querySelector('h1');
      const headingBox = heading ? heading.getBoundingClientRect() : null;
      return { top: box.top, height: box.height, text: element.innerText.slice(0, 240), headingTop: headingBox && headingBox.top, headingHeight: headingBox && headingBox.height };
    });
    assert.ok(mainBox.headingTop >= 0 && mainBox.headingTop < 700, 'config heading is offscreen ' + JSON.stringify(mainBox));
    const visible = await page.locator('main').innerText();
    assert.match(visible, /全局按钮位置.json/);
    assert.ok(visible.trim().length > 10);
    await page.locator('.sidebar').getByRole('button', { name: '模组与资源', exact: true }).click();
    await page.waitForFunction(() => !document.documentElement.dataset.pageAnimating);
    const card = page.getByRole('article', { name: 'MCStudio 模组 ' + packName, exact: true });
    await card.waitFor();
    const measured = await card.locator('h3').evaluate((element) => {
      const box = element.getBoundingClientRect();
      const cardBox = element.closest('article').getBoundingClientRect();
      return { text: element.textContent, width: box.width, card: cardBox.width, scroll: element.scrollWidth, client: element.clientWidth };
    });
    assert.equal(measured.text, packName);
    assert.ok(measured.width > measured.card * 0.7, 'name does not use the card ' + JSON.stringify(measured));
    const shortCard = page.getByRole('article', { name: 'MCStudio 模组 ' + shortName, exact: true });
    const shortMeasured = await shortCard.locator('h3').evaluate((element) => ({ text: element.textContent, client: element.clientWidth, scroll: element.scrollWidth }));
    assert.equal(shortMeasured.text, shortName);
    assert.ok(shortMeasured.scroll <= shortMeasured.client + 1, 'short name clipped ' + JSON.stringify(shortMeasured));
    assert.deepEqual(errors, []);
    console.log('netease page stays visible and MCStudio mod name is fully shown');
  } finally {
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
