/* derive-exti.js — 「设计原理」EXTI 章：从「主循环忙的时候按键会漏」推到外部中断
   数据结构见 derive-i2c.js 顶部说明；本章用通用单片机模拟器（mcusim.js）：按键可以按、可以抖，EXTI9_5_IRQHandler 会真的被调用。 */
(function () {
  'use strict';
  var D = window.STM32_DERIVE = window.STM32_DERIVE || {};

  D.exti = {
    id: 'exti', topic: 'exti', engine: 'mcu', defaultSc: 'irq',
    title: 'EXTI：主循环在忙，按键怎么才不会漏',
    task: '按一下 KEY1（PF8），LED1 翻转一次；主循环一直在干别的事，按得再快也不能漏。',
    intro: [
      'GPIO 章里读按键的办法是在主循环里一遍遍读 IDR。主循环只干这一件事的时候没问题；可一旦它还要干别的（等串口、算数、Delay），读按键的间隔就变长了，短短一按可能正好落在两次读之间。',
      '这一章从这个问题出发，「发明」出中断：让硬件盯着引脚，一变就把 CPU 叫过来。然后把它落到 STM32 的 EXTI、AFIO 和 NVIC 上，每一个要配的位都会有它存在的理由。'
    ],
    honesty: '说明：下面是「如果让我们自己来设计」的思路重建，不是中断真实的发展史。STM32 的行为按 RM0008（EXTI、AFIO）与 PM0056（NVIC）；接线按开发板原理图（KEY1 接 PF8，按下接地，没有外部上拉）。模拟器里按键的抖动是示意。',

    facts: {
      F1: { t: '中断：硬件盯着事件，事件一来就打断 CPU，跑完处理函数再回到原处接着跑', short: '中断', from: 's2' },
      F2: { t: 'EXTI 第 n 条线只能接各个端口的第 n 号脚，选哪个口在 AFIO_EXTICR 里（要开 AFIO 的时钟）', short: '线和脚', from: 's4' },
      F3: { t: 'RTSR / FTSR 选上升沿 / 下降沿，IMR 打开这条线的中断；边沿来了 PR 置 1', short: '选沿与开关', from: 's5' },
      F4: { t: 'PR 写 1 清除；中断里不清，一返回又会进来', short: '清标志', from: 's6' },
      F5: { t: '线 5~9 共用 EXTI9_5_IRQHandler、线 10~15 共用 EXTI15_10_IRQHandler：进去先看 PR 是哪条线', short: '共用入口', from: 's7' },
      F6: { t: '中断里只做最少的事（记一笔，volatile 变量），处理放到主循环', short: '中断里做什么', from: 's8' }
    },

    stages: [
      { id: 'A', name: '为什么要中断', desc: '轮询会漏、让硬件盯着、盯电平还是盯变化' },
      { id: 'B', name: '落到 STM32 上', desc: 'EXTI 线与 AFIO、选沿与 PR、NVIC 与入口、中断里做什么、配置顺序' },
      { id: 'C', name: '从任务需求推到代码', desc: '事件表 → 一行行代码 → 主循环在忙也不漏' },
      { id: 'D', name: '换个需求，自己再推一遍', desc: '按键抖动：一次按下进好几次中断' }
    ],

    steps: [
    {
      id: 's1', stage: 'A', q: '主循环在忙的时候，按键会不会漏',
      beats: [
        { k: 'need', t: '主循环除了看按键，还要干别的：比如每 200 ms 处理一次传感器数据（这里用 Delay_ms(200) 代替）。我们想做到：按一下 KEY1，LED1 就翻转一次。' },
        { k: 'test', t: 'GPIO 章的写法：每圈读一次 PF8，读到 0（按下）就翻转。现在一圈要 200 ms，可人按一下按键常常只有 100 ms 左右。' },
        { k: 'ask', id: 'e1-a', type: 'choice', predict: true, q: '在 250 ms ~ 350 ms 之间按了一下（100 ms），主循环在 0、200、400 ms 各读一次 PF8。LED1 会翻转吗？',
          opts: [
            { t: '不会：200 ms 读的时候还没按，400 ms 读的时候已经松开了，这一下正好落在两次读之间', ok: true },
            { t: '会：按键按下以后引脚会一直保持低电平', assume: '按下的状态会被记住', counter: '引脚只是一根线，松手后上拉马上把它拉回高电平。没人读的那 100 ms 里发生了什么，事后读 IDR 是看不出来的。', back: 's1' }
          ],
          explain: '对。下面的模拟里按了一下，LED1 一直没动。' },
        { k: 'w', w: 'sim', sc: 'poll', cap: '主循环每 200 ms 读一次 PF8；KEY1 在 250 ~ 350 ms 按了一下。' },
        { k: 'trouble', t: '把 Delay 改短可以缓解，但治标不治本：主循环要干的事越多，读按键的间隔就越长、越不均匀。我们需要一种「不靠 CPU 去问」也能知道引脚变过的办法。' }
      ],
      gist: '轮询（主循环一遍遍去读）只能看到「读的那一刻」的电平。主循环一忙，两次读之间的短按就漏了。',
      next: '能不能让硬件自己盯着引脚，一变就告诉 CPU？',
      refs: [{ t: 'GPIO 章：按键轮询与消抖' }]
    },

    {
      id: 's2', stage: 'A', q: '让硬件盯着，一变就叫 CPU', from: 's1',
      beats: [
        { k: 'idea', t: ['在引脚旁边放一个小电路，专门盯着它：一发现变化，就给 CPU 发一个「请求」。CPU 不管正在干什么，先停下来，跑一段专门的**处理函数**，跑完再回到刚才停下的地方接着干。', '这就是**中断**：被「打断」的是 CPU 正在跑的程序。'] },
        { k: 'ask', id: 'e2-a', type: 'choice', q: '处理函数跑完以后，CPU 怎么知道该回到哪里？',
          opts: [
            { t: '进中断之前，硬件把「下一条要执行的指令的地址」和几个寄存器压到栈里；处理函数一返回，再弹出来接着跑', ok: true },
            { t: '回到 main 的开头重新跑', assume: '中断以后程序从头来', counter: '那主循环每被打断一次就重来一次，前面干到一半的事全丢了。Cortex-M3 进中断时自动保存现场（xPSR、PC、LR、R12、R0~R3），返回时恢复，被打断的程序完全感觉不到。', back: 's2' }
          ],
          explain: '对。这一切是硬件自动做的，所以处理函数看起来就是一个普通的 void 函数。' },
        { k: 'fact', f: 'F1' },
        { k: 'why', t: '取舍：轮询简单，但 CPU 要一直花时间去问，而且问得不够勤就会漏；中断不用问，事件一来就处理，代价是多了一套「怎么叫、叫谁、叫完怎么回来」的机制要配。下面几环就是在配这套机制。' }
      ],
      makes: ['F1'],
      gist: '中断：硬件盯着事件，来了就打断 CPU；CPU 自动保存现场、跑处理函数、再恢复现场回到原处接着跑。',
      next: '这个小电路该盯什么：引脚是低电平，还是引脚「变了」？',
      refs: [{ t: 'PM0056：异常进入与返回（自动压栈 8 个寄存器）' }]
    },

    {
      id: 's3', stage: 'A', q: '盯电平还是盯变化', from: 's2',
      beats: [
        { k: 'trouble', t: '如果「引脚是低电平」就叫 CPU：按住按键的那 100 ms 里引脚一直是低，CPU 处理完一返回，发现还是低，又被叫回去——这 100 ms 里主程序一步都走不了。' },
        { k: 'fix', t: '改成盯**变化**：只在引脚从高变低（**下降沿**）或从低变高（**上升沿**）的那一瞬间叫一次。按一下就是一次下降沿（按下）加一次上升沿（松手）。' },
        { k: 'ask', id: 'e3-a', type: 'choice', q: 'KEY1 按下接地、平时靠上拉是高电平。「按下的那一刻」是哪种边沿？',
          opts: [
            { t: '下降沿：从高变低', ok: true },
            { t: '上升沿', assume: '按下就是「变高」', counter: '看接法：KEY1 平时被上拉到 1，按下接到地变成 0。课件用的 KEY3（PF10）正好相反：按下接 3V3、平时下拉，按下是上升沿。', back: 's3' }
          ],
          explain: '对。所以 KEY1 选下降沿触发；换成 KEY3 就选上升沿。' },
        { k: 'hw', t: '板上四个按键：KEY1（PF8）、KEY2（PF9）按下接地 → 上拉输入、下降沿；KEY3（PF10）、KEY4（PF11）按下接 3V3 → 下拉输入、上升沿。' }
      ],
      gist: '盯电平会在按住期间一直叫 CPU → 盯边沿：按下、松手各一次。KEY1 按下接地 → 下降沿。',
      next: 'STM32 上这个「盯边沿的小电路」在哪，一共有几个？',
      refs: [{ t: '开发板原理图第 8 页：KEY1~KEY4' }],
      links: [{ sch: 'board-08' }]
    },

    {
      id: 's4', stage: 'B', q: 'EXTI：16 条线，怎么接到 112 个脚上', from: 's3',
      beats: [
        { k: 'need', t: 'STM32F103ZE 有 PA~PG 七个口、112 个 GPIO 脚。每个脚都配一个盯边沿的电路？太浪费了，大多数脚根本用不到。' },
        { k: 'hw', t: ['STM32 的做法：**EXTI**（外部中断 / 事件控制器）只有 16 条线给 GPIO 用：EXTI0 ~ EXTI15。第 n 条线只能接**各个口的第 n 号脚**之一：EXTI8 可以接 PA8、PB8、……、PG8，但同一时间只能接一个。', '接哪个口由 **AFIO_EXTICR1 ~ 4** 决定：每条线 4 位，EXTICR1 管线 0~3、EXTICR2 管线 4~7、EXTICR3 管线 8~11、EXTICR4 管线 12~15。写 0 = PA、1 = PB、……、5 = PF。'] },
        { k: 'fact', f: 'F2' },
        { k: 'ask', id: 'e4-a', type: 'choice', q: 'KEY1 在 PF8：要设哪个寄存器的哪几位？（代码里 EXTICR 是从 0 开始编号的数组）',
          opts: [
            { t: 'EXTICR3（代码里写 AFIO->EXTICR[2]）的线 8 那 4 位，写成 5（PF）', ok: true },
            { t: 'EXTICR1 的第 8 位', assume: '一个脚对应一位', counter: '每条线要从 7 个口里选一个，3 位才够，手册给了 4 位。线 8 是 EXTICR3 的最低 4 位。', back: 's4' },
            { t: 'AFIO->EXTICR[3]', assume: 'EXTICR3 就是下标 3', counter: '手册里从 EXTICR1 开始编号，CMSIS 的数组从 0 开始：EXTICR3 在代码里是 EXTICR[2]。', back: 's4' }
          ],
          explain: '对。宏 AFIO_EXTICR3_EXTI8_PF 就是「线 8 选 PF」的那个值。' },
        { k: 'trouble', t: '最容易漏的一步：EXTICR 在 **AFIO** 里，AFIO 和 GPIO 一样要开时钟（RCC_APB2ENR 的 AFIOEN）。没开的话这次写入不起作用，线 8 还接在复位值 PA8 上——按 KEY1 永远没反应。' },
        { k: 'w', w: 'sim', sc: 'noafio', cap: '忘了开 AFIO 的时钟：' }
      ],
      makes: ['F2'],
      gist: 'EXTI 只有 16 条线：线 n 接各口第 n 号脚之一，选哪个口写 AFIO_EXTICR（PF8 → EXTICR[2] 的线 8 = 5）。AFIO 要开时钟。',
      next: '线接好了。上升沿、下降沿怎么选？中断怎么打开？',
      refs: [{ t: 'RM0008 AFIO_EXTICR1~4；EXTI 框图' }]
    },

    {
      id: 's5', stage: 'B', q: '选沿、开关和挂起标志：RTSR / FTSR、IMR、PR', from: 's4',
      beats: [
        { k: 'hw', t: ['每条线在 EXTI 里有这么几位：', '· **RTSR**：上升沿触发，**FTSR**：下降沿触发（两个都开 = 两个沿都触发）；', '· **IMR**：这条线的中断开关（还有一个 EMR 是「事件」开关，用来唤醒，不进中断）；', '· **PR**：挂起标志。选中的边沿一来，PR 对应的位置 1，表示「这条线有事，等着处理」。'] },
        { k: 'fact', f: 'F3' },
        { k: 'ask', id: 'e5-a', type: 'choice', q: 'KEY1：要设的是哪几位？',
          opts: [
            { t: 'FTSR 的 TR8（下降沿）和 IMR 的 MR8（打开线 8 的中断）', ok: true },
            { t: 'RTSR 的 TR8 和 IMR 的 MR8', assume: '按下是上升沿', counter: 'KEY1 按下接地，是下降沿（[[s3]]）。选了上升沿，松手的时候才触发。', back: 's3' },
            { t: '只设 IMR 的 MR8', assume: '打开中断就会自动选好沿', counter: 'RTSR、FTSR 复位都是 0：一个沿都不选，线上怎么变 PR 都不会置 1。', back: 's5' }
          ],
          explain: '对。EXTI 本身没有时钟开关，直接写就行。' }
      ],
      uses: ['F2'], makes: ['F3'],
      gist: 'RTSR / FTSR 选沿，IMR 打开中断，边沿来了 PR 置 1。KEY1：FTSR.TR8 + IMR.MR8。',
      next: 'PR 置 1 以后 CPU 进了中断。PR 自己会变回 0 吗？',
      refs: [{ t: 'RM0008 EXTI_IMR / RTSR / FTSR / PR' }]
    },

    {
      id: 's6', stage: 'B', q: 'PR 不清会怎样？为什么是「写 1 清」', from: 's5',
      beats: [
        { k: 'trouble', t: 'PR 是「有事等着处理」的意思。处理完了，硬件不知道你处理完没有，所以 PR 不会自己清 0。只要 PR 还是 1、中断开着，CPU 从处理函数一返回，立刻又被叫回去。' },
        { k: 'ask', id: 'e6-a', type: 'choice', predict: true, q: '处理函数里忘了清 PR，会看到什么？',
          opts: [
            { t: '按一下以后 CPU 一直在进出中断，主循环再也跑不动了：LED 一次都没翻转，程序像死机一样', ok: true },
            { t: '没什么影响，下一次按键会覆盖它', assume: '标志只是记录，不会反复触发', counter: '中断是「只要标志在、开关开着就一直请求」。不清，请求就一直在。', back: 's6' }
          ],
          explain: '对。下面模拟一下。' },
        { k: 'w', w: 'sim', sc: 'noclear', cap: '处理函数里没有清 PR：' },
        { k: 'why', t: ['清除方法是往 PR 对应的位**写 1**（写 0 没影响）：`EXTI->PR = EXTI_PR_PR8;`。', '为什么不用常见的 `&= ~`？`EXTI->PR &= ~X` 是先读出 PR、改一位、再写回——读出来的值里别的线如果也挂着 1，写回去就把它们也清掉了，那几条线的事件就丢了。「写 1 清、写 0 不变」让你只碰想清的那一位，不用读。'] },
        { k: 'fact', f: 'F4' }
      ],
      uses: ['F3'], makes: ['F4'],
      gist: 'PR 不会自己清，不清就一返回又进来（中断风暴）。写 1 清除、写 0 不变：直接 `EXTI->PR = EXTI_PR_PR8;`，不读不改，别的线不受影响。',
      next: 'PR 置 1 以后，CPU 是怎么知道要跑哪个函数的？',
      refs: [{ t: 'RM0008 EXTI_PR：rc_w1（写 1 清除）' }]
    },

    {
      id: 's7', stage: 'B', q: 'NVIC 和入口函数：线 8 的中断叫什么名字', from: 's6',
      beats: [
        { k: 'hw', t: ['外设的中断请求先到 **NVIC**（嵌套向量中断控制器）。每个中断源有一个编号，NVIC 里要打开它（`NVIC_EnableIRQ`）；CPU 响应时，去启动文件里的**向量表**按编号找处理函数的地址。', 'EXTI 的 16 条线在 NVIC 里没有 16 个编号：EXTI0 ~ EXTI4 各有一个，**线 5 ~ 9 共用 EXTI9_5**，**线 10 ~ 15 共用 EXTI15_10**。向量表里对应的函数名就是 `EXTI9_5_IRQHandler`、`EXTI15_10_IRQHandler`。'] },
        { k: 'ask', id: 'e7-a', type: 'choice', q: 'KEY1（线 8）和 KEY2（线 9）都开了中断，进了 EXTI9_5_IRQHandler，第一件事该做什么？',
          opts: [
            { t: '看 EXTI->PR：是线 8 还是线 9 挂着，分别处理、分别清', ok: true },
            { t: '直接当成 KEY1 处理', assume: '进来的一定是线 8', counter: '这个入口线 5~9 都会进来。不看 PR 就处理，按 KEY2 也会被当成 KEY1；而且线 9 的 PR 没清，又会一直进来。', back: 's7' }
          ],
          explain: '对。哪怕现在只开了线 8，先查 PR 再处理也是好习惯。' },
        { k: 'fact', f: 'F5' },
        { k: 'mine', t: '函数名必须和启动文件里一字不差：写成 `EXTI9_5_IRQHandle` 编译不会报错（它只是一个没人调用的普通函数），中断一来 CPU 跳进默认处理函数——一个死循环，整个程序卡住。定时器章踩过一次同样的坑。' }
      ],
      uses: ['F4'], makes: ['F5'],
      gist: 'NVIC 打开 EXTI9_5_IRQn；向量表里线 5~9 共用 EXTI9_5_IRQHandler（10~15 共用 EXTI15_10_IRQHandler）。进去先看 PR 是哪条线。',
      next: '处理函数里该做多少事？直接翻转 LED，还是把要做的都做完？',
      refs: [{ t: 'RM0008 向量表：EXTI9_5 = 23、EXTI15_10 = 40；startup_stm32f10x_hd.s' }]
    },

    {
      id: 's8', stage: 'B', q: '中断里做多少事：只记一笔', from: 's7',
      beats: [
        { k: 'trouble', t: '中断里干的事越多，CPU 被占得越久：主循环停着，别的中断（同级或更低优先级的）也只能排队。中断里 Delay 或 printf 尤其糟——课件的按键中断里 Delay_ms(5)，定时器中断里 printf，这些时间里别的中断全被耽误。' },
        { k: 'fix', t: '中断里只做最少的事：确认是哪条线 → 清 PR → 设一个标志「按过了」，马上返回。真正的处理（翻转 LED、消抖、发串口）放在主循环里，看到标志再做。' },
        { k: 'ask', id: 'e8-a', type: 'choice', q: '这个标志变量 `pressed`，为什么要写成 `volatile uint8_t`？',
          opts: [
            { t: '它在中断里被改、在主循环里被读：不加 volatile，编译器可能把它读进寄存器以后一直用旧值，主循环永远看不到中断改的 1', ok: true },
            { t: '为了让它占的内存少一点', assume: 'volatile 和变量大小有关', counter: 'volatile 不改大小，它告诉编译器「这个变量随时会被别处改」，每次用都要老老实实从内存读。', back: 's8' }
          ],
          explain: '对。开了优化以后，`while (!pressed);` 这种写法没有 volatile 会变成死循环。' },
        { k: 'fact', f: 'F6' }
      ],
      uses: ['F1'], makes: ['F6'],
      gist: '中断里只做最少的事：查线、清 PR、置标志（volatile），处理放主循环。不要在中断里 Delay / printf。',
      next: 'PF8 这个引脚本身还要配吗？EXTI 是从哪里看到它的电平的？',
      refs: [{ t: 'C 标准：volatile 限定符' }]
    },

    {
      id: 's9', stage: 'B', q: '引脚本身：还是上拉输入', from: 's8',
      beats: [
        { k: 'hw', t: 'EXTI 不接管引脚，它只是在 GPIO 的输入电路旁边「听」。所以 PF8 还是要像 GPIO 章那样配成输入，而且因为板上没有外部上拉，要配**上拉输入**：CNF8 = 10（上 / 下拉输入），ODR8 = 1 选上拉。' },
        { k: 'ask', id: 'e9-a', type: 'choice', q: '如果 PF8 留在复位的浮空输入，会怎样？',
          opts: [
            { t: '没按的时候引脚电平不确定，可能乱跳，产生一串不存在的「按键」；也可能一直是低，按下去根本没有下降沿', ok: true },
            { t: '没区别，EXTI 有自己的上拉', assume: 'EXTI 会管引脚的电平', counter: 'EXTI 只听不管。电平由 GPIO 的配置和外部电路决定，浮空就是没人决定（GPIO 章 F2）。', back: 's9' }
          ],
          explain: '对。所以初始化里 GPIOF 的时钟、CRH、ODR 这几行和 GPIO 章一样都要写。' },
        { k: 'say', t: '这也说明了为什么 KEY1 要同时开 **GPIOF** 和 **AFIO** 两个时钟：一个给引脚配置用，一个给 EXTICR 用。' }
      ],
      uses: ['F2'],
      gist: 'EXTI 只「听」GPIO 输入电路，不改引脚：PF8 仍要配成上拉输入（CNF=10、ODR=1）。GPIOF 和 AFIO 的时钟都要开。',
      next: '这么多东西要配，顺序有讲究吗？',
      refs: [{ t: 'RM0008 外部中断 / 事件线映射' }]
    },

    {
      id: 's10', stage: 'B', q: '配置顺序：先把门后面的东西准备好，最后再开门', from: 's9',
      beats: [
        { k: 'idea', t: '一个中断要三道门都开才会来：EXTI 的 IMR → NVIC → 处理函数存在（定时器章 F3 是同一个道理）。原则是：选沿、接线、清掉旧标志这些都配好，最后再打开 IMR 和 NVIC。' },
        { k: 'trouble', t: '为什么要先清 PR？配置过程中引脚可能已经抖过一下（比如上拉刚打开时电平从低升到高），PR 里留着一个旧的 1。这时一打开中断就会立刻进一次——开机 LED 莫名其妙翻转一下。' },
        { k: 'ask', id: 'e10-a', type: 'choice', q: '下面哪个顺序最稳妥？',
          opts: [
            { t: '开时钟 → 配 PF8 上拉输入 → EXTICR 选 PF → FTSR 选下降沿 → 清 PR → 开 IMR → 开 NVIC', ok: true },
            { t: '先开 NVIC 和 IMR，再慢慢配别的', assume: '中断开关和别的配置没有先后关系', counter: '门先开了，后面配置过程中的任何一个边沿、任何一个旧标志都会马上把 CPU 叫过来，这时处理函数看到的是半配好的状态。', back: 's10' }
          ],
          explain: '对。和定时器章「先 UG、清 UIF，再开中断」是一回事。' }
      ],
      uses: ['F3', 'F4'],
      gist: '三道门（IMR、NVIC、处理函数）最后开：先配引脚、接线、选沿，再清一次 PR，然后开 IMR、NVIC。',
      next: '回到任务：把这些写成代码，跑起来。',
      refs: [{ t: 'RM0008 EXTI 配置步骤' }]
    },

    {
      id: 's11', stage: 'C', q: '任务：主循环在忙也不漏按键——写出代码，跑起来', from: 's10',
      beats: [
        { k: 'ask', id: 'e11-o', type: 'order', q: '把 key_init 要做的事排好顺序（符合因果关系就算对）。',
          items: [{ t: '开 GPIOF、AFIO 的时钟' }, { t: 'PF8 配成上拉输入' }, { t: 'EXTICR[2] 线 8 选 PF' }, { t: 'FTSR 选下降沿' }, { t: '清一次 PR' }, { t: '打开 IMR 的线 8' }, { t: 'NVIC 打开 EXTI9_5' }],
          rules: [
            { a: 0, b: 1, why: 'GPIOF 的时钟没开，PF8 配不成上拉输入。', back: 's9' },
            { a: 0, b: 2, why: 'AFIO 的时钟没开，写 EXTICR 不起作用（F2）。', back: 's4' },
            { a: 3, b: 5, why: '先选好沿再开中断。', back: 's10' },
            { a: 4, b: 5, why: '先清掉旧的 PR 再开中断，否则一开就进一次。', back: 's10' },
            { a: 4, b: 6, why: '先清掉旧的 PR 再开 NVIC。', back: 's10' },
            { a: 2, b: 5, why: '先把线接到 PF8 上，再开这条线的中断。', back: 's10' }
          ] },
        { k: 'fn', fn: 'key_init' },
        { k: 'fn', fn: 'EXTI9_5_IRQHandler' },
        { k: 'fn', fn: 'main' },
        { k: 'w', w: 'sim', sc: 'irq', cap: '同样是 250 ~ 350 ms 按一下、主循环每圈 Delay 200 ms：这次 LED1 翻转了（在下一圈主循环看到标志时）。' },
        { k: 'say', t: '试试把 key_init 里「开 AFIO 时钟」和「EXTICR」交换，或者把处理函数里清 PR 那一行挪走。' }
      ],
      uses: ['F2', 'F3', 'F4', 'F5', 'F6'],
      gist: 'key_init：GPIOF + AFIO 时钟 → PF8 上拉输入 → EXTICR[2] 选 PF → FTSR.TR8 → 清 PR → IMR.MR8 → NVIC。处理函数：查 PR8 → 写 1 清 → pressed = 1。主循环看到 pressed 再翻转。',
      next: '机械按键是会抖的。一次按下，会进几次中断？'
    },

    {
      id: 's12', stage: 'D', q: '换个需求：按键会抖，一次按下进好几次中断', from: 's11', transfer: true,
      beats: [
        { k: 'need', t: '把主循环里的 Delay 去掉（主循环跑得很快），按一下 KEY1：LED1 有时翻转一次，有时没变化，有时翻转三次。' },
        { k: 'trouble', t: '机械按键按下的头几毫秒，触点会弹跳：接通、断开、再接通……一次按下引脚上有好几个下降沿，每个下降沿都进一次中断。松手时也会弹，又有几个下降沿。' },
        { k: 'w', w: 'sim', sc: 'bounce', cap: '主循环不 Delay、看到标志就翻转：按一次（带抖动）。' },
        { k: 'ask', id: 'e12-a', type: 'choice', q: '用学过的东西消抖，最合适的是？',
          opts: [
            { t: '主循环看到标志以后等 10 ms，抖动过去了再读一次 PF8：还是低电平才算按下；这 10 ms 里多进的中断一起清掉', ok: true },
            { t: '在中断里 Delay_ms(10) 再读', assume: '中断里等一会儿没关系', counter: '中断里等 10 ms，这段时间主循环和别的中断全停着（F6）。课件就是这么写的，按键多、中断多的时候会出问题。', back: 's8' },
            { t: '关掉下降沿，只用上升沿', assume: '抖动只在按下时发生', counter: '松手时同样会弹跳，上升沿也有好几个。', back: 's12' }
          ],
          explain: '对。等的这 10 ms 放在主循环里，只影响主循环自己。要主循环一点都不停，就要用定时器章的 Millis()：中断里记下时间，离上一次不到 50 ms 的不算。' },
        { k: 'fn', fn: 'main_debounce' },
        { k: 'w', w: 'sim', sc: 'debounce', cap: '加了消抖：同样带抖动地按一次，只翻转一次。' },
        { k: 'say', t: '回头看：从「主循环一忙按键就漏」出发，推出了中断、边沿触发、16 条 EXTI 线和 AFIO 选口、RTSR / FTSR / IMR / PR、写 1 清、NVIC 和共用入口、volatile 标志、配置顺序、消抖。现在课件那段按键中断代码，每一行在回答什么问题，你都说得出来。' }
      ],
      uses: ['F4', 'F6'],
      gist: '按键弹跳会产生好几个边沿、进好几次中断。消抖放在主循环：看到标志等 10 ms，再读引脚确认，期间多进的中断一起清掉。中断里不要 Delay。',
      refs: [{ t: '课件：中断案例 检测按键按下（中断里 Delay_ms(5) 消抖）' }]
    }
    ],

    globals: ['static volatile uint8_t pressed = 0;'],

    fns: {
      led_init: {
        sig: 'void led_init(void)', doc: 'PA0（LED1）推挽输出，初始为灭（GPIO 章推过）', sc: 'irq',
        lines: [
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', why: '开 GPIOA 时钟。', from: ['s9'] },
          { c: 'GPIOA->BSRR = GPIO_BSRR_BS0;', why: 'LED1 低电平亮：先写 1（灭）。', from: ['s9'] },
          { c: 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0)) | GPIO_CRL_MODE0;', why: 'PA0 推挽输出 50 MHz：先清后置。', from: ['s9'] }
        ],
        rules: [{ a: 0, b: 2, sc: 'irq', why: '先开时钟再配置。', back: 's9' }]
      },
      key_init: {
        sig: 'void key_init(void)', doc: 'KEY1（PF8）下降沿触发 EXTI 线 8 中断', sc: 'irq',
        lines: [
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPFEN | RCC_APB2ENR_AFIOEN;', why: 'GPIOF 给引脚配置用，AFIO 给 EXTICR 用：两个时钟都要开（F2）。', from: ['F2', 's9'] },
          { c: 'GPIOF->CRH = (GPIOF->CRH & ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8)) | GPIO_CRH_CNF8_1;', why: 'PF8：MODE = 00 输入，CNF = 10 上 / 下拉输入。', from: ['s9'] },
          { c: 'GPIOF->BSRR = GPIO_BSRR_BS8;', why: 'ODR8 = 1：选上拉。板上没有外部上拉（[[s9]]）。', from: ['s9'] },
          { c: 'AFIO->EXTICR[2] = (AFIO->EXTICR[2] & ~AFIO_EXTICR3_EXTI8) | AFIO_EXTICR3_EXTI8_PF;', why: 'EXTICR3（下标 2）里线 8 的 4 位写成 PF（F2）。', from: ['F2', 's4'] },
          { c: 'EXTI->FTSR |= EXTI_FTSR_TR8;', why: '线 8 下降沿触发：KEY1 按下是从高到低（[[s3]]、F3）。', from: ['F3', 's5'] },
          { c: 'EXTI->PR = EXTI_PR_PR8;', why: '先清掉配置过程中可能留下的旧标志，写 1 清（F4）。', from: ['F4', 's10'] },
          { c: 'EXTI->IMR |= EXTI_IMR_MR8;', why: '第一道门：打开线 8 的中断（F3）。', from: ['F3', 's5'] },
          { c: 'NVIC_EnableIRQ(EXTI9_5_IRQn);', why: '第二道门：在 NVIC 里打开线 5~9 共用的那个中断（F5）。', from: ['F5', 's7'] }
        ],
        rules: [
          { a: 0, b: 1, sc: 'irq', why: 'GPIOF 的时钟没开，PF8 配不成上拉输入，停在浮空。', back: 's9' },
          { a: 0, b: 3, sc: 'irq', why: 'AFIO 的时钟没开，EXTICR 写不进去，线 8 还接在 PA8 上，按 KEY1 没反应（F2）。', back: 's4' },
          { a: 3, b: 6, sc: 'irq', why: '先把线接到 PF8，再开中断。', back: 's10', simNote: '这里看不出区别：两行之间引脚没有变化。真实电路里，先开中断的话，这期间 PA8 上的边沿也会触发线 8。' },
          { a: 5, b: 6, sc: 'irq', why: '先清旧标志再开中断，否则一开就进一次。', back: 's10', simNote: '这里看不出区别：模拟器里配置过程中 PF8 没有抖动，PR 本来就是 0。' },
          { a: 4, b: 7, sc: 'irq', why: '先选好沿，再打开最后一道门。', back: 's10', simNote: '这里看不出区别：两行之间没有按键。' }
        ]
      },
      EXTI9_5_IRQHandler: {
        sig: 'void EXTI9_5_IRQHandler(void)', doc: '线 5~9 共用的入口：名字必须和启动文件里一字不差', sc: 'irq',
        lines: [
          { c: 'if (EXTI->PR & EXTI_PR_PR8) {', why: '先看是不是线 8：线 5~9 都会进这个函数（F5）。', from: ['F5', 's7'] },
          { c: '    EXTI->PR = EXTI_PR_PR8;', why: '写 1 清 PR8，否则一返回又进来（F4）。', from: ['F4', 's6'] },
          { c: '    pressed = 1;', why: '只记一笔，处理放到主循环（F6）。', from: ['F6', 's8'] },
          { c: '}' }
        ],
        rules: []
      },
      main: {
        sig: 'int main(void)', doc: '主循环每圈要忙 200 ms；按键由中断记下来', sc: 'irq',
        lines: [
          { c: 'led_init();', why: '' },
          { c: 'key_init();', why: '' },
          { c: 'while (1) {', why: '' },
          { c: '    if (pressed) {', why: '中断记过一笔吗？', from: ['F6'] },
          { c: '        pressed = 0;', why: '先清掉，这一次只处理一次。', from: ['F6'] },
          { c: '        GPIOA->ODR ^= GPIO_ODR_ODR0;', why: '翻转 LED1。', from: ['s11'] },
          { c: '    }' },
          { c: '    Delay_ms(200);', why: '代表主循环里别的活：再忙，按键也不会漏，只是处理晚一点。', from: ['s1'] },
          { c: '}' }
        ],
        rules: []
      },
      main_poll: {
        sig: 'int main(void)', doc: 'GPIO 章的写法：每圈读一次 PF8', sc: 'poll',
        lines: [
          { c: 'led_init();', why: '' },
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;', why: 'PF8 上拉输入（GPIO 章）。', from: ['s9'] },
          { c: 'GPIOF->CRH = (GPIOF->CRH & ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8)) | GPIO_CRH_CNF8_1;', why: '' },
          { c: 'GPIOF->BSRR = GPIO_BSRR_BS8;', why: '' },
          { c: 'while (1) {', why: '' },
          { c: '    if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0)', why: '读的那一刻是按下的才算。', from: ['s1'] },
          { c: '        GPIOA->ODR ^= GPIO_ODR_ODR0;', why: '' },
          { c: '    Delay_ms(200);', why: '主循环里别的活。', from: ['s1'] },
          { c: '}' }
        ],
        rules: []
      },
      main_fast: {
        sig: 'int main(void)', doc: '主循环不 Delay，看到标志就翻转（不消抖）', sc: 'bounce',
        lines: [
          { c: 'led_init();', why: '' },
          { c: 'key_init();', why: '' },
          { c: 'while (1) {', why: '' },
          { c: '    if (pressed) {', why: '', from: ['F6'] },
          { c: '        pressed = 0;', why: '' },
          { c: '        GPIOA->ODR ^= GPIO_ODR_ODR0;', why: '每进一次中断就翻转一次。', from: ['s12'] },
          { c: '    }' },
          { c: '}' }
        ],
        rules: []
      },
      main_debounce: {
        sig: 'int main(void)', doc: '看到标志等 10 ms，再读一次引脚确认', sc: 'debounce',
        lines: [
          { c: 'led_init();', why: '' },
          { c: 'key_init();', why: '' },
          { c: 'while (1) {', why: '' },
          { c: '    if (pressed) {', why: '中断记过一笔。', from: ['F6'] },
          { c: '        Delay_ms(10);', why: '等抖动过去（一般在 10 ms 以内）。等在主循环里，不耽误别的中断（F6）。', from: ['F6', 's12'] },
          { c: '        pressed = 0;', why: '等完再清：这 10 ms 里抖动多进的几次一起清掉（F4 清的是硬件标志，这里清的是自己的记录）。', from: ['F4', 's12'] },
          { c: '        if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0)', why: '10 ms 后还是低电平才算按下；松手时的抖动读到的是 1，不算。', from: ['s12'] },
          { c: '            GPIOA->ODR ^= GPIO_ODR_ODR0;', why: '翻转 LED1。' },
          { c: '    }' },
          { c: '}' }
        ],
        rules: [
          { a: 4, b: 5, sc: 'debounce', why: '先等完再清标志：反过来，等的这 10 ms 里抖动又把标志置 1，下一圈会再处理一次。', back: 's12' }
        ]
      }
    },

    scenarios: {
      poll: { title: '轮询：每 200 ms 读一次 PF8', ms: 1200, entry: ['main_poll'], board: { keys: [{ pin: 'PF8', down: [[250, 350]] }] }, view: { pins: ['PF8', 'PA0'], from: 0, to: 1200000 } },
      irq: { title: '中断：主循环同样每圈 Delay 200 ms', ms: 1200, board: { keys: [{ pin: 'PF8', down: [[250, 350]] }] }, view: { pins: ['PF8', 'PA0'], from: 0, to: 1200000 } },
      noafio: { title: '忘了开 AFIO 的时钟', ms: 1200, patch: { key_init: { set: { 0: { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPFEN;' } } } }, board: { keys: [{ pin: 'PF8', down: [[250, 350]] }] }, view: { pins: ['PF8', 'PA0'], from: 0, to: 1200000 } },
      noclear: { title: '处理函数里没有清 PR', ms: 1200, patch: { EXTI9_5_IRQHandler: { order: [0, 2, 3] } }, board: { keys: [{ pin: 'PF8', down: [[250, 350]] }] }, view: { pins: ['PF8', 'PA0'], from: 0, to: 1200000 } },
      bounce: { title: '按一次，带抖动', ms: 1200, entry: ['main_fast'], board: { keys: [{ pin: 'PF8', down: [[300, 700]], bounce: true }] }, view: [{ pins: ['PF8', 'PA0'], from: 0, to: 1200000 }, { pins: ['PF8', 'PA0'], from: 299500, to: 302500, label: '放大按下的前 3 ms：' }] },
      debounce: { title: '主循环里消抖', ms: 1200, entry: ['main_debounce'], board: { keys: [{ pin: 'PF8', down: [[300, 700]], bounce: true }] }, view: { pins: ['PF8', 'PA0'], from: 0, to: 1200000 } }
    }
  };
})();
