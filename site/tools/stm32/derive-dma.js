/* derive-dma.js — 「设计原理」DMA 章：从「CPU 的时间都花在等串口上」推到 DMA
   数据结构见 derive-i2c.js 顶部说明；本章用通用单片机模拟器（mcusim.js）：DMA1 通道 4 真的会把内存里的数据一个个交给 USART1。 */
(function () {
  'use strict';
  var D = window.STM32_DERIVE = window.STM32_DERIVE || {};

  D.dma = {
    id: 'dma', topic: 'dma', engine: 'mcu', defaultSc: 'dma',
    title: 'DMA：发一串数据，CPU 能不能不用守着',
    task: '用 USART1 把一串字符发到电脑上；发的这段时间里，主循环照常让 LED1 每 0.5 ms 翻转一次。',
    intro: [
      'USART 章里发数据的办法是：等 TXE、写 DR，一个字节一个字节来。115200 波特率下一个字节要 87 µs，CPU 绝大部分时间都在等。数据一多，主循环里别的事就全被拖住了。',
      '这一章从这个问题出发，「发明」出 DMA：一个专门搬数据的小助手。然后把它落到 STM32 的 DMA1 通道 4 上：地址、个数、方向、递增、请求、开始和结束，每一个要配的位都有它存在的理由。'
    ],
    honesty: '说明：下面是「如果让我们自己来设计」的思路重建，不是 DMA 真实的发展史。STM32 的行为按 RM0008（DMA、USART）；模拟器只模拟了 DMA1 通道 4 / 5 和 USART1 之间的搬运，总线仲裁、优先级这些细节没有模拟。',

    facts: {
      F1: { t: '外设的 DMA 请求固定接在某个通道上：USART1_TX → DMA1 通道 4（查手册的请求映射表）', short: '通道', from: 's4' },
      F2: { t: 'CPAR = 外设寄存器的地址（&USART1->DR），CMAR = 内存里数据的地址，CNDTR = 搬几个', short: '地址和个数', from: 's5' },
      F3: { t: 'DIR = 1：内存 → 外设；MINC = 1：内存地址每次加 1，外设地址不动（PINC = 0）', short: '方向与递增', from: 's6' },
      F4: { t: '外设那边也要打开 DMA 请求：USART1 的 DMAT（发）/ DMAR（收），不开就没人喊「下一个」', short: '外设请求', from: 's7' },
      F5: { t: '通道开着时 CMAR、CNDTR 改不了：先关 EN → 设地址和个数 → 清 TCIF → 开 EN；搬完置 TCIF', short: '开始与结束', from: 's8' },
      F6: { t: '要搬的数据在搬完之前必须一直有效、不能改：不能用函数里的局部数组', short: '数据要活着', from: 's9' }
    },

    stages: [
      { id: 'A', name: '为什么要 DMA', desc: 'CPU 在等、中断发送的代价、专门的搬运工' },
      { id: 'B', name: '落到 STM32 上', desc: '通道、地址和个数、方向与递增、外设请求、开始结束、数据的生命、搬完与发完' },
      { id: 'C', name: '从任务需求推到代码', desc: '事件表 → 一行行代码 → 发数据的同时 LED 照常闪' },
      { id: 'D', name: '换个需求，自己再推一遍', desc: '发完自动通知：传输完成中断' }
    ],

    steps: [
    {
      id: 's1', stage: 'A', q: '一个字节一个字节地发，CPU 的时间去哪了',
      beats: [
        { k: 'need', t: '要发一串 25 个字节的字符串，同时主循环还要每 0.5 ms 翻转一次 LED1（代表别的要按时做的事）。' },
        { k: 'test', t: 'USART 章的写法：for 循环里等 TXE、写 DR。115200 波特率下一帧 10 位，一个字节 ≈ 87 µs。' },
        { k: 'ask', id: 'd1-a', type: 'fill', q: '25 个字节全发完，CPU 大约要在这个 for 循环里待多少毫秒？（保留一位小数）',
          answers: ['2.2', '2.17', '2.1', '2.3'], hints: ['25 × 87 µs。', '约 2170 µs。'],
          explain: '对：约 2.2 ms。这 2.2 ms 里 CPU 99% 的时间都在 `while (TXE == 0);` 里空转，LED 一下都没翻。' },
        { k: 'w', w: 'sim', sc: 'poll', cap: '等 TXE 发 25 个字节，发完才开始翻转 LED1：' },
        { k: 'trouble', t: '数据越多、波特率越低，CPU 被拖住的时间越长：9600 波特率下同样 25 个字节要 26 ms。CPU 明明有空，却只能守着串口。' }
      ],
      gist: '轮询发送：每个字节都要等 TXE。115200 下一个字节 87 µs，25 个字节约 2.2 ms，这段时间 CPU 只能空等。',
      next: '不想空等，用中断发送行不行？',
      refs: [{ t: 'USART 章：发送一个字节（等 TXE、写 DR）' }]
    },

    {
      id: 's2', stage: 'A', q: '用中断发送行不行', from: 's1',
      beats: [
        { k: 'idea', t: '打开 USART 的 TXEIE：发送缓冲一空就进一次中断，在中断里写下一个字节。CPU 不用守着了，平时可以干别的。' },
        { k: 'ask', id: 'd2-a', type: 'choice', q: '中断发送解决了「空等」。它还有什么代价？',
          opts: [
            { t: '每个字节都要进出一次中断：保存现场、查标志、写 DR、恢复现场，几十个时钟周期；字节多、波特率高的时候，中断非常密，CPU 还是很忙', ok: true },
            { t: '没有代价', assume: '进中断是免费的', counter: '每次进中断都要硬件压栈、出栈，处理函数里还要判断是哪个中断源。1 MHz 波特率下每 10 µs 就要进一次，CPU 大部分时间又耗在进出中断上。', back: 's2' }
          ],
          explain: '对。而且中断里干的其实只是「从内存拿一个字节、放进 DR、指针加 1、计数减 1」——这么机械的事，能不能交给硬件？' },
        { k: 'why', t: '取舍：轮询简单但 CPU 空等；中断不空等，但每个字节都要 CPU 亲自搬一次。两种办法里，搬数据的都是 CPU。' }
      ],
      gist: '中断发送不用空等，但每个字节都要进出一次中断、由 CPU 亲手搬，字节多时中断很密。',
      next: '把「从内存拿一个、放进 DR」这件机械的事交给专门的硬件呢？',
      refs: [{ t: 'RM0008 USART_CR1：TXEIE' }]
    },

    {
      id: 's3', stage: 'A', q: '专门的搬运工', from: 's2',
      beats: [
        { k: 'idea', t: ['在 CPU 旁边放一个专门搬数据的小助手：USART 每说一声「我要下一个」，它就从内存里取一个字节放进 USART1->DR，自己记着搬到第几个了；全部搬完，再告诉 CPU 一声。CPU 只在开头交代一次、在结尾听一次结果。', '这就是 **DMA**（直接存储器访问）：数据不经过 CPU，直接在内存和外设之间搬。'] },
        { k: 'ask', id: 'd3-a', type: 'choice', q: '交代这个搬运工，至少要告诉它哪些事？',
          opts: [
            { t: '从哪搬（内存地址）、搬到哪（外设寄存器地址）、搬几个、每搬一个地址怎么变、什么时候搬（谁来喊下一个）', ok: true },
            { t: '只要告诉它要发的字符串', assume: '它自己知道发到哪、发多长', counter: '搬运工不懂「字符串」：它只认地址和个数。发给哪个外设、每次搬多少位、搬完一个地址要不要往后挪、什么时候搬下一个，都要你说清楚。', back: 's3' }
          ],
          explain: '对。下面几环就是把这几件事一件件落到寄存器上。' },
        { k: 'why', t: '代价：多了一套要配的硬件；还要注意 DMA 和 CPU 共用总线，DMA 搬的时候 CPU 偶尔要让一下（几乎感觉不到）。换来的是：发 1 个字节和发 1000 个字节，CPU 的工作量一样。' }
      ],
      gist: 'DMA：外设喊一声，它从内存搬一个到外设，计数减一，搬完告诉 CPU。要交代：源地址、目的地址、个数、地址怎么变、谁来喊。',
      next: 'STM32 上有好几个外设要用 DMA，搬运工怎么知道是谁在喊？',
      refs: [{ t: 'RM0008 DMA 简介' }]
    },

    {
      id: 's4', stage: 'B', q: '谁在喊：通道和请求映射', from: 's3',
      beats: [
        { k: 'hw', t: ['STM32F103ZE 有两个 DMA：DMA1 有 7 个**通道**，DMA2 有 5 个。每个通道是一个独立的搬运工，可以同时干各自的活。', '每个外设的 DMA 请求**固定**接在某个通道上（手册里有一张「DMA1 请求映射」表）：USART1_TX → 通道 4，USART1_RX → 通道 5，ADC1 → 通道 1，SPI1_TX → 通道 3……不能随便选。'] },
        { k: 'fact', f: 'F1' },
        { k: 'ask', id: 'd4-a', type: 'choice', q: 'USART1 发送要用哪个通道？',
          opts: [
            { t: 'DMA1 的通道 4', ok: true },
            { t: '随便哪个没用的通道', assume: '通道可以自由分配', counter: 'F1 的 DMA 请求是硬连线的：USART1 的发送请求只接到 DMA1 通道 4。配了通道 1，USART1 喊破喉咙它也听不见。', back: 's4' }
          ],
          explain: '对。课件里选的也是通道 4。' }
      ],
      makes: ['F1'],
      gist: 'DMA1 有 7 个通道，每个外设请求固定接一个：USART1_TX → 通道 4（RX → 通道 5）。',
      next: '通道选好了。怎么告诉它从哪搬、搬到哪、搬几个？',
      refs: [{ t: 'RM0008 DMA1 请求映射表' }]
    },

    {
      id: 's5', stage: 'B', q: '从哪搬、搬到哪、搬几个：CPAR、CMAR、CNDTR', from: 's4',
      beats: [
        { k: 'hw', t: ['每个通道有三个寄存器记这三件事：', '· **CPAR**：外设那一头的地址；', '· **CMAR**：内存那一头的地址；', '· **CNDTR**：一共搬几个。每搬一个减 1，减到 0 就停。'] },
        { k: 'fact', f: 'F2' },
        { k: 'ask', id: 'd5-a', type: 'choice', q: '发串口时，CPAR 应该写什么？',
          opts: [
            { t: 'USART1->DR 的地址：`(uint32_t)&USART1->DR`', ok: true },
            { t: 'USART1 的地址：`(uint32_t)USART1`', assume: '给外设的名字就行', counter: 'USART1 是整个外设寄存器组的起点（就是 SR 的地址）。DMA 只会往一个地址里写，要写的是数据寄存器 DR 那个地址。', back: 's5' },
            { t: '要发的字符串', assume: 'CPAR 放数据', counter: 'CPAR、CMAR 放的都是地址，不是数据。字符串的地址放 CMAR。', back: 's5' }
          ],
          explain: '对。`&` 取地址，`(uint32_t)` 把指针当成一个 32 位的数写进寄存器。' }
      ],
      uses: ['F1'], makes: ['F2'],
      gist: 'CPAR = 外设寄存器地址（&USART1->DR），CMAR = 内存数据地址，CNDTR = 个数（每搬一个减 1）。',
      next: '搬完一个以后，下一个从哪拿、往哪放？',
      refs: [{ t: 'RM0008 DMA_CPARx / CMARx / CNDTRx' }]
    },

    {
      id: 's6', stage: 'B', q: '往哪边搬、地址怎么变：DIR、MINC、PINC', from: 's5',
      beats: [
        { k: 'hw', t: ['通道的 **CCR** 里：', '· **DIR**：0 = 从外设读、写到内存（收），1 = 从内存读、写到外设（发）；', '· **MINC** / **PINC**：每搬一个，内存 / 外设的地址要不要往后挪；', '· **MSIZE** / **PSIZE**：每次搬 8、16 还是 32 位。'] },
        { k: 'ask', id: 'd6-a', type: 'choice', predict: true, q: '发字符串：DIR = 1、PINC = 0，如果忘了 MINC（MINC = 0），电脑会收到什么？',
          opts: [
            { t: '25 个一模一样的字符：内存地址一直不动，每次都拿第一个字节', ok: true },
            { t: '正常的字符串', assume: '内存地址会自动往后走', counter: '地址往不往后走，全看 MINC。不开，它就一遍遍地搬同一个地址。', back: 's6' }
          ],
          explain: '对。外设那头正好相反：USART1->DR 只有一个，地址不能动，所以 PINC = 0。' },
        { k: 'fact', f: 'F3' },
        { k: 'w', w: 'sim', sc: 'nominc', cap: '忘了 MINC：' }
      ],
      uses: ['F2'], makes: ['F3'],
      gist: 'DIR = 1 内存 → 外设；MINC = 1 内存地址每次加 1；PINC = 0 外设地址不动；8 位就 MSIZE = PSIZE = 00。忘了 MINC 就一直搬第一个字节。',
      next: '都配好了，搬运工什么时候搬下一个？',
      refs: [{ t: 'RM0008 DMA_CCRx' }]
    },

    {
      id: 's7', stage: 'B', q: '谁来喊「下一个」：外设那边的 DMAT', from: 's6',
      beats: [
        { k: 'trouble', t: 'DMA 不能想搬就搬：USART 还没把上一个字节发出去，就往 DR 里塞下一个，上一个就被冲掉了。必须是 USART 准备好了（TXE = 1）再搬。' },
        { k: 'hw', t: '所以外设那边也有一个开关：USART1 的 **CR3.DMAT**。打开后，TXE 一变成 1，USART 就向 DMA 发一个请求（而不是去叫 CPU）；DMA 搬一个字节进 DR，TXE 又变 0，请求撤掉，等下一次。接收方向对应的是 **DMAR**（RXNE → 请求）。' },
        { k: 'fact', f: 'F4' },
        { k: 'ask', id: 'd7-a', type: 'choice', predict: true, q: 'DMA 通道全配好、也打开了，但忘了设 DMAT，会怎样？',
          opts: [
            { t: '什么都不发：USART 从来没喊过「下一个」，DMA 一个字节都不搬', ok: true },
            { t: 'DMA 一口气把 25 个字节全塞进 DR', assume: 'DMA 自己会搬', counter: 'DMA 是「有人喊才搬」。没有 DMAT，USART 的 TXE 不会变成 DMA 请求。', back: 's7' }
          ],
          explain: '对。课件的初始化里也有 `USART1->CR3 |= USART_CR3_DMAT;` 这一行。' },
        { k: 'w', w: 'sim', sc: 'nodmat', cap: '忘了 DMAT：' }
      ],
      uses: ['F3'], makes: ['F4'],
      gist: 'USART 准备好（TXE）才能搬：打开 CR3.DMAT，TXE 就变成 DMA 请求。不开 DMAT，DMA 一个字节都不搬。',
      next: '怎么开始？搬完了怎么知道？想再发一次又该怎么做？',
      refs: [{ t: 'RM0008 USART_CR3：DMAT / DMAR；USART 的 DMA 发送' }]
    },

    {
      id: 's8', stage: 'B', q: '开始、结束、再来一次', from: 's7',
      beats: [
        { k: 'hw', t: ['CCR 的 **EN** 是通道开关：置 1 就开始按请求搬。CNDTR 减到 0 时，DMA1->ISR 里的 **TCIF4**（传输完成）置 1。', '手册规定：**通道开着（EN = 1）时，CPAR、CMAR、CNDTR 是只读的**，写了不起作用。所以每次发送都是：关 EN → 设 CMAR、CNDTR → 清 TCIF4（往 IFCR 写 1）→ 开 EN。'] },
        { k: 'ask', id: 'd8-a', type: 'choice', q: '上一次已经发完（CNDTR = 0），通道还开着。这次直接写 CMAR、CNDTR，再置 EN，会怎样？',
          opts: [
            { t: '写不进去：EN 还是 1，CMAR、CNDTR 只读；CNDTR 还是 0，什么也不发', ok: true },
            { t: '正常发送新的数据', assume: '搬完以后通道会自动关', counter: '普通模式下 CNDTR 减到 0 只是停下，EN 不会自己变 0。要先手动关掉才能改。', back: 's8' }
          ],
          explain: '对。所以发送函数第一句就是关 EN。' },
        { k: 'fact', f: 'F5' },
        { k: 'alt', t: '循环模式（CIRC = 1）：CNDTR 减到 0 自动装回原来的值，从头再搬，适合 ADC 连续采样、串口循环接收这类「一直在搬」的场合（ADC 多通道 + DMA 就是这样用的）。发一串字符不用它，不然会一遍遍地重复发——课件的实验 1 就开了循环模式。' }
      ],
      uses: ['F2'], makes: ['F5'],
      gist: 'EN = 1 开始搬，CNDTR 到 0 置 TCIF4。通道开着时 CMAR / CNDTR 只读：每次发送先关 EN → 设地址个数 → IFCR 清 TCIF4 → 开 EN。',
      next: 'DMA 在后台搬的时候，函数早就返回了。要发的数据放在哪才安全？',
      refs: [{ t: 'RM0008 DMA 通道配置步骤；DMA_ISR / DMA_IFCR' }, { t: '课件：DMA 实验 1（开了 CIRC）' }]
    },

    {
      id: 's9', stage: 'B', q: '数据要活到搬完为止', from: 's8',
      beats: [
        { k: 'trouble', t: 'DMA 发送函数一返回，CPU 就去干别的了，DMA 还在后台一个个地从 CMAR 指的地方拿数据。这时候如果那块内存被改了、被别的东西占用了，发出去的就是乱码。' },
        { k: 'ask', id: 'd9-a', type: 'choice', q: '下面这样写有什么问题？\n`void say_hello(void) { uint8_t buf[] = "hello"; uart_dma_send(buf, 5); }`',
          opts: [
            { t: 'buf 是函数里的局部数组，放在栈上；函数一返回这块栈就被后面的函数调用占掉了，DMA 再去拿就是别的数据', ok: true },
            { t: '没问题，DMA 会先把数据复制一份', assume: 'DMA 发送前会拷贝数据', counter: 'DMA 只记住了地址，不会复制。它是在之后的 2 ms 里一个个去那个地址拿的。', back: 's9' }
          ],
          explain: '对。要发的数据要么是全局 / static 的（一直有效），要么在发完之前不离开、不改动。' },
        { k: 'fact', f: 'F6' },
        { k: 'say', t: '同样的道理：DMA 正在发 buf 的时候，主循环不能往 buf 里写新的内容。要边发边准备下一段，就用两块缓冲区轮流（双缓冲）。' }
      ],
      uses: ['F5'], makes: ['F6'],
      gist: 'DMA 只记地址、在后台慢慢拿：数据要一直有效到搬完（全局 / static），搬完之前不能改。不能发函数里的局部数组。',
      next: 'TCIF4 置 1 了，是不是数据就已经全发到电脑上了？',
      refs: [{ t: 'C：自动变量的生命周期' }]
    },

    {
      id: 's10', stage: 'B', q: '搬完不等于发完：TCIF 和 TC', from: 's9',
      beats: [
        { k: 'hw', t: 'TCIF4 的意思是「DMA 把最后一个字节交给了 USART」。可这时最后一个字节还在 USART 的发送缓冲或移位寄存器里，还要 87 µs 才真正从 PA9 出去。USART 自己的 **TC**（发送完成）位才表示「线上也发完了」。' },
        { k: 'ask', id: 'd10-a', type: 'choice', q: '发完一串数据后要关掉 USART 省电（或者切换 RS485 的方向），应该等哪个标志？',
          opts: [
            { t: '先等 DMA 的 TCIF4（全交给 USART 了），再等 USART 的 TC（线上也发完了）', ok: true },
            { t: '只等 TCIF4', assume: 'DMA 搬完就是发完', counter: 'TCIF4 来的时候最后一两个字节还在 USART 里。这时关 USART，最后的字节就只发了一半。', back: 's10' }
          ],
          explain: '对。只是接着发下一段的话，等 TCIF4 就够了：USART 会排着队发。' },
        { k: 'say', t: '在 USART 那头，TC 在最后一个字节的停止位发完、而且发送缓冲里没有新数据时才置 1。所以 DMA 搬完以后再等一个 TC，就一个字节都不会少。' }
      ],
      uses: ['F5'],
      gist: 'TCIF4 = DMA 搬完（最后一个字节交给了 USART）；USART 的 TC = 线上也发完。关串口、切方向要等 TC。',
      next: '回到任务：把这些写成代码，跑起来。',
      refs: [{ t: 'RM0008 USART：用 DMA 发送时 TC 的用法' }]
    },

    {
      id: 's11', stage: 'C', q: '任务：发数据的同时 LED 照常闪——写出代码，跑起来', from: 's10',
      beats: [
        { k: 'ask', id: 'd11-o', type: 'order', q: '把初始化和一次发送要做的事排好顺序（符合因果关系就算对）。',
          items: [{ t: '开 DMA1 的时钟' }, { t: 'CPAR = &USART1->DR' }, { t: 'CCR：MINC + DIR' }, { t: 'USART1 的 CR3 打开 DMAT' }, { t: '（每次发送）关 EN' }, { t: '设 CMAR、CNDTR' }, { t: '清 TCIF4' }, { t: '开 EN' }],
          rules: [
            { a: 0, b: 1, why: 'DMA1 的时钟没开，写不进去。', back: 's5' },
            { a: 0, b: 2, why: 'DMA1 的时钟没开，写不进去。', back: 's6' },
            { a: 4, b: 5, why: '通道开着时 CMAR、CNDTR 是只读的：先关 EN（F5）。', back: 's8' },
            { a: 5, b: 7, why: '地址和个数设好再开始搬。', back: 's8' },
            { a: 6, b: 7, why: '先清掉上一次的完成标志，再开始这一次。', back: 's8' },
            { a: 1, b: 7, why: '外设地址要在开始前设好。', back: 's5' },
            { a: 3, b: 7, why: '不开 DMAT，开了通道也没人喊「下一个」（F4）。', back: 's7' }
          ] },
        { k: 'fn', fn: 'dma_init' },
        { k: 'fn', fn: 'dma_send' },
        { k: 'fn', fn: 'main' },
        { k: 'w', w: 'sim', sc: 'cmp', cap: '左边：等 TXE 一个个发（发完 LED 才开始闪）；右边：交给 DMA（LED 从一开始就照常闪）。电脑收到的内容一样。' },
        { k: 'say', t: '试试在 dma_send 里把「开 EN」挪到「设 CNDTR」前面，或者在 main 里把 usart_init 挪到 dma_init 后面。' }
      ],
      uses: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'],
      gist: 'dma_init：DMA1 时钟 → CPAR = &USART1->DR → CCR = MINC | DIR → USART1 DMAT。dma_send：关 EN → CMAR、CNDTR → IFCR 清 TCIF4 → 开 EN，立刻返回。数据是 static 的 msg。',
      next: 'DMA 发完了，主循环怎么知道？总不能一直去查 TCIF4。'
    },

    {
      id: 's12', stage: 'D', q: '换个需求：发完自动通知，接着发下一段', from: 's11', transfer: true,
      beats: [
        { k: 'need', t: '要一段接一段地一直发（比如不停地往电脑上报数据），主循环照常闪灯。每次发完要马上知道，好开始下一段。' },
        { k: 'ask', id: 'd12-a', type: 'choice', q: '用学过的东西，最合适的是？',
          opts: [
            { t: '打开通道的传输完成中断（TCIE）和 NVIC：搬完进 DMA1_Channel4_IRQHandler，清 TCIF4、记一笔；主循环看到记录就发下一段', ok: true },
            { t: '主循环里 while 等 TCIF4', assume: '等一下没关系', counter: '那又回到了「CPU 守着」：等的这 2 ms 里主循环什么都干不了。', back: 's1' },
            { t: '打开循环模式 CIRC', assume: '循环模式会发下一段', counter: '循环模式是把同一块缓冲区从头再发一遍，不会换成下一段数据（[[s8]]）。', back: 's8' }
          ],
          explain: '对。和 EXTI 章一样：中断里只清标志、记一笔，处理放主循环。中断号 DMA1_Channel4_IRQn，入口 DMA1_Channel4_IRQHandler。' },
        { k: 'fn', fn: 'dma_init_tc' },
        { k: 'fn', fn: 'DMA1_Channel4_IRQHandler' },
        { k: 'fn', fn: 'main_tc' },
        { k: 'w', w: 'sim', sc: 'tc', cap: '发完一段进一次中断，主循环接着发下一段；LED 一直照常闪。' },
        { k: 'say', t: '回头看：从「CPU 的时间都花在等 TXE 上」出发，推出了中断发送的代价、专门的搬运工、通道与请求映射、CPAR / CMAR / CNDTR、DIR 与 MINC、DMAT、EN 与只读规则、TCIF 与 IFCR、数据的生命周期、TCIF 与 TC、传输完成中断。课件 DMA 那一章的每一行，现在都说得出它在回答什么问题。' }
      ],
      uses: ['F5'],
      gist: '发完要通知：CCR 打开 TCIE、NVIC 打开 DMA1_Channel4_IRQn；中断里查 TCIF4、写 IFCR 清、记一笔；主循环看到记录再发下一段。',
      refs: [{ t: 'RM0008 DMA 中断；向量表 DMA1_Channel4 = 14' }]
    }
    ],

    globals: ['static const uint8_t msg[] = "hello DMA, CPU is free!\\r\\n";', 'static volatile uint8_t done = 0;'],

    fns: {
      usart_init: {
        sig: 'void usart_init(void)', doc: 'USART1 115200 发送（USART 章推过）', sc: 'dma',
        lines: [
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_USART1EN;', why: 'GPIOA 和 USART1 的时钟。', from: ['s11'] },
          { c: 'GPIOA->CRH = (GPIOA->CRH & ~(GPIO_CRH_CNF9 | GPIO_CRH_MODE9)) | GPIO_CRH_CNF9_1 | GPIO_CRH_MODE9;', why: 'PA9 复用推挽输出（TX）。', from: ['s11'] },
          { c: 'USART1->BRR = 625;', why: '72 MHz ÷ 115200 = 625。', from: ['s1'] },
          { c: 'USART1->CR1 = USART_CR1_TE | USART_CR1_UE;', why: '打开发送和 USART1。', from: ['s11'] }
        ],
        rules: [{ a: 0, b: 2, sc: 'dma', why: 'USART1 的时钟没开，BRR 写不进去。', back: 's11' }]
      },
      led_init: {
        sig: 'void led_init(void)', doc: 'PA0（LED1）推挽输出', sc: 'dma',
        lines: [
          { c: 'RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', why: '开 GPIOA 时钟。' },
          { c: 'GPIOA->BSRR = GPIO_BSRR_BS0;', why: '先写 1（灭）。' },
          { c: 'GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0)) | GPIO_CRL_MODE0;', why: 'PA0 推挽输出。' }
        ],
        rules: []
      },
      dma_init: {
        sig: 'void dma_init(void)', doc: 'DMA1 通道 4：内存 → USART1->DR，内存地址递增', sc: 'dma',
        lines: [
          { c: 'RCC->AHBENR |= RCC_AHBENR_DMA1EN;', why: 'DMA1 挂在 AHB 上：开它的时钟。', from: ['s4'] },
          { c: 'DMA1_Channel4->CPAR = (uint32_t)&USART1->DR;', why: '外设那一头：USART1 的数据寄存器（F2）。通道 4 是 USART1_TX 的（F1）。', from: ['F1', 'F2', 's5'] },
          { c: 'DMA1_Channel4->CCR = DMA_CCR4_MINC | DMA_CCR4_DIR;', why: 'DIR = 1 内存 → 外设，MINC = 1 内存地址递增，PINC = 0，8 位（F3）。先不开 EN。', from: ['F3', 's6'] },
          { c: 'USART1->CR3 |= USART_CR3_DMAT;', why: 'USART1 的 TXE 变成 DMA 请求（F4）。', from: ['F4', 's7'] }
        ],
        rules: [
          { a: 0, b: 1, sc: 'dma', why: 'DMA1 的时钟没开，CPAR 写不进去。', back: 's5' },
          { a: 0, b: 2, sc: 'dma', why: 'DMA1 的时钟没开，CCR 写不进去：方向和递增都没设上。', back: 's6' }
        ]
      },
      dma_send: {
        sig: 'void dma_send(const uint8_t *buf, uint16_t n)', doc: '把 buf 里的 n 个字节交给 DMA，立刻返回', sc: 'dma',
        lines: [
          { c: 'DMA1_Channel4->CCR &= ~DMA_CCR4_EN;', why: '先关通道：开着的时候 CMAR、CNDTR 改不了（F5）。', from: ['F5', 's8'] },
          { c: 'DMA1_Channel4->CMAR = (uint32_t)buf;', why: '内存那一头：要发的数据（F2）。buf 要一直有效到发完（F6）。', from: ['F2', 'F6', 's9'] },
          { c: 'DMA1_Channel4->CNDTR = n;', why: '搬 n 个（F2）。', from: ['F2', 's5'] },
          { c: 'DMA1->IFCR = DMA_IFCR_CTCIF4;', why: '清掉上一次的 TCIF4：写 1 清（F5）。', from: ['F5', 's8'] },
          { c: 'DMA1_Channel4->CCR |= DMA_CCR4_EN;', why: '开始：之后 USART 每喊一次，DMA 搬一个。函数马上返回。', from: ['F5', 's8'] }
        ],
        rules: [
          { a: 0, b: 1, sc: 'dma', why: '先关通道再改 CMAR（F5）。', back: 's8', simNote: '这里看不出区别：第一次发送时通道本来就是关着的。连着发第二段时，不先关就改不了地址（看最后一环）。' },
          { a: 1, b: 4, sc: 'dma', why: '地址设好再开通道：开了以后 CMAR 只读，写不进去（F5）。', back: 's8' },
          { a: 2, b: 4, sc: 'dma', why: '个数设好再开通道：CNDTR 还是 0 就开始，什么也不搬（F5）。', back: 's8' },
          { a: 3, b: 4, sc: 'dma', why: '先清旧的完成标志再开始。', back: 's8', simNote: '这里看不出区别：开 EN 以后要等 2 ms 才会搬完，紧接着清标志也来得及。但如果开了传输完成中断，顺序反了就可能把这一次的标志当成上一次的。' }
        ]
      },
      main: {
        sig: 'int main(void)', doc: '交给 DMA 发，主循环照常闪 LED', sc: 'dma',
        lines: [
          { c: 'usart_init();', why: '' },
          { c: 'led_init();', why: '' },
          { c: 'dma_init();', why: '要写 USART1->CR3：USART1 的时钟得先开。', from: ['s11'] },
          { c: 'dma_send(msg, sizeof(msg) - 1);', why: 'msg 是 static 的，一直有效（F6）；sizeof 包含结尾的 0，减 1。', from: ['F6', 's9'] },
          { c: 'while (1) {', why: '' },
          { c: '    GPIOA->ODR ^= GPIO_ODR_ODR0;', why: 'DMA 在后台发，CPU 照常干别的。', from: ['s3'] },
          { c: '    Delay_us(500);', why: '' },
          { c: '}' }
        ],
        rules: [{ a: 0, b: 2, sc: 'dma', why: 'dma_init 要写 USART1 的 CR3：USART1 的时钟没开，DMAT 写不进去，什么也不发。', back: 's7' }]
      },
      main_poll: {
        sig: 'int main(void)', doc: 'USART 章的写法：等 TXE，一个个发', sc: 'poll',
        lines: [
          { c: 'usart_init();', why: '' },
          { c: 'led_init();', why: '' },
          { c: 'for (uint16_t i = 0; i < sizeof(msg) - 1; i++) {', why: '' },
          { c: '    while ((USART1->SR & USART_SR_TXE) == 0);', why: 'CPU 守在这里空等。', from: ['s1'] },
          { c: '    USART1->DR = msg[i];', why: '' },
          { c: '}' },
          { c: 'while (1) {', why: '' },
          { c: '    GPIOA->ODR ^= GPIO_ODR_ODR0;', why: '发完才轮到闪灯。', from: ['s1'] },
          { c: '    Delay_us(500);', why: '' },
          { c: '}' }
        ],
        rules: []
      },
      dma_init_tc: {
        sig: 'void dma_init_tc(void)', doc: '在 dma_init 的基础上打开传输完成中断', sc: 'tc',
        lines: [
          { c: 'dma_init();', why: '' },
          { c: 'DMA1_Channel4->CCR |= DMA_CCR4_TCIE;', why: '搬完（TCIF4 = 1）时产生中断。通道还没开，可以改 CCR。', from: ['F5', 's12'] },
          { c: 'NVIC_EnableIRQ(DMA1_Channel4_IRQn);', why: 'NVIC 里打开 14 号中断。', from: ['s12'] }
        ],
        rules: []
      },
      DMA1_Channel4_IRQHandler: {
        sig: 'void DMA1_Channel4_IRQHandler(void)', doc: '名字必须和启动文件里一字不差', sc: 'tc',
        lines: [
          { c: 'if (DMA1->ISR & DMA_ISR_TCIF4) {', why: '确认是传输完成。', from: ['F5'] },
          { c: '    DMA1->IFCR = DMA_IFCR_CTCIF4;', why: '写 1 清 TCIF4，否则一返回又进来。', from: ['F5', 's12'] },
          { c: '    done = 1;', why: '只记一笔，发下一段放到主循环（EXTI 章 F6）。', from: ['s12'] },
          { c: '}' }
        ],
        rules: []
      },
      main_tc: {
        sig: 'int main(void)', doc: '一段发完马上接着发下一段', sc: 'tc',
        lines: [
          { c: 'usart_init();', why: '' },
          { c: 'led_init();', why: '' },
          { c: 'dma_init_tc();', why: '' },
          { c: 'dma_send(msg, sizeof(msg) - 1);', why: '先发第一段。', from: ['F6'] },
          { c: 'uint8_t k = 1;', why: '已经发了几段：这里一共发 3 段。' },
          { c: 'while (1) {', why: '' },
          { c: '    if (done && k < 3) {', why: '中断说发完了，而且还没发够。', from: ['s12'] },
          { c: '        done = 0;', why: '' },
          { c: '        k++;', why: '' },
          { c: '        dma_send(msg, sizeof(msg) - 1);', why: '接着发下一段（这里简单起见还是同一段）。dma_send 里先关 EN 再改，正好用上 F5。', from: ['F5', 's12'] },
          { c: '    }' },
          { c: '    GPIOA->ODR ^= GPIO_ODR_ODR0;', why: 'LED 照常闪。' },
          { c: '    Delay_us(500);', why: '' },
          { c: '}' }
        ],
        rules: []
      }
    },

    scenarios: {
      poll: { title: '等 TXE 一个个发', ms: 4, entry: ['main_poll'], view: { pins: ['PA9', 'PA0'], from: 0, to: 4000 } },
      dma: { title: '交给 DMA 发', ms: 4, view: { pins: ['PA9', 'PA0'], from: 0, to: 4000 } },
      cmp: { compare: ['poll', 'dma'] },
      nominc: { title: '忘了 MINC', ms: 4, patch: { dma_init: { set: { 2: { c: 'DMA1_Channel4->CCR = DMA_CCR4_DIR;' } } } }, view: { pins: ['PA9'], from: 0, to: 4000 } },
      nodmat: { title: '忘了 DMAT', ms: 4, patch: { dma_init: { order: [0, 1, 2] } }, view: { pins: ['PA9', 'PA0'], from: 0, to: 4000 } },
      tc: { title: '发完一段进一次中断，接着发下一段（共 3 段）', ms: 10, entry: ['main_tc'], view: { pins: ['PA9', 'PA0'], from: 0, to: 10000 } }
    }
  };
})();
