/* lab-core.js — 「编程思维」「硬件原理」两个模块共用的数据和逻辑（不碰 DOM，可在 Node 里测试）
   编程思维：一章 = 一道编程题，按「明确任务 → 查资料 → 规划 → 编写 → 验证」走完；右边一次只放一份资料。
   硬件原理：一张自绘的结构图（map），把外设拆成几块，一块讲一个知识点，并标出每块要初始化的寄存器。
   · 代码：直接用「代码推导」里课件同款的文件（STM32_CODEDERIVE），保证和课件一个写法。
   · 编写：点一行代码，右边显示这一行用到的寄存器；寄存器的值来自模拟器（mcusim.js）真的跑到这一行后的状态。
   · 验证：同样跑模拟器，按结果找出缺了哪一环，分三级提示（先问一句 → 指出哪一步 → 给出写法）。 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.STM32Lab = api;
})(typeof window === 'object' ? window : this, function (root) {
  'use strict';
  function Sim() { return root.STM32McuSim; }
  function CD() { return (root.STM32_CODEDERIVE || {}).CD || {}; }

  /* ===================== 章节 ===================== */
  // 初始化框架：每一章都是这几格，只是填的内容不同（标题用名词短语，答案在 frame 里按章节给）
  var FRAME = [['① 开时钟', '总线与时钟使能位'], ['② 配引脚', '引脚与工作模式'], ['③ 配外设', '外设参数'], ['④ 使能', '外设总开关'], ['用', '读写方式']];

  var CH = {};
  CH.gpio = {
    id: 'gpio', topic: 'gpio', title: 'GPIO：点亮 LED', cd: 'gpio',
    port: 'A', clk: { reg: 'APB2ENR', bit: 2, name: 'IOPAEN' },
    pins: [
      { key: 'PA0', label: 'LED1', color: 'y' },
      { key: 'PA1', label: 'LED2', color: 'b' },
      { key: 'PA8', label: 'LED3', color: 'g' }
    ],
    files: ['led.h', 'led.c', 'main.c'], cfile: 'led.c', hfile: 'led.h',
    task: '让板子上的三个 LED（LED1 黄、LED2 蓝、LED3 绿）轮流亮，做一个流水灯。main.c 里只写 LED_On(LED1) 这样的话，看不到任何寄存器。',
    ask: [
      { q: '实现效果', a: '三个灯轮流亮 0.5 秒。拆开看是三件小事：开机先把引脚准备好、点亮某个灯、熄灭某个灯。' },
      { q: '所需资料', a: '<b>开发板原理图</b>：灯接在哪个脚、什么电平亮。<b>参考手册框图</b>：GPIO 挂在哪条总线、引脚内部的输出结构。<b>寄存器说明</b>：具体写哪一位。' },
      { q: '程序负责的部分', a: '时钟（RCC 里开 GPIOA）、引脚模式（推挽输出）、输出的值（0 亮 1 灭）。延时不归 LED 管，交给 delay 模块。' }
    ],
    fns: [
      { name: 'LED_Init', sig: 'void LED_Init(void)', job: '开 GPIOA 的时钟，把 PA0、PA1、PA8 配成推挽输出，先让灯都灭着', args: '无', ret: '无' },
      { name: 'LED_On', sig: 'void LED_On(uint8_t n)', job: '点亮第 n 个灯', args: 'n：灯的编号 1~3', ret: '无' },
      { name: 'LED_Off', sig: 'void LED_Off(uint8_t n)', job: '熄灭第 n 个灯', args: 'n：灯的编号 1~3', ret: '无' },
      { name: 'LED_Toggle', sig: 'void LED_Toggle(uint8_t n)', job: '翻转第 n 个灯（亮变灭、灭变亮）', args: 'n：灯的编号 1~3', ret: '无' }
    ],
    calls: ['main()', ['LED_Init()', 'while (1)', ['LED_On(n)', 'Delay_ms(500)', 'LED_Off(n)']]],
    place: [
      { t: 'LED_Init / LED_On / LED_Off / LED_Toggle 的声明', h: true, why: 'main.c 要调用它们，声明得让别的文件看得见。' },
      { t: '#define LED1 1 这些编号', h: true, why: '调用的人要写 LED_On(LED1)，编号属于「接口」。' },
      { t: '#define LED_PORT GPIOA', h: false, why: '灯接在哪个端口是这块板子的细节，只有 led.c 需要知道；放进 .h 别人就会依赖它。' },
      { t: 'led_pin[] 表（每个灯是哪一位）', h: false, why: '同样是硬件细节；加 static，别的文件看不见。' },
      { t: '函数体（实现）', h: false, why: '.h 只放声明，实现在 led.c。头文件被好几个 .c 包含，放了函数体就会「重复定义」。' }
    ],
    chips: [
      { id: 'init', name: 'LED_Init()', file: 'led.c', fn: 'LED_Init', main: ['LED_Init();'],
        intro: '开机先调用一次。信号先到 <b>RCC</b> 开时钟，再到 GPIOA：先把输出写成 1，再把三个脚切成推挽输出——切过去的那一刻灯是灭的。' },
      { id: 'on', name: 'LED_On(LED1)', file: 'led.c', fn: 'LED_On', main: ['LED_Init();', 'LED_On(1);'],
        intro: '已经初始化过了。点亮 LED1：写 BSRR 的高 16 位，PA0 输出 0，<b>N-MOS 导通</b>，电流从 3V3 流过 LED 进到引脚。' },
      { id: 'off', name: 'LED_Off(LED1)', file: 'led.c', fn: 'LED_Off', main: ['LED_Init();', 'LED_On(1);', 'LED_Off(1);'],
        intro: 'LED1 现在亮着。熄灭：写 BSRR 的低 16 位，PA0 输出 1，<b>P-MOS 导通</b>，引脚和 3V3 一样高，没有电流。' },
      { id: 'toggle', name: 'LED_Toggle(LED2)', file: 'led.c', fn: 'LED_Toggle', main: ['LED_Init();', 'LED_Toggle(2);'],
        intro: '翻转用 ODR ^=：先把 ODR <b>读回</b> Cortex-M3，改一位再写回去。蓝色的点是回程。' },
      { id: 'main', name: 'main.c 流水灯', file: 'main.c', fn: 'main', ms: 1700, max: 12,
        intro: 'main 里只有 LED_ 开头的函数。一圈：三个灯轮流亮 0.5 秒。' },
      { id: 'single', name: '单文件版 main.c', file: 'single', fn: 'main', ms: 1200, max: 9,
        intro: '编程思维「编写」的第一版：只有一个灯，全写在 main 里。开时钟、先写 1、切推挽，然后亮、灭。' }
    ],
    hwFns: [['LED_Init', 'init'], ['LED_On', 'on'], ['LED_Off', 'off'], ['LED_Toggle', 'toggle']],
    exercises: [
      { id: 'init', label: '编写 LED_Init', fns: ['LED_Init'], rows: 8, check: 'checkInit',
        ask: '开 GPIOA 的时钟，把 PA0、PA1、PA8 配成推挽输出（50 MHz），而且上电那一刻灯不能闪一下。' },
      { id: 'onoff', label: '编写 LED_On / LED_Off', fns: ['LED_On', 'LED_Off'], rows: 3, check: 'checkOnOff',
        ask: '用 LED_PORT 和 led_pin[n] 写出点亮、熄灭第 n 个灯，只动这一个脚；编号不对就什么都不做。' }
    ],
    ctx: [0, 3],   // 自己写时上面给出的 led.c 前几行
    defaults: { task: 'sch-led', look: 'sch-led', v1: 'reg-apb2', v2: 'reg-crl' },

    look: [
      { q: 'LED 连接与点亮电平', doc: 'sch-led',
        find: '原理图第 8 页右上角：3V3 → 排阻 RN2（2kΩ）→ LED → LED-1 / LED-2 / LED-3。这三根线在核心板上接 PA0、PA1、PA8。引脚输出 0 时 LED 两端有压差，<b>亮</b>；输出 1 时两端都是 3.3 V，灭。',
        card: 'LED1 / LED2 / LED3 = PA0 / PA1 / PA8，<b>输出 0 亮</b>' },
      { q: 'GPIOA 所在总线与时钟来源', doc: 'fig-sys',
        find: '系统结构图：GPIOA 在 <b>APB2</b> 那一列，经桥接 1 接到 AHB；外设时钟统一由 <b>RCC</b>（复位和时钟控制）开关。第一步要在 RCC 里找 APB2 的时钟使能寄存器。',
        card: 'GPIOA 在 APB2 上，时钟开关在 RCC' },
      { q: 'GPIOA 时钟使能位', doc: 'reg-apb2',
        find: 'RCC_APB2ENR 第 2 位 <b>IOPAEN</b>：写 1 开 GPIOA 的时钟，宏名 RCC_APB2ENR_IOPAEN。用 |= 只开这一位，别的外设的时钟不动。',
        card: 'RCC_APB2ENR 的 IOPAEN（位 2）写 1' },
      { q: '引脚输出结构', doc: 'fig-out',
        find: '输出配置图：输出数据寄存器 → 输出控制 → <b>P-MOS / N-MOS</b>。推挽模式下写 1，P-MOS 导通，引脚接 VDD；写 0，N-MOS 导通，引脚接地。LED 只需要能被拉到 0，推挽就行（课件用推挽）。',
        card: '用<b>推挽输出</b>' },
      { q: 'PA0 推挽输出配置', doc: 'reg-crl',
        find: '每个脚在 CRL / CRH 里占 4 位：<b>MODE = 11</b> 是输出、最大 50 MHz；<b>CNF = 00</b> 是通用推挽。复位值 0100 是浮空输入，所以要先把 4 位清掉再置。PA0~7 在 CRL，<b>PA8 在 CRH</b>。',
        card: 'MODE = 11、CNF = 00（先清后置）；PA8 在 CRH' },
      { q: '输出电平控制', doc: 'reg-bsrr',
        find: 'ODR 的每一位就是输出值。更方便的是 <b>BSRR</b>：低 16 位 BSy 写 1 → 这一位置 1；高 16 位 BRy 写 1 → 清 0。只动写 1 的位，不用先读出来。复位后 ODR 是 0——配成输出那一刻灯会亮，所以要<b>先写 1 再切输出</b>。',
        card: '亮：BR 写 1；灭：BS 写 1；先写 1 再切输出' }
    ],
    frame: ['RCC->APB2ENR 的 IOPAEN（GPIOA 在 APB2 上）', 'PA0、PA1、PA8 推挽输出 50 MHz；先把输出写成 1，上电不闪', 'GPIO 没有：它本身就是引脚', 'GPIO 没有', '写输出：亮 = BR 写 1（输出 0），灭 = BS 写 1（输出 1）'],
    split: { q: '单文件与模块化',
      a: '只点一个灯、只用这一次，全写在 main 里最省事，编写那一步的第一版就是这样。<br>需要拆的时候：灯一多（三个灯）、别的章节也要点灯（按键、串口都会用到）、换板子只想改一处——这时把「怎么点灯」收进 led.c，main 里只说「点哪个灯」。<b>.h 是给别人看的说明书</b>（有哪些函数、编号），<b>.c 是只有自己知道的做法</b>（哪个端口、哪一位、寄存器）。' },
    v1: { label: '第一版 单文件', lead: '', limit: ['单文件的局限', '三个灯就要把这几行抄三遍；按键、串口那几章也要点灯，又得再抄；换一块板子，灯换了脚，得把所有地方都找出来改。<b>把「怎么点灯」收进一个模块</b>，main 里只说「点哪个灯」——这就是第二版。'] },
    v2: { label: '第二版 led 模块' },
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
    groups: {
      'single': { 5: '① 开时钟', 6: '② 配引脚', 9: '用：亮 → 等 → 灭 → 等' },
      'led.c': { 7: '① 开时钟', 8: '② 配引脚（先写 1，再切输出）', 15: '用：亮', 21: '用：灭', 27: '用：翻转' },
      'led.h': { 0: '头文件保护', 5: '对外的编号', 9: '对外的函数' },
      'main.c': { 5: '初始化', 6: '主循环：只说「点哪个灯」' }
    },
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
      'reg-crh-key': { kind: 'reg', id: 'GPIO_CRH', f: ['MODE8', 'CNF8'], val: 0x44444448, port: 'F' },
      'reg-bsrr': { kind: 'reg', id: 'GPIO_BSRR', f: ['BR0', 'BS0'] },
      'reg-odr': { kind: 'reg', id: 'GPIO_ODR', f: ['ODR0', 'ODR1', 'ODR8'] },
      'reg-idr': { kind: 'reg', id: 'GPIO_IDR', f: ['IDR8'], port: 'F' },
      'reg-bsrr-key': { kind: 'reg', id: 'GPIO_BSRR', f: ['BS8'], val: 0x100, write: true, port: 'F' }
    },
    transfer: {
      label: '迁移：按键控制 LED', doc: 'sch-key', check: 'checkKey',
      ask: '按住 KEY1，LED1 亮；松开，LED1 灭。LED 模块已经写好，可以直接用 LED_Init / LED_On / LED_Off。你来写 KEY_Init，和主循环里判断按键的那几行。',
      look: [
        { q: 'KEY1 连接与按下电平', doc: 'sch-key', a: 'PF8。按下接 GND（低电平），原理图上<b>没有上拉电阻</b>——松开时要靠芯片内部上拉。' },
        { q: '上拉输入配置', doc: 'fig-in', a: '上拉输入：MODE8 = 00（输入），CNF8 = 10（上拉/下拉），再把 ODR8 写成 1 选「上拉」。' },
        { q: '引脚读取', doc: 'reg-idr', a: '读 IDR 的第 8 位：(GPIOF->IDR & GPIO_IDR_IDR8) == 0 就是按下。' }
      ],
      editors: [
        { key: 'KEY_Init', file: 'key.c', head: 'void KEY_Init(void)\n{', tail: '}', rows: 6, label: 'KEY_Init 的函数体' },
        { key: 'KEY_loop', file: 'main.c', head: 'int main(void)\n{\n    LED_Init();\n    KEY_Init();\n    while (1) {', tail: '    }\n}', rows: 4, label: '主循环里的代码', init: '        ' }
      ],
      ref: 'void KEY_Init(void)\n{\n    RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;                  // ① 开 GPIOF 的时钟\n    GPIOF->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);     // ② PF8：先清掉\n    GPIOF->CRH |= GPIO_CRH_CNF8_1;                       //    CNF8 = 10 上拉/下拉输入\n    GPIOF->BSRR = GPIO_BSRR_BS8;                         //    ODR8 = 1 选上拉\n}\n\n// main 的 while (1) 里：\nif ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) LED_On(LED1);   // 按下读到 0\nelse LED_Off(LED1);'
    }
  };

  CH.tim = {
    id: 'tim', topic: 'tim', title: '定时器：呼吸灯与毫秒节拍', cd: 'tim', kind: 'tim',
    port: 'A', clk: { reg: 'APB2ENR', bit: 2, name: 'IOPAEN' },
    pins: [{ key: 'PA1', label: 'LED2', color: 'b' }],
    tims: [{ n: 6, basic: true, irq: 54, isr: 'TIM6_IRQHandler' }, { n: 5, ch: 2, pin: 'PA1' }],
    files: ['tim.h', 'tim.c', 'main.c'], cfile: 'tim.c', hfile: 'tim.h',
    task: 'LED2 做呼吸灯：亮度慢慢升高、再慢慢降低，一直循环。主循环里不用 Delay，留出时间做别的事；需要计时的时候，读一个毫秒节拍。',
    ask: [
      { q: '实现效果', a: 'LED2 的亮度在 0 和 100% 之间来回变化，每 10 ms 变一点。拆开是两件事：<b>调亮度</b>（PWM）和<b>计时</b>（1 ms 节拍）。' },
      { q: '所需资料', a: '<b>开发板原理图</b>：LED2 接哪个脚。<b>数据手册引脚表</b>：这个脚能接哪个定时器通道。<b>参考手册</b>：时钟树、定时器框图、PWM 模式、相关寄存器。' },
      { q: '程序负责的部分', a: '两个定时器：TIM5 通道 2 输出 PWM 调亮度；TIM6 每 1 ms 产生一次更新中断，中断里计数。主循环只看时间、改亮度。' }
    ],
    fns: [
      { name: 'Tick_Init', sig: 'void Tick_Init(void)', job: 'TIM6 每 1 ms 产生一次更新中断，开始计时', args: '无', ret: '无' },
      { name: 'Millis', sig: 'uint32_t Millis(void)', job: '读开机以来过了多少毫秒', args: '无', ret: '毫秒数' },
      { name: 'PWM_Init', sig: 'void PWM_Init(void)', job: 'TIM5 通道 2 在 PA1（LED2）上输出 1 kHz PWM，先灭', args: '无', ret: '无' },
      { name: 'PWM_SetDuty', sig: 'void PWM_SetDuty(uint16_t permille)', job: '设置 LED2 的亮度', args: 'permille：0~1000（千分比）', ret: '无' }
    ],
    calls: ['main()', ['Tick_Init()', 'PWM_Init()', 'while (1)', ['Millis()', 'PWM_SetDuty(duty)']], 'TIM6_IRQHandler()', ['ms++']],
    place: [
      { t: 'Tick_Init / Millis / PWM_Init / PWM_SetDuty 的声明', h: true, why: 'main.c 要调用它们，声明得让别的文件看得见。' },
      { t: 'static volatile uint32_t ms;', h: false, why: '只有 tim.c 的中断函数改它，别人通过 Millis() 读；放进 .h，别的文件就能直接改。' },
      { t: 'TIM6_IRQHandler', h: false, why: '中断函数由硬件调用，不给别人调；名字和启动文件里的一样就行，不用声明。' },
      { t: 'PWM_SetDuty 的参数用千分比', h: true, why: '参数属于接口。用千分比，以后改了 ARR，调用的地方不用改。' }
    ],
    chips: [
      { id: 'pwm', name: 'PWM_Init()', file: 'tim.c', fn: 'PWM_Init', main: ['PWM_Init();'],
        intro: '开时钟、PA1 切成复用推挽、配 PSC / ARR / CCR2 和通道 2 的 PWM 模式，最后开始计数。计数开始以后，CNT 一圈一圈地数，和 CCR2 比较，结果送到 PA1。' },
      { id: 'duty', name: 'PWM_SetDuty(250)', file: 'tim.c', fn: 'PWM_SetDuty', main: ['PWM_Init();', 'PWM_SetDuty(250);'],
        intro: 'PWM 已经在跑，占空比 0（灭）。写 CCR2 = 250：每一圈前 1/4 的时间输出有效（低电平），LED2 亮四分之一的时间。' },
      { id: 'tick', name: 'Tick_Init()', file: 'tim.c', fn: 'Tick_Init', main: ['Tick_Init();'], ms: 2,
        intro: 'TIM6 每 1 ms 溢出一次。打开更新中断和 NVIC 以后，每次溢出 CPU 都会去执行一次中断函数。' },
      { id: 'isr', name: 'TIM6_IRQHandler()', file: 'tim.c', fn: 'TIM6_IRQHandler', main: ['Tick_Init();', 'Delay_ms(2);'], ms: 3, max: 3,
        intro: 'CNT 数到 ARR，UIF 置 1，经 NVIC 打断 CPU。中断函数先看是不是更新中断，清掉 UIF，再把毫秒数加 1。' },
      { id: 'single', name: '单文件版 main.c', file: 'single', fn: 'main', ms: 60, max: 17,
        intro: '编程思维「编写」的第一版：只做呼吸灯，全写在 main 里，用 Delay 等 10 ms。' }
    ],
    hwFns: [['Tick_Init', 'tick'], ['PWM_Init', 'pwm'], ['PWM_SetDuty', 'duty'], ['TIM6_IRQHandler', 'isr']],
    exercises: [
      { id: 'pwm', label: '编写 PWM_Init', fns: ['PWM_Init'], rows: 12, check: 'checkPwm',
        ask: 'TIM5 通道 2 在 PA1（LED2）上输出 1 kHz 的 PWM，低电平有效；初始化完先灭（占空比 0）。' },
      { id: 'tick', label: '编写 Tick_Init', fns: ['Tick_Init'], rows: 9, check: 'checkTick',
        ask: 'TIM6 每 1 ms 产生一次更新中断。中断函数已经写好（清 UIF、ms++）。' }
    ],
    ctx: null,
    defaults: { task: 'sch-led', look: 'sch-led', v1: 'reg-apb1', v2: 'reg-psc' },

    look: [
      { q: 'LED2 连接', doc: 'sch-led', find: 'LED2（蓝）接 PA1，接法和 LED1 一样：3V3 → 2kΩ → LED → 引脚，<b>输出 0 亮</b>。', card: 'LED2 = PA1，输出 0 亮' },
      { q: 'PA1 的复用功能', doc: 'pin-pa1', find: '数据手册的引脚定义表：PA1 的默认复用功能有 USART2_RTS、ADC123_IN1、<b>TIM5_CH2</b>、TIM2_CH2。选 TIM5 通道 2，不用重映射。', card: 'PA1 = <b>TIM5_CH2</b>（默认复用，不用重映射）' },
      { q: '定时器时钟', doc: 'fig-clock', find: '时钟树：TIM2~7 挂在 <b>APB1</b>。APB1 是 72 MHz 二分频 = 36 MHz；APB1 的分频系数不为 1 时定时器时钟 ×2，所以 <b>TIMxCLK = 72 MHz</b>。', card: 'TIM5 / TIM6 在 APB1，计数时钟 72 MHz' },
      { q: '定时器时钟使能位', doc: 'reg-apb1', find: 'RCC_APB1ENR：<b>TIM5EN</b> 是第 3 位，<b>TIM6EN</b> 是第 4 位。PA1 还要开 GPIOA 的时钟（APB2ENR 的 IOPAEN）。', card: 'APB1ENR 的 TIM5EN（位 3）、TIM6EN（位 4）；APB2ENR 的 IOPAEN' },
      { q: '定时器内部结构', doc: 'fig-tim', find: '通用定时器框图：时钟 → <b>PSC</b> 预分频 → <b>CNT</b> 计数，数到 <b>ARR</b> 产生更新事件（UEV）并回到 0；每个通道把 CNT 和<b>捕获/比较寄存器（CCR）</b>比较，结果经输出控制送到引脚。', card: 'PSC 分频 → CNT 数到 ARR 溢出；CNT 与 CCR 比较 → 输出' },
      { q: '计数频率与周期', doc: 'reg-psc', find: '计数频率 = 72 MHz ÷ (PSC + 1)；一圈 = ARR + 1 个数。PSC = 71 → 1 MHz（1 µs 一个数），ARR = 999 → 1 ms 一圈。PSC 有<b>影子寄存器</b>，写完要等一次更新事件（或写 EGR 的 UG）才生效。', card: 'PSC = 71 → 1 MHz；ARR = 999 → 1 ms；写 UG 立即装载' },
      { q: 'PWM 模式', doc: 'fig-pwm', find: 'PWM 模式 1（OCxM = 110）：CNT < CCR 时输出<b>有效</b>，否则无效。CCR 越大，有效的时间越长。ARR + 1 = 1000 时，CCR 正好是千分比。', card: 'OC2M = 110（PWM 模式 1），CCR2 = 亮度千分比' },
      { q: '输出极性与使能', doc: 'reg-ccer', find: 'CCER 的 <b>CC2E</b> 打开通道 2 的输出；<b>CC2P = 1</b> 让「有效」= 低电平。LED2 低电平亮，有效 = 亮，CCR 越大越亮。', card: 'CC2E = 1 打开输出；CC2P = 1 低电平有效' },
      { q: '更新中断', doc: 'reg-dier', find: 'DIER 的 <b>UIE</b> 允许更新中断；溢出时 SR 的 <b>UIF</b> 置 1，NVIC 里也要打开 TIM6 中断。中断函数里先把 UIF 清 0（写 0 清除），否则一退出又进来。', card: 'UIE = 1，NVIC 打开 TIM6；中断里清 UIF' }
    ],
    frame: ['RCC->APB1ENR 的 TIM5EN、TIM6EN；RCC->APB2ENR 的 IOPAEN（PA1）', 'PA1 复用推挽输出 50 MHz（CNF = 10，MODE = 11）：输出由 TIM5_CH2 驱动', 'PSC = 71、ARR = 999；TIM5 通道 2：PWM 模式 1、CC2E 打开、CC2P 低有效；写 UG 装载', 'TIM6：UIE + NVIC 打开中断；两个定时器 CR1 的 CEN 置 1 开始计数', '改 CCR2 调亮度；TIM6 中断里 ms++，Millis() 读时间'],
    split: { q: '单文件与模块化',
      a: '第一版只做呼吸灯：PWM 配好以后，主循环里改 CCR2、再 Delay_ms(10)。能跑，但 Delay 的时候 CPU 只能干等。<br>要让主循环腾出手，就需要一个<b>时间基准</b>：TIM6 每 1 ms 中断一次、计一次数，主循环只问「过了 10 ms 没有」。PWM 和节拍都属于定时器，收进 tim.c；对外只给 Tick_Init、Millis、PWM_Init、PWM_SetDuty 四个函数。' },
    v1: { label: '第一版 单文件', limit: ['单文件的局限', 'Delay_ms(10) 的这 10 ms 里，CPU 什么都干不了：要同时查按键、收串口就做不到。第二版用 TIM6 做 1 ms 节拍，主循环只在「到时间了」才改亮度，其余时间可以做别的事。'] },
    v2: { label: '第二版 tim 模块' },
    single: [
      ['#include "stm32f10x.h"', '芯片头文件', ''],
      ['#include "delay.h"', 'Delay_ms 来自延时模块', ''],
      ['', '', ''],
      ['int main(void)', '', ''],
      ['{', '', ''],
      ['    int16_t duty = 0, step = 10;', '当前亮度、每次变多少', 'step 要能变成负的，用有符号数。'],
      ['    RCC->APB1ENR |= RCC_APB1ENR_TIM5EN;', '开 TIM5 的时钟', 'TIM5 挂在 APB1。'],
      ['    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', '开 GPIOA 的时钟', 'PA1 在 GPIOA。'],
      ['    GPIOA->CRL &= ~(GPIO_CRL_CNF1 | GPIO_CRL_MODE1);', '清掉 PA1 的配置位', ''],
      ['    GPIOA->CRL |= (GPIO_CRL_MODE1 | GPIO_CRL_CNF1_1);', 'PA1：复用推挽 50 MHz', '输出由 TIM5_CH2 驱动，所以选「复用」：CNF1 = 10。'],
      ['    TIM5->PSC = 72 - 1;', '72 MHz ÷ 72 = 1 MHz', '分频比 = PSC + 1。'],
      ['    TIM5->ARR = 1000 - 1;', '一圈 1000 个数 = 1 ms，PWM 1 kHz', '高于 100 Hz，人眼看不出闪。'],
      ['    TIM5->CCR2 = 0;', '先灭', ''],
      ['    TIM5->CCMR1 = TIM_CCMR1_OC2M_2 | TIM_CCMR1_OC2M_1 | TIM_CCMR1_OC2PE;', '通道 2：PWM 模式 1，开预装载', 'CNT < CCR2 时输出有效。'],
      ['    TIM5->CCER = TIM_CCER_CC2E | TIM_CCER_CC2P;', '打开通道 2，低电平有效', 'LED2 低电平亮：有效 = 亮。'],
      ['    TIM5->EGR = TIM_EGR_UG;', '装载上面的值', 'PSC、ARR、CCR 都有影子寄存器，UG 让它们立刻生效。'],
      ['    TIM5->CR1 |= TIM_CR1_CEN;', '开始计数', ''],
      ['    while (1) {', '', ''],
      ['        duty += step;', '改一点亮度', ''],
      ['        if (duty <= 0 || duty >= 1000) step = -step;', '到头就反向', ''],
      ['        TIM5->CCR2 = duty;', '写进比较寄存器', '下一圈开始按新的比较值输出。'],
      ['        Delay_ms(10);', '等 10 ms', '这 10 ms 里 CPU 只能干等。'],
      ['    }', '', ''],
      ['}', '', '']
    ],
    groups: {
      'single': { 6: '① 开时钟', 8: '② 配引脚', 10: '③ 配外设', 15: '④ 使能', 17: '用：每 10 ms 改一次亮度' },
      'tim.c': { 8: '① 开时钟', 9: '③ 配外设（1 ms 溢出一次）', 13: '④ 使能（中断 + 计数）', 20: '① 开时钟', 22: '② 配引脚（PA1 复用推挽）', 24: '③ 配外设（PWM 模式 1，1 kHz）', 31: '④ 使能', 34: '用：读时间', 39: '用：调亮度', 45: '中断：每 1 ms 一次' },
      'tim.h': { 0: '头文件保护', 5: '对外的函数' },
      'main.c': { 6: '初始化', 8: '主循环：到时间才改亮度，不等' }
    },
    docs: {
      'sch-led': { kind: 'sch', page: 'board-08', title: 'LED 电路', crop: [0.69, 0.05, 0.25, 0.24], hl: [[0.715, 0.13, 0.17, 0.065]] },
      'pin-pa1': { kind: 'pin', pin: 'PA1', hl: ['TIM5_CH2'] },
      'pin-pa0': { kind: 'pin', pin: 'PA0', hl: ['TIM2_CH1_ETR'] },
      'fig-clock': { kind: 'fig', fig: 'clock-tree', crop: [0.3, 0.28, 0.7, 0.36], hl: [[0.555, 0.38, 0.25, 0.15]] },
      'fig-tim': { kind: 'fig', fig: 'tim-gp', crop: [0, 0.28, 1, 0.38], hl: [[0.42, 0.355, 0.3, 0.115], [0.52, 0.5, 0.42, 0.075]] },
      'fig-pwm': { kind: 'fig', fig: 'tim-pwm-edge' },
      'reg-apb1': { kind: 'reg', id: 'RCC_APB1ENR', f: ['TIM5EN', 'TIM6EN'], val: 0x18 },
      'reg-apb1-t2': { kind: 'reg', id: 'RCC_APB1ENR', f: ['TIM2EN'], val: 0x1 },
      'reg-apb2': { kind: 'reg', id: 'RCC_APB2ENR', f: ['IOPAEN'], val: 0x4 },
      'reg-crl-pa1': { kind: 'reg', id: 'GPIO_CRL', f: ['MODE1', 'CNF1'], val: 0x444444B4 },
      'reg-crl-pa0': { kind: 'reg', id: 'GPIO_CRL', f: ['MODE0', 'CNF0'], val: 0x4444444B },
      'reg-psc': { kind: 'reg', id: 'TIM_PSC', f: ['PSC'], val: 71, note: 'ARR 同理：ARR = 999，CNT 从 0 数到 999 为一圈。' },
      'reg-arr': { kind: 'reg', id: 'TIM_ARR', f: ['ARR'], val: 999 },
      'reg-ccmr1': { kind: 'reg', id: 'TIM_CCMR1', f: ['OC2M', 'OC2PE'], val: 0x6800 },
      'reg-ccmr1-c1': { kind: 'reg', id: 'TIM_CCMR1', f: ['OC1M', 'OC1PE'], val: 0x68 },
      'reg-ccer': { kind: 'reg', id: 'TIM_CCER', f: ['CC2E', 'CC2P'], val: 0x30 },
      'reg-ccer-c1': { kind: 'reg', id: 'TIM_CCER', f: ['CC1E', 'CC1P'], val: 0x3 },
      'reg-cr1': { kind: 'reg', id: 'TIM_CR1', f: ['CEN', 'ARPE'], val: 0x81 },
      'reg-egr': { kind: 'reg', id: 'TIM_EGR', f: ['UG'], val: 1, write: true },
      'reg-dier': { kind: 'reg', id: 'TIM_DIER', f: ['UIE'], val: 1, note: 'TIM6 是基本定时器，参考手册里它的寄存器在「基本定时器」一章，UIE、UIF 的位置相同。' },
      'reg-sr': { kind: 'reg', id: 'TIM_SR', f: ['UIF'] },
      'reg-ccr2': { kind: 'reg', id: 'TIM_CCR2', f: ['CCR2'], val: 250 }
    },
    transfer: {
      label: '迁移：LED1 固定亮度', doc: 'pin-pa0', check: 'checkTransferPwm',
      ask: 'LED1 固定在 25% 的亮度：用 TIM2 通道 1（PA0）输出 2 kHz 的 PWM，低电平有效。写一个 PWM1_Init，把占空比也在里面设好。',
      look: [
        { q: 'PA0 的复用功能', doc: 'pin-pa0', a: 'PA0 的默认复用功能里有 <b>TIM2_CH1_ETR</b>（还有 TIM5_CH1）。用 TIM2 通道 1，不用重映射。' },
        { q: 'TIM2 时钟使能位', doc: 'reg-apb1-t2', a: 'RCC_APB1ENR 的 <b>TIM2EN</b>（位 0）。PA0 还要开 GPIOA 的时钟。' },
        { q: '2 kHz 与 25%', doc: 'reg-psc', a: '计数 1 MHz（PSC = 71）时，2 kHz 一圈 = 500 个数：<b>ARR = 499</b>；25% 有效：<b>CCR1 = 125</b>。' },
        { q: '通道 1 的模式与极性', doc: 'reg-ccmr1-c1', a: '通道 1 在 CCMR1 的低 8 位：<b>OC1M = 110</b>；CCER 的 <b>CC1E</b>、<b>CC1P</b>。' }
      ],
      editors: [
        { key: 'PWM1_Init', file: 'tim.c', head: 'void PWM1_Init(void)\n{', tail: '}', rows: 12, label: 'PWM1_Init 的函数体' }
      ],
      ref: 'void PWM1_Init(void)\n{\n    RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;                   // ① 开 TIM2 的时钟\n    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;                   // ① 开 GPIOA 的时钟\n    GPIOA->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0);      // ② PA0：先清掉\n    GPIOA->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_CNF0_1);     //    复用推挽 50 MHz\n    TIM2->PSC = 72 - 1;                                   // ③ 1 MHz\n    TIM2->ARR = 500 - 1;                                  // ③ 500 个数 = 2 kHz\n    TIM2->CCR1 = 125;                                     // ③ 25%\n    TIM2->CCMR1 = TIM_CCMR1_OC1M_2 | TIM_CCMR1_OC1M_1 | TIM_CCMR1_OC1PE;   // ③ PWM 模式 1\n    TIM2->CCER = TIM_CCER_CC1E | TIM_CCER_CC1P;           // ③ 打开通道 1，低电平有效\n    TIM2->EGR = TIM_EGR_UG;                               // ④ 装载\n    TIM2->CR1 |= TIM_CR1_CEN;                             // ④ 开始计数\n}'
    }
  };
  /* ===================== 结构图（硬件原理） =====================
     自绘的「讲解图」：一个外设拆成几块，每块讲一个知识点，并标出这一块要初始化的寄存器。
     图上：开关 = 使能位（置 1），方框 = 寄存器（写一个值），闪电 = 事件，红框 = 标志位。
     regs：s = 初始化框架的哪一步（1 开时钟 / 2 配引脚 / 3 配外设 / 4 使能 / 0 用），id = 寄存器（找位图、找所在的块），
           n = 图上和卡片里的写法，f = 位域（多个用逗号），v = 写的值，why = 一句话原因。
     variants：同一张图，按任务换数值；none = 这一种外设根本没有的块，idle = 这个任务用不到的块。 */
  CH.gpio.map = {
    title: 'GPIO 端口位结构图',
    basis: '依据 RM0008「I/O 端口位的基本结构」（中文版 8.1 / 英文版 9.1）和开发板原理图第 8 页重画，只保留讲解用到的部分。',
    variants: [
      { id: 'led', label: 'PA0 · LED1 输出', pin: 'PA0', port: 'A', bit: 0, idle: ['in'] },
      { id: 'key', label: 'PF8 · KEY1 输入', pin: 'PF8', port: 'F', bit: 8, idle: ['out'] }
    ],
    zones: [
      { id: 'clk', name: '时钟', color: 'slate',
        lead: 'GPIOA~GPIOG 都挂在 APB2 上。RCC_APB2ENR 里一个端口一位，打开以后这个端口的寄存器才能读写。',
        regs: {
          led: [{ s: 1, id: 'RCC_APB2ENR', n: 'APB2ENR.IOPAEN', f: 'IOPAEN', v: '1', why: '开 GPIOA 的时钟', doc: 'reg-apb2' }],
          key: [{ s: 1, id: 'RCC_APB2ENR', n: 'APB2ENR.IOPFEN', f: 'IOPFEN', v: '1', why: '开 GPIOF 的时钟', doc: 'reg-apb2-f' }]
        },
        points: ['时钟不开，往 GPIO 写什么都没反应，读 IDR 也一直是 0。', '一个端口 16 个脚共用这一位：PA0、PA1、PA8 只需要开一次 IOPAEN。'] },
      { id: 'cfg', name: '端口配置', color: 'violet',
        lead: '每个脚在 CRL / CRH 里占 4 位：MODE 选输入还是输出（输出时还选最高速度），CNF 选具体接哪种电路。PA0~PA7 在 CRL，PA8~PA15 在 CRH。',
        regs: {
          led: [{ s: 2, id: 'GPIO_CRL', n: 'CRL.MODE0', f: 'MODE0', v: '11', why: '输出，最高 50 MHz', doc: 'reg-crl' }, { s: 2, id: 'GPIO_CRL', n: 'CRL.CNF0', f: 'CNF0', v: '00', why: '通用推挽', doc: 'reg-crl' }],
          key: [{ s: 2, id: 'GPIO_CRH', n: 'CRH.MODE8', f: 'MODE8', v: '00', why: '输入', doc: 'reg-crh-key' }, { s: 2, id: 'GPIO_CRH', n: 'CRH.CNF8', f: 'CNF8', v: '10', why: '上拉 / 下拉输入', doc: 'reg-crh-key' }]
        },
        points: ['复位值是 0100（浮空输入）。先用 &= ~(CNF | MODE) 把 4 位清掉，再用 |= 置需要的位。', '输出模式下输入通路照样接着：读 IDR 能读到引脚上的实际电平。'],
        mini: 'modes' },
      { id: 'out', name: '输出驱动', color: 'blue',
        lead: '写 ODR（或者用 BSRR 只改其中几位）→ 输出控制 → 两个 MOS 管。推挽：1 时 P-MOS 导通，引脚接 VDD；0 时 N-MOS 导通，引脚接地。开漏只用 N-MOS。',
        regs: {
          led: [{ s: 2, id: 'GPIO_BSRR', n: 'BSRR.BS0', f: 'BS0', v: '1', why: '切成输出之前先输出 1，上电不闪', doc: 'reg-bsrr' },
            { s: 0, id: 'GPIO_BSRR', n: 'BSRR.BR0', f: 'BR0', v: '1', why: '输出 0：灯亮', doc: 'reg-bsrr' },
            { s: 0, id: 'GPIO_BSRR', n: 'BSRR.BS0', f: 'BS0', v: '1', why: '输出 1：灯灭', doc: 'reg-bsrr' }],
          key: []
        },
        points: ['BSRR 低 16 位写 1 置 1、高 16 位写 1 清 0，只动写了 1 的那几位，不用先读出来。ODR ^= 要先读、再改、再写回。', '复位后 ODR = 0：先切成输出再写 1 的话，切过去那一刻 LED 会闪一下。'],
        mini: 'drive' },
      { id: 'in', name: '输入', color: 'green',
        lead: '引脚上的电平经过施密特触发器整形，存进 IDR。上拉 / 下拉输入时，内部有一个约 40 kΩ 的电阻接到 VDD 或 VSS，接哪边由 ODR 这一位决定。',
        regs: {
          led: [],
          key: [{ s: 2, id: 'GPIO_BSRR', n: 'BSRR.BS8', f: 'BS8', v: '1', why: 'ODR8 = 1：选上拉', doc: 'reg-bsrr-key' },
            { s: 0, id: 'GPIO_IDR', n: 'IDR.IDR8', f: 'IDR8', v: '读', why: '读到 0 = 按下', doc: 'reg-idr' }]
        },
        points: ['原理图上 KEY1 没有外部上拉：松开时引脚悬空，读到的是随机值，所以要用内部上拉。', '模拟输入（CNF = 00、MODE = 00）时施密特触发器关闭，引脚直接给 ADC 用。'] },
      { id: 'pin', name: '引脚与外部电路', color: 'amber',
        lead: { led: 'LED1：3V3 → 2 kΩ → LED → PA0。PA0 输出 0 时 LED 两端有压差，电流流进引脚，灯亮；输出 1 时两端都是 3.3 V，灯灭。', key: 'KEY1：PF8 → 按键 → GND。按下时引脚接地，读到 0；松开时靠内部上拉，读到 1。' },
        regs: { led: [], key: [] },
        points: ['引脚旁的两个保护二极管把电压钳在 VSS ~ VDD 附近；标 FT 的引脚能承受 5 V。', '这一块不用写寄存器，决定的是「写 0 还是写 1 才是亮」「按下读到几」。'] }
    ]
  };

  CH.tim.map = {
    title: '定时器结构图',
    basis: '依据 RM0008「通用定时器框图」（中文版 14.2 / 英文版 15.2）、「基本定时器框图」和时钟树重画，只保留这一章用到的部分。',
    variants: [
      { id: 'pwm', label: 'TIM5 通道 2 · PWM', tim: 5, fn: 'PWM_Init', idle: ['irq'] },
      { id: 'tick', label: 'TIM6 · 1 ms 中断', tim: 6, fn: 'Tick_Init', none: ['oc', 'pin'] }
    ],
    zones: [
      { id: 'clk', name: '时钟', color: 'slate',
        lead: 'TIM2~TIM7 挂在 APB1。APB1 只有 36 MHz，但它的分频系数不是 1 时，送给定时器的那一路会再 ×2，所以定时器拿到的是 72 MHz。',
        regs: {
          pwm: [{ s: 1, id: 'RCC_APB1ENR', n: 'APB1ENR.TIM5EN', f: 'TIM5EN', v: '1', why: '开 TIM5 的时钟', doc: 'reg-apb1' }],
          tick: [{ s: 1, id: 'RCC_APB1ENR', n: 'APB1ENR.TIM6EN', f: 'TIM6EN', v: '1', why: '开 TIM6 的时钟', doc: 'reg-apb1' }]
        },
        points: ['时钟不开，往定时器寄存器里写什么都没反应。', 'TIM1、TIM8 挂在 APB2，使能位在 APB2ENR。'] },
      { id: 'tb', name: '时基单元', color: 'blue',
        lead: 'PSC 把 72 MHz 分频，CNT 每来一个脉冲加 1；数到 ARR 以后回到 0，同时产生一次更新事件。',
        formula: ['计数频率 = 72 MHz ÷ (PSC + 1)', '一圈 = ARR + 1 个数'],
        regs: {
          pwm: [{ s: 3, id: 'TIM_PSC', n: 'PSC', f: 'PSC', v: '71', why: '1 MHz：1 µs 数一个', doc: 'reg-psc' },
            { s: 3, id: 'TIM_ARR', n: 'ARR', f: 'ARR', v: '999', why: '1000 个数一圈 = 1 ms，PWM 1 kHz', doc: 'reg-arr' },
            { s: 3, id: 'TIM_CR1', n: 'CR1.ARPE', f: 'ARPE', v: '1', why: '改 ARR 时等这一圈数完再生效', doc: 'reg-cr1' },
            { s: 3, id: 'TIM_EGR', n: 'EGR.UG', f: 'UG', v: '1', why: '立刻装载 PSC、ARR、CCR2', doc: 'reg-egr' },
            { s: 4, id: 'TIM_CR1', n: 'CR1.CEN', f: 'CEN', v: '1', why: '开始计数', doc: 'reg-cr1' }],
          tick: [{ s: 3, id: 'TIM_PSC', n: 'PSC', f: 'PSC', v: '71', why: '1 MHz：1 µs 数一个', doc: 'reg-psc' },
            { s: 3, id: 'TIM_ARR', n: 'ARR', f: 'ARR', v: '999', why: '1000 个数 = 1 ms 溢出一次', doc: 'reg-arr' },
            { s: 3, id: 'TIM_EGR', n: 'EGR.UG', f: 'UG', v: '1', why: '立刻装载 PSC、ARR', doc: 'reg-egr' },
            { s: 4, id: 'TIM_CR1', n: 'CR1.CEN', f: 'CEN', v: '1', why: '开始计数', doc: 'reg-cr1' }]
        },
        points: ['<b>影子寄存器</b>：PSC、ARR 写进去先放在预装载寄存器里，等到更新事件才搬进真正干活的那一份。初始化时写一次 UG，让它们马上生效。', 'UG 产生的更新事件也会把 UIF 置 1：要开更新中断的话，先把它清掉（见「中断」）。'],
        mini: 'saw' },
      { id: 'oc', name: '输出比较', color: 'violet',
        lead: '每个通道把 CNT 和自己的 CCR 比较。PWM 模式 1：CNT < CCR 时参考信号 OC2REF 有效，否则无效；再经过极性选择和输出使能送到引脚。',
        formula: ['占空比 = CCR2 ÷ (ARR + 1)', 'ARR = 999 时，CCR2 就是千分比'],
        regs: {
          pwm: [{ s: 3, id: 'TIM_CCR2', n: 'CCR2', f: 'CCR2', v: '0', why: '先灭；以后由 PWM_SetDuty 改', doc: 'reg-ccr2' },
            { s: 3, id: 'TIM_CCMR1', n: 'CCMR1.OC2M', f: 'OC2M', v: '110', why: 'PWM 模式 1', doc: 'reg-ccmr1' },
            { s: 3, id: 'TIM_CCMR1', n: 'CCMR1.OC2PE', f: 'OC2PE', v: '1', why: 'CCR2 预装载：新值从下一圈开始用', doc: 'reg-ccmr1' },
            { s: 3, id: 'TIM_CCER', n: 'CCER.CC2P', f: 'CC2P', v: '1', why: '有效 = 低电平（LED2 低电平亮）', doc: 'reg-ccer' },
            { s: 3, id: 'TIM_CCER', n: 'CCER.CC2E', f: 'CC2E', v: '1', why: '打开通道 2 的输出', doc: 'reg-ccer' },
            { s: 0, id: 'TIM_CCR2', n: 'CCR2', f: 'CCR2', v: '0~1000', why: '调亮度', doc: 'reg-ccr2' }],
          tick: []
        },
        points: ['一个定时器 4 个通道共用同一个 CNT：频率一样，占空比各自由 CCR1~CCR4 决定。', 'CC2P 只决定「有效」是高还是低。设成低有效以后，CCR 越大，LED 亮的时间越长。'],
        mini: 'pwm', noneText: '基本定时器 TIM6、TIM7 没有输出通道，只有时基单元和更新中断。' },
      { id: 'pin', name: '引脚', color: 'green',
        lead: 'PA1 的默认复用功能里有 TIM5_CH2。配成复用推挽，输出控制改由定时器驱动，不再听 ODR。',
        regs: {
          pwm: [{ s: 1, id: 'RCC_APB2ENR', n: 'APB2ENR.IOPAEN', f: 'IOPAEN', v: '1', why: 'PA1 在 GPIOA', doc: 'reg-apb2' },
            { s: 2, id: 'GPIO_CRL', n: 'CRL.MODE1', f: 'MODE1', v: '11', why: '输出，最高 50 MHz', doc: 'reg-crl-pa1' },
            { s: 2, id: 'GPIO_CRL', n: 'CRL.CNF1', f: 'CNF1', v: '10', why: '复用推挽', doc: 'reg-crl-pa1' }],
          tick: []
        },
        points: ['配成普通推挽（CNF = 00）的话，PA1 只听 ODR，定时器的波形出不来。', '哪个脚能接哪个通道，查数据手册的引脚定义表；默认位置不合适时再用 AFIO 重映射。'],
        noneText: '基本定时器没有输出通道，也就不占引脚。' },
      { id: 'irq', name: '中断', color: 'red',
        lead: '更新事件把 SR 的 UIF 置 1。DIER 的 UIE 打开时，请求送到 NVIC；NVIC 里也打开，CPU 才会跳去执行中断函数。',
        regs: {
          pwm: [],
          tick: [{ s: 3, id: 'TIM_SR', n: 'SR.UIF', f: 'UIF', v: '0', why: '清掉 UG 顺带置起的 UIF，免得一开中断就进去一次', doc: 'reg-sr' },
            { s: 4, id: 'TIM_DIER', n: 'DIER.UIE', f: 'UIE', v: '1', why: '允许更新中断', doc: 'reg-dier' },
            { s: 4, id: 'NVIC_ISER', n: 'NVIC_EnableIRQ(TIM6_IRQn)', f: 'SETENA', v: '', why: 'NVIC 打开 TIM6 这一路' },
            { s: 0, id: 'TIM_SR', n: 'SR.UIF', f: 'UIF', v: '0', why: '中断函数里先判断，再写 0 清除', doc: 'reg-sr' }]
        },
        points: ['标志位 → 使能开关 → 或门 → NVIC：所有外设的中断都是这样接的。同一个定时器的几个中断共用一个中断函数，所以函数里要先判断是哪个标志。', '标志位要软件清（写 0）。不清的话，一退出中断马上又进来。'],
        idleText: '这个任务不用中断：PWM 是定时器自己输出的，不需要 CPU 参与。' }
    ]
  };
  // 没在 regs 里出现的寄存器（比如 PA8 的 CRH）按所属的块归类
  CH.gpio.map.fam = { RCC_APB2ENR: 'clk', GPIO_CRL: 'cfg', GPIO_CRH: 'cfg', GPIO_ODR: 'out', GPIO_BSRR: 'out', GPIO_BRR: 'out', GPIO_IDR: 'in' };
  CH.tim.map.fam = { RCC_APB1ENR: 'clk', TIM_PSC: 'tb', TIM_ARR: 'tb', TIM_CNT: 'tb', TIM_EGR: 'tb', TIM_CR1: 'tb', TIM_CCR1: 'oc', TIM_CCR2: 'oc', TIM_CCR3: 'oc', TIM_CCR4: 'oc', TIM_CCMR1: 'oc', TIM_CCMR2: 'oc', TIM_CCER: 'oc', RCC_APB2ENR: 'pin', GPIO_CRL: 'pin', TIM_DIER: 'irq', TIM_SR: 'irq', NVIC_ISER: 'irq' };
  // 这个寄存器（资料面板里的一份）在结构图的哪一块；vr 是哪种用法（TIM6 → 节拍，PF 口 → 按键）
  function zoneOf(ch, d) {
    var M = ch.map; if (!M || !d || d.kind !== 'reg') return null;
    var vr = M.variants[0].id;
    if (ch.id === 'tim' && (d.tim === 6 || d.tim === 7 || /^TIM_(SR|DIER)$/.test(d.id) || d.id === 'NVIC_ISER' || ((d.f || []).length && d.f.every(function (f) { return /^TIM[67]EN$/.test(f); })))) vr = 'tick';
    if (ch.id === 'gpio' && (d.port === 'F' || d.id === 'GPIO_IDR')) vr = 'key';
    var best = null;
    M.zones.forEach(function (z) {
      ((z.regs || {})[vr] || []).forEach(function (r) {
        if (r.id !== d.id) return;
        var hit = (d.f || []).some(function (f) { return String(r.f).split(',').indexOf(f) >= 0; });
        if (!best || (hit && !best.hit)) best = { z: z.id, hit: hit };
      });
    });
    var z = best ? best.z : (M.fam || {})[d.id];
    return z ? { z: z, vr: vr } : null;
  }
  var ORDER = ['gpio', 'tim'];


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
    var c = parseFile(file(ch, ch.cfile)), m = parseFile(file(ch, 'main.c'));
    var fns = c.fns, hdr = file(ch, ch.hfile).map(function (l) { return l[0]; }).filter(function (x) { return /^#define\s+\w+\s+\S/.test(x.trim()); });
    Object.keys(override || {}).forEach(function (k) {
      var body = joinElse(String(override[k]).split('\n').filter(function (x) { return x.trim(); })).map(function (x) { return { c: x }; });
      fns[k] = { sig: fns[k] ? fns[k].sig : 'void ' + k + '(void)', lines: body, src: body.map(function (_, i) { return i; }), mine: true };
    });
    if (m.fns.main) fns.main = m.fns.main;
    return { fns: fns, globals: hdr.concat(c.globals) };
  }

  /* ===================== 跑一遍，记下每一行之前的状态 ===================== */
  function mode(c) { if (c.mode === 0) return c.cnf === 0 ? 'an' : 'in'; return ['pp', 'od', 'afpp', 'afod'][c.cnf]; }
  var TIMBIT = { 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5 };   // RCC_APB1ENR 里的位
  function snap(ch, M, extra) {
    var g = M.gpio[ch.port], o = { t: M.t, apb1: M.rcc.APB1ENR >>> 0, apb2: M.rcc.APB2ENR >>> 0, clk: !!(M.rcc[ch.clk.reg] & (1 << ch.clk.bit)), crl: g.CRLv >>> 0, crh: g.CRHv >>> 0, odr: g.ODRv >>> 0, pins: {} };
    ch.pins.forEach(function (p) { var c = M.pinCfg(p.key), lv = M.level(p.key); o.pins[p.key] = { mode: mode(c), odr: c.odr, level: lv === 'Z' ? 'z' : lv }; });
    if (ch.tims) {
      o.tim = {}; o.nvic = {}; o.irqs = extra ? extra.irqs : 0;
      ch.tims.forEach(function (d) {
        var tm = M.tim[d.n]; if (!tm) return;
        o.tim[d.n] = { CR1: tm.CR1, DIER: tm.DIER, SR: tm.SR, PSC: tm.PSC, ARR: tm.ARR, CCR: tm.CCR.slice(), CCMR1: tm.CCMR1, CCER: tm.CCER, clk: !!(M.rcc.APB1ENR & (1 << TIMBIT[d.n])) };
        if (d.irq) o.nvic[d.irq] = !!M.irqEnabled[d.irq];
      });
    }
    return o;
  }
  // chip：{ fn: 只看这个函数的行, main: main 里依次调用的语句（没给就用 main.c）, ms, until, skip: 跳过前几次调用 }
  function trace(ch, chip, override) {
    var S = Sim(), prog = program(ch, override), snaps = [], err = null;
    if (chip.patch) prog.globals = chip.patch(prog.globals);
    if (chip.main) prog.fns.main = { sig: 'int main(void)', lines: chip.main.map(function (c) { return { c: c }; }), src: chip.main.map(function (_, i) { return i; }) };
    if (chip.file === 'single') prog.fns.main = parseFile(ch.single).fns.main;
    var isr = (ch.tims || []).map(function (d) { return d.isr; }).filter(Boolean), ex = { irqs: 0 };
    var r = S.run({ fns: prog.fns, globals: prog.globals }, { ms: chip.ms || 30, onLine: function (f, i, M) { if (i === 0 && isr.indexOf(f) >= 0) ex.irqs++; snaps.push({ f: f, i: i, s: snap(ch, M, ex) }); } });
    if (r.stop.kind === 'error') err = r.stop.text;
    snaps.push({ f: '__end', i: -1, s: snap(ch, r.machine, ex) });
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
    (ch.tims || []).forEach(function (d) { if (!a.tim[d.n].clk && b.tim[d.n].clk) ev.parts.push({ t: 'clk', what: 'TIM' + d.n, bus: 'APB1' }); });
    if (!a.clk && b.clk) ev.parts.push({ t: 'clk', what: 'GPIO' + ch.port, bus: 'APB2' });
    if (ch.tims) {
      var m = /\bTIM(\d+)->(\w+)\s*(\|=|&=|\^=|=(?!=))?/.exec(text);
      if (m && b.tim[+m[1]]) ev.parts.push({ t: m[3] ? 'treg' : 'tread', tim: +m[1], reg: m[2], lost: !b.tim[+m[1]].clk });
      else ch.tims.forEach(function (d) {   // 函数调用里改了寄存器（比如 main 里的 PWM_SetDuty）
        var x = a.tim[d.n], y = b.tim[d.n];
        ['PSC', 'ARR', 'CCMR1', 'CCER', 'DIER'].forEach(function (r) { if (x[r] !== y[r]) ev.parts.push({ t: 'treg', tim: d.n, reg: r }); });
        for (var k = 1; k <= 4; k++) if (x.CCR[k] !== y.CCR[k]) ev.parts.push({ t: 'treg', tim: d.n, reg: 'CCR' + k });
        if ((x.CR1 & 1) !== (y.CR1 & 1)) ev.parts.push({ t: 'treg', tim: d.n, reg: 'CR1' });
      });
      ch.tims.forEach(function (d) { if (d.irq && !a.nvic[d.irq] && b.nvic[d.irq]) ev.parts.push({ t: 'nvic', irq: d.irq, tim: d.n }); });
    }
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
  function body(ch, name) { var p = parseFile(file(ch, ch.cfile)).fns[name]; return p ? p.lines.map(function (l) { return l.c; }).join('\n') : ''; }
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
    if (/APB1ENR/.test(t)) { f = grab(/RCC_APB1ENR_(\w+)()/g); return { kind: 'reg', id: 'RCC_APB1ENR', f: f, val: state ? state.apb1 : null }; }
    if ((rx = /NVIC_EnableIRQ\s*\(\s*TIM(\d+)_IRQn/.exec(t))) { var irq = { 2: 28, 3: 29, 4: 30, 5: 50, 6: 54, 7: 55 }[rx[1]]; return { kind: 'reg', id: 'NVIC_ISER', f: ['SETENA'], val: (1 << (irq & 31)) >>> 0, write: true, note: 'TIM' + rx[1] + ' 的中断号是 ' + irq + '：在 ISER' + (irq >> 5) + ' 的第 ' + (irq & 31) + ' 位。NVIC 在 Cortex-M3 内核里，寄存器见 PM0056 编程手册。' }; }
    if ((rx = /\bTIM(\d+)->\s*(\w+)/.exec(t))) {
      var tn = +rx[1], R = rx[2], ts = state && state.tim && state.tim[tn], v = null;
      f = grab(new RegExp('TIM_' + R.replace(/\d+$/, '\\d') + '_(\\w+?)(?:_\\d)?\\b()', 'g'));
      if (/^CCR\d$/.test(R)) { f = [R]; v = ts ? ts.CCR[+R.slice(3)] : null; }
      else if (R === 'PSC' || R === 'ARR') { f = [R]; v = ts ? ts[R] : null; }
      else if (R === 'SR') { f = ['UIF']; v = ts ? ts.SR : null; }
      else if (R === 'EGR') { f = ['UG']; v = 1; }
      else if (ts && ts[R] != null) v = ts[R];
      var id = 'TIM_' + R.replace(/^CCR(\d)$/, 'CCR$1');
      var d = { kind: 'reg', id: id, f: f, val: v, write: R === 'EGR', tim: tn };
      if (tn === 6 || tn === 7) d.note = 'TIM' + tn + ' 是基本定时器，参考手册里它的寄存器在「基本定时器」一章，这几位的位置相同。';
      return d;
    }
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

  /* ===================== 定时器：检查 ===================== */
  // 一段时间里某个脚的波形：周期（µs）、低电平占比
  function measure(tr, t0, t1) {
    var pts = (tr || []).filter(function (e) { return e[0] > t0 && e[0] < t1; }), v0 = levelAt(tr, t0), low = 0, last = t0, cur = v0, falls = [];
    pts.forEach(function (e) { if (cur === 0) low += e[0] - last; if (cur !== 0 && e[1] === 0) falls.push(e[0]); last = e[0]; cur = e[1]; });
    if (cur === 0) low += t1 - last;
    var per = []; for (var i = 1; i < falls.length; i++) per.push(falls[i] - falls[i - 1]); per.sort(function (a, b) { return a - b; });
    return { period: per.length ? per[per.length >> 1] : 0, low: low / (t1 - t0), z: v0 === 'Z' && !pts.length, edges: pts.length };
  }
  function runWith(ch, over, mainLines, ms, extra) {
    var S = Sim(), prog = program(ch, over), cnt = { irqs: 0 };
    prog.fns.main = { sig: 'int main(void)', lines: mainLines.map(function (c) { return { c: c }; }) };
    var isr = (ch.tims || []).map(function (d) { return d.isr; }).filter(Boolean);
    var r = S.run({ fns: prog.fns, globals: prog.globals }, { ms: ms, board: extra, onLine: function (f, i) { if (i === 0 && isr.indexOf(f) >= 0) cnt.irqs++; } });
    r.irqs = cnt.irqs; return r;
  }
  function syntaxErr(r) { return r.stop.kind === 'error' ? [{ k: 'err', id: 'syntax', msg: '这段代码模拟器看不懂：' + r.stop.text + '。检查一下括号、分号和宏名的拼写。' }] : null; }
  var PIN_HINT = function (pin, n, chn) {
    return ['定时器的输出要「接管」这个脚，引脚该配成什么模式？', '复用推挽输出：CNF' + n + ' = 10、MODE' + n + ' = 11。通用推挽只听 ODR，定时器的输出到不了引脚。',
      'GPIOA->CRL &= ~(GPIO_CRL_CNF' + n + ' | GPIO_CRL_MODE' + n + ');\nGPIOA->CRL |= (GPIO_CRL_MODE' + n + ' | GPIO_CRL_CNF' + n + '_1);'];
  };
  // 通用的 PWM 检查：timer n、通道 k、引脚 pin（PAx），期望周期 per（µs）和低电平占比 duty
  function pwmCheck(r, o) {
    var M = r.machine, tm = M.tim[o.n], pn = Number(o.pin.slice(2)), out = [], k = o.k, T = 'TIM' + o.n;
    if (!(M.rcc.APB1ENR & (1 << TIMBIT[o.n]))) return [{ k: 'err', id: 'clkT', doc: o.docClk, msg: T + ' 没有开时钟，后面写它的寄存器都没生效。',
      hints: [T + ' 挂在哪条总线上？', 'TIM2~7 在 APB1：RCC_APB1ENR 的 ' + T + 'EN。', 'RCC->APB1ENR |= RCC_APB1ENR_' + T + 'EN;'] }];
    if (!(M.rcc.APB2ENR & 4)) out.push({ k: 'err', id: 'clkA', doc: 'reg-apb2', msg: 'GPIOA 没有开时钟，' + o.pin + ' 的配置没生效。',
      hints: [o.pin + ' 在哪个端口？', 'GPIOA 在 APB2：RCC_APB2ENR 的 IOPAEN。', 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;'] });
    var c = M.pinCfg(o.pin);
    if (!out.length && (c.mode === 0 || c.cnf < 2)) out.push({ k: 'err', id: 'pin', doc: o.docPin, msg: o.pin + (c.mode === 0 ? ' 还是输入。' : ' 是通用输出：引脚只听 ODR，定时器的输出到不了这个脚。'), hints: PIN_HINT(o.pin, pn, k) });
    var m = ((k <= 2 ? tm.CCMR1 : tm.CCMR2) >> (((k - 1) & 1) * 8 + 4)) & 7;
    if (m !== 6 && m !== 7) out.push({ k: 'err', id: 'ocm', doc: o.docMode, msg: '通道 ' + k + ' 不是 PWM 模式（OC' + k + 'M = ' + m.toString(2).padStart(3, '0') + '）。',
      hints: ['CNT 和 CCR 比较以后，输出按什么规则变？', 'PWM 模式 1 是 OC' + k + 'M = 110：OC' + k + 'M_2 和 OC' + k + 'M_1 置 1。', T + '->CCMR1 = TIM_CCMR1_OC' + k + 'M_2 | TIM_CCMR1_OC' + k + 'M_1 | TIM_CCMR1_OC' + k + 'PE;'] });
    if (!((tm.CCER >> ((k - 1) * 4)) & 1)) out.push({ k: 'err', id: 'cce', doc: o.docCcer, msg: '通道 ' + k + ' 的输出没打开（CC' + k + 'E = 0），波形出不去。',
      hints: ['比较的结果要经过一个开关才能送到引脚。', 'CCER 的 CC' + k + 'E 置 1。', T + '->CCER = TIM_CCER_CC' + k + 'E | TIM_CCER_CC' + k + 'P;'] });
    if (!(tm.CR1 & 1)) out.push({ k: 'err', id: 'cen', doc: 'reg-cr1', msg: T + ' 没有开始计数（CEN = 0）。',
      hints: ['都配好以后，还差哪一个总开关？', 'CR1 的 CEN 置 1。', T + '->CR1 |= TIM_CR1_CEN;'] });
    if (out.length) return out;
    var w = measure(r.trace[o.pin], o.t0, o.t1), hz = w.period ? Math.round(1e6 / w.period) : 0;
    if (!w.period) return [{ k: 'err', id: 'flat', doc: o.docPsc, msg: o.pin + ' 上一直是' + (w.low > 0.5 ? '低' : '高') + '电平，没有波形。占空比是 0 或 100%？', hints: ['CCR 和 ARR 是多少？', 'CCR 要在 0 和 ARR + 1 之间才有方波。', o.ref] }];
    if (Math.abs(w.period - o.per) > o.per * 0.03) out.push({ k: 'err', id: 'freq', doc: o.docPsc, msg: 'PWM 周期是 ' + Math.round(w.period) + ' µs（约 ' + hz + ' Hz），要求 ' + Math.round(1e6 / o.per) + ' Hz。',
      hints: ['周期由哪两个寄存器决定？', '周期 = (PSC + 1) × (ARR + 1) ÷ 72 MHz。PSC = 71 时 1 µs 一个数，一圈要 ' + o.per + ' 个数。', T + '->PSC = 72 - 1;\n' + T + '->ARR = ' + o.per + ' - 1;'] });
    if (out.length) return out;
    var want = o.duty, got = Math.round(w.low * 100);
    if (Math.abs(w.low - want) > 0.03) {
      if (Math.abs(w.low - (1 - want)) < 0.03) out.push({ k: 'err', id: 'pol', doc: o.docCcer, msg: '反了：要求亮 ' + Math.round(want * 100) + '% 的时间，现在亮 ' + got + '%。',
        hints: ['LED 是低电平亮。「有效」现在对应的是高还是低？', 'CC' + k + 'P = 1 让有效 = 低电平（或者用 PWM 模式 2）。', T + '->CCER = TIM_CCER_CC' + k + 'E | TIM_CCER_CC' + k + 'P;'] });
      else out.push({ k: 'err', id: 'duty', doc: 'reg-ccr2', msg: '亮的时间占 ' + got + '%，要求 ' + Math.round(want * 100) + '%。',
        hints: ['亮多久由哪个寄存器决定？', '占空比 = CCR ÷ (ARR + 1)。', o.dutyRef] });
    }
    return out;
  }
  function checkPwm(ch, src) {
    var r = runWith(ch, { PWM_Init: src }, ['PWM_Init();', 'Delay_ms(4);', 'TIM5->CCR2 = 250;', 'Delay_ms(16);'], 21), e = syntaxErr(r); if (e) return e;
    var out = pwmCheck(r, { n: 5, k: 2, pin: 'PA1', per: 1000, duty: 0.25, t0: 8000, t1: 20000, docClk: 'reg-apb1', docPin: 'reg-crl-pa1', docMode: 'reg-ccmr1', docCcer: 'reg-ccer', docPsc: 'reg-psc',
      ref: 'TIM5->CCR2 = 0;', dutyRef: 'TIM5->CCR2 = 0;   // 先灭；PWM_SetDuty 里再改' });
    if (!out.length) {
      var w0 = measure(r.trace.PA1, 200, 3900);
      if (w0.low > 0.02) out.push({ k: 'warn', id: 'init', doc: 'reg-ccr2', msg: '初始化完 LED2 就亮了（亮 ' + Math.round(w0.low * 100) + '% 的时间）：要求先灭。', hints: ['初始化时 CCR2 写的是多少？', '先灭：CCR2 = 0。', 'TIM5->CCR2 = 0;'] });
    }
    if (!out.length) out.push({ k: 'ok', msg: '全对：TIM5 和 GPIOA 的时钟开了，PA1 复用推挽，1 kHz、PWM 模式 1、低电平有效。CCR2 = 250 时 LED2 亮 25% 的时间。' });
    return out;
  }
  function checkTick(ch, src) {
    var r = runWith(ch, { Tick_Init: src }, ['Tick_Init();', 'Delay_ms(50);'], 51), e = syntaxErr(r); if (e) return e;
    var M = r.machine, tm = M.tim[6], n = r.irqs, out = [];
    if (!(M.rcc.APB1ENR & (1 << 4))) return [{ k: 'err', id: 'clkT', doc: 'reg-apb1', msg: 'TIM6 没有开时钟，后面写它的寄存器都没生效。', hints: ['TIM6 挂在哪条总线上？', 'APB1：RCC_APB1ENR 的 TIM6EN（位 4）。', 'RCC->APB1ENR |= RCC_APB1ENR_TIM6EN;'] }];
    if (!n) {
      if (!(tm.CR1 & 1)) out.push({ k: 'err', id: 'cen', doc: 'reg-cr1', msg: 'TIM6 没有开始计数（CEN = 0），一次中断都没有。', hints: ['都配好以后，还差哪一个总开关？', 'CR1 的 CEN 置 1。', 'TIM6->CR1 |= TIM_CR1_CEN;'] });
      if (!(tm.DIER & 1)) out.push({ k: 'err', id: 'uie', doc: 'reg-dier', msg: '没有打开更新中断（UIE = 0）：UIF 置 1 了，但不会去打断 CPU。', hints: ['溢出以后，什么东西决定要不要发中断请求？', 'DIER 的 UIE 置 1。', 'TIM6->DIER |= TIM_DIER_UIE;'] });
      if (!M.irqEnabled[54]) out.push({ k: 'err', id: 'nvic', doc: 'reg-dier', msg: 'NVIC 里没有打开 TIM6 中断：请求到了 NVIC 就被挡住了。', hints: ['定时器发出请求以后，还要经过谁才能打断 CPU？', 'NVIC_EnableIRQ 打开这一路中断。', 'NVIC_EnableIRQ(TIM6_IRQn);'] });
      if (!out.length) out.push({ k: 'err', id: 'none', doc: 'reg-psc', msg: '50 ms 里一次中断都没进。', hints: ['PSC、ARR 是多少？', '1 MHz 计数、数 1000 个数一圈：PSC = 71，ARR = 999。', 'TIM6->PSC = 72 - 1;\nTIM6->ARR = 1000 - 1;'] });
      return out;
    }
    if (n < 48 || n > 52) return [{ k: 'err', id: 'rate', doc: 'reg-psc', msg: '50 ms 里进了 ' + n + ' 次中断，应该是 50 次（每 1 ms 一次）。',
      hints: ['中断的间隔由哪两个寄存器决定？', '间隔 = (PSC + 1) × (ARR + 1) ÷ 72 MHz。1 ms 可以是 PSC = 71、ARR = 999。别忘了写 UG，PSC 才会立刻生效。', 'TIM6->PSC = 72 - 1;\nTIM6->ARR = 1000 - 1;\nTIM6->EGR = TIM_EGR_UG;'] }];
    return [{ k: 'ok', msg: '全对：50 ms 里进了 ' + n + ' 次中断，每 1 ms 一次。' }];
  }
  function checkTransferPwm(ch, src) {
    var r = runWith(ch, { PWM1_Init: src }, ['PWM1_Init();', 'Delay_ms(12);'], 13), e = syntaxErr(r); if (e) return e;
    var out = pwmCheck(r, { n: 2, k: 1, pin: 'PA0', per: 500, duty: 0.25, t0: 3000, t1: 12000, docClk: 'reg-apb1-t2', docPin: 'reg-crl-pa0', docMode: 'reg-ccmr1-c1', docCcer: 'reg-ccer-c1', docPsc: 'reg-psc',
      ref: 'TIM2->CCR1 = 125;', dutyRef: 'TIM2->CCR1 = 125;   // 125 ÷ 500 = 25%' });
    if (!out.length) out.push({ k: 'ok', msg: '全对：PA0 上 2 kHz、亮 25% 的时间。还是同一套框架：① 开时钟 → ② 配引脚（复用推挽）→ ③ 配外设（PSC / ARR / CCR / 模式 / 极性）→ ④ 使能。' });
    return out;
  }

  return {
    CH: CH, ORDER: ORDER, FRAME: FRAME, chapter: function (id) { return CH[id] || null; },
    file: file, parseFile: parseFile, joinElse: joinElse, program: program, trace: trace, diff: diff, body: body,
    checkInit: checkInit, checkOnOff: checkOnOff, checkKey: checkKey, checkPwm: checkPwm, checkTick: checkTick, checkTransferPwm: checkTransferPwm, measure: measure, docFor: docFor, zoneOf: zoneOf, levelAt: levelAt
  };
});
