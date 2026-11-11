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
