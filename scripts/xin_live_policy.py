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
