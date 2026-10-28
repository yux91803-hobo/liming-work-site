/* regcode.js — 寄存器版代码：整段程序，每一行一句注释，点开看「为什么这样写」
   有 Code 推导章的外设（GPIO / USART / I2C / TIM / ADC / SPI）直接用章里的函数（derive-*.js 的 fns，理由在 line.why），
   这里只补每行的短注释 cm 和动笔前的思路 plan；没有推导章的（RCC / EXTI / DMA / FSMC）整段写在这里。
   不碰 DOM；Node 里测试：注释条数和代码行数对得上、函数名都存在。 */
(function () {
  'use strict';
  var W = typeof window === 'object' ? window : this;

  // ---------- 推导章里的函数：每行注释（和 fns[fn].lines 一一对应；pre 是宏定义行） ----------
  var CM = {
    gpio: {
      led_init: ['打开 GPIOA 的时钟（不开时钟，后面写 GPIOA 都无效）', '先让 ODR0 = 1：LED1 低电平亮，1 = 灭', '清掉 PA0 的 4 位配置（CNF0、MODE0）', 'MODE0 = 11：推挽输出，50 MHz'],
      main: ['配置 LED1', '一直循环', 'ODR0 取反：亮 ↔ 灭', '等 500 ms', ''],
      key_init: ['打开 GPIOF 的时钟', '清掉 PF8 的 4 位配置', 'CNF8 = 10：上拉 / 下拉输入', 'ODR8 = 1 → 选上拉（松开时读到 1）'],
      main_key: ['配置 LED1', '配置 KEY1', '一直循环', '读到 0：可能按下了', '等 10 ms，躲开抖动', '还是 0：确实按下了', '翻转 LED1', '等松手（不然按住会一直翻）', '松手也会抖，再等 10 ms', '', '', '']
    },
    usart: {
      usart1_init: ['打开 GPIOA 和 USART1 的时钟', 'PA9 复用推挽输出（TX），PA10 浮空输入（RX）', '波特率 115200：72 MHz / 115200 ≈ 39.06 → 0x271', '打开发送、接收（8 位、无校验、1 停止位是默认值）', '最后打开 USART1'],
      usart1_send_byte: ['等发送缓冲空（TXE = 1）', '写进数据寄存器，硬件开始发'],
      usart1_send_string: ['一个一个字节发，直到字符串结尾的 0', '发一个字节'],
      main: ['初始化串口', '一直循环', '发 hello 和换行', '等 1 秒', ''],
      main_echo: ['初始化串口', '一直循环', '等收到一个字节（RXNE = 1）', '读出来（读 DR 同时清掉 RXNE）', '原样发回去', '']
    },
    i2c: {
      _pre: ['松开 SCL：开漏写 1 = 不拉，上拉电阻把线拉高', '拉低 SCL', '松开 SDA', '拉低 SDA', '读 SDA 线上的电平', '每半个时钟等 5 µs（约 100 kHz）'],
      i2c_init: ['打开 GPIOB 的时钟', '先松开 SCL', '先松开 SDA（总线空闲 = 两根都高）', 'PB10、PB11 = 0111：开漏输出 50 MHz'],
      i2c_start: ['SDA 先松开（高）', '等一会', 'SCL 松开（高）', '等一会', 'SCL 高的时候 SDA 由高变低 = 起始信号', '等一会', '拉低 SCL，准备发数据'],
      i2c_stop: ['SDA 先拉低', '等一会', 'SCL 松开（高）', '等一会', 'SCL 高的时候 SDA 由低变高 = 停止信号', '等一会'],
      i2c_send_byte: ['发 8 位，高位先发', '最高位是 1 就松开 SDA，是 0 就拉低', '下一位挪到最高位', 'SCL 低的时候改 SDA，等它稳定', 'SCL 拉高：对方在这时读 SDA', '保持一会', 'SCL 拉低，准备下一位', ''],
      i2c_wait_ack: ['存应答结果', '松开 SDA，把线交给对方', '等一会', '第 9 个时钟：SCL 拉高', '等一会', '读 SDA：0 = 应答（ACK），1 = 没应答', 'SCL 拉低，这一位结束', '返回：0 成功，1 失败'],
      eeprom_write_byte: ['出错标志：0 = 成功', '起始', '器件地址 1010 000 + 写（0）= 0xA0', '等应答', '发存储地址，等应答', '发数据，等应答', '停止', '成功的话等 5 ms：EEPROM 内部正在写', '返回：0 成功'],
      i2c_read_byte: ['收到的字节，从 0 开始拼', '松开 SDA，让 EEPROM 来驱动', '收 8 位，高位先到', 'SCL 低，等 EEPROM 把数据放上来', 'SCL 拉高', '等数据稳定', '左移一位，读到的这一位放进最低位', 'SCL 拉低', '', '返回收到的字节'],
      i2c_send_nack: ['松开 SDA = 不应答：告诉 EEPROM 读够了', '等一会', '第 9 个时钟：SCL 拉高', '等一会', 'SCL 拉低，这一位结束'],
      eeprom_read_byte: ['出错标志：0 = 成功', '起始', '先用「写」把存储地址告诉它', '等应答', '发存储地址', '重复起始 + 器件地址「读」（0xA1）', '读一个字节，回 NACK', '停止', '返回：0 成功']
    },
    tim: {
      led_init: ['打开 GPIOA 的时钟', '先让 ODR1 = 1（LED2 灭）', 'PA1 推挽输出 50 MHz'],
      tim6_init: ['打开 TIM6 的时钟（挂在 APB1）', '预分频：72 MHz / 7200 = 10 kHz，每 0.1 ms 计一次', '计满 10000 次 = 1 秒溢出一次', '产生一次更新事件：让 PSC 立刻生效', 'UG 也会置 UIF，先清掉', '允许更新中断', '中断优先级', 'NVIC 里打开 TIM6 中断', '开始计数'],
      TIM6_IRQHandler: ['是更新中断吗', '清掉 UIF（不清会一直进中断）', '翻转 LED2', ''],
      main: ['配置 LED2', '配置 TIM6', '主循环什么都不用做', ''],
      pwm_init: ['打开 TIM5 的时钟', '打开 GPIOA 的时钟', 'PA1 复用推挽输出（TIM5_CH2）', '72 MHz / 72 = 1 MHz，每 1 µs 计一次', '周期 1000 µs，即 1 kHz', '比较值 200 → 占空比 20%', 'CH2 设成 PWM 模式 1，开预装载', '打开 CH2 输出，低电平有效（LED2 低电平亮）', 'ARR 也开预装载', '更新事件：把上面的值装进去', '开始计数'],
      main_pwm: ['配置 PWM', '主循环什么都不用做：波形全由硬件产生', ''],
      main_breathe: ['配置 PWM', '一直循环', '占空比从 0 慢慢加到 100%', '改比较值 = 改亮度', '每 10 ms 变一点', '', '再慢慢减回 0', '改比较值', '每 10 ms 变一点', '', '']
    },
    adc: {
      adc_init: ['打开 ADC1 和 GPIOC 的时钟', 'ADC 时钟 = 72 MHz / 6 = 12 MHz（不能超过 14 MHz）', 'PC0 设成模拟输入（4 位全 0）', '通道 10 采样 239.5 个周期（最长，最稳）', '规则组只转 1 个通道', '第 1 个转换的是通道 10', '触发源选 SWSTART，并允许外部触发', '给 ADC 上电', '等它稳定（约 1 µs）', '开始校准', '等校准完成（CAL 变回 0）'],
      adc_read: ['软件启动一次转换', '等转换结束（EOC = 1）', '读结果（同时清掉 EOC）'],
      main: ['初始化 ADC', '一直循环', '读一次', '打印读数和电压：v × 3.3 / 4096', '等 0.5 秒', ''],
      main_avg: ['初始化 ADC', '连续模式：转完自动开始下一个', '启动第一次', '一直循环', '累加器清零', '取 16 次', '等一个新结果', '加上去（读 DR 清掉 EOC）', '', '打印平均值', '等 0.5 秒', '']
    },
    spi: {
      spi1_init: ['打开 SPI1、GPIOA、GPIOC 的时钟', '片选先拉高（不选中 Flash）', 'PC13 推挽输出：片选自己控制', 'PA5 SCK、PA7 MOSI 复用推挽；PA6 MISO 浮空输入', '主机、软件管片选、72 MHz / 8 = 9 MHz、模式 0', '打开 SPI1'],
      spi_swap: ['等发送缓冲空', '发一个字节（同时开始收）', '等收完一个字节', '返回收到的字节'],
      w25q_read_id: ['拼 24 位的 ID', '片选拉低：开始一条命令', '发命令 0x9F（读 JEDEC ID）', '发空字节，换回厂商 ID', '换回存储类型', '换回容量', '片选拉高：命令结束', '返回 0xEF4016'],
      main: ['初始化 SPI1', '读 ID 并打印', '读完就停在这里', ''],
      w25q_read: ['片选拉低', '读数据命令 0x03', '地址高字节', '地址中字节', '地址低字节', '连续读 n 个', '每个字节打印出来', '片选拉高', '换行'],
      main_read: ['初始化 SPI1', '从 0x012345 开始读 4 个字节', '读完就停在这里', '']
    }
  };

  // ---------- 每个外设的程序 ----------
  // 推导章的程序：fns 是章里的函数名；自己写的程序：fns 是 [{ sig, lines: [[代码, 注释, 为什么]] }]
  var PROGS = {
    gpio: [
      { id: 'blink', title: 'LED1 每 0.5 秒亮灭', chapter: 'gpio', fns: ['led_init', 'main'],
        plan: ['LED1 接 PA0，低电平亮 → 要把 PA0 配成输出', '用 GPIOA 之前先开它的时钟（RCC_APB2ENR 的 IOPAEN）', '先把 ODR0 写成 1，再切成输出：上电那一刻灯不会闪一下', '主循环里翻转 ODR0，中间延时 500 ms'] },
      { id: 'key', title: '按一下 KEY1，LED1 换一次状态', chapter: 'gpio', fns: ['led_init', 'key_init', 'main_key'],
        plan: ['KEY1 接 PF8，按下接地，板上没有上拉 → PF8 配成上拉输入', '读 IDR8：0 = 按下', '机械按键会抖 10 ms 左右 → 读到 0 先等 10 ms 再确认', '按住不放只能算一次 → 等松手'] }
    ],
    usart: [
      { id: 'hello', title: '每秒向电脑发一次 hello', chapter: 'usart', fns: ['usart1_init', 'usart1_send_byte', 'usart1_send_string', 'main'],
        plan: ['板上 USART1：PA9 = TX、PA10 = RX，经 ST-Link 变成电脑上的串口', '开 GPIOA 和 USART1 的时钟，PA9 复用推挽、PA10 输入', '双方约好波特率 115200 → 算出 BRR', '发一个字节前先等 TXE（上一个字节已经交给移位寄存器）'] },
      { id: 'echo', title: '收到什么就发回什么', chapter: 'usart', fns: ['usart1_init', 'usart1_send_byte', 'main_echo'],
        plan: ['初始化和上一个一样', '等 RXNE = 1 说明收到了一个字节', '读 DR 拿到它（读的同时清掉 RXNE），再发回去'] }
    ],
    i2c: [
      { id: 'write', title: '向 M24C02 写一个字节（软件 I2C）', chapter: 'i2c', fns: ['i2c_init', 'i2c_start', 'i2c_stop', 'i2c_send_byte', 'i2c_wait_ack', 'eeprom_write_byte'],
        plan: ['M24C02 接 PB10（SCL）、PB11（SDA），板上有 10kΩ 上拉 → 两个脚都配成开漏输出', '「写 1」= 松开，让上拉把线拉高；「写 0」= 拉低', '按 I2C 的规矩拼时序：起始 → 地址 + 写 → 存储地址 → 数据 → 停止，每个字节后读一次应答', '写完 EEPROM 要忙 5 ms，这期间不应答'] },
      { id: 'read', title: '从 M24C02 读回一个字节', chapter: 'i2c', fns: ['i2c_read_byte', 'i2c_send_nack', 'eeprom_read_byte'],
        plan: ['先像写一样，把要读的存储地址「写」给它', '重复起始，再发器件地址 + 读（0xA1）', '读 8 位，最后一个字节回 NACK 告诉它读完了，然后停止', '起始、停止、发字节这些函数和上一个程序共用'] }
    ],
    tim: [
      { id: 'irq', title: '定时器中断：LED2 每秒翻转', chapter: 'tim', fns: ['led_init', 'tim6_init', 'TIM6_IRQHandler', 'main'],
        plan: ['72 MHz 太快 → 先用 PSC 分频到 10 kHz，再数 10000 次 = 1 秒', 'TIM6 是基本定时器，只会计数和产生更新中断，正好够用', 'PSC 要等更新事件才生效 → 配好以后手动 UG 一次，再清掉它顺带置起的 UIF', '中断里第一件事清 UIF，不然出来马上又进去'] },
      { id: 'breathe', title: 'PWM 呼吸灯（LED2，TIM5_CH2）', chapter: 'tim', fns: ['pwm_init', 'main_breathe'],
        plan: ['LED2 接 PA1，PA1 的复用功能里有 TIM5_CH2 → 用硬件 PWM', '1 MHz 计数、ARR = 999 → 1 kHz，人眼看不出闪', '改 CCR2 = 改占空比 = 改亮度；LED 低电平亮，所以输出极性选低有效', '主循环里慢慢加、慢慢减 CCR2'] }
    ],
    adc: [
      { id: 'read', title: '读电位器电压，每 0.5 秒打印一次', chapter: 'adc', fns: ['adc_init', 'adc_read', 'main'],
        plan: ['电位器接 PC0 = ADC 通道 10 → PC0 配成模拟输入', 'ADC 时钟不能超过 14 MHz → 72 MHz 六分频得 12 MHz', '只转一个通道：规则组长度 1，第一个就是通道 10', '上电 → 等稳定 → 校准 → 以后每次 SWSTART 启动、等 EOC、读 DR', '12 位结果：电压 = 读数 × 3.3 / 4096（printf 已重定向到串口）'] },
      { id: 'avg', title: '连续转换 + 16 次平均', chapter: 'adc', fns: ['adc_init', 'main_avg'],
        plan: ['读数在最后一两位上跳是正常的噪声 → 多读几次取平均', '打开连续模式，只启动一次，以后每次等 EOC 读一个', '16 个 12 位数相加最大 65520，要用 32 位变量'] }
    ],
    spi: [
      { id: 'id', title: '读出 W25Q32 的 JEDEC ID', chapter: 'spi', fns: ['spi1_init', 'spi_swap', 'w25q_read_id', 'main'],
        plan: ['W25Q32 接 SPI1：PA5 SCK、PA6 MISO、PA7 MOSI，片选 PC13', '片选用普通推挽输出自己控制，SPI 设成软件管理 NSS（SSM = SSI = 1）', 'SPI 是「交换」：发一个字节的同时收一个字节 → 写一个 spi_swap', '命令格式：拉低 CS → 0x9F → 换回 3 个字节 → 拉高 CS'] },
      { id: 'read', title: '从 Flash 读数据', chapter: 'spi', fns: ['w25q_read', 'main_read'],
        plan: ['读数据命令 0x03 + 3 字节地址，之后每发一个空字节就换回一个数据', '读多少个都在同一次片选里完成'] }
    ],
    sys: [
      { id: 'clock', title: '系统时钟切到 72 MHz（HSE 8 MHz × 9）', plan: ['上电默认用内部 8 MHz（HSI）；要 72 MHz 得用外部 8 MHz 晶振经 PLL ×9', '顺序：开 HSE 等稳定 → 设好 Flash 等待和总线分频 → 配 PLL → 开 PLL 等锁定 → 切换 → 等切换完成', 'Flash 跟不上 72 MHz，要先加 2 个等待周期，再提速', 'APB1 最高 36 MHz → 二分频'],
        fns: [{ sig: 'void clock_72mhz(void)', lines: [
          ['RCC->CR |= RCC_CR_HSEON;', '打开外部 8 MHz 晶振（HSE）', '外部晶振比内部 RC 振荡器准得多（串口、USB 都靠它）。先打开它，PLL 才有输入。'],
          ['while ((RCC->CR & RCC_CR_HSERDY) == 0);', '等 HSE 起振稳定', '晶振从上电到稳定要一段时间，硬件稳定后置 HSERDY。没等稳定就用，后面 PLL 会锁不住。'],
          ['FLASH->ACR = FLASH_ACR_PRFTBE | (2 << FLASH_ACR_LATENCY_Pos);', 'Flash 等 2 个周期，开预取', 'Flash 的读速度跟不上 CPU：手册规定 0~24 MHz 不用等，24~48 MHz 等 1 个周期，48~72 MHz 等 2 个。必须在提速之前设好，否则一切到 72 MHz 就会读错指令。'],
          ['RCC->CFGR |= RCC_CFGR_PPRE1_DIV2;', 'APB1 = 72 / 2 = 36 MHz', 'APB1 总线最高 36 MHz（TIM2~7、USART2/3、I2C 挂在上面）；APB2 和 AHB 可以跑满 72 MHz，保持不分频。'],
          ['RCC->CFGR |= RCC_CFGR_PLLSRC;', 'PLL 输入选 HSE', 'PLLSRC = 1：PLL 的输入来自 HSE（PLLXTPRE = 0，不二分频）。为 0 时是 HSI / 2 = 4 MHz。'],
          ['RCC->CFGR |= RCC_CFGR_PLLMULL9;', 'PLL × 9 → 72 MHz', '8 MHz × 9 = 72 MHz，正好是 F103 的最高主频。PLL 打开以后就不能再改倍频，所以要先设好。'],
          ['RCC->CR |= RCC_CR_PLLON;', '打开 PLL', '倍频、来源都设好了才打开。'],
          ['while ((RCC->CR & RCC_CR_PLLRDY) == 0);', '等 PLL 锁定', 'PLL 锁定后硬件置 PLLRDY，之前它的输出不稳定。'],
          ['RCC->CFGR |= RCC_CFGR_SW_PLL;', '系统时钟切到 PLL', 'SW = 10：SYSCLK 来自 PLL。从这一刻起 CPU 跑在 72 MHz。'],
          ['while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL);', '等切换真正完成', '切换不是立刻发生的，SWS 反映当前实际的时钟源，等它变成 PLL 再往下走。']
        ] }] }
    ],
    exti: [
      { id: 'key', title: 'KEY1 按下触发中断，翻转 LED1', plan: ['KEY1 接 PF8，按下 1 → 0 → 用下降沿触发', '引脚先配成上拉输入（和 GPIO 章一样）', 'EXTI 线 8 可以接 PA8~PG8 中的任意一个 → 在 AFIO_EXTICR3 里选 PF', '打开线 8 的下降沿和中断屏蔽，再在 NVIC 打开 EXTI9_5（线 5~9 共用一个中断）', '中断里先确认是线 8，清标志，再干活'],
        fns: [
          { sig: 'void led_init(void)', lines: [
            ['RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', '打开 GPIOA 的时钟', '和 GPIO 章一样：用 GPIOA 先开时钟。'],
            ['GPIOA->BSRR = GPIO_BSRR_BS0;', 'ODR0 = 1：LED1 先灭', 'LED1 低电平亮，先写 1，切成输出时就不会亮一下。'],
            ['GPIOA->CRL = (GPIOA->CRL & ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0)) | GPIO_CRL_MODE0;', 'PA0 推挽输出 50 MHz', '先清掉 4 位再置 MODE0 = 11，一句写完。']
          ] },
          { sig: 'void key1_exti_init(void)', lines: [
            ['RCC->APB2ENR |= RCC_APB2ENR_IOPFEN | RCC_APB2ENR_AFIOEN;', '打开 GPIOF 和 AFIO 的时钟', '「EXTI 线接哪个口」的选择寄存器 EXTICR 在 AFIO 里，所以 AFIO 的时钟也要开——这是最容易漏的一步。'],
            ['GPIOF->CRH = (GPIOF->CRH & ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8)) | GPIO_CRH_CNF8_1;', 'PF8 上拉 / 下拉输入', 'CNF8 = 10、MODE8 = 00：输入，带上拉或下拉，具体哪个由 ODR8 决定。'],
            ['GPIOF->BSRR = GPIO_BSRR_BS8;', 'ODR8 = 1 → 上拉', '板上 KEY1 没有外部上拉，松开时要靠内部上拉读到 1。'],
            ['AFIO->EXTICR[2] = (AFIO->EXTICR[2] & ~AFIO_EXTICR3_EXTI8) | AFIO_EXTICR3_EXTI8_PF;', 'EXTI 线 8 接到 PF8', '每条 EXTI 线只有一个输入：线 8 在 PA8~PG8 里选一个。EXTICR[2] 就是手册里的 EXTICR3（管线 8~11），PF 的编码是 0101。'],
            ['EXTI->FTSR |= EXTI_FTSR_TR8;', '线 8 下降沿触发', '按下时 PF8 从 1 变 0 → 下降沿。上升沿（RTSR）不开，松手时就不会再触发。'],
            ['EXTI->PR = EXTI_PR_PR8;', '先清掉可能挂着的标志', 'PR 写 1 清零。配置过程中引脚电平可能变过，先清一次，免得一打开中断就进去。'],
            ['EXTI->IMR |= EXTI_IMR_MR8;', '不屏蔽线 8 的中断', 'IMR = 1 才会把线 8 的请求送到 NVIC。'],
            ['NVIC_EnableIRQ(EXTI9_5_IRQn);', 'NVIC 里打开 EXTI9_5 中断', '线 5~9 共用一个中断入口 EXTI9_5_IRQHandler，所以中断里要自己判断是哪条线。']
          ] },
          { sig: 'void EXTI9_5_IRQHandler(void)', lines: [
            ['if (EXTI->PR & EXTI_PR_PR8) {', '是线 8 来的吗', '线 5~9 都会进这里，先看 PR 里哪一位是 1。'],
            ['    EXTI->PR = EXTI_PR_PR8;', '写 1 清掉标志', '不清的话退出中断后标志还在，会立刻再进来，主程序再也跑不到。注意是写 1 清，不是写 0。'],
            ['    GPIOA->ODR ^= GPIO_ODR_ODR0;', '翻转 LED1', '真正要干的活放在清标志之后。按键会抖，可能一次按下进好几次中断；要求严格时在这里记下时间，主循环里再消抖。'],
            ['}', '', '']
          ] },
          { sig: 'int main(void)', lines: [
            ['led_init();', '配置 LED1', ''],
            ['key1_exti_init();', '配置 KEY1 中断', ''],
            ['while (1) {', '主循环什么都不用做', '按键的事全交给中断，CPU 可以干别的，或者进低功耗。'],
            ['}', '', '']
          ] }
        ] }
    ],
    dma: [
      { id: 'tx', title: '用 DMA 把一串字符发到串口', plan: ['逐个字节等 TXE 再写 DR，CPU 一直被占着 → 让 DMA 搬：每次 TXE 来了，DMA 自动把下一个字节写进 USART1->DR', '查 DMA 请求映射表：USART1_TX 在 DMA1 通道 4', '告诉通道：从哪搬（内存地址）、搬到哪（USART1->DR）、搬几个、方向、地址要不要递增', 'USART 这边打开 DMAT（发送用 DMA），最后使能通道', '搬完 DMA 置 TCIF4；下一次之前先关通道才能改 CNDTR'],
        fns: [
          { sig: 'void usart1_dma_send(const char *s, uint16_t n)', lines: [
            ['RCC->AHBENR |= RCC_AHBENR_DMA1EN;', '打开 DMA1 的时钟（在 AHB 上）', 'DMA 控制器挂在 AHB 总线，时钟开关在 AHBENR，不在 APB2ENR。'],
            ['DMA1_Channel4->CCR &= ~DMA_CCR_EN;', '先关掉通道', '通道开着的时候 CPAR、CMAR、CNDTR 都改不了，每次重新发之前都要先关。'],
            ['DMA1_Channel4->CPAR = (uint32_t)&USART1->DR;', '外设地址：USART1 的数据寄存器', '每搬一个字节就写到这里，写 DR 就是让串口发出去。'],
            ['DMA1_Channel4->CMAR = (uint32_t)s;', '内存地址：字符串开头', '从这里开始读。'],
            ['DMA1_Channel4->CNDTR = n;', '要搬 n 个字节', '每搬一个减 1，减到 0 就停，并置完成标志 TCIF4。'],
            ['DMA1_Channel4->CCR = DMA_CCR_MINC | DMA_CCR_DIR;', '内存地址递增；方向：内存 → 外设', 'MINC = 1：每次读下一个字节；外设地址不递增（一直写 DR）。DIR = 1 表示从内存读、写到外设。PSIZE / MSIZE 保持 00 = 8 位。'],
            ['DMA1->IFCR = DMA_IFCR_CTCIF4;', '清掉上次的完成标志', '不清的话下面的 while 会直接通过。'],
            ['USART1->CR3 |= USART_CR3_DMAT;', 'USART1 发送用 DMA', 'DMAT = 1：每当 TXE = 1，USART 就向 DMA 发一次请求，DMA 搬一个字节过来。'],
            ['DMA1_Channel4->CCR |= DMA_CCR_EN;', '开始搬', '使能通道后，搬运完全由硬件完成，CPU 可以去干别的。'],
            ['while ((DMA1->ISR & DMA_ISR_TCIF4) == 0);', '（演示用）等搬完', '这里为了简单直接等；实际可以打开 TCIE 用中断通知，等待期间 CPU 做别的事。注意 TCIF 只说明最后一个字节交给了 USART，要确认发完得再等 USART 的 TC。']
          ] },
          { sig: 'int main(void)', lines: [
            ['usart1_init();', '串口初始化（和 USART 章一样）', '115200、PA9 / PA10，见 Code 里的 USART 章。'],
            ['usart1_dma_send("hello DMA\\r\\n", 11);', '交给 DMA 发 11 个字节', 'h e l l o 空格 D M A \\r \\n，一共 11 个。'],
            ['while (1) {', '', ''],
            ['}', '', '']
          ] }
        ] }
    ],
    fsmc: [
      { id: 'lcd', title: '用 FSMC 驱动 LCD 接口（16 位 8080 总线）', plan: ['LCD 接在 FSMC Bank1 第 4 区（NE4 = PG12）→ 地址 0x6C00 0000 起，CPU 往这个地址写，FSMC 自动产生片选、写使能和数据线上的波形', 'RS（命令 / 数据）接 FSMC_A10：写地址的 A10 = 0 是命令，= 1 是数据', '16 位总线时 FSMC 的 A10 对应 CPU 地址的第 11 位 → 数据地址 = 0x6C00 0000 + (1 << 11)', '用到的脚（D0~D15、NOE、NWE、NE4、A10）全部配成复用推挽', 'Bank1 设成 SRAM 类型、16 位宽、允许写，再设读写时序'],
        fns: [
          { sig: '#define', lines: [
            ['#define LCD_CMD  (*(volatile uint16_t *)0x6C000000)', '写这里 = 发命令（A10 = 0）', 'NE4 对应 Bank1 第 4 区，起始地址 0x6C00 0000；volatile 保证每次都真的去写总线，不被编译器优化掉。'],
            ['#define LCD_DATA (*(volatile uint16_t *)0x6C000800)', '写这里 = 发数据（A10 = 1）', '16 位宽时 FSMC 把 CPU 地址右移一位再送到 A 线上：A10 = 1 对应 CPU 地址的 bit11，即 0x800。']
          ] },
          { sig: 'void fsmc_lcd_init(void)', lines: [
            ['RCC->AHBENR |= RCC_AHBENR_FSMCEN;', '打开 FSMC 的时钟（在 AHB 上）', 'FSMC 和 DMA 一样挂在 AHB。'],
            ['RCC->APB2ENR |= RCC_APB2ENR_IOPBEN | RCC_APB2ENR_IOPDEN | RCC_APB2ENR_IOPEEN | RCC_APB2ENR_IOPGEN;', '打开 GPIOB / D / E / G 的时钟', 'FSMC 的线分散在 PD、PE、PG；背光在 PB0。'],
            ['GPIOD->CRL = (GPIOD->CRL & 0xFF00FF00) | 0x00BB00BB;', 'PD0 D2、PD1 D3、PD4 NOE、PD5 NWE：复用推挽', '每个脚 4 位，B = 1011：复用推挽输出 50 MHz。只改这 4 个脚，PD2、PD3、PD6、PD7 板上接了别的东西，不能动。'],
            ['GPIOD->CRH = (GPIOD->CRH & 0x00FFF000) | 0xBB000BBB;', 'PD8~10 D13~15、PD14 D0、PD15 D1', '同上，只改 5 个脚。'],
            ['GPIOE->CRL = (GPIOE->CRL & 0x0FFFFFFF) | 0xB0000000;', 'PE7 D4', 'PE7 的 4 位在 CRL 最高 4 位（28~31），只改它，PE0~6 不动。'],
            ['GPIOE->CRH = 0xBBBBBBBB;', 'PE8~15 D5~12', 'PE8~15 全是数据线，整个寄存器一次写完。'],
            ['GPIOG->CRL = (GPIOG->CRL & 0xFFFFFFF0) | 0x0000000B;', 'PG0 A10（RS）', 'PG0 是 FSMC_A10，也就是 LCD 的 RS 线：地址决定这次写的是命令还是数据。'],
            ['GPIOG->CRH = (GPIOG->CRH & 0xFFF0FFFF) | 0x000B0000;', 'PG12 NE4（片选）', 'PG12 是 FSMC_NE4：CPU 访问 0x6C00 0000 ~ 0x6FFF FFFF 时 FSMC 自动拉低它。PG12 在 CRH 的 16~19 位。'],
            ['FSMC_Bank1->BTCR[7] = (5 << 8) | (1 << 0);', '时序：地址建立 1、数据保持 5（个 HCLK）', 'BTCR[7] 是 BTR4。模式 1 下写一次约 ADDSET + (DATAST + 1) = 7 个 HCLK ≈ 97 ns，比常见 LCD 控制器要求的写周期长，留了余量；屏显示不稳就把 DATAST 加大。'],
            ['FSMC_Bank1->BTCR[6] = (1 << 12) | (1 << 4) | (1 << 0);', 'BCR4：允许写、16 位宽、SRAM 类型、打开 Bank', 'bit12 WREN 允许写，bit5:4 MWID = 01 → 16 位，MTYP = 00 → SRAM（LCD 的 8080 接口和 SRAM 时序一样），最后 bit0 MBKEN 打开。直接赋值同时清掉复位值里的 MUXEN、WAITEN 等。'],
            ['GPIOB->CRL = (GPIOB->CRL & 0xFFFFFFF0) | 0x00000003;', 'PB0 推挽输出（背光）', '背光只是开 / 关，普通推挽输出（MODE = 11、CNF = 00）就行；要调亮度可以改成 TIM3_CH3 的 PWM。'],
            ['GPIOB->BSRR = GPIO_BSRR_BS0;', '打开背光', '原理图接口页没有标背光的有效电平，常见模块是高电平亮；不亮就改成 BR0 试试。']
          ] },
          { sig: 'void lcd_write(uint16_t cmd, uint16_t data)', lines: [
            ['LCD_CMD = cmd;', '先发命令（寄存器号）', '一条普通的赋值，FSMC 自动拉低 NE4 和 NWE、把 cmd 放到 D0~15、A10 = 0。'],
            ['LCD_DATA = data;', '再发数据', '同样的波形，只是 A10 = 1，LCD 就知道这是数据。']
          ] }
        ] }
    ]
  };

  W.STM32_REGCODE = { CM: CM, PROGS: PROGS };
})();
