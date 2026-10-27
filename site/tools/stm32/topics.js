/* topics.js — 外设主题（学习路径顺序 = 课件顺序）
   每个主题从现有数据里汇总：寄存器组（groups，可用 only / except 筛寄存器）、课件章节（chapters：一级章节 id，二级自动带上）、
   引脚（sig：按复用功能名匹配；board：按开发板资源分组取脚）、要点（points：F103 的通用事实，不依赖课件）。
   hue 是主题色，light / dark 两套，界面用它给芯片引脚、标题色块、列表标记上色。 */
window.STM32_TOPICS = [
  {
    id: 'sys', code: 'RCC', name: '系统与时钟', hue: ['#5d6b7e', '#9aa9bd'], icon: 'clock',
    summary: '时钟树、启动方式、存储器映射：所有外设工作的前提。',
    groups: [{ id: 'rcc' }, { id: 'flash' }],
    chapters: ['v20-ch01', 'v20-ch02', 'v20-ch05', 'v20-ch06', 'v21-ch05'],
    figs: ['sys-arch', 'memmap-1', 'memmap-2', 'boot-modes', 'power', 'reset', 'clock-tree', 'hse-lse', 'swj'],
    teach: ['teach-sys-01', 'teach-sys-02', 'teach-sys-03', 'teach-sys-04', 'teach-sys-05', 'teach-sys-06', 'teach-sys-07', 'teach-sys-08', 'teach-sys-09'],
    sig: /^(OSC|BOOT|SW|JT|NJTRST|TRACE|MCO|WKUP|TAMPER|NRST)/, types: ['S'],
    points: [
      '开发板用 8 MHz 外部晶振（HSE），经 PLL ×9 得到 72 MHz 系统时钟；AHB、APB2 可跑 72 MHz，APB1 最高 36 MHz。',
      '任何外设用之前，先在 RCC 的 AHBENR / APB2ENR / APB1ENR 里打开它的时钟，否则写它的寄存器不起作用。',
      '系统时钟 72 MHz 时，Flash 读取要插 2 个等待周期（FLASH_ACR 的 LATENCY = 2），HAL 的 SystemClock_Config 会配好。',
      'BOOT0 接地时从主 Flash 启动；下载调试走 SWD（PA13 SWDIO、PA14 SWCLK），不要把这两个脚另作他用。'
    ]
  },
  {
    id: 'gpio', code: 'GPIO', name: 'GPIO 通用输入输出', hue: ['#2f8a57', '#5ec48a'], icon: 'gpio',
    summary: '点灯、读按键、驱动蜂鸣器：每个引脚的 8 种工作模式。',
    groups: [{ id: 'gpio' }, { id: 'afio', except: /^AFIO_EXTICR/ }],
    chapters: ['v20-ch03', 'v20-ch04'],
    figs: ['gpio-bit', 'gpio-in', 'gpio-out', 'gpio-af', 'gpio-analog', 'gpio-5v'],
    teach: ['teach-gpio-10', 'teach-gpio-11', 'teach-gpio-12', 'teach-gpio-13'],
    board: ['LED', 'KEY', 'BEEP'],
    points: [
      '每个引脚用 4 位配置：CNF[1:0] + MODE[1:0]。0~7 号脚在 CRL，8~15 号脚在 CRH。',
      'MODE = 00 是输入，其余三种是输出并决定最大翻转速度（10 / 2 / 50 MHz）；CNF 再细分推挽、开漏、复用、上下拉。',
      '置位 / 清零用 BSRR：低 16 位写 1 置高，高 16 位写 1 拉低，一次写入就完成，不需要读-改-写。',
      'GPIO 挂在 APB2 上，先打开 RCC_APB2ENR 里对应端口的 IOPxEN；用复用功能或重映射时还要打开 AFIO 时钟。'
    ]
  },
  {
    id: 'exti', code: 'EXTI', name: '外部中断与 NVIC', hue: ['#b77d12', '#e3ae4a'], icon: 'bolt',
    summary: '按键触发中断：EXTI 选线、NVIC 排优先级、回调里处理。',
    groups: [{ id: 'exti' }, { id: 'nvic' }, { id: 'afio', only: /^AFIO_EXTICR/ }],
    chapters: ['v20-ch07'],
    figs: ['exti-block', 'exti-gpio'],
    teach: ['teach-nvic-exti-arch', 'teach-irq-14', 'teach-irq-16'],
    board: ['KEY'],
    points: [
      'EXTI0~15 对应引脚号 0~15：同一个编号只能选一个端口，比如 PA8 和 PF8 不能同时作中断（由 AFIO_EXTICRx 选择）。',
      'EXTI0~4 各有独立的中断入口；5~9 共用 EXTI9_5_IRQn，10~15 共用 EXTI15_10_IRQn，进中断后要看是哪条线。',
      '挂起位 EXTI_PR 写 1 清除；HAL 的 HAL_GPIO_EXTI_IRQHandler 已经替你清了，再调用你的回调。',
      'NVIC 优先级数值越小越优先；F103 实现了 4 位，按 SCB_AIRCR 的分组拆成抢占优先级和子优先级。'
    ]
  },
  {
    id: 'usart', code: 'USART', name: 'USART 串口', hue: ['#2a6fb8', '#6aa8ec'], icon: 'serial',
    summary: '和电脑收发数据、printf 打印调试信息。',
    groups: [{ id: 'usart' }],
    chapters: ['v20-ch08'],
    figs: ['usart'],
    teach: ['teach-comm-52'],
    sig: /^U(S)?ART\d/,
    points: [
      'USART1 挂在 APB2（72 MHz），USART2 / 3 和 UART4 / 5 挂在 APB1（36 MHz）；算波特率要用对应的总线时钟。',
      '波特率 = fPCLK ÷ (16 × USARTDIV)。72 MHz、115200 时 USARTDIV = 39.0625，BRR 写 0x271。',
      'TX 配成复用推挽输出，RX 配成浮空或上拉输入；USART1 默认是 PA9 / PA10，板上接到 STLink 的虚拟串口。',
      '读 DR 会自动清掉 RXNE；TC = 1 表示最后一帧已经完全发出去，关串口或切换方向前要等它。'
    ]
  },
  {
    id: 'i2c', code: 'I2C', name: 'I2C 总线', hue: ['#7651b8', '#ab8ef0'], icon: 'bus',
    summary: '两根线挂多个器件：读写板载 EEPROM。',
    groups: [{ id: 'i2c' }],
    chapters: ['v20-ch09'],
    figs: ['i2c-protocol', 'i2c'],
    teach: ['teach-i2c-49', 'teach-i2c-50', 'teach-i2c-51'],
    sig: /^I2C\d/,
    points: [
      'SCL、SDA 都配成复用开漏输出，总线靠外部上拉电阻拉高；板载 EEPROM 接在 I2C2（PB10 / PB11）。',
      '标准模式 100 kHz：CCR = PCLK1 ÷ (2 × fSCL)，PCLK1 = 36 MHz 时 CCR = 180；TRISE = PCLK1 的 MHz 数 + 1 = 37。',
      '7 位器件地址左移一位放在地址字节里，最低位是读写方向；HAL 的 DevAddress 要用这种 8 位写法（例如 0xA0）。',
      'EEPROM 按页写入不能跨页；每次写完器件要几毫秒完成内部写周期，期间不应答。'
    ]
  },
  {
    id: 'tim', code: 'TIM', name: '定时器', hue: ['#c25d22', '#ee9056'], icon: 'timer',
    summary: '定时中断、PWM 呼吸灯、SysTick 延时。',
    groups: [{ id: 'systick' }, { id: 'tim' }],
    chapters: ['v21-ch01'],
    figs: ['tim-basic', 'tim-gp', 'tim-adv', 'tim-oc-toggle', 'tim-pwm-edge', 'tim-pwm-center', 'tim-deadtime', 'tim-encoder'],
    teach: ['teach-tim-17', 'teach-tim-18', 'teach-tim-19', 'teach-tim-20', 'teach-tim-21', 'teach-tim-22', 'teach-tim-23', 'teach-tim-24', 'teach-tim-25', 'teach-tim-26', 'teach-tim-27', 'teach-tim-28', 'teach-tim-29', 'teach-tim-30', 'teach-tim-31', 'teach-tim-32', 'teach-tim-33', 'teach-tim-34', 'teach-tim-35'],
    sig: /^TIM\d/,
    points: [
      '更新频率 = 定时器时钟 ÷ ((PSC + 1) × (ARR + 1))。APB1 分频不为 1 时，TIM2~7 的时钟是 PCLK1 的 2 倍，也是 72 MHz。',
      'PWM 模式 1、向上计数时，占空比 = CCR ÷ (ARR + 1)。',
      'TIM1 / TIM8 是高级定时器，输出 PWM 还要把 BDTR 的 MOE 置 1，否则引脚没有波形。',
      'SysTick 是内核里的 24 位递减计数器，HAL 用它产生 1 ms 时基，HAL_Delay 和 HAL_GetTick 都靠它。'
    ]
  },
  {
    id: 'dma', code: 'DMA', name: 'DMA 直接存储器访问', hue: ['#13868a', '#4fc6c8'], icon: 'dma',
    summary: '不占 CPU 搬数据：串口收发、ADC 连续采样。',
    groups: [{ id: 'dma' }],
    chapters: ['v21-ch02'],
    figs: ['dma', 'dma1-req', 'dma2-req'],
    teach: [],
    points: [
      'DMA1 有 7 个通道，DMA2 有 5 个；每个外设请求固定接在某个通道上，例如 ADC1 → DMA1 通道 1，USART1_TX → 通道 4，USART1_RX → 通道 5。',
      '配置顺序：CPAR 写外设地址，CMAR 写内存地址，CNDTR 写搬运次数，CCR 设方向、地址增量、数据宽度，最后置 EN 启动。',
      '循环模式（CIRC）搬完自动从头开始，适合 ADC 连续采样到一个数组。',
      'DMA 挂在 AHB 上，先打开 RCC_AHBENR 的 DMA1EN / DMA2EN。'
    ]
  },
  {
    id: 'adc', code: 'ADC', name: 'ADC 模数转换', hue: ['#b33c6c', '#e77aa4'], icon: 'wave',
    summary: '把电压变成数字：读电位器。',
    groups: [{ id: 'adc' }],
    chapters: ['v21-ch03'],
    figs: ['adc', 'adc-temp'],
    teach: ['teach-adc-36', 'teach-adc-37', 'teach-adc-38', 'teach-adc-39', 'teach-adc-40', 'teach-adc-41'],
    sig: /^ADC/,
    points: [
      '12 位精度，结果 0~4095 对应 0~VREF+（板上 3.3 V）：电压 = 读数 × 3.3 ÷ 4095。',
      'ADC 时钟不能超过 14 MHz：72 MHz 系统时钟下选 6 分频，得到 12 MHz。',
      '一次转换时间 = 采样时间 + 12.5 个周期；选 239.5 周期采样，在 12 MHz 下约 21 μs，读数更稳。',
      '上电后先校准一次（HAL_ADCEx_Calibration_Start），再开始转换。'
    ]
  },
  {
    id: 'spi', code: 'SPI', name: 'SPI 总线', hue: ['#3f50c2', '#8592ef'], icon: 'spi',
    summary: '四线高速通信：读写板载 SPI Flash。',
    groups: [{ id: 'spi' }],
    chapters: ['v21-ch04'],
    figs: ['spi', 'spi-timing'],
    teach: ['teach-spi-42', 'teach-spi-43', 'teach-spi-44', 'teach-spi-45', 'teach-spi-46', 'teach-spi-47', 'teach-spi-48'],
    sig: /^(SPI|I2S)\d/,
    points: [
      '主机模式通常用软件管理 NSS（SSM = 1、SSI = 1），片选用一个普通 GPIO 自己拉低拉高。',
      'SCK = PCLK ÷ 分频（2~256）；SPI1 挂在 APB2，SPI2 / 3 挂在 APB1。',
      '发送和接收同时进行：发 1 个字节的同时收 1 个字节；只想读数据时发一个无意义的字节（常用 0xFF）。',
      'CPOL / CPHA 要和从机一致；板载 W25Q 系列 Flash 支持模式 0 和模式 3。'
    ]
  },
  {
    id: 'fsmc', code: 'FSMC', name: 'FSMC 与 LCD', hue: ['#7a7a24', '#bdbd5a'], icon: 'lcd',
    summary: '把外部存储器和 LCD 当内存访问。',
    groups: [{ id: 'fsmc' }],
    chapters: ['v21-ch06', 'v21-ch07'],
    figs: ['fsmc', 'fsmc-banks'],
    teach: [],
    sig: /^FSMC_/,
    points: [
      'FSMC 把外部 SRAM、NOR、LCD 映射进地址空间：Bank1 从 0x6000 0000 开始，分 4 个 64 MB 子区，对应片选 NE1~NE4。',
      '8080 接口的 LCD 按 SRAM 方式访问：拿一根地址线当 RS，地址里这一位决定写的是命令还是数据。',
      'BTR 里设置地址建立时间和数据保持时间，时序太快 LCD 会花屏，太慢刷新变慢。'
    ]
  }
];
