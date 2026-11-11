"""Production smoke policy for the owner's configured foreground model."""
OPUS = 'claude-opus-4.6'
DEEPSEEK = 'deepseek-v4.1-flash'
# The foreground allows 65 s for Opus and 25 s for DeepSeek inference. Allow
# bounded provider setup and transport as well; creating background work still ends the turn.
REPLY_LIMIT = {OPUS: 75, DEEPSEEK: 30}


def validate_front_model(done, quota=None, now_ms=0):
    if done.get('ok') is not True:
        raise RuntimeError('Foreground did not complete successfully')
    model = done.get('model')
    if model == OPUS:
        return model
    if model != DEEPSEEK:
        raise RuntimeError('Foreground used an unexpected model')
    quota = quota or {}
    if (quota.get('model') != OPUS or quota.get('blocked') is not True
            or not isinstance(quota.get('retryAt'), (int, float)) or quota['retryAt'] <= now_ms):
        raise RuntimeError('Foreground skipped Opus without real exhausted Claude quota')
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
