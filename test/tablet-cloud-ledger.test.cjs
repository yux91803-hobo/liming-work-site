// 平板 liming-cloud 阶段 2 单测：台账原子写与权限、确定性编号与路径安全、发件箱崩溃恢复重放、secrets 权限校验与脱敏。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const pluginRoot = path.resolve(__dirname, '../site/tablet/liming-cloud');
const libDir = path.join(pluginRoot, 'lib');
const importLib = (file) => import(pathToFileURL(path.join(libDir, file)).href);

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablet-cloud-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const modeOf = (p) => fs.statSync(p).mode & 0o777;

// 忠实模拟阶段 1 实测确认的 Harness 0.2.2-rc.3 会话语义：
// - session/prompt 找不到会话报 session/not-found；同一 requestId 幂等不增消息不增轮次
// - session/create 空白同目录幂等、换目录报 session/conflict、已有轮次会话另建 session-<uuid>
function createFakeCloudHarness() {
  const sessions = new Map(); // sessionId -> { sessionId, cwd, requestIds: Set, messages: [], turns: 0 }
  const calls = [];
  let seqUuid = 0;

  let nextCreateFault = null;
  let nextPromptFault = null;
  let loseNextPromptReceipt = false;
  let forceWrongCreateId = null;

  function makeRpcError(code, message) {
    const err = new Error(`${code}: ${message}`);
    err.code = code;
    return err;
  }

  const client = {
    async createSession({ sessionId, cwd }) {
      calls.push({ method: 'session/create', sessionId, cwd });
      if (nextCreateFault) {
        const f = nextCreateFault;
        nextCreateFault = null;
        throw f;
      }
      if (forceWrongCreateId) {
        const bad = forceWrongCreateId;
        forceWrongCreateId = null;
        sessions.set(bad, { sessionId: bad, cwd, requestIds: new Set(), messages: [], turns: 0 });
        return { sessionId: bad };
      }
      const existing = sessions.get(sessionId);
      if (!existing) {
        sessions.set(sessionId, { sessionId, cwd, requestIds: new Set(), messages: [], turns: 0 });
        return { sessionId };
      }
      if (existing.cwd !== cwd) {
        throw makeRpcError('session/conflict', `session ${sessionId} already bound to ${existing.cwd}`);
      }
      if (existing.turns === 0) {
        return { sessionId };
      }
      // 阶段 1 E1 实测边界：非空会话调 session/create 会新分配 session-<uuid>！
      const minted = `session-unexpected-${++seqUuid}`;
      sessions.set(minted, { sessionId: minted, cwd, requestIds: new Set(), messages: [], turns: 0 });
      return { sessionId: minted };
    },

    async prompt(sessionId, text, { requestId, mode = 'queue' } = {}) {
      calls.push({ method: 'session/prompt', sessionId, text, requestId, mode });
      if (nextPromptFault) {
        const f = nextPromptFault;
        nextPromptFault = null;
        throw f;
      }
      const sess = sessions.get(sessionId);
      if (!sess) {
        throw makeRpcError('session/not-found', `session ${sessionId} not found`);
      }
      if (!sess.requestIds.has(requestId)) {
        sess.requestIds.add(requestId);
        sess.messages.push({ requestId, text, mode });
        if (mode === 'queue' || sess.turns === 0) {
          sess.turns += 1;
        }
      }
      if (loseNextPromptReceipt) {
        loseNextPromptReceipt = false;
        const drop = new Error('ECONNRESET: connection dropped after cloud accepted');
        drop.code = 'SOCKET_ERROR';
        throw drop;
      }
      return { accepted: true };
    },
  };

  return {
    client,
    sessions,
    calls,
    failNextCreate(err) { nextCreateFault = err; },
    failNextPrompt(err) { nextPromptFault = err; },
    dropNextPromptReceipt() { loseNextPromptReceipt = true; },
    returnWrongCreateId(id) { forceWrongCreateId = id; },
  };
}

test('台账初始化强制目录 700 / 文件 600，原子写中断不损坏原文件且不留临时文件', async (t) => {
  const { createLedger, LEDGER_SCHEMA_VERSION } = await importLib('ledger.js');
  const root = tmpDir(t);
  const cloudDir = path.join(root, '.liming-cloud');

  const ledger = createLedger({ dir: cloudDir, now: () => 1700000000000 });
  const initial = ledger.init();
  assert.equal(initial.schemaVersion, LEDGER_SCHEMA_VERSION);
  assert.equal(modeOf(cloudDir), 0o700, '目录权限必须是 700');
  assert.equal(modeOf(ledger.filePath), 0o600, 'tasks.json 权限必须是 600');

  const created = ledger.createTask({
    taskId: 'task_alpha_01',
    tabletSessionId: 'sess-local-1',
    machine: 'li2',
    title: 'Research DSH Repo',
  });
  assert.equal(created.status, 'dispatching');
  assert.equal(created.noticeState, 'none');
  const snapshotBeforeCrash = fs.readFileSync(ledger.filePath, 'utf8');

  // 模拟原子写到 rename 前瞬间崩溃
  const crashingLedger = createLedger({
    dir: cloudDir,
    beforeRename() {
      throw new Error('simulated crash before rename');
    },
  });
  assert.throws(
    () => crashingLedger.createTask({ taskId: 'task_beta_02', machine: 'li', title: 'Should Rollback' }),
    /simulated crash before rename/,
  );

  // 原文件毫发无损，且不留 .tmp.* 文件
  assert.equal(fs.readFileSync(ledger.filePath, 'utf8'), snapshotBeforeCrash);
  assert.equal(modeOf(ledger.filePath), 0o600);
  const leftovers = fs.readdirSync(cloudDir).filter(f => f.includes('.tmp.'));
  assert.deepEqual(leftovers, []);
});

test('台账 schemaVersion 读写、迁移钩子与未知高版本保护', async (t) => {
  const { createLedger, LEDGER_SCHEMA_VERSION } = await importLib('ledger.js');
  const cloudDir = path.join(tmpDir(t), '.liming-cloud');
  fs.mkdirSync(cloudDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(cloudDir, 'tasks.json');

  // 未知高版本必须拒绝读取与覆写，原文件内容保持不变
  const futurePayload = JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION + 5, tasks: {}, extra: true });
  fs.writeFileSync(filePath, futurePayload, { mode: 0o600 });
  const ledger = createLedger({ dir: cloudDir });
  assert.throws(
    () => ledger.load(),
    (err) => err.code === 'LEDGER_UNSUPPORTED_VERSION',
  );
  assert.throws(
    () => ledger.createTask({ taskId: 't_new_01', machine: 'li2', title: 'Blocked' }),
    (err) => err.code === 'LEDGER_UNSUPPORTED_VERSION',
  );
  assert.equal(fs.readFileSync(filePath, 'utf8'), futurePayload, '未知高版本台账绝不被覆写');

  // 迁移钩子：旧版本 v0 经迁移升级到 v1 并校验通过
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 0,
    legacyList: [{
      taskId: 't_mig_01',
      tabletSessionId: 'tab-1',
      machine: 'li',
      cloudSessionId: 'tablet-t_mig_01',
      project: 'mig-tmig01',
      cwd: '/data/workspace/tablet/mig-tmig01',
      title: 'Migrated Task',
      status: 'completed',
      createdAt: 1,
      startedAt: 1,
      endedAt: 2,
      updatedAt: 2,
      lastSeq: 3,
      outbox: [],
      stopRequest: null,
      noticeState: 'confirmed',
      noticeMeta: null,
      summary: 'ok',
      jobId: null,
      lastError: null,
    }],
  }), { mode: 0o600 });

  const migratedLedger = createLedger({
    dir: cloudDir,
    migrations: {
      0: (doc) => ({
        schemaVersion: 1,
        tasks: Object.fromEntries(doc.legacyList.map(item => [item.taskId, item])),
      }),
    },
  });
  const doc = migratedLedger.init();
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.tasks.t_mig_01.status, 'completed');
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schemaVersion, 1);
});

test('确定性云端对话编号与纯 ASCII 项目目录名生成，严格拒绝路径穿越', async (t) => {
  const {
    cloudSessionIdForTask,
    projectDirName,
    resolveProjectCwd,
    createLedger,
  } = await importLib('ledger.js');

  assert.equal(cloudSessionIdForTask('t_abc12345'), 'tablet-t_abc12345');
  assert.equal(cloudSessionIdForTask('t_abc12345'), cloudSessionIdForTask('t_abc12345'));

  const p1 = projectDirName('Research GitHub / Next.js App!', 't_m1_9a8b7c6d');
  const p2 = projectDirName('研究 STM32 DMA 驱动', 't_m1_9a8b7c6d');
  const p3 = projectDirName('整理今天的学习笔记', 't_m1_9a8b7c6d');
  for (const p of [p1, p2, p3]) {
    assert.match(p, /^[a-z0-9][a-z0-9-]{0,63}$/);
    assert.ok(p.endsWith('9a8b7c6d'));
  }
  assert.ok(p1.startsWith('research-github-next-js-app-'));
  assert.ok(p2.startsWith('stm32-dma-'));
  assert.ok(p3.startsWith('task-'));
  assert.equal(resolveProjectCwd(p2), `/data/workspace/tablet/${p2}`);

  const ledger = createLedger({ dir: path.join(tmpDir(t), '.liming-cloud') });
  for (const bad of ['../etc', 'a/b', 'a\\b', '..\\secret', '.hidden', 'foo/../../bar', '', 'bad name', 'x\0y']) {
    assert.throws(() => resolveProjectCwd(bad), /LEDGER_INVALID_PROJECT|非法项目目录名|不能为空/);
    assert.throws(() => ledger.createTask({ taskId: 't_safe_01', machine: 'li2', project: bad }), Error);
  }
  assert.throws(
    () => ledger.createTask({ taskId: 't_safe_02', machine: 'li2', project: 'good-1234', cwd: '/etc/passwd' }),
    (err) => err.code === 'LEDGER_PATH_TRAVERSAL',
  );
});

test('发件箱三种崩溃点重放后云端只有 1 份对话、1 条消息、1 轮；补充要求重发只多 1 轮', async (t) => {
  const { createLedger } = await importLib('ledger.js');
  const { createOutbox } = await importLib('outbox.js');

  // 崩溃点 1：写入台账发件箱后、session/create 前崩溃
  {
    const dir = path.join(tmpDir(t), 'crash1');
    const cloud = createFakeCloudHarness();
    const ledger1 = createLedger({ dir });
    const outbox1 = createOutbox(ledger1);
    const task = ledger1.createTask({ taskId: 't_c1_0001', machine: 'li2', title: 'Crash Before Create' });
    const entry = outbox1.enqueue(task.taskId, { text: 'analyze repo', requestId: 'req-c1-1' });
    assert.equal(entry.status, 'pending');
    assert.equal(cloud.sessions.size, 0, '仅 enqueue 不得提前发网络请求');

    // 模拟进程重启，从磁盘重读台账并重放
    const ledger2 = createLedger({ dir });
    const outbox2 = createOutbox(ledger2);
    const r1 = await outbox2.flushOutbox(task.taskId, cloud.client);
    assert.equal(r1.pendingRemaining, 0);
    assert.equal(r1.sent.length, 1);
    assert.equal(r1.sent[0].createdSession, true);

    const sess = cloud.sessions.get(task.cloudSessionId);
    assert.equal(cloud.sessions.size, 1);
    assert.equal(sess.messages.length, 1);
    assert.equal(sess.turns, 1);
    assert.equal(ledger2.getTask(task.taskId).status, 'running');

    // 再次 flush 跳过已 ack 条目，零网络调用
    const callsBefore = cloud.calls.length;
    const r2 = await outbox2.flushOutbox(task.taskId, cloud.client);
    assert.deepEqual(r2.skipped, ['req-c1-1']);
    assert.equal(cloud.calls.length, callsBefore);
  }

  // 崩溃点 2：session/create 成功后、session/prompt 发出前崩溃
  {
    const dir = path.join(tmpDir(t), 'crash2');
    const cloud = createFakeCloudHarness();
    const ledger1 = createLedger({ dir });
    const outbox1 = createOutbox(ledger1);
    const task = ledger1.createTask({ taskId: 't_c2_0001', machine: 'li2', title: 'Crash After Create' });
    outbox1.enqueue(task.taskId, { text: 'build firmware', requestId: 'req-c2-1' });

    // 让首次 prompt（发现 not-found）后 createSession 成功，但紧接着的 prompt 抛断线错
    const origPrompt = cloud.client.prompt.bind(cloud.client);
    let promptCount = 0;
    const crashingClient = {
      createSession: cloud.client.createSession.bind(cloud.client),
      async prompt(...args) {
        promptCount += 1;
        if (promptCount === 2) {
          const e = new Error('network down before prompt reached cloud');
          e.code = 'SOCKET_ERROR';
          throw e;
        }
        return origPrompt(...args);
      },
    };
    await assert.rejects(() => outbox1.flushOutbox(task.taskId, crashingClient), /network down/);
    assert.equal(cloud.sessions.size, 1, '云端对话已建好');
    assert.equal(cloud.sessions.get(task.cloudSessionId).turns, 0, '消息尚未发出去');
    assert.equal(ledger1.getTask(task.taskId).outbox[0].status, 'pending');

    // 重启后重放：先调 session/prompt，空白对话已存在直接成功，不再多建会话
    const ledger2 = createLedger({ dir });
    const outbox2 = createOutbox(ledger2);
    const res = await outbox2.flushOutbox(task.taskId, cloud.client);
    assert.equal(res.pendingRemaining, 0);
    assert.equal(res.sent[0].createdSession, false);
    const sess = cloud.sessions.get(task.cloudSessionId);
    assert.equal(cloud.sessions.size, 1);
    assert.equal(sess.messages.length, 1);
    assert.equal(sess.turns, 1);
  }

  // 崩溃点 3：云端接受后丢回执崩溃 + 后续 cloud_tell 补充要求重发只多 1 轮
  {
    const dir = path.join(tmpDir(t), 'crash3');
    const cloud = createFakeCloudHarness();
    const ledger1 = createLedger({ dir });
    const outbox1 = createOutbox(ledger1);
    const task = ledger1.createTask({ taskId: 't_c3_0001', machine: 'li', title: 'Drop Ack After Accept' });
    outbox1.enqueue(task.taskId, { text: 'initial goal', requestId: 'req-c3-1' });

    cloud.dropNextPromptReceipt();
    await assert.rejects(() => outbox1.flushOutbox(task.taskId, cloud.client), /ECONNRESET/);
    assert.equal(cloud.sessions.size, 1);
    assert.equal(cloud.sessions.get(task.cloudSessionId).turns, 1, '云端已经接受并跑起第 1 轮');
    assert.equal(ledger1.getTask(task.taskId).outbox[0].status, 'pending', '平板未收到回执仍记 pending');

    // 重启后重放：绝不误调 session/create（否则云端 0.2.2-rc.3 会另建 session-<uuid>）
    const createsBeforeReplay = cloud.calls.filter(c => c.method === 'session/create').length;
    const ledger2 = createLedger({ dir });
    const outbox2 = createOutbox(ledger2);
    const replayed = await outbox2.flushOutbox(task.taskId, cloud.client);
    assert.equal(replayed.pendingRemaining, 0);
    assert.equal(replayed.sent[0].createdSession, false);
    assert.equal(
      cloud.calls.filter(c => c.method === 'session/create').length,
      createsBeforeReplay,
      '已有轮次会话恢复不得误调 session/create',
    );
    assert.equal(cloud.sessions.size, 1, '云端严格只有 1 份对话');
    assert.equal(cloud.sessions.get(task.cloudSessionId).messages.length, 1);
    assert.equal(cloud.sessions.get(task.cloudSessionId).turns, 1);

    // 补充要求（cloud_tell）同样丢回执再重发：严格只多 1 轮（总计 2 条消息、2 轮）
    outbox2.enqueue(task.taskId, { text: 'follow up requirement', requestId: 'req-c3-2', mode: 'queue' });
    cloud.dropNextPromptReceipt();
    await assert.rejects(() => outbox2.flushOutbox(task.taskId, cloud.client), /ECONNRESET/);
    await outbox2.flushOutbox(task.taskId, cloud.client);

    const sess = cloud.sessions.get(task.cloudSessionId);
    assert.equal(cloud.sessions.size, 1);
    assert.equal(sess.messages.length, 2);
    assert.equal(sess.turns, 2);
    assert.equal(cloud.calls.filter(c => c.method === 'session/create').length, createsBeforeReplay);
  }
});

test('发件箱保护：session/create 返回不一致 sessionId 拒绝派发；session/conflict 如实报错', async (t) => {
  const { createLedger } = await importLib('ledger.js');
  const { createOutbox } = await importLib('outbox.js');

  // 返回不一致 sessionId -> 拒绝继续发 prompt
  {
    const dir = path.join(tmpDir(t), 'mismatch');
    const cloud = createFakeCloudHarness();
    const ledger = createLedger({ dir });
    const outbox = createOutbox(ledger);
    const task = ledger.createTask({ taskId: 't_mm_0001', machine: 'li2', title: 'Mismatch Guard' });
    outbox.enqueue(task.taskId, { text: 'hello', requestId: 'req-mm-1' });
    cloud.returnWrongCreateId('session-stray-999');

    await assert.rejects(
      () => outbox.flushOutbox(task.taskId, cloud.client),
      (err) => err.code === 'OUTBOX_SESSION_ID_MISMATCH',
    );
    // 确认未向错误会话发 prompt
    assert.equal(cloud.sessions.get('session-stray-999').messages.length, 0);
    assert.equal(ledger.getTask(task.taskId).outbox[0].status, 'pending');
  }

  // session/conflict -> 如实抛出 session/conflict，不伪报成功
  {
    const dir = path.join(tmpDir(t), 'conflict');
    const cloud = createFakeCloudHarness();
    const ledger = createLedger({ dir });
    const outbox = createOutbox(ledger);
    const task = ledger.createTask({ taskId: 't_cf_0001', machine: 'li2', title: 'Conflict Guard' });
    outbox.enqueue(task.taskId, { text: 'hello', requestId: 'req-cf-1' });

    const conflictErr = new Error('session/conflict: cwd mismatch');
    conflictErr.code = 'session/conflict';
    cloud.failNextCreate(conflictErr);

    await assert.rejects(
      () => outbox.flushOutbox(task.taskId, cloud.client),
      (err) => err.code === 'session/conflict',
    );
    const saved = ledger.getTask(task.taskId).outbox[0];
    assert.equal(saved.status, 'pending');
    assert.match(saved.lastError, /session\/conflict/);
  }
});

test('secrets.json 强制 700/600 权限、拒绝 machines:delete 与写权限字段、按机器返回凭据且报错不泄露密钥', async (t) => {
  const { createSecretsStore } = await importLib('secrets.js');
  const cloudDir = path.join(tmpDir(t), '.liming-cloud');
  const store = createSecretsStore({ dir: cloudDir });

  const li2Ssh = 'ibssh_FakeTokenLi2Alpha9876@li2.instabox.test';
  const li2Key = 'ibk_FakeReadOnlyKeyLi2987654';
  store.setMachine('li2', { sshTarget: `ssh ${li2Ssh}`, readKey: li2Key, scopes: ['machines:read'] });

  assert.equal(modeOf(cloudDir), 0o700);
  assert.equal(modeOf(store.filePath), 0o600);
  assert.equal(store.inspectPermissions().secure, true);

  const m = store.getMachine('li2');
  assert.equal(m.sshTarget, li2Ssh);
  assert.equal(m.readKey, li2Key);
  assert.deepEqual(store.listMachines(), ['li2']);

  // 拒绝 machines:delete / machines:write / writeKey / leaseKey / 非法结构
  const badCases = [
    { schemaVersion: 1, machines: { li2: { sshTarget: li2Ssh, readKey: li2Key, scopes: ['machines:read', 'machines:delete'] } } },
    { schemaVersion: 1, machines: { li2: { sshTarget: li2Ssh, readKey: li2Key, scopes: ['machines:write'] } } },
    { schemaVersion: 1, machines: { li2: { sshTarget: li2Ssh, writeKey: 'ibk_FakeWriteKey123456' } } },
    { schemaVersion: 1, machines: { li2: { sshTarget: li2Ssh, leaseKey: 'ibk_FakeLeaseKey123456' } } },
    { schemaVersion: 1, machines: { li2: { sshTarget: 'root@li2.instabox.test', readKey: li2Key } } },
    { schemaVersion: 1, machines: { li2: { sshTarget: 'ibssh_abc@li2.test; rm -rf /' } } },
    { schemaVersion: 99, machines: {} },
    'not-an-object',
  ];
  for (const bad of badCases) {
    assert.throws(
      () => store.save(bad),
      (err) => {
        assert.ok(!err.message.includes('FakeTokenLi2Alpha9876'));
        assert.ok(!err.message.includes('FakeWriteKey123456'));
        assert.ok(!err.message.includes('FakeLeaseKey123456'));
        return true;
      },
    );
  }

  // 权限放宽时 strictPermissions 能检出
  fs.chmodSync(store.filePath, 0o644);
  assert.equal(store.inspectPermissions().secure, false);
  assert.throws(
    () => store.load({ strictPermissions: true }),
    (err) => err.code === 'SECRETS_INSECURE_PERMISSIONS',
  );
});

test('redact 100% 屏蔽 SSH 令牌、InstaBox key、网关 key、DSH Cookie 与 launch token', async () => {
  const { redactText, redactValue, redactError, createRedactingLogger } = await importLib('redact.js');
  const rawSecrets = [
    'ibssh_SecretSshTok998877',
    'ibk_SecretInstaBoxKey112233',
    'sk-GatewaySecretKey998877665544',
    'dsh-auth-AbCdEf123456=v1.eyJhdXRoIjoxfQ.SignatureXYZ',
    'LaunchTokSecret445566',
    'BearerSecretToken778899',
  ];
  const sample = [
    `ssh ${rawSecrets[0]}@li2.instabox.sh`,
    `readKey=${rawSecrets[1]}`,
    `gateway=${rawSecrets[2]}`,
    `Cookie: ${rawSecrets[3]}; Path=/`,
    `dsh web: http://127.0.0.1:43210/?token=${rawSecrets[4]}&foo=1`,
    `Authorization: Bearer ${rawSecrets[5]}`,
    `x-dsh-auth-token: AccountTok12345`,
  ].join('\n');

  const redacted = redactText(sample);
  for (const s of [...rawSecrets, 'AccountTok12345']) {
    assert.ok(!redacted.includes(s), `脱敏结果不应包含 ${s}：${redacted}`);
  }
  assert.ok(redacted.includes('@li2.instabox.sh'), '保留脱敏后的主机名便于排查');
  assert.ok(redacted.includes('token=[REDACTED]'));

  const obj = redactValue({
    machine: 'li2',
    sshTarget: `${rawSecrets[0]}@li2.instabox.sh`,
    readKey: rawSecrets[1],
    nested: { detail: `failed with ${rawSecrets[2]} and ?token=${rawSecrets[4]}` },
  });
  const objJson = JSON.stringify(obj);
  for (const s of rawSecrets) assert.ok(!objJson.includes(s));

  const err = redactError(new Error(`RPC failed cookie=${rawSecrets[3]} key=${rawSecrets[1]}`));
  for (const s of rawSecrets) assert.ok(!err.message.includes(s));

  const logged = [];
  const safeLog = createRedactingLogger({ warn: (...a) => logged.push(a.join(' ')) }, [rawSecrets[0]]);
  safeLog.warn(`connect failed ${rawSecrets[0]}@li2 token=${rawSecrets[4]}`);
  assert.equal(logged.length, 1);
  assert.ok(!logged[0].includes(rawSecrets[0]));
  assert.ok(!logged[0].includes(rawSecrets[4]));
});

// 阶段 3 起入口要注册三个工具和一段使用说明（原阶段 2 这项断言「不注册工具」，按计划在阶段 3 改成下面这样）
test('liming-cloud 插件入口与 package.json 合规：零依赖，注册三个工具和使用说明，台账权限 700/600', async (t) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'liming-cloud');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.2 <0.3.0-0');
  assert.equal(pkg.engines.node, '>=22.19');
  assert.equal(pkg.dependencies, undefined, '零外部依赖');

  const plugin = await importLib('index.js');
  assert.equal(plugin.name, 'liming-cloud');
  assert.deepEqual([...plugin.inject].sort(), ['agents', 'jobs', 'systemPrompt', 'tools']);
  assert.ok(!plugin.inject.includes('dshGo') && !plugin.inject.includes('dshGo?'), 'dshGo 只能用 ctx.inject([\'dshGo\'], …) 挂，不放顶层');

  const cloudDir = path.join(tmpDir(t), '.liming-cloud');
  const effects = [];
  const tools = [];
  const sections = [];
  const ctx = {
    effect: (fn) => effects.push(fn),
    tools: { register: (def) => { tools.push(def.name); return () => {}; } },
    jobs: { start: () => { throw new Error('入口不该直接起任务'); } },
    agents: { get: () => undefined },
    systemPrompt: { section: (s) => { sections.push(s); return () => {}; }, getSectionOrder: () => 500 },
    on: () => () => {},
    inject: () => {},
  };
  plugin.apply(ctx, { dir: cloudDir });
  assert.deepEqual(tools.sort(), ['cloud_machines', 'cloud_run', 'cloud_tell']);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'liming-cloud');
  assert.match(sections[0].text, /cloud_run/);
  assert.equal(effects.length, 1);
  const dispose = effects[0]();
  assert.ok(fs.existsSync(path.join(cloudDir, 'tasks.json')));
  assert.equal(modeOf(cloudDir), 0o700);
  assert.equal(modeOf(path.join(cloudDir, 'tasks.json')), 0o600);
  await dispose();
});
