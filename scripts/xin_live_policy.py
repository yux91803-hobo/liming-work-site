"""Production smoke policy for the owner's configured foreground model."""
# 站长 2026-11-13：前台用 Antigravity 的 Gemini 4 Hydrogen（思考强度中），Gemini 额度用完再切 DeepSeek；Claude 不再用。
HYDROGEN = 'gemini-4-hydrogen'
DEEPSEEK = 'deepseek-v4.1-flash'
# The foreground allows 65 s for Hydrogen and 25 s for DeepSeek inference. Allow
# bounded provider setup and transport as well; creating background work still ends the turn.
REPLY_LIMIT = {HYDROGEN: 75, DEEPSEEK: 30}


def validate_front_model(done, quota=None, now_ms=0):
    if done.get('ok') is not True:
        raise RuntimeError('Foreground did not complete successfully')
    model = done.get('model')
    if model == HYDROGEN:
        return model
    if model != DEEPSEEK:
        raise RuntimeError('Foreground used an unexpected model')
    quota = quota or {}
    if (quota.get('model') != HYDROGEN or quota.get('blocked') is not True
            or not isinstance(quota.get('retryAt'), (int, float)) or quota['retryAt'] <= now_ms):
        raise RuntimeError('Foreground skipped Hydrogen without real exhausted Gemini quota')
    return model


def front_reply_limit(model):
    if model not in REPLY_LIMIT:
        raise RuntimeError('No reply deadline for this foreground model')
    return REPLY_LIMIT[model]


# Opening lines of the conversations this smoke test creates (a conversation's title is its first line, cut to 40 chars).
# An earlier run whose cleanup failed leaves them behind; cross-conversation recall then quotes their old instructions
# into this run's turns, and the foreground may follow those instead of the current line (seen 2026-11-11 with DeepSeek).
SMOKE_TITLES = ('这是发布后的真实联调，使用默认后台安排，', '只读取这张图片中唯一一行字符并照写出来。', '只回复 generation-original-', '只回复 generation-current-')


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
THIRD_PERSON = ('小芯', '分身', '后台', '同事', '助手', '交给')


def first_person_receipt(reply):
    reply = str(reply or '').strip()
    return bool(reply) and not any(x in reply for x in THIRD_PERSON)


GEMINI_SKIP_MS = 15 * 60 * 1000  # vm-agent AGY_STALL_MS: new tasks skip Gemini this long after an outage
CLOCK_SKEW_MS = 60 * 1000  # the runner and the cloud computer keep separate clocks


def explain_background_fallback(quota, issue, dispatched_ms, now_ms):
    """Why the default background task did not finish on Gemini, from what the controller recorded.

    Accepted: a quota cooldown still in force, or a Gemini outage (no output = stall, or a non-SUCCESS
    answer = status) recorded during this run or in the window before it in which new tasks skip Gemini.
    A local agy failure is never recorded by the controller, so it cannot explain anything here."""
    quota = quota or {}
    if quota.get('blocked') is True and isinstance(quota.get('retryAt'), (int, float)) and quota['retryAt'] > now_ms:
        return 'quota'
    issue = issue or {}
    at = issue.get('at')
    if issue.get('kind') in ('stall', 'status') and isinstance(at, (int, float)) and dispatched_ms - GEMINI_SKIP_MS <= at <= now_ms + CLOCK_SKEW_MS:
        return 'gemini ' + issue['kind'] + (' ' + str(issue['status']) if issue.get('status') else '')
    raise RuntimeError('Default Antigravity did not run and no recorded quota cooldown or Gemini outage explains the fallback')


# 第 2 批（docs/superpowers/plans/2026-11-15-xin-state-owner-switch.md）：正式站的状态由内核外壳拉起、看住的常驻进程管，
# 网页的每次操作经本机套接字交给它，外壳不再起控制器进程。usage 的 owner 是外壳的 summary 加上 spawns（外壳起过几次控制器）。
# 公开仓库的日志只打印阶段、代号和计数。
def resident_owner(usage):
    o = (usage or {}).get('owner') or {}
    if o.get('phase') != 'running' or o.get('mode') != 'kernel':
        return None
    if type(o.get('epoch')) is not int or type(o.get('spawns')) is not int:
        return None
    return {'epoch': o['epoch'], 'spawns': o['spawns']}


def owner_brief(usage):
    o = (usage or {}).get('owner') or {}
    return 'phase=' + str(o.get('phase')) + ' mode=' + str(o.get('mode')) + ' lastError=' + str(o.get('lastError'))


def same_resident_owner(first, usage):
    now = resident_owner(usage)
    if now is None:
        raise RuntimeError('State owner is no longer the resident process: ' + owner_brief(usage))
    if now['epoch'] != first['epoch']:
        raise RuntimeError('State owner restarted during the run: epoch ' + str(first['epoch']) + ' -> ' + str(now['epoch']))
    if now['spawns'] != first['spawns']:
        raise RuntimeError('The kernel started controller processes in kernel mode: ' + str(now['spawns'] - first['spawns']))
