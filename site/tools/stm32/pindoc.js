/* pindoc.js — 板载模块每个脚的详细说明：作用（这个脚是干什么的）、程序里（接 MCU 的脚怎么配、怎么用）。
   板上怎么接的在 modules.js 的 note 里，这里不重复。
   查找顺序：「模块.脚键」→「模块.脚名」→ 通用规则（电源 / 地 / 悬空 / FSMC 地址数据线）。 */
(function () {
  'use strict';
  var W = typeof window === 'object' ? window : this;
  var STM = W.STM = W.STM || {};

  function crx(mcu, mode) {   // 'PA9' → 'GPIOA_CRH 里 MODE9 / CNF9'
    var m = /^P([A-G])(\d+)$/.exec(mcu || ''); if (!m) return '';
    var y = +m[2];
    return 'GPIO' + m[1] + '_' + (y < 8 ? 'CRL' : 'CRH') + ' 里 MODE' + y + ' / CNF' + y + (mode ? ' 配成' + mode : '');
  }
  var OUT = function (mcu) { return '推挽输出：' + crx(mcu) + ' = 11 / 00（50 MHz）。先开 RCC_APB2ENR 里这个端口的时钟。'; };
  var AFPP = function (mcu) { return '复用推挽：' + crx(mcu) + ' = 11 / 10，由外设驱动这个脚。'; };
  var AFIN = function (mcu) { return '输入：' + crx(mcu) + ' = 00 / 01（浮空输入），外设直接读这个脚。'; };
  var ANA = function (mcu) { return '模拟输入：' + crx(mcu) + ' = 00 / 00，数字部分断开，只给 ADC 用。'; };

  var D = {
    /* ---------- 晶振 ---------- */
    'xtal.hi': { role: '外部高速时钟的输入端。8 MHz 晶振和芯片里的振荡电路一起产生稳定的时钟，经 PLL ×9 得到 72 MHz，作为整个芯片的系统时钟 SYSCLK。比内部 8 MHz RC 振荡器准得多，串口波特率、USB 都靠它。',
      how: '不用配 GPIO。RCC_CR 置 HSEON，等 HSERDY = 1；再在 RCC_CFGR 里选 PLL 源 = HSE、倍频 ×9，打开 PLL，最后把 SW 切到 PLL。Flash 要先设 2 个等待周期（FLASH_ACR 的 LATENCY = 2）。' },
    'xtal.ho': { role: '高速振荡电路的输出端，和 OSC_IN 一起接在晶振两端，驱动晶振起振。', how: '跟 OSC_IN 一起由 RCC 管，不用单独配置。' },
    'xtal.li': { role: '外部低速时钟的输入端，接 32.768 kHz 晶振，给 RTC（实时时钟）用：32768 = 2¹⁵，分频 32768 次正好 1 秒。主电源断电后靠 VBAT 继续走时。',
      how: '先开 PWR 和 BKP 的时钟，PWR_CR 置 DBP 解除备份域写保护；RCC_BDCR 置 LSEON，等 LSERDY = 1，再选 RTCSEL = LSE。开了 LSE 以后 PC14 不能再当普通 IO。' },
    'xtal.lo': { role: '低速振荡电路的输出端，和 PC14 一起接在 32.768 kHz 晶振两端。', how: '跟 PC14 一起由 RCC 管；开了 LSE 以后 PC15 不能再当普通 IO。' },

    /* ---------- BOOT ---------- */
    'boot.p1': { role: '3.3 V。跳线帽短接 1-2，把 BOOT0 拉到高电平。' },
    'boot.p2': { role: '启动方式选择。芯片只在上电或复位的那一刻读一次：BOOT0 = 0 → 从主 Flash 启动，跑你下载进去的程序；BOOT0 = 1 → 看 BOOT1：BOOT1 = 0 从系统存储器启动（ST 出厂固化的 bootloader，可以用串口下载程序），BOOT1 = 1 从内部 SRAM 启动。',
      how: '不用编程，靠跳线。复位之后再改跳线不影响正在跑的程序，要再复位一次才生效。' },
    'boot.p3': { role: '3.3 V。跳线帽短接 3-4，把 BOOT1 拉到高电平。' },
    'boot.p4': { role: 'BOOT1，和 BOOT0 一起选启动方式，只在 BOOT0 = 1 时才有意义。BOOT1 和 PB2 是同一个脚。', how: '只在复位瞬间采样；复位以后 PB2 就是普通 IO，可以照常使用。' },
    'boot.p5': { role: '地。跳线帽短接 5-6，把 BOOT1 拉到低电平。' },
    'boot.p6': { role: 'BOOT1（同 4 脚，都接 PB2）。跳线帽接到这边 = BOOT1 = 0。', how: '只在复位瞬间采样；复位以后 PB2 就是普通 IO。' },

    /* ---------- USB ---------- */
    'usb.vbus': { role: 'USB 口的 5 V 电源。插电脑或充电头时，整块板从这里取电。' },
    'usb.dm': { role: 'USB 差分数据线的负端。D+ 和 D− 两根一起传一个信号，看的是两根线的电压差，所以抗干扰。STM32F103 自带全速 USB 设备控制器（12 Mbit/s），可以做成虚拟串口、U 盘、键盘等。',
      how: '开 USB 外设以后这个脚由 USB 模块接管，不用配 GPIO 模式。USB 要 48 MHz 时钟：RCC_CFGR 的 USBPRE = 0（72 MHz ÷ 1.5）。注意 CAN 和 USB 共用一块 SRAM，不能同时用。' },
    'usb.dp': { role: 'USB 差分数据线的正端。D+ 上的上拉电阻告诉电脑：这里插了一个全速设备，电脑才会开始枚举。', how: '同 D−，由 USB 外设接管。' },
    'usb.cc': { role: 'Type-C 的配置脚。设备端把 CC 经电阻接地，告诉电脑或充电头「我是受电的设备」，对方才会把 5 V 送过来。少了这个电阻，有些 C 口充电头不给电。' },

    /* ---------- LED ---------- */
    'led.led1': { role: '黄灯。阳极经 2kΩ 接 3V3，阴极接 PA0。PA0 输出 0 → 两端有压差、有电流 → 亮；输出 1 → 两端都是 3.3 V → 灭。这种接法叫低电平点亮，灌电流比拉电流对 IO 更友好。',
      how: OUT('PA0') + ' 亮：GPIOA->BSRR = GPIO_BSRR_BR0；灭：GPIOA->BSRR = GPIO_BSRR_BS0；翻转：GPIOA->ODR ^= GPIO_ODR_ODR0。' },
    'led.led2': { role: '蓝灯，接法同 LED1：PA1 输出 0 亮、1 灭。', how: OUT('PA1') + ' 亮：GPIOA->BSRR = GPIO_BSRR_BR1。' },
    'led.led3': { role: '绿灯，接法同 LED1：PA8 输出 0 亮、1 灭。', how: OUT('PA8') + ' 亮：GPIOA->BSRR = GPIO_BSRR_BR8。' },
    'led.led5': { role: 'WS2812 全彩灯，灯里自带控制芯片。一根线串行送 24 位颜色（G、R、B 各 8 位），每一位用高电平持续的长短区分 0 和 1（一位约 1.25 µs）；几颗灯可以串起来，每颗取走前 24 位，剩下的往后传。',
      how: OUT('PG11') + ' 时序是微秒级的：最简单是关中断后用循环延时打出每一位；发完以后保持低电平 50 µs 以上，灯才会更新颜色。' },
    'led.pwr': { role: '电源指示灯，直接接在 3V3 上，上电就亮，程序管不了它。' },

    /* ---------- 按键 ---------- */
    'key.key1': { role: '按键 1。按下时 PF8 接到 GND，读到 0；松开时这个脚什么都没接（悬空），电平不确定，所以要用芯片内部的上拉电阻把它拉到 1。',
      how: '上拉输入：' + crx('PF8') + ' = 00 / 10，再把 ODR8 置 1 选上拉（GPIOF->ODR |= GPIO_ODR_ODR8）。读 GPIOF->IDR & GPIO_IDR_IDR8，等于 0 就是按下。按键有机械抖动，判断按下后延时 10~20 ms 再读一次。也可以接 EXTI8 用中断。' },
    'key.key2': { role: '按键 2，接法同按键 1：按下读到 0，要配上拉输入。',
      how: '上拉输入：' + crx('PF9') + ' = 00 / 10，ODR9 置 1。读 GPIOF->IDR & GPIO_IDR_IDR9，0 = 按下。' },
    'key.key3': { role: '按键 3。和前两个相反：按下时 PF10 接到 3V3，读到 1；松开时悬空，要用内部下拉把它拉到 0。',
      how: '下拉输入：' + crx('PF10') + ' = 00 / 10，ODR10 清 0 选下拉。读 GPIOF->IDR & GPIO_IDR_IDR10，等于 1 才是按下。' },
    'key.key4': { role: '按键 4，接法同按键 3：按下读到 1，要配下拉输入。',
      how: '下拉输入：' + crx('PF11') + ' = 00 / 10，ODR11 清 0。读到 1 = 按下。' },
    'key.rst': { role: '复位键。NRST 低电平有效：按下把它拉低，芯片里的寄存器全部回到复位值，程序从头开始跑。10kΩ 上拉让它平时保持高电平，100nF 电容让上电时自动复位一下。', how: '不用编程。' },

    /* ---------- 蜂鸣器 ---------- */
    'beep.g': { role: 'MOS 管 AO3400A 的栅极，也就是开关的控制端。栅极电压高于约 1 V，管子导通，蜂鸣器两端有电压就响。用 MOS 管是因为蜂鸣器要几十 mA，IO 口直接带不动。10kΩ 下拉保证上电、复位时 PB1 还没配置，蜂鸣器也不会乱响。',
      how: OUT('PB1') + ' 输出 1 响，输出 0 停。' },
    'beep.d': { role: 'MOS 管漏极，接蜂鸣器负极。管子导通时漏极被拉到地，电流从 5V 经蜂鸣器流进来。' },
    'beep.s': { role: 'MOS 管源极，接地，是电流的出口。' },
    'beep.bp': { role: '蜂鸣器正极，接 5V。并联的续流二极管 D4 用来吸收蜂鸣器线圈断电瞬间产生的反向高压，保护 MOS 管。' },
    'beep.bn': { role: '蜂鸣器负极，接 MOS 管漏极；管子导通时被拉到地，蜂鸣器两端才有电压。' },

    /* ---------- 4-20mA ---------- */
    'ma420.p1': { role: '4-20mA 是工业传感器常用的电流信号：电流在长导线上不会像电压那样衰减，而且用 4 mA 当零点，读到 0 mA 就知道线断了。电流流过 150Ω 采样电阻变成 0.6~3.0 V，送进 ADC3 通道 4；ZMM3V3 稳压管把电压限制在 3.3 V 以内，保护芯片。',
      how: ANA('PF6') + ' ADC3 规则通道选 4。电流 (mA) = ADC 值 × 3.3 ÷ 4095 ÷ 150 × 1000。' },
    'ma420.p2': { role: '给外接的两线制变送器供电：电流从 VIN 出去，流经变送器，再从 IN1 / IN2 回来，变送器靠控制这个电流的大小来表示测到的值。' },
    'ma420.p3': { role: '第二路 4-20mA 输入，原理同 IN1，接 ADC3 通道 5。', how: ANA('PF7') + ' ADC3 规则通道选 5。' },

    /* ---------- DS18B20 ---------- */
    'ds18b20.p2': { role: '单总线（1-Wire）数据脚：一根线既发命令又收数据，一条线上还能挂好几个 DS18B20（每个有唯一的 64 位 ID）。总线平时被 10kΩ 上拉成高电平，主机和传感器都只会把它拉低，不会往上推。',
      how: '开漏输出：' + crx('PC3') + ' = 11 / 01。写 1 等于松开，由上拉拉高；同时随时可以读 IDR，看对方有没有把线拉低。时序按微秒算：复位脉冲拉低 480 µs，读写一位各约 60 µs。' },

    /* ---------- M24C02 ---------- */
    'eeprom.E0': { role: '器件地址最低位。I2C 地址是 1010 E2 E1 E0 再加一位读写位，同一条总线上最多挂 8 片 24C02，靠这三个脚区分。三个都接地 → 写地址 0xA0、读地址 0xA1。' },
    'eeprom.E1': { role: '器件地址第 2 位，作用同 E0。' },
    'eeprom.E2': { role: '器件地址第 3 位，作用同 E0。三个都接地 → 写地址 0xA0、读地址 0xA1。' },
    'eeprom.SDA': { role: 'I2C 数据线，双向：MCU 发器件地址、存储地址和数据，EEPROM 回应答（ACK）和读出来的数据。两边都是开漏输出，空闲时靠 10kΩ 上拉保持高电平。',
      how: '软件模拟 I2C：开漏输出 ' + crx('PB11') + ' = 11 / 01，读 IDR 收数据。硬件 I2C2：复用开漏 = 11 / 11，由 I2C2 外设驱动。' },
    'eeprom.SCL': { role: 'I2C 时钟线，由主机（MCU）产生。规则：SCL 高电平期间 SDA 必须保持不变；SDA 只能在 SCL 低的时候变。SCL 高时 SDA 从高变低 = 起始信号，从低变高 = 停止信号。',
      how: '软件模拟：开漏输出 ' + crx('PB10') + ' = 11 / 01。硬件 I2C2：复用开漏 = 11 / 11；I2C2 在 APB1（36 MHz），CR2 的 FREQ 填 36，CCR 按 100 kHz 算 = 180。' },
    'eeprom.WC': { role: '写保护（Write Control）。高电平时芯片拒绝一切写入，读不受影响；这里接地 = 一直允许写。' },

    /* ---------- W25Q32 ---------- */
    'flash.CS': { role: '片选，低电平时芯片才理会 SPI 上的命令。每条命令都以 CS 拉低开始、拉高结束；比如写使能 0x06 发完必须先拉高一次，写使能才生效。',
      how: OUT('PC13') + ' 由软件控制：发命令前 GPIOC->BSRR = GPIO_BSRR_BR13，发完 GPIO_BSRR_BS13。PC13 驱动能力弱（最高 2 MHz），当片选够用。' },
    'flash.DO': { role: '数据输出：Flash → MCU，对应 MCU 的 MISO。读 ID、读数据、读状态寄存器时，Flash 从这根线把数据送回来。', how: 'SPI1_MISO：' + AFIN('PA6') },
    'flash.WP': { role: '写保护：低电平时状态寄存器不能被改写；这里接 3V3 = 不保护。' },
    'flash.DI': { role: '数据输入：MCU → Flash，对应 MCU 的 MOSI。命令、地址、要写的数据都从这根线发过去。', how: 'SPI1_MOSI：' + AFPP('PA7') },
    'flash.CLK': { role: 'SPI 时钟，由主机（MCU）产生，每个时钟传 1 位；W25Q32 支持模式 0 和模式 3。', how: 'SPI1_SCK：' + AFPP('PA5') + ' SPI1 在 APB2（72 MHz），最快 36 MHz，W25Q32 跟得上。' },
    'flash.HOLD': { role: '暂停：拉低时芯片暂停当前传输，总线可以先让给别的设备用；这里接 3V3 = 不暂停。' },

    /* ---------- 电位器 ---------- */
    'pot.p1': { role: '电位器一端接 3V3。' },
    'pot.p2': { role: '滑动端。转动旋钮，这一点在 0 V 到 3.3 V 之间连续变化，相当于一个可调分压器。拿来练 ADC 最直观。',
      how: ANA('PC0') + ' ADC1 通道 10。电压 = ADC 值 × 3.3 ÷ 4095。' },
    'pot.p3': { role: '电位器另一端接地。' },

    /* ---------- ST-Link ---------- */
    'stlink.p2': { role: '复位线。下载器可以通过它复位芯片：比如程序把 SWD 脚改成了普通 IO，下载器连不上时，要先拉住复位再连接。', how: '不用编程；下载软件里把连接方式选成「Connect under reset」就会用到它。' },
    'stlink.p3': { role: 'SWD 调试接口的数据线，下载程序、单步调试都走这根。复位后 PA13 默认就是 SWDIO。',
      how: '别把 PA13 配成普通 IO，也别用 AFIO_MAPR 的 SWJ_CFG 关掉 SWD，否则下载器连不上，只能按住复位键再下载。' },
    'stlink.p4': { role: 'USART1 接收（RX）：电脑上串口助手发的数据，经 ST-Link 的虚拟串口从这里进来。',
      how: 'USART1_RX：' + AFIN('PA10') + ' USART1 在 APB2（72 MHz），115200 波特率 BRR = 72000000 ÷ 115200 ≈ 0x271。' },
    'stlink.p5': { role: 'SWD 调试接口的时钟线，由下载器产生。复位后 PA14 默认就是 SWCLK。', how: '同 SWDIO：别把 PA14 配成普通 IO。' },
    'stlink.p6': { role: 'USART1 发送（TX）：printf 打印的内容从这里发出，经 ST-Link 的虚拟串口显示在电脑上。', how: 'USART1_TX：' + AFPP('PA9') + ' 发一个字节：等 USART1->SR 的 TXE = 1，再写 DR。' },
    'stlink.p8': { role: '下载器提供的 5 V，只插 ST-Link 也能给板子供电。' },

    /* ---------- SD 卡 ---------- */
    'sd.p1': { role: 'SDIO 数据线 2。4 位模式下 DAT0~DAT3 一次传 4 位；卡刚上电是 1 位模式，只用 DAT0，切到 4 位模式后才用它。', how: 'SDIO_D2：' + AFPP('PC10') },
    'sd.p2': { role: 'SDIO 数据线 3。4 位模式下的最高位；SD 卡在 SPI 模式下这根线是片选。', how: 'SDIO_D3：' + AFPP('PC11') },
    'sd.p3': { role: '命令线：主机发命令（如 CMD0 复位、CMD17 读一块、CMD24 写一块），卡在同一根线上回响应。', how: 'SDIO_CMD：' + AFPP('PD2') },
    'sd.p5': { role: 'SDIO 时钟，由主机产生：初始化阶段不能超过 400 kHz，识别完卡以后再调高（常用 24 MHz）。', how: 'SDIO_CK：' + AFPP('PC12') + ' 分频在 SDIO_CLKCR 的 CLKDIV。' },
    'sd.p7': { role: 'SDIO 数据线 0。1 位模式只用它；写完一块数据后卡还会把 DAT0 拉低表示「正在写，忙」，直到写完才放开。', how: 'SDIO_D0：' + AFPP('PC8') },
    'sd.p8': { role: 'SDIO 数据线 1，4 位模式下使用。', how: 'SDIO_D1：' + AFPP('PC9') },
    'sd.cd': { role: '卡座里的机械开关：插卡和没插卡时 PG8 的电平不同，程序据此判断有没有卡，没卡就不去初始化。', how: '上拉输入：' + crx('PG8') + ' = 00 / 10，ODR8 置 1。' },

    /* ---------- SRAM ---------- */
    'sram.CS': { role: '片选（低有效）。FSMC 访问 0x6800 0000 ~ 0x6BFF FFFF 这段地址时，自动把 NE3 拉低选中这片 SRAM；访问别的区时它保持高。',
      how: AFPP('PG10') + ' FSMC_BCR3 配成 SRAM、16 位，BTR3 配读写时序；之后像普通内存一样用：*(volatile uint16_t *)0x68000000 = 0x1234。' },
    'sram.WE': { role: '写使能（低有效）：为低时 SRAM 把数据线上的数据写进地址线选中的单元。FSMC 做写操作时自动产生这个脉冲。', how: 'FSMC_NWE：' + AFPP('PD5') },
    'sram.OE': { role: '读使能（低有效）：为低时 SRAM 把选中单元的数据放到数据线上。FSMC 做读操作时自动拉低。', how: 'FSMC_NOE：' + AFPP('PD4') },
    'sram.LB': { role: '低字节使能（低有效）：为低时 IO0~IO7 这 8 位有效。按字节写（uint8_t）时，FSMC 只拉低 LB 或 UB 其中一个，另一半字节不会被改掉。', how: 'FSMC_NBL0：' + AFPP('PE0') },
    'sram.UB': { role: '高字节使能（低有效）：为低时 IO8~IO15 这 8 位有效。', how: 'FSMC_NBL1：' + AFPP('PE1') },

    /* ---------- NAND ---------- */
    'nand.R/B': { role: '忙 / 就绪：NAND 在擦除、编程（写）、读一页到内部缓存时输出低电平（忙），完成后变高。主机发完命令要等它变高才能继续。',
      how: '可以由 FSMC 的 NWAIT 自动等待，也可以把 PD6 当普通上拉输入，在程序里等它变成 1。' },
    'nand.RE': { role: '读使能（低有效）：每来一个下降沿，NAND 就把下一个字节送到 IO 线上。', how: 'FSMC_NOE：' + AFPP('PD4') },
    'nand.CE': { role: '片选（低有效）：FSMC 访问 Bank2（0x7000 0000 起）时自动拉低。', how: 'FSMC_NCE2：' + AFPP('PD7') + ' FSMC_PCR2 配成 NAND、8 位。' },
    'nand.CLE': { role: '命令锁存使能：CLE = 1 时，IO 上的这个字节被当作命令，比如 0x00 / 0x30 读一页、0x80 / 0x10 写一页、0x60 / 0xD0 擦一块。',
      how: '接 FSMC_A16，往 0x7001 0000 写一个字节，A16 = 1，就是在写命令。' + AFPP('PD11') },
    'nand.ALE': { role: '地址锁存使能：ALE = 1 时，IO 上的这个字节被当作地址；一个完整地址（列地址 + 行地址）要分 4~5 次送。',
      how: '接 FSMC_A17，往 0x7002 0000 写，A17 = 1，就是在写地址。' + AFPP('PD12') },
    'nand.WE': { role: '写使能（低有效）：上升沿时 NAND 锁存 IO 上的命令、地址或数据。', how: 'FSMC_NWE：' + AFPP('PD5') },
    'nand.WP': { role: '写保护：低电平时禁止编程和擦除；这里上拉 = 允许写。' },

    /* ---------- LCD ---------- */
    'lcd.T_SDA': { role: '电容触摸芯片的 I2C 数据线：读触摸点坐标从这里出来。', how: '软件模拟：开漏输出 ' + crx('PB7') + ' = 11 / 01；硬件 I2C1：复用开漏 = 11 / 11。' },
    'lcd.T_SCL': { role: '电容触摸芯片的 I2C 时钟线。', how: '软件模拟：开漏输出 ' + crx('PB6') + ' = 11 / 01；硬件 I2C1：复用开漏 = 11 / 11。' },
    'lcd.T_INT': { role: '触摸中断：有手指按下时，触摸芯片拉低这根线通知 MCU，不用一直轮询。', how: '上拉输入 ' + crx('PC1') + ' = 00 / 10，可以接 EXTI1 下降沿中断。' },
    'lcd.BL': { role: '背光控制。液晶本身不发光，靠背后的 LED 背光照亮；不开背光屏幕上什么都看不见。', how: OUT('PB0') + ' PB0 也是 TIM3_CH3，可以用 PWM 调亮度。' },
    'lcd.RST': { role: '屏的复位（低有效）。初始化屏之前先拉低一段时间再拉高，等屏内部准备好，再发初始化命令。', how: OUT('PG15') },
    'lcd.CS': { role: '片选（低有效）：FSMC 访问 Bank1 第 4 区（0x6C00 0000 起）时自动拉低选中屏。', how: 'FSMC_NE4：' + AFPP('PG12') + ' FSMC_BCR4 配成 SRAM 模式、16 位。' },
    'lcd.RS': { role: '命令 / 数据选择：RS = 0 时写进去的是命令（寄存器号），RS = 1 时写的是数据（参数或像素颜色）。它接在地址线 A10 上，所以「写命令」和「写数据」只是写两个不同的地址。',
      how: '16 位模式下 A10 对应字节地址的第 11 位（1 << 11 = 0x800）：写命令 *(volatile uint16_t *)0x6C000000，写数据 *(volatile uint16_t *)0x6C000800。' + AFPP('PG0') },
    'lcd.WR': { role: '写使能（低有效）：上升沿时屏锁存数据线上的值。FSMC 写操作时自动产生。', how: 'FSMC_NWE：' + AFPP('PD5') },
    'lcd.RD': { role: '读使能（低有效）：读屏的 ID 或显存时使用。', how: 'FSMC_NOE：' + AFPP('PD4') },

    /* ---------- RS232 ---------- */
    'rs232.p1': { role: '电荷泵电容 C1 的正端。SP3232 只用 3.3~5 V 供电，靠两颗电容反复充放电，「泵」出 ±5.5 V，满足 RS232 的电平要求（逻辑 1 = −3 ~ −15 V，逻辑 0 = +3 ~ +15 V）。' },
    'rs232.p2': { role: '电荷泵产生的正电压（约 +5.5 V），接 100nF 储能电容，芯片内部给发送器用。' },
    'rs232.p3': { role: '电荷泵电容 C1 的负端。' },
    'rs232.p4': { role: '电荷泵电容 C2 的正端，C2 用来产生负电压。' },
    'rs232.p5': { role: '电荷泵电容 C2 的负端。' },
    'rs232.p6': { role: '电荷泵产生的负电压（约 −5.5 V），接 100nF 储能电容。' },
    'rs232.p11': { role: '发送器输入：接 MCU 的 TX（0 / 3.3 V 的 TTL 电平）。芯片把它转成 RS232 电平从 T1OUT 发出去，同时电平反相：TTL 的 1 变成负电压。',
      how: 'USART1_TX：' + AFPP('PA9') + ' 跳线 H11 切到 RS232 后，程序和用 ST-Link 串口完全一样。' },
    'rs232.p12': { role: '接收器输出：把 R1IN 收到的 RS232 电平转回 TTL 电平，送给 MCU 的 RX。', how: 'USART1_RX：' + AFIN('PA10') },
    'rs232.p13': { role: '接收器输入，接 DB9 接口，收对方发来的 RS232 电平。' },
    'rs232.p14': { role: '发送器输出，接 DB9 接口，发出 RS232 电平。' },

    /* ---------- RS485 ---------- */
    'rs485.RO': { role: '接收器输出：把 A、B 两根线上的电压差还原成 0 / 1，送给 MCU 的 RX。', how: 'USART1_RX：' + AFIN('PA10') },
    'rs485.RE': { role: '接收使能（低有效）。和 DE 接在一起用一个脚控制：485 是半双工，同一时刻只能一边发；PE3 = 0 时在收，= 1 时在发。', how: OUT('PE3') + ' 平时保持 0（接收）。' },
    'rs485.DE': { role: '发送使能（高有效），和 RE 接在一起。为 1 时芯片把 DI 上的数据变成差分信号推到 A、B 上。',
      how: OUT('PE3') + ' 发之前置 1；等最后一个字节真正发完（USART1->SR 的 TC = 1，不是 TXE）再置 0 回到接收，否则最后一个字节会被截断。' },
    'rs485.DI': { role: '驱动器输入：要发的数据，接 MCU 的 TX。', how: 'USART1_TX：' + AFPP('PA9') },
    'rs485.A': { role: '差分总线 A：A − B > +200 mV 读作 1，< −200 mV 读作 0。A、B 两根线绞在一起传，干扰同时加在两根上、差值不变，所以抗干扰、能传 1 km 左右。' },
    'rs485.B': { role: '差分总线 B。总线最远的两端各接一个 120Ω 终端电阻，防止信号在线的末端反射。' },

    /* ---------- CAN ---------- */
    'can.TXD': { role: 'CAN 控制器的发送输出，送进收发器 PD1050，变成 CANH / CANL 上的差分信号。',
      how: 'CAN_TX：' + AFPP('PB9') + ' CAN 默认在 PA11 / PA12（被 USB 占了），要在 AFIO_MAPR 里把 CAN_REMAP 设成 10，才映射到 PB8 / PB9；先开 AFIO 时钟。' },
    'can.RXD': { role: '收发器把总线上的差分信号转成 0 / 1，送给 CAN 控制器。', how: 'CAN_RX：' + crx('PB8') + ' = 00 / 10，ODR8 置 1（上拉输入）；同样要设 CAN_REMAP = 10。' },
    'can.VREF': { role: '参考电压输出（约 VCC 的一半），这块板没用，悬空。' },
    'can.CANH': { role: 'CAN 总线高线。显性位（逻辑 0）时 CANH ≈ 3.5 V、CANL ≈ 1.5 V；隐性位（逻辑 1）时两根都约 2.5 V。多个节点同时发时显性压过隐性，CAN 靠这一点做仲裁。' },
    'can.CANL': { role: 'CAN 总线低线，和 CANH 成对。总线两端各接一个 120Ω 终端电阻。' },
    'can.S': { role: '模式选择：高电平 = 静默模式（只收不发），低或悬空 = 正常收发。' },

    /* ---------- W5500 ---------- */
    'w5500.p1': { role: '以太网发送差分对的负端，经网络变压器隔离后到 RJ45 网口。W5500 内部集成了 MAC、PHY 和 TCP/IP 协议栈，MCU 只要通过 SPI 读写它的寄存器就能上网。' },
    'w5500.p2': { role: '以太网发送差分对的正端。' },
    'w5500.p5': { role: '以太网接收差分对的负端。' },
    'w5500.p6': { role: '以太网接收差分对的正端。' },
    'w5500.p30': { role: '25 MHz 晶振输入，给 W5500 内部的 PHY 提供时钟。' },
    'w5500.p31': { role: '25 MHz 晶振输出。' },
    'w5500.p32': { role: 'SPI 片选（低有效）。每次读写 W5500 的寄存器或缓冲区，都要先拉低、结束后拉高。', how: OUT('PD3') + ' 由软件控制。' },
    'w5500.p33': { role: 'SPI 时钟。', how: 'SPI2_SCK：' + AFPP('PB13') + ' SPI2 在 APB1（36 MHz），最快 18 MHz。' },
    'w5500.p34': { role: 'SPI 数据：W5500 → MCU。', how: 'SPI2_MISO：' + AFIN('PB14') },
    'w5500.p35': { role: 'SPI 数据：MCU → W5500。每次传输先发 16 位地址 + 8 位控制字（选哪块寄存器、读还是写），再跟数据。', how: 'SPI2_MOSI：' + AFPP('PB15') },
    'w5500.p36': { role: '中断输出（低有效）：收到数据、连接建立或断开等事件发生时拉低，通知 MCU 来读。', how: '上拉输入 ' + crx('PG6') + ' = 00 / 10，可以接 EXTI6 下降沿中断。' },
    'w5500.p37': { role: '硬件复位（低有效）：拉低至少 500 µs 再拉高，W5500 回到初始状态。', how: OUT('PG7') },

    /* ---------- ESP32-C3 ---------- */
    'esp32.p1': { role: '射频端，经匹配电路接板载天线，WiFi 和蓝牙信号都从这里收发。' },
    'esp32.p7': { role: '使能：高电平工作，拉低就关机；拉低再放开等于复位 ESP32。', how: OUT('PE4') + ' 平时输出 1；要复位 ESP32 时拉低几十毫秒再拉高。' },
    'esp32.p12': { role: 'ESP32 的 UART1 RX，接 STM32 的 USART2 TX。STM32 从这里给 ESP32 发 AT 指令（如 AT+CWJAP 连 WiFi）。', how: 'USART2_TX：' + AFPP('PA2') + ' USART2 在 APB1（36 MHz），波特率按 36 MHz 算：115200 → BRR ≈ 0x138。' },
    'esp32.p13': { role: 'ESP32 的 UART1 TX，接 STM32 的 USART2 RX：ESP32 的回复（OK、收到的网络数据）从这里回来。', how: 'USART2_RX：' + AFIN('PA3') },
    'esp32.p15': { role: '启动模式脚：上电时为低 → 进入下载模式；为高（默认）→ 正常运行。平时还接着 LED12。' },
    'esp32.p25': { role: 'ESP32-C3 自带的 USB 的 D−，接第二个 Type-C 口 USB2，用来给 ESP32 自己下载程序、看日志。' },
    'esp32.p26': { role: 'ESP32-C3 自带的 USB 的 D+。' },
    'esp32.p29': { role: '40 MHz 晶振的一端，ESP32 的主时钟。' },
    'esp32.p30': { role: '40 MHz 晶振的另一端。' },

    /* ---------- LoRa ---------- */
    'lora.p6': { role: '射频开关控制：接收时置 1。模块的天线收发共用，要用这个开关切换方向；RXEN 和 TXEN 不能同时为 1。', how: OUT('PE5') },
    'lora.p7': { role: '射频开关控制：发送时置 1，同时 RXEN 置 0。', how: OUT('PE6') },
    'lora.p14': { role: '忙标志：模块内部芯片（SX1268）正在处理时为 1。每次发 SPI 命令前都要等 BUSY 变成 0。', how: '输入：' + crx('PE2') + ' = 00 / 01，读 GPIOE->IDR & GPIO_IDR_IDR2。' },
    'lora.p15': { role: '复位（低有效）：拉低一下再放开，模块回到初始状态。', how: OUT('PG13') },
    'lora.p16': { role: 'SPI 数据：模块 → MCU，和 W25Q32 共用 SPI1。', how: 'SPI1_MISO：' + AFIN('PA6') + ' 两个设备共用 SPI1，同一时间只能拉低一个片选。' },
    'lora.p17': { role: 'SPI 数据：MCU → 模块，和 W25Q32 共用 SPI1。', how: 'SPI1_MOSI：' + AFPP('PA7') },
    'lora.p18': { role: 'SPI 时钟，和 W25Q32 共用 SPI1。', how: 'SPI1_SCK：' + AFPP('PA5') },
    'lora.p19': { role: 'SPI 片选（低有效）：拉低时模块才理会 SPI 上的命令。', how: OUT('PG14') + ' 由软件控制。' },
    'lora.p21': { role: '天线接口，接 433 MHz 频段的天线。' }
  };

  var FSMC_W = { sram: 16, nand: 8, lcd: 16 };
  function generic(m, p) {
    var name = String(p.name), net = p.net || '';
    if (net === 'GND' || /^(GND|VSS)$/.test(name)) return { role: '地，所有信号电平的参考 0 V。' };
    if (net === 'NC' || name === 'NC') return { role: '不接（No Connect），悬空。' };
    if (/^(VCC|VDD|3V3|5V)$/.test(name) || net === '3V3' || net === '5V') {
      var v = net === '5V' || name === '5V' ? '5 V' : '3.3 V';
      return { role: '电源 ' + v + '。旁边一般有 100nF 去耦电容，就近给芯片补电流，滤掉它工作时产生的毛刺。' };
    }
    var sig = p.sig || '';
    if (!sig && m.id === 'lcd' && /^D\d+$/.test(name)) sig = 'FSMC_' + name;
    var d = /^FSMC_D(\d+)$/.exec(sig), a = /^FSMC_A(\d+)$/.exec(sig), w = FSMC_W[m.id] || 16;
    if (d) return {
      role: '数据线第 ' + d[1] + ' 位。读写时 MCU 和芯片通过这 ' + w + ' 根数据线一次并行传一个' + (w === 16 ? '半字（16 位）' : '字节') + '。' + (m.id === 'lcd' ? '屏的一个像素用 RGB565 正好 16 位，一次写一个像素。' : m.id === 'nand' ? '命令、地址、数据都分时走这 8 根线，靠 CLE / ALE 区分。' : ''),
      how: sig + '：' + AFPP(p.mcu) + ' 程序里不直接操作这根脚：读写对应的地址，FSMC 硬件自动驱动它。'
    };
    if (a) return {
      role: '地址线第 ' + a[1] + ' 位。19 根地址线 A0~A18 一起选中 512K 个 16 位存储单元里的一个。',
      how: sig + '：' + AFPP(p.mcu) + ' 16 位模式下 FSMC 把字节地址右移一位送到地址线，所以程序里地址 +2 才是这里的地址 +1。'
    };
    return { role: p.note || '' };
  }
  function doc(m, p) {
    var x = D[m.id + '.' + p.k] || D[m.id + '.' + p.name];
    var g = generic(m, p);
    function tidy(t) { return String(t || '').replace(/([。：，；）]) +/g, '$1'); }
    return { role: tidy((x && x.role) || g.role), how: tidy((x && x.how) || (x ? '' : g.how || '')) };
  }
  STM.pindoc = doc;
  W.STM32_PINDOC = { doc: doc, table: D };
})();
