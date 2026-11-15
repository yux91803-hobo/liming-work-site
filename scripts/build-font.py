"""把工具箱首页用到的字从 Unifont（16px 点阵字体，GPL-2+ 带字体嵌入例外 / OFL 双许可）裁成一个小 woff。
用法：python3 scripts/build-font.py  （需要 fonttools；新增了文字后重跑一次）"""
import os, sys
from fontTools import subset
from fontTools.ttLib import TTFont

SRC = os.environ.get('UNIFONT', '/usr/share/fonts/opentype/unifont/unifont.otf')
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'site')
chars = set(chr(c) for c in range(0x20, 0x7f))
# 只有工具箱首页用点阵字体：扫首页自己的文件（工具名、分类、「继续上次」里的外设和章节名都在 shell.js / tools.js 里）
for f in ('index.html', 'shell.js', 'shell.css', 'pixel.css', 'tools.js', 'mascot.js', 'tools/stm32/study-core.js'):
    try: chars |= set(open(os.path.join(ROOT, f), encoding='utf8').read())
    except Exception: pass
# 首页以外只有一处用点阵字：小芯聊天的欢迎页那句（site/xin/chat.js 的 welcome）
chars |= set('嗨，我是小芯')
chars = {c for c in chars if ord(c) >= 0x20}
opts = subset.Options()
opts.flavor = 'woff'; opts.layout_features = []; opts.name_IDs = [1, 2, 3, 4, 6]
opts.notdef_outline = True; opts.hinting = False; opts.desubroutinize = True
font = TTFont(SRC)
sub = subset.Subsetter(opts); sub.populate(text=''.join(sorted(chars))); sub.subset(font)
out = os.path.join(ROOT, 'fonts', 'pixel.woff')
os.makedirs(os.path.dirname(out), exist_ok=True)
font.flavor = 'woff'; font.save(out)
print('%d 个字符 → %s (%d KB)' % (len(chars), out, os.path.getsize(out) // 1024))
