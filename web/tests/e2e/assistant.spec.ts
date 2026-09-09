import { test, expect, type Page } from '@playwright/test';

type AssistantAttachmentFixture = {
  id: string;
  project_id: string;
  conversation_id: string;
  message_id: string | null;
  name: string;
  safe_name: string;
  mime_type: string;
  extension: string;
  byte_size: number;
  sha256: string;
  kind: 'image';
  delivery_mode: 'pending';
  analysis_status: 'pending';
  extracted_chars: number;
  extraction_error: null;
  metadata: Record<string, unknown>;
  url: string;
  created_at: string;
  updated_at: string;
};

async function seedProject(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/v2/projects', {
    data: { name, ratio: '16:9', duration: 12, generator: 'seedance2.0', brief: 'Assistant desktop acceptance fixture' },
  });
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { document: { id: string } }).document.id;
}

async function switchToProject(page: Page, name: string, projectId?: string): Promise<void> {
  const managerButton = page.getByRole('button', { name: '项目管理', exact: true });
  const dialog = page.getByRole('dialog', { name: /项目管理/ });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expect(managerButton).toBeEnabled();
    const currentTitle = await page.locator('.project-title').textContent();
    if (currentTitle?.includes(name)) return;
    if (await dialog.isVisible().catch(() => false)) break;
    await managerButton.click();
    if (await dialog.isVisible().catch(() => false)) break;
    await page.waitForTimeout(100);
  }
  await expect(dialog).toBeVisible();
  const row = projectId ? page.locator(`.project-manager-row[data-project-id="${projectId}"]`) : page.locator('.project-manager-row').filter({ hasText: name }).first();
  await expect(row).toBeVisible();
  const switchButton = row.getByRole('button', { name: '切换到此项目' });
  if (await switchButton.count()) await switchButton.click();
  else await page.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.project-title')).toContainText(name);
}

function sse(eventType: string, payload: Record<string, unknown>): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test.describe('FRAMEFLOW desktop Agent workspace', () => {
  test('keeps attachments local until send and shows the external confirmation gate', async ({ page }) => {
    // Keep the shared Playwright fixture compatible with the existing
    // workbench smoke tests, which intentionally open this baseline project
    // by its stable name in the same browser database.
    const projectName = '浏览器验收项目';
    const projectId = await seedProject(page, projectName);
    const now = '2026-01-01T00:00:00Z';
    const conversationId = 'CONV_E2E';
    const attachment: AssistantAttachmentFixture = {
      id: 'ATT_E2E',
      project_id: projectId,
      conversation_id: conversationId,
      message_id: null,
      name: 'reference.png',
      safe_name: 'reference.png',
      mime_type: 'image/png',
      extension: '.png',
      byte_size: 2048,
      sha256: 'a'.repeat(64),
      kind: 'image',
      delivery_mode: 'pending',
      analysis_status: 'pending',
      extracted_chars: 0,
      extraction_error: null,
      metadata: {},
      url: '/api/v2/assistant/attachments/ATT_E2E',
      created_at: now,
      updated_at: now,
    };
    const conversation = {
      id: conversationId,
      project_id: projectId,
      title: '桌面 Agent 验收会话',
      status: 'active',
      last_contract_hash: null,
      external_consent: [],
      message_count: 0,
      pending_plan_count: 0,
      created_at: now,
      updated_at: now,
    };
    let streamCalled = false;

    await page.route(`**/api/v2/projects/${projectId}/assistant/conversations`, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, conversations: [conversation] }) });
      return route.continue();
    });
    await page.route(`**/api/v2/assistant/conversations/${conversationId}/messages`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: conversationId, messages: [] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/runs*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, runs: [] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/attachments**`, async (route) => {
      expect(route.request().method()).toBe('POST');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ attachment }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/stream`, async (route) => {
      streamCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse('run_started', { run_id: 'ARUN_E2E', sequence: 1, event_type: 'run_started', status: 'paused', data: {}, created_at: now })
          + sse('snapshot_complete', { run_id: 'ARUN_E2E', sequence: 1, status: 'awaiting_external_confirmation' }),
      });
    });
    await page.route('**/api/v2/assistant/runs/ARUN_E2E', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'ARUN_E2E',
        project_id: projectId,
        conversation_id: conversationId,
        source_message_id: 'MSG_E2E',
        client_message_id: 'CLIENT_E2E',
        status: 'awaiting_external_confirmation',
        contract_hash: 'b'.repeat(64),
        contract_snapshot: { bundle_hash: 'b'.repeat(64) },
        skill: { skill_id: 'video-script-storyboard', skill_version: '1.0.0' },
        provider_profile_id: 'openai-default',
        provider_model: 'gpt-5.6-terra',
        base_project_revision: 1,
        base_graph_revision: 1,
        base_timeline_revision: 1,
        checkpoint: { last_event: 'run_created' },
        result: {},
        error: null,
        awaiting_confirmation: {
          provider_profile_id: 'openai-default',
          provider_name: 'OpenAI',
          provider_type: 'openai',
          model: 'gpt-5.6-terra',
          purpose: '图片 vision 理解',
          attachments: [{ id: attachment.id, name: attachment.name, mime_type: attachment.mime_type, byte_size: attachment.byte_size, delivery_mode: 'multimodal' }],
        },
        attachments: [{ ...attachment, delivery_mode: 'multimodal', analysis_status: 'ready' }],
        created_at: now,
        updated_at: now,
      }) });
    });
    await page.route('**/api/v2/assistant/runs/ARUN_E2E/external-confirmation', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'ARUN_E2E', project_id: projectId, conversation_id: conversationId, source_message_id: 'MSG_E2E', client_message_id: 'CLIENT_E2E', status: 'canceled', contract_hash: 'b'.repeat(64), contract_snapshot: { bundle_hash: 'b'.repeat(64) }, skill: { skill_id: 'video-script-storyboard', skill_version: '1.0.0' }, provider_profile_id: 'openai-default', provider_model: 'gpt-5.6-terra', base_project_revision: 1, base_graph_revision: 1, base_timeline_revision: 1, checkpoint: {}, result: {}, error: { message: '附件仍保存在本地项目资料中。' }, awaiting_confirmation: null, attachments: [{ ...attachment, delivery_mode: 'project_reference', analysis_status: 'not_analyzed' }], created_at: now, updated_at: now }) });
    });

    await page.goto('/');
    await switchToProject(page, projectName, projectId);
    await page.locator('.assistant-launcher').click();
    await expect(page.getByRole('dialog', { name: /FRAMEFLOW AI Agent 工作台/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: '项目会话' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '工作区上下文' })).toBeVisible();

    const fileInput = page.locator('.assistant-composer-v2 input[type="file"]');
    await fileInput.setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('fake-png') });
    await expect(page.getByText('reference.png', { exact: true }).first()).toBeVisible();
    expect(streamCalled).toBeFalsy();

    await page.getByLabel('向 FRAMEFLOW Agent 提问').fill('根据参考图补充角色身份锚点。');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('heading', { name: '确认附件外发' })).toBeVisible();
    await expect(page.getByText(/OpenAI/).last()).toBeVisible();
    await expect(page.getByRole('button', { name: '确认外发并继续' })).toBeVisible();
    expect(streamCalled).toBeTruthy();
    await page.getByRole('button', { name: '拒绝并保留本地' }).click();
    await expect(page.getByText('已拒绝外发；附件仍保存在本地项目资料中。')).toBeVisible();
  });

  test('approves the attachment gate, resumes the same run and exposes reply plus plan', async ({ page }) => {
    const projectName = `助手外发恢复验收项目-${Date.now()}`;
    const projectId = await seedProject(page, projectName);
    const now = '2026-01-01T00:00:00Z';
    const conversationId = 'CONV_APPROVAL_E2E';
    const runId = 'ARUN_APPROVAL_E2E';
    const contractHash = 'f'.repeat(64);
    const attachment: AssistantAttachmentFixture = {
      id: 'ATT_APPROVAL_E2E', project_id: projectId, conversation_id: conversationId, message_id: null, name: 'brief.png', safe_name: 'brief.png', mime_type: 'image/png', extension: '.png', byte_size: 1024, sha256: '1'.repeat(64), kind: 'image', delivery_mode: 'pending', analysis_status: 'pending', extracted_chars: 0, extraction_error: null, metadata: {}, url: '/api/v2/assistant/attachments/ATT_APPROVAL_E2E', created_at: now, updated_at: now,
    };
    const conversation = { id: conversationId, project_id: projectId, title: '外发恢复会话', status: 'active', last_contract_hash: contractHash, external_consent: [], message_count: 0, pending_plan_count: 0, created_at: now, updated_at: now };
    let phase: 'awaiting_external_confirmation' | 'preparing' | 'succeeded' = 'awaiting_external_confirmation';
    const events = [
      { run_id: runId, sequence: 1, item_id: null, event_type: 'run_started', status: 'paused', data: {}, created_at: now },
      { run_id: runId, sequence: 2, item_id: 'attachment_preparing', event_type: 'item_completed', status: 'succeeded', data: {}, created_at: now },
      { run_id: runId, sequence: 3, item_id: 'source_citation', event_type: 'item_completed', status: 'succeeded', data: { sources: [{ id: attachment.id, name: attachment.name }] }, created_at: now },
      { run_id: runId, sequence: 4, item_id: 'external_attachment_confirmation', event_type: 'approval_request', status: 'paused', data: {}, created_at: now },
      { run_id: runId, sequence: 5, item_id: 'external_attachment_confirmation', event_type: 'item_completed', status: 'succeeded', data: {}, created_at: now },
      { run_id: runId, sequence: 6, item_id: 'vision_analysis', event_type: 'item_completed', status: 'succeeded', data: { summary: '参考图中包含清晰的角色轮廓。' }, created_at: now },
      { run_id: runId, sequence: 7, item_id: 'assistant_message', event_type: 'item_completed', status: 'succeeded', data: { reply: '已恢复同一个运行并生成候选。' }, created_at: now },
      { run_id: runId, sequence: 8, item_id: null, event_type: 'run_completed', status: 'succeeded', data: { plan_id: 'AGENT_APPROVAL_E2E' }, created_at: now },
    ];
    const runPayload = () => ({
      id: runId, project_id: projectId, conversation_id: conversationId, source_message_id: 'MSG_APPROVAL_E2E', client_message_id: 'CLIENT_APPROVAL_E2E', status: phase, contract_hash: contractHash, contract_snapshot: { bundle_hash: contractHash }, skill: { skill_id: 'video-character-design-director', skill_version: '1.0.0' }, provider_profile_id: 'openai-default', provider_model: 'gpt-5.6-terra', base_project_revision: 1, base_graph_revision: 1, base_timeline_revision: 1, checkpoint: {}, result: phase === 'succeeded' ? { plan_id: 'AGENT_APPROVAL_E2E', reply: '已恢复同一个运行并生成候选。', patch: { workspace_operations: [{ id: 'OP_APPROVAL_SAFE', workspace: 'assets', action: 'create_prompt_candidate', target_id: 'AST_AGENT', title: '角色 Prompt 候选', summary: '等待审阅。', before: null, after: { prompt: '角色身份锚点' }, content: { prompt: '角色身份锚点' }, source_attachment_ids: [attachment.id], source_refs: [`${attachment.id}:image`], contract_snapshot: { bundle_hash: contractHash }, risk: 'safe_draft', requires_confirmation: false }] } } : {}, error: null, awaiting_confirmation: phase === 'awaiting_external_confirmation' ? { provider_profile_id: 'openai-default', provider_name: 'OpenAI', provider_type: 'openai', model: 'gpt-5.6-terra', purpose: '图片 vision 理解', attachments: [{ id: attachment.id, name: attachment.name, mime_type: attachment.mime_type, byte_size: attachment.byte_size, delivery_mode: 'multimodal' }] } : null, attachments: [{ ...attachment, delivery_mode: 'multimodal', analysis_status: 'ready' }], created_at: now, updated_at: now,
    });
    let approvalCalled = false;

    await page.route(`**/api/v2/projects/${projectId}/assistant/conversations`, async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, conversations: [conversation] }) });
      return route.continue();
    });
    await page.route(`**/api/v2/assistant/conversations/${conversationId}/messages`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: conversationId, messages: [{ id: 'MSG_APPROVAL_E2E_USER', role: 'user', content: '分析参考图', message_type: 'user', metadata: {}, attachments: [attachment], created_at: now }, ...(phase === 'succeeded' ? [{ id: 'MSG_APPROVAL_E2E_ASSISTANT', role: 'assistant', content: '已恢复同一个运行并生成候选。', message_type: 'assistant', metadata: { run_id: runId, plan_id: 'AGENT_APPROVAL_E2E' }, attachments: [], created_at: now }] : [])] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/runs*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, runs: [] }) });
    });
    await page.route('**/api/v2/contracts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle_version: '1.0', bundle_hash: contractHash, prompt_contract: { version: '2.0', workflow: 'frameflow-prompt-v2', field_order: [] }, story_contract: { version: '1.0', required_shot_fields: [], detail_fields: [], validation_rules: [] }, audio_contract: { version: 'minimax-speech-audio-v2', required_fields: [] }, workflow_contract: { version: '1.0', available_skills: [] } }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/attachments**`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ attachment }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/stream`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.slice(0, 4).map((item) => sse(item.event_type, item)).join('') + sse('snapshot_complete', { run_id: runId, sequence: 4, status: phase }) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runPayload()) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}/external-confirmation`, async (route) => {
      approvalCalled = true;
      phase = 'preparing';
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(runPayload()) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}/events*`, async (route) => {
      if (phase === 'preparing') phase = 'succeeded';
      const url = new URL(route.request().url());
      const after = Number(url.searchParams.get('after_sequence') || '0');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run_id: runId, events: events.filter((item) => item.sequence > after) }) });
    });

    await page.goto('/');
    await switchToProject(page, projectName, projectId);
    await page.locator('.assistant-launcher').click();
    await page.locator('.assistant-composer-v2 input[type="file"]').setInputFiles({ name: attachment.name, mimeType: attachment.mime_type, buffer: Buffer.from('image') });
    await page.getByLabel('向 FRAMEFLOW Agent 提问').fill('分析参考图');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('heading', { name: '确认附件外发' })).toBeVisible();
    await page.getByRole('button', { name: '确认外发并继续' }).click();
    await expect.poll(() => approvalCalled).toBeTruthy();
    await expect(page.getByText('已恢复同一个运行并生成候选。')).toBeVisible();
    await expect(page.getByText('来源引用')).toBeVisible();
    await expect(page.getByText('选择要应用到工作台的修改')).toBeVisible();
    await page.getByRole('button', { name: '重新生成' }).click();
    await expect(page.getByLabel('向 FRAMEFLOW Agent 提问')).toHaveValue('分析参考图');
  });

  test('creates the first project conversation and sends from the welcome shortcut with Enter', async ({ page }) => {
    const projectName = `助手首会话验收项目-${Date.now()}`;
    const projectId = await seedProject(page, projectName);
    const now = '2026-01-01T00:00:00Z';
    const conversationId = 'CONV_FIRST_E2E';
    const runId = 'ARUN_FIRST_E2E';
    const conversation = { id: conversationId, project_id: projectId, title: '检查全流程', status: 'active', last_contract_hash: 'a'.repeat(64), external_consent: [], message_count: 2, last_message: '首会话已生成候选', pending_plan_count: 1, created_at: now, updated_at: now };
    const run = {
      id: runId,
      project_id: projectId,
      conversation_id: conversationId,
      source_message_id: 'MSG_FIRST_E2E',
      client_message_id: 'CLIENT_FIRST_E2E',
      status: 'succeeded',
      contract_hash: 'a'.repeat(64),
      contract_snapshot: { bundle_hash: 'a'.repeat(64) },
      skill: { skill_id: 'video-script-storyboard', skill_version: '1.0.0' },
      provider_profile_id: 'openai-default',
      provider_model: 'gpt-5.6-terra',
      base_project_revision: 1,
      base_graph_revision: 1,
      base_timeline_revision: 1,
      checkpoint: {},
      result: {
        plan_id: 'AGENT_FIRST_E2E',
        reply: '首个项目会话已经生成可审阅候选。',
        patch: {
          workspace_operations: [{
            id: 'OP_FIRST_SAFE',
            workspace: 'story',
            action: 'candidate_draft',
            title: '首个故事候选',
            summary: '由欢迎快捷操作生成。',
            before: null,
            after: { script: '候选脚本' },
            content: { script: '候选脚本' },
            source_attachment_ids: [],
            source_refs: [],
            contract_snapshot: { bundle_hash: 'a'.repeat(64) },
            risk: 'safe_draft',
            requires_confirmation: false,
          }],
        },
      },
      error: null,
      awaiting_confirmation: null,
      attachments: [],
      created_at: now,
      updated_at: now,
    };
    let conversationCreated = false;
    let streamCalled = false;

    await page.route(`**/api/v2/projects/${projectId}/assistant/conversations`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, conversations: conversationCreated ? [conversation] : [] }) });
        return;
      }
      conversationCreated = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation }) });
    });
    await page.route(`**/api/v2/assistant/conversations/${conversationId}/messages`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: conversationId, messages: streamCalled ? [{ id: 'MSG_FIRST_USER', role: 'user', content: '检查当前故事、资产、声音和时间线之间的连续性，生成可审阅的修复候选。', message_type: 'user', metadata: {}, attachments: [], created_at: now }, { id: 'MSG_FIRST_ASSISTANT', role: 'assistant', content: run.result.reply, message_type: 'assistant', metadata: { run_id: runId, plan_id: run.result.plan_id }, attachments: [], created_at: now }] : [] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/runs*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, runs: streamCalled ? [run] : [] }) });
    });
    await page.route('**/api/v2/contracts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle_version: '1.0', bundle_hash: 'a'.repeat(64), prompt_contract: { version: '2.0', workflow: 'frameflow-prompt-v2', field_order: [] }, story_contract: { version: '1.0', required_shot_fields: [], detail_fields: [], validation_rules: [] }, audio_contract: { version: 'minimax-speech-audio-v2', required_fields: [] }, workflow_contract: { version: '1.0', available_skills: [] } }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/stream`, async (route) => {
      streamCalled = true;
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse('run_started', { run_id: runId, sequence: 1, event_type: 'run_started', status: 'running', data: {}, created_at: now }) + sse('item_completed', { run_id: runId, sequence: 2, item_id: 'plan_preview', event_type: 'item_completed', status: 'succeeded', data: { operation_count: 1 }, created_at: now }) + sse('snapshot_complete', { run_id: runId, sequence: 2, status: 'succeeded' }) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(run) });
    });

    await page.goto('/');
    await switchToProject(page, projectName, projectId);
    await page.locator('.assistant-launcher').click();
    await expect(page.getByText('把想法和资料交给工作台')).toBeVisible();
    await page.getByRole('button', { name: '检查全流程' }).click();
    await expect(page.getByLabel('向 FRAMEFLOW Agent 提问')).toHaveValue(/检查当前故事/);
    await page.getByLabel('向 FRAMEFLOW Agent 提问').press('Enter');
    await expect.poll(() => conversationCreated).toBeTruthy();
    await expect.poll(() => streamCalled).toBeTruthy();
    await expect(page.getByText('首个项目会话已经生成可审阅候选。').last()).toBeVisible();
    await expect(page.getByText('选择要应用到工作台的修改')).toBeVisible();
  });

  test('restores run events after reopening and reviews only safe operations', async ({ page }) => {
    const projectName = `助手计划审阅验收项目-${Date.now()}`;
    const projectId = await seedProject(page, projectName);
    const now = '2026-01-01T00:00:00Z';
    const conversationId = 'CONV_PLAN_E2E';
    const contractHash = 'c'.repeat(64);
    const conversation = {
      id: conversationId,
      project_id: projectId,
      title: '计划审阅会话',
      status: 'active',
      last_contract_hash: contractHash,
      external_consent: [],
      message_count: 1,
      pending_plan_count: 1,
      created_at: now,
      updated_at: now,
    };
    const run = {
      id: 'ARUN_PLAN_E2E',
      project_id: projectId,
      conversation_id: conversationId,
      source_message_id: 'MSG_PLAN_E2E',
      client_message_id: 'CLIENT_PLAN_E2E',
      status: 'succeeded',
      contract_hash: contractHash,
      contract_snapshot: { bundle_hash: contractHash, bundle_version: '1.0', prompt_contract_version: '2.0', story_contract_version: '1.0', audio_contract_version: 'minimax-speech-audio-v2', workflow_contract_version: '1.0' },
      skill: { skill_id: 'video-script-storyboard', skill_version: '1.0.0' },
      provider_profile_id: 'openai-default',
      provider_model: 'gpt-5.6-terra',
      base_project_revision: 1,
      base_graph_revision: 1,
      base_timeline_revision: 1,
      checkpoint: { last_event: 'plan_preview' },
      result: {
        plan_id: 'AGENT_PLAN_E2E',
        reply: '已生成故事候选，并保留工作流图不变。',
        patch: { workspace_operations: [
          { id: 'OP_SAFE_E2E', workspace: 'story', action: 'candidate_draft', title: '故事候选', summary: '新增一条可审阅的故事草稿。', before: { script: '旧稿' }, after: { script: '新稿' }, content: { script: '新稿' }, source_attachment_ids: [], source_refs: [], contract_snapshot: { bundle_hash: contractHash }, risk: 'safe_draft', requires_confirmation: false },
          { id: 'OP_BLOCKED_E2E', workspace: 'workflow', action: 'remove_node', target_id: 'generate', title: '删除生成节点', summary: '受保护操作。', before: { id: 'generate' }, after: null, content: null, source_attachment_ids: [], source_refs: [], contract_snapshot: { bundle_hash: contractHash }, risk: 'blocked', requires_confirmation: true },
        ] },
        apply: undefined,
      },
      error: null,
      awaiting_confirmation: null,
      attachments: [],
      created_at: now,
      updated_at: now,
    };
    const events = [
      { run_id: run.id, sequence: 1, item_id: null, event_type: 'run_started', status: 'running', data: {}, created_at: now },
      { run_id: run.id, sequence: 2, item_id: 'context_loading', event_type: 'item_completed', status: 'succeeded', data: { label: '读取项目与当前工作区' }, created_at: now },
      { run_id: run.id, sequence: 3, item_id: 'plan_preview', event_type: 'item_completed', status: 'succeeded', data: { operation_count: 2 }, created_at: now },
      { run_id: run.id, sequence: 4, item_id: 'assistant_message', event_type: 'item_completed', status: 'succeeded', data: { reply: run.result.reply }, created_at: now },
      { run_id: run.id, sequence: 5, item_id: null, event_type: 'run_completed', status: 'succeeded', data: { plan_id: run.result.plan_id }, created_at: now },
    ];
    let eventReplayRequested = false;
    let applyCalled = false;

    await page.route(`**/api/v2/projects/${projectId}/assistant/conversations`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, conversations: [conversation] }) });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/v2/assistant/conversations/${conversationId}/messages`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: conversationId, messages: [{ id: 'MSG_PLAN_E2E', role: 'user', content: '生成故事候选', message_type: 'user', client_message_id: 'CLIENT_PLAN_E2E', metadata: {}, attachments: [], created_at: now }] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/runs*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, runs: [run] }) });
    });
    await page.route('**/api/v2/contracts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle_version: '1.0', bundle_hash: contractHash, prompt_contract: { version: '2.0', workflow: 'frameflow-prompt-v2', field_order: [] }, story_contract: { version: '1.0', required_shot_fields: [], detail_fields: [], validation_rules: [] }, audio_contract: { version: 'minimax-speech-audio-v2', required_fields: [] }, workflow_contract: { version: '1.0', available_skills: [] } }) });
    });
    await page.route('**/api/v2/projects/*/assistant/stream', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse('run_started', { run_id: run.id, sequence: 1, event_type: 'run_started', status: 'running', data: {}, created_at: now }) + sse('snapshot_complete', { run_id: run.id, sequence: 5, status: 'succeeded' }) });
    });
    await page.route(`**/api/v2/assistant/runs/${run.id}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(run) });
    });
    await page.route(`**/api/v2/assistant/runs/${run.id}/events*`, async (route) => {
      eventReplayRequested = true;
      const url = new URL(route.request().url());
      const after = Number(url.searchParams.get('after_sequence') || '0');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run_id: run.id, events: events.filter((item) => item.sequence > after) }) });
    });
    await page.route(`**/api/v2/assistant/runs/${run.id}/apply`, async (route) => {
      applyCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run: { ...run, result: { ...run.result, apply: { selected_operation_ids: ['OP_SAFE_E2E'], applied_operation_ids: ['OP_SAFE_E2E'] } } }, plan: { id: run.result.plan_id, status: 'applied' }, applied_operation_ids: ['OP_SAFE_E2E'], project_revision: 2, graph_revision: 1, timeline_revision: 1 }) });
    });

    await page.goto('/');
    await switchToProject(page, projectName, projectId);
    await page.locator('.assistant-launcher').click();
    await expect(page.getByRole('dialog', { name: /FRAMEFLOW AI Agent 工作台/ })).toBeVisible();
    await page.getByLabel('向 FRAMEFLOW Agent 提问').fill('生成故事候选');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('选择要应用到工作台的修改')).toBeVisible();
    await expect(page.locator('.assistant-operation-card').first().getByText('查看差异')).toBeVisible();
    const blockedCard = page.locator('.assistant-operation-card').filter({ hasText: '删除生成节点' });
    await expect(blockedCard).toHaveClass(/blocked/);
    await expect(blockedCard.locator('input[type="checkbox"]')).toBeDisabled();
    await page.getByRole('button', { name: '清空' }).click();
    await expect(page.getByRole('button', { name: '应用已选 0 项' })).toBeDisabled();

    await page.getByLabel('关闭创作助手').click();
    await page.locator('.assistant-launcher').click();
    await expect.poll(() => eventReplayRequested).toBeTruthy();
    await expect(page.locator('.assistant-event-timeline')).toBeVisible();
    await expect(page.getByText('运行完成')).toBeVisible();

    await page.getByRole('button', { name: '全选安全项' }).click();
    await expect(page.getByRole('button', { name: '应用已选 1 项' })).toBeEnabled();
    await page.getByRole('button', { name: '应用已选 1 项' }).click();
    await expect.poll(() => applyCalled).toBeTruthy();
    await expect(page.getByText(/已应用 1 项工作台修改/)).toBeVisible();
  });

  test('freezes a plan in the desktop UI when the live contract changes', async ({ page }) => {
    const projectName = `助手规范过期验收项目-${Date.now()}`;
    const projectId = await seedProject(page, projectName);
    const now = '2026-01-01T00:00:00Z';
    const conversationId = 'CONV_STALE_E2E';
    const runId = 'ARUN_STALE_E2E';
    const planContractHash = 'a'.repeat(64);
    const currentContractHash = 'b'.repeat(64);
    const conversation = {
      id: conversationId,
      project_id: projectId,
      title: '规范更新会话',
      status: 'active',
      last_contract_hash: planContractHash,
      external_consent: [],
      message_count: 1,
      pending_plan_count: 1,
      created_at: now,
      updated_at: now,
    };
    const run = {
      id: runId,
      project_id: projectId,
      conversation_id: conversationId,
      source_message_id: 'MSG_STALE_E2E',
      client_message_id: 'CLIENT_STALE_E2E',
      status: 'succeeded',
      contract_hash: planContractHash,
      contract_snapshot: { bundle_hash: planContractHash, bundle_version: '1.0' },
      skill: { skill_id: 'video-script-storyboard', skill_version: '1.0.0' },
      provider_profile_id: 'openai-default',
      provider_model: 'gpt-5.6-terra',
      base_project_revision: 1,
      base_graph_revision: 1,
      base_timeline_revision: 1,
      checkpoint: { last_event: 'plan_preview' },
      result: {
        plan_id: 'AGENT_STALE_E2E',
        reply: '这条计划基于旧规范。',
        patch: { workspace_operations: [{
          id: 'OP_STALE_SAFE',
          workspace: 'story',
          action: 'candidate_draft',
          title: '旧规范故事候选',
          summary: '规范更新后只能重新生成。',
          before: { script: '旧稿' },
          after: { script: '候选稿' },
          content: { script: '候选稿' },
          source_attachment_ids: [],
          source_refs: [],
          contract_snapshot: { bundle_hash: planContractHash },
          risk: 'safe_draft',
          requires_confirmation: false,
        }] },
      },
      error: null,
      awaiting_confirmation: null,
      attachments: [],
      created_at: now,
      updated_at: now,
    };
    await page.route(`**/api/v2/projects/${projectId}/assistant/conversations`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, conversations: [conversation] }) });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/v2/assistant/conversations/${conversationId}/messages`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: conversationId, messages: [{ id: 'MSG_STALE_E2E', role: 'user', content: '按当前规范生成候选', message_type: 'user', metadata: {}, attachments: [], created_at: now }] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/runs*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, runs: [run] }) });
    });
    await page.route('**/api/v2/contracts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle_version: '1.1', bundle_hash: currentContractHash, prompt_contract: { version: '2.1', workflow: 'frameflow-prompt-v2', field_order: [] }, story_contract: { version: '1.0', required_shot_fields: [], detail_fields: [], validation_rules: [] }, audio_contract: { version: 'minimax-speech-audio-v2', required_fields: [] }, workflow_contract: { version: '1.0', available_skills: [] } }) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(run) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}/events*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run_id: runId, events: [{ run_id: runId, sequence: 1, item_id: 'plan_preview', event_type: 'item_completed', status: 'succeeded', data: { operation_count: 1 }, created_at: now }] }) });
    });
    let applyCalled = false;
    await page.route(`**/api/v2/assistant/runs/${runId}/apply`, async (route) => {
      applyCalled = true;
      await route.continue();
    });

    await page.goto('/');
    await switchToProject(page, projectName, projectId);
    await page.locator('.assistant-launcher').click();
    await expect(page.getByText('规范已更新，计划已冻结')).toBeVisible();
    await expect(page.getByText(/本计划基于 a{12}/)).toBeVisible();
    await expect(page.locator('.assistant-operation-card').first()).toHaveClass(/disabled/);
    await expect(page.locator('.assistant-operation-card').first().locator('input[type="checkbox"]')).toBeDisabled();
    await expect(page.getByRole('button', { name: '规范已更新' })).toBeDisabled();
    await page.locator('.assistant-plan-stale button').click();
    await expect(page.getByLabel('向 FRAMEFLOW Agent 提问')).toHaveValue('按当前规范生成候选');
    expect(applyCalled).toBeFalsy();
  });

  test('exposes a retry button for a failed run and restores the original message', async ({ page }) => {
    const projectName = `助手失败重试验收项目-${Date.now()}`;
    const projectId = await seedProject(page, projectName);
    const now = '2026-01-01T00:00:00Z';
    const conversationId = 'CONV_FAILED_E2E';
    const runId = 'ARUN_FAILED_E2E';
    const contractHash = 'd'.repeat(64);
    const conversation = { id: conversationId, project_id: projectId, title: '失败重试会话', status: 'active', last_contract_hash: contractHash, external_consent: [], message_count: 1, last_message: '进行工作台功能测试', pending_plan_count: 0, created_at: now, updated_at: now };
    const run = {
      id: runId,
      project_id: projectId,
      conversation_id: conversationId,
      source_message_id: 'MSG_FAILED_E2E',
      client_message_id: 'CLIENT_FAILED_E2E',
      status: 'failed',
      contract_hash: contractHash,
      contract_snapshot: { bundle_hash: contractHash, bundle_version: '1.0' },
      skill: { skill_id: 'video-script-storyboard', skill_version: '1.0.0' },
      provider_profile_id: 'openai-default',
      provider_model: 'gpt-5.6-terra',
      base_project_revision: 1,
      base_graph_revision: 1,
      base_timeline_revision: 1,
      checkpoint: { last_event: 'run_failed' },
      result: {},
      error: { message: '模拟 Provider 输入超限', kind: 'validation', status: 422 },
      awaiting_confirmation: null,
      attachments: [],
      created_at: now,
      updated_at: now,
    };
    await page.route(`**/api/v2/projects/${projectId}/assistant/conversations`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, conversations: [conversation] }) });
        return;
      }
      await route.continue();
    });
    await page.route(`**/api/v2/assistant/conversations/${conversationId}/messages`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: conversationId, messages: [{ id: 'MSG_FAILED_E2E', role: 'user', content: '进行工作台功能测试', message_type: 'user', metadata: {}, attachments: [], created_at: now }] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/runs*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, runs: [run] }) });
    });
    await page.route('**/api/v2/contracts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle_version: '1.0', bundle_hash: contractHash, prompt_contract: { version: '2.0', workflow: 'frameflow-prompt-v2', field_order: [] }, story_contract: { version: '1.0', required_shot_fields: [], detail_fields: [], validation_rules: [] }, audio_contract: { version: 'minimax-speech-audio-v2', required_fields: [] }, workflow_contract: { version: '1.0', available_skills: [] } }) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(run) });
    });
    await page.route(`**/api/v2/assistant/runs/${runId}/events*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ run_id: runId, events: [{ run_id: runId, sequence: 1, item_id: null, event_type: 'run_failed', status: 'failed', data: { message: '模拟 Provider 输入超限' }, created_at: now }] }) });
    });

    await page.goto('/');
    await switchToProject(page, projectName, projectId);
    await page.locator('.assistant-launcher').click();
    await expect(page.getByRole('alert')).toContainText('模拟 Provider 输入超限');
    const retry = page.locator('.assistant-run-error-actions').getByRole('button', { name: '重新生成' });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.getByLabel('向 FRAMEFLOW Agent 提问')).toHaveValue('进行工作台功能测试');
  });

  test('creates, archives, restores sessions and manages composer attachments', async ({ page }) => {
    const projectName = `助手会话管理验收项目-${Date.now()}`;
    const projectId = await seedProject(page, projectName);
    const now = '2026-01-01T00:00:00Z';
    let conversation = { id: 'CONV_SESSION_E2E', project_id: projectId, title: '初始会话', status: 'active', last_contract_hash: null, external_consent: ['openai-default'], message_count: 0, last_message: '上一条项目资料检查消息', pending_plan_count: 0, created_at: now, updated_at: now };
    let createdConversation = { id: 'CONV_NEW_E2E', project_id: projectId, title: '新会话', status: 'active', last_contract_hash: null, external_consent: [], message_count: 0, pending_plan_count: 0, created_at: now, updated_at: now };
    let uploadCount = 0;
    let failNextUpload = true;
    const attachment = (name: string) => ({ id: `ATT_SESSION_${++uploadCount}`, project_id: projectId, conversation_id: null, message_id: null, name, safe_name: name, mime_type: name.endsWith('.png') ? 'image/png' : 'text/plain', extension: name.endsWith('.png') ? '.png' : '.txt', byte_size: 12, sha256: 'd'.repeat(64), kind: name.endsWith('.png') ? 'image' : 'document', delivery_mode: 'pending', analysis_status: 'pending', extracted_chars: 0, extraction_error: null, metadata: {}, url: `/api/v2/assistant/attachments/ATT_SESSION_${uploadCount}`, created_at: now, updated_at: now });
    await page.route(`**/api/v2/projects/${projectId}/assistant/conversations`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, conversations: [conversation] }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation: createdConversation }) });
    });
    await page.route(`**/api/v2/assistant/conversations/${conversation.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      const payload = route.request().postDataJSON() as { title: string };
      conversation = { ...conversation, title: payload.title };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation }) });
    });
    await page.route('**/api/v2/assistant/conversations/*/messages', async (route) => {
      const id = route.request().url().split('/').at(-2);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation_id: id, messages: [] }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/runs*`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ project_id: projectId, runs: [] }) });
    });
    await page.route('**/api/v2/contracts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bundle_version: '1.0', bundle_hash: 'e'.repeat(64), prompt_contract: { version: '2.0', workflow: 'frameflow-prompt-v2', field_order: [] }, story_contract: { version: '1.0', required_shot_fields: [], detail_fields: [], validation_rules: [] }, audio_contract: { version: 'minimax-speech-audio-v2', required_fields: [] }, workflow_contract: { version: '1.0', available_skills: [] } }) });
    });
    await page.route(`**/api/v2/projects/${projectId}/assistant/attachments**`, async (route) => {
      if (failNextUpload) {
        failNextUpload = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: '模拟一次可重试的上传失败', retryable: true }) });
        return;
      }
      const rawBody = route.request().postData() || '';
      const fileName = rawBody.match(/filename="([^"]+)"/)?.[1] || (uploadCount === 0 ? 'first.txt' : uploadCount === 1 ? 'second.png' : 'drop.txt');
      const body = attachment(fileName);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ attachment: body }) });
    });
    await page.route('**/api/v2/assistant/conversations/*/external-consent/reset', async (route) => {
      conversation = { ...conversation, external_consent: [] };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation, message: '下一次带附件发送将重新要求外发确认。' }) });
    });
    await page.route('**/api/v2/assistant/conversations/*/archive', async (route) => {
      createdConversation = { ...createdConversation, status: 'archived' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation: createdConversation, message: '会话已归档；消息、附件和运行记录仍保留。' }) });
    });
    await page.route('**/api/v2/assistant/conversations/*/restore', async (route) => {
      createdConversation = { ...createdConversation, status: 'active' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ conversation: createdConversation, message: '会话已恢复为活动状态。' }) });
    });

    await page.goto('/');
    await switchToProject(page, projectName, projectId);
    await page.locator('.assistant-launcher').click();
    await expect(page.getByRole('button', { name: '重新确认外发范围' })).toBeVisible();
    await expect(page.getByText('上一条项目资料检查消息')).toBeVisible();
    await expect(page.getByText('Provider 能力', { exact: true })).toBeVisible();
    await expect(page.getByText('资产画布', { exact: true })).toBeVisible();
    await page.locator('.assistant-conversation-row').filter({ hasText: '初始会话' }).getByRole('button', { name: '重命名 初始会话' }).click();
    await page.getByRole('textbox', { name: '会话标题 初始会话' }).fill('人工命名会话');
    await page.getByRole('button', { name: '保存会话标题' }).click();
    await expect(page.locator('.assistant-conversation-row').filter({ hasText: '人工命名会话' })).toBeVisible();
    await page.getByLabel('搜索会话').fill('人工命名');
    await expect(page.locator('.assistant-conversation-row')).toHaveCount(1);
    await page.getByLabel('搜索会话').fill('不存在的会话');
    await expect(page.getByText('没有匹配的项目会话。')).toBeVisible();
    await page.getByLabel('搜索会话').fill('');
    await page.getByRole('button', { name: '重新确认外发范围' }).click();
    await expect(page.getByText('下一次带附件发送将重新要求外发确认。')).toBeVisible();
    await page.getByRole('button', { name: '收起' }).click();
    await expect(page.getByText('Provider 能力', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '展开' }).click();
    await expect(page.getByText('Provider 能力', { exact: true })).toBeVisible();
    await page.locator('.assistant-new-conversation').click();
    await expect(page.locator('.assistant-conversation-row').filter({ hasText: '新会话' })).toBeVisible();
    await page.locator('.assistant-conversation-row').filter({ hasText: '新会话' }).getByRole('button', { name: '归档 新会话' }).click();
    await expect(page.locator('.assistant-conversation-row').filter({ hasText: '已归档' })).toBeVisible();
    await page.locator('.assistant-conversation-row').filter({ hasText: '新会话' }).getByRole('button', { name: '恢复 新会话' }).click();
    await expect(page.locator('.assistant-conversation-row').filter({ hasText: '新会话' }).getByRole('button', { name: '归档 新会话' })).toBeVisible();

    const fileInput = page.locator('.assistant-composer-v2 input[type="file"]');
    await fileInput.setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry') });
    await expect(page.locator('.assistant-upload-row.failed')).toBeVisible();
    await page.locator('.assistant-upload-row.failed').getByRole('button', { name: '重试', exact: true }).click();
    await expect(page.locator('.assistant-upload-row.saved')).toBeVisible();
    await expect(page.locator('.assistant-composer-attachments .assistant-attachment-card')).toHaveCount(1);
    await page.getByRole('button', { name: '移除 retry.txt' }).click();
    await expect(page.locator('.assistant-composer-attachments .assistant-attachment-card')).toHaveCount(0);
    await fileInput.setInputFiles([
      { name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
      { name: 'second.png', mimeType: 'image/png', buffer: Buffer.from('two') },
    ]);
    await expect(page.locator('.assistant-composer-attachments .assistant-attachment-card')).toHaveCount(2);
    await page.getByRole('button', { name: '移除 first.txt' }).click();
    await expect(page.locator('.assistant-composer-attachments .assistant-attachment-card')).toHaveCount(1);

    await page.locator('.assistant-workspace').evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['drop'], 'drop.txt', { type: 'text/plain' }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
    });
    await expect(page.locator('.assistant-composer-attachments .assistant-attachment-card')).toHaveCount(2);

    await page.locator('textarea[aria-label="向 FRAMEFLOW Agent 提问"]').evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['paste'], 'paste.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dataTransfer }));
    });
    await expect(page.locator('.assistant-composer-attachments .assistant-attachment-card')).toHaveCount(3);
    await page.getByRole('button', { name: '返回当前工作区' }).click();
    await expect(page.getByRole('dialog', { name: /FRAMEFLOW AI Agent 工作台/ })).toHaveCount(0);
  });
});
