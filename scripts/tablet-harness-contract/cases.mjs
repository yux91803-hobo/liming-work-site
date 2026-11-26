// 真实 Harness 契约测试用例（对应设计 docs/superpowers/specs/2026-11-26-tablet-cloud-tasks-design.md 第 7、11 节）。
// 覆盖：E1–E6、E7a–E7f、以及第 7 节点名的两项通知补验（C1、C2）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { DshRpcError } from './dsh-client.mjs';
import {
  DshHarnessRunner,
  findProcessesInDir,
  killProcessesInDir,
  pidAlive,
  sleep,
  waitFor,
} from './dsh-runner.mjs';

function turnEndsOf(events) {
  return events.filter(e => e.type === 'turn/end');
}

function turnStartsOf(events) {
  return events.filter(e => e.type === 'turn/start');
}

function userMessagesOf(events) {
  return events.filter(e => e.type === 'user/message');
}

function textOfUserEvent(event) {
  return (event?.data?.content || [])
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}

async function waitTurnCount(client, sessionId, wantEnds, timeoutMs = 15000) {
  return waitFor(async () => {
    const events = await client.readAllEvents(sessionId);
    const st = await client.state(sessionId);
    if (!st.running && turnEndsOf(events).length >= wantEnds) return events;
    return null;
  }, { timeoutMs, intervalMs: 60, label: `session ${sessionId} reaching ${wantEnds} completed turns` });
}

function scanTeardownCancelReasons(dshBin) {
  const realBin = fs.realpathSync(dshBin);
  // 从 dsh bin 向上找到 node_modules/@deepseek-ai
  let cur = path.dirname(realBin);
  let scopeDir = null;
  for (let i = 0; i < 6; i++) {
    const cand = path.join(cur, 'node_modules', '@deepseek-ai');
    if (fs.existsSync(cand)) { scopeDir = cand; break; }
    if (path.basename(cur) === '@deepseek-ai') { scopeDir = cur; break; }
    cur = path.dirname(cur);
  }
  if (!scopeDir) return { checked: false, reasons: [], missing: [] };
  const targetFile = path.join(scopeDir, 'dsh-jobs-local', 'lib', 'index.js');
  if (!fs.existsSync(targetFile)) return { checked: false, reasons: [], missing: [] };
  const code = fs.readFileSync(targetFile, 'utf8');
  const found = new Set();
  for (const m of code.matchAll(/cancelForTeardown\([^,]+,\s*['"]([^'"]+)['"]\)/g)) found.add(m[1]);
  for (const m of code.matchAll(/disposeAll\(\),\s*['"]([^'"]+)['"]/g)) found.add(m[1]);
  for (const m of code.matchAll(/settleCause\s*=\s*['"]([^'"]+)['"]/g)) {
    if (m[1] === 'teardown') found.add(m[1]);
  }
  const allow = new Set(['owner disposed', 'jobs service disposed', 'jobs teardown', 'teardown']);
  const unknown = [...found].filter(r => !allow.has(r));
  return { checked: true, reasons: [...found].sort(), unknown };
}

export const CONTRACT_CASES = [
  {
    id: 'E1',
    name: '重复建对话（同编号同目录幂等、换目录冲突、非空会话边界）',
    targets: ['rc3'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, label: 'e1' });
      try {
        mockServer.reset(() => ({ text: 'e1-reply' }));
        const client = await runner.start();
        const dirA = path.join(runner.workspace, 'proj-a');
        const dirB = path.join(runner.workspace, 'proj-b');
        fs.mkdirSync(dirA, { recursive: true });
        fs.mkdirSync(dirB, { recursive: true });

        const sid = `tablet-e1-${randomUUID().slice(0, 8)}`;
        const first = await client.createSession({ sessionId: sid, cwd: dirA });
        assert.equal(first.sessionId, sid, '首次建对话应使用客户端指定的 sessionId');

        const second = await client.createSession({ sessionId: sid, cwd: dirA });
        assert.equal(second.sessionId, sid, '空白会话同编号同目录重复建应返回原 sessionId');

        let conflictCode = null;
        try {
          await client.createSession({ sessionId: sid, cwd: dirB });
        } catch (err) {
          assert.ok(err instanceof DshRpcError, `换目录应返回 DshRpcError，实际：${err}`);
          conflictCode = err.code;
        }
        assert.equal(conflictCode, 'session/conflict', '同编号换目录应返回 session/conflict');

        // 额外核实非空会话行为（实施计划关键护栏）：开始过一轮后再调 session/create 会新分配 session-<uuid>
        await client.prompt(sid, 'hello E1', { requestId: `req-e1-${randomUUID().slice(0, 8)}` });
        await waitTurnCount(client, sid, 1);
        const afterTurn = await client.createSession({ sessionId: sid, cwd: dirA });
        const nonBlankMintedNew = afterTurn.sessionId !== sid;
        assert.equal(nonBlankMintedNew, true, '已有轮次会话再调 session/create 时，上游按预期新分配会话编号而非静默复写');

        return `同目录空白幂等(${sid})，换目录报 ${conflictCode}，非空再建分配新号(${afterTurn.sessionId})`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E2',
    name: '请求编号幂等（连发两次、空闲重发、云端 SIGKILL 重启后重发）',
    targets: ['rc3'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, label: 'e2' });
      try {
        mockServer.reset(() => ({ text: 'e2-single-reply' }));
        let client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-e2');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-e2-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });

        const reqId = `req-e2-${randomUUID().slice(0, 8)}`;
        const [r1, r2] = await Promise.all([
          client.prompt(sid, 'only once please', { requestId: reqId }),
          client.prompt(sid, 'only once please', { requestId: reqId }),
        ]);
        assert.equal(r1.accepted, true);
        assert.equal(r2.accepted, true);

        await waitTurnCount(client, sid, 1);
        const r3 = await client.prompt(sid, 'only once please', { requestId: reqId });
        assert.equal(r3.accepted, true);
        await sleep(300);

        // 强杀云端 Harness 再重启，用同一个 requestId 重发
        await runner.killHard();
        client = await runner.start();
        const r4 = await client.prompt(sid, 'only once please', { requestId: reqId });
        assert.equal(r4.accepted, true);
        await sleep(400);

        const events = await client.readAllEvents(sid);
        const userMsgs = userMessagesOf(events).filter(e => e.data?.source?.kind === 'user');
        assert.equal(userMsgs.length, 1, `日志里应只有 1 条 user/message，实际 ${userMsgs.length}`);
        assert.equal(turnStartsOf(events).length, 1, `应只有 1 轮，实际 ${turnStartsOf(events).length}`);
        assert.equal(mockServer.requests.length, 1, `模拟模型应只被调用 1 次，实际 ${mockServer.requests.length}`);

        return `4 次发送同 requestId（含 SIGKILL 重启后），用户消息=1，轮次=1，模型请求=1`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E3',
    name: '插话进同一轮（前台 bash 运行中 steer，不另起新轮）',
    targets: ['rc3'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, label: 'e3' });
      try {
        const cwd = path.join(runner.workspace, 'proj-e3');
        fs.mkdirSync(cwd, { recursive: true });
        const startedFlag = path.join(cwd, 'started.flag');
        const releaseFlag = path.join(cwd, 'release.flag');

        let step = 0;
        mockServer.reset((req) => {
          step += 1;
          if (step === 1) {
            return {
              toolCalls: [{
                name: 'bash',
                arguments: {
                  description: 'Wait for steer release flag',
                  command: `touch "${startedFlag}"; while [ ! -f "${releaseFlag}" ]; do sleep 0.05; done; echo bash-done`,
                },
              }],
            };
          }
          return { text: `saw-steer: ${req.userTexts.join(' | ')}` };
        });

        const client = await runner.start();
        const sid = `tablet-e3-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'run step 1', { requestId: `req-e3-1-${randomUUID().slice(0, 8)}` });

        await waitFor(() => fs.existsSync(startedFlag), { timeoutMs: 15000, label: 'E3 bash started' });
        const steerText = 'STEER_TOKEN_E3_IN_SAME_TURN';
        const steerAck = await client.prompt(sid, steerText, {
          requestId: `req-e3-steer-${randomUUID().slice(0, 8)}`,
          mode: 'steer',
        });
        assert.equal(steerAck.accepted, true);

        // 放行 bash，让同一轮进入 step 2
        fs.writeFileSync(releaseFlag, 'go');
        const events = await waitTurnCount(client, sid, 1, 20000);
        await sleep(300);

        const eventsAfter = await client.readAllEvents(sid);
        assert.equal(turnStartsOf(eventsAfter).length, 1, `插话应留在同一轮，实际轮次=${turnStartsOf(eventsAfter).length}`);
        assert.equal(turnEndsOf(eventsAfter).length, 1, '应仅结束 1 轮');
        assert.ok(mockServer.requests.length >= 2, `至少 2 次模型请求，实际 ${mockServer.requests.length}`);
        const step2SawSteer = mockServer.requests[1].userTexts.some(t => t.includes(steerText));
        assert.equal(step2SawSteer, true, '第 2 步模型请求必须包含插话内容');

        const stepStarts = eventsAfter.filter(e => e.type === 'step/start').map(e => `${e.data.turn}.${e.data.step}`);
        return `单轮内完成插话（turns=1，steps=${stepStarts.join(',')}，step 2 收到 ${steerText}）`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E4',
    name: '停止前台工具（进程被杀、aborted/user 结束、空闲重复停仍回 accepted）',
    targets: ['rc3'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, label: 'e4' });
      try {
        const cwd = path.join(runner.workspace, 'proj-e4');
        fs.mkdirSync(cwd, { recursive: true });
        const readyFile = path.join(cwd, 'fg.ready');
        const marker = `E4_FG_${randomUUID().slice(0, 8)}`;

        // 使用宿主机 /proc/<pid>/cwd + marker 定位真实进程，兼容 bwrap(--unshare-pid)、landlock 与 full-access。
        mockServer.reset(() => ({
          toolCalls: [{
            name: 'bash',
            arguments: {
              description: 'Hold foreground process until cancelled',
              command: `exec node -e 'require("fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},60000)' "${readyFile}" "${marker}"`,
            },
          }],
        }));

        const client = await runner.start();
        const sid = `tablet-e4-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'start long fg command', { requestId: `req-e4-${randomUUID().slice(0, 8)}` });

        await waitFor(() => fs.existsSync(readyFile), { timeoutMs: 15000, label: 'E4 fg ready' });
        const fgProcs = await waitFor(() => {
          const list = findProcessesInDir(cwd, marker).filter(p => !p.cmdline.startsWith('bwrap'));
          return list.length > 0 ? list : null;
        }, { timeoutMs: 5000, label: 'E4 host fg process' });
        const fgPid = fgProcs[0].pid;
        assert.equal(pidAlive(fgPid), true, '停止前前台进程应活着');

        const cancel1 = await client.cancel(sid);
        assert.equal(cancel1.accepted, true);

        const events = await waitTurnCount(client, sid, 1, 15000);
        await waitFor(() => findProcessesInDir(cwd, marker).length === 0, { timeoutMs: 5000, label: 'E4 fg process dead' });

        const end = turnEndsOf(events).at(-1);
        assert.equal(end.data.reason.kind, 'aborted', `预期 aborted，实际 ${JSON.stringify(end.data.reason)}`);
        assert.equal(end.data.reason.reason?.kind, 'user', `预期原因 user，实际 ${JSON.stringify(end.data.reason)}`);

        // 空闲时再停一次，仍幂等回 accepted
        const cancel2 = await client.cancel(sid);
        assert.equal(cancel2.accepted, true, '空闲时重复 session/cancel 应回 accepted: true');

        return `前台宿主 PID ${fgPid} 已退出，turn/end=${end.data.reason.kind}/${end.data.reason.reason.kind}，空闲复停 accepted=true`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E5',
    name: '停止对话不停后台命令 + job/list 可见 + job/kill 才停（重复停回 already-finished）',
    targets: ['rc3'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, label: 'e5' });
      try {
        const cwd = path.join(runner.workspace, 'proj-e5');
        fs.mkdirSync(cwd, { recursive: true });
        const bgReadyFile = path.join(cwd, 'bg.ready');
        const fgFlag = path.join(cwd, 'fg2.flag');
        const bgMarker = `E5_BG_${randomUUID().slice(0, 8)}`;

        let step = 0;
        mockServer.reset(() => {
          step += 1;
          if (step === 1) {
            return {
              toolCalls: [{
                name: 'bash',
                arguments: {
                  description: 'Start background sleeper',
                  command: `exec node -e 'require("fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},60000)' "${bgReadyFile}" "${bgMarker}"`,
                  run_in_background: true,
                },
              }],
            };
          }
          // 第 2 步挂一个前台等待，确保本轮仍在运行中供 session/cancel 打断
          return {
            toolCalls: [{
              name: 'bash',
              arguments: {
                description: 'Hold turn active after starting background job',
                command: `touch "${fgFlag}"; exec sleep 120`,
              },
            }],
          };
        });

        const client = await runner.start();
        const sid = `tablet-e5-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'spawn bg then hold', { requestId: `req-e5-${randomUUID().slice(0, 8)}` });

        await waitFor(() => fs.existsSync(bgReadyFile), { timeoutMs: 15000, label: 'E5 bg ready' });
        const bgProcs = await waitFor(() => {
          const list = findProcessesInDir(cwd, bgMarker).filter(p => !p.cmdline.startsWith('bwrap'));
          return list.length > 0 ? list : null;
        }, { timeoutMs: 5000, label: 'E5 host bg process' });
        const bgPid = bgProcs[0].pid;
        await waitFor(() => fs.existsSync(fgFlag), { timeoutMs: 15000, label: 'E5 fg2 active' });

        await client.cancel(sid);
        await waitTurnCount(client, sid, 1, 15000);
        await sleep(300);

        // 关键契约：session/cancel 之后，后台命令进程仍在跑，且 job/list 仍能列出
        assert.equal(pidAlive(bgPid), true, 'session/cancel 不应连带停掉后台 bash 命令');
        const jobsBefore = await client.readJobListOnce(sid);
        const bgJob = jobsBefore.find(j => j.kind === 'bash' && (j.status === 'running' || j.status === 'stopping'));
        assert.ok(bgJob, `job/list 应仍列出运行中的后台命令，实际：${JSON.stringify(jobsBefore)}`);

        const kill1 = await client.killJob(sid, bgJob.id);
        assert.equal(kill1.outcome, 'requested', `首次 job/kill 应回 requested，实际 ${JSON.stringify(kill1)}`);
        await waitFor(() => findProcessesInDir(cwd, bgMarker).length === 0, { timeoutMs: 5000, label: 'E5 bg pid dead after job/kill' });
        await waitFor(async () => {
          const list = await client.readJobListOnce(sid);
          const item = list.find(j => j.id === bgJob.id);
          return item && item.status !== 'running' && item.status !== 'stopping';
        }, { timeoutMs: 5000, label: 'E5 bg job settled' });

        const kill2 = await client.killJob(sid, bgJob.id);
        assert.equal(kill2.outcome, 'already-finished', `重复 job/kill 应回 already-finished，实际 ${JSON.stringify(kill2)}`);

        return `session/cancel 后后台宿主 PID ${bgPid} 仍存活，job/kill(${bgJob.id}) 停掉并退出，复停回 already-finished`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E6',
    name: '强杀云端 Harness：孤儿进程存活、重启后无 turn/end、job/list 清空、原 requestId 仍幂等',
    targets: ['rc3'],
    async run({ dshBin, mockServer }) {
      // 注：在装有 bwrap 的宿主机上 workspace-write 会用 bwrap --die-with-parent 自动收割子进程，
      // 但云端 li/li2 无 bwrap（走 Landlock）或 danger-full-access 时不会自动收割；这里用 danger-full-access 复现真实孤儿场景。
      const runner = new DshHarnessRunner({
        dshBin,
        mockV1Url: mockServer.v1Url,
        label: 'e6',
        extraEnv: { DSH_PERMISSION_MODE: 'danger-full-access' },
      });
      const cwd = path.join(runner.workspace, 'proj-e6');
      fs.mkdirSync(cwd, { recursive: true });
      const fgReadyFile = path.join(cwd, 'orphan-fg.ready');
      const bgReadyFile = path.join(cwd, 'orphan-bg.ready');
      const fgMarker = `E6_FG_${randomUUID().slice(0, 8)}`;
      const bgMarker = `E6_BG_${randomUUID().slice(0, 8)}`;
      try {
        let step = 0;
        mockServer.reset(() => {
          step += 1;
          if (step === 1) {
            return {
              toolCalls: [{
                name: 'bash',
                arguments: {
                  description: 'Start bg process before SIGKILL',
                  command: `exec node -e 'require("fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},60000)' "${bgReadyFile}" "${bgMarker}"`,
                  run_in_background: true,
                },
              }],
            };
          }
          return {
            toolCalls: [{
              name: 'bash',
              arguments: {
                description: 'Start fg process before SIGKILL',
                command: `exec node -e 'require("fs").writeFileSync(process.argv[1],"ready");setInterval(()=>{},60000)' "${fgReadyFile}" "${fgMarker}"`,
              },
            }],
          };
        });

        let client = await runner.start();
        const sid = `tablet-e6-${randomUUID().slice(0, 8)}`;
        const reqId = `req-e6-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'run bg and fg then kill host', { requestId: reqId });

        await waitFor(() => fs.existsSync(bgReadyFile), { timeoutMs: 15000, label: 'E6 bg ready' });
        await waitFor(() => fs.existsSync(fgReadyFile), { timeoutMs: 15000, label: 'E6 fg ready' });
        const bgPid = findProcessesInDir(cwd, bgMarker)[0]?.pid;
        const fgPid = findProcessesInDir(cwd, fgMarker)[0]?.pid;
        assert.ok(bgPid && fgPid, `应找到前台与后台宿主进程（fg=${fgPid}, bg=${bgPid}）`);

        // 强杀云端 Harness 进程
        await runner.killHard();
        await sleep(300);

        // 前台与后台命令均成为孤儿存活，且可按工作目录定位
        assert.equal(pidAlive(fgPid), true, 'SIGKILL 后前台命令应成孤儿继续跑');
        assert.equal(pidAlive(bgPid), true, 'SIGKILL 后后台命令应成孤儿继续跑');
        const orphans = findProcessesInDir(cwd);
        assert.ok(orphans.some(p => p.pid === fgPid), `按项目目录扫描应找到孤儿前台进程 ${fgPid}`);
        assert.ok(orphans.some(p => p.pid === bgPid), `按项目目录扫描应找到孤儿后台进程 ${bgPid}`);

        // 重启云端 Harness 检查冷态对账信号
        client = await runner.start();
        const list = await client.listSessions();
        const row = (list.items || []).find(i => i.sessionId === sid);
        assert.ok(row, '重启后 session/list 仍能查到该对话');
        assert.equal(row.running, false, '重启后对话 running 应为 false');

        const events = await client.readAllEvents(sid);
        assert.equal(turnStartsOf(events).length, 1, '日志应有 turn/start');
        const ends = turnEndsOf(events);
        const interruptedByApi = ends.length === 0 || (ends.length === 1 && ends[0].data?.reason?.kind === 'interrupted');
        assert.equal(
          interruptedByApi,
          true,
          `强杀崩溃后 session/page 应无 turn/end 或由 session-query 合成 reason.kind="interrupted"，实际 ${JSON.stringify(ends)}`,
        );

        // 核对磁盘原始会话日志（未走冷读修补前）确实没有写入 turn/end（支持 .jsonl 与 .jsonl.zstd）
        let rawHasTurnEnd = null;
        const walkFiles = (dir) => {
          if (!fs.existsSync(dir)) return [];
          const out = [];
          for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) out.push(...walkFiles(full));
            else out.push(full);
          }
          return out;
        };
        const rawFile = walkFiles(runner.dshHome).find(
          f => f.includes(sid) && (f.endsWith('.jsonl') || f.endsWith('.jsonl.zstd')),
        );
        assert.ok(rawFile, `应在 ${runner.dshHome} 下找到会话 ${sid} 的磁盘原始日志文件`);
        const rawText = rawFile.endsWith('.zstd')
          ? zlib.zstdDecompressSync(fs.readFileSync(rawFile)).toString('utf8')
          : fs.readFileSync(rawFile, 'utf8');
        const rawLines = rawText.split('\n').filter(Boolean);
        rawHasTurnEnd = rawLines.some(l => l.includes('"turn/end"'));
        assert.equal(rawHasTurnEnd, false, `磁盘原始日志 ${rawFile} 不应包含 turn/end`);

        // 后台命令表只在内存里，重启后清空
        const jobsAfterRestart = await client.readJobListOnce(sid);
        assert.equal(jobsAfterRestart.length, 0, `重启后 job/list 应为空，实际 ${JSON.stringify(jobsAfterRestart)}`);

        // 重发原 requestId 仍幂等，不再调用模型也不开第 2 轮
        const reqsBeforeResend = mockServer.requests.length;
        const resend = await client.prompt(sid, 'run bg and fg then kill host', { requestId: reqId });
        assert.equal(resend.accepted, true);
        await sleep(400);
        assert.equal(mockServer.requests.length, reqsBeforeResend, '崩溃重启后重发原 requestId 不应再次调用模型');

        // 按设计 5.6 第 3 步按项目目录清理残留进程并复核
        const killed = await killProcessesInDir(cwd);
        assert.ok(killed.some(p => p.pid === fgPid));
        assert.ok(killed.some(p => p.pid === bgPid));
        assert.equal(pidAlive(fgPid), false, '按项目目录清理后孤儿前台进程应已退出');
        assert.equal(pidAlive(bgPid), false, '按项目目录清理后孤儿后台进程应已退出');

        const apiEndSummary = ends.length === 0 ? '无 turn/end' : `冷读合成 turn/end(${ends[0].data?.reason?.kind})`;
        return `孤儿宿主 PID fg=${fgPid}/bg=${bgPid} 存活并可按 cwd 清理；重启后 running=false、${apiEndSummary}（磁盘原始日志无 turn/end）、job/list=0、原 requestId 幂等`;
      } finally {
        await killProcessesInDir(cwd).catch(() => {});
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E7a',
    name: '后台任务空闲完成：仅唤醒 1 次、通知含 jobId、无多余唤醒 + agent/status 切换',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'e7a' });
      try {
        mockServer.reset((req) => ({ text: `ack-${req.seq}` }));
        const client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-e7a');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-e7a-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });

        // 先跑完一轮让代理处于空闲
        await client.prompt(sid, 'init turn', { requestId: `req-e7a-init-${randomUUID().slice(0, 8)}` });
        await waitTurnCount(client, sid, 1);
        assert.equal(mockServer.requests.length, 1);

        // 探针登记后台任务并在空闲时结算
        const taskId = `task-e7a-${randomUUID().slice(0, 6)}`;
        const { jobId } = await runner.probePost('/start-job', { sessionId: sid, taskId, label: 'cloud research' });
        await runner.probePost('/finish-job', { taskId, result: 'SUMMARY_E7A_OK' });

        const events = await waitTurnCount(client, sid, 2, 15000);
        await sleep(600);
        assert.equal(mockServer.requests.length, 2, `完成通知应只唤醒 1 次（总计 2 次模型请求），实际 ${mockServer.requests.length}`);

        const wakeupReq = mockServer.requests[1];
        const sawJobIdInPrompt = wakeupReq.userTexts.some(t => t.includes(jobId));
        assert.equal(sawJobIdInPrompt, true, `唤醒模型时的通知原文应包含 ${jobId}`);

        const notices = userMessagesOf(events).filter(e => e.data?.source?.kind === 'tool-jobs' && e.data?.source?.form === 'notice');
        assert.equal(notices.length, 1, `日志里应有 1 条 tool-jobs notice，实际 ${notices.length}`);
        assert.ok(textOfUserEvent(notices[0]).includes(jobId), '日志通知正文应包含 jobId');

        const statusEvents = runner.readProbeEvents().filter(e => e.type === 'agent/status' && e.sessionId === sid).map(e => e.status);
        assert.ok(statusEvents.includes('running') && statusEvents.includes('idle'), `agent/status 应记录 running/idle 切换，实际 ${JSON.stringify(statusEvents)}`);

        return `空闲完成唤醒次数=1，通知含 ${jobId}，agent/status 序列=${statusEvents.join('→')}`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E7b',
    name: '取消原因实测：模型调 job_kill 透传自定义原因原文',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'e7b' });
      try {
        const customReason = 'user changed mind for E7b';
        const taskId = `task-e7b-${randomUUID().slice(0, 6)}`;
        let step = 0;
        mockServer.reset((req) => {
          step += 1;
          if (step === 1) {
            return {
              toolCalls: [{ name: 'probe_start_job', arguments: { task_id: taskId, label: 'e7b job' } }],
            };
          }
          if (step === 2) {
            const out = req.toolOutputs.at(-1)?.output || '';
            const m = out.match(/cloud-[a-z0-9]+/i);
            if (!m) throw new Error(`could not parse jobId from probe_start_job output: ${out}`);
            return {
              toolCalls: [{ name: 'job_kill', arguments: { job_id: m[0], reason: customReason } }],
            };
          }
          return { text: 'killed by model' };
        });

        const client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-e7b');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-e7b-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'start and kill job', { requestId: `req-e7b-${randomUUID().slice(0, 8)}` });
        await waitTurnCount(client, sid, 1, 15000);

        const cancelEv = await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'job/cancel' && e.taskId === taskId),
          { timeoutMs: 5000, label: 'E7b job/cancel event' },
        );
        assert.equal(cancelEv.reason, customReason, `取消原因应原样透传 "${customReason}"，实际 "${cancelEv.reason}"`);

        return `模型 job_kill 取消原因原样透传：${JSON.stringify(cancelEv.reason)}`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E7c',
    name: '取消原因实测：POST /api/job/kill 接口传入 "cancelled by the user"',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'e7c' });
      try {
        mockServer.reset(() => ({ text: 'ok' }));
        const client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-e7c');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-e7c-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });

        const taskId = `task-e7c-${randomUUID().slice(0, 6)}`;
        const { jobId } = await runner.probePost('/start-job', { sessionId: sid, taskId, label: 'e7c job' });
        const res = await client.killJob(sid, jobId);
        assert.equal(res.outcome, 'requested');

        const cancelEv = await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'job/cancel' && e.taskId === taskId),
          { timeoutMs: 5000, label: 'E7c job/cancel event' },
        );
        assert.equal(cancelEv.reason, 'cancelled by the user');
        return `POST /api/job/kill 取消原因=${JSON.stringify(cancelEv.reason)}`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E7d',
    name: '取消原因实测：归档平板对话传入 "session archived"',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'e7d' });
      try {
        mockServer.reset(() => ({ text: 'ok' }));
        const client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-e7d');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-e7d-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });

        const taskId = `task-e7d-${randomUUID().slice(0, 6)}`;
        await runner.probePost('/start-job', { sessionId: sid, taskId, label: 'e7d job' });
        await client.archiveSession(sid, { stopActivity: true });

        const cancelEv = await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'job/cancel' && e.taskId === taskId),
          { timeoutMs: 5000, label: 'E7d job/cancel event' },
        );
        assert.equal(cancelEv.reason, 'session archived');
        return `workspace/archiveSession 取消原因=${JSON.stringify(cancelEv.reason)}`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E7e',
    name: '取消原因实测：引擎正常退出传入 "owner disposed" + 源码释放原因清单核对',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'e7e' });
      try {
        mockServer.reset(() => ({ text: 'ok' }));
        const client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-e7e');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-e7e-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });

        const taskId = `task-e7e-${randomUUID().slice(0, 6)}`;
        await runner.probePost('/start-job', { sessionId: sid, taskId, label: 'e7e job' });

        await runner.stopGraceful();
        const cancelEv = runner.readProbeEvents().find(e => e.type === 'job/cancel' && e.taskId === taskId);
        assert.ok(cancelEv, '引擎正常退出时探针必须收到 cancel 回调');
        assert.equal(cancelEv.reason, 'owner disposed', `预期 "owner disposed"，实际 ${JSON.stringify(cancelEv.reason)}`);

        const scan = scanTeardownCancelReasons(dshBin);
        assert.equal(scan.checked, true, '应能扫描到已安装 dsh-jobs-local 的释放原因源码');
        assert.deepEqual(scan.unknown, [], `发现未收录的释放类取消原因：${JSON.stringify(scan.unknown)}`);

        return `SIGTERM 取消原因=${JSON.stringify(cancelEv.reason)}；源码释放原因清单=${JSON.stringify(scan.reasons)}`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'E7f',
    name: '通知写进日志后重启：日志保留 tool-jobs/notice 且含 jobId，重启不重复补投',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'e7f' });
      try {
        mockServer.reset((req) => ({ text: `e7f-reply-${req.seq}` }));
        let client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-e7f');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-e7f-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'seed turn', { requestId: `req-e7f-1-${randomUUID().slice(0, 8)}` });
        await waitTurnCount(client, sid, 1);

        const taskId = `task-e7f-${randomUUID().slice(0, 6)}`;
        const { jobId } = await runner.probePost('/start-job', { sessionId: sid, taskId, label: 'e7f job' });
        await runner.probePost('/finish-job', { taskId, result: 'E7F_RESULT' });
        await waitTurnCount(client, sid, 2);

        // 模拟台账在写入 confirmed 前意外丢失（退回 pending），重启后应凭日志去重而不重发
        const ledgerPath = path.join(runner.probeDir, 'ledger.json');
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        ledger.tasks[taskId].noticeState = 'pending';
        fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));

        client = await runner.restart();
        const events = await client.readAllEvents(sid);
        const notices = userMessagesOf(events).filter(e => e.data?.source?.kind === 'tool-jobs' && e.data?.source?.form === 'notice');
        assert.equal(notices.length, 1, '重启后日志仍应保留 1 条 tool-jobs notice');
        assert.ok(textOfUserEvent(notices[0]).includes(jobId), '重启后日志通知正文仍应含 jobId');

        // 激活对话加载代理，验证按日志去重不补发
        const reqsBeforeActivate = mockServer.requests.length;
        await client.activateSession(sid);
        const dedupEv = await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'notice/deduped' && e.taskId === taskId),
          { timeoutMs: 8000, label: 'E7f notice/deduped event' },
        );
        await sleep(400);
        assert.equal(mockServer.requests.length, reqsBeforeActivate, '去重后不应再次唤醒模型');
        const finalLedger = await runner.probeLedger();
        assert.equal(finalLedger.tasks[taskId].noticeState, 'confirmed');

        return `重启后日志留存 tool-jobs/notice（seq=${dedupEv.seq}），代理加载时按日志去重不补发`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'C1',
    name: '设计 §7 补验 1：插件进程内确认通知写进日志（session/event）后才记「已告诉」',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'c1' });
      try {
        mockServer.reset((req) => ({ text: `c1-reply-${req.seq}` }));
        const client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-c1');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-c1-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'c1 init', { requestId: `req-c1-${randomUUID().slice(0, 8)}` });
        await waitTurnCount(client, sid, 1);

        const taskId = `task-c1-${randomUUID().slice(0, 6)}`;
        await runner.probePost('/start-job', { sessionId: sid, taskId, label: 'c1 job' });
        const finishResp = await runner.probePost('/finish-job', { taskId, result: 'C1_RESULT' });
        assert.equal(finishResp.beforeSettle.noticeState, 'pending', '结算后台任务前必须先写台账为 pending');

        const confirmedEv = await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'notice/confirmed' && e.taskId === taskId),
          { timeoutMs: 15000, label: 'C1 notice/confirmed via session/event' },
        );
        await waitTurnCount(client, sid, 2);

        const allProbeEvents = runner.readProbeEvents();
        const pendingIdx = allProbeEvents.findIndex(e => e.type === 'task/marked-pending' && e.taskId === taskId);
        const confirmedIdx = allProbeEvents.findIndex(e => e.type === 'notice/confirmed' && e.taskId === taskId);
        assert.ok(pendingIdx >= 0 && confirmedIdx > pendingIdx, '顺序必须为先记 pending，再由 session/event 确认为 confirmed');

        const ledger = await runner.probeLedger();
        assert.equal(ledger.tasks[taskId].noticeState, 'confirmed');
        assert.equal(ledger.tasks[taskId].confirmedSeq, confirmedEv.seq);

        const logEvents = await client.readAllEvents(sid);
        const matchingEvent = logEvents.find(e => e.seq === confirmedEv.seq);
        assert.equal(matchingEvent?.type, 'user/message');
        assert.equal(matchingEvent?.data?.source?.kind, 'tool-jobs');

        return `先写 pending，经进程内 session/event（seq=${confirmedEv.seq}）确认写进日志后才改为 confirmed`;
      } finally {
        await runner.cleanup();
      }
    },
  },

  {
    id: 'C2',
    name: '设计 §7 补验 2：引擎重启后代理出现（agent/created）时补投通知且日志里只有一条',
    targets: ['rc3', 'rc1'],
    async run({ dshBin, mockServer }) {
      const runner = new DshHarnessRunner({ dshBin, mockV1Url: mockServer.v1Url, withProbe: true, label: 'c2' });
      try {
        mockServer.reset((req) => ({ text: `c2-reply-${req.seq}` }));
        let client = await runner.start();
        const cwd = path.join(runner.workspace, 'proj-c2');
        fs.mkdirSync(cwd, { recursive: true });
        const sid = `tablet-c2-${randomUUID().slice(0, 8)}`;
        await client.createSession({ sessionId: sid, cwd });
        await client.prompt(sid, 'c2 initial turn', { requestId: `req-c2-${randomUUID().slice(0, 8)}` });
        await waitTurnCount(client, sid, 1);

        // 模拟引擎在第 1、2 步之间被杀：台账已是 completed + pending，但对话日志里没有任何通知
        const taskId = `task-c2-${randomUUID().slice(0, 6)}`;
        await runner.probePost('/seed-pending-notice', {
          taskId,
          sessionId: sid,
          summary: 'C2_CATCHUP_RESULT',
        });

        // 强杀重启（此时对话尚未打开，代理尚未加载，不应误标 confirmed）
        await runner.killHard();
        client = await runner.start();
        await sleep(400);
        const ledgerBeforeLoad = await runner.probeLedger();
        assert.equal(ledgerBeforeLoad.tasks[taskId].noticeState, 'pending', '代理未加载前应保持 pending（完成未读）');
        assert.equal(mockServer.requests.length, 1, '代理未加载前不应有额外模型请求');

        // 站长回到这段对话（activate: true 加载代理）→ 触发 agent/created → 补投通知
        await client.activateSession(sid);
        const catchupSent = await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'notice/catchup-sent' && e.taskId === taskId),
          { timeoutMs: 10000, label: 'C2 notice/catchup-sent' },
        );
        assert.equal(catchupSent.method, 'followup', '空闲代理恢复时应走 followup 唤醒');

        const confirmed = await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'notice/confirmed' && e.taskId === taskId),
          { timeoutMs: 15000, label: 'C2 notice/confirmed' },
        );
        assert.equal(confirmed.via, 'liming-cloud');
        await waitTurnCount(client, sid, 2);

        const ledgerAfterConfirm = await runner.probeLedger();
        assert.equal(ledgerAfterConfirm.tasks[taskId].noticeState, 'confirmed');

        // 再次退回 pending 并二次重启激活，验证按日志去重后整段日志里严格只有 1 条通知
        const ledgerPath = path.join(runner.probeDir, 'ledger.json');
        const tampered = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        tampered.tasks[taskId].noticeState = 'pending';
        fs.writeFileSync(ledgerPath, JSON.stringify(tampered, null, 2));

        client = await runner.restart();
        const reqsBeforeSecondActivate = mockServer.requests.length;
        await client.activateSession(sid);
        await waitFor(
          () => runner.readProbeEvents().find(e => e.type === 'notice/deduped' && e.taskId === taskId),
          { timeoutMs: 8000, label: 'C2 second restart dedup' },
        );
        await sleep(400);
        assert.equal(mockServer.requests.length, reqsBeforeSecondActivate, '二次重启加载不应再补发');

        const logEvents = await client.readAllEvents(sid);
        const cloudNotices = userMessagesOf(logEvents).filter(
          e => e.data?.source?.kind === 'liming-cloud' && e.data?.source?.form === 'notice' && e.data?.source?.taskId === taskId,
        );
        assert.equal(cloudNotices.length, 1, `日志里应严格只有 1 条补投通知，实际 ${cloudNotices.length}`);

        return `重启未加载前保持 pending；agent/created 时补投（${catchupSent.method}，seq=${confirmed.seq}）并确认；二次重启按日志去重，日志共 1 条`;
      } finally {
        await runner.cleanup();
      }
    },
  },
];
