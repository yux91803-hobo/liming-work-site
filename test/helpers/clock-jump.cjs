// 测试用预载（node --require）：模拟电脑暂停后恢复、墙上时钟一下跳了很久（第 2 批计划 Task 3）。
// XIN_HOME/clock-jump 里写一个毫秒数，之后这个进程里的 Date.now() 都加上它；performance.now() 不动（单调时钟本来就不跟墙上时钟）。
// 只在临时目录的测试里用，不会进正式代码。
const fs = require('node:fs'), path = require('node:path');
const file = path.join(process.env.XIN_HOME || '/nonexistent', 'clock-jump');
const realNow = Date.now.bind(Date);
let offset = 0;
const read = () => { try { offset = Number(fs.readFileSync(file, 'utf8')) || 0; } catch { /* 还没写 */ } };
read();
setInterval(read, 50).unref();
Date.now = () => realNow() + offset;
