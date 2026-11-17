// `node --import <这个文件>`：测试起的子进程脚本在加载任何控制器模块之前先拿所有权，扮演常驻状态进程。
// 见 own-state.cjs。XIN_HOME 由起子进程的测试设好；拿不到（有真的状态进程在管）就照常报错退出。
import { ownership } from '../../site/xin/vm-base.mjs';
if (!ownership.owning) ownership.take({ waitMs: 5000 });
