import { test, expect, type Page } from '@playwright/test';

async function seedProject(page: Page, name = '浏览器验收项目') {
  const response = await page.request.post('/api/v2/projects', {
    data: { name, ratio: '16:9', duration: 12, generator: 'seedance2.0', brief: 'Playwright deterministic fixture' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).document.id as string;
}

async function openWorkbench(page: Page) {
  await page.goto('/');
  await expect(page.locator('.brand')).toContainText('FRAMEFLOW');
  await expect(page.locator('.project-title')).toContainText('浏览器验收项目');
}

async function switchToProject(page: Page, name: string) {
  await page.getByRole('button', { name: '项目管理' }).click();
  const target = page.locator('.project-manager-row').filter({ hasText: name });
  await expect(target).toBeVisible();
  const switchButton = target.getByRole('button', { name: '切换到此项目' });
  if (await switchButton.count()) await switchButton.click();
  else await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(page.locator('.project-title')).toContainText(name);
}

async function seedAssetBoardProject(page: Page, name = '资产选中验收项目') {
  const projectResponse = await page.request.post('/api/v2/projects', {
    data: { name, ratio: '16:9', duration: 12, generator: 'seedance2.0', brief: 'Asset board selection fixture' },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json() as { document: { id: string }; revision: number };
  let revision = project.revision;

  const assetResponse = await page.request.post(`/api/v2/projects/${project.document.id}/assets`, {
    data: { expected_revision: revision, name: '于村祠堂雨夜', asset_class: 'scene', asset_role: 'environment', grade: 'A+', required: true },
  });
  expect(assetResponse.ok()).toBeTruthy();
  const assetResult = await assetResponse.json() as { revision: number; asset: { id: string } };
  revision = assetResult.revision;

  const storyResponse = await page.request.get(`/api/v2/projects/${project.document.id}/story`);
  expect(storyResponse.ok()).toBeTruthy();
  const storyEnvelope = await storyResponse.json() as { revision: number; story: Record<string, any> };
  const story = storyEnvelope.story;
  story.shots = [{ id: 'SH001', scene: '于村祠堂雨夜', duration: 4, purpose: '验证资产卡选中', camera: '固定广角', action: '无', dialogue: '', status: 'ready', assetRequirements: [{ assetId: assetResult.asset.id, assetClass: 'scene', role: 'asset reference', priority: 'A+', required: true, requiredReadiness: 'production' }] }];
  const saveStoryResponse = await page.request.put(`/api/v2/projects/${project.document.id}/story`, {
    data: { expected_revision: revision, spec: story.spec, script: story.script, scenes: story.scenes, shots: story.shots },
  });
  expect(saveStoryResponse.ok()).toBeTruthy();
  revision = (await saveStoryResponse.json() as { revision: number }).revision;

  const promptResponse = await page.request.post(`/api/v2/projects/${project.document.id}/assets/${assetResult.asset.id}/prompt-versions`, {
    data: { prompt: '一座暴雨夜中的湘西乡村祠堂，空场景，湿石地面，冷蓝夜色与克制暖光。', source: 'e2e', change_reason: '资产画布选中测试' },
  });
  expect(promptResponse.ok()).toBeTruthy();
  return { id: project.document.id, name };
}

async function seedAssetLibraryFilterProject(page: Page, name: string) {
  const projectResponse = await page.request.post('/api/v2/projects', {
    data: { name, ratio: '16:9', duration: 12, generator: 'seedance2.0', brief: 'Asset library scope filter fixture' },
  });
  expect(projectResponse.ok()).toBeTruthy();
  const project = await projectResponse.json() as { document: { id: string }; revision: number };
  let revision = project.revision;
  const assetIds: Record<string, string> = {};
  for (const item of [
    { key: 'character', name: '测试角色', asset_class: 'character', asset_role: 'character' },
    { key: 'scene', name: '测试场景', asset_class: 'scene', asset_role: 'environment' },
    { key: 'prop', name: '测试道具', asset_class: 'prop', asset_role: 'prop' },
    { key: 'fusion', name: '测试融合', asset_class: 'fusion', asset_role: 'fusion' },
  ]) {
    const assetResponse = await page.request.post(`/api/v2/projects/${project.document.id}/assets`, {
      data: { expected_revision: revision, name: item.name, asset_class: item.asset_class, asset_role: item.asset_role, grade: 'B', required: true },
    });
    expect(assetResponse.ok()).toBeTruthy();
    const assetResult = await assetResponse.json() as { revision: number; asset: { id: string } };
    revision = assetResult.revision;
    assetIds[item.key] = assetResult.asset.id;
  }
  return { id: project.document.id, name, assetIds };
}

test.describe('FrameFlow V3 workbench', () => {
  test('API readiness and legacy boundary are explicit', async ({ request }) => {
    const health = await request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    const healthBody = await health.json();
    expect(['ready', 'degraded', 'not_ready']).toContain(healthBody.status);
    expect(healthBody.capabilities).toBeTruthy();
    expect(JSON.stringify(healthBody)).not.toMatch(/OPENAI_API_KEY|sk-[A-Za-z0-9]/);
    const legacy = await request.get('/api/projects');
    expect(legacy.status()).toBe(410);
    const missing = await request.get('/api/v2/projects/does-not-exist');
    expect(missing.status()).toBe(404);
    const invalid = await request.post('/api/v2/projects', { data: { name: 42 } });
    expect(invalid.status()).toBe(422);
    const audit = await request.get('/api/v2/system/data-audit');
    expect(audit.ok()).toBeTruthy();
    expect((await audit.json()).schema_version).toBeGreaterThanOrEqual(15);
  });

  test('project manager and all primary workspaces remain navigable', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await seedProject(page);
    await openWorkbench(page);

    const workspaceNavigation = page.getByRole('navigation');
    for (const label of ['故事与分镜', '资产生产工作区', '后期时间线', '统一资产库', '设置与 Provider']) {
      await workspaceNavigation.getByRole('button', { name: new RegExp(label) }).click();
      await expect(page.locator('.studio-content')).toBeVisible();
    }

    await page.getByRole('button', { name: '项目管理' }).click();
    await expect(page.getByRole('dialog', { name: /项目管理/ })).toBeVisible();
    await page.getByRole('button', { name: /新建项目/ }).click();
    await page.getByPlaceholder('例如：我的新短片').fill('第二个验收项目');
    await page.getByRole('button', { name: '创建并开始编辑' }).click();
    await expect(page.locator('.project-title')).toContainText('第二个验收项目');
    await page.getByRole('button', { name: '项目管理' }).click();
    await expect(page.getByRole('button', { name: '归档' }).first()).toBeVisible();
    const secondRow = page.locator('.project-manager-row').filter({ hasText: '第二个验收项目' });
    await secondRow.getByRole('button', { name: '归档' }).click();
    await expect(page.getByText('已归档项目')).toBeVisible();
    const archivedRow = page.locator('.project-manager-row.archived').filter({ hasText: '第二个验收项目' });
    await archivedRow.getByRole('button', { name: '恢复' }).click();
    await expect(page.locator('.project-manager-row').filter({ hasText: '第二个验收项目' })).toBeVisible();
    await page.locator('.project-manager-row').filter({ hasText: '第二个验收项目' }).getByRole('button', { name: '归档' }).click();
    await page.locator('.project-manager-row.archived').filter({ hasText: '第二个验收项目' }).getByRole('button', { name: '删除' }).click();
    await expect(page.getByRole('dialog', { name: /确认删除项目/ })).toBeVisible();
    await page.getByRole('button', { name: '删除项目' }).click();
    await expect(page.locator('.project-manager-row').filter({ hasText: '第二个验收项目' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('project-manager.png'), fullPage: true });
    expect(errors).toEqual([]);
  });

  test('timeline opens as a shot-first delivery control room', async ({ page }) => {
    await seedProject(page, '时间线交付验收项目');
    await openWorkbench(page);
    await page.getByRole('button', { name: /后期时间线/ }).click();
    await expect(page.locator('.timeline-v2')).toBeVisible();
    await expect(page.getByText('最终整合与交付')).toBeVisible();
    await expect(page.getByRole('heading', { name: '镜头序列' })).toBeVisible();
    await expect(page.locator('.timeline-track-row')).toHaveCount(7);
    await expect(page.getByRole('button', { name: '创建交付包' })).toBeDisabled();
    await expect(page.getByText(/交付阻塞/)).toBeVisible();
  });

  test('paid workflow gate can be cancelled without creating a run', async ({ page }) => {
    await seedProject(page, '费用门禁项目');
    await page.route('**/api/v2/runs/estimate', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ estimate: {
        node_count: 1, paid_node_count: 1, paid_nodes: [{ node_id: 'video-generation', kind: 'video', estimated_cost: 1.2, currency: 'USD', model: 'local-fake' }], estimated_cost: 1.2, currency: 'USD', requires_confirmation: true, impact_node_ids: ['video-generation'],
      } }) });
    });
    let runCreated = false;
    await page.route('**/api/v2/runs', async (route) => { runCreated = true; await route.continue(); });
    await openWorkbench(page);
    await page.getByRole('button', { name: '项目管理' }).click();
    const target = page.locator('.project-manager-row').filter({ hasText: '费用门禁项目' });
    await target.getByRole('button', { name: '切换到此项目' }).click();
    await expect(page.locator('.project-title')).toContainText('费用门禁项目');
    await page.locator('nav button').filter({ hasText: '故事与分镜' }).click();
    await page.getByRole('button', { name: /启动工作流/ }).click();
    await expect(page.getByRole('dialog', { name: /确认付费工作流/ })).toBeVisible();
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog', { name: /确认付费工作流/ })).toHaveCount(0);
    expect(runCreated).toBeFalsy();
  });

  test('asset library scope filters keep categories isolated', async ({ page }, testInfo) => {
    const fixture = await seedAssetLibraryFilterProject(page, `资产范围筛选验收项目-${testInfo.workerIndex}-${Date.now()}`);
    await page.goto('/');
    await switchToProject(page, fixture.name);
    await page.getByRole('button', { name: /统一资产库/ }).click();

    const list = page.locator('.asset-list-item');
    const resultCount = page.locator('.asset-filter-result b').first();
    const scope = page.getByLabel('资产分类范围');
    const status = page.locator('.asset-library-toolbar select[aria-label="资产状态筛选"]');
    const characterId = fixture.assetIds.character;
    const sceneId = fixture.assetIds.scene;
    const propId = fixture.assetIds.prop;
    const fusionId = fixture.assetIds.fusion;

    await scope.selectOption('character');
    await expect(resultCount).toHaveText('1');
    await expect(list).toHaveCount(1);
    await expect(page.locator(`[data-asset-list-id="${characterId}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-asset-list-id="${sceneId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-asset-list-id="${propId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-asset-list-id="${fusionId}"]`)).toHaveCount(0);

    await scope.selectOption('scene-prop');
    await expect(resultCount).toHaveText('2');
    await expect(list).toHaveCount(2);
    await expect(page.locator(`[data-asset-list-id="${sceneId}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-asset-list-id="${propId}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-asset-list-id="${characterId}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-asset-list-id="${fusionId}"]`)).toHaveCount(0);

    await status.selectOption('pending');
    await expect(resultCount).toHaveText('2');
    await expect(list).toHaveCount(2);
    await scope.selectOption('fusion');
    await expect(resultCount).toHaveText('1');
    await expect(list).toHaveCount(1);
    await expect(page.locator(`[data-asset-list-id="${fusionId}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-asset-list-id="${sceneId}"]`)).toHaveCount(0);

    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(scope).toHaveValue('all');
    await expect(status).toHaveValue('all');
    await expect(resultCount).toHaveText('4');
    await expect(list).toHaveCount(4);
  });

  test('asset board selects the exact card and keeps collapse separate', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page);
    const assetName = '于村祠堂雨夜';
    await page.goto('/');
    await switchToProject(page, fixture.name);
    await page.getByRole('button', { name: /资产生产工作区/ }).click();

    const sceneCard = page.locator('.asset-board-card.asset-board-asset').filter({ hasText: assetName }).first();
    const promptCard = page.locator('.asset-board-card.asset-board-prompt-card').filter({ hasText: `资产 Prompt · ${assetName}` }).first();
    await expect(sceneCard).toBeVisible();
    await expect(promptCard).toBeVisible();

    const productionShortcut = sceneCard.locator('.asset-board-production-shortcuts button');
    await expect(productionShortcut).toHaveCount(1);
    await expect(productionShortcut).toHaveText('打开制作操作台');
    await productionShortcut.click();
    await expect(page.locator('.asset-production-panel')).toBeVisible();
    await expect(page.locator('[data-asset-production-upload]')).toBeVisible();

    const assetFlowHeader = page.locator('.asset-board-table-header-cell').filter({ hasText: '镜头资产流' }).first();
    const fusionHeader = page.locator('.asset-board-table-header-cell').filter({ hasText: '镜头融合' }).first();
    const promptBox = await promptCard.boundingBox();
    const assetFlowBox = await assetFlowHeader.boundingBox();
    const fusionBox = await fusionHeader.boundingBox();
    expect(promptBox).not.toBeNull();
    expect(assetFlowBox).not.toBeNull();
    expect(fusionBox).not.toBeNull();
    expect(promptBox!.x + promptBox!.width).toBeLessThanOrEqual(assetFlowBox!.x + assetFlowBox!.width + 1);
    expect(fusionBox!.x).toBeGreaterThanOrEqual(assetFlowBox!.x + assetFlowBox!.width);
    await expect(page.locator('.asset-board-column-shells')).toHaveCount(0);

    const sceneNode = sceneCard.locator('..');
    const promptNode = promptCard.locator('..');
    await sceneCard.click();
    await expect(sceneNode).toHaveClass(/selected/);
    await expect(promptNode).not.toHaveClass(/selected/);
    await expect(page.locator('.asset-production-panel header > span')).toContainText('资产卡');

    const sceneBeforeDrag = await sceneNode.boundingBox();
    expect(sceneBeforeDrag).not.toBeNull();
    const sceneDragStart = { x: sceneBeforeDrag!.x + sceneBeforeDrag!.width / 2, y: sceneBeforeDrag!.y + sceneBeforeDrag!.height / 2 };
    await page.mouse.move(sceneDragStart.x, sceneDragStart.y);
    await page.mouse.down();
    await page.mouse.move(sceneDragStart.x + 180, sceneDragStart.y + 120, { steps: 6 });
    await page.mouse.up();
    const sceneAfterDrag = await sceneNode.boundingBox();
    expect(sceneAfterDrag).not.toBeNull();
    expect(Math.abs(sceneAfterDrag!.x - sceneBeforeDrag!.x)).toBeLessThan(2);
    expect(Math.abs(sceneAfterDrag!.y - sceneBeforeDrag!.y)).toBeLessThan(2);

    const collapseButton = sceneCard.locator('button.asset-board-scope-toggle');
    await collapseButton.click();
    await expect(sceneNode).toHaveClass(/selected/);
    await expect(collapseButton).toHaveAttribute('aria-expanded', 'false');
    await collapseButton.click();
    await expect(sceneNode).toHaveClass(/selected/);
    await expect(collapseButton).toHaveAttribute('aria-expanded', 'true');

    await promptCard.click();
    await expect(promptNode).toHaveClass(/selected/);
    await expect(sceneNode).not.toHaveClass(/selected/);
    await expect(page.locator('.asset-production-panel header > span')).toContainText('Prompt / 图片卡');

    await sceneCard.click({ modifiers: ['Control'] });
    await expect(sceneNode).toHaveClass(/selected/);
    await expect(promptNode).toHaveClass(/selected/);
    await expect(page.locator('.asset-selection-multi-state')).toContainText('已选中多个卡片');
    await sceneCard.click({ modifiers: ['Control'] });
    await expect(sceneNode).not.toHaveClass(/selected/);
    await expect(promptNode).toHaveClass(/selected/);

    await page.getByRole('button', { name: '筛选' }).click();
    const filterDialog = page.getByRole('dialog', { name: '资产工作区筛选' });
    await expect(filterDialog).toBeVisible();
    await expect(page.locator('.asset-board-toolbar').getByRole('button', { name: '新增资产' })).toHaveCount(0);
    await expect(page.locator('.asset-board-toolbar').getByRole('button', { name: '保存画布' })).toHaveCount(0);
    await filterDialog.getByLabel('定位镜头').selectOption('SH001');
    await expect(promptNode).toHaveClass(/selected/);
    await filterDialog.getByLabel('定位镜头').selectOption('');
    await filterDialog.getByLabel('资产类型').selectOption('scene');
    await expect(promptNode).toHaveClass(/selected/);
    await filterDialog.getByLabel('资产类型').selectOption('all');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '布局' }).click();
    const layoutDialog = page.getByRole('dialog', { name: '资产工作区布局' });
    await expect(layoutDialog).toBeVisible();
    await layoutDialog.getByLabel('网格密度').selectOption('compact');
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await layoutDialog.getByRole('button', { name: '恢复默认列宽' }).click();
    await page.keyboard.press('Escape');

    await sceneCard.click();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('dialog', { name: /确认删除逻辑资产/ })).toBeVisible();
    await page.getByRole('button', { name: '删除资产' }).click();
    await expect(page.locator('.asset-board-card.asset-board-asset').filter({ hasText: assetName })).toHaveCount(0);
    await expect(page.locator('.asset-board-card.asset-board-prompt-card').filter({ hasText: `资产 Prompt · ${assetName}` })).toHaveCount(0);
  });

  test('asset board toolbar stays on one row at target viewports', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page, '资产工作区响应式验收项目');
    for (const viewport of [{ width: 1468, height: 945 }, { width: 1280, height: 824 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await switchToProject(page, fixture.name);
      await page.getByRole('button', { name: /资产生产工作区/ }).click();
      const toolbar = page.locator('.asset-board-toolbar');
      await expect(toolbar).toBeVisible();
      const dimensions = await toolbar.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
      await expect(toolbar.getByRole('button', { name: '同步故事与分镜' })).toBeVisible();
      await expect(toolbar.getByRole('button', { name: '筛选' })).toBeVisible();
      await expect(toolbar.getByRole('button', { name: '布局' })).toBeVisible();
    }
  });

  test('audio workbench keeps provider-neutral and QA gates explicit', async ({ page }) => {
    const name = `人物声音闭环验收项目-${Date.now()}`;
    await seedProject(page, name);
    await page.goto('/');
    await switchToProject(page, name);
    await page.getByRole('button', { name: /声音资产工坊/ }).click();
    await expect(page.getByText('人物声音闭环向导')).toBeVisible();
    await expect(page.getByText(/provider-neutral 可继续规划/).first()).toBeVisible();
    await expect(page.getByText(/有文件只代表候选存在/)).toBeVisible();

    await page.getByRole('button', { name: '人物声音' }).click();
    await page.getByLabel('角色 / 旁白 ID').fill('C001');
    await page.getByLabel('声音名称').fill('C001 · Voice Design');
    await page.getByLabel('表演特征').fill('克制，近距离，句尾收住');
    await page.getByLabel('发音风险').fill('专有名词，数字');
    await page.getByRole('button', { name: /建立声音简报并创建三组 audition/ }).click();
    await expect(page.getByText('V001', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('neutral', { exact: true })).toBeVisible();
    await expect(page.getByText('emotional', { exact: true })).toBeVisible();
    await expect(page.getByText('pronunciation-stress', { exact: true })).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 provider-neutral 包' }).click();
    await expect((await download).suggestedFilename()).toContain('voice-auditions.json');
  });

  test('provider-free UI can create scenes, stable shots and core logical assets', async ({ page }) => {
    const name = `纯人工生产闭环-${Date.now()}`;
    const created = await page.request.post('/api/v2/projects', { data: { name, ratio: '16:9', duration: 20, generator: 'manual', brief: 'Provider disabled manual workflow' } });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json() as { document: { id: string } }).document.id;
    const forbiddenProviderPosts: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && (/\/api\/v2\/runs$/.test(path) || /\/story\/runs$/.test(path) || /generate-image$/.test(path) || /asset-prompt-runs$/.test(path) || /fusion-prompt-runs$/.test(path))) forbiddenProviderPosts.push(path);
    });

    await page.goto('/');
    await switchToProject(page, name);
    await page.locator('.studio-sidebar').getByRole('button', { name: /故事与分镜/ }).click();
    await page.getByRole('button', { name: '＋ 新增场景' }).click();
    const sceneRow = page.locator('.manual-scene-row').last();
    await sceneRow.getByLabel('场景名称').fill('人工场景 A');
    await sceneRow.getByLabel('空间/说明').fill('无 Provider 手工建立');
    for (let index = 0; index < 3; index += 1) await page.getByRole('button', { name: '＋ 新增镜头' }).click();
    const shotRows = page.locator('.shot-row');
    await expect(shotRows).toHaveCount(3);
    const initialIds = await shotRows.locator('.shot-id b').allTextContents();
    expect(new Set(initialIds).size).toBe(3);
    await shotRows.nth(1).getByRole('button', { name: '删除' }).click();
    await expect(shotRows).toHaveCount(2);
    await shotRows.first().getByRole('button', { name: '复制' }).click();
    await shotRows.first().getByRole('button', { name: '拆分' }).click();
    await expect(shotRows).toHaveCount(4);
    await page.getByRole('button', { name: '保存镜头表' }).click();
    await expect(page.locator('.save-state')).toContainText('故事与分镜已保存');
    const story = await (await page.request.get(`/api/v2/projects/${projectId}/story`)).json() as { story: { scenes: Array<Record<string, unknown>>; shots: Array<{ id: string }> } };
    expect(story.story.scenes.some((scene) => scene.name === '人工场景 A')).toBeTruthy();
    expect(story.story.shots.map((shot) => shot.id)).toContain(initialIds[2]);
    expect(story.story.shots.map((shot) => shot.id)).not.toContain(initialIds[1]);
    expect(new Set(story.story.shots.map((shot) => shot.id)).size).toBe(4);

    const classes = ['character', 'scene', 'prop', 'fusion', 'audio'];
    for (const assetClass of classes) {
      await page.locator('.studio-sidebar').getByRole('button', { name: /统一资产库/ }).click();
      await page.getByRole('button', { name: '＋ 新建逻辑资产' }).click();
      const dialog = page.getByRole('dialog', { name: '新增逻辑资产' });
      await dialog.getByPlaceholder(/例如：陈继业/).fill(`Manual ${assetClass}`);
      await dialog.getByLabel('资产类型').selectOption(assetClass);
      await dialog.getByRole('button', { name: '创建资产' }).click();
      await expect(dialog).toBeHidden();
    }
    const project = await (await page.request.get(`/api/v2/projects/${projectId}`)).json() as { document: { assets: Array<{ assetClass: string }> } };
    expect(new Set(project.document.assets.map((asset) => asset.assetClass))).toEqual(new Set(classes));
    expect(forbiddenProviderPosts).toEqual([]);
  });
});
