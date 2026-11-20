"""Production smoke policy for the owner's configured foreground model."""
# 前台优先 Gemini 4 Hydrogen，使用备用模型时核对本轮的切换原因。
import re
HYDROGEN = 'gemini-4-hydrogen'
DEEPSEEK = 'deepseek-v4.1-flash'
# The foreground allows 65 s for Hydrogen and 25 s for DeepSeek inference. Allow
# bounded provider setup and transport as well; creating background work still ends the turn.
REPLY_LIMIT = {HYDROGEN: 75, DEEPSEEK: 30}
RECOVERED_REPLY_LIMIT = REPLY_LIMIT[HYDROGEN] + 45  # One bounded DeepSeek attempt after Gemini's deadline.
FRONT_WEB_UNAVAILABLE = '现在暂时查不了网页'


def recovered_front_timeout(done):
    return (done.get('model') == DEEPSEEK and done.get('from') == HYDROGEN and
            done.get('why') in ('front_timeout_fallback', 'front_capacity_fallback'))


def validate_front_model(done, quota=None, now_ms=0):
    if done.get('ok') is not True:
        raise RuntimeError('Foreground did not complete successfully')
    model = done.get('model')
    if model == HYDROGEN:
        return model
    if model != DEEPSEEK:
        raise RuntimeError('Foreground used an unexpected model')
    if recovered_front_timeout(done):
        return model
    quota = quota or {}
    if (quota.get('model') != HYDROGEN or quota.get('blocked') is not True
            or not isinstance(quota.get('retryAt'), (int, float)) or quota['retryAt'] <= now_ms):
        raise RuntimeError('Foreground skipped Hydrogen without real exhausted Gemini quota')
    return model


def front_reply_limit(model, done=None):
    if model not in REPLY_LIMIT:
        raise RuntimeError('No reply deadline for this foreground model')
    if model == DEEPSEEK and recovered_front_timeout(done or {}):
        return RECOVERED_REPLY_LIMIT
    return REPLY_LIMIT[model]


# Opening lines of the conversations this smoke test creates (a conversation's title is its first line, cut to 40 chars).
# An earlier run whose cleanup failed leaves them behind; cross-conversation recall then quotes their old instructions
# into this run's turns, and the foreground may follow those instead of the current line (seen 2026-11-11 with DeepSeek).
SMOKE_TITLES = ('这是发布后的真实联调，使用默认后台安排，', '这是发布后的真实联调（插话），', '只读取这张图片中唯一一行字符并照写出来。', '只回复 generation-original-', '只回复 generation-current-')


def is_leftover_smoke(session):
    """Only the owner's non-main conversations whose title is one of this script's own opening lines."""
    return isinstance(session, dict) and not session.get('main') and str(session.get('title') or '').startswith(SMOKE_TITLES)


# 「只回复 X」用的标记：几个随机的普通词，不用十六进制。DeepSeek 当前台时会把十六进制当成内部编号，
# 按人设「不主动讲任务编号」删掉后半段（2026-11-11 联调里见过回复正好是 generation-current 这 18 个字符）。
SPOKEN = ('青柠', '风筝', '海盐', '灯塔', '松果', '白鹭', '琥珀', '银杏', '竹笛', '云杉', '橘猫', '雪梨', '麦穗', '珊瑚', '砚台', '纸鸢',
          '薄荷', '石榴', '萤火', '杏仁', '柚子', '鲸鱼', '雨伞', '火车', '邮票', '陀螺', '积木', '书签', '茶壶', '蜻蜓', '葡萄', '贝壳',
          '铃铛', '枫叶', '海豚', '钢琴', '风车', '橄榄', '冰川', '南瓜')


def spoken_marker(avoid='', rng=None):
    """Three distinct random words, none shared with `avoid`."""
    import random
    taken = set(str(avoid or '').split())
    return ' '.join((rng or random.SystemRandom()).sample([w for w in SPOKEN if w not in taken], 3))


def says(text, marker):
    """The reply contains every word of the marker (punctuation between them is fine)."""
    text = str(text or '')
    return bool(marker) and all(w in text for w in str(marker).split())


def reply_shape(texts, marker, other=None):
    """Shape of the visible replies when the expected marker is missing, without printing any reply or marker."""
    texts = [str(t or '') for t in (texts or [])]
    last = texts[-1] if texts else ''
    words = str(marker).split()
    dashes = '\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uff0d'
    return {'replies': len(texts), 'chars': len(last), 'lines': len(last.splitlines()) if last else 0, 'ascii': last.isascii(),
            'words': sum(w in last for w in words), 'of': len(words), 'otherWords': sum(w in last for w in str(other or '').split()),
            'oddDash': any(d in last for d in dashes), 'anyReplySays': any(says(t, marker) for t in texts)}


# 回执要用第一人称（站长的规矩：进度和完成用「我」说，不讲分身、后台、模型）。中文常省略主语：
# 「好嘞，这就去画这只小奶龙」就是第一人称（2026-11-12 #125 联调里 DeepSeek 这样回，被只查「我」字的检查判失败）。
# 真正要拦的是把自己说成第三人称、或者说交给了别人去做。
# 站长 2026-11-18：派活要照实说派后台（「我派后台去……」「交给后台」），这两个词不再算第三人称；
# 自称「小芯」、说分身、同事、助手的仍然不是第一人称（#176 正式联调因为旧名单判失败、自动回滚）
THIRD_PERSON = ('小芯', '分身', '同事', '助手')


def front_lookup_verdict(events):
    """站长 2026-11-18：几下就能查到的，前台自己用 search_web / read_url_content 查，不派后台。返回失败原因，空字符串表示通过。"""
    events = events or []
    if any(e.get('t') == 'task' for e in events):
        return 'dispatched a background task'
    steps = [e for e in events if e.get('t') == 'tool' and e.get('name') in ('WebSearch', 'WebFetch')]
    if not steps:
        return 'no web step recorded'
    if not '\n'.join(e.get('text', '') for e in events if e.get('t') == 'text').strip():
        return 'empty reply'
    if not next((e for e in events if e.get('t') == 'done'), {}).get('ok'):
        return 'turn did not finish ok'
    return ''


def front_lookup_during_outage(events, plain_done=None):
    """Check the degraded reply after a provider 503 or corroborated timeouts."""
    done = next((e for e in events if e.get('t') == 'done'), {})
    plain_done = plain_done or {}
    repeated_timeout = (done.get('why') == 'front_timeout_fallback' and
                        plain_done.get('ok') is True and recovered_front_timeout(plain_done))
    if done.get('why') != 'front_capacity_fallback' and not repeated_timeout:
        return None  # The usual native-web check still applies.
    if done.get('ok') is not True or not recovered_front_timeout(done):
        return 'outage fallback did not finish on the backup model'
    if any(e.get('t') in ('task', 'tool', 'tool_end') for e in events):
        return 'outage fallback reported an unexpected operation'
    text = '\n'.join(e.get('text', '') for e in events if e.get('t') == 'text').strip().rstrip('。！.!')
    return '' if text == FRONT_WEB_UNAVAILABLE else 'outage fallback did not report that web lookup is unavailable'


def first_person_receipt(reply):
    reply = str(reply or '').strip()
    return bool(reply) and not any(x in reply for x in THIRD_PERSON)


GEMINI_SKIP_MS = 15 * 60 * 1000  # vm-agent AGY_STALL_MS: new tasks skip Gemini this long after an outage
CLOCK_SKEW_MS = 60 * 1000  # the runner and the cloud computer keep separate clocks


def explain_background_fallback(quota, issue, dispatched_ms, now_ms, expected_model=None):
    """Why the default background task did not finish on Gemini, from what the controller recorded.

    Accepted: a quota cooldown still in force, or a Gemini outage (no output = stall, or a non-SUCCESS
    answer = status) recorded during this run or in the window before it in which new tasks skip Gemini.
    A local agy failure is never recorded by the controller, so it cannot explain anything here."""
    quota = quota or {}
    gemini_pool = ('gemini-4-hydrogen', 'gemini-4-neon')
    model_matches = expected_model is None or quota.get('model') == expected_model or (expected_model in gemini_pool and quota.get('model') in gemini_pool)
    if model_matches and quota.get('blocked') is True and isinstance(quota.get('retryAt'), (int, float)) and quota['retryAt'] > now_ms:
        return 'quota'
    issue = issue or {}
    at = issue.get('at')
    if issue.get('kind') in ('stall', 'status') and isinstance(at, (int, float)) and dispatched_ms - GEMINI_SKIP_MS <= at <= now_ms + CLOCK_SKEW_MS:
        return 'gemini ' + issue['kind'] + (' ' + str(issue['status']) if issue.get('status') else '')
    raise RuntimeError('Default Antigravity did not run and no recorded quota cooldown or Gemini outage explains the fallback')


# 第 2 批（docs/superpowers/plans/2026-11-15-xin-state-owner-switch.md）：正式站的状态由内核外壳拉起、看住的常驻进程管，
# 网页的每次操作经本机套接字交给它，外壳不再起控制器进程。用状态进程的 PID 和接管次数核对它是否持续服务。
# kernelCurrent（Worker 加的）：电脑上的外壳是不是这次部署的版本。改了外壳的部署，Worker 在后台换外壳；换好之前不记，
# 不然外壳中途换掉会把切换次数加一，被判成「状态进程中途重启」而回滚（删旧模式第 2 步上线前自查发现，
# 参考 Kubernetes 滚动发布：新版本就绪了才开始检查）。
# 公开仓库的日志只打印阶段、代号和计数。
def resident_owner(usage):
    o = (usage or {}).get('owner') or {}
    if o.get('phase') != 'running' or o.get('mode') != 'kernel' or o.get('kernelCurrent') is not True:
        return None
    if any(type(o.get(field)) is not int or o[field] < 1 for field in ('epoch', 'pid')):
        return None
    return {'epoch': o['epoch'], 'pid': o['pid']}


def owner_brief(usage):
    o = (usage or {}).get('owner') or {}
    return 'phase=' + str(o.get('phase')) + ' mode=' + str(o.get('mode')) + ' kernelCurrent=' + str(o.get('kernelCurrent')) + ' lastError=' + str(o.get('lastError'))


def same_resident_owner(first, usage):
    now = resident_owner(usage)
    if now is None:
        raise RuntimeError('State owner is no longer the resident process: ' + owner_brief(usage))
    if now['epoch'] != first['epoch']:
        raise RuntimeError('State owner restarted during the run: epoch ' + str(first['epoch']) + ' -> ' + str(now['epoch']))
    if now['pid'] != first['pid']:
        raise RuntimeError('State owner PID changed during the run: ' + str(first['pid']) + ' -> ' + str(now['pid']))


# ---------- 后台干活时插话（docs/superpowers/specs/2026-11-17-xin-steer-design.md，scripts/xin_live_steer.py） ----------
# 夹具：按顺序核对几个模型名（启用的、备用的），每个名字单独一条 shell 命令、先 sleep，好让补充落在中途；最终只写一行名单。
# pause：每一步先睡几秒，好让聊天里那句补充赶在这件事做完之前（命令 60 秒会被控制器杀掉，要小于它）
def steer_request(title, directory, items, model='', pause=20):
    names = '、'.join(n + ('（启用）' if on else '（备用）') for n, on in items)
    return ('这是发布后的真实联调（插话），只派一个后台任务并立即回复，不要等待它完成。' + (model and '这个后台任务' + model + '。') +
            '使用 xin task new --kind research' + (' --model kimi-k3.1-pro' if 'Kimi' in model else '') + ' --title ' + title + ' --dir ' + directory +
            ' -- 后台测试：核对这份 Agent 模型清单：' + names + '。按顺序一个一个核对：每个名字单独执行一次 shell 命令 sleep ' + str(int(pause)) + '; echo 名字 >> checked.txt，'
            '一次只核对一个，不要合并成一条命令。全部核对完后，最终结果只写一行：用英文逗号连接核对过的模型名。'
            '不要访问其它项目、记事本、设备或用户服务。请只派这个任务，不要派审查。')

# 最终名单：要的都在、不要的一个都没有（只回布尔值，不回原文）
def list_verdict(text, keep, drop):
    t = str(text or '')
    return {'keeps': all(n in t for n in keep), 'drops': not any(n in t for n in drop)}

# 最终名单里出现了不要的名字：每一行分清是当一项列出来了（以 -、*、1. 这类开头），还是在说明里提了一句（不列、排除、按要求……）。
# 只给布尔值、不给原话（仓库公开），失败时打出来，下次能看出是模型没照补充筛，还是说明里多提了名字
LIST_ITEM = re.compile(r'^\s*(?:[-*•·]|\d+\s*[.)、．])\s*')
EXCLUDE_NOTE = re.compile(r'不列|没列|未列|不再|排除|去掉|筛掉|按要求|按新要求|按你的要求|备用')


def drop_mentions(text, drop):
    return [{'listed': bool(LIST_ITEM.match(line)), 'note': bool(EXCLUDE_NOTE.search(line))}
            for line in str(text or '').splitlines() if any(n in line for n in drop)]

# 核对某个名字的命令：照任务的说法是 sleep N; echo 名字 >> checked.txt（只看命令，不看输出）。
# 按新要求把之前查到的筛掉（sed -i '/名字/d'、grep -v 名字）是站长要的「重新筛一遍」，不算再核对
def checks_name(detail, names):
    return any(re.search(r"echo\s+['\"]?" + re.escape(n) + r"['\"]?\s*>>", str(detail or '')) for n in names)

# 聊天里那句补充送进了这一轮（过程里有前台转来的补充：编号 ft- 开头，vm-agent.mjs 的 frontAction），它之后还有没有再核对不要的名字；
# 网页任务详情那样直接补的（别的编号）不算聊天里那句
def after_steer(events, drop):
    i = next((k for k, e in enumerate(events) if e.get('t') == 'user' and e.get('steer') and str(e.get('clientId', '')).startswith('ft-')), None)
    steers = sum(1 for e in events if e.get('t') == 'user' and e.get('steer'))
    if i is None:
        return {'steered': False, 'laterDrop': False, 'steers': steers}
    later = [e for e in events[i + 1:] if e.get('t') in ('tool', 'tool_end') and checks_name(e.get('detail', ''), drop)]
    return {'steered': True, 'laterDrop': bool(later), 'steers': steers}

# 同一编号的补充在这一轮的过程里出现了几次（断线重送只该算一次）
def steer_count(events, client_id):
    return sum(1 for e in events if e.get('t') == 'user' and e.get('steer') and e.get('clientId') == client_id)

# 控制器兜底的固定说法（前台自己的话要不到时才用）；站长要的是顺着对话的一句
CANNED = ('好，我这就去弄。', '行，接下来就按你说的来。', '好，这一轮跑完我就按你补的再来一遍。', '好，开始的时候一起带上。', '好，我接着做。')
def canned_reply(text):
    return str(text or '').strip() in CANNED
