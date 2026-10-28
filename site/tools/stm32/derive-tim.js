/* derive-tim.js — 「编程思维」定时器章：从「Delay 占住了 CPU」推到「定时器中断翻转 LED」和「PWM 调亮度」
   数据结构见 derive-i2c.js 顶部说明；本章用通用单片机模拟器（mcusim.js）：定时器按 72 MHz 计数，中断会真的调用 TIM6_IRQHandler。 */
(function () {
  'use strict';
  var D = window.STM32_DERIVE = window.STM32_DERIVE || {};

  D.tim = {
    id: 'tim', topic: 'tim', engine: 'mcu', defaultSc: 'tim',
    title: '定时器：让硬件替 CPU 数时间',
    task: '用定时器中断让 LED2（PA1）每 1 秒翻转一次，主程序里不用任何延时。',
    intro: [
      'GPIO 章用 Delay_ms(500) 让灯闪了起来，可那 500 ms 里 CPU 什么也干不了。这一章从这个不满出发：能不能让一块硬件替 CPU 数时间，到点了再叫它？',
      '顺着往下推，你会自己「造」出计数器、预分频器、自动重装载、更新事件、中断，再顺手发现 PSC 第一次不生效的怪现象。最后把同一个计数器再用一次——比较一下计数值，就有了 PWM。'
    ],
    honesty: '说明：下面是「如果让我们自己来设计」的思路重建，不是定时器真实的设计过程。寄存器行为按 RM0008（通用定时器 TIM2~5、基本定时器 TIM6/7），时钟按本板的 72 MHz 配置。',

    facts: {
      F1: { t: '计数器跟着时钟加 1，数满一圈（到 ARR 再回 0）产生一次更新事件', short: '更新事件', from: 's2' },
      F2: { t: '更新周期 = (PSC + 1) × (ARR + 1) ÷ 定时器时钟', short: '周期公式', from: 's4' },
      F3: { t: '中断要过三道门：外设的 UIE、NVIC 的使能、名字对得上的中断函数；进了中断要清 UIF', short: '中断三道门', from: 's6' },
      F4: { t: 'PSC（和开了预装载的 ARR / CCR）要等下一次更新事件才生效；UG 可以立刻产生一次', short: '预装载', from: 's8' },
      F5: { t: 'PWM 模式 1：计数值小于 CCR 时输出有效电平，占空比 = CCR ÷ (ARR + 1)', short: 'PWM', from: 's11' }
    },

    stages: [
      { id: 'A', name: '让硬件替 CPU 数时间', desc: '计数器、预分频、自动重装载' },
      { id: 'B', name: '到点了怎么叫 CPU', desc: '标志与中断、三道门、时钟、预装载' },
      { id: 'C', name: '从任务需求推到代码', desc: '事件表 → 初始化与中断函数 → 跑起来' },
      { id: 'D', name: '换个需求：同一个计数器做 PWM', desc: '比较寄存器、极性、呼吸灯' }
    ],

    steps: [
    {
      id: 's1', stage: 'A', q: '用 Delay 等 500 ms，有什么不好？',
      beats: [
        { k: 'need', t: 'GPIO 章的闪灯程序是这样的：翻转、Delay_ms(500)、翻转、Delay_ms(500)……现在加一个需求：灯照样闪，同时要随时响应按键、收串口数据。' },
        { k: 'trouble', t: ['Delay_ms 是在「死等」：CPU 一直在查 SysTick 的标志，500 ms 里干不了别的。按键在这期间按下又松开，程序根本看不到；串口来了数据，RDR 溢出丢了（USART 章见过）。', '把 500 ms 拆成 50 次 10 ms，中间去查按键？能凑合，但每加一件事，主循环就更乱，时间也越来越不准。'] },
        { k: 'idea', t: '真正想要的是：有一块硬件替 CPU 数时间，CPU 该干嘛干嘛；时间到了，硬件「叫」一声 CPU，CPU 花几微秒翻一下灯，再回去干活。' },
        { k: 'ask', id: 't1-a', type: 'choice', q: '要做这样一块「数时间」的硬件，最简单的电路是什么？',
          opts: [
            { t: '一个计数器：每来一个时钟脉冲就加 1', ok: true },
            { t: '一段每隔一段时间执行一次的程序', assume: '计时只能靠软件', counter: '程序要靠 CPU 执行——我们想要的恰恰是不占用 CPU。时钟本身就是一串等间隔的脉冲，数脉冲就是数时间。', back: 's1' },
            { t: '一个 RC 电路，充满电就是时间到', assume: '要用模拟电路计时', counter: 'RC 的时间随温度、元件误差变化很大，而芯片里有一个由晶振产生的、非常准的时钟——直接数它最准。', back: 's1' }
          ],
          explain: '对。时钟是晶振产生的、间隔非常准的脉冲；数脉冲个数，就知道过了多少时间。' }
      ],
      gist: 'Delay 让 CPU 死等，期间什么都干不了 → 想要一块硬件替 CPU 数时间，到点叫它。最简单的硬件就是数时钟脉冲的计数器。',
      next: '就用 72 MHz 的时钟去数，一个 16 位的计数器能数多久？',
      refs: [{ t: 'RM0008 通用定时器（TIM2~5）与基本定时器（TIM6/7）简介' }]
    },

    {
      id: 's2', stage: 'A', q: '一个跟着 72 MHz 加 1 的 16 位计数器，能数多久？', from: 's1',
      beats: [
        { k: 'test', t: ['16 位计数器从 0 数到 65535，再加 1 就回到 0——一共 65536 个脉冲。', '72 MHz 下，一个脉冲 1/72 µs ≈ 13.9 ns，数满一圈只要 `65536 ÷ 72 MHz ≈ 0.91 ms`。'] },
        { k: 'say', t: '「数满一圈、回到 0」这个时刻很有用：它天然就是一个周期性的事件。我们把它叫做**更新事件**（update event），硬件在这一刻置一个标志 **UIF**。' },
        { k: 'fact', f: 'F1' },
        { k: 'trouble', t: '可我们要的是 1 秒，0.91 ms 太短了。差了一千多倍。' },
        { k: 'ask', id: 't2-a', type: 'choice', q: '要让一圈变长，有哪些办法？（选最合理的方向）',
          opts: [
            { t: '让计数器数得慢一点：先把时钟分频，再拿去数', ok: true },
            { t: '把计数器做成 32 位', assume: '只能靠加长位数', counter: '这是一种办法（有的定时器确实是 32 位），但 32 位在 72 MHz 下一圈约 60 秒，想要 1 秒还是得想办法让它「提前回 0」或「数慢点」。而且位数加倍，芯片面积和比较电路都要加倍。', back: 's2' },
            { t: '让 CPU 数够 1000 次溢出', assume: '剩下的交给软件', counter: '可以，但每 0.91 ms 就要打扰 CPU 一次。我们想要的是硬件直接给出 1 秒。', back: 's2' }
          ],
          explain: '对。这就是下一步：预分频器。' }
      ],
      makes: ['F1'],
      gist: '16 位计数器在 72 MHz 下数满一圈只要 0.91 ms。数满回 0 的时刻 = 更新事件（置 UIF）。要 1 秒得让它数慢点。',
      next: '在计数器前面加一个分频器——分多少？怎么设？',
      refs: [{ t: 'RM0008 时基单元：计数器 CNT、更新事件 UEV、UIF' }]
    },

    {
      id: 's3', stage: 'A', q: '想数得更久：预分频器 PSC', from: 's2',
      beats: [
        { k: 'fix', t: '在计数器前面加一个小计数器：它每数够 N 个时钟，才给后面的计数器一个脉冲。这就是**预分频器**，N 由寄存器 **PSC** 决定。' },
        { k: 'hw', t: '计数器的时钟 = `定时器时钟 ÷ (PSC + 1)`。' },
        { k: 'ask', id: 't3-a', type: 'choice', q: '为什么是 PSC + 1，而不是直接 ÷ PSC？',
          opts: [
            { t: '因为寄存器写 0 时也要有意义：0 表示不分频（÷1），这样 16 位能表示 ÷1 到 ÷65536', ok: true },
            { t: '为了防止除以 0', assume: '这只是个保护措施', counter: '防除零只是附带的好处。关键是 16 位寄存器有 65536 个取值，「+1」让每一个取值都对应一个有用的分频比，从 1 到 65536，一个都不浪费。', back: 's3' }
          ],
          explain: '对。所以想要 ÷7200，就写 PSC = 7199，代码里常写成 `7200 - 1`，一眼就看出分频比。' },
        { k: 'test', t: 'PSC = 7199：计数器每 7200 个时钟才加 1，也就是 72 MHz ÷ 7200 = **10 kHz**，每加 1 是 100 µs。数满 65536 要 6.55 秒——这回又太长了。' }
      ],
      uses: ['F1'],
      gist: '计数器前加预分频器：计数时钟 = 定时器时钟 ÷ (PSC + 1)。PSC = 7199 → 10 kHz，每计一个数 100 µs。',
      next: '6.55 秒又太长。能不能不数满 65536，数到某个数就回 0？',
      refs: [{ t: 'RM0008 TIMx_PSC：计数器时钟频率 CK_CNT = fCK_PSC / (PSC + 1)' }]
    },

    {
      id: 's4', stage: 'A', q: '不想数满 65536：自动重装载 ARR', from: 's3',
      beats: [
        { k: 'fix', t: '再加一个寄存器 **ARR**（自动重装载）：计数器数到 ARR，下一个脉冲就回到 0，并产生更新事件。于是一圈 = ARR + 1 个计数。' },
        { k: 'fact', f: 'F2' },
        { k: 'test', t: '要 1 秒：PSC = 7199（10 kHz），一圈要 10000 个计数，ARR = 9999。`(7199 + 1) × (9999 + 1) ÷ 72 MHz = 1 s`。' },
        { k: 'ask', id: 't4-a', type: 'fill', q: 'PSC 还是 7199，要每 500 ms 产生一次更新事件，ARR 应该写多少？',
          answers: ['4999', '5000-1', '5000 - 1'], hints: ['计数时钟 10 kHz，每个数 100 µs。', '500 ms ÷ 100 µs = 5000 个数，ARR = 5000 − 1。'],
          explain: '对：4999。' },
        { k: 'why', t: ['同样是 1 秒，PSC = 7199 / ARR = 9999 和 PSC = 35999 / ARR = 1999 都行。区别在**分辨率**：前者每个数 100 µs，后者 500 µs。以后要用这个计数器做 PWM、测脉宽时，分辨率越细越好；只用来定时，随便选一组整数就行。', '两个寄存器都是 16 位，所以最长周期是 65536 × 65536 ÷ 72 MHz ≈ 59.6 秒。'] }
      ],
      uses: ['F1'], makes: ['F2'],
      gist: '计数到 ARR 就回 0 并产生更新事件：周期 = (PSC+1)(ARR+1) ÷ 72 MHz。1 s → 7199 / 9999；500 ms → 7199 / 4999。',
      next: '更新事件发生时 UIF 被置 1。CPU 怎么知道它被置 1 了？',
      refs: [{ t: 'RM0008 TIMx_ARR；向上计数模式' }]
    },

    {
      id: 's5', stage: 'B', q: '计数到了，CPU 怎么知道？', from: 's4',
      beats: [
        { k: 'idea', t: '最直接：CPU 在主循环里一直读 TIM6->SR，看 UIF 是不是 1。' },
        { k: 'trouble', t: '这不就又回到死等了吗？只是从「等 SysTick」换成了「等 TIM6」。我们要的是 CPU 不用盯着，到点了被「叫」。' },
        { k: 'fix', t: ['这就是**中断**：UIF 置 1 时，如果允许了中断，CPU 会在执行完当前这条指令后，自动跳到一个特定的函数（中断服务函数）去执行，执行完再回到原来的地方接着跑——主程序甚至不知道自己被打断过。', '在 TIM6 里，「允许更新中断」的开关是 **DIER 寄存器的 UIE 位**。'] },
        { k: 'ask', id: 't5-a', type: 'choice', predict: true, q: '中断函数里翻转了 LED，但**没有把 UIF 清零**就返回了。会发生什么？',
          opts: [
            { t: 'UIF 还是 1，CPU 一返回就又被叫回中断里，永远出不来，主程序停住', ok: true },
            { t: '没关系，硬件会自动清 UIF', assume: '进中断时标志会自动清', counter: 'TIM 的 UIF 只能由软件清（写 0）。只要它还是 1、中断还允许着，CPU 就认为「还有事没处理」。', back: 's5' },
            { t: '下一次更新事件就不会再触发中断了', assume: '标志已经是 1 就不会再进', counter: '恰恰相反：它一直是 1，CPU 一直被叫进去。', back: 's5' }
          ],
          explain: '对。下面的模拟里对比一下。' },
        { k: 'w', w: 'sim', sc: 'clearcmp', cap: '左边：中断函数里清了 UIF；右边：忘了清。' }
      ],
      uses: ['F1'],
      gist: '轮询 UIF 还是死等 → 用中断：UIF 置 1 且 UIE 允许时，CPU 自动跳进中断函数，执行完回来。中断函数里必须清 UIF，否则一返回又被叫回去。',
      next: '只开 UIE 就够了吗？从 TIM6 到 CPU，中断还要经过哪些关口？',
      refs: [{ t: 'RM0008 TIMx_DIER：UIE；TIMx_SR：UIF（软件写 0 清除）' }]
    },

    {
      id: 's6', stage: 'B', q: '中断从 TIM6 到 CPU，要过哪几道门？', from: 's5',
      beats: [
        { k: 'need', t: '芯片上有几十个外设，每个都能产生中断。CPU 怎么知道是谁叫它、该跳到哪个函数？要是两个同时叫，先处理谁？' },
        { k: 'fix', t: ['所以在外设和 CPU 之间有一个专门的「接线员」：**NVIC**（嵌套向量中断控制器）。每个中断源有一个编号（TIM6 是 54 号），NVIC 里可以单独打开 / 关闭它，并给它设优先级。', '编号对应一张表——**中断向量表**，表里第 54 项存着中断函数的地址。启动文件（startup_stm32f10x_hd.s）里已经把这一项写成了 `TIM6_IRQHandler`：你只要写一个同名函数，链接时就会填进去。'] },
        { k: 'fact', f: 'F3' },
        { k: 'ask', id: 't6-a', type: 'choice', q: '把中断函数名不小心写成了 `TIM6_IRQHandle`（少了个 r），会怎样？',
          opts: [
            { t: '编译不报错，但向量表里还是默认的处理函数（一个死循环）：一来中断程序就卡死', ok: true },
            { t: '编译报错', assume: '编译器会检查中断函数名', counter: '编译器只看到你定义了一个普通函数 TIM6_IRQHandle，合法。启动文件里 TIM6_IRQHandler 是一个「弱」符号，没人覆盖它，就指向默认的 Default_Handler——一个无限循环。', back: 's6' },
            { t: 'TIM6 会自动找到这个函数', assume: '按名字模糊匹配', counter: '向量表靠的是链接时的符号名，必须一字不差。', back: 's6' }
          ],
          explain: '对。这类错误编译器不会提醒，只能靠「名字从启动文件里复制」来避免。' },
        { k: 'w', w: 'sim', sc: 'nvic', cap: '开了 UIE，却忘了 NVIC_EnableIRQ：' },
        { k: 'hw', t: 'NVIC 的优先级数值越小越优先。F103 用 4 位优先级，可以按分组拆成「抢占优先级」和「子优先级」：抢占优先级高的中断可以打断正在执行的低优先级中断。这个例子只有一个中断，优先级随便设。' }
      ],
      uses: ['F1'], makes: ['F3'],
      gist: '三道门：TIM6 的 UIE → NVIC 使能 54 号中断 → 向量表里同名的 TIM6_IRQHandler。名字写错编译不报错，中断一来就卡在默认处理函数。',
      next: '还有一个前提：「定时器时钟」到底是多少？TIM6 挂在 36 MHz 的 APB1 上啊。',
      refs: [{ t: 'PM0056 NVIC；startup_stm32f10x_hd.s 中断向量表（TIM6_IRQHandler 为弱符号）' }]
    },

    {
      id: 's7', stage: 'B', q: '定时器的时钟是 72 MHz 还是 36 MHz？', from: 's6',
      beats: [
        { k: 'trouble', t: 'TIM6 挂在 APB1 总线上，而 APB1 最高只能 36 MHz（本板就是 72 MHz ÷ 2）。按 36 MHz 算，PSC = 7199 得到的是 5 kHz，ARR = 9999 就成了 2 秒——灯会慢一半？' },
        { k: 'hw', t: ['RM0008 的时钟树里有一条专门的规则：**如果 APB1 的分频系数不是 1，那么 TIM2 ~ TIM7 的时钟是 PCLK1 的 2 倍。**', '本板 APB1 分频是 2，所以 TIM6 的时钟 = 36 MHz × 2 = **72 MHz**，和公式里用的一样。'] },
        { k: 'why', t: '为什么要这样设计？APB1 因为外设多、要省电，速度被限制在 36 MHz；但定时器希望分辨率越高越好。于是在定时器入口处加了一个倍频：总线慢，定时器的时钟不降。这是一个只能「记住」的规则，但知道了它的理由，就不容易记反。' },
        { k: 'ask', id: 't7-a', type: 'choice', q: '假如有人把系统配成 APB1 不分频（APB1 = 36 MHz，系统时钟也只有 36 MHz），TIM6 的时钟是多少？',
          opts: [
            { t: '36 MHz：APB1 分频系数是 1 时，定时器时钟就等于 PCLK1，不倍频', ok: true },
            { t: '72 MHz：定时器时钟永远是 PCLK1 的 2 倍', assume: '倍频是无条件的', counter: '规则是「分频系数不为 1 时才 ×2」。分频为 1 时 ×2 就会超过总线时钟的来源，没有意义。', back: 's7' }
          ],
          explain: '对。所以换了时钟配置（比如用 CubeMX 改过）以后，定时器的参数要重新算。' }
      ],
      uses: ['F2'],
      gist: 'APB1 分频不为 1 时，TIM2~7 的时钟 = 2 × PCLK1。本板 PCLK1 = 36 MHz → 定时器时钟 72 MHz。',
      next: '一切都配好了，跑一下——第一次中断却来得特别早。为什么？',
      refs: [{ t: 'RM0008 时钟树：TIMxCLK = PCLK1 × 2（当 APB1 预分频 ≠ 1）' }],
      links: [{ fig: 'clock-tree' }]
    },

    {
      id: 's8', stage: 'B', q: '为什么第一次中断来得特别早？', from: 's7',
      beats: [
        { k: 'test', t: '按课件的写法：写 PSC = 7199、ARR = 9999、开中断、开计数器。跑起来——LED2 第一次翻转发生在 0.14 ms，之后才是每秒一次。' },
        { k: 'w', w: 'sim', sc: 'ugcmp', cap: '左边：写完 PSC 后用 UG 立刻产生一次更新事件；右边：没有。注意右边第一次翻转的时间。' },
        { k: 'why', t: ['原因在 PSC 的设计上：**写进 PSC 的值不会立刻生效，要等下一次更新事件才装进真正起作用的「影子寄存器」。**', '所以第一圈的计数时钟还是 72 MHz（PSC 复位值 0），10000 个数只要 139 µs；第一次更新事件发生时新的 PSC 才装进去，之后才是 1 秒。'] },
        { k: 'ask', id: 't8-a', type: 'choice', q: 'PSC 为什么要设计成「等更新事件才生效」，而不是写进去立刻生效？',
          opts: [
            { t: '定时器在运行中改分频时，如果立刻生效，正在数的这一圈会变成一个「不长不短」的怪周期；等到一圈结束再换，每一圈都是完整的', ok: true },
            { t: '为了省电', assume: '缓冲是为了功耗', counter: '多一级寄存器反而要多一点电。它解决的是「运行中修改参数」时的周期完整性问题。', back: 's8' }
          ],
          explain: '对。比如 PWM 正在驱动电机，你改了频率，如果中途生效，那一个周期的波形就是错的。ARR、CCR 也可以选择同样的缓冲方式（ARPE、OCxPE 位），PSC 是强制缓冲的。' },
        { k: 'fact', f: 'F4' },
        { k: 'fix', t: ['解决办法：写完 PSC 和 ARR 后，往 **EGR 寄存器的 UG 位**写 1，用软件产生一次更新事件——影子寄存器立刻装上新值，计数器清零。', '但 UG 产生的更新事件也会置 UIF！所以紧接着要把 UIF 清掉，再打开中断，否则一开中断就会立刻进一次。'] }
      ],
      deep: [
        { q: '能不能不清 UIF，而是让 UG 不置 UIF？', a: ['可以：CR1 的 URS 位置 1 后，只有计数器溢出才会置 UIF，UG 不会。两种写法都常见。'] }
      ],
      uses: ['F1', 'F2'], makes: ['F4'],
      gist: 'PSC 写进去要等下一次更新事件才生效 → 第一圈按 PSC=0 计数，第一次中断 139 µs 就来了。写完 PSC/ARR 后用 UG 立刻更新，再清掉 UG 顺带置上的 UIF。',
      next: '零件都齐了。回到任务：LED2 每秒翻转一次，要做哪些事？',
      refs: [{ t: 'RM0008 TIMx_PSC（在下一次更新事件时装入）；TIMx_EGR：UG；TIMx_CR1：URS、ARPE' }]
    },

    {
      id: 's9', stage: 'C', q: '任务：LED2 每秒翻转——要做哪些事？', from: 's8',
      beats: [
        { k: 'ask', id: 't9-o', type: 'order', q: '把初始化定时器要做的事排好顺序（符合因果关系就算对）。',
          items: [{ t: '开 TIM6 的时钟' }, { t: '写 PSC = 7199、ARR = 9999' }, { t: 'UG：立刻产生一次更新事件' }, { t: '清 UIF' }, { t: '开 UIE 和 NVIC 中断' }, { t: '开计数器 CEN' }],
          rules: [
            { a: 0, b: 1, why: '时钟没开，写不进去（GPIO 章的老问题）。', back: 's7' },
            { a: 1, b: 2, why: 'UG 是让写好的 PSC / ARR 立刻生效：要先写好它们（F4）。', back: 's8' },
            { a: 2, b: 3, why: 'UG 会顺带把 UIF 置 1，所以要在 UG 之后清（F4）。', back: 's8' },
            { a: 3, b: 4, why: '先清 UIF 再开中断，否则一开中断就立刻进一次（F3）。', back: 's5' },
            { a: 1, b: 5, why: '先配好周期再开始数。', back: 's4' }
          ] },
        { k: 'table', head: ['在哪', '做什么', '理由'], rows: [
          ['初始化', '开 GPIOA、TIM6 时钟；PA1 推挽输出（灭）', 'GPIO 章'],
          ['初始化', 'PSC = 7199，ARR = 9999', '{F2} [[s4]]'],
          ['初始化', 'UG，清 UIF', '{F4} [[s8]]'],
          ['初始化', 'UIE、NVIC 使能、CEN', '{F3} [[s6]]'],
          ['TIM6_IRQHandler', '清 UIF，翻转 PA1', '[[s5]]'],
          ['main', '初始化后什么都不用做', 'CPU 空出来了']] },
        { k: 'say', t: '注意分工的变化：GPIO 章里，「每秒翻转一次」这件事写在主循环里；现在它被拆成两半——「每秒」由硬件负责（初始化时配好），「翻转」写在中断函数里。主循环第一次可以什么都不写。' }
      ],
      uses: ['F2', 'F3', 'F4'],
      gist: '开时钟 → PSC/ARR → UG → 清 UIF → UIE + NVIC → CEN；中断函数里清 UIF、翻转 LED；主循环空着。',
      next: '写出来，跑一下。'
    },

    {
      id: 's10', stage: 'C', q: '写出 tim6_init 和 TIM6_IRQHandler，跑起来', from: 's9',
      beats: [
        { k: 'ask', id: 't10-o', type: 'order', fn: 'tim6_init', q: '把 tim6_init() 的 9 行排好（排完会跑 3.5 秒看 LED2）。' },
        { k: 'fn', fn: 'led_init' },
        { k: 'fn', fn: 'tim6_init' },
        { k: 'fn', fn: 'TIM6_IRQHandler' },
        { k: 'fn', fn: 'main' },
        { k: 'w', w: 'sim', sc: 'tim', cap: '跑 3.5 秒：LED2 在 1 s、2 s、3 s 翻转，主循环一直空着。' },
        { k: 'mine', t: '课件的 Driver_TIM6_Init 没有 UG 和清 UIF 两步，所以第一次翻转会在开机 0.14 ms 后就发生（[[s8]]）。对一个每秒闪一次的灯来说几乎看不出来，但如果你用这个中断来计时，第一个「1 秒」就是错的。' },
        { k: 'say', t: '试试在 tim6_init 里交换 UG 和清 UIF 两行，或者交换「清 UIF」和「开 UIE」，看第一次翻转的时间。' }
      ],
      uses: ['F2', 'F3', 'F4'],
      gist: 'tim6_init 九行：时钟、PSC、ARR、UG、清 UIF、UIE、优先级、NVIC 使能、CEN。中断函数：确认 UIF、清 UIF、翻转。',
      next: '同一个计数器还能干别的：如果在计数的过程中比较一下计数值呢？',
      links: [{ cw: 'v21-14' }]
    },

    {
      id: 's11', stage: 'D', q: '换个需求：让 LED 不只是亮和灭，而是可以调亮度', from: 's10', transfer: true,
      beats: [
        { k: 'need', t: 'GPIO 只能输出 0 V 或 3.3 V，LED 要么全亮要么全灭。想要「半亮」怎么办？' },
        { k: 'idea', t: '让它快速地亮、灭、亮、灭：一秒钟上千次，眼睛跟不上，看到的就是平均亮度。一个周期里亮的时间越长，就越亮。亮的时间占整个周期的比例叫**占空比**，这种方式叫 **PWM**（脉冲宽度调制）。' },
        { k: 'ask', id: 't11-a', type: 'choice', q: '用 CPU 在主循环里快速翻转引脚当然可以，但我们手里正好有一个一直在数数的计数器。怎样让它直接产生 PWM？',
          opts: [
            { t: '再加一个寄存器 CCR：计数值小于 CCR 时输出一个电平，大于等于时输出另一个电平——每一圈都自动重复', ok: true },
            { t: '每次更新事件进中断，在中断里翻转引脚', assume: '只能靠中断改引脚', counter: '这样做一个周期至少要两次中断，频率一高 CPU 就忙不过来，波形还会被别的中断拖后。让硬件在计数器旁边直接比较，一行代码都不用跑。', back: 's5' }
          ],
          explain: '对。这个寄存器叫「捕获 / 比较寄存器」CCR，每个通用定时器有 4 个（4 个通道）。' },
        { k: 'fact', f: 'F5' },
        { k: 'hw', t: ['TIM5 的通道 2 正好可以从 **PA1**（LED2）输出（课件的呼吸灯就是这样接的）。要做的事：', '· PA1 配成**复用推挽输出**（引脚交给定时器，USART 章见过同样的道理）；', '· CCMR1 的 OC2M = 110（PWM 模式 1），OC2PE = 1（CCR2 预装载，[[s8]] 的道理）；', '· CCER 的 CC2E = 1（打开通道 2 的输出）；', '· PSC = 71（1 MHz 计数），ARR = 999（1 kHz 的 PWM），CCR2 = 200 → 占空比 20%。'] },
        { k: 'ask', id: 't11-b', type: 'choice', predict: true, q: 'PWM 模式 1 在「计数值 < CCR2」时输出高电平（有效电平默认是高）。CCR2 = 200、ARR = 999，LED2 是低电平点亮——它看起来有多亮？',
          opts: [
            { t: '大约 80% 的亮度：高电平（灭）只占 20%，剩下 80% 是低电平（亮）', ok: true },
            { t: '20% 的亮度', assume: '占空比就是亮度', counter: '占空比说的是「有效电平」的比例，有效电平默认是高电平；而 LED2 是低电平亮。所以亮的比例是 1 − 20%。', back: 's11' }
          ],
          explain: '对。要让「CCR 越大越亮」，把通道的有效电平改成低电平：CCER 的 CC2P = 1。' },
        { k: 'w', w: 'sim', sc: 'polcmp', cap: '同样 CCR2 = 200：左边 CC2P = 1（有效电平为低，LED 亮 20%），右边 CC2P = 0（亮 80%）。' },
        { k: 'mine', t: '课件的 Driver_TIM5_Init 保持 CC2P = 0（高电平有效），所以课件里的 CCR2 越大，LED 越暗——不是错误，只是方向反了。另外课件用的是 PSC = 7199、ARR = 99，PWM 频率 100 Hz：一般看不出闪，但快速转动眼睛或者用手机拍时可能看得出来，很多产品会用 1 kHz 以上。' },
        { k: 'fn', fn: 'pwm_init' }
      ],
      uses: ['F2', 'F4'], makes: ['F5'],
      gist: '快速开关 + 改变占空比 = PWM。计数器旁加比较寄存器 CCR：PWM 模式 1 下 CNT < CCR 输出有效电平，占空比 = CCR ÷ (ARR+1)。LED 低电平亮 → 用 CC2P = 1 让有效电平为低。',
      next: '最后一步：让亮度慢慢变化——呼吸灯。',
      refs: [{ t: 'RM0008 PWM 模式；TIMx_CCMR1：OC2M、OC2PE；TIMx_CCER：CC2E、CC2P' }],
      links: [{ fig: 'tim-pwm-edge' }, { pin: 'PA1' }, { cw: 'v21-25' }]
    },

    {
      id: 's12', stage: 'D', q: '呼吸灯：一边输出 PWM，一边慢慢改占空比', from: 's11', transfer: true,
      beats: [
        { k: 'idea', t: '主循环里每 10 ms 把 CCR2 加一点，加到最大再一点点减回来。PWM 波形由定时器硬件一直输出，CPU 只是偶尔改一个数。' },
        { k: 'ask', id: 't12-a', type: 'choice', q: '为什么 pwm_init 里要开 OC2PE（CCR2 预装载）？',
          opts: [
            { t: '主循环随时改 CCR2，可能正好改在一个周期中间；开了预装载，新值等这一圈结束才生效，每个周期都是完整的', ok: true },
            { t: '不开就不能改 CCR2', assume: '预装载是修改的前提', counter: '不开也能改，只是立刻生效：如果计数器已经数过了新的 CCR2，这一圈就会少一次翻转，波形出现一个「毛刺」。', back: 's8' }
          ],
          explain: '对。这是 [[s8]] 里预装载思想的又一次应用。RM0008 对 PWM 模式也明确要求开 OCxPE，并在启动前用 UG 把所有影子寄存器装好。' },
        { k: 'fn', fn: 'main_breathe' },
        { k: 'w', w: 'sim', sc: 'breathe', cap: '跑 2 秒：PWM 频率不变，亮的时间占比从 0 慢慢升到 100% 又降回来。' },
        { k: 'say', t: ['回头看：从「Delay 占住了 CPU」出发，推出了计数器、PSC、ARR、更新事件、中断的三道门、定时器时钟的倍频、预装载和 UG，最后同一个计数器加一个比较寄存器就成了 PWM。', '定时器还能做的事——输入捕获（测脉宽）、编码器接口、触发 ADC——都是「计数器 + 比较 / 捕获」这一个想法的延伸。'] }
      ],
      uses: ['F4', 'F5'],
      gist: '呼吸灯：PWM 由硬件一直输出，主循环每 10 ms 改一次 CCR2。开 OC2PE 让新值在周期边界生效，避免毛刺。',
      refs: [{ t: 'RM0008 PWM 模式：必须设置 OCxPE，并在启动前用 UG 初始化' }]
    }
    ],

    fns: {
      led_init: {
        sig: 'void led_init(void)', doc: 'PA1（LED2）推挽输出，初始为灭（GPIO 章推过）', sc: 'tim',
        lines: [
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', why: '开 GPIOA 时钟。', from: ['s9'] },
          { c: 'GPIOA->BSRR = GPIO_BSRR_BS1;', why: 'LED2 低电平亮：先写 1（灭）。', from: ['s9'] },
          { c: 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF1 | GPIO_CRL_MODE1)) | GPIO_CRL_MODE1;', why: 'PA1 推挽输出 50 MHz：先清后置。', from: ['s9'] }
        ],
        rules: [{ a: 0, b: 2, sc: 'tim', why: '先开时钟再配置。', back: 's9' }]
      },
      tim6_init: {
        sig: 'void tim6_init(void)', doc: 'TIM6 每 1 秒产生一次更新中断', sc: 'tim',
        lines: [
          { c: 'RCC->APB1ENR |= RCC_APB1ENR_TIM6EN;', why: 'TIM6 挂在 APB1 上：开它的时钟。', from: ['s7'] },
          { c: 'TIM6->PSC = 7200 - 1;', why: '72 MHz ÷ 7200 = 10 kHz，每计一个数 100 µs。', from: ['F2', 's3'] },
          { c: 'TIM6->ARR = 10000 - 1;', why: '数 10000 个 = 1 s 产生一次更新事件。', from: ['F2', 's4'] },
          { c: 'TIM6->EGR = TIM_EGR_UG;', why: '立刻产生一次更新事件：PSC 马上生效、计数器清零（F4）。', from: ['F4', 's8'] },
          { c: 'TIM6->SR &= ~TIM_SR_UIF;', why: 'UG 顺带置了 UIF：清掉，免得一开中断就进去。', from: ['F4', 's8'] },
          { c: 'TIM6->DIER |= TIM_DIER_UIE;', why: '第一道门：允许 TIM6 的更新事件产生中断。', from: ['F3', 's5'] },
          { c: 'NVIC_SetPriority(TIM6_IRQn, 1);', why: '设优先级（数值越小越优先）。只有一个中断，随便设。', from: ['s6'] },
          { c: 'NVIC_EnableIRQ(TIM6_IRQn);', why: '第二道门：在 NVIC 里打开 54 号中断。', from: ['F3', 's6'] },
          { c: 'TIM6->CR1 |= TIM_CR1_CEN;', why: '一切就绪，开始计数。', from: ['s9'] }
        ],
        rules: [
          { a: 0, b: 1, sc: 'tim', why: '时钟没开，写 PSC 不起作用：计数器按 72 MHz 数，周期只有 0.14 ms。', back: 's7' },
          { a: 0, b: 2, sc: 'tim', why: '时钟没开，写 ARR 不起作用。', back: 's7' },
          { a: 0, b: 8, sc: 'tim', why: '时钟没开，CEN 写不进去，定时器根本不会开始数。', back: 's7' },
          { a: 1, b: 3, sc: 'tim', why: 'UG 是把「已经写好的」PSC 装进影子寄存器：PSC 要先写（F4）。', back: 's8' },
          { a: 3, b: 4, sc: 'tim', why: 'UG 会置 UIF：清 UIF 必须在 UG 之后，否则开中断后立刻进一次。', back: 's8' },
          { a: 4, b: 5, sc: 'tim', why: '先清 UIF 再允许中断：UIF 还是 1 时开 UIE，中断立刻就来。', back: 's5', simNote: '这里看不出区别：开 UIE 时 NVIC 那道门还关着，等 NVIC 打开时 UIF 已经清掉了。三道门要全开中断才会来（F3）——试试把「清 UIF」和「NVIC_EnableIRQ」交换。' },
          { a: 4, b: 7, sc: 'tim', why: '先清 UIF 再打开 NVIC：UIF 还是 1、UIE 已经开着时打开最后一道门，中断立刻就来，LED 一开机就翻转一次。', back: 's6' },
          { a: 1, b: 8, sc: 'tim', why: '先配好周期，再开始数。', back: 's4' }
        ]
      },
      TIM6_IRQHandler: {
        sig: 'void TIM6_IRQHandler(void)', doc: '第三道门：名字必须和启动文件里的一字不差', sc: 'tim',
        lines: [
          { c: 'if (TIM6->SR & TIM_SR_UIF) {', why: '确认是更新事件叫的（别的定时器中断源共用入口时尤其要查）。', from: ['s5'] },
          { c: '    TIM6->SR &= ~TIM_SR_UIF;', why: '清掉 UIF，否则一返回又被叫回来（F3）。', from: ['F3', 's5'] },
          { c: '    GPIOA->ODR ^= GPIO_ODR_ODR1;', why: '翻转 LED2。', from: ['s9'] },
          { c: '}' }
        ],
        rules: []
      },
      main: {
        sig: 'int main(void)', doc: '初始化以后，主循环什么都不用做', sc: 'tim',
        lines: [
          { c: 'led_init();', why: 'LED2 推挽输出。', from: ['s9'] },
          { c: 'tim6_init();', why: '定时器开始数，每秒叫一次 CPU。', from: ['s9'] },
          { c: 'while (1) {', why: 'CPU 空出来了：这里可以放别的任务（读按键、收串口……）。', from: ['s1'] },
          { c: '}' }
        ],
        rules: [{ a: 0, b: 1, sc: 'tim', why: '定时器先跑起来，LED 还没配好，第一次翻转可能落空——习惯上先配好要控制的东西，再打开会触发它的中断。', back: 's9', simNote: '这里看不出区别：第一次中断要 1 秒后才来，那时 LED 早就配好了。如果定时周期很短，第一次中断就可能在 LED 配好之前到来，那一次翻转就白做了。' }]
      },
      pwm_init: {
        sig: 'void pwm_init(void)', doc: 'TIM5 通道 2 在 PA1 上输出 1 kHz PWM，占空比 20%（低电平有效）', sc: 'pwm',
        lines: [
          { c: 'RCC->APB1ENR |= RCC_APB1ENR_TIM5EN;', why: 'TIM5 在 APB1 上。', from: ['s7'] },
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', why: 'PA1 在 GPIOA 上。', from: ['s9'] },
          { c: 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF1 | GPIO_CRL_MODE1)) | GPIO_CRL_CNF1_1 | GPIO_CRL_MODE1;', why: 'PA1 复用推挽输出（CNF=10、MODE=11）：引脚交给 TIM5 的通道 2。', from: ['s11'] },
          { c: 'TIM5->PSC = 72 - 1;', why: '计数时钟 1 MHz，每个数 1 µs。', from: ['F2'] },
          { c: 'TIM5->ARR = 1000 - 1;', why: '一圈 1000 µs：PWM 频率 1 kHz。', from: ['F2'] },
          { c: 'TIM5->CCR2 = 200;', why: '比较值 200：有效电平占 200 / 1000 = 20%。', from: ['F5'] },
          { c: 'TIM5->CCMR1 = (TIM5->CCMR1 & ~(TIM_CCMR1_OC2M | TIM_CCMR1_CC2S)) | TIM_CCMR1_OC2M_2 | TIM_CCMR1_OC2M_1 | TIM_CCMR1_OC2PE;', why: '通道 2：CC2S = 00（输出），OC2M = 110（PWM 模式 1），OC2PE = 1（CCR2 预装载）。', from: ['F5', 'F4'] },
          { c: 'TIM5->CCER |= TIM_CCER_CC2E | TIM_CCER_CC2P;', why: '打开通道 2 输出；CC2P = 1：有效电平为低，LED2（低电平亮）的亮度正比于 CCR2。', from: ['F5', 's11'] },
          { c: 'TIM5->CR1 |= TIM_CR1_ARPE;', why: 'ARR 也开预装载。', from: ['F4'] },
          { c: 'TIM5->EGR = TIM_EGR_UG;', why: '把 PSC、ARR、CCR2 一次装进影子寄存器（F4）。', from: ['F4', 's8'] },
          { c: 'TIM5->CR1 |= TIM_CR1_CEN;', why: '开始计数，PA1 上出现 PWM。', from: ['s11'] }
        ],
        rules: [
          { a: 0, b: 3, sc: 'pwm', why: 'TIM5 时钟没开，写不进去。', back: 's7' },
          { a: 1, b: 2, sc: 'pwm', why: 'GPIOA 时钟没开，PA1 配不成复用输出。', back: 's11' },
          { a: 3, b: 9, sc: 'pwm', why: 'UG 把已经写好的 PSC 装进去：PSC 要先写，否则第一段 PWM 的频率是错的。', back: 's8' },
          { a: 5, b: 9, sc: 'pwm', why: '开了 OC2PE 以后 CCR2 也要等更新事件才生效：先写好，再 UG。', back: 's8' },
          { a: 9, b: 10, sc: 'pwm', why: '先把影子寄存器装好，再开始数。', back: 's8', simNote: '这里只差了几十纳秒，看不出来。但如果 CEN 和 UG 之间隔了别的代码，这段时间里定时器按旧的 PSC / ARR 在跑，PWM 的开头一段就是错的。' }
        ]
      },
      main_pwm: {
        sig: 'int main(void)', doc: '固定占空比', sc: 'pwm',
        lines: [{ c: 'pwm_init();', why: '' }, { c: 'while (1) {', why: '' }, { c: '}' }],
        rules: []
      },
      main_breathe: {
        sig: 'int main(void)', doc: '呼吸灯：每 10 ms 改一次 CCR2', sc: 'breathe',
        lines: [
          { c: 'pwm_init();', why: 'PWM 先跑起来。', from: ['s11'] },
          { c: 'while (1) {', why: '' },
          { c: '    for (uint16_t d = 0; d < 1000; d += 10) {', why: '亮度从 0 往上加，每次 1%。', from: ['s12'] },
          { c: '        TIM5->CCR2 = d;', why: '只改比较值：新值在这一圈结束时生效（OC2PE）。', from: ['F5', 'F4'] },
          { c: '        Delay_ms(10);', why: '每 10 ms 变一次：100 步 = 1 秒从暗到亮。', from: ['s12'] },
          { c: '    }' },
          { c: '    for (uint16_t d = 1000; d > 0; d -= 10) {', why: '再从亮到暗。', from: ['s12'] },
          { c: '        TIM5->CCR2 = d;', why: '' },
          { c: '        Delay_ms(10);', why: '' },
          { c: '    }' },
          { c: '}' }
        ],
        rules: []
      }
    },

    scenarios: {
      tim: { title: 'TIM6 每秒翻转 LED2', ms: 3500, view: { pins: ['PA1'], from: 0, to: 3500000 } },
      clearcmp: { compare: ['timOk', 'timNoClear'] },
      timOk: { title: '清了 UIF', ms: 2500, view: { pins: ['PA1'], from: 0, to: 2500000 } },
      timNoClear: { title: '忘了清 UIF', ms: 2500, patch: { TIM6_IRQHandler: { order: [0, 2, 3] } }, view: [{ pins: ['PA1'], from: 0, to: 2500000 }, { pins: ['PA1'], from: 1000000, to: 1000020, label: '放大 1 秒之后的 20 µs：' }] },
      nvic: { title: '忘了 NVIC_EnableIRQ', ms: 2500, patch: { tim6_init: { order: [0, 1, 2, 3, 4, 5, 6, 8] } }, view: { pins: ['PA1'], from: 0, to: 2500000 } },
      ugcmp: { compare: ['ugYes', 'ugNo'] },
      ugYes: { title: '用 UG 并清 UIF', ms: 2500, view: [{ pins: ['PA1'], from: 0, to: 2500000 }, { pins: ['PA1'], from: 0, to: 400, label: '开头 0.4 ms：' }] },
      ugNo: { title: '课件写法：没有 UG', ms: 2500, patch: { tim6_init: { order: [0, 1, 2, 5, 6, 7, 8] } }, view: [{ pins: ['PA1'], from: 0, to: 2500000 }, { pins: ['PA1'], from: 0, to: 400, label: '开头 0.4 ms：' }] },
      pwm: { title: 'PWM 20%', ms: 6, entry: ['main_pwm'], view: { pins: ['PA1'], from: 0, to: 5000 } },
      polcmp: { compare: ['pwm', 'pwmHigh'] },
      pwmHigh: { title: 'CC2P = 0（高电平有效）', ms: 6, entry: ['main_pwm'], patch: { pwm_init: { set: { 7: { c: 'TIM5->CCER |= TIM_CCER_CC2E;' } } } }, view: { pins: ['PA1'], from: 0, to: 5000 } },
      breathe: { title: '呼吸灯', ms: 2000, entry: ['main_breathe'], view: [{ pins: ['PA1'], from: 0, to: 2000000 }, { pins: ['PA1'], from: 250000, to: 254000, label: '放大 0.25 s 处的 4 ms：' }, { pins: ['PA1'], from: 750000, to: 754000, label: '放大 0.75 s 处的 4 ms：' }] }
    }
  };
})();
