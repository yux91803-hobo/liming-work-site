/* lab-core.js — 「编程思维」「硬件原理」两个模块共用的数据和逻辑（不碰 DOM，可在 Node 里测试）
   编程思维：一章 = 一道编程题，按「明确任务 → 查资料 → 规划 → 编写 → 验证」走完；右边一次只放一份资料。
   硬件原理：同一份代码交给模拟器跑，把每一行在芯片里引起的变化演成动画。
   · 代码：直接用「代码推导」里课件同款的文件（STM32_CODEDERIVE），保证和课件一个写法。
   · .c 那一步：把代码交给 mcusim.js 真的跑一遍，每执行一行记一次芯片状态（时钟、CRL/CRH、ODR、引脚电平），
     前后两次的差别就是这一行在硬件上造成的变化（开时钟 / 改模式 / 改输出）。界面按这些变化播动画——
     所以自己写的代码也能放进去看，图永远和代码对得上。
   · 自己写：同样跑模拟器，按结果找出缺了哪一环，分三级提示（先问一句 → 指出哪一步 → 给出写法）。 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32Lab = api;
})(typeof window === 'object' ? window : this, function (root) {
  'use strict';
  function Sim() { return root.STM32McuSim; }
  function CD() { return (root.STM32_CODEDERIVE || {}).CD || {}; }

  /* ===================== 章节 ===================== */
  var CH = {};
  CH.gpio = {
    id: 'gpio', topic: 'gpio', title: 'GPIO：点亮 LED', cd: 'gpio',
    port: 'A', clk: { reg: 'APB2ENR', bit: 2, name: 'IOPAEN' },
    pins: [
      { key: 'PA0', label: 'LED1', color: 'y' },
      { key: 'PA1', label: 'LED2', color: 'b' },
      { key: 'PA8', label: 'LED3', color: 'g' }
    ],
    board: 'leds',
    task: '让板子上的三个 LED（LED1 黄、LED2 蓝、LED3 绿）轮流亮，做一个流水灯。main.c 里只写 LED_On(LED1) 这样的话，看不到任何寄存器。',
    ask: [   // 明确任务：先把要求拆开
      { q: '最后要实现什么？', a: '三个灯轮流亮 0.5 秒。拆开看是三件小事：开机先把引脚准备好、能点亮某个灯、能把它熄灭。' },
      { q: '要查哪些资料？', a: '三样：<b>开发板原理图</b>（灯接在哪个脚、什么电平亮），<b>参考手册的框图</b>（GPIO 挂在哪条总线、引脚内部怎么输出），<b>寄存器说明</b>（具体写哪一位）。下一步一样一样查，右边一次放一份。' },
      { q: '用到的东西里，哪些是程序要管的？', a: '时钟（RCC 里开 GPIOA）、引脚模式（推挽输出）、输出的值（0 亮 1 灭）。延时不归 LED 管，交给 delay 模块。' }
    ],
    need: [
      { q: '最后要实现什么？', a: '三个灯轮流亮 0.5 秒。拆开看是三件小事：开机先把引脚准备好、能点亮某个灯、能把它熄灭。' },
      { q: '要用到哪些硬件？', a: '看原理图：灯接在 PA0、PA1、PA8，接法是 3V3 → 2kΩ → LED → 引脚，所以<b>引脚输出 0 灯亮</b>。要用 GPIOA 的这三个脚，配成推挽输出；GPIOA 挂在 APB2 上，用之前要在 RCC 里开它的时钟。' },
      { q: '要做哪几件独立的事？', a: '初始化（开时钟、配引脚）、点亮、熄灭，顺手再加一个翻转。延时不归 LED 管，交给 delay 模块——一个模块只管一件事。' },
      { q: '哪些做成函数？参数用什么？', a: '每件事一个函数：LED_Init、LED_On、LED_Off、LED_Toggle。参数用<b>灯的编号</b>（1、2、3），不用引脚号：用的人不用知道灯接在哪个脚上，换板子 main.c 一行不用改。' },
      { q: '谁先谁后？', a: 'LED_Init 必须最先调用一次（没开时钟、没配引脚，后面全白写）；然后 main 在 while (1) 里一个接一个：点亮 → 延时 → 熄灭。' }
    ],
    facts: [
      '<b>推挽输出</b>：写 1 → P-MOS 导通，引脚接到 3.3 V；写 0 → N-MOS 导通，引脚接到地。两个管子轮流干活，引脚总有确定的电平。',
      '<b>低电平点亮</b>：引脚是 0 时，电流从 3V3 经 2kΩ 电阻、LED 流进引脚，再经 N-MOS 到地，灯亮；引脚是 1 时 LED 两端都是 3.3 V，没有电流，灯灭。',
      '<b>寄存器</b>：CRL / CRH 决定引脚是输入还是输出、推挽还是开漏；ODR 是输出的值；BSRR 只改某几位（写 1 置 1 / 清 0），不用先读。',
      '<b>时钟</b>：GPIOA 挂在 APB2 上，RCC 里的 IOPAEN 不开，往 GPIOA 写什么都没反应。'
    ],
    tour: [   // 「硬件」那一步：用一小段代码把路线走一遍
      ['RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', '开时钟：Cortex-M3 → 系统总线 → 总线矩阵 → AHB → RCC。之后 GPIOA 才「通电」。'],
      ['GPIOA->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0);', '配引脚：Cortex-M3 → 总线 → 桥接1 → APB2 → GPIOA。先清掉 PA0 的 4 个配置位（模拟输入：输入、输出驱动器都断开）。'],
      ['GPIOA->CRL |= GPIO_CRL_MODE0;', 'PA0 配成推挽输出：输出驱动器接上，P-MOS、N-MOS 都能用。ODR 复位值是 0，N-MOS 导通——灯一下就亮了。'],
      ['GPIOA->BSRR = GPIO_BSRR_BS0;', '写 1：位设置/清除寄存器 → 输出数据寄存器第 0 位 = 1 → P-MOS 导通，PA0 = 3.3 V，LED 两端一样高，灭。'],
      ['GPIOA->BSRR = GPIO_BSRR_BR0;', '写 0：第 0 位 = 0 → N-MOS 导通，电流从 3V3 经 2kΩ、LED 流进 PA0，再经 N-MOS 到地——亮。']
    ],
    fns: [
      { name: 'LED_Init', sig: 'void LED_Init(void)', job: '开 GPIOA 的时钟，把 PA0、PA1、PA8 配成推挽输出，先让灯都灭着', args: '无', ret: '无', where: 'h' },
      { name: 'LED_On', sig: 'void LED_On(uint8_t n)', job: '点亮第 n 个灯', args: 'n：灯的编号 1~3', ret: '无', where: 'h' },
      { name: 'LED_Off', sig: 'void LED_Off(uint8_t n)', job: '熄灭第 n 个灯', args: 'n：灯的编号 1~3', ret: '无', where: 'h' },
      { name: 'LED_Toggle', sig: 'void LED_Toggle(uint8_t n)', job: '翻转第 n 个灯（亮变灭、灭变亮）', args: 'n：灯的编号 1~3', ret: '无', where: 'h' }
    ],
    calls: ['main()', ['LED_Init()', 'while (1)', ['LED_On(n)', 'Delay_ms(500)', 'LED_Off(n)']]],
    place: [   // 放 .h 还是只在 .c 里
      { t: 'LED_Init / LED_On / LED_Off / LED_Toggle 的声明', h: true, why: 'main.c 要调用它们，声明得让别的文件看得见。' },
      { t: '#define LED1 1 这些编号', h: true, why: '调用的人要写 LED_On(LED1)，编号属于「接口」。' },
      { t: '#define LED_PORT GPIOA', h: false, why: '灯接在哪个端口是这块板子的细节，只有 led.c 需要知道；放进 .h 别人就会依赖它。' },
      { t: 'led_pin[] 表（每个灯是哪一位）', h: false, why: '同样是硬件细节；加 static，别的文件看不见。' },
      { t: '函数体（实现）', h: false, why: '.h 只放声明，实现在 led.c。头文件被好几个 .c 包含，放了函数体就会「重复定义」。' }
    ],
    // .h 一步步长出来：每一步是课件 led.h 的哪几行（按行号）
    hsteps: [
      { lines: [0, 1, 14], q: '先套上「外壳」：头文件保护' },
      { lines: [3], q: '自己用到 uint8_t，自己包含芯片头文件' },
      { lines: [5, 6, 7], q: '对外的编号' },
      { lines: [9, 10, 11, 12], q: '函数声明：只写函数头和分号' }
    ],
    chips: [
      { id: 'init', name: 'LED_Init()', file: 'led.c', fn: 'LED_Init', main: ['LED_Init();'],
        intro: '开机先调用一次。看信号先到 <b>RCC</b> 开时钟，再到 GPIOA：先把输出写成 1，再把三个脚切成推挽输出——切过去的那一刻灯是灭的。' },
      { id: 'on', name: 'LED_On(LED1)', file: 'led.c', fn: 'LED_On', main: ['LED_Init();', 'LED_On(1);'],
        intro: '已经初始化过了。点亮 LED1：写 BSRR 的高 16 位，PA0 输出 0，<b>N-MOS 导通</b>，电流从 3V3 流过 LED 进到引脚。' },
      { id: 'off', name: 'LED_Off(LED1)', file: 'led.c', fn: 'LED_Off', main: ['LED_Init();', 'LED_On(1);', 'LED_Off(1);'],
        intro: 'LED1 现在亮着。熄灭它：写 BSRR 的低 16 位，PA0 输出 1，<b>P-MOS 导通</b>，引脚和 3V3 一样高，没有电流。' },
      { id: 'toggle', name: 'LED_Toggle(LED2)', file: 'led.c', fn: 'LED_Toggle', main: ['LED_Init();', 'LED_Toggle(2);'],
        intro: '翻转用 ODR ^=：先把 ODR <b>读回</b> Cortex-M3，改一位再写回去。看蓝色的点走一趟回程。' },
      { id: 'main', name: 'main.c 流水灯', file: 'main.c', fn: 'main', ms: 1700, max: 12,
        intro: 'main 里只有 LED_ 开头的函数。走一圈：三个灯轮流亮 0.5 秒。' },
      { id: 'single', name: '单文件版 main.c', file: 'single', fn: 'main', ms: 1200, max: 9,
        intro: '编程思维「编写」第一版：只有一个灯，全写在 main 里。走一遍：开时钟、先写 1、切推挽，然后亮、灭。' }
    ],
    // 动画时代码下面那句「硬件上发生了什么」（按代码文本找）
    hw: {
      'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;': 'Cortex-M3 → 系统总线 → 总线矩阵 → AHB → <b>RCC</b>：IOPAEN 置 1，GPIOA 有了时钟。',
      'LED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;': '经 APB2 到 GPIOA 的<b>位设置/清除寄存器</b>，输出数据寄存器第 0、1、8 位都变成 1。三个脚还是输入，<b>输出驱动器没接上</b>，引脚不动。',
      'LED_PORT->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0 | GPIO_CRL_CNF1 | GPIO_CRL_MODE1);': 'PA0、PA1 的 4 个配置位清零：变成模拟输入，输入、输出驱动器都断开（连肖特基触发器也关了）。',
      'LED_PORT->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_MODE1);': 'PA0、PA1 变成<b>推挽输出</b>：输出驱动器接上。ODR 已经是 1 → <b>P-MOS 导通</b>，引脚 3.3 V，灯不亮（没闪一下）。',
      'LED_PORT->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);': 'PA8 在 CRH 里，同样先清零。',
      'LED_PORT->CRH |= (GPIO_CRH_MODE8);': 'PA8 也变成推挽输出，P-MOS 导通，灯灭着。',
      'if (n < 1 || n > 3) return;': '只在 Cortex-M3 里比较一下，<b>不碰总线和引脚</b>。',
      'LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;': '写 BSRR 的高 16 位（BR）：这一位清 0 → <b>N-MOS 导通</b> → 电流从 3V3 经 2kΩ、LED 流进引脚，经 N-MOS 到地——<b>亮</b>。',
      'LED_PORT->BSRR = led_pin[n];': '写 BSRR 的低 16 位（BS）：这一位置 1 → <b>P-MOS 导通</b>，引脚 3.3 V，LED 两端一样高——<b>灭</b>。',
      'LED_PORT->ODR ^= led_pin[n];': '读-改-写：先把 <b>ODR 读回</b> Cortex-M3，异或这一位，再整个写回去。比 BSRR 多走一趟总线。',
      'LED_Init();': '初始化：开时钟、先写 1、配推挽输出。',
      'LED_On(n);': '点亮第 n 个灯。',
      'Delay_ms(500);': 'CPU 原地等 0.5 秒，引脚保持不变。',
      'LED_Off(n);': '熄灭，轮到下一个。'
    },
    exercises: [
      { id: 'init', fn: 'LED_Init', title: '写 LED_Init', ask: '开 GPIOA 的时钟，把 PA0、PA1、PA8 配成推挽输出（50 MHz），而且上电那一刻灯不能闪一下。',
        check: 'checkInit', ref: 'LED_Init' },
      { id: 'onoff', fn: ['LED_On', 'LED_Off'], title: '写 LED_On 和 LED_Off', ask: '用 LED_PORT 和 led_pin[n] 写出点亮、熄灭第 n 个灯，只动这一个脚；编号不对就什么都不做。',
        check: 'checkOnOff', ref: ['LED_On', 'LED_Off'] }
    ],

    /* ---------- 编程思维（新版）：明确任务 → 查资料 → 规划 → 编写 → 验证 ---------- */
    // 查资料：每一问对应右边一份资料；查到的结论收进「资料卡」，规划时直接用
    look: [
      { q: 'LED 接在哪个脚？什么电平亮？', doc: 'sch-led',
        find: '原理图第 8 页右上角：3V3 → 排阻 RN2（2kΩ）→ LED → LED-1 / LED-2 / LED-3。这三根线在核心板上接 PA0、PA1、PA8。引脚输出 0 时 LED 两端有压差，<b>亮</b>；输出 1 时两端都是 3.3 V，灭。',
        card: 'LED1 / LED2 / LED3 = PA0 / PA1 / PA8，<b>输出 0 亮</b>' },
      { q: 'GPIOA 挂在哪条总线上？时钟归谁管？', doc: 'fig-sys',
        find: '系统结构图：GPIOA 在 <b>APB2</b> 那一列，经桥接 1 接到 AHB；外设时钟统一由 <b>RCC</b>（复位和时钟控制）开关。所以第一步要在 RCC 里找 APB2 的时钟使能寄存器。',
        card: 'GPIOA 在 APB2 上，时钟开关在 RCC' },
      { q: 'RCC_APB2ENR 里哪一位是 GPIOA？', doc: 'reg-apb2',
        find: '第 2 位 <b>IOPAEN</b>：写 1 开 GPIOA 的时钟。头文件里的宏叫 RCC_APB2ENR_IOPAEN。用 |= 只开这一位，别的外设的时钟不动。',
        card: 'RCC_APB2ENR 的 IOPAEN（位 2）写 1' },
      { q: '要让引脚输出，芯片里是什么结构？', doc: 'fig-out',
        find: '输出配置图：输出数据寄存器 → 输出控制 → <b>P-MOS / N-MOS</b>。推挽模式下写 1，P-MOS 导通，引脚接 VDD；写 0，N-MOS 导通，引脚接地。LED 只需要能被拉到 0，推挽就行（课件用推挽）。',
        card: '用<b>推挽输出</b>' },
      { q: 'CRL 里怎么把 PA0 配成推挽输出？', doc: 'reg-crl',
        find: '每个脚在 CRL / CRH 里占 4 位：<b>MODE = 11</b> 是输出、最大 50 MHz；<b>CNF = 00</b> 是通用推挽。复位值 0100 是浮空输入，所以要先把 4 位清掉再置。PA0~7 在 CRL，<b>PA8 在 CRH</b>。',
        card: 'MODE = 11、CNF = 00（先清后置）；PA8 在 CRH' },
      { q: '怎么让它输出 0 或 1？', doc: 'reg-bsrr',
        find: 'ODR 的每一位就是输出值。更方便的是 <b>BSRR</b>：低 16 位 BSy 写 1 → 这一位置 1；高 16 位 BRy 写 1 → 清 0。只动写 1 的位，不用先读出来。复位后 ODR 是 0——配成输出那一刻灯会亮，所以要<b>先写 1 再切输出</b>。',
        card: '亮：BR 写 1；灭：BS 写 1；先写 1 再切输出' }
    ],
    // 每一章都一样的初始化框架；这一章每一格填什么
    frame: [
      { k: '① 开时钟', q: '这个外设挂在哪条总线？时钟在 RCC 哪一位？', a: 'RCC->APB2ENR 的 IOPAEN（GPIOA 在 APB2 上）' },
      { k: '② 配引脚', q: '用哪几个脚？输入还是输出？推挽还是开漏？', a: 'PA0、PA1、PA8 推挽输出 50 MHz；先把输出写成 1，上电不闪' },
      { k: '③ 配外设', q: '外设自己还有要配的吗？（波特率、分频……）', a: 'GPIO 没有：它本身就是引脚' },
      { k: '④ 使能', q: '要不要打开外设的总开关？', a: 'GPIO 没有' },
      { k: '用', q: '平时怎么用：读、写，还是等标志？', a: '写输出：亮 = BR 写 1（输出 0），灭 = BS 写 1（输出 1）' }
    ],
    split: { q: '先写成一个 main.c 行不行？什么时候要拆成 led.h / led.c？',
      a: '<b>行</b>。只点一个灯、只用这一次，全写在 main 里最省事，编写那一步的第一版就是这样。<br>要拆的时候：灯一多（三个灯）、别的章节也要点灯（按键、串口都会用到）、换板子只想改一处——这时把「怎么点灯」收进 led.c，main 里只说「点哪个灯」。<b>.h 是给别人看的说明书</b>（有哪些函数、编号），<b>.c 是只有自己知道的做法</b>（哪个端口、哪一位、寄存器）。' },
    // 第一版：一个灯，全写在 main.c 里（[代码, 注释, 为什么]）
    single: [
      ['#include "stm32f10x.h"', '芯片头文件：寄存器名、宏都在里面', ''],
      ['#include "delay.h"', 'Delay_ms 来自延时模块', ''],
      ['', '', ''],
      ['int main(void)', '', ''],
      ['{', '', ''],
      ['    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', '开 GPIOA 的时钟', '时钟没开，后面写 GPIOA 的寄存器都没反应。|= 只开这一位。'],
      ['    GPIOA->BSRR = GPIO_BSRR_BS0;', '先把输出写成 1（灭）', '这时 PA0 还是输入，写 ODR 不影响引脚；等一会儿切成输出，输出的就是 1，上电不闪。'],
      ['    GPIOA->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0);', '清掉 PA0 的 4 个配置位', '复位值 0100（浮空输入）里的 CNF0 = 01 要先清掉，否则 |= 以后变成开漏。'],
      ['    GPIOA->CRL |= GPIO_CRL_MODE0;', 'PA0：推挽输出 50 MHz', 'MODE0 = 11 输出 50 MHz；CNF0 清零后就是 00 推挽。'],
      ['    while (1) {', '一直循环', ''],
      ['        GPIOA->BSRR = GPIO_BSRR_BR0;', '输出 0：亮', 'BR0 在 BSRR 的第 16 位，写 1 把 ODR0 清 0。'],
      ['        Delay_ms(500);', '', ''],
      ['        GPIOA->BSRR = GPIO_BSRR_BS0;', '输出 1：灭', ''],
      ['        Delay_ms(500);', '', ''],
      ['    }', '', ''],
      ['}', '', '']
    ],
    // 代码上方的小标题（子目标）：同一套标签，每一章都一样
    groups: {
      'single': { 5: '① 开时钟', 6: '② 配引脚', 9: '用：亮 → 等 → 灭 → 等' },
      'led.c': { 7: '① 开时钟', 8: '② 配引脚（先写 1，再切输出）', 15: '用：亮', 21: '用：灭', 27: '用：翻转' },
      'led.h': { 0: '头文件保护', 5: '对外的编号', 9: '对外的函数' },
      'main.c': { 5: '先初始化', 6: '主循环：只说「点哪个灯」' }
    },
    // 资料：sch 开发板原理图 / fig 参考手册框图 / reg 寄存器位图。框是相对整张图的比例 [x, y, w, h]
    docs: {
      'sch-led': { kind: 'sch', page: 'board-08', title: 'LED 电路', crop: [0.69, 0.05, 0.25, 0.24], hl: [[0.715, 0.08, 0.17, 0.19]] },
      'sch-key': { kind: 'sch', page: 'board-08', title: '按键电路', crop: [0.11, 0.33, 0.33, 0.33], hl: [[0.13, 0.355, 0.15, 0.1]] },
      'fig-sys': { kind: 'fig', fig: 'sys-arch', crop: [0, 0, 0.82, 0.74], hl: [[0.398, 0.428, 0.146, 0.092], [0.628, 0.655, 0.085, 0.042]] },
      'fig-out': { kind: 'fig', fig: 'gpio-out', hl: [[0.3, 0.5, 0.52, 0.42]] },
      'fig-in': { kind: 'fig', fig: 'gpio-in' },
      'reg-apb2': { kind: 'reg', id: 'RCC_APB2ENR', f: ['IOPAEN'], val: 0x4 },
      'reg-apb2-f': { kind: 'reg', id: 'RCC_APB2ENR', f: ['IOPFEN'], val: 0x80 },
      'reg-crl': { kind: 'reg', id: 'GPIO_CRL', f: ['MODE0', 'CNF0', 'MODE1', 'CNF1'], val: 0x44444433 },
      'reg-crh': { kind: 'reg', id: 'GPIO_CRH', f: ['MODE8', 'CNF8'], val: 0x44444443 },
      'reg-crh-key': { kind: 'reg', id: 'GPIO_CRH', f: ['MODE8', 'CNF8'], val: 0x44444448 },
      'reg-bsrr': { kind: 'reg', id: 'GPIO_BSRR', f: ['BR0', 'BS0'] },
      'reg-odr': { kind: 'reg', id: 'GPIO_ODR', f: ['ODR0', 'ODR1', 'ODR8'] },
      'reg-idr': { kind: 'reg', id: 'GPIO_IDR', f: ['IDR8'] }
    },
    // 换题：同一套框架，换一个需求
    transfer: {
      title: '换题：按键控制 LED',
      ask: '按住 KEY1，LED1 亮；松开，LED1 灭。LED 模块已经写好，可以直接用 LED_Init / LED_On / LED_Off。你来写 KEY_Init，和主循环里判断按键的那几行。',
      look: [
        { q: 'KEY1 接在哪个脚？按下是什么电平？', doc: 'sch-key', a: 'PF8。按下接 GND（低电平），原理图上<b>没有上拉电阻</b>——松开时要靠芯片内部上拉。' },
        { q: '输入要怎么配？', doc: 'fig-in', a: '上拉输入：MODE8 = 00（输入），CNF8 = 10（上拉/下拉），再把 ODR8 写成 1 选「上拉」。' },
        { q: '怎么读这个脚？', doc: 'reg-idr', a: '读 IDR 的第 8 位：(GPIOF->IDR & GPIO_IDR_IDR8) == 0 就是按下。' }
      ]
    }
  };
  var ORDER = ['gpio'];

  /* ===================== 代码 → 模拟器的程序 ===================== */
  function file(ch, name) { if (name === 'single') return ch.single; var c = CD()[ch.cd], f = c && c.files.filter(function (x) { return x.name === name; })[0]; return f ? f.lines : []; }
  // 把一个 .c 文件拆成全局行和函数（记下每一行在文件里的行号）
  function parseFile(lines) {
    var fns = {}, globals = [], cur = null, depth = 0;
    lines.forEach(function (l, idx) {
      var c = l[0], t = c.trim();
      if (!t || /^#include/.test(t)) return;
      if (!cur) {
        var m = /^((?:static\s+)?[\w\s\*]+?)\s+(\w+)\s*\(([^)]*)\)\s*$/.exec(t);
        if (m) { cur = { sig: t, lines: [], src: [], head: idx }; fns[m[2]] = cur; depth = 0; return; }
        globals.push(c); return;
      }
      if (depth === 0 && t === '{') { depth = 1; cur.open = idx; return; }
      var o = (t.match(/\{/g) || []).length, cl = (t.match(/\}/g) || []).length;
      if (depth === 1 && t === '}' ) { cur.close = idx; cur = null; return; }
      depth += o - cl;
      cur.lines.push({ c: c }); cur.src.push(idx);
    });
    return { fns: fns, globals: globals };
  }
  // 「else」单独起一行时接到上一行后面（模拟器按行插桩，else 不能和 if 分开）
  function joinElse(lines) { var out = []; lines.forEach(function (x) { if (/^\s*else\b/.test(x) && out.length) out[out.length - 1] += ' ' + x.trim(); else out.push(x); }); return out; }
  function program(ch, override) {
    var c = parseFile(file(ch, 'led.c')), m = parseFile(file(ch, 'main.c'));
    var fns = c.fns, hdr = file(ch, 'led.h').map(function (l) { return l[0]; }).filter(function (x) { return /^#define\s+\w+\s+\S/.test(x.trim()); });
    Object.keys(override || {}).forEach(function (k) {
      var body = joinElse(String(override[k]).split('\n').filter(function (x) { return x.trim(); })).map(function (x) { return { c: x }; });
      fns[k] = { sig: fns[k] ? fns[k].sig : 'void ' + k + '(void)', lines: body, src: body.map(function (_, i) { return i; }), mine: true };
    });
    if (m.fns.main) fns.main = m.fns.main;
    return { fns: fns, globals: hdr.concat(c.globals) };
  }

  /* ===================== 跑一遍，记下每一行之前的状态 ===================== */
  function mode(c) { if (c.mode === 0) return c.cnf === 0 ? 'an' : 'in'; return ['pp', 'od', 'afpp', 'afod'][c.cnf]; }
  function snap(ch, M) {
    var g = M.gpio[ch.port], o = { t: M.t, apb2: M.rcc.APB2ENR >>> 0, clk: !!(M.rcc[ch.clk.reg] & (1 << ch.clk.bit)), crl: g.CRLv >>> 0, crh: g.CRHv >>> 0, odr: g.ODRv >>> 0, pins: {} };
    ch.pins.forEach(function (p) { var c = M.pinCfg(p.key), lv = M.level(p.key); o.pins[p.key] = { mode: mode(c), odr: c.odr, level: lv === 'Z' ? 'z' : lv }; });
    return o;
  }
  // chip：{ fn: 只看这个函数的行, main: main 里依次调用的语句（没给就用 main.c）, ms, until, skip: 跳过前几次调用 }
  function trace(ch, chip, override) {
    var S = Sim(), prog = program(ch, override), snaps = [], err = null;
    if (chip.patch) prog.globals = chip.patch(prog.globals);
    if (chip.main) prog.fns.main = { sig: 'int main(void)', lines: chip.main.map(function (c) { return { c: c }; }), src: chip.main.map(function (_, i) { return i; }) };
    if (chip.file === 'single') prog.fns.main = parseFile(ch.single).fns.main;
    var r = S.run({ fns: prog.fns, globals: prog.globals }, { ms: chip.ms || 30, onLine: function (f, i, M) { snaps.push({ f: f, i: i, s: snap(ch, M) }); } });
    if (r.stop.kind === 'error') err = r.stop.text;
    snaps.push({ f: '__end', i: -1, s: snap(ch, r.machine) });
    var focus = chip.fn, F = prog.fns[focus], evs = [], states = [], seen = 0, started = false;
    for (var k = 0; k < snaps.length - 1; k++) {
      var sn = snaps[k];
      if (sn.f !== focus) continue;
      if (sn.i === 0 && focus !== 'main') { seen++; }
      if (chip.skip && seen <= chip.skip) continue;
      if (chip.max && evs.length >= chip.max) break;
      var j = k + 1;
      while (j < snaps.length - 1 && !(snaps[j].f === focus || (focus !== 'main' && snaps[j].f === 'main'))) j++;
      if (!started) { states.push(sn.s); started = true; }
      var text = F.lines[sn.i].c.trim();
      if (text === '}') continue;
      var ev = diff(ch, sn.s, snaps[j].s, text);
      ev.ln = F.src[sn.i]; ev.code = text;
      evs.push(ev); states.push(snaps[j].s);
      if (focus !== 'main' && snaps[j].f === 'main') { if (!chip.all) break; }
    }
    if (!states.length) states.push(snaps[snaps.length - 1].s);
    return { evs: evs, states: states, err: err, log: r.log, result: r, fn: F, prog: prog };
  }
  // 一行代码前后的状态 → 这一行在硬件上干了什么
  function diff(ch, a, b, text) {
    var ev = { parts: [] }, pins = ch.pins.map(function (p) { return p.key; });
    if (!a.clk && b.clk) ev.parts.push({ t: 'clk' });
    var odr = pins.filter(function (p) { return a.pins[p].odr !== b.pins[p].odr; });
    var md = pins.filter(function (p) { return a.pins[p].mode !== b.pins[p].mode; });
    var reg = /BSRR/.test(text) ? 'BSRR' : /BRR/.test(text) ? 'BRR' : /ODR\s*[\^|&]?=/.test(text) ? 'ODR' : /LED_(On|Off)/.test(text) ? 'BSRR' : /LED_Toggle/.test(text) ? 'ODR' : 'BSRR';
    if (odr.length) ev.parts.push({ t: 'w', pins: odr, reg: reg, rmw: reg === 'ODR' && /\^=|\|=|&=/.test(text) || /LED_Toggle/.test(text) });
    if (md.length) ev.parts.push({ t: 'mode', pins: md, reg: md.some(function (p) { return Number(p.slice(2)) >= 8; }) && md.some(function (p) { return Number(p.slice(2)) < 8; }) ? 'CR' : Number(md[0].slice(2)) >= 8 ? 'CRH' : 'CRL' });
    if (!ev.parts.length) {
      if (/Delay_/.test(text)) ev.parts.push({ t: 'delay', ms: Math.round((b.t - a.t) / 1000) });
      else if (/->|LED_PORT|GPIO[A-G]\b|RCC/.test(text) && !/^(if|return)/.test(text)) ev.parts.push({ t: a.clk ? 'same' : 'lost', reg: /CR[LH]/.test(text) ? 'CRL' : 'BSRR' });
      else ev.parts.push({ t: 'cpu' });
    }
    return ev;
  }

  /* ===================== 自己写：检查 ===================== */
  function body(ch, name) { var p = parseFile(file(ch, 'led.c')).fns[name]; return p ? p.lines.map(function (l) { return l.c; }).join('\n') : ''; }
  function nib(s, n) { return ((n < 8 ? s.crl : s.crh) >>> ((n & 7) * 4)) & 15; }
  var LEDP = [0, 1, 8];
  function checkInit(ch, src) {
    var t = trace(ch, { fn: 'LED_Init', main: ['LED_Init();'] }, { LED_Init: src }), out = [];
    if (t.err) return [{ k: 'err', id: 'syntax', msg: '这段代码模拟器看不懂：' + t.err + '。检查一下括号、分号和宏名的拼写。' }];
    var end = t.states[t.states.length - 1];
    if (!end.clk) out.push({ k: 'err', id: 'clk', msg: '跑完以后 GPIOA 还没有时钟，后面写的寄存器全都没生效。',
      hints: ['GPIO 用之前，第一件事要做什么？', '在 RCC 里打开 GPIOA 的时钟：APB2ENR 里的 IOPAEN。', 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;'] });
    else {
      var bad = [];
      ch.pins.forEach(function (p) { var m = end.pins[p.key].mode; if (m !== 'pp') bad.push(p.key + (m === 'od' ? ' 是开漏输出' : m === 'afpp' || m === 'afod' ? ' 是复用输出' : ' 还是输入')); });
      if (bad.length) out.push({ k: 'err', id: 'mode', msg: bad.join('，') + '。三个脚都要配成通用推挽输出。',
        hints: ['每个脚在 CRL / CRH 里占 4 位：MODE 选输入还是输出，CNF 选推挽还是开漏。推挽输出 50 MHz 是 MODE = 11、CNF = 00。', 'PA0、PA1 在 CRL，PA8 在 CRH。先 &= ~(CNF | MODE) 清掉，再 |= MODE 置上。',
          'LED_PORT->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0 | GPIO_CRL_CNF1 | GPIO_CRL_MODE1);\nLED_PORT->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_MODE1);\nLED_PORT->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\nLED_PORT->CRH |= (GPIO_CRH_MODE8);'] });
      var others = [];
      for (var n = 0; n < 16; n++) if (LEDP.indexOf(n) < 0 && nib(end, n) !== 4) others.push('PA' + n);
      if (others.length) out.push({ k: 'err', id: 'others', msg: '别的脚也被改了：' + others.slice(0, 6).join('、') + (others.length > 6 ? ' 等' : '') + '。CRL / CRH 被整体赋值了。',
        hints: ['用 = 直接给 CRL 赋值，会把同一个寄存器里其他 7 个脚的配置也一起改掉。', '只动自己的 4 位：先 &= ~(…) 清掉这几位，再 |= (…) 置上。', 'LED_PORT->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0 | GPIO_CRL_CNF1 | GPIO_CRL_MODE1);'] });
      if (!bad.length) {
        var lit = ch.pins.filter(function (p) { return end.pins[p.key].level === 0; });
        var flash = ch.pins.filter(function (p) { return t.states.some(function (s) { return s.pins[p.key].level === 0; }); });
        if (lit.length) out.push({ k: 'err', id: 'lit', msg: lit.map(function (p) { return p.label; }).join('、') + ' 初始化完是亮的。要求开机先灭着。',
          hints: ['ODR 的复位值是 0，配成输出以后引脚输出的就是 0——低电平点亮。', '配成输出之前，先把这三位写成 1。', 'LED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;'] });
        else if (flash.length) out.push({ k: 'warn', id: 'flash', msg: '上电那一刻 ' + flash.map(function (p) { return p.label; }).join('、') + ' 会闪一下：配成输出时 ODR 还是 0，之后才写 1。',
          hints: ['看动画：配成推挽输出的那一行，N-MOS 先导通了一下。', '把「写 1」挪到配引脚之前：先写 ODR，再切成输出。', 'LED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;   // 放在配 CRL / CRH 之前'] });
      }
    }
    if (!out.length) out.push({ k: 'ok', msg: '全对：时钟开了，PA0、PA1、PA8 都是推挽输出，别的脚没动，开机灯灭着，也没有闪一下。' });
    return out;
  }
  function checkOnOff(ch, onSrc, offSrc) {
    var calls = ['LED_Init();', 'LED_On(1);', 'LED_On(3);', 'LED_Off(1);', 'LED_On(5);', 'LED_Off(0);'];
    // 表后面接几格「垃圾」：C 里 led_pin[5] 会读到表外面的随便什么值，这里让它是 0xFFFF，越界就看得出来
    var junk = function (g) { return g.map(function (l) { return /led_pin\s*\[\s*\]/.test(l) ? l.replace(/\}\s*;\s*$/, ', 0xFFFF, 0xFFFF, 0xFFFF, 0xFFFF };') : l; }); };
    var t = trace(ch, { fn: 'main', main: calls, patch: junk }, { LED_On: onSrc, LED_Off: offSrc }), out = [];
    if (t.err) return [{ k: 'err', id: 'syntax', msg: '这段代码模拟器看不懂：' + t.err + '。检查一下括号、分号和宏名的拼写。' }];
    var S = t.states, L = function (s, k) { return s.pins[k].level; };
    // S[i + 1] 是执行完 calls[i] 之后
    var a1 = S[2], a3 = S[3], f1 = S[4], bad5 = S[5], bad0 = S[6];
    if (L(a1, 'PA0') !== 0) out.push({ k: 'err', id: 'on', msg: 'LED_On(1) 以后 LED1 没亮（PA0 = ' + L(a1, 'PA0') + '）。',
      hints: ['低电平点亮：要让这个脚输出 0。', '用 BSRR 的高 16 位（BR）清 0：led_pin[n] 左移 16 位就到了高半部分。', 'LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;'] });
    else if (L(a1, 'PA1') !== 1 || L(a1, 'PA8') !== 1) out.push({ k: 'err', id: 'onOthers', msg: 'LED_On(1) 把别的灯也点亮了。',
      hints: ['你是不是给 ODR 整个赋值了？', 'BSRR 只改写 1 的那几位，别的位不动。', 'LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;'] });
    if (L(a3, 'PA8') !== 0 || L(a3, 'PA0') !== 0) out.push({ k: 'err', id: 'onN', msg: 'LED_On(3) 没有只点亮 LED3（这时 LED1 应该还亮着）。',
      hints: ['参数 n 是编号，要换成「哪一位」。', '查表：led_pin[n] 就是第 n 个灯那一位的掩码。', 'LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;'] });
    if (L(f1, 'PA0') !== 1) out.push({ k: 'err', id: 'off', msg: 'LED_Off(1) 以后 LED1 还亮着。',
      hints: ['熄灭 = 输出 1。', '用 BSRR 的低 16 位（BS）置 1。', 'LED_PORT->BSRR = led_pin[n];'] });
    else if (L(f1, 'PA8') !== 0) out.push({ k: 'err', id: 'offOthers', msg: 'LED_Off(1) 把 LED3 也灭了。', hints: ['只能动第 n 个灯那一位。', 'BSRR 写 1 的位才会变。', 'LED_PORT->BSRR = led_pin[n];'] });
    var same = function (x, y) { return ['PA0', 'PA1', 'PA8'].every(function (k) { return L(x, k) === L(y, k); }); };
    if (!same(bad5, f1) || !same(bad0, bad5) || (bad5.odr & ~0x103) !== (f1.odr & ~0x103)) out.push({ k: 'warn', id: 'range', msg: 'LED_On(5) 把一排脚都拉低了：led_pin[5] 读到了表外面的值。编号不对的时候应该什么都不做。',
      hints: ['外面传进来的参数不一定对。', '函数开头先检查 n 的范围。', 'if (n < 1 || n > 3) return;'] });
    if (!out.length) out.push({ k: 'ok', msg: '全对：只动第 n 个灯那一位，编号不对就什么都不做。' });
    return out;
  }

  /* ===================== 一行代码 → 右边该放哪份资料 =====================
     认寄存器名和宏名：RCC->APB2ENR / ->CRL / ->CRH / ->BSRR / ->ODR / ->IDR；字段从宏名里取（GPIO_CRL_MODE0 → MODE0）。
     state 是这一行执行完以后的芯片状态（有就把寄存器的值也画出来）。 */
  function docFor(ch, code, state) {
    var t = String(code || '').replace(/\/\/.*$/, ''), f = [], m, rx;
    function grab(re) { var out = []; re.lastIndex = 0; while ((m = re.exec(t))) { var n = m[2] ? m[1] + m[2] : m[1]; if (out.indexOf(n) < 0) out.push(n); } return out; }
    if (/APB2ENR/.test(t)) { f = grab(/RCC_APB2ENR_(\w+)()/g); return { kind: 'reg', id: 'RCC_APB2ENR', f: f, val: state ? state.apb2 : null }; }
    if ((rx = /->\s*(CRL|CRH)\b/.exec(t))) {
      f = []; grab(/GPIO_CR[LH]_(?:CNF|MODE)(\d+)(?:_\d)?()/g).forEach(function (n) { f.push('MODE' + n, 'CNF' + n); });
      return { kind: 'reg', id: 'GPIO_' + rx[1], f: f, val: state && /LED_PORT|GPIOA/.test(t) ? state[rx[1].toLowerCase()] : null };
    }
    if (/->\s*BSRR\b/.test(t)) {
      f = grab(/GPIO_BSRR_(B[SR]\d+)()/g);
      if (/led_pin\s*\[\s*n\s*\]\s*<<\s*16/.test(t)) f = ['BR0', 'BR1', 'BR8'];
      else if (/led_pin\s*\[\s*n\s*\]/.test(t)) f = ['BS0', 'BS1', 'BS8'];
      var v = 0; f.forEach(function (n) { var k = Number(n.slice(2)); v |= (n[1] === 'R' ? 1 << (k + 16) : 1 << k); });
      return { kind: 'reg', id: 'GPIO_BSRR', f: f, val: /led_pin/.test(t) ? null : v >>> 0, write: true };
    }
    if (/->\s*BRR\b/.test(t)) return { kind: 'reg', id: 'GPIO_BRR', f: grab(/GPIO_BRR_(BR\d+)()/g) };
    if (/->\s*ODR\b|GPIO_ODR_ODR/.test(t)) {
      f = grab(/GPIO_ODR_(ODR\d+)()/g); if (/led_pin/.test(t)) f = ['ODR0', 'ODR1', 'ODR8'];
      return { kind: 'reg', id: 'GPIO_ODR', f: f, val: state && /LED_PORT|GPIOA|led_pin/.test(t) ? state.odr : null };
    }
    if (/->\s*IDR\b/.test(t)) return { kind: 'reg', id: 'GPIO_IDR', f: grab(/GPIO_IDR_(IDR\d+)()/g) };
    if (/#define\s+LED_PORT|LED1|LED2|LED3/.test(t)) return ch.docs['sch-led'];
    return null;
  }

  /* ===================== 换题：按键控制 LED ===================== */
  function levelAt(tr, us) { var v = null; (tr || []).forEach(function (e) { if (e[0] <= us) v = e[1]; }); return v; }
  function checkKey(ch, initSrc, loopSrc) {
    var S = Sim(), prog = program(ch, { KEY_Init: initSrc }), out = [];
    var loop = joinElse(String(loopSrc || '').split('\n').filter(function (x) { return x.trim(); }));
    prog.fns.main = { sig: 'int main(void)', lines: ['LED_Init();', 'KEY_Init();', 'while (1) {'].concat(loop, ['Delay_ms(1);', '}']).map(function (c) { return { c: c }; }) };
    var press = [[150, 350], [600, 800]];   // 主循环末尾悄悄加了 1 ms 延时：模拟器不用空转上千万圈，效果和一直查一样
    var r = S.run({ fns: prog.fns, globals: prog.globals }, { ms: 950, board: { keys: [{ pin: 'PF8', down: press }] } });
    if (r.stop.kind === 'error') return [{ k: 'err', id: 'syntax', msg: '这段代码模拟器看不懂：' + r.stop.text + '。检查一下括号、分号和宏名的拼写。' }];
    var M = r.machine, c = M.pinCfg('PF8');
    if (!(M.rcc.APB2ENR & (1 << 7))) return [{ k: 'err', id: 'clk', doc: 'reg-apb2-f', msg: 'GPIOF 没有开时钟，PF8 的配置都没生效。',
      hints: ['KEY1 在哪个端口？那个端口的时钟开了吗？', 'GPIOF 也在 APB2 上：RCC_APB2ENR 的 IOPFEN（位 7）。', 'RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;'] }];
    if (c.mode !== 0) out.push({ k: 'err', id: 'out', doc: 'reg-crh-key', msg: 'PF8 被配成了输出。按键要配成输入。',
      hints: ['按键是「读」，引脚应该是输入还是输出？', 'MODE8 = 00 是输入。', 'GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\nGPIOF->CRH |= GPIO_CRH_CNF8_1;\nGPIOF->BSRR = GPIO_BSRR_BS8;'] });
    else if (c.cnf === 1) out.push({ k: 'err', id: 'float', doc: 'fig-in', msg: 'PF8 是浮空输入：松开的时候没有任何东西决定它的电平，读到的值不可靠。',
      hints: ['看原理图：KEY1 松开时，PF8 接到哪了？', '板子上没有上拉电阻，要用芯片内部的：CNF8 = 10（上拉/下拉），ODR8 = 1 选上拉。', 'GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);\nGPIOF->CRH |= GPIO_CRH_CNF8_1;\nGPIOF->BSRR = GPIO_BSRR_BS8;'] });
    else if (c.cnf === 2 && !c.odr) out.push({ k: 'err', id: 'pulldown', doc: 'reg-odr', msg: 'PF8 选成了下拉：松开是 0，按下也是 0，分不出来。',
      hints: ['上拉还是下拉，由哪个寄存器决定？', 'CNF8 = 10 时，ODR8 = 1 是上拉，0 是下拉。复位后 ODR 是 0。', 'GPIOF->BSRR = GPIO_BSRR_BS8;'] });
    else if (c.cnf === 0) out.push({ k: 'err', id: 'analog', doc: 'reg-crh-key', msg: 'PF8 是模拟输入：数字部分断开了，读出来永远是 0。',
      hints: ['CNF8 = 00、MODE8 = 00 是哪种模式？', '上拉输入要 CNF8 = 10。', 'GPIOF->CRH |= GPIO_CRH_CNF8_1;'] });
    if (out.length) return out;
    // 行为：松开时灭、按住时亮
    var at = [[100, 1], [250, 0], [480, 1], [700, 0], [900, 1]], got = at.map(function (x) { return levelAt(r.trace.PA0, x[0] * 1000); });
    var ok = at.every(function (x, i) { return got[i] === x[1]; });
    if (!ok) {
      var inv = at.every(function (x, i) { return got[i] === 1 - x[1]; }), stuck = got.every(function (g) { return g === got[0]; });
      if (inv) out.push({ k: 'err', id: 'inverted', doc: 'sch-key', msg: '反了：松开时 LED1 亮，按住时灭。',
        hints: ['按下的时候，PF8 读到的是 0 还是 1？', '上拉 + 按键接地：按下读到 0。判断条件要写成 == 0。', 'if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);\nelse LED_Off(LED1);'] });
      else if (stuck) out.push({ k: 'err', id: 'stuck', doc: 'reg-idr', msg: 'LED1 一直' + (got[0] === 0 ? '亮' : '灭') + '，没有跟着按键变。',
        hints: ['主循环里有没有每一圈都读一次 PF8？', '读 IDR 的第 8 位：GPIOF->IDR & GPIO_IDR_IDR8。按下和松开要分别点亮、熄灭。', 'if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);\nelse LED_Off(LED1);'] });
      else out.push({ k: 'err', id: 'follow', doc: 'reg-idr', msg: 'LED1 没有完全跟着按键：按住时应该一直亮，松开就灭。',
        hints: ['松开的时候有没有把灯熄掉？', '两种情况都要处理：if … LED_On … else LED_Off。', 'if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);\nelse LED_Off(LED1);'] });
      return out;
    }
    return [{ k: 'ok', msg: '全对：GPIOF 开了时钟，PF8 上拉输入，按住亮、松开灭。同一套框架：① 开时钟 → ② 配引脚 → 用（这次是读）。' }];
  }

  return {
    CH: CH, ORDER: ORDER, chapter: function (id) { return CH[id] || null; },
    file: file, parseFile: parseFile, joinElse: joinElse, program: program, trace: trace, diff: diff, body: body,
    checkInit: checkInit, checkOnOff: checkOnOff, checkKey: checkKey, docFor: docFor, levelAt: levelAt
  };
});
