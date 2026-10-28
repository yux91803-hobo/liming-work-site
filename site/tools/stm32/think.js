/* think.js — 「编程思维」教学内容（数据，不含界面）
   每章四段：why 为什么（问题与设计推演）→ skel 思路骨架（每步：为什么、跳过会怎样、寄存器 / HAL 写法）→ tasks 自己推一遍 / 换个需求。
   通用骨架 SK：几乎所有外设程序都是「开时钟 → 配引脚 → 设参数 → 使能 → 运行」，每章都往这五格里填东西。

   题目类型：
     choice  单选。opts[{t, ok, why}]：选错时显示这个选项自己的 why（针对这个误解的提示），再选；选对显示 explain。
     order   排序。items 按正确顺序给出；rank 相同的可以互换；每项的 hint 在它放错位置时显示。
     fill    填空。answers 里任意一个算对（忽略大小写和空格）；hints 每错一次多给一条。
     parsons 拼代码。lines 按正确顺序；extra 是干扰行（各带 why）。
     info    只是说明，没有题。
   link：题目旁的「打开计算器 / 看片段 / 看图」按钮，{ reg, i, val } / { snip } / { fig } / { pin }。
   注意：推演是教学上的「如果让你来设计」，不是历史；硬件细节以 RM0008 和板子原理图为准。 */
window.STM32_THINK = {
  SK: [
    { id: 'clk', name: '开时钟', what: '在 RCC 里给要用的硬件接上时钟' },
    { id: 'pin', name: '配引脚', what: '告诉引脚：听谁的、输入还是输出、电路怎么接' },
    { id: 'cfg', name: '设参数', what: '外设自己的设置：速率、格式、模式' },
    { id: 'en', name: '使能', what: '设置都写好以后，打开外设的总开关' },
    { id: 'run', name: '运行', what: '循环里做的事：写数据、等标志、读结果' }
  ],

  chapters: [
  /* =========================================================== GPIO */
  {
    id: 'gpio', topic: 'gpio', title: 'GPIO：让程序控制一盏灯',
    goal: '让开发板上的 LED1（PA0）每 0.5 秒闪一次。',
    why: [
      { title: '一个看起来很简单的需求',
        text: ['你写了一行 C 代码，想让桌上的一盏 LED 亮起来。',
          'CPU 做的事说到底主要是两类：算数，和把数据从一个地方搬到另一个地方。而 LED 要的是电——它两端要有电压，才会有电流流过、才会亮。',
          '所以问题变成：怎样让 CPU 里的「一个数」，变成芯片引脚上的「一个电压」？'],
        q: { type: 'choice', q: '如果让你来设计，最直接的思路是什么？',
          opts: [
            { t: '在芯片里放一个能记住 0 / 1 的小格子，CPU 往里写数；再用一个电路根据格子里的值，把引脚接到 3.3V 或接到地', ok: true },
            { t: '让 CPU 每时每刻都盯着引脚，亲自输出电压', why: 'CPU 一会儿要算别的东西，不可能一直守着引脚。我们需要一个能「记住」输出值的地方，CPU 写一次就不用管了。' },
            { t: '把 LED 直接接在 CPU 的数据线上', why: 'CPU 内部的数据线一刻不停地在传各种数据，LED 接上去只会乱闪，而且内部信号也驱动不了外面的负载。需要一个「记住 + 驱动」的中间环节。' }
          ],
          explain: '对。这个能记住值、又有固定地址让 CPU 去写的小格子，就叫「寄存器」。把它的值变成引脚电压的电路，叫「输出驱动」。下面一步步把它们设计出来。' } },
      { title: '设计一：一个有门牌号的格子',
        text: ['我们在芯片里放一排格子，每个格子记住一位 0 或 1，一个格子对应一个引脚。这一排格子叫「输出数据寄存器」，名字是 ODR。',
          'CPU 怎么找到它？给它分配一个地址，就像内存里的一个变量。CPU 往这个地址写数据，格子就记下来；不再写，它就一直保持。',
          'STM32 把所有外设的寄存器都排在地址空间里，比如 GPIOA 的 ODR 就在 0x4001 080C。C 语言里写 GPIOA->ODR，编译出来就是读写这个地址。'],
        note: '寄存器 = 有地址的存储格子，但它的每一位都连着真实的硬件电路。' },
      { title: '设计二：把 0 / 1 变成电压',
        text: ['格子里记着 1 或 0，引脚上要变成 3.3V 或 0V。最常见的电路是用两个开关：一个接 3.3V，一个接地，同一时间只闭合一个。写 1 时上面的闭合，引脚被推到 3.3V；写 0 时下面的闭合，引脚被拉到地。这叫「推挽输出」。',
          '另一种只保留下面那个开关：写 0 时拉到地，写 1 时两个都断开、引脚悬空，要靠外面的电阻把它拉高。这叫「开漏输出」，后面学 I2C 时你会发现它为什么必不可少。'],
        fig: 'gpio-out',
        q: { type: 'choice', q: '板上 LED1 的接法是：3.3V → 电阻 → LED → PA0。要让它亮，PA0 应该输出什么？',
          opts: [
            { t: '低电平（0V）', ok: true },
            { t: '高电平（3.3V）', why: 'LED 的另一端已经接在 3.3V 上了。PA0 也输出 3.3V 的话，两端没有电压差，就没有电流流过。' },
            { t: '高低都行，LED 不分方向', why: 'LED 是二极管，只有电流从正极流向负极时才亮。这里电流要从 3.3V 流进 PA0，所以 PA0 必须更低。' }
          ],
          explain: '对，这个灯是「低电平点亮」：往 ODR 写 0 亮，写 1 灭。开发板页面里每个资源都标了高 / 低电平有效。' } },
      { title: '设计三：同一个脚，有时要「听」',
        text: ['引脚不光要输出。接按键时，CPU 要知道外面现在是高是低，这时候引脚要「听」：把电压读进来，存到另一个格子里，叫「输入数据寄存器」IDR。',
          '同一个脚到底在说还是在听，必须有地方记着。于是每个引脚又配了 4 位设置：MODE 两位决定是输入还是输出（输出时顺便选最快能多快），CNF 两位决定具体用哪种电路。0~7 号脚的设置放在 CRL，8~15 号放在 CRH。'],
        q: { type: 'choice', q: '为什么不能让引脚一直同时开着输出电路和输入电路？',
          opts: [
            { t: '按键会把引脚接到地，而输出电路正推着高电平，两边「打架」，电流很大，读到的值也不对', ok: true },
            { t: '因为芯片规定一个时刻只能干一件事', why: '电路本身可以同时工作，问题出在电：输出在推高，按键在拉低，等于把 3.3V 直接接地。' },
            { t: '只是为了省电', why: '省电是次要的。真正的问题是外部电路和输出电路会互相冲突。' }
          ],
          explain: '对。所以引脚复位后默认是「浮空输入」：只听不说，最安全。想让它输出，必须由程序明确改设置。' } },
      { title: '设计四：为什么先要「开时钟」',
        text: ['芯片里有几十个外设，寄存器电路都要靠时钟一拍一拍地工作。如果全部一直开着，就算用不到也在耗电。',
          '所以 STM32 默认把大部分外设的时钟关着，由 RCC（复位和时钟控制）里的一排开关决定给谁供时钟。时钟没开时，往那个外设的寄存器里写，什么也记不住。'],
        q: { type: 'choice', q: '你配置好了 PA0 却忘了开 GPIOA 的时钟，会发生什么？',
          opts: [
            { t: '写进去的配置都不生效，LED 一直不亮', ok: true },
            { t: '编译时报错', why: '编译器不知道你有没有开时钟，语法对就能编译通过。这类错误只能在板子上看现象来发现。' },
            { t: 'LED 常亮', why: '写不进去，PA0 就保持复位状态（浮空输入），不会往下拉，LED 没有电流，所以是灭的。' }
          ],
          explain: '对。「先开时钟」会出现在后面每一个外设里，它是骨架的第一步。' } },
      { title: '把设计连起来',
        text: ['从 CPU 到灯的整条路是这样的：',
          'CPU 往 RCC 写：给 GPIOA 开时钟 → 往 CRL 写：PA0 用推挽输出 → 往 ODR 写 0 或 1 → 输出电路把 PA0 接地或接 3.3V → LED 亮或灭。',
          '程序要做的事，就是按这个顺序，把每个格子写成你想要的值。下一段把它变成一份清单。'] }
    ],
    skel: {
      intro: 'GPIO 本身就是引脚，所以「设参数」和「使能」不用单独做：配好模式，引脚就开始工作了。',
      steps: [
        { sk: 'clk', title: '打开 GPIOA 的时钟', what: 'RCC_APB2ENR 的 IOPAEN 位置 1（GPIO 都挂在 APB2 总线上）。',
          why: 'GPIOA 的寄存器靠时钟工作，复位后时钟是关的。', skip: '后面所有对 GPIOA 的写入都被忽略，LED 不亮，调试器里看 GPIOA 的寄存器一直不变。',
          reg: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', hal: '__HAL_RCC_GPIOA_CLK_ENABLE();', link: { reg: 'RCC_APB2ENR' } },
        { sk: 'pin', title: '先定好初始电平：让 PA0 输出高（灯灭）', what: 'BSRR 写 BS0，把 ODR0 置 1。',
          why: '下一步一切换成输出，引脚马上输出 ODR 里的值。ODR 复位后是 0，不先改的话，切换瞬间灯会闪一下。CubeMX 生成的代码也是先写电平、再初始化引脚。',
          skip: '功能不受影响，只是上电时 LED 会先亮一下。驱动电机、继电器时，这种瞬间的错误输出可能有危险。',
          reg: 'GPIOA->BSRR = GPIO_BSRR_BS0;', hal: 'HAL_GPIO_WritePin(GPIOA, GPIO_PIN_0, GPIO_PIN_SET);', link: { reg: 'GPIO_BSRR', i: 'GPIOA' } },
        { sk: 'pin', title: '把 PA0 设成推挽输出', what: 'CRL 低 4 位写 0011：MODE0 = 11（输出，最快 50 MHz），CNF0 = 00（推挽）。',
          why: '复位后引脚是浮空输入，只听不说。不改成输出，ODR 写什么都到不了引脚。',
          skip: '引脚还是输入，LED 一直不亮（不会往下拉）。',
          trap: '不要写 GPIOA->CRL = 3：那会把 PA1~PA7 的设置全改成 0000（模拟输入）。只改 PA0 那 4 位，其他位原样保留，这叫「读-改-写」。',
          reg: 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0)) | GPIO_CRL_MODE0;', hal: 'GPIO_InitStruct.Pin = GPIO_PIN_0;\nGPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;\nGPIO_InitStruct.Pull = GPIO_NOPULL;\nGPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;   /* = MODE 11，50 MHz；点灯用 LOW（2 MHz）也完全够 */\nHAL_GPIO_Init(GPIOA, &GPIO_InitStruct);',
          link: { reg: 'GPIO_CRL', i: 'GPIOA', val: '0x44444443' } },
        { sk: 'run', title: '循环：翻转 PA0，等 0.5 秒', what: 'ODR 的第 0 位取反，然后延时 500 ms，一直重复。',
          why: '闪烁就是「亮—等—灭—等」的重复。HAL_Delay 靠 SysTick 每 1 ms 计一次数，CubeMX 工程默认已经配好。',
          skip: '不延时的话，灯一秒翻转几百万次，眼睛分辨不出来，看起来是一直半亮。',
          reg: 'GPIOA->ODR ^= GPIO_ODR_ODR0;\nHAL_Delay(500);', hal: 'HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_0);\nHAL_Delay(500);' }
      ],
      program: [
        { s: -1, code: '/* main.c 里 HAL_Init()、SystemClock_Config() 之后 */' },
        { s: 0, code: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;          /* 1 开时钟 */' },
        { s: 1, code: 'GPIOA->BSRR = GPIO_BSRR_BS0;                 /* 2 先输出高：灯灭 */' },
        { s: 2, code: 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0))\n           | GPIO_CRL_MODE0;                 /* 3 PA0 推挽输出 50MHz */' },
        { s: -1, code: 'while (1)\n{' },
        { s: 3, code: '  GPIOA->ODR ^= GPIO_ODR_ODR0;               /* 4 翻转 */\n  HAL_Delay(500);' },
        { s: -1, code: '}' }
      ]
    },
    tasks: [
      { id: 'blink', kind: 'guided', title: '让 LED1 每 0.5 秒闪一次', goal: '只看需求，一步步自己推出程序。',
        gists: ['闪灯靠 GPIO：引脚电平按时间变化。', 'LED1 在 PA0，低电平点亮。', '顺序：开时钟 → 先定电平 → 设推挽输出 → 循环里翻转、延时。', '漏开时钟：写什么都无效，灯不亮。', 'PA0 推挽 50 MHz：CRL 低 4 位 = 0011。', '改 CRL 要读-改-写，只动 PA0 那 4 位。', '程序拼好了：每一行对应骨架的一格。'],
        qs: [
          { type: 'choice', q: '要让 LED1 闪，主要靠哪个外设？',
            opts: [
              { t: 'GPIO', ok: true },
              { t: 'USART 串口', why: '串口是用来和另一台设备收发数据的。这里只需要一根线变高变低。' },
              { t: '定时器', why: '定时器以后可以替你计时，但「让引脚变高变低」这件事归 GPIO 管。先用最简单的延时。' }
            ], explain: '对。闪烁 = 引脚电平按时间变化，引脚归 GPIO 管。' },
          { type: 'choice', q: 'LED1 接在哪个脚，怎样点亮？（可以去「开发板」页查）', link: { pin: 34 },
            opts: [
              { t: 'PA0，输出低电平点亮', ok: true },
              { t: 'PA0，输出高电平点亮', why: '看原理图：3.3V → 电阻 → LED → PA0。电流要从 3.3V 流进 PA0，PA0 必须是低电平。' },
              { t: 'PA1，输出低电平点亮', why: 'PA1 接的是 LED2（蓝灯）。LED1（黄灯）在 PA0。' }
            ], explain: '对。记住：这块板子上三颗 LED 都是低电平点亮。' },
          { type: 'order', q: '把这些步骤排成正确的顺序（点选，依次放进下面）。',
            items: [
              { t: '打开 GPIOA 的时钟', rank: 1, hint: '没开时钟之前，对 GPIOA 的任何写入都会被忽略，所以它必须最先。' },
              { t: '让 PA0 先输出高电平（灯灭）', rank: 2, hint: '电平要在切换成输出之前定好，否则切换瞬间引脚输出的是 ODR 的旧值 0，灯会闪一下。' },
              { t: '把 PA0 设成推挽输出', rank: 3, hint: '模式要在开时钟之后；先定电平再切输出更稳妥。' },
              { t: '循环里翻转 PA0', rank: 4, hint: '翻转和延时是循环里反复做的事，要放在所有初始化之后。' },
              { t: '循环里延时 0.5 秒', rank: 4, hint: '翻转和延时是循环里反复做的事，要放在所有初始化之后。' }
            ], explain: '这就是 GPIO 版的骨架：开时钟 → 配引脚 → 运行。' },
          { type: 'choice', q: '如果第一步漏掉了，你在板子上会看到什么？',
            opts: [
              { t: 'LED 一直不亮', ok: true },
              { t: '编译报错', why: '编译器只检查语法，不知道硬件有没有时钟。这类错误编译能过，只能看现象。' },
              { t: 'LED 一直亮着', why: '写不进去，PA0 保持复位状态（浮空输入），不会往下拉，所以灯是灭的。' }
            ], explain: '对。以后遇到「怎么配都没反应」，第一个就查时钟。' },
          { type: 'fill', q: 'PA0 推挽输出、最快 50 MHz：CRL 里 PA0 那 4 位（CNF0 MODE0）应该是多少？写成 4 位二进制。',
            link: { reg: 'GPIO_CRL', i: 'GPIOA' },
            answers: ['0011', '0b0011', '0x3', '3'],
            hints: ['MODE 是低 2 位：11 表示输出、最快 50 MHz。', '输出时 CNF 是高 2 位：00 表示通用推挽。', '高 2 位 CNF = 00，低 2 位 MODE = 11，合起来是 0011。'],
            explain: '对，0011。复位值是 0100（浮空输入），所以要改。打开计算器，在 PA0 那组里选一下就能看到同样的结果。' },
          { type: 'choice', q: '同学写了 GPIOA->CRL = 0x3; LED 确实闪了，但 PA1 上的 LED2 再也控制不了。为什么？',
            opts: [
              { t: '这样写把整个 CRL 都覆盖了，PA1~PA7 的设置被改成 0000（模拟输入）', ok: true },
              { t: '0x3 这个值本身就是错的', why: 'PA0 那 4 位确实应该是 0011，问题出在另外 28 位。' },
              { t: 'CRL 只能写一次', why: 'CRL 可以随时读写。问题是整寄存器赋值会改到别的脚。' }
            ], explain: '对。正确做法是「读-改-写」：先读出 CRL，只把 PA0 那 4 位清零再填新值，其他位不动。这个坑课件里也出现过（勘误有记录）。' },
          { type: 'parsons', q: '把代码行按顺序拼起来（有两行是干扰项，不要用）。',
            lines: ['RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', 'GPIOA->BSRR = GPIO_BSRR_BS0;', 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0)) | GPIO_CRL_MODE0;', 'while (1) {', '  GPIOA->ODR ^= GPIO_ODR_ODR0;', '  HAL_Delay(500);', '}'],
            extra: [
              { t: 'GPIOA->CRL = 0x3;', why: '整寄存器赋值会把 PA1~PA7 的设置也改掉，用读-改-写那一行。' },
              { t: 'RCC->APB1ENR |= RCC_APB2ENR_IOPAEN;', why: 'GPIO 挂在 APB2 上，IOPAEN 是 APB2ENR 里的位，写到 APB1ENR 就开错了开关。' }
            ], explain: '完整程序拼出来了。每一行都能说出它属于骨架的哪一步。' }
        ],
        final: { title: '上板验证', check: [
          '正常：LED1（黄灯）每 0.5 秒亮灭一次。',
          '一直不亮：先查第 1 行时钟，再查 CRL 那一行（调试器里看 GPIOA->CRL 低 4 位是不是 0011）。',
          '一直亮、不闪：看程序是不是卡在循环之前；HAL_Delay 不返回通常是 SysTick 没在走（不是 CubeMX 生成的工程时要注意）。',
          '上电先亮一下再开始闪：初始电平那一行放到了模式之后。'] } },
      { id: 'key', kind: 'transfer', title: '换个需求：按住 KEY1 时 LED1 亮，松开灭', goal: '同一套骨架，多了一个「输入」引脚。',
        gists: ['多了一个输入脚：开 GPIOF 时钟，配置 PF8。', '按下接地、板上没有上拉 → PF8 用上拉输入。', 'PF8 在 CRH 低 4 位，上下拉输入 = 1000。', '上拉还是下拉由 ODR8 决定：写 1 是上拉。', '读 IDR8：等于 0 表示按下。', '骨架不变：开两个端口时钟 → 一个输出、一个输入 → 循环里读入、写出。'],
        qs: [
          { type: 'choice', q: '和闪灯相比，骨架里多出来了什么？',
            opts: [
              { t: '要再开一个端口的时钟，并把 KEY1 的引脚配成输入', ok: true },
              { t: '要换一个外设，比如 EXTI 中断', why: '中断是另一种做法（下一章）。最简单的是在循环里不停地读引脚，只用 GPIO 就够了。' },
              { t: '什么都不多，循环里改一下就行', why: 'KEY1 接在另一个引脚上，那个引脚也要开时钟、配模式，否则读不到。' }
            ], explain: '对。KEY1 接在 PF8，所以要开 GPIOF 的时钟，并配置 PF8。' },
          { type: 'choice', q: 'KEY1 的接法是：按下时 PF8 接地，板上没有外部上拉电阻。PF8 应该配成？', link: { pin: 'PF8' },
            opts: [
              { t: '上拉输入', ok: true },
              { t: '浮空输入', why: '松开时 PF8 什么都没接，电平随干扰乱跳，读到的值不可靠。需要一个电阻把它稳定在高电平。' },
              { t: '下拉输入', why: '按下是接地（低），下拉的话松开也是低，按与不按读到的都是 0。' }
            ], explain: '对：松开时上拉电阻让它保持高电平，按下时被拉到低电平。' },
          { type: 'fill', q: '上拉 / 下拉输入的 4 位是 CNF = 10、MODE = 00。PF8 在 CRL 还是 CRH？它那 4 位写成二进制是？（只填 4 位）',
            link: { reg: 'GPIO_CRH', i: 'GPIOF' },
            answers: ['1000', '0b1000', '0x8', '8'],
            hints: ['8 号脚在 CRH 的最低 4 位（CRL 只管 0~7 号）。', 'CNF 在高 2 位、MODE 在低 2 位：10 和 00。'],
            explain: '对，1000，写在 GPIOF->CRH 的低 4 位。' },
          { type: 'choice', q: '1000 只说明「带上下拉的输入」。到底是上拉还是下拉，由什么决定？',
            opts: [
              { t: 'ODR 里这一位：写 1 是上拉，写 0 是下拉', ok: true },
              { t: '由 CNF 的两个位决定', why: 'CNF = 10 只表示「有上下拉」，两种情况一样。区分上下的是 ODR 那一位。' },
              { t: '芯片自动判断', why: '芯片不知道外面怎么接，必须由程序指定。' }
            ], explain: '对。输入模式下 ODR 那一位不再控制输出，而是用来选上拉 / 下拉。所以要写 GPIOF->BSRR = GPIO_BSRR_BS8。' },
          { type: 'choice', q: '循环里怎么知道 KEY1 被按下了？',
            opts: [
              { t: '读 GPIOF->IDR 的第 8 位，等于 0 就是按下', ok: true },
              { t: '读 GPIOF->ODR 的第 8 位', why: 'ODR 记的是「你想输出的值」（这里是上拉选择），引脚上实际的电平要看 IDR。' },
              { t: '读 GPIOF->IDR 的第 8 位，等于 1 就是按下', why: '上拉输入松开时是 1，按下接地才是 0。' }
            ], explain: '对：if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) 表示按下。' },
          { type: 'parsons', q: '拼出完整程序（有一行干扰项）。',
            lines: ['RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_IOPFEN;', 'GPIOA->BSRR = GPIO_BSRR_BS0;', 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0)) | GPIO_CRL_MODE0;', 'GPIOF->BSRR = GPIO_BSRR_BS8;', 'GPIOF->CRH = (GPIOF->CRH & ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8)) | GPIO_CRH_CNF8_1;', 'while (1) {', '  if ((GPIOF->IDR & GPIO_IDR_IDR8) == 0) GPIOA->BSRR = GPIO_BSRR_BR0;', '  else GPIOA->BSRR = GPIO_BSRR_BS0;', '}'],
            extra: [{ t: '  if ((GPIOF->ODR & GPIO_ODR_ODR8) == 0) GPIOA->BSRR = GPIO_BSRR_BR0;', why: '读按键要看 IDR（引脚实际电平），ODR 这一位在这里只表示上拉。' }],
            explain: '和闪灯是同一个骨架：开时钟（两个端口）→ 配引脚（一个输出、一个上拉输入）→ 运行（读输入、写输出）。' }
        ],
        final: { title: '上板验证', check: ['按住 KEY1 灯亮，松开灯灭。', '一直亮：多半读的是 ODR，或者上下拉选反了（下拉时松开也读到 0）。', '一直不亮：查 GPIOF 时钟和 CRH 那一行。'] } },
      { id: 'flow', kind: 'transfer', title: '再换一个：三颗灯轮流亮（流水灯）', goal: '三颗 LED：PA0、PA1、PA8。有一个小陷阱。',
        gists: ['PA0、PA1 在 CRL，PA8 在 CRH。', 'PA8 推挽 50 MHz：CRH 低 4 位 = 0011。', '同时改几个脚用 BSRR：一次写入，不碰其他脚。'],
        qs: [
          { type: 'choice', q: '三颗灯的模式设置分别写在哪个寄存器？',
            opts: [
              { t: 'PA0、PA1 在 GPIOA->CRL，PA8 在 GPIOA->CRH', ok: true },
              { t: '都在 GPIOA->CRL', why: 'CRL 只管 0~7 号脚，PA8 是 8 号，它的设置在 CRH 的最低 4 位。' },
              { t: '分别在 GPIOA、GPIOB、GPIOC', why: '三个都是 A 口（PA），同一个端口，只是号码不同。' }
            ], explain: '对。这是常见的漏网之鱼：只改了 CRL，PA8 那颗灯不亮。' },
          { type: 'fill', q: 'PA8 推挽输出 50 MHz，写在 CRH 的哪 4 位、值是多少？（填 4 位二进制）', link: { reg: 'GPIO_CRH', i: 'GPIOA' },
            answers: ['0011', '0b0011', '0x3', '3'], hints: ['和 PA0 的设置完全一样，只是换了寄存器：CRH 的最低 4 位就是 8 号脚。'], explain: '对，0011，写在 CRH 的 [3:0]。' },
          { type: 'choice', q: '要点亮 LED2 同时熄灭 LED1，最好怎么写？',
            opts: [
              { t: 'GPIOA->BSRR = GPIO_BSRR_BR1 | GPIO_BSRR_BS0;  一次写入同时改两个脚', ok: true },
              { t: '先 GPIOA->ODR = 0; 再 GPIOA->ODR = ...', why: '整体写 ODR 会把 A 口其他输出脚也一起改掉；中间那一瞬间所有灯都是同一状态。' },
              { t: '必须分两条语句，一次只能改一个脚', why: 'BSRR 的每一位独立：低 16 位置高、高 16 位拉低，一次写入可以同时改多个脚，而且不影响没写 1 的脚。' }
            ], explain: '对。BR1 拉低 PA1（LED2 亮），BS0 拉高 PA0（LED1 灭），一次完成，别的脚不受影响。' }
        ],
        final: { title: '上板验证', check: ['三颗灯依次亮起、循环。', '第三颗（PA8，绿灯）不亮：检查是不是只改了 CRL。'] } }
    ]
  },

  /* =========================================================== USART */
  {
    id: 'usart', topic: 'usart', title: 'USART：让单片机和电脑说话',
    goal: '让 STM32 每秒给电脑发送一行 "hello"，在串口助手里看到。',
    why: [
      { title: '两台设备要交换数据',
        text: ['单片机测到了温度，想告诉电脑；电脑想给单片机下命令。它们之间要传的是一个个字节。',
          '最直接的办法是并行：拉 8 根线，一根线负责一位，一次传完一个字节。但线多、接口大，距离一长 8 根线的信号还会对不齐。'],
        q: { type: 'choice', q: '如果只给你一根数据线，怎么传一个字节？',
          opts: [
            { t: '把 8 位一位一位地轮流放到线上，对方一位一位地收', ok: true },
            { t: '用 8 种不同的电压表示 8 位', why: '电压分得越细越容易受干扰读错。数字电路只用高、低两种电平最可靠。' },
            { t: '一根线做不到', why: '可以：拿时间换线，轮流发送每一位。这就叫「串行」。' }
          ], explain: '对，这就是「串行通信」。代价是要多花时间，但只要一根线（双向就两根：TX 发、RX 收）。' } },
      { title: '问题：对方什么时候读下一位？',
        text: ['发送方每隔一段时间换一位。接收方必须在每一位的中间去读，读早了读晚了都会读到相邻的位。',
          '办法有两种：再拉一根线专门打拍子（同步，比如后面的 I2C、SPI）；或者双方事先约好「每一位持续多久」，各自按自己的时钟计时（异步）。USART 平时用的是异步，这个约好的速度叫「波特率」，比如 115200 表示每秒 115200 位。'],
        q: { type: 'choice', q: '单片机按 115200 发，电脑串口助手却设成 9600，会看到什么？',
          opts: [
            { t: '一堆乱码', ok: true },
            { t: '什么都收不到', why: '线上确实有信号，电脑也在收，只是按错误的节拍去读每一位，拼出来的字节都不对。' },
            { t: '收得慢一点，但内容正确', why: '接收方不会自动适应，它只按自己设定的速度读，速度不一致就读错。' }
          ], explain: '对。乱码 → 第一个怀疑波特率（或者单片机的时钟根本不是你以为的频率）。' } },
      { title: '问题：一个字节从哪儿开始？',
        text: ['线上没数据时一直是高电平（空闲）。接收方怎么知道「现在开始了」？',
          '约定：先发一位低电平当「起始位」，接收方一看到高变低，就开始计时；然后发 8 个数据位，低位在前；最后发一位高电平当「停止位」，回到空闲。',
          '这个格式记作 8N1：8 个数据位、无校验（None）、1 个停止位。双方都要用同样的格式。'],
        q: { type: 'choice', q: '为什么最后一定要有一个高电平的停止位？',
          opts: [
            { t: '保证下一个字节的起始位（高变低）一定能被看出来', ok: true },
            { t: '为了凑够 10 位', why: '不是凑数：如果最后一位数据正好是 0，没有停止位就不会回到高电平，下一个起始位的「高变低」就看不出来了。' },
            { t: '告诉对方数据是对的', why: '检查数据对不对是校验位的事（8N1 里没用）。停止位只是让线回到空闲。' }
          ], explain: '对。起始位和停止位一头一尾，把每个字节框起来。' } },
      { title: '把活交给硬件：USART 外设',
        text: ['如果让 CPU 自己按时间去拉高拉低引脚，它就别干别的了。所以芯片里有专门的 USART 电路：你把一个字节写进它的数据寄存器 DR，它自己按波特率加上起始位、停止位，一位一位送出 TX 引脚。',
          'CPU 写得太快怎么办？DR 只能放一个字节。USART 用一个状态标志告诉你：TXE = 1 表示「发送数据寄存器空了，可以写下一个」。接收也一样，RXNE = 1 表示「收到一个字节了，来读吧」。',
          '「先看标志，再读写数据」，这个习惯会贯穿后面所有的通信外设。'] },
      { title: '它和你学过的东西怎么连起来',
        text: ['USART 也是外设，所以也要先开时钟：USART1 挂在 APB2（72 MHz）上，开关在 RCC_APB2ENR。',
          'TX 信号要从 PA9 出去。PA9 是 GPIO 的引脚，这时它不能再听 ODR 的，而要交给 USART 驱动，这叫「复用功能」：在 CRH 里把 PA9 配成「复用推挽输出」。上一章学的 CRL / CRH，在这里直接用上了。',
          '于是骨架的五格都要填：开时钟（GPIOA + USART1）→ 配引脚（PA9 复用推挽）→ 设参数（波特率）→ 使能（USART 和发送器）→ 运行（等 TXE、写 DR）。'] }
    ],
    skel: {
      intro: '五格全用上：这是最典型的外设程序结构，后面的 I2C、SPI 都是它的变体。',
      steps: [
        { sk: 'clk', title: '打开 GPIOA 和 USART1 的时钟', what: 'RCC_APB2ENR 的 IOPAEN、USART1EN 置 1。',
          why: 'PA9 属于 GPIOA，发送电路属于 USART1，两个都要时钟。', skip: '少开 USART1：写 BRR、CR1 都没用，什么都发不出来。少开 GPIOA：PA9 配不成复用输出，同样收不到。',
          trap: 'USART1 用默认的 PA9 / PA10 时不需要开 AFIO 时钟。AFIO 只在重映射引脚、或给外部中断选线时才用。',
          reg: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_USART1EN;', hal: '__HAL_RCC_GPIOA_CLK_ENABLE();\n__HAL_RCC_USART1_CLK_ENABLE();', link: { reg: 'RCC_APB2ENR' } },
        { sk: 'pin', title: '把 PA9 配成复用推挽输出', what: 'CRH 里 PA9 那 4 位写 1011：MODE9 = 11，CNF9 = 10（复用推挽）。',
          why: '「复用」表示引脚由外设驱动，而不是 ODR。推挽能主动输出高低电平，适合只有一个发送方的 TX 线。',
          skip: '配成普通推挽：PA9 只听 ODR，USART 的波形到不了引脚，电脑什么也收不到。不配：PA9 是浮空输入，同样收不到。',
          reg: 'GPIOA->CRH = (GPIOA->CRH & ~(GPIO_CRH_CNF9 | GPIO_CRH_MODE9)) | GPIO_CRH_CNF9_1 | GPIO_CRH_MODE9;',
          hal: 'GPIO_InitStruct.Pin = GPIO_PIN_9;\nGPIO_InitStruct.Mode = GPIO_MODE_AF_PP;\nGPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;\nHAL_GPIO_Init(GPIOA, &GPIO_InitStruct);', link: { reg: 'GPIO_CRH', i: 'GPIOA' } },
        { sk: 'cfg', title: '设波特率：BRR = 0x271', what: '72 MHz ÷ (16 × 115200) = 39.0625：整数 39 写在高 12 位，小数 0.0625 × 16 = 1 写在低 4 位，合起来 0x271。帧格式 8N1 正好是复位值，不用改。',
          why: '波特率决定每一位持续多久，必须和电脑那边一致。', skip: '不写 BRR：值是 0，USART 不会正常工作。按 36 MHz 算（USART2 的总线频率）：速度差一倍，电脑上全是乱码。',
          reg: 'USART1->BRR = 0x271;', hal: 'huart1.Init.BaudRate = 115200;   /* HAL 按实际 PCLK2 自动算 BRR */', link: { reg: 'USART_BRR', i: 'USART1', val: '0x00000271' } },
        { sk: 'en', title: '打开 USART 和发送器', what: 'CR1 的 UE（总开关）和 TE（发送使能）置 1。',
          why: '参数都写好再开总开关；TE 打开后 TX 引脚才开始由发送器控制。', skip: '少 UE：整个 USART 不工作。少 TE：写 DR 也不会发出去。',
          reg: 'USART1->CR1 |= USART_CR1_UE | USART_CR1_TE;', hal: 'HAL_UART_Init(&huart1);   /* CubeMX 生成在 MX_USART1_UART_Init 里 */', link: { reg: 'USART_CR1', i: 'USART1' } },
        { sk: 'run', title: '发送一个字节：等 TXE，再写 DR', what: '先等 SR 的 TXE 变 1，再把字节写进 DR；发字符串就对每个字符重复。',
          why: 'DR 一次只放一个字节，上一个还没交给移位电路时写新的，会把它覆盖掉。', skip: '不等 TXE 连续写：后写的盖掉先写的，电脑上会丢字。',
          reg: 'while (!(USART1->SR & USART_SR_TXE)) {}\nUSART1->DR = c;', hal: 'HAL_UART_Transmit(&huart1, (uint8_t *)"hello\\r\\n", 7, HAL_MAX_DELAY);   /* 内部就是循环：等 TXE、写 DR */',
          link: { snip: 'printf 重定向到 USART1' } }
      ],
      program: [
        { s: -1, code: '/* HAL_Init()、SystemClock_Config() 之后：系统时钟 72 MHz */' },
        { s: 4, code: 'static void uart1_putc(char c)\n{\n  while (!(USART1->SR & USART_SR_TXE)) {}   /* 5 等发送数据寄存器空 */\n  USART1->DR = c;\n}' },
        { s: -1, code: 'static void uart1_puts(const char *s) { while (*s) uart1_putc(*s++); }\n' },
        { s: 0, code: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_USART1EN;   /* 1 */' },
        { s: 1, code: 'GPIOA->CRH = (GPIOA->CRH & ~(GPIO_CRH_CNF9 | GPIO_CRH_MODE9))\n           | GPIO_CRH_CNF9_1 | GPIO_CRH_MODE9;              /* 2 PA9 复用推挽 */' },
        { s: 2, code: 'USART1->BRR = 0x271;                                       /* 3 115200 @ 72MHz */' },
        { s: 3, code: 'USART1->CR1 |= USART_CR1_UE | USART_CR1_TE;                /* 4 */' },
        { s: -1, code: 'while (1)\n{' },
        { s: 4, code: '  uart1_puts("hello\\r\\n");                                 /* 5 */' },
        { s: -1, code: '  HAL_Delay(1000);\n}' }
      ]
    },
    tasks: [
      { id: 'hello', kind: 'guided', title: '每秒给电脑发一行 hello', goal: '从需求推到能运行的代码。',
        gists: ['和电脑通信用 USART1：PA9 发、PA10 收，走 STLink 虚拟串口。', '双方只约定波特率和帧格式：115200、8N1。', '顺序：开时钟 → PA9 复用推挽 → 设 BRR → 置 UE、TE → 等 TXE、写 DR。', 'PA9 复用推挽输出：那 4 位是 1011。', '用默认引脚，不用开 AFIO 时钟。', '72 MHz、115200：BRR = 0x271。', '写 DR 前必须等 TXE，否则丢字。', '乱码先查波特率和系统时钟；什么都收不到才查时钟、引脚、使能。', '程序拼好了：每一行对应骨架的一格。'],
        qs: [
          { type: 'choice', q: '板上哪个串口能直接和电脑通信？', link: { pin: 'PA9' },
            opts: [
              { t: 'USART1（PA9 TX / PA10 RX），接在 STLink 的虚拟串口上', ok: true },
              { t: 'USART2（PA2 / PA3）', why: '板上 PA2 / PA3 接的是 ESP32-C3 模块，不通电脑。' },
              { t: 'I2C2', why: 'I2C 是板上芯片之间用的，电脑那头没有 I2C。' }
            ], explain: '对。插上 STLink 的 USB，电脑上会多出一个 COM 口，就是它。' },
          { type: 'choice', q: '电脑串口助手设成 115200、8N1。单片机这边哪些必须和它一样？',
            opts: [
              { t: '波特率和帧格式（8 个数据位、无校验、1 个停止位）', ok: true },
              { t: '时钟频率也要一样', why: '双方的时钟可以完全不同，各自按约定的波特率分频计时就行。' },
              { t: '用的引脚号也要告诉电脑', why: '电脑只看线上的波形，不知道也不关心你用的是哪个脚。' }
            ], explain: '对。这就是「异步」：只约定速度和格式，不共用时钟。' },
          { type: 'order', q: '把初始化和发送的步骤排好。',
            items: [
              { t: '打开 GPIOA 和 USART1 的时钟', rank: 1, hint: '时钟永远第一：没开时钟，后面写的都无效。' },
              { t: '把 PA9 配成复用推挽输出', rank: 2, hint: '引脚在外设参数之前配，GPIO 时钟开了才能配。' },
              { t: '设置波特率 BRR', rank: 3, hint: '参数要在打开 USART（UE）之前写好。' },
              { t: '置 UE、TE：打开 USART 和发送器', rank: 4, hint: '使能放在所有设置之后：先设好，再开。' },
              { t: '等 TXE = 1，把字节写进 DR', rank: 5, hint: '这是运行阶段，要在使能之后。' }
            ], explain: '五格全齐：开时钟 → 配引脚 → 设参数 → 使能 → 运行。' },
          { type: 'choice', q: 'PA9 应该配成什么模式？',
            opts: [
              { t: '复用推挽输出', ok: true },
              { t: '通用推挽输出', why: '「通用」表示引脚听 ODR 的。USART 发出的波形到不了引脚，电脑什么也收不到。' },
              { t: '浮空输入', why: '那是 RX（PA10）的设置：接收脚要「听」。TX 要「说」。' }
            ], explain: '对：CNF9 = 10（复用推挽），MODE9 = 11，PA9 那 4 位是 1011。' },
          { type: 'choice', q: '还要不要打开 AFIO 的时钟？',
            opts: [
              { t: '不用，USART1 用的是默认引脚', ok: true },
              { t: '要，凡是复用功能都要开 AFIO', why: '这是很常见的误解。AFIO 只管「重映射」和「外部中断选线」。USART1 用默认的 PA9 / PA10，不需要它。' }
            ], explain: '对。如果要把 USART1 重映射到 PB6 / PB7，那才需要开 AFIO 并改 AFIO_MAPR。' },
          { type: 'fill', q: '系统时钟 72 MHz（USART1 挂在 APB2，也是 72 MHz），波特率 115200，BRR 应该写多少？（十六进制）',
            link: { reg: 'USART_BRR', i: 'USART1' },
            answers: ['0x271', '271', '0x0271', '0x00000271'],
            hints: ['先算 USARTDIV = 72000000 ÷ (16 × 115200) = 39.0625。', '整数部分 39 = 0x27，放在 BRR 的高 12 位，也就是左移 4 位。', '小数部分 0.0625 × 16 = 1，放在低 4 位。0x27 后面接 1。'],
            explain: '对，0x271。计算器里的「算波特率」可以替你算，误差也会显示出来。' },
          { type: 'choice', q: '如果不等 TXE，连续往 DR 写 "hello" 五个字母，电脑上大概会看到什么？',
            opts: [
              { t: '只收到一两个字母，中间的丢了', ok: true },
              { t: '完整的 hello，硬件会自动排队', why: 'DR 只能放一个字节，没有队列。上一个还在等着被送出时写新的，就把它覆盖了。' },
              { t: '编译报错', why: '语法没问题，编译器不知道硬件时序。' }
            ], explain: '对。CPU 比串口快得多：写 5 个字节用不了 1 微秒，串口发一个字节却要约 87 微秒。' },
          { type: 'choice', q: '程序跑起来了，电脑上收到的是乱码。最先该怀疑什么？',
            opts: [
              { t: '波特率不一致：BRR 算错，或者系统时钟其实不是 72 MHz', ok: true },
              { t: 'PA9 没配置', why: 'PA9 没配好通常是「什么都收不到」，而不是乱码。有乱码说明信号到了，只是节拍不对。' },
              { t: 'USART1 的时钟没开', why: '时钟没开，USART 根本不发，电脑什么都收不到。' }
            ], explain: '对。「什么都收不到」和「收到乱码」是两类问题，排查方向完全不同。' },
          { type: 'parsons', q: '拼出初始化和发送一个字符的代码（有两行干扰项）。',
            lines: ['RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_USART1EN;', 'GPIOA->CRH = (GPIOA->CRH & ~(GPIO_CRH_CNF9 | GPIO_CRH_MODE9)) | GPIO_CRH_CNF9_1 | GPIO_CRH_MODE9;', 'USART1->BRR = 0x271;', 'USART1->CR1 |= USART_CR1_UE | USART_CR1_TE;', 'while (!(USART1->SR & USART_SR_TXE)) {}', 'USART1->DR = \'A\';'],
            extra: [
              { t: 'USART1->BRR = 115200;', why: 'BRR 里放的不是波特率本身，而是分频系数：72 MHz ÷ (16 × 115200) 换算成的 0x271。' },
              { t: 'RCC->APB1ENR |= RCC_APB1ENR_USART2EN;', why: 'USART1 在 APB2 上；APB1 上的是 USART2 / 3。这里开错了串口。' }
            ], explain: '每一行都对应骨架里的一格。' }
        ],
        final: { title: '上板验证', check: [
          '串口助手选 STLink 对应的 COM 口，115200、8N1，每秒出现一行 hello。',
          '什么都收不到：COM 口选错了？USART1 时钟、UE / TE、PA9 的 CRH 设置。',
          '乱码：波特率；在调试器里看 RCC 确认系统时钟真的是 72 MHz。',
          '只有第一个字母：循环里没有等 TXE。'] } },
      { id: 'echo', kind: 'transfer', title: '换个需求：收到什么就发回什么', goal: '发送反过来就是接收，骨架不变。',
        gists: ['接收只改两格：使能加 RE，运行加「等 RXNE、读 DR」。', '收到数据看 RXNE；读 DR 会自动清掉它。', '来不及读会溢出（ORE），新字节丢失；数据多时用中断或 DMA。', '回显：等 RXNE 读一个，等 TXE 发回去。'],
        qs: [
          { type: 'choice', q: '要接收，骨架里哪几格要改？',
            opts: [
              { t: '使能多开 RE（接收器）；运行里多一个「等 RXNE、读 DR」', ok: true },
              { t: '要重新设一个接收用的波特率', why: '收发用同一个 BRR，双方约定的是同一个速度。' },
              { t: '要把 PA10 配成复用推挽输出', why: 'RX 是「听」的脚，保持浮空输入（复位值就是）或上拉输入即可。配成输出会和对方的 TX 打架。' }
            ], explain: '对。时钟、引脚、参数都已经有了，只改「使能」和「运行」两格。' },
          { type: 'choice', q: '怎么知道收到了一个字节？',
            opts: [
              { t: '等 SR 的 RXNE 变成 1，再读 DR', ok: true },
              { t: '等 TXE 变成 1', why: 'TXE 是发送那边的标志（发送寄存器空了）。接收看 RXNE（接收寄存器非空）。' },
              { t: '一直读 DR，不为 0 就是收到了', why: '对方完全可能发送 0x00。只有 RXNE 能准确告诉你「来了新数据」。' }
            ], explain: '对。读 DR 时 RXNE 自动清零，不用另外清。' },
          { type: 'choice', q: '如果收到了一个字节却迟迟不读 DR，下一个字节又到了，会怎样？',
            opts: [
              { t: 'SR 的 ORE（溢出）置 1，新到的字节丢失', ok: true },
              { t: '自动覆盖旧的，只丢旧字节', why: 'F1 上发生溢出时 DR 里还是旧数据，丢的是新到的那个，同时 ORE 置 1 提醒你。' },
              { t: '硬件会让对方等一等', why: '异步串口没有这种机制（除非另外接 RTS/CTS 流控线）。来不及读就会丢。' }
            ], explain: '对。数据多、来得快时，轮询容易来不及，这就是后面要用中断（片段「USART1 中断收发」）或 DMA 的原因。', link: { snip: 'USART1 中断收发' } },
          { type: 'parsons', q: '拼出回显程序（初始化之后的部分）。',
            lines: ['USART1->CR1 |= USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;', 'while (1) {', '  while (!(USART1->SR & USART_SR_RXNE)) {}', '  char c = USART1->DR;', '  while (!(USART1->SR & USART_SR_TXE)) {}', '  USART1->DR = c;', '}'],
            extra: [{ t: '  while (!(USART1->SR & USART_SR_TXE)) {}  /* 等收到 */', why: '等「收到」要看 RXNE，TXE 是发送用的。' }],
            explain: '先收后发，每一步都先看标志。这就是轮询方式的串口程序。' }
        ],
        final: { title: '上板验证', check: ['在串口助手里发任意字符，立刻收到同样的字符。', '发得很快时偶尔丢字：轮询来不及，下一步学中断接收。'] } }
    ]
  }
  ]
};
