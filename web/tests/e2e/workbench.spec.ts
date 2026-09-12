import { test, expect, type Page } from '@playwright/test';

async function seedProject(page: Page, name = '浏览器验收项目'): Promise<string> {
  const response = await page.request.post('/api/v2/projects', {
    data: { name, ratio: '16:9', duration: 12, generator: 'seedance2.0', brief: 'Playwright deterministic fixture' },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).document.id as string;
}

async function openWorkbench(page: Page, expectedProjectName = '浏览器验收项目', projectId?: string) {
  await page.goto('/');
  await expect(page.locator('.brand')).toContainText('FRAMEFLOW');
  await expect.poll(async () => (await page.locator('.project-title').textContent()) || '').not.toBe('尚未选择项目');
  if (!((await page.locator('.project-title').textContent()) || '').includes(expectedProjectName)) {
    await switchToProject(page, expectedProjectName, projectId);
  }
  await expect(page.locator('.project-title')).toContainText(expectedProjectName);
}

async function switchToProject(page: Page, name: string, projectId?: string) {
  const currentTitle = (await page.locator('.project-title').textContent()) || '';
  if (currentTitle.includes(name)) return;
  const managerButton = page.getByRole('button', { name: '项目管理', exact: true });
  const dialog = page.getByRole('dialog', { name: /项目管理/ });
  if (!(await dialog.isVisible().catch(() => false))) { await expect(managerButton).toBeEnabled(); await managerButton.click(); }
  await expect(dialog).toBeVisible();
  const target = projectId ? page.locator(`.project-manager-row[data-project-id="${projectId}"]`) : page.locator('.project-manager-row').filter({ hasText: name }).first();
  await expect(target).toBeVisible();
  const switchButton = target.getByRole('button', { name: '切换到此项目' });
  if (await switchButton.count()) await switchButton.click();
  else await page.getByRole('button', { name: '关闭项目管理' }).click();
  await expect(dialog).toHaveCount(0);
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
  return { id: project.document.id, name, assetId: assetResult.asset.id };
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
    for (const label of ['故事与分镜', '资产生产工作区', '声音资产工坊', '后期时间线', '设置与 Provider']) {
      await workspaceNavigation.getByRole('button', { name: new RegExp(label) }).click();
      await expect(page.locator('.studio-content')).toBeVisible();
    }
    await expect(workspaceNavigation.getByRole('button', { name: /统一资产库/ })).toHaveCount(0);
    await expect(workspaceNavigation.getByRole('button', { name: /人物与角色/ })).toHaveCount(0);
    await expect(workspaceNavigation.getByRole('button', { name: /场景与道具/ })).toHaveCount(0);
    await expect(workspaceNavigation.getByRole('button', { name: /融合与候选/ })).toHaveCount(0);

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

  test('MiniMax settings keep China and Global credentials in separate slots', async ({ page }) => {
    const projectName = `MiniMax 双区域凭据验收项目-${Date.now()}`;
    const projectId = await seedProject(page, projectName);
    const removableProviderName = '临时可删除 Agent';
    const removableProviderId = `e2e-removable-agent-${Date.now()}`;
    const removableProvider = await page.request.post('/api/v2/settings/providers', {
      data: { id: removableProviderId, provider_type: 'opencode', display_name: removableProviderName, base_url: 'http://127.0.0.1:4096', capabilities: ['orchestrator'], enabled: true, model_config: {} },
    });
    expect(removableProvider.ok()).toBeTruthy();
    const bound = await page.request.put('/api/v2/settings/capability-bindings', {
      data: { capability: 'orchestrator', provider_profile_id: removableProviderId, model: null },
    });
    expect(bound.ok()).toBeTruthy();
    await openWorkbench(page, projectName, projectId);
    await page.getByRole('button', { name: '设置与 Provider' }).click();
    await expect(page.getByRole('heading', { name: '设置与 Provider 控制面' })).toBeVisible();
    await expect(page.locator('.settings-provider-item').filter({ hasText: /OpenAI/i })).toHaveCount(0);
    await expect(page.locator('.settings-presets button').filter({ hasText: /OpenAI/i })).toHaveCount(0);
    const removableProviderRow = page.locator('.settings-provider-item').filter({ hasText: removableProviderName });
    await expect(page.getByRole('button', { name: 'Provider 管理' })).toHaveAttribute('aria-pressed', 'false');
    await expect(removableProviderRow.getByRole('button', { name: `删除 ${removableProviderName}` })).toHaveCount(0);
    await page.getByRole('button', { name: 'Provider 管理' }).click();
    await expect(page.getByRole('button', { name: 'Provider 管理' })).toHaveAttribute('aria-pressed', 'true');
    await expect(removableProviderRow.getByRole('button', { name: `删除 ${removableProviderName}` })).toBeVisible();
    const providerCount = await page.locator('.settings-provider-item').count();
    await expect(page.locator('.settings-provider-delete')).toHaveCount(providerCount);
    await expect(page.locator('.settings-routing')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '当前运行路由' })).toBeVisible();
    await expect(page.locator('.settings-route-summary')).toContainText(removableProviderName);
    await expect(page.locator('.settings-route-summary')).toContainText('MiniMax TTS');
    await expect(page.locator('.settings-presets button').filter({ hasText: 'MiniMax TTS' })).toContainText('实际链接：');
    await expect(page.locator('.settings-presets button').filter({ hasText: 'OpenCode Go Plan Agent' })).toContainText('实际链接：');
    await removableProviderRow.getByRole('button', { name: `删除 ${removableProviderName}` }).click();
    const deleteProviderDialog = page.getByRole('dialog', { name: '确认删除 Provider' });
    await expect(deleteProviderDialog).toBeVisible();
    await deleteProviderDialog.getByRole('button', { name: '删除 Provider' }).click();
    await expect(removableProviderRow).toHaveCount(0);
    await page.getByRole('button', { name: 'Provider 管理' }).click();
    await expect(page.locator('.settings-provider-delete')).toHaveCount(0);
    await expect(page.locator('.settings-route-summary')).toContainText('OpenCode Go Plan Agent');
    await expect(page.locator('.settings-presets')).toContainText('删除配置后仍可重新添加');
    await expect(page.locator('.settings-minimax-credentials')).toContainText('MiniMax TTS 接入');
    await expect(page.getByLabel('默认 TTS 模型')).toHaveCount(1);
    await expect(page.locator('.settings-agent-form').filter({ hasText: 'MiniMax TTS 模型' })).toHaveCount(0);
    await expect(page.locator('.settings-minimax-region-card')).toHaveCount(2);
    await expect(page.locator('.settings-minimax-region-card').filter({ hasText: '中国区' })).toBeVisible();
    await expect(page.locator('.settings-minimax-region-card').filter({ hasText: '国际区' })).toBeVisible();
    await expect(page.getByLabel('中国区 MiniMax API Key')).toBeVisible();
    await expect(page.getByLabel('国际区 MiniMax API Key')).toBeVisible();
    await expect(page.locator('option[value="MINIMAX_CN_API_KEY"]')).toHaveCount(1);
    await expect(page.locator('option[value="MINIMAX_GLOBAL_API_KEY"]')).toHaveCount(1);
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
    const projectId = await seedProject(page, '费用门禁项目');
    await page.route('**/api/v2/runs/estimate', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ estimate: {
        node_count: 1, paid_node_count: 1, paid_nodes: [{ node_id: 'video-generation', kind: 'video', estimated_cost: 1.2, currency: 'USD', model: 'local-fake' }], estimated_cost: 1.2, currency: 'USD', requires_confirmation: true, impact_node_ids: ['video-generation'],
      } }) });
    });
    let runCreated = false;
    await page.route('**/api/v2/runs', async (route) => { runCreated = true; await route.continue(); });
    await openWorkbench(page);
    await page.getByRole('button', { name: '项目管理' }).click();
    const target = page.locator(`.project-manager-row[data-project-id="${projectId}"]`);
    await target.getByRole('button', { name: '切换到此项目' }).click();
    await expect(page.locator('.project-title')).toContainText('费用门禁项目');
    await page.locator('nav button').filter({ hasText: '故事与分镜' }).click();
    await page.getByRole('button', { name: /启动工作流/ }).click();
    await expect(page.getByRole('dialog', { name: /确认付费工作流/ })).toBeVisible();
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('dialog', { name: /确认付费工作流/ })).toHaveCount(0);
    expect(runCreated).toBeFalsy();
  });

  test('asset production workspace replaces the standalone asset section', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page, `资产生产唯一入口验收项目-${Date.now()}`);
    await page.goto('/');
    await switchToProject(page, fixture.name, fixture.id);
    const navigation = page.locator('.studio-sidebar nav');
    await expect(navigation.getByRole('button', { name: /统一资产库/ })).toHaveCount(0);
    await expect(navigation.getByRole('button', { name: /人物与角色/ })).toHaveCount(0);
    await expect(navigation.getByRole('button', { name: /场景与道具/ })).toHaveCount(0);
    await expect(navigation.getByRole('button', { name: /融合与候选/ })).toHaveCount(0);

    await navigation.getByRole('button', { name: /资产生产工作区/ }).click();
    await expect(page.locator('.asset-board-toolbar')).toBeVisible();
    await expect(page.locator('.asset-library-v3')).toHaveCount(0);
    await expect(page.locator('.asset-board-card.asset-board-asset').filter({ hasText: '于村祠堂雨夜' }).first()).toBeVisible();
  });

  test('asset board selects the exact card and keeps collapse separate', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page);
    const assetName = '于村祠堂雨夜';
    await page.goto('/');
    await switchToProject(page, fixture.name, fixture.id);
    await page.getByRole('button', { name: /资产生产工作区/ }).click();

    const sceneCard = page.locator('.asset-board-card.asset-board-asset').filter({ hasText: assetName }).first();
    const promptCard = page.locator('.asset-board-card.asset-board-prompt-card').filter({ hasText: `资产 Prompt · ${assetName}` }).first();
    await expect(sceneCard).toBeVisible();

    const productionShortcut = sceneCard.locator('.asset-board-production-shortcuts button');
    await expect(productionShortcut).toHaveCount(1);
    await expect(productionShortcut).toHaveText('打开制作操作台');
    await productionShortcut.click();
    await expect(page.locator('.asset-production-panel')).toBeVisible();
    await expect(page.locator('[data-asset-production-upload]')).toBeVisible();
    await expect(promptCard).toBeVisible();

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

    await promptCard.locator('.asset-board-card-meta > span').click();
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

  test('asset prompt actions execute and operator input can be opened and closed', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page, `资产 Prompt 控件验收项目-${Date.now()}`);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8791' });
    await page.setViewportSize({ width: 1010, height: 799 });
    await openWorkbench(page, fixture.name, fixture.id);
    await page.getByRole('button', { name: /资产生产工作区/ }).click();

    const sceneCard = page.locator('.asset-board-card.asset-board-asset').filter({ hasText: '于村祠堂雨夜' }).first();
    await expect(sceneCard).toBeVisible();
    await sceneCard.locator('.asset-board-production-shortcuts button').click();
    const promptCard = page.locator('.asset-board-card.asset-board-prompt-card').filter({ hasText: '资产 Prompt · 于村祠堂雨夜' }).first();
    await expect(promptCard).toBeVisible();

    await promptCard.getByRole('button', { name: '重写 Prompt' }).click();
    const rewriteDialog = page.getByRole('dialog', { name: '重写 Prompt' });
    await expect(rewriteDialog).toBeVisible();
    await rewriteDialog.getByRole('button', { name: '取消' }).click();
    await expect(rewriteDialog).toHaveCount(0);

    await promptCard.getByRole('button', { name: '复制 Prompt' }).click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('Image Execution Prompt');

    await promptCard.getByRole('button', { name: '通过 Prompt QA' }).click();
    const qaDialog = page.getByRole('dialog', { name: '确认 Prompt QA' });
    await expect(qaDialog).toBeVisible();
    await qaDialog.getByRole('button', { name: '取消' }).click();
    await expect(qaDialog).toHaveCount(0);

    const operatorIdea = promptCard.locator('details.asset-board-operator-idea');
    await operatorIdea.locator('summary').click();
    await expect(operatorIdea).toHaveAttribute('open', '');
    await expect(operatorIdea).toContainText('把我的想法整合进当前 Prompt');
    await expect(operatorIdea.getByRole('button', { name: '关闭补充想法' })).toBeVisible();
    const ideaInput = operatorIdea.getByRole('textbox', { name: /补充 .* 的创作意图/ });
    const [storySnapshotResponse, librarySnapshotResponse, boardSnapshotResponse] = await Promise.all([
      page.request.get(`/api/v2/projects/${fixture.id}/story`),
      page.request.get(`/api/v2/projects/${fixture.id}/assets`),
      page.request.get(`/api/v2/projects/${fixture.id}/asset-board`),
    ]);
    const storySnapshot = await storySnapshotResponse.json();
    const librarySnapshot = await librarySnapshotResponse.json();
    const boardSnapshot = await boardSnapshotResponse.json();
    let operatorIdeaPayload = '';
    await page.route(`**/api/v2/projects/${fixture.id}/asset-prompt-runs`, async (route) => {
      const body = route.request().postDataJSON() as { operator_idea?: string };
      operatorIdeaPayload = String(body.operator_idea || '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          revision: Number(storySnapshot.revision || 1) + 1,
          story: storySnapshot,
          library: librarySnapshot,
          asset_board: boardSnapshot,
          run: { id: 'ASSET_PROMPT_OPERATOR_IDEA_E2E', promptCards: [{ id: fixture.assetId, prompt: '整合后的 Prompt 草稿', promptPack: {}, promptQuality: null }], fusionPlans: [] },
        }),
      });
    });
    const idea = '压低雨水反射，保持当前资产 ID 和唯一水纹。';
    await ideaInput.fill(idea);
    await expect(operatorIdea.getByRole('button', { name: 'AI 整合为 Prompt 草稿' })).toBeEnabled();
    await operatorIdea.getByRole('button', { name: 'AI 整合为 Prompt 草稿' }).click();
    await expect.poll(() => operatorIdeaPayload).toBe(idea);
    const draftDialog = page.getByRole('dialog', { name: '补充想法已整合' });
    await expect(draftDialog).toBeVisible();
    await draftDialog.getByRole('button', { name: '暂不保存' }).click();
    await expect(draftDialog).toHaveCount(0);
    await operatorIdea.getByRole('button', { name: '关闭补充想法' }).click();
    await expect(operatorIdea).not.toHaveAttribute('open');
  });

  test('story stage gates asset prompt generation behind per-asset creative intent', async ({ page }) => {
    const name = `逐资产创作意图验收项目-${Date.now()}`;
    const created = await page.request.post('/api/v2/projects', {
      data: { name, ratio: '16:9', duration: 12, generator: 'seedance2.0', brief: 'Asset intent pre-prompt gate fixture' },
    });
    expect(created.ok()).toBeTruthy();
    const project = await created.json() as { document: { id: string }; revision: number };
    const projectId = project.document.id;
    let revision = project.revision;
    const assetIds: Record<string, string> = {};
    for (const asset of [
      { key: 'character', name: 'PILOT-01', role: '高机动人形机甲专属驾驶员', grade: 'A+' },
      { key: 'scene', name: '同步机库', role: '机甲同步机库', grade: 'A' },
      { key: 'prop', name: '青蓝同步手套', role: '驾驶员触觉反馈装置', grade: 'A' },
    ]) {
      const response = await page.request.post(`/api/v2/projects/${projectId}/assets`, {
        data: { expected_revision: revision, name: asset.name, asset_class: asset.key, asset_role: asset.role, grade: asset.grade, required: true },
      });
      expect(response.ok()).toBeTruthy();
      const payload = await response.json() as { revision: number; asset: { id: string } };
      revision = payload.revision;
      assetIds[asset.key] = payload.asset.id;
    }
    const storyResponse = await page.request.get(`/api/v2/projects/${projectId}/story`);
    expect(storyResponse.ok()).toBeTruthy();
    const storyEnvelope = await storyResponse.json() as { revision: number; story: Record<string, any> };
    const story = storyEnvelope.story;
    story.scenes = [{ id: 'S001', name: '同步机库', description: '宽阔的机甲同步机库。', interiorExterior: '内景', timeOfDay: '夜', location: '同步机库', characterIds: [assetIds.character], propIds: [assetIds.prop], narrativeFunction: '建立角色与机甲关系', emotion: '克制期待', visualAnchors: ['青蓝能源光'], spatialGeography: '前景平台，中景驾驶员，背景机甲。', materialEvidence: '金属地面反光。', lightingCausality: '能源光照亮角色面部。', soundscape: '低频机械同步声。', productionDifficulty: 'high', relevantShots: ['SH001'] }];
    story.shots = [{ id: 'SH001', scene: 'S001', duration: 4, purpose: '建立角色与机甲关系', size: '中景', camera: '平视固定', action: '角色触碰机甲手指', visibleEvent: '青蓝光亮起', eventConsequence: '角色眼神出现轻微期待', subjectFocus: '接触点', performance: '安静、专业', dialogue: '', narration: '', sound: '低频同步声', environment: '机库夜景', spatialGeography: '角色位于机甲手指前方。', materialEvidence: '白色手套与金属产生接触反光。', lightingCausality: '能源光照亮角色面部。', cameraExecution: '平视固定', atmosphereBehavior: '少量散热雾', generationMethod: 'reference_to_video', difficulty: 'high', risks: [], referenceRoles: [], assetRequirements: [
      { assetId: assetIds.character, assetClass: 'character', role: '主体角色', priority: 'A+', required: true, requiredReadiness: 'production' },
      { assetId: assetIds.scene, assetClass: 'scene', role: '环境', priority: 'A', required: true, requiredReadiness: 'production' },
      { assetId: assetIds.prop, assetClass: 'prop', role: '触觉反馈装置', priority: 'A', required: true, requiredReadiness: 'production' },
    ] }];
    const savedStory = await page.request.put(`/api/v2/projects/${projectId}/story`, {
      data: { expected_revision: revision, spec: story.spec, script: 'PILOT-01 在同步机库触碰机甲手指。', scenes: story.scenes, shots: story.shots },
    });
    expect(savedStory.ok()).toBeTruthy();
    revision = (await savedStory.json() as { revision: number }).revision;
    for (const asset of [
      { name: 'S001 镜头融合规划', asset_class: 'fusion', asset_role: 'shot-fusion' },
      { name: 'SH01 尾帧首帧连续性', asset_class: 'fusion', asset_role: 'shot_reference' },
      { name: 'A01 机库低频环境声', asset_class: 'audio', asset_role: 'ambience' },
    ]) {
      const response = await page.request.post(`/api/v2/projects/${projectId}/assets`, {
        data: { expected_revision: revision, name: asset.name, asset_class: asset.asset_class, asset_role: asset.asset_role, grade: 'A', required: false },
      });
      expect(response.ok()).toBeTruthy();
      revision = (await response.json() as { revision: number }).revision;
    }

    await page.setViewportSize({ width: 1010, height: 799 });
    await openWorkbench(page, name, projectId);
    await page.getByRole('button', { name: '▥ 故事与分镜' }).click();
    const intentEntry = page.getByRole('button', { name: '资产创作意图' });
    const promptEntry = page.getByRole('button', { name: '生成资产 Prompt' });
    await expect(intentEntry).toBeEnabled();
    await expect(promptEntry).toBeEnabled();
    await intentEntry.click();
    const dialog = page.getByRole('dialog', { name: '资产创作意图' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('待确认基础资产');
    await expect(dialog).toContainText('角色资产');
    await expect(dialog).toContainText('环境资产');
    await expect(dialog).toContainText('道具 / 物品资产');
    await expect(dialog).toContainText('系统后续规划');
    await expect(dialog.locator('.asset-intent-card')).toHaveCount(3);
    await expect(dialog.locator('.asset-intent-system-plan')).toHaveCount(3);
    await expect(dialog.getByRole('button', { name: '确认资产意图并生成资产 Prompt' })).toBeDisabled();
    await expect(dialog).toContainText('已确认基础资产 0 / 3 项');

    const characterCard = dialog.locator('.asset-intent-card').filter({ hasText: assetIds.character });
    const sceneCard = dialog.locator('.asset-intent-card').filter({ hasText: assetIds.scene });
    const propCard = dialog.locator('.asset-intent-card').filter({ hasText: assetIds.prop });
    await characterCard.getByRole('textbox', { name: `${assetIds.character} 资产创作想法` }).fill('冷静、温柔且专业；黑色中短发，冷白驾驶服，青蓝腕部链接装置。');
    await dialog.getByRole('button', { name: '保存草稿' }).click();
    await expect(characterCard).toContainText('草稿已保存');
    await expect(dialog).toContainText('已确认基础资产 0 / 3 项');
    await sceneCard.getByRole('button', { name: '按剧本生成' }).click();
    await propCard.getByRole('button', { name: '暂不补充' }).click();
    await expect(dialog).toContainText('已确认基础资产 2 / 3 项');
    await expect(dialog.getByRole('button', { name: '确认资产意图并生成资产 Prompt' })).toBeDisabled();
    await characterCard.getByRole('button', { name: '按剧本生成' }).click();
    await expect(dialog).toContainText('已确认基础资产 3 / 3 项');
    await expect(dialog.getByRole('button', { name: '确认资产意图并生成资产 Prompt' })).toBeEnabled();

    let generationBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v2/projects/${projectId}/asset-prompt-runs`, async (route) => {
      generationBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: '验收环境未配置编排 Provider。' }) });
    });
    await dialog.getByRole('button', { name: '确认资产意图并生成资产 Prompt' }).click();
    await expect(dialog.getByRole('alert')).toContainText('资产 Prompt 生成未完成');
    expect(generationBody).toMatchObject({ asset_intent_version: expect.any(Number) });
  });

  test('global shortcuts remain available from the asset workbench', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page, `资产工作区快捷键验收项目-${Date.now()}`);
    await page.goto('/');
    await switchToProject(page, fixture.name, fixture.id);
    await page.getByRole('button', { name: /资产生产工作区/ }).click();

    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('dialog', { name: '跳转到工作台功能' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '跳转到工作台功能' })).toHaveCount(0);

    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: '工作台快捷键' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '工作台快捷键' })).toHaveCount(0);

    await page.keyboard.press('Alt+1');
    await expect(page.locator('h1.a11y-page-title')).toHaveText('项目总览');
    await page.keyboard.press('Alt+2');
    await expect(page.locator('h1.a11y-page-title')).toHaveText('故事与分镜');
    await page.keyboard.press('Alt+3');
    await expect(page.locator('h1.a11y-page-title')).toHaveText('资产生产工作区');
    await page.keyboard.press('Alt+4');
    await expect(page.locator('h1.a11y-page-title')).toHaveText('后期时间线');
    await page.keyboard.press('Alt+5');
    await expect(page.locator('h1.a11y-page-title')).toHaveText('声音资产工坊');
    await page.keyboard.press('Alt+6');
    await expect(page.locator('h1.a11y-page-title')).toHaveText('设置与 Provider');
    await page.keyboard.press('Alt+3');
    await expect(page.locator('h1.a11y-page-title')).toHaveText('资产生产工作区');
    await expect(page.locator('.asset-board-toolbar')).toBeVisible();

    await page.keyboard.press('ControlOrMeta+F');
    await expect(page.locator('#asset-board-directory-search')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#asset-board-directory-search')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Z');
    await expect(page.locator('.save-state')).toContainText('资产画布没有可撤销的编辑');
    await page.keyboard.press('ControlOrMeta+Shift+Z');
    await expect(page.locator('.save-state')).toContainText('资产画布没有可重做的编辑');
    await page.keyboard.press('ControlOrMeta+C');
    await expect(page.locator('.save-state')).toContainText('请先选择一个资产或镜头节点');
    await page.keyboard.press('ControlOrMeta+X');
    await expect(page.locator('.save-state')).toContainText('请先选择一个资产或镜头节点');
    await page.keyboard.press('ControlOrMeta+V');
    await expect(page.locator('.save-state')).toContainText('资产剪贴板为空');

    let assetBoardSaveRequests = 0;
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/asset-board')) assetBoardSaveRequests += 1;
    });
    await expect(page.locator('.asset-board-toolbar')).toBeVisible();
    await expect(page.locator('.asset-board-wrap .canvas-loading')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+S');
    await expect.poll(() => assetBoardSaveRequests).toBe(1);

    await page.keyboard.press('ControlOrMeta+Shift+A');
    await expect(page.getByRole('dialog', { name: 'FRAMEFLOW AI Agent 工作台' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'FRAMEFLOW AI Agent 工作台' })).toHaveCount(0);
  });

  test('rendered workbench text can be selected and copied from page and canvas', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page, `文本复制验收项目-${Date.now()}`);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8791' });
    await page.goto('/');
    await switchToProject(page, fixture.name, fixture.id);

    const homeHeading = page.locator('section.home-view .home-heading h1');
    await expect(homeHeading).toHaveText('项目首页');
    await homeHeading.selectText();
    await page.keyboard.press('ControlOrMeta+C');
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('项目首页');

    await page.getByRole('button', { name: /资产生产工作区/ }).click();
    const sceneCard = page.locator('.asset-board-card.asset-board-asset').filter({ hasText: '于村祠堂雨夜' }).first();
    await expect(sceneCard).toBeVisible();
    await sceneCard.selectText();
    await page.keyboard.press('ControlOrMeta+C');
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('于村祠堂雨夜');
  });

  test('asset board toolbar stays on one row at target viewports', async ({ page }) => {
    const fixture = await seedAssetBoardProject(page, '资产工作区响应式验收项目');
    for (const viewport of [{ width: 1468, height: 945 }, { width: 1280, height: 824 }]) {
      await page.setViewportSize(viewport);
      await page.goto('/');
      await switchToProject(page, fixture.name, fixture.id);
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
    const projectId = await seedProject(page, name);
    await openWorkbench(page, name, projectId);
    await page.getByRole('button', { name: /声音资产工坊/ }).click();
    await expect(page.getByText('把想法变成可试听的音色')).toBeVisible();
    await page.getByRole('button', { name: '需要时打开完整流程' }).click();
    await page.getByRole('button', { name: '制作概览' }).click();
    await expect(page.getByText('人物声音闭环向导')).toBeVisible();
    await expect(page.getByText(/provider-neutral 可继续规划/).first()).toBeVisible();
    await expect(page.getByText(/有文件只代表候选存在/)).toBeVisible();

    await page.getByRole('button', { name: '完整声音制作' }).click();
    const minimaxRegionOptions = await page.getByLabel('执行区域').locator('option').allTextContents();
    expect(minimaxRegionOptions).toEqual(expect.arrayContaining(['cn · 中国区', 'global · 国际区']));
    await page.getByLabel('角色 / 旁白 ID').fill('C001');
    await page.getByLabel('声音名称').fill('C001 · Voice Design');
    await page.getByLabel('声音来源').selectOption('design');
    await page.getByRole('textbox', { name: '语言', exact: true }).fill('Japanese');
    await page.locator('label').filter({ hasText: /^locale/ }).locator('select').selectOption('ja-JP');
    await page.getByLabel('方言 / 口音').fill('Standard Japanese');
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

  test('audio creator exposes MiniMax web copy actions', async ({ page }) => {
    const name = `MiniMax 网页复制验收项目-${Date.now()}`;
    const projectId = await seedProject(page, name);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:8791' });
    await openWorkbench(page, name, projectId);
    await page.getByRole('button', { name: /声音资产工坊/ }).click();

    const designPrompt = page.getByRole('textbox', { name: 'MiniMax Voice Design Prompt' });
    const designPreview = page.getByRole('textbox', { name: 'MiniMax Voice Design Text to Preview' });
    await expect(page.getByRole('button', { name: '复制音色 Prompt' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '复制试听台词' })).toHaveCount(1);
    await designPrompt.fill('A soft, clear young adult voice with restrained warmth and natural conversational pacing.');
    await designPreview.fill('先輩、今日の放課後、一緒に帰りませんか？');
    await page.getByRole('button', { name: '复制音色 Prompt' }).last().click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('restrained warmth');
    await page.getByRole('button', { name: '复制试听台词' }).last().click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe('先輩、今日の放課後、一緒に帰りませんか？');
    await expect(page.locator('a[href="https://www.minimax.io/audio/voice-design"]')).toHaveAttribute('target', '_blank');
    await page.getByRole('button', { name: '复制完整填写包' }).last().click();
    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toContain('Text to Preview');
    await expect(page.getByRole('button', { name: '生成音色候选' })).toBeVisible();
  });

  test('embeds the voice preparation assistant inside the audio workbench', async ({ page }) => {
    const name = `声音前置 AI 内嵌验收项目-${Date.now()}`;
    const projectId = await seedProject(page, name);
    await openWorkbench(page, name, projectId);
    await page.getByRole('button', { name: /声音资产工坊/ }).click();

    const panel = page.locator('.audio-assistant-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('VOICE DESIGN AI');
    await expect(panel).toContainText('先把想法整理好');
    await expect(panel).toContainText('规划');
    await expect(panel).toContainText('OpenCode');
    await expect(panel).toContainText('生成');
    await expect(panel).toContainText('MiniMax');
    await expect(panel.getByRole('textbox', { name: '声音想法输入' })).toBeVisible();
    await expect(panel.getByRole('textbox', { name: '声音前置准备对话' })).toHaveCount(0);
    await expect(panel).not.toContainText('声音准备会话');
    await expect(panel).not.toContainText('RUN TRACE');
    await expect(page.getByRole('dialog', { name: /FRAMEFLOW AI Agent 工作台/ })).toHaveCount(0);

    await panel.getByRole('button', { name: '收起' }).click();
    await expect(panel).toContainText('AI 音色输入');
    await expect(panel.getByRole('button', { name: /展开继续/ })).toBeVisible();
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
    await switchToProject(page, name, projectId);
    await page.locator('.studio-sidebar').getByRole('button', { name: /故事与分镜/ }).click();
    await expect(page.getByLabel('参考时长（秒）')).toHaveCount(1);
    await expect(page.getByText('不限制最终片长')).toHaveCount(1);
    await expect(page.getByText('预算最小值', { exact: true })).toHaveCount(0);
    await expect(page.getByText('预算目标值', { exact: true })).toHaveCount(0);
    await expect(page.getByText('预算最大值', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '＋ 场景' }).click();
    const sceneCard = page.locator('[data-story-scene-id]').last();
    await expect(sceneCard.locator('.story-v2-scene-details')).not.toHaveAttribute('open', '');
    await sceneCard.getByText('查看详情', { exact: true }).click();
    await sceneCard.getByLabel('场景名称').fill('人工场景 A');
    await sceneCard.getByLabel('地点').fill('无 Provider 手工建立');
    for (let index = 0; index < 3; index += 1) await page.getByRole('button', { name: '＋ 镜头' }).click();
    const shotRows = page.locator('.story-v2-shot-card');
    await expect(shotRows).toHaveCount(3);
    await expect(shotRows.first().locator('.story-v2-shot-toggle-copy')).toContainText('未填写画面内容');
    await expect(shotRows.first().locator('.story-v2-shot-editor')).toHaveCount(0);
    const initialIds = await shotRows.locator('.story-v2-shot-id').allTextContents();
    expect(new Set(initialIds).size).toBe(3);
    await shotRows.nth(1).getByRole('button', { name: '删除' }).click();
    await expect(shotRows).toHaveCount(2);
    await shotRows.first().getByRole('button', { name: '复制' }).click();
    await shotRows.first().getByRole('button', { name: '拆分' }).click();
    await expect(shotRows).toHaveCount(4);
    await expect(sceneCard.locator('.story-v2-scene-ledger-status')).toContainText('待 AI 补齐');
    const summaryCollision = await shotRows.first().locator('.story-v2-shot-summary').evaluate((element) => {
      const rects = Array.from(element.children).map((child) => child.getBoundingClientRect());
      return rects.some((a, index) => rects.slice(index + 1).some((b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top));
    });
    expect(summaryCollision).toBeFalsy();
    await page.getByRole('button', { name: '保存更改' }).click();
    await expect(page.getByText(/故事与分镜已保存/)).toBeVisible();
    const story = await (await page.request.get(`/api/v2/projects/${projectId}/story`)).json() as { story: { scenes: Array<Record<string, unknown>>; shots: Array<{ id: string }> } };
    expect(story.story.scenes.some((scene) => scene.name === '人工场景 A')).toBeTruthy();
    expect(story.story.shots.map((shot) => shot.id)).toContain(initialIds[2]);
    expect(story.story.shots.map((shot) => shot.id)).not.toContain(initialIds[1]);
    expect(new Set(story.story.shots.map((shot) => shot.id)).size).toBe(4);

    const classes = ['character', 'scene', 'prop', 'fusion', 'audio'];
    await page.locator('.studio-sidebar').getByRole('button', { name: /资产生产工作区/ }).click();
    for (const assetClass of classes) {
      await page.getByRole('button', { name: '＋ 新增资产' }).click();
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

  test('direct storyboard import creates a complete two-shot scene ledger without replacing source script', async ({ page }) => {
    const name = `LINK 导入验收-${Date.now()}`;
    const created = await page.request.post('/api/v2/projects', { data: { name, ratio: '16:9', duration: 14, generator: 'seedance2.5', brief: 'Direct storyboard import fixture' } });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json() as { document: { id: string } }).document.id;
    const source = `标题：LINK / 同步\n总时长：约14秒\n【镜头01】\n时间：00:00–00:07.10\n景别：超近景 → 侧脸特写\n画面：白色驾驶手套触碰巨大机甲机械手，青蓝能源沿装甲向肩部点亮。\n摄影：缓慢 Push-In、Slide、Tilt Up。\n目的：建立尺度和人机关系。\n转场：大型肩甲完全遮挡，完成隐藏剪辑。\n【镜头02】\n时间：00:07.10–00:14.00\n景别：三分之二侧脸特写 → 英雄特写\n画面：少女位于前景，机甲头部在后景，光学系统亮起并形成逆光剪影。\n摄影：缓慢 Orbit、Rack Focus、Push-In。\n动作：少女抬眼，轻声“走吧”，机甲同步抬头。\n声音：SYSTEM SYNC COMPLETE；机甲核心重低频。\n目的：完成同步出击 Hero Shot。`;

    await page.goto('/');
    await switchToProject(page, name, projectId);
    await page.locator('.studio-sidebar').getByRole('button', { name: /故事与分镜/ }).click();
    await page.getByRole('button', { name: '＋ 直接导入' }).click();
    const dialog = page.getByRole('dialog', { name: '直接导入现有分镜' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('分镜导入内容').fill(source);
    await dialog.getByRole('button', { name: '导入并替换当前分镜' }).click();
    await expect(page.getByText(/故事与分镜已保存/)).toBeVisible();
    await expect(page.locator('.story-v2-scene-card')).toHaveCount(1);
    await expect(page.locator('.story-v2-shot-card')).toHaveCount(2);
    await expect(page.locator('.story-v2-scene-ledger-status.complete')).toHaveCount(1);
    const story = await (await page.request.get(`/api/v2/projects/${projectId}/story`)).json() as { story: { script: string; scenes: Array<Record<string, unknown>>; shots: Array<Record<string, unknown>> } };
    expect(story.story.script).toBe('');
    expect(story.story.scenes[0].relevantShots).toEqual(['SH001', 'SH002']);
    expect(story.story.shots.map((shot) => shot.id)).toEqual(['SH001', 'SH002']);
    expect(story.story.shots.map((shot) => shot.duration)).toEqual([7.1, 6.9]);
  });

  test('story candidate review can send feedback and regenerate without replacing the source', async ({ page }) => {
    const name = `故事候选修订验收-${Date.now()}`;
    const created = await page.request.post('/api/v2/projects', { data: { name, ratio: '16:9', duration: 30, generator: 'seedance2.5', brief: 'Candidate revision fixture' } });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json() as { document: { id: string } }).document.id;
    let createCount = 0;
    let revisionPayload: Record<string, unknown> | null = null;
    const candidateOutput = {
      workflowMode: 'optimize_script_and_storyboard',
      proposedScript: '候选拍摄剧本：保留一个核心事件。',
      scenes: [{ id: 'S001', name: '雨夜控制台', description: '控制台与雨幕空间', interiorExterior: '内景', timeOfDay: '夜', location: '控制台', characterIds: [], propIds: [], narrativeFunction: '建立状态', emotion: '克制', visualAnchors: ['湿润金属'], spatialGeography: '前景控制台，背景雨幕', materialEvidence: '金属表面有水痕', lightingCausality: '冷光在水痕上形成反射', soundscape: '雨声', productionDifficulty: 'medium', relevantShots: ['SH001'] }],
      shots: [{ id: 'SH001', scene: 'S001', duration: 7, purpose: '建立悬念', size: '近景', camera: '缓慢推进', action: '手指按下开关', visibleEvent: '手指按下开关', eventConsequence: '指示灯亮起', seedancePlan: { model: 'seedance2.5', generationMode: 'reference_to_video' }, continuity: { cutIn: '雨声先入', cutOut: '灯光保持' } }],
      shotBudgetAssessment: { duration: 14, referenceDuration: 30, durationSource: 'script_explicit', targetGenerator: 'seedance2.5', minimum: 3, target: 3, maximum: 3, actual: 1, averageShotDuration: 7, status: 'normal' },
      sourceBeatCoverage: { status: 'complete', total: 1, covered: 1, partial: 0, missing: 0, items: [] },
      normalizationReport: { status: 'ok', droppedItems: [] },
      handoffStatus: 'ready', acceptanceAllowed: true, scriptAcceptanceAllowed: true,
    };
    const makeRun = (id: string) => ({ id, project_id: projectId, status: 'storyboard_review_required', active_step: 'storyboard_review_required', input: { workflow_mode: 'optimize_script_and_storyboard', duration: 14, reference_duration: 30, duration_source: 'script_explicit', shot_budget: { shot_count_min: 3, shot_count_target: 3, shot_count_max: 3 }, target_generator: 'seedance2.5' }, storyboard_output: candidateOutput, regulator_output: null, error: null });
    await page.route(`**/api/v2/projects/${projectId}/story/runs`, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      createCount += 1;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (createCount === 2) revisionPayload = body;
      const id = createCount === 1 ? 'STORYRUN_E2E_BASE' : 'STORYRUN_E2E_REVISION';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, project_id: projectId, status: 'draft', active_step: 'draft' }) });
    });
    await page.route('**/api/v2/story-runs/*/start', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const id = route.request().url().includes('STORYRUN_E2E_REVISION') ? 'STORYRUN_E2E_REVISION' : 'STORYRUN_E2E_BASE';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: makeRun(id) }) });
    });

    await openWorkbench(page, name, projectId);
    await page.getByRole('button', { name: '▥ 故事与分镜', exact: true }).click();
    await page.getByLabel('初始想法或现有剧本').fill('视频时长：14秒。人物在雨夜按下开关。');
    await page.getByRole('button', { name: /AI 整合并优化为拍摄剧本/ }).click();
    await expect(page.getByText('不满意？告诉 AI 你希望怎么改')).toBeVisible();
    await expect(page.locator('.story-v2-candidate-script-output')).toContainText('候选拍摄剧本');
    const candidateCard = page.locator('.story-v2-candidate').first();
    await expect(candidateCard.locator('.story-v2-candidate-full-output')).toHaveCount(0);
    const expandDetails = candidateCard.getByRole('button', { name: '展开 SH001 分镜详情' });
    await expect(expandDetails).toHaveText('⌄');
    await expandDetails.click();
    await expect(candidateCard.locator('.story-v2-candidate-full-output')).toContainText('主可见事件');
    const collapseDetails = candidateCard.getByRole('button', { name: '收起 SH001 分镜详情' });
    await expect(collapseDetails).toHaveText('⌃');
    await collapseDetails.click();
    await expect(candidateCard.locator('.story-v2-candidate-full-output')).toHaveCount(0);
    const feedback = '保留一个核心事件；把推进速度放慢，强调指示灯亮起的物理后果。';
    await page.getByLabel('AI 分镜修订意见').fill(feedback);
    await page.getByRole('button', { name: '按我的想法重新生成' }).click();
    await expect(page.getByText(/已按你的意见重新生成候选/)).toBeVisible();
    expect(revisionPayload).toMatchObject({ revision_feedback: feedback, revision_of_run_id: 'STORYRUN_E2E_BASE' });
    expect(createCount).toBe(2);
    const source = await (await page.request.get(`/api/v2/projects/${projectId}/story`)).json() as { story: { script: string } };
    expect(source.story.script).toBe('视频时长：14秒。人物在雨夜按下开关。');
  });

  test('optimized shooting script can become the locked storyboard source', async ({ page }) => {
    const name = `拍摄剧本转分镜验收-${Date.now()}`;
    const created = await page.request.post('/api/v2/projects', { data: { name, ratio: '16:9', duration: 30, generator: 'seedance2.5', brief: 'Optimized script routing fixture' } });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json() as { document: { id: string } }).document.id;
    const originalScript = '原始剧本：少女进入机库，但尚未决定如何拍摄。';
    const optimizedScript = '优化拍摄剧本：少女在机库中触碰机甲，蓝光沿机械手点亮。';
    const candidateOutput = {
      workflowMode: 'optimize_script_and_storyboard',
      proposedScript: optimizedScript,
      scenes: [{ id: 'S001', name: '机库', description: '少女与机甲建立连接的空间', interiorExterior: '内景', timeOfDay: '夜', location: '大型机库', characterIds: [], propIds: [], narrativeFunction: '建立人机关系', emotion: '克制', visualAnchors: ['冷蓝接口灯'], spatialGeography: '少女在前景，机械手在中景', materialEvidence: '深灰装甲与白色手套形成材质反差', lightingCausality: '接口接触后蓝光沿装甲点亮', soundscape: '低频机械环境声', productionDifficulty: 'medium', relevantShots: ['SH001'] }],
      shots: [{ id: 'SH001', scene: 'S001', duration: 7, purpose: '建立人机连接', size: '近景', camera: '缓慢推进', action: '少女手指触碰机械手', visibleEvent: '少女手指触碰巨大机械手', eventConsequence: '蓝色接口灯亮起并沿装甲传播', seedancePlan: { model: 'seedance2.5', generationMode: 'reference_to_video' }, continuity: { cutIn: '机械低频先入', cutOut: '蓝光保持' } }],
      shotBudgetAssessment: { duration: 14, referenceDuration: 30, durationSource: 'script_explicit', targetGenerator: 'seedance2.5', minimum: 3, target: 3, maximum: 3, actual: 1, averageShotDuration: 7, status: 'normal' },
      sourceBeatCoverage: { status: 'complete', total: 1, covered: 1, partial: 0, missing: 0, items: [] },
      normalizationReport: { status: 'ok', droppedItems: [] },
      handoffStatus: 'ready', acceptanceAllowed: true, scriptAcceptanceAllowed: true,
    };
    let createCount = 0;
    let routedPayload: Record<string, unknown> | null = null;
    const makeRun = (id: string, workflowMode: string, currentScript: string) => ({ id, project_id: projectId, status: 'storyboard_review_required', active_step: 'storyboard_review_required', input: { workflow_mode: workflowMode, source_script_origin: workflowMode === 'storyboard_from_source' ? 'optimized_candidate' : 'project_script', current_script: currentScript, duration: 14, reference_duration: 30, duration_source: 'script_explicit', shot_budget: { shot_count_min: 3, shot_count_target: 3, shot_count_max: 3 }, target_generator: 'seedance2.5' }, storyboard_output: { ...candidateOutput, workflowMode, proposedScript: currentScript }, regulator_output: null, error: null });

    await page.route(`**/api/v2/projects/${projectId}/story/runs`, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      createCount += 1;
      const body = route.request().postDataJSON() as Record<string, unknown>;
      if (createCount === 2) routedPayload = body;
      const id = createCount === 1 ? 'STORYRUN_E2E_OPTIMIZE' : 'STORYRUN_E2E_FROM_SCRIPT';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, project_id: projectId, status: 'draft', active_step: 'draft' }) });
    });
    await page.route('**/api/v2/story-runs/*/start', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      const fromOptimizedScript = route.request().url().includes('STORYRUN_E2E_FROM_SCRIPT');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: makeRun(fromOptimizedScript ? 'STORYRUN_E2E_FROM_SCRIPT' : 'STORYRUN_E2E_OPTIMIZE', fromOptimizedScript ? 'storyboard_from_source' : 'optimize_script_and_storyboard', fromOptimizedScript ? optimizedScript : optimizedScript) }) });
    });

    await page.goto('/');
    await switchToProject(page, name, projectId);
    await page.getByRole('button', { name: '▥ 故事与分镜', exact: true }).click();
    await page.getByLabel('初始想法或现有剧本').fill(originalScript);
    await page.getByRole('button', { name: /AI 整合并优化为拍摄剧本/ }).click();
    await expect(page.getByRole('button', { name: '▦ 根据此拍摄剧本生成分镜' })).toBeVisible();
    await expect(page.getByLabel('AI 优化后的拍摄剧本')).toHaveValue(optimizedScript);
    await page.getByRole('button', { name: '▦ 根据此拍摄剧本生成分镜' }).click();
    await expect(page.getByText(/已将 AI 拍摄剧本作为锁定来源生成分镜候选/)).toBeVisible();
    expect(routedPayload).toMatchObject({ workflow_mode: 'storyboard_from_source', source_script_override: optimizedScript, source_script_run_id: 'STORYRUN_E2E_OPTIMIZE' });
    await expect(page.getByRole('heading', { name: '锁定拍摄剧本 · 分镜来源' })).toBeVisible();
    await expect(page.getByLabel('AI 优化后的拍摄剧本')).toHaveValue(optimizedScript);
    const source = await (await page.request.get(`/api/v2/projects/${projectId}/story`)).json() as { story: { script: string } };
    expect(source.story.script).toBe(originalScript);
  });

  test('automatic shot reference range does not disable accepting a longer candidate', async ({ page }) => {
    const name = `镜头参考范围验收-${Date.now()}`;
    const created = await page.request.post('/api/v2/projects', { data: { name, ratio: '16:9', duration: 20, generator: 'seedance2.5', brief: 'Automatic shot guidance fixture' } });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json() as { document: { id: string } }).document.id;
    const source = '视频时长：20秒。四个独立的动作事件组成一段连续分镜。';
    const candidateShots = Array.from({ length: 4 }, (_, index) => ({ id: `SH00${index + 1}`, scene: 'S001', duration: 5, purpose: `事件 ${index + 1}`, size: '中景', camera: '固定', action: '动作', visibleEvent: '动作发生', eventConsequence: '状态改变' }));
    const makeRun = { id: 'STORYRUN_E2E_REFERENCE_RANGE', project_id: projectId, status: 'storyboard_review_required', active_step: 'storyboard_review_required', input: { workflow_mode: 'storyboard_from_source', source_script_origin: 'project_script', current_script: source, duration: 20, reference_duration: 20, duration_source: 'script_explicit', shot_budget: { shot_count_min: 3, shot_count_target: 3, shot_count_max: 3, shot_budget_source: 'automatic' }, target_generator: 'seedance2.5' }, storyboard_output: { workflowMode: 'storyboard_from_source', proposedScript: source, scenes: [], shots: candidateShots, sourceBeatCoverage: { status: 'complete', total: 1, covered: 1, partial: 0, missing: 0, items: [] }, normalizationReport: { status: 'ok', droppedItems: [] }, handoffStatus: 'ready', acceptanceAllowed: true }, regulator_output: null, error: null };
    await page.route(`**/api/v2/projects/${projectId}/story/runs`, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: makeRun.id, project_id: projectId, status: 'draft', active_step: 'draft' }) });
    });
    await page.route('**/api/v2/story-runs/*/start', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: makeRun }) });
    });

    await openWorkbench(page, name, projectId);
    await page.getByRole('button', { name: '▥ 故事与分镜', exact: true }).click();
    await page.getByLabel('初始想法或现有剧本').fill(source);
    await page.getByRole('button', { name: /剧本直接整合为分镜/ }).click();
    await expect(page.getByText('4 个候选镜头')).toBeVisible();
    await expect(page.getByText('高于参考：仍可接受')).toBeVisible();
    await expect(page.getByRole('button', { name: '接受全部候选' })).toBeEnabled();
  });

  test('incomplete storyboard candidate shows missing beats and blocks shot acceptance', async ({ page }) => {
    const name = `分镜内容覆盖门禁验收-${Date.now()}`;
    const created = await page.request.post('/api/v2/projects', { data: { name, ratio: '16:9', duration: 12, generator: 'seedance2.5', brief: 'Storyboard coverage gate fixture' } });
    expect(created.ok()).toBeTruthy();
    const projectId = (await created.json() as { document: { id: string } }).document.id;
    const source = '角色触碰机械手。机甲头部亮起。角色说：走吧。';
    const run = {
      id: 'STORYRUN_E2E_INCOMPLETE',
      project_id: projectId,
      status: 'storyboard_review_required',
      active_step: 'storyboard_review_required',
      input: { workflow_mode: 'storyboard_from_source', source_script_origin: 'project_script', current_script: source, duration: 12, reference_duration: 12, duration_source: 'script_explicit', shot_budget: { shot_count_min: 3, shot_count_target: 3, shot_count_max: 3, shot_budget_source: 'automatic' }, target_generator: 'seedance2.5' },
      storyboard_output: {
        workflowMode: 'storyboard_from_source',
        proposedScript: source,
        scenes: [],
        shots: [{ id: 'SH001', scene: 'S001', duration: 4, purpose: '建立接触', size: '近景', camera: '缓慢推进', action: '角色触碰机械手', visibleEvent: '角色手指接触机械手', eventConsequence: '接口灯亮起' }],
        sourceBeatCoverage: { status: 'incomplete', total: 3, covered: 1, partial: 0, missing: 2, items: [{ beatId: 'B002', status: 'missing', summary: '机甲头部亮起', reason: '没有候选镜头覆盖机甲启动' }, { beatId: 'B003', status: 'missing', summary: '角色说：走吧', reason: '没有候选镜头覆盖台词' }] },
        normalizationReport: { status: 'incomplete', droppedItems: [{ path: 'shots[1]', reason: 'not_an_object' }] },
        handoffStatus: 'handoff_not_ready',
        acceptanceAllowed: false,
        scriptAcceptanceAllowed: false,
        blockingIssues: [{ code: 'storyboard_coverage_missing', message: 'storyboard_coverage_missing: B002 缺少机甲启动' }, { code: 'normalization_dropped_item', message: 'normalization_dropped_item: shots[1] 无法解析' }],
      },
      regulator_output: null,
      error: null,
    };
    await page.route(`**/api/v2/projects/${projectId}/story/runs`, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: run.id, project_id: projectId, status: 'draft', active_step: 'draft' }) });
    });
    await page.route(`**/api/v2/story-runs/${run.id}/start`, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run }) });
    });

    await openWorkbench(page, name, projectId);
    await page.getByRole('button', { name: '▥ 故事与分镜', exact: true }).click();
    await page.getByLabel('初始想法或现有剧本').fill(source);
    await page.getByRole('button', { name: /剧本直接整合为分镜/ }).click();
    await expect(page.getByRole('alert')).toContainText('分镜候选不完整，暂不能接受');
    await expect(page.getByRole('alert')).toContainText('缺少 2 个剧本节拍');
    await expect(page.getByRole('button', { name: '接受全部候选' })).toBeDisabled();
    const diagnostics = page.getByRole('alert').getByText('查看缺失内容与结构诊断');
    await expect(diagnostics).toBeVisible();
    await diagnostics.click();
    await expect(page.getByRole('alert')).toContainText('B002');
    await expect(page.getByRole('alert')).toContainText('shots[1]');
  });
});
