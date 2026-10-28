/* derive-spi.js — 「编程思维」SPI 章：从「I2C 太慢」推到「读出板载 W25Q32 的 ID」
   数据结构见 derive-i2c.js 顶部说明；本章用通用单片机模拟器（mcusim.js）：SPI1 按 SCK 的每个边沿和板上的 W25Q32 模型交换数据。 */
(function () {
  'use strict';
  var D = window.STM32_DERIVE = window.STM32_DERIVE || {};

  D.spi = {
    id: 'spi', topic: 'spi', engine: 'mcu', defaultSc: 'id',
    title: 'SPI：为了更快，把 I2C 的设计一条条推翻',
    task: '用 SPI1 读出板载 Flash（W25Q32）的 JEDEC ID，打印出来。',
    intro: [
      '学过 I2C 再看 SPI，会觉得它的每一个设计都和 I2C 反着来：不用开漏用推挽、不用地址用片选、没有应答、收发同时进行……这不是巧合。',
      '这一章从一个具体的不满出发——读一颗 4 MB 的 Flash，I2C 太慢了——把 I2C 的每一条设计重新审视一遍：哪些是为了「两根线挂一串器件」付出的代价，换一个目标时能不能拿掉。'
    ],
    honesty: '说明：下面是「如果让我们自己来设计」的思路重建，不是 SPI 真实的发明过程（SPI 由摩托罗拉在 1980 年代提出，没有像 I2C 那样统一的官方规范，各家芯片的细节以自己的数据手册为准）。STM32 部分按 RM0008 和数据手册，Flash 部分按 Winbond W25Q32JV 数据手册，接线按开发板原理图。',

    facts: {
      F1: { t: '每根线只有一个方向、同一时刻只有一个驱动者：SCK、MOSI 由主机推挽驱动，MISO 只由被选中的从机驱动', short: '方向固定的线', from: 's2' },
      F2: { t: '片选 CS 拉低 = 选中并开始一次传输，拉高 = 结束；没被选中的从机必须放开 MISO', short: '片选', from: 's3' },
      F3: { t: '每个时钟交换一位：发一个字节的同时一定收一个字节；只想收也要发（常发 0xFF）', short: '全双工交换', from: 's4' },
      F4: { t: 'CPOL / CPHA 决定空闲电平和采样边沿，必须和从机一致（W25Q32 支持模式 0 和 3）', short: '时钟模式', from: 's5' },
      F5: { t: '主模式用软件管理 NSS：SSM = 1、SSI = 1，否则 NSS 引脚为低时会 MODF，SPI 自己关掉', short: 'NSS 与 MODF', from: 's8' }
    },

    stages: [
      { id: 'A', name: '为了快，重新设计', desc: '推挽与方向固定的线、片选、全双工、时钟模式、没有应答' },
      { id: 'B', name: '落到 W25Q32 和 STM32 上', desc: '指令、NSS 与 MODF、SCK 频率、TXE / RXNE' },
      { id: 'C', name: '从任务需求推到代码', desc: '事件表 → 一行行代码 → 读出 EF 40 16' },
      { id: 'D', name: '换个需求，自己再推一遍', desc: '读出 Flash 里的数据' }
    ],

    steps: [
    {
      id: 's1', stage: 'A', q: '已经有 I2C 了，为什么还要另一种总线？',
      beats: [
        { k: 'need', t: '开发板上有一颗 **W25Q32**：一颗 4 MB（32 Mbit）的 Flash，可以存字库、图片、日志。设想要把它整颗读一遍。' },
        { k: 'test', t: ['用 I2C 标准模式（100 kHz）：每个字节 9 个时钟（8 位 + 应答），4 MB 就是 4 194 304 × 9 ÷ 100 000 ≈ **377 秒**。快速模式 400 kHz 也要 94 秒。', '读一张 100 KB 的图片要 2 ~ 9 秒，界面卡得没法用。'] },
        { k: 'ask', id: 'p1-a', type: 'choice', q: '回想 I2C 章：是什么把 I2C 的速度卡住了？（选最根本的一条）',
          opts: [
            { t: '开漏 + 上拉：线变成 1 只能靠上拉电阻给线上的电容慢慢充电，上升沿慢，时钟不能太快', ok: true },
            { t: 'STM32 的时钟不够快', assume: '速度只取决于 CPU', counter: 'STM32 跑 72 MHz，比 400 kHz 快了近 200 倍。瓶颈在线上：I2C 章算过，上拉电阻和总线电容决定了上升时间，快速模式只允许 300 ns。', back: 's1' },
            { t: '每个字节要多一个应答位', assume: '应答是主要开销', counter: '应答只让每字节多了 1/8 的时间，是小头。真正限制频率的是上升沿：开漏的 1 是「等」出来的。', back: 's1' }
          ],
          explain: '对。I2C 选开漏是为了让多个器件安全地共用同一根线、还能互相应答——这些都是为「两根线挂一串器件」付出的代价。如果只追求快，能不能换一种做法？' },
        { k: 'idea', t: '那就反过来：每根线都用**推挽**驱动，0 和 1 都由管子主动推出来，边沿又陡又快，几十 MHz 都没问题。' }
      ],
      gist: 'I2C 读 4 MB 要几十到几百秒。根本限制是开漏 + 上拉的慢上升沿 → 想快就要用推挽驱动每根线。',
      next: '可是 I2C 章推过：两个推挽输出接在同一根线上会短路。用推挽，多个器件还能共用线吗？',
      refs: [{ t: 'Winbond W25Q32JV 数据手册：32 Mbit 串行 Flash' }],
      links: [{ sch: 'board-05' }]
    },

    {
      id: 's2', stage: 'A', q: '改成推挽，几个器件还能共用线吗？', from: 's1',
      beats: [
        { k: 'trouble', t: 'I2C 的 SDA 上，主机和从机轮流说话。如果 SDA 用推挽，主机推 1、从机拉 0 的那一瞬间就是短路（I2C 章问题 3 的同类问题）。' },
        { k: 'fix', t: ['那就别让两方共用一根数据线：**每个方向一根线，每根线永远只有一个人驱动**。', '· **MOSI**（主出从入）：只有主机驱动；', '· **MISO**（主入从出）：只有从机驱动；', '· **SCK**（时钟）：只有主机驱动。', '一根线只有一个驱动者，推挽就不会打架。'] },
        { k: 'ask', id: 'p2-a', type: 'choice', q: '可板子上 SPI1 接了两个从机（W25Q32 和 LoRa 模块），它们的 MISO 都接在 PA6 上。这不又是两个驱动者共用一根线了吗？',
          opts: [
            { t: '规定：只有被选中的从机才能驱动 MISO，没被选中的从机把 MISO 设成高阻（松手）', ok: true },
            { t: 'MISO 要改成开漏 + 上拉', assume: '共用的线只能用开漏', counter: '那 MISO 又会慢回 I2C 的速度。只要保证任何时刻只有一个从机在驱动，推挽也安全——问题变成「怎么保证只有一个」。', back: 's2' },
            { t: '两个从机同时输出，主机取平均', assume: '冲突可以被容忍', counter: '两个推挽输出一高一低就是短路（I2C 章问题 3），不能容忍。', back: 's2' }
          ],
          explain: '对。于是又需要一种方法告诉每个从机「现在选的是你」——下一步就是它。' },
        { k: 'fact', f: 'F1' }
      ],
      makes: ['F1'],
      gist: '推挽不能共用 → 每个方向一根线、每根线一个驱动者：SCK、MOSI 由主机驱动，MISO 由从机驱动；多个从机共用 MISO 时只有被选中的那个驱动，其余高阻。',
      next: '怎么告诉某一个从机「选的是你」？I2C 用地址字节，SPI 也这样吗？',
      refs: [{ t: 'RM0008 SPI 引脚：SCK、MISO、MOSI、NSS' }]
    },

    {
      id: 's3', stage: 'A', q: '不用地址，怎么点名？片选线', from: 's2',
      beats: [
        { k: 'idea', t: 'I2C 用第一个字节当地址：所有从机都要先听一个字节、比较、再决定理不理。这多花一个字节，还要求每个从机都有地址译码电路。' },
        { k: 'fix', t: ['SPI 的做法更直接：**每个从机一根单独的片选线 CS**（低电平有效）。主机想跟谁说话，就把谁的 CS 拉低；其余的 CS 保持高。', '· 被选中的从机：开始听 SCK、往 MISO 上说话；', '· 没被选中的：对 SCK、MOSI 视而不见，MISO 保持高阻。'] },
        { k: 'fact', f: 'F2' },
        { k: 'say', t: 'CS 还顺便承担了 I2C 里起始 / 停止信号的角色：**CS 拉低就是一次传输的开始，拉高就是结束**。很多从机（包括 W25Q32）的指令就是靠 CS 的边沿来分隔的：每条指令都要先拉低 CS，「写入」「擦除」这类指令要在 CS 拉高时才真正执行。' },
        { k: 'ask', id: 'p3-a', type: 'choice', q: '片选的代价是什么？',
          opts: [
            { t: '每多一个从机就要多一根线（多占主机一个引脚）', ok: true },
            { t: '速度变慢', assume: '片选要额外的时间', counter: '恰恰相反：不用发地址字节、不用等应答，片选拉低就可以直接开始。代价在引脚数上。', back: 's3' }
          ],
          explain: '对。I2C 用时间（地址字节）换线，SPI 用线换时间。挂三五个从机，多几根线完全可以接受。' },
        { k: 'hw', t: '看开发板原理图：W25Q32 的 CS 接 **PC13**，LoRa 模块的 CS 接 PG14，它们共用 SPI1 的 PA5（SCK）、PA6（MISO）、PA7（MOSI）。片选只是普通的 GPIO：用推挽输出、自己拉高拉低。' }
      ],
      uses: ['F1'], makes: ['F2'],
      gist: '每个从机一根片选线 CS（低有效）：拉低 = 选中并开始，拉高 = 结束；没选中的从机不听、MISO 高阻。用引脚换掉了地址字节和应答。',
      next: '选中了，开始传。I2C 里收和发是轮流的——SPI 呢？',
      refs: [{ t: '开发板原理图：W25Q32 CS = PC13，LoRa CS = PG14，SPI1 = PA5 / PA6 / PA7' }],
      links: [{ pin: 'PC13' }, { sch: 'board-05' }]
    },

    {
      id: 's4', stage: 'A', q: '收和发是轮流来，还是可以同时？', from: 's3',
      beats: [
        { k: 'idea', t: ['MOSI 和 MISO 是两根独立的线，那就没理由轮流了：每个时钟，主机往 MOSI 上送一位，从机同时往 MISO 上送一位。', '电路上最简单的实现：主机和从机各有一个 8 位**移位寄存器**，首尾相接连成一个环。每个时钟，两边各往外移一位、同时移进对方的一位。8 个时钟后，两边的内容正好**互换**。'] },
        { k: 'fact', f: 'F3' },
        { k: 'ask', id: 'p4-a', type: 'choice', q: '主机只想**读**从机的一个字节，它要怎么做？',
          opts: [
            { t: '还是要发一个字节（内容无所谓，常发 0xFF），时钟才会走，从机的字节才会被换过来', ok: true },
            { t: '什么都不发，等从机发过来', assume: '从机可以自己开口', counter: 'SCK 只有主机能产生：没有时钟，谁也移不了位。主机不发，就没有时钟。', back: 's4' },
            { t: '发一个「读」命令，然后不发东西等它回', assume: '读命令发完就可以等着收', counter: '发完读命令，后面每收一个字节都要再发一个（无意义的）字节去换。这就是为什么 SPI 驱动里总有一个「交换一个字节」的函数。', back: 's4' }
          ],
          explain: '对。所以 SPI 驱动的核心函数通常叫 swap / transfer：发一个、同时收一个。只想发时，收到的东西扔掉；只想收时，发的东西随便。' },
        { k: 'why', t: '这种「交换」的设计让硬件极其简单：一个移位寄存器同时负责收和发，没有方向切换、没有应答。代价是协议层要自己规定「哪些字节有意义」——那是从机数据手册的事。' }
      ],
      uses: ['F1'], makes: ['F3'],
      gist: '主从各一个移位寄存器连成环，每个时钟交换一位，8 个时钟互换一个字节。时钟只由主机产生 → 只想收也要发一个字节（常发 0xFF）。',
      next: '一位一位地换：在 SCK 的哪个边沿把数据放上去、哪个边沿读？',
      refs: [{ t: 'RM0008 SPI 功能描述：主从移位寄存器' }]
    },

    {
      id: 's5', stage: 'A', q: '在 SCK 的哪个边沿采样？CPOL 和 CPHA', from: 's4',
      beats: [
        { k: 'need', t: 'I2C 规定死了：SCL 低时改、SCL 高时读（I2C 章 F2）。SPI 没有统一的官方规范，各家芯片的习惯不一样：有的空闲时 SCK 是低的，有的是高的；有的在第一个边沿读，有的在第二个边沿读。' },
        { k: 'fix', t: ['于是 SPI 外设干脆做成可配置的两位：', '· **CPOL**（时钟极性）：空闲时 SCK 是 0 还是 1；', '· **CPHA**（时钟相位）：在时钟的第一个边沿采样（0），还是第二个边沿采样（1）。', '组合出 4 种「模式」：模式 0 = CPOL 0 / CPHA 0，模式 3 = CPOL 1 / CPHA 1，最常用。'] },
        { k: 'table', head: ['模式', 'CPOL', 'CPHA', '空闲时 SCK', '在哪个边沿采样'], rows: [
          ['0', '0', '0', '低', '上升沿（第一个边沿）'], ['1', '0', '1', '低', '下降沿（第二个边沿）'], ['2', '1', '0', '高', '下降沿（第一个边沿）'], ['3', '1', '1', '高', '上升沿（第二个边沿）']] },
        { k: 'fact', f: 'F4' },
        { k: 'hw', t: 'W25Q32 的数据手册说它支持**模式 0 和模式 3**：两种模式都是在上升沿采样、在下降沿换数据，区别只在空闲时 SCK 是低还是高（Flash 在 CS 拉低时看一眼 SCK 就知道是哪种）。' },
        { k: 'ask', id: 'p5-a', type: 'choice', predict: true, q: '如果主机配成模式 1（CPHA = 1），去读 W25Q32 的 ID，会读到什么？',
          opts: [
            { t: '读不到正确的 ID：两边对「在哪个边沿采样」理解不一样，Flash 收到的指令位是错开的，它根本认不出 0x9F', ok: true },
            { t: '还是对的，SPI 会自动适应', assume: 'SPI 会自动协商模式', counter: 'SPI 没有任何协商机制。两边对「哪个边沿读」理解不一样，读到的就是错的——而且没有应答，主机自己还不知道错了。', back: 's5' }
          ],
          explain: '对。下面对比一下。' },
        { k: 'w', w: 'sim', sc: 'modecmp', cap: '同样读 JEDEC ID：左边模式 0，右边模式 1。' }
      ],
      uses: ['F3'], makes: ['F4'],
      gist: 'CPOL 定空闲电平，CPHA 定在第一个还是第二个边沿采样，组合成模式 0~3。必须和从机一致：W25Q32 支持模式 0 和 3（上升沿采样）。模式不对，读到错乱的数。',
      next: '上面右边读错了，主机却完全不知道。SPI 没有应答——主机怎么知道对方在、听懂了？',
      refs: [{ t: 'RM0008 SPI_CR1：CPOL、CPHA；W25Q32JV 数据手册：支持 SPI 模式 0 和 3' }],
      links: [{ fig: 'spi-timing' }]
    },

    {
      id: 's6', stage: 'A', q: '没有应答，主机怎么知道对方在、听懂了？', from: 's5',
      beats: [
        { k: 'say', t: 'I2C 每个字节后都有应答：从机不在、地址不对，主机马上知道。SPI 为了快，把应答也拿掉了：主机发出去的每一位，从机收没收到、听没听懂，线上没有任何反馈。' },
        { k: 'ask', id: 'p6-a', type: 'choice', q: '如果 W25Q32 根本没焊上（或者 CS 接错了），主机照样发 0x9F、再读 3 个字节，会读到什么？',
          opts: [
            { t: '读到 MISO 上「没人驱动」时的电平：通常是 0xFF 或 0x00（取决于有没有上下拉），程序不会报错', ok: true },
            { t: 'SPI 外设会报一个「从机不存在」的错误', assume: 'SPI 硬件会检测从机', counter: 'SPI 的主机只是按时钟移位，MISO 上是什么就收什么。线上没人说话，收到的就是悬空引脚的电平。', back: 's6' }
          ],
          explain: '对。所以 SPI 程序要自己验证：最常见的办法就是先读一个**已知的值**——器件 ID。读到 EF 40 16，说明接线、模式、时钟都对了；读到 FF FF FF 或 00 00 00，先查接线。' },
        { k: 'why', t: ['同样的道理，写 Flash 时也没有「写好了」的应答。W25Q32 把这个信息放进了一个**状态寄存器**：BUSY 位表示它还在忙（写入、擦除），主机要自己发「读状态」指令（0x05）去查——这其实就是 I2C 章里 EEPROM「应答轮询」的 SPI 版本。', '这就是 SPI 的取舍：硬件层什么都不保证，可靠性交给上层协议（器件的指令集）。换来的是简单和速度。'] }
      ],
      uses: ['F1', 'F2'],
      gist: 'SPI 没有应答：从机不在时主机读到的是悬空的 MISO（常见 0xFF / 0x00），不会报错。所以先读已知的器件 ID 来验证；写入完成要靠读状态寄存器的 BUSY 位。',
      next: '那就先来读 ID。W25Q32 的「你是谁」该怎么问？',
      refs: [{ t: 'W25Q32JV 数据手册：状态寄存器 1（BUSY、WEL）、读状态指令 05h' }]
    },

    {
      id: 's7', stage: 'B', q: 'W25Q32 的指令：怎么问「你是谁」？', from: 's6',
      beats: [
        { k: 'hw', t: ['W25Q32 的协议很简单：CS 拉低后，主机发的**第一个字节是指令**，后面跟着这条指令需要的地址或数据，CS 拉高结束。', '「读 JEDEC ID」的指令是 **0x9F**：发完它，再交换 3 个字节，Flash 依次送出：', '· **0xEF**：制造商 Winbond；', '· **0x40**：存储器类型（SPI Flash 系列）；', '· **0x16**：容量。'] },
        { k: 'ask', id: 'p7-a', type: 'choice', q: '容量编码 0x16 = 22。它和 32 Mbit 是什么关系？',
          opts: [
            { t: '2²² 字节 = 4 MB = 32 Mbit', ok: true },
            { t: '22 MB', assume: '编码就是容量', counter: 'JEDEC 用的是 2 的指数：0x16 = 22，容量是 2²² 字节。同系列的 W25Q64 是 0x17（8 MB），W25Q128 是 0x18（16 MB）。', back: 's7' }
          ],
          explain: '对。' },
        { k: 'ask', id: 'p7-o', type: 'order', q: '读 JEDEC ID 的一次完整传输，排好顺序。',
          items: [{ t: 'CS 拉低' }, { t: '交换：发 0x9F' }, { t: '交换：发 0xFF，收到 0xEF' }, { t: '交换：发 0xFF，收到 0x40' }, { t: '交换：发 0xFF，收到 0x16' }, { t: 'CS 拉高' }],
          rules: [
            { a: 0, b: 1, why: 'CS 拉低之前 Flash 不听 SCK，指令会被忽略（F2）。', back: 's3' },
            { a: 1, b: 2, why: '第一个字节必须是指令：Flash 收到 0x9F 才知道接下来该送 ID。', back: 's7' },
            { a: 2, b: 3, why: 'ID 的三个字节按 EF、40、16 的顺序出来。', back: 's7' },
            { a: 3, b: 4, why: 'ID 的三个字节按 EF、40、16 的顺序出来。', back: 's7' },
            { a: 4, b: 5, why: 'CS 拉高结束这条指令；拉早了，后面的字节就收不到。', back: 's3' }
          ] }
      ],
      uses: ['F2', 'F3'],
      gist: 'W25Q32：CS 拉低后第一个字节是指令。读 JEDEC ID = 发 0x9F，再换 3 个字节得到 EF 40 16（Winbond、SPI Flash、2²² 字节），CS 拉高结束。',
      next: '协议清楚了。STM32 的 SPI 外设要怎么配？课件里那句 SSM、SSI 是做什么的？',
      refs: [{ t: 'W25Q32JV 数据手册：Read JEDEC ID（9Fh）：EFh、40h、16h' }]
    },

    {
      id: 's8', stage: 'B', q: 'STM32 的 SPI：主模式、NSS 和 MODF', from: 's7',
      beats: [
        { k: 'need', t: 'STM32 的 SPI 既能当主机也能当从机（CR1 的 MSTR 位）。当从机时，它也需要一根片选输入——这根引脚叫 **NSS**（SPI1 是 PA4）。' },
        { k: 'trouble', t: ['可当主机时 NSS 还在起作用：芯片设计者考虑了「一条总线上有多个主机」的情况——如果别的主机把我的 NSS 拉低，说明它要用总线了，我就不能再当主机。', '于是规定：主模式下，如果 NSS 引脚是低电平，SPI 立刻报**模式错误 MODF**，并自动清掉 MSTR 和 SPE——退回从模式、关掉 SPI。', '而 PA4 在我们的板子上没有接任何东西（浮空），读到低电平的可能性很大……'] },
        { k: 'ask', id: 'p8-a', type: 'choice', q: '我们自己用 GPIO（PC13）做片选，NSS 引脚用不上。怎么让 SPI 不再去看它？',
          opts: [
            { t: '用软件管理 NSS：SSM = 1（不看 NSS 引脚，改看寄存器里的 SSI 位），再让 SSI = 1（告诉它「NSS 是高的，没人抢」）', ok: true },
            { t: '把 PA4 配成推挽输出 1', assume: '只能靠引脚', counter: '这样也行，但白白占了一个引脚。STM32 专门提供了软件 NSS：SSM = 1 时，NSS 的电平由 SSI 位决定。', back: 's8' },
            { t: '不用管，NSS 只在从模式有用', assume: 'NSS 和主模式无关', counter: '主模式下 NSS 为低会触发 MODF（多主机保护），SPI 被自动关掉——这是用 SPI 时最常见的「怎么发不出去」。', back: 's8' }
          ],
          explain: '对。课件的 `SPI1->CR1 |= SPI_CR1_SSM; SPI1->CR1 |= SPI_CR1_SSI;` 就是这个用意。' },
        { k: 'fact', f: 'F5' },
        { k: 'w', w: 'sim', sc: 'modf', cap: '没设 SSM / SSI：' },
        { k: 'alt', t: 'STM32 也能让 SPI 硬件自己输出片选（SSOE = 1，NSS 引脚当输出）。但在 F1 上，这个 NSS 在 SPE = 1 期间一直是低的，不会在每条指令之间自动拉高——而 W25Q32 恰恰要靠 CS 的边沿分隔指令（F2）。所以读写 Flash 时都用 GPIO 自己管片选。' }
      ],
      uses: ['F2'], makes: ['F5'],
      gist: '主模式下 NSS 为低 → MODF（多主机保护），SPI 自动关掉。片选用 GPIO 时：SSM = 1、SSI = 1，让 SPI 不看 NSS 引脚。F1 的硬件 NSS 不会在指令间拉高，不适合 Flash。',
      next: 'SCK 能跑多快？',
      refs: [{ t: 'RM0008 SPI_CR1：MSTR、SSM、SSI；主模式故障 MODF' }],
      links: [{ cw: 'v21-95' }]
    },

    {
      id: 's9', stage: 'B', q: 'SCK 跑多快？分频与上限', from: 's8',
      beats: [
        { k: 'hw', t: ['SCK 由外设时钟分频得到：`SCK = PCLK ÷ 2^(BR + 1)`，BR 是 CR1 里的 3 位，÷2 到 ÷256。SPI1 在 APB2 上，PCLK = 72 MHz。', '能选 ÷2 = 36 MHz 吗？不能：STM32F103 数据手册给 SPI 的上限是 **18 MHz**，所以 SPI1 最快只能 ÷4。W25Q32 这边，普通读指令（0x03）最高 50 MHz，不是瓶颈。'] },
        { k: 'ask', id: 'p9-a', type: 'fill', q: 'BR = 010（÷8），SCK 是多少 MHz？',
          answers: ['9', '9MHz', '9 MHz'], hints: ['72 MHz ÷ 8。'],
          explain: '对：9 MHz。课件用的就是这一档；本章的代码也用它。' },
        { k: 'test', t: '算一下读完 4 MB 要多久：18 MHz 下每个字节 8 个时钟 = 0.44 µs，4 MB ≈ 1.9 秒（实际还要加上软件开销）。和 I2C 的 94 ~ 377 秒比，快了两个数量级——这就是第一环想要的。' }
      ],
      gist: 'SCK = 72 MHz ÷ 2^(BR+1)；F103 的 SPI 上限 18 MHz（÷4）。÷8 = 9 MHz。读完 4 MB 约 2 秒，比 I2C 快两个数量级。',
      next: '剩下最后一块：CPU 怎么和 SPI 外设交换一个字节？',
      refs: [{ t: 'RM0008 SPI_CR1：BR[2:0]；STM32F103xE 数据手册：SPI fSCK 最大 18 MHz' }]
    },

    {
      id: 's10', stage: 'B', q: '交换一个字节：TXE、RXNE，为什么每次都要读 DR', from: 's9',
      beats: [
        { k: 'hw', t: ['和 USART 很像：写 **DR** 就是把字节放进发送缓冲，**TXE** = 1 表示发送缓冲空了；交换完 8 位后，收到的字节在接收缓冲里，**RXNE** = 1，读 **DR** 拿到它并清 RXNE。', '所以「交换一个字节」是四步：等 TXE → 写 DR → 等 RXNE → 读 DR。'] },
        { k: 'ask', id: 'p10-a', type: 'choice', q: '发指令 0x9F 时，收到的那个字节没有意义。能不能干脆不读 DR？',
          opts: [
            { t: '不行：不读的话 RXNE 一直是 1，下一个字节交换完时就溢出（OVR），而且下次读到的是旧的那个字节', ok: true },
            { t: '可以，没用的字节不读也没关系', assume: '只有有用的数据才需要读', counter: 'SPI 每发一个字节必收一个（F3）。不读走，接收缓冲就一直占着：下一个字节到来时置 OVR，后面读到的数据和发送对不上号。', back: 's4' }
          ],
          explain: '对。所以 swap 函数每次都读 DR：要不要这个字节，由调用者决定。' },
        { k: 'ask', id: 'p10-o', type: 'order', fn: 'spi_swap', q: '把 spi_swap() 的 4 行排好（会读一次 JEDEC ID 验证）。' },
        { k: 'fn', fn: 'spi_swap' }
      ],
      uses: ['F3'],
      gist: '交换一个字节：等 TXE → 写 DR → 等 RXNE → 读 DR。没用的字节也要读走，否则 RXNE 一直占着，下一次溢出、数据错位。',
      next: '回到任务：读 JEDEC ID，从初始化到打印，要做哪些事？',
      refs: [{ t: 'RM0008 SPI_SR：TXE、RXNE、OVR、BSY' }]
    },

    {
      id: 's11', stage: 'C', q: '任务：读出 W25Q32 的 JEDEC ID', from: 's10',
      beats: [
        { k: 'ask', id: 'p11-o', type: 'order', fn: 'spi1_init', q: '把 spi1_init() 的 6 行排好（会跑一次并打印 ID）。' },
        { k: 'fn', fn: 'spi1_init' },
        { k: 'fn', fn: 'w25q_read_id' },
        { k: 'fn', fn: 'main' },
        { k: 'w', w: 'sim', sc: 'id', cap: '读到 EF 40 16。下面是 CS 拉低期间四根线的波形：每个 SCK 上升沿，Flash 读 MOSI、主机读 MISO。' },
        { k: 'mine', t: '课件的 Driver_SPI_Init 把 PA6（MISO）配成浮空输入、PA5 / PA7 配成复用推挽、PC13 配成通用推挽，和这里一样；它没有先把 PC13 置 1 再切成输出——切换的一瞬间 PC13 输出 0，Flash 被选中了一下。通常不会出事，但不干净（GPIO 章问题 10 的同一个道理）。' },
        { k: 'say', t: '试试在 w25q_read_id 里把「CS 拉低」挪到发 0x9F 后面，或者把「CS 拉高」挪到最后一个字节前面。' }
      ],
      uses: ['F2', 'F3', 'F4', 'F5'],
      gist: 'spi1_init：时钟 → CS 先置 1 再推挽输出 → PA5/PA7 复用推挽、PA6 浮空输入 → CR1 = 主模式 + SSM + SSI + ÷8 → SPE。读 ID：CS 低、换 0x9F、换 3 个 0xFF、CS 高。',
      next: '换一个需求：读出 Flash 里某个地址开始的几个字节。',
      links: [{ cw: 'v21-95' }]
    },

    {
      id: 's12', stage: 'D', q: '换个需求：读出 Flash 里某个地址开始的 4 个字节', from: 's11', transfer: true,
      beats: [
        { k: 'need', t: '还是同一条思路：指令格式 → 交换哪些字节 → 代码。先自己想。' },
        { k: 'hw', t: 'W25Q32 的「读数据」指令是 **0x03**，后面跟 **3 个字节的地址**（24 位，高字节在前），然后每交换一个字节就送出一个数据，地址自动加 1，想读多少读多少，CS 拉高结束。' },
        { k: 'ask', id: 'p12-a', type: 'choice', q: '地址为什么是 3 个字节？',
          opts: [
            { t: '4 MB = 2²² 字节，至少要 22 位地址；按字节发就是 3 个字节（24 位）', ok: true },
            { t: '为了和 I2C 一样', assume: '地址长度是随便定的', counter: '地址长度由容量决定：2²² 需要 22 位，凑整成 3 个字节。更大的 W25Q256（32 MB）就要 4 字节地址模式。', back: 's7' }
          ],
          explain: '对。' },
        { k: 'ask', id: 'p12-o', type: 'order', q: '读 4 个字节的一次传输，排好顺序。',
          items: [{ t: 'CS 拉低' }, { t: '交换 0x03' }, { t: '交换地址高字节' }, { t: '交换地址中字节' }, { t: '交换地址低字节' }, { t: '交换 4 次 0xFF，依次收到数据' }, { t: 'CS 拉高' }],
          rules: [
            { a: 0, b: 1, why: 'CS 拉低后 Flash 才开始听（F2）。', back: 's3' },
            { a: 1, b: 2, why: '第一个字节是指令。', back: 's7' },
            { a: 2, b: 3, why: '地址高字节在前。', back: 's12' },
            { a: 3, b: 4, why: '地址高字节在前。', back: 's12' },
            { a: 4, b: 5, why: '地址发完，Flash 才从这个地址开始送数据。', back: 's12' },
            { a: 5, b: 6, why: '数据都收完再拉高 CS。', back: 's3' }
          ] },
        { k: 'fn', fn: 'w25q_read' },
        { k: 'w', w: 'sim', sc: 'read', cap: 'Flash 地址 0x012345 开始存着 48 65 6C 6C（"Hell"）。' },
        { k: 'say', t: ['写 Flash 比读复杂得多，这里先说清楚为什么，代码留给你按同样的思路推：', '· Flash 的存储单元只能把 1 **编程**成 0，不能把 0 变回 1；要变回 1 只能**擦除**，而且最小以 4 KB 的扇区为单位擦（指令 0x20）。所以「写」通常是：擦扇区 → 编程。', '· 擦除和编程前都要先发**写使能**（0x06）：防止一个错误的字节误改了数据。', '· 编程（0x02）一次最多一页 256 字节，跨页会回卷（和 M24C02 的页是同一种设计）；指令在 CS 拉高时才真正执行，执行期间 BUSY = 1，要用读状态（0x05）轮询到 BUSY = 0（[[s6]]）。', '回头看：从「I2C 太慢」出发，推出了推挽、方向固定的线、片选、全双工交换、时钟模式、没有应答的取舍、NSS 与 MODF。SPI 的每一条规则，都是 I2C 某一条规则在「只追求快」时的反面。'] }
      ],
      uses: ['F2', 'F3'],
      gist: '读数据：CS 低 → 0x03 → 3 字节地址（高字节在前）→ 每换一个 0xFF 收一个数据 → CS 高。写入要先写使能、擦除（只能 1 变 0）、按页编程、轮询 BUSY。',
      refs: [{ t: 'W25Q32JV 数据手册：Read Data（03h）、Write Enable（06h）、Page Program（02h）、Sector Erase（20h）' }]
    }
    ],

    fns: {
      spi1_init: {
        sig: 'void spi1_init(void)', doc: 'SPI1 主模式、模式 0、9 MHz；PC13 作 W25Q32 的片选', sc: 'id',
        lines: [
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_SPI1EN | RCC_APB2ENR_IOPAEN | RCC_APB2ENR_IOPCEN;', why: 'SPI1、GPIOA（SCK / MISO / MOSI）、GPIOC（片选 PC13）都在 APB2 上。', from: ['s3'] },
          { c: 'GPIOC->BSRR = GPIO_BSRR_BS13;', why: '先把片选写成 1（不选中）：切成输出的那一刻 Flash 不会被误选中。', from: ['F2', 's11'] },
          { c: 'GPIOC->CRH = (GPIOC->CRH & ~(GPIO_CRH_CNF13 | GPIO_CRH_MODE13)) | GPIO_CRH_MODE13;', why: 'PC13 通用推挽输出：片选由我们自己用 GPIO 控制（[[s8]]）。', from: ['s3', 's8'] },
          { c: 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF5 | GPIO_CRL_MODE5 | GPIO_CRL_CNF6 | GPIO_CRL_MODE6 | GPIO_CRL_CNF7 | GPIO_CRL_MODE7)) | GPIO_CRL_CNF5_1 | GPIO_CRL_MODE5 | GPIO_CRL_CNF6_0 | GPIO_CRL_CNF7_1 | GPIO_CRL_MODE7;', why: 'PA5（SCK）、PA7（MOSI）复用推挽输出：由 SPI 驱动（F1）；PA6（MISO）浮空输入：由 Flash 驱动。', from: ['F1', 's2'] },
          { c: 'SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1;', why: '主模式；软件 NSS（SSM = 1、SSI = 1，F5）；BR = 010 → 9 MHz；CPOL = CPHA = 0（模式 0，F4）；8 位、高位先行。', from: ['F4', 'F5', 's9'] },
          { c: 'SPI1->CR1 |= SPI_CR1_SPE;', why: '最后打开 SPI。', from: ['s8'] }
        ],
        rules: [
          { a: 0, b: 1, sc: 'id', why: 'GPIOC 时钟没开，写 BSRR 不起作用。', back: 's11' },
          { a: 0, b: 3, sc: 'id', why: 'GPIOA 时钟没开，SCK / MOSI 配不成复用输出。', back: 's2' },
          { a: 0, b: 4, sc: 'id', why: 'SPI1 时钟没开，写 CR1 不起作用。', back: 's8' },
          { a: 1, b: 2, sc: 'id', why: '先写 1 再切输出：反过来，切换的一瞬间 PC13 是 0，Flash 被选中了一下。', back: 's11', simNote: '这里看不出区别：Flash 只被选中了几十纳秒，期间 SCK 没有动，它什么也没收到。但如果这时 SPI 正在和 LoRa 模块通信，两个从机就会同时被选中、同时驱动 MISO。' },
          { a: 4, b: 5, sc: 'id', why: 'CR1 = … 是整个寄存器赋值：放在后面会把 SPE 清掉。而且要先设好 SSM / SSI，再打开 SPE，否则一打开就 MODF（F5）。', back: 's8' }
        ]
      },
      spi_swap: {
        sig: 'uint8_t spi_swap(uint8_t b)', doc: '交换一个字节：发 b，返回同时收到的字节', sc: 'id',
        lines: [
          { c: 'while ((SPI1->SR & SPI_SR_TXE) == 0);', why: '等发送缓冲空。', from: ['s10'] },
          { c: 'SPI1->DR = b;', why: '写进发送缓冲：SPI 开始产生 8 个时钟。', from: ['F3', 's10'] },
          { c: 'while ((SPI1->SR & SPI_SR_RXNE) == 0);', why: '8 位交换完，收到的字节进了接收缓冲。', from: ['F3', 's10'] },
          { c: 'return SPI1->DR;', why: '读走它（清 RXNE）：有没有用由调用者决定，但一定要读（[[s10]]）。', from: ['s10'] }
        ],
        rules: [
          { a: 1, b: 2, sc: 'id', why: '先写 DR，才有交换；先等 RXNE 就是在等一个还没开始的交换。', back: 's10' },
          { a: 2, b: 3, sc: 'id', why: '交换完成（RXNE）再读 DR，否则读到的是上一个字节。', back: 's10' },
          { a: 0, b: 1, sc: 'id', why: '等发送缓冲空再写。', back: 's10', simNote: '这里看不出区别：每次都等到 RXNE 才返回，下一次进来时发送缓冲早就空了。连续发送、不等 RXNE 的写法里，这一行才是必需的。' }
        ]
      },
      w25q_read_id: {
        sig: 'uint32_t w25q_read_id(void)', doc: '读 JEDEC ID（应为 0xEF4016）', sc: 'id',
        lines: [
          { c: 'uint32_t id;', why: '' },
          { c: 'GPIOC->BSRR = GPIO_BSRR_BR13;', why: 'CS 拉低：选中 Flash，一条指令开始（F2）。', from: ['F2'] },
          { c: 'spi_swap(0x9F);', why: '第一个字节是指令：读 JEDEC ID。收到的字节没用，扔掉。', from: ['s7'] },
          { c: 'id = spi_swap(0xFF) << 16;', why: '发 0xFF（内容无所谓）换回制造商 0xEF（F3）。', from: ['F3', 's7'] },
          { c: 'id |= spi_swap(0xFF) << 8;', why: '换回存储器类型 0x40。', from: ['s7'] },
          { c: 'id |= spi_swap(0xFF);', why: '换回容量 0x16。', from: ['s7'] },
          { c: 'GPIOC->BSRR = GPIO_BSRR_BS13;', why: 'CS 拉高：指令结束。', from: ['F2'] },
          { c: 'return id;', why: '' }
        ],
        rules: [
          { a: 1, b: 2, sc: 'id', why: 'CS 拉低之后 Flash 才听：指令在 CS 拉低前发出，Flash 根本没收到（F2）。', back: 's3' },
          { a: 2, b: 3, sc: 'id', why: '先发指令，Flash 才知道后面要送什么。', back: 's7' },
          { a: 5, b: 6, sc: 'id', why: '最后一个字节换完再拉高 CS：拉早了，Flash 不再驱动 MISO，最后一个字节读到的是悬空的电平。', back: 's3' }
        ]
      },
      main: {
        sig: 'int main(void)', doc: '读出 ID 并打印（printf 已重定向到 USART1）', sc: 'id',
        lines: [
          { c: 'spi1_init();', why: '' },
          { c: 'printf("JEDEC ID = %06X\\r\\n", w25q_read_id());', why: '应该打印 EF4016。', from: ['s7'] },
          { c: 'while (1) {', why: '' },
          { c: '}' }
        ],
        rules: [{ a: 0, b: 1, sc: 'id', why: 'SPI 还没配好就去读。', back: 's11' }]
      },
      w25q_read: {
        sig: 'void w25q_read(uint32_t addr, uint16_t n)', doc: '从 addr 开始读 n 个字节并打印', sc: 'read',
        lines: [
          { c: 'GPIOC->BSRR = GPIO_BSRR_BR13;', why: 'CS 拉低。', from: ['F2'] },
          { c: 'spi_swap(0x03);', why: '指令：读数据。', from: ['s12'] },
          { c: 'spi_swap((addr >> 16) & 0xFF);', why: '24 位地址，高字节在前。', from: ['s12'] },
          { c: 'spi_swap((addr >> 8) & 0xFF);', why: '', from: ['s12'] },
          { c: 'spi_swap(addr & 0xFF);', why: '', from: ['s12'] },
          { c: 'for (uint16_t i = 0; i < n; i++)', why: '每换一个 0xFF，收一个数据，地址自动加 1。', from: ['F3', 's12'] },
          { c: '    printf("%02X ", spi_swap(0xFF));', why: '' },
          { c: 'GPIOC->BSRR = GPIO_BSRR_BS13;', why: 'CS 拉高。', from: ['F2'] },
          { c: 'printf("\\r\\n");', why: '' }
        ],
        rules: [
          { a: 0, b: 1, sc: 'read', why: 'CS 先拉低。', back: 's3' },
          { a: 1, b: 2, sc: 'read', why: '指令在前，地址在后。', back: 's12' },
          { a: 2, b: 4, sc: 'read', why: '地址高字节在前：顺序反了，读的就是另一个地址。', back: 's12' }
        ]
      },
      main_read: {
        sig: 'int main(void)', doc: '读出地址 0 开始的 4 个字节', sc: 'read',
        lines: [{ c: 'spi1_init();', why: '' }, { c: 'w25q_read(0x012345, 4);', why: '' }, { c: 'while (1) {', why: '' }, { c: '}' }],
        rules: []
      }
    },

    scenarios: {
      id: { title: '读 JEDEC ID', ms: 5, view: { pins: ['PC13', 'PA5', 'PA7', 'PA6'], from: 0, to: 6 } },
      modecmp: { compare: ['id', 'mode1'] },
      mode1: { title: '模式 1（CPHA = 1）', ms: 5, patch: { spi1_init: { set: { 4: { c: 'SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1 | SPI_CR1_CPHA;' } } } }, view: { pins: ['PC13', 'PA5', 'PA7', 'PA6'], from: 0, to: 6 } },
      modf: { title: '没设 SSM / SSI', ms: 5, patch: { spi1_init: { set: { 4: { c: 'SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_BR_1;' } } } }, view: { pins: ['PC13', 'PA5', 'PA7', 'PA6'], from: 0, to: 6 } },
      read: { title: '读地址 0x012345 开始的 4 个字节', ms: 5, entry: ['main_read'], flash: { data: { 74565: [0x48, 0x65, 0x6C, 0x6C] } }, view: { pins: ['PC13', 'PA5', 'PA7', 'PA6'], from: 0, to: 9 } }
    }
  };
})();
