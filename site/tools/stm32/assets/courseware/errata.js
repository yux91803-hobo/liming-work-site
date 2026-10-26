/* 课件代码勘误（只读数据）。部署：tools/stm32/assets/courseware/errata.js
   part=v20|v21（对应 STM32_COURSEWARE.parts[].id）；pages=课件查看器页号（从 1 起，= PDF 页号）；
   sev=err(确定错误)|warn(可疑/不推荐)|fmt(排版问题)；all=true 表示全书通用、不挂某页；also=同一条在另一册也出现的页。 */
window.STM32_CW_ERRATA = {
 "generated": "2026-10-26 11:44 北京时间",
 "counts": {
  "确定错误": 10,
  "可疑/不推荐": 18,
  "排版问题": 11
 },
 "notice": "从课件 Word/PDF 复制的代码缩进是不间断空格（U+00A0），直接粘进 Keil/GCC 会报 stray '\\302'，请替换成普通空格。",
 "items": [
  {
   "id": "e01",
   "part": "v20",
   "pages": [
    134
   ],
   "pageText": "134",
   "severity": "确定错误",
   "sev": "err",
   "original": "if (huart1.Instance == USART1)\n{\n    HAL_UART_Transmit(&huart1, buff, 1);\n    HAL_UART_Receive_IT(&huart1, buff, 1);\n}",
   "issue": "HAL_UART_Transmit 原型有 4 个参数（huart, pData, Size, Timeout），这里漏了 Timeout，编译直接报 too few arguments；另外回调里判断的是全局 huart1 而不是形参 huart，等于永远为真，多串口时会串台。",
   "fix": "if (huart->Instance == USART1)\n{\n    HAL_UART_Transmit(&huart1, buff, 1, 100);\n    HAL_UART_Receive_IT(&huart1, buff, 1);\n}",
   "block": "v20-035"
  },
  {
   "id": "e02",
   "part": "v20",
   "pages": [
    159
   ],
   "pageText": "159",
   "severity": "确定错误",
   "sev": "err",
   "original": "uint8_t Driver_I2C_SendAddr(uint8_t addr)\n{\n    I2C2->DR = addr;\n    timeout = 0xffff;\n    ...",
   "issue": "timeout 在本函数里没有声明（其它函数里是局部变量），编译报 'timeout' undeclared。",
   "fix": "uint8_t Driver_I2C_SendAddr(uint8_t addr)\n{\n    I2C2->DR = addr;\n    uint16_t timeout = 0xffff;\n    ...",
   "block": "v20-048"
  },
  {
   "id": "e03",
   "part": "v20",
   "pages": [
    145
   ],
   "pageText": "145",
   "severity": "确定错误",
   "sev": "err",
   "original": "/* 1. scl 拉高 sda拉低 */\nSCL_HIGH;\nSDA_LOW;\nI2C_DELAY;\nSDA_HIGH;\nI2C_DELAY;",
   "issue": "软件 I2C 停止信号时序写反：先拉高 SCL 再拉低 SDA，若此时 SDA 为高（例如读最后一字节发 NACK 之后），SCL 高期间 SDA 下降沿就是一个“起始信号”，不符合 I2C 规范，部分器件会出错。正确做法是 SCL 低时先把 SDA 拉低，再拉高 SCL，最后在 SCL 高期间拉高 SDA。",
   "fix": "SCL_LOW;\nSDA_LOW;\nI2C_DELAY;\nSCL_HIGH;\nI2C_DELAY;\nSDA_HIGH;   /* SCL 高时 SDA 上升沿 = STOP */\nI2C_DELAY;",
   "block": "v20-043"
  },
  {
   "id": "e04",
   "part": "v20",
   "pages": [
    114,
    115,
    116
   ],
   "pageText": "114-116",
   "severity": "确定错误",
   "sev": "err",
   "original": "/*Configure GPIO pin : PE3 */ ... GPIO_PIN_3 (GPIOE)\n/*Configure GPIO pin : PG6 */ ... GPIO_MODE_IT_RISING\nHAL_NVIC_SetPriority(EXTI9_5_IRQn, 0, 0);\nHAL_NVIC_EnableIRQ(EXTI9_5_IRQn);\n...\nvoid EXTI15_10_IRQHandler(void) { HAL_GPIO_EXTI_IRQHandler(GPIO_PIN_10); }\n...\nif (HAL_GPIO_ReadPin(GPIOF, GPIO_Pin) == GPIO_PIN_SET)\n    HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_0);",
   "issue": "同一个 HAL 外部中断案例里三段代码对不上：MX_GPIO_Init 配的是 PE3 输出、PG6 上升沿中断、EXTI9_5 中断（像是别的板子的工程），而中断服务函数和回调用的是 PF10/EXTI15_10、LED 在 PA0；GPIOF 时钟也没开、PA0 也没配置成输出。照抄这段 MX_GPIO_Init 按键不会进中断。按本板应为 KEY3=PF10 上升沿下拉、LED1=PA0 推挽输出。",
   "fix": "__HAL_RCC_GPIOA_CLK_ENABLE();\n__HAL_RCC_GPIOF_CLK_ENABLE();\nHAL_GPIO_WritePin(GPIOA, GPIO_PIN_0, GPIO_PIN_SET);\nGPIO_InitStruct.Pin = GPIO_PIN_0;  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;\nGPIO_InitStruct.Pull = GPIO_NOPULL; GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;\nHAL_GPIO_Init(GPIOA, &GPIO_InitStruct);\nGPIO_InitStruct.Pin = GPIO_PIN_10; GPIO_InitStruct.Mode = GPIO_MODE_IT_RISING;\nGPIO_InitStruct.Pull = GPIO_PULLDOWN;\nHAL_GPIO_Init(GPIOF, &GPIO_InitStruct);\nHAL_NVIC_SetPriority(EXTI15_10_IRQn, 2, 0);\nHAL_NVIC_EnableIRQ(EXTI15_10_IRQn);",
   "block": "v20-026/027/028"
  },
  {
   "id": "e05",
   "part": "v20",
   "pages": [
    42,
    43
   ],
   "pageText": "42-43",
   "severity": "确定错误",
   "sev": "err",
   "original": "/* 按位或 8&7 = 1000&0111 = 0000 */\n/* 按位取反 ~8 = ~1000 = 0111 */\n...\na =  1111 0100  是由 ~(1<<2) 得到\n...\nprintfBinary(\"10的123位置为101 \", num);",
   "issue": "位运算教学示例的注释有多处与代码不符：① 8&7 是“按位与”不是“按位或”；② ~(1<<2) 是 1111 1011，不是 1111 0100；③ ~8 在 unsigned char 下是 1111 0111，程序实际打印 11110111 而不是 0111；④ num 初值是 13，标签写成“10的…”，结果应为 1011；⑤ 多处 mum 应为 num。另 itoa 不是标准 C 函数，GCC/newlib 下不可用（Keil 可能也没有）。",
   "fix": "/* 按位与 8&7 = 1000&0111 = 0000 */\n/* 按位取反 ~8 = ~0000 1000 = 1111 0111 */\na = 1111 1011  是由 ~(1<<2) 得到\nprintfBinary(\"13的123位置为101 \", num);   /* 结果 1011 */\n/* itoa 可换成自己写的循环按位输出 */",
   "block": "v20-007"
  },
  {
   "id": "e06",
   "part": "v21",
   "pages": [
    15
   ],
   "pageText": "15",
   "severity": "确定错误",
   "sev": "err",
   "original": "#include \"led.h\"\n#include \"usart.h\"\n#include \"timer6.h\"\nint main(void)\n{\n    LED_Init();\n    usart1_init();\n    printf(\"尚硅谷基本定时器实验....\\r\\n\");\n    TIM6_Init();",
   "issue": "本章的驱动文件是 Driver_LED.h / Driver_USART.h / Driver_TIM6.h，函数名是 Driver_LED_Init / Driver_USART1_Init / Driver_TIM6_Init（紧接着的 Driver_TIM6.h 就是这样声明的），main 里用的是旧工程的头文件名和函数名，照抄会找不到头文件、链接失败。",
   "fix": "#include \"Driver_LED.h\"\n#include \"Driver_USART.h\"\n#include \"Driver_TIM6.h\"\nint main(void)\n{\n    Driver_LED_Init();\n    Driver_USART1_Init();\n    printf(\"尚硅谷基本定时器实验....\\r\\n\");\n    Driver_TIM6_Init();",
   "block": "v21-013"
  },
  {
   "id": "e07",
   "part": "v21",
   "pages": [
    52
   ],
   "pageText": "52",
   "severity": "确定错误",
   "sev": "err",
   "original": "/* 4.3 输出的极性 0=高电平有效 1=低电平有效 */;\nTIM1->CCER &= TIM_CCER_CC1P;",
   "issue": "想把 CC1P 清 0（高电平有效），却漏了取反符号 ~：这句实际是把 CCER 除 CC1P 以外的位全部清掉。只是因为 CCER 复位值为 0 才“碰巧能用”，如果之前开过其它通道就会被关掉。",
   "fix": "/* 4.3 输出的极性 0=高电平有效 1=低电平有效 */\nTIM1->CCER &= ~TIM_CCER_CC1P;",
   "block": "v21-040"
  },
  {
   "id": "e08",
   "part": "v21",
   "pages": [
    61
   ],
   "pageText": "61",
   "severity": "确定错误",
   "sev": "err",
   "original": "int main(void)\n    HAL_Init();\n    ...",
   "issue": "main 函数少了左花括号 {，语法错误，编译不过。",
   "fix": "int main(void)\n{\n    HAL_Init();\n    ...",
   "block": "v21-046"
  },
  {
   "id": "e09",
   "part": "v21",
   "pages": [
    62
   ],
   "pageText": "62",
   "severity": "确定错误",
   "sev": "err",
   "original": "Extern Volatile uint8_t dmaTC;      /* Driver_DMA1.h */\nVolatile uint8_t dmaTC;             /* Driver_DMA1.c */",
   "issue": "C 关键字区分大小写，Extern / Volatile 不是关键字，编译报 unknown type name，后续 main 里 dmaTC 也跟着报 undeclared。（像是 Word 自动首字母大写造成的）",
   "fix": "extern volatile uint8_t dmaTC;      /* Driver_DMA1.h */\nvolatile uint8_t dmaTC;             /* Driver_DMA1.c */",
   "block": "v21-048/049"
  },
  {
   "id": "e10",
   "part": "v21",
   "pages": [
    71,
    76
   ],
   "pageText": "71,76",
   "severity": "确定错误",
   "sev": "err",
   "original": "ADC1->CR2 &= ~ADC_CR2_EXTTRIG; /* 禁用规则组的外部转换 */\n...\nADC1->CR2 |= ADC_CR2_ADON;\nADC1->CR2 |= ADC_CR2_SWSTART;",
   "issue": "RM0008 规定：F1 的 SWSTART 只有在 EXTTRIG=1 且 EXTSEL=111（SWSTART）时才起作用。这里把 EXTTRIG 关掉了，SWSTART 实际无效，转换其实是靠第二次写 ADON（ADON 已为 1 时再写 1 = 启动转换）触发的，注释和原理讲反了；以后如果删掉那句 ADON，ADC 就不转了。",
   "fix": "ADC1->CR2 |= ADC_CR2_EXTSEL;          /* EXTSEL=111：软件触发 SWSTART */\nADC1->CR2 |= ADC_CR2_EXTTRIG;         /* 规则组使能外部触发（软件触发也需要） */\n...\nADC1->CR2 |= ADC_CR2_SWSTART;         /* 启动转换 */",
   "block": "v21-053/057"
  },
  {
   "id": "e11",
   "part": "v21",
   "pages": [
    79
   ],
   "pageText": "79",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "int main(void)\n{\n    ...\n    HAL_ADC_Start_DMA(&hadc1, (uint32_t *)data, 2);",
   "issue": "本页 main 用到了数组 data，但这一段（“添加其他代码”）里没有给出 data 的定义，只按本页抄会报 data undeclared；且 ADC 是半字（16 位）DMA，数组必须是 uint16_t。",
   "fix": "uint16_t data[2] = {0};   /* 放在 main 之前（USER CODE BEGIN 0） */",
   "block": "v21-058"
  },
  {
   "id": "e12",
   "part": "v20",
   "pages": [
    114,
    116
   ],
   "pageText": "114,116",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "HAL_NVIC_SetPriority(EXTI9_5_IRQn, 0, 0);\n...\nvoid HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)\n{\n    if (GPIO_Pin == GPIO_PIN_10)\n    {\n        HAL_Delay(15);",
   "issue": "在 EXTI 回调（中断上下文）里调用 HAL_Delay。HAL 的 SysTick 优先级默认是 15（最低），EXTI 设成 0，SysTick 无法打断 EXTI，uwTick 不再增加，HAL_Delay 会永远卡死。p114 正文提醒了“调整优先级”，但给出的代码仍是 0,0，读者照抄会卡死。",
   "fix": "方案一：HAL_NVIC_SetPriority(EXTI15_10_IRQn, 2, 0) 并把 SysTick 设为更高优先级（数值更小，如 HAL_InitTick(0)）；\n方案二（推荐）：回调里只记录时间戳，用 HAL_GetTick() 判断间隔 >15ms 再动作，不在中断里延时。",
   "block": "v20-028"
  },
  {
   "id": "e13",
   "part": "v20",
   "pages": [
    158
   ],
   "pageText": "158",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "I2C2->TRISE |= 37;",
   "issue": "TRISE 复位值为 0x02，用 |= 得到 0x27|0x02=0x27 碰巧正确，但这是“整值写入”的寄存器，应直接赋值；同函数 CR2 |= 36 也是同理。",
   "fix": "I2C2->CR2 = (I2C2->CR2 & ~I2C_CR2_FREQ) | 36;\nI2C2->TRISE = 37;",
   "block": "v20-048"
  },
  {
   "id": "e14",
   "part": "v20",
   "pages": [
    160
   ],
   "pageText": "160",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "/**\n * @description: 读一个字节的数据\n * @param {uint8_t} byte 要发送的字节\n */\nuint8_t Driver_I2C_ReadByte(void)",
   "issue": "注释写的参数 byte“要发送的字节”与函数无参、返回读取值不符（复制粘贴遗留）。",
   "fix": "/**\n * @description: 读一个字节的数据\n * @return 读到的字节，超时返回 0\n */",
   "block": "v20-048"
  },
  {
   "id": "e15",
   "part": "v20",
   "pages": [
    160,
    161,
    162,
    163
   ],
   "pageText": "160-163",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "单字节读：发送读地址 → 读 SR2 清 ADDR → 再清 ACK、发 STOP",
   "issue": "RM0008 的单字节接收流程要求在清 ADDR（读 SR1+SR2）之前就把 ACK 清 0，否则第一个字节后会回 ACK、多收一个字节；本例 EEPROM 能工作但不规范。",
   "fix": "I2C2->CR1 &= ~I2C_CR1_ACK;   /* 先 NACK */\n(void)I2C2->SR1; (void)I2C2->SR2;   /* 再清 ADDR */\nI2C2->CR1 |= I2C_CR1_STOP;\n/* 等 RXNE 后读 DR */",
   "block": "v20-050"
  },
  {
   "id": "e16",
   "part": "v20",
   "pages": [
    142,
    143,
    150
   ],
   "pageText": "142-143,150",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "Inf_M24C02_WriteBytes(0x00, \"123456789abcdefghijkl\", 21);  /* 一次写 21 字节 */",
   "issue": "M24C02 页大小 16 字节，一次页写超过页边界会在页内回卷覆盖开头数据。p142 正文讲了这一规则，示例可能是故意演示，但页面没说明预期输出，读者会以为是芯片坏了。",
   "fix": "在示例旁注明“超过 16 字节会回卷”；正确用法是按页拆分：每次写 n = 16 - (addr % 16) 字节，写完等 5ms 再写下一页。",
   "block": "v20-041/046"
  },
  {
   "id": "e17",
   "part": "v20",
   "pages": [
    165,
    166
   ],
   "pageText": "165-166",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "HAL_I2C_Mem_Read(&hi2c2, ADDR + 1, innerAddr, I2C_MEMADD_SIZE_8BIT, ...);",
   "issue": "HAL 的 DevAddress 传 8 位写地址即可，读写位由 HAL 自己置；传 ADDR+1 在 F1 HAL 里因为会被重新或上 1 所以碰巧能用，但不规范，换别的系列/库会出错。",
   "fix": "HAL_I2C_Mem_Read(&hi2c2, ADDR, innerAddr, I2C_MEMADD_SIZE_8BIT, ...);",
   "block": "v20-053"
  },
  {
   "id": "e18",
   "part": "v20",
   "pages": [
    62,
    63
   ],
   "pageText": "62-63（另见 V2.1.0 p12）",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "SysTick->LOAD = 72 * us;\n/*等待计数到0， 如果计数到0则16位会置为1*/",
   "issue": "SysTick 从 LOAD 数到 0 共 LOAD+1 个周期，严格应为 72*us-1（误差很小）；另注释“16位”应写成“第 16 位 COUNTFLAG”。v21 p12 的同一段代码相同。",
   "fix": "SysTick->LOAD = 72 * us - 1;\n/* 计数到 0 时 CTRL 第 16 位 COUNTFLAG 置 1 */",
   "block": "v20-011",
   "also": [
    {
     "part": "v21",
     "pages": [
      12
     ]
    }
   ]
  },
  {
   "id": "e19",
   "part": "v20",
   "pages": [
    112
   ],
   "pageText": "112",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "EXTI->PR |= EXTI_PR_PR10;\nDelay_ms(5);",
   "issue": "EXTI_PR 是“写 1 清零”寄存器，用 |= 会把其它已挂起的线一并清掉（读-改-写）；应直接赋值。另外在中断里 Delay_ms 阻塞不推荐。注释“按下按键 1”与代码用的 PF10（KEY_3/SW5）不符。",
   "fix": "EXTI->PR = EXTI_PR_PR10;   /* 只清 line10 */",
   "block": "v20-025"
  },
  {
   "id": "e20",
   "part": "v20",
   "pages": [
    124,
    125,
    126,
    127,
    128,
    129,
    130,
    131
   ],
   "pageText": "124-131",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "buff[len++] = USART1->DR;   /* 接收中断里存数据，IDLE 判断一帧结束 */",
   "issue": "与中断共享的 len、isOver 等变量没有 volatile，开优化后主循环可能读不到更新；没有判断 len 是否越界；空闲中断标志 IDLE 需要“先读 SR 再读 DR”才清除，部分写法没清。",
   "fix": "volatile uint8_t len, isOver;\nif (len < sizeof(buff)) buff[len++] = USART1->DR;\nif (USART1->SR & USART_SR_IDLE) { (void)USART1->DR; isOver = 1; }",
   "block": "v20-031/032"
  },
  {
   "id": "e21",
   "part": "v20",
   "pages": [
    33,
    41
   ],
   "pageText": "33,41",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "GPIOA->CRL = 0x3;   /* 整个寄存器直接赋值 */",
   "issue": "入门示例用整寄存器赋值会把同一寄存器里其它引脚的配置一起改掉（PA1~PA7 变成模拟输入），后面多 LED 时会互相覆盖。属于教学简化，建议注明。",
   "fix": "GPIOA->CRL &= ~(GPIO_CRL_MODE0 | GPIO_CRL_CNF0);\nGPIOA->CRL |= GPIO_CRL_MODE0;   /* PA0 推挽输出 50MHz */",
   "block": "v20-004/006"
  },
  {
   "id": "e22",
   "part": "v21",
   "pages": [
    4,
    5,
    16,
    17
   ],
   "pageText": "4-5,16-17",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "void TIM6_IRQHandler(void) { ... printf(...); }",
   "issue": "在中断服务函数里调用 printf（阻塞串口发送），会严重拖长中断时间，不推荐；同时示例缺 #include <stdio.h>。",
   "fix": "中断里只置标志，主循环里 printf。",
   "block": "v21-004/015"
  },
  {
   "id": "e23",
   "part": "v21",
   "pages": [
    37,
    41
   ],
   "pageText": "37,41",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "return 1000000 / t;",
   "issue": "与捕获中断共享的 t 没有 volatile；整数除法会丢小数；t 为 0（还没测到信号）时除零触发 HardFault/未定义。",
   "fix": "volatile uint32_t t;\nreturn t ? 1000000.0 / t : 0;",
   "block": "v21-028/031"
  },
  {
   "id": "e24",
   "part": "v21",
   "pages": [
    45
   ],
   "pageText": "45",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "return TIM4->CCR1 / 1000.0;\nreturn 1000000.0 / TIM4->CCR1;",
   "issue": "PWM 输入模式下周期计数应为 CCR1+1（HAL 版 v21-036 已写 +1，寄存器版没写，两版不一致）；CCR1 为 0 时除零。",
   "fix": "uint32_t p = TIM4->CCR1 + 1;\nreturn 1000000.0 / p;",
   "block": "v21-034"
  },
  {
   "id": "e25",
   "part": "v21",
   "pages": [
    60
   ],
   "pageText": "60",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "DMA1_Channel4->CCR |= DMA_CCR4_CIRC;\n...\nDMA1->IFCR |= DMA_IFCR_CGIF4;\nuint8_t isTransmitFinished = 0;",
   "issue": "IFCR 是只写寄存器，应直接赋值；USART 发送用循环模式会不停重复发送同一缓冲区，与“发送完成”的示例意图不符；isTransmitFinished 被中断修改却没有 volatile。",
   "fix": "/* 不要 CIRC */\nDMA1->IFCR = DMA_IFCR_CGIF4;\nvolatile uint8_t isTransmitFinished = 0;",
   "block": "v21-045"
  },
  {
   "id": "e26",
   "part": "v21",
   "pages": [
    65
   ],
   "pageText": "65",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "uint8_t dmaTc;",
   "issue": "HAL 版 DMA 例子里中断回调修改 dmaTc，同样缺 volatile，开优化后 while 循环可能永远看不到变化。",
   "fix": "volatile uint8_t dmaTc;",
   "block": "v21-050"
  },
  {
   "id": "e27",
   "part": "v21",
   "pages": [
    71,
    77
   ],
   "pageText": "71,77",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "ADC1->CR2 |= ADC_CR2_ADON;\nADC1->CR2 |= ADC_CR2_CAL;",
   "issue": "RM0008 要求 ADON 上电后至少等待 2 个 ADC 时钟（tSTAB）再开始校准，这里紧接着就校准；多数情况能用但不规范。",
   "fix": "ADC1->CR2 |= ADC_CR2_ADON;\nfor (volatile int i = 0; i < 100; i++);   /* 等待稳定 */\nADC1->CR2 |= ADC_CR2_RSTCAL; while (ADC1->CR2 & ADC_CR2_RSTCAL);\nADC1->CR2 |= ADC_CR2_CAL;    while (ADC1->CR2 & ADC_CR2_CAL);",
   "block": "v21-053/057"
  },
  {
   "id": "e28",
   "part": "v21",
   "pages": [
    102,
    103,
    104,
    105,
    106
   ],
   "pageText": "102-106",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "void Inf_W25Q32_Init(void)\n{\n    Driver_SPI_Init();\n}",
   "issue": "HAL 版 W25Q32 里 Driver_SPI_Init 已经不存在（spi.c 的 USER CODE 只定义了 Start/Stop/SwapByte，初始化由 MX_SPI1_Init 完成），这里仍调用它：隐式声明告警，链接时可能报 undefined reference（取决于是否开启未用段剔除）。main 也没有调用 Init。",
   "fix": "void Inf_W25Q32_Init(void)\n{\n    /* HAL 版由 MX_SPI1_Init() 完成初始化，这里留空 */\n}",
   "block": "v21-073"
  },
  {
   "id": "e29",
   "part": "v21",
   "pages": [
    88,
    89,
    90,
    91,
    92,
    93,
    94,
    95,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106
   ],
   "pageText": "88-106",
   "severity": "可疑/不推荐",
   "sev": "warn",
   "original": "Inf_W25q32_WriteEnable();\n...页写/扇区擦除...\nInf_W25q32_WriteDisanable();",
   "issue": "W25Q32 在页编程/擦除执行完会自动清除 WEL；BUSY 期间发写禁止指令会被忽略，所以这句无害但无意义，容易让人误会。",
   "fix": "删除 WriteDisable，或放在等待 BUSY 结束之后。",
   "block": "v21-063/068/073"
  },
  {
   "id": "e30",
   "part": "v20",
   "pages": [],
   "pageText": "全书",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "（98/129 个代码块）缩进是不间断空格 U+00A0",
   "issue": "Word 源文档里代码缩进用的是 NBSP（U+00A0），从课件/网页直接复制到 Keil/GCC 会报 stray '\\302' in program，看起来像“代码有错”。规范化成普通空格后 107/129 段能通过语法检查。",
   "fix": "把 U+00A0 全部替换为普通空格（网站展示/复制时也应做替换）。",
   "block": "全部",
   "all": true
  },
  {
   "id": "e31",
   "part": "v20",
   "pages": [
    112,
    124
   ],
   "pageText": "112,124",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "#ifndef __DRVIER_USART_H\nDrviver_LED_Toggle(LED_1);",
   "issue": "拼写错误：DRVIER、Drviver（应为 DRIVER / Driver）。头文件保护宏前后一致所以不影响编译，但函数名 Drviver_ 与声明不一致时会链接失败。",
   "fix": "#ifndef __DRIVER_USART_H\nDriver_LED_Toggle(LED_1);",
   "block": "v20-030 等"
  },
  {
   "id": "e32",
   "part": "v21",
   "pages": [
    41,
    52,
    69,
    70,
    71,
    72,
    73,
    74,
    75,
    76,
    77,
    84
   ],
   "pageText": "41,52,69-77,84",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "HAL_TIM_IC_Start_IT(&htim4, TIM_CHANNEL_1);;\n/* 4.2 配置捕获比较寄存器的值 */;",
   "issue": "多余分号：语句后 ;; 以及注释后单独的 ;（v21-040/053/057/059 等多处），无害但不规范。",
   "fix": "删除多余的分号。",
   "block": "v21-032"
  },
  {
   "id": "e33",
   "part": "v21",
   "pages": [
    59
   ],
   "pageText": "59",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "/* 1. 开启 DAM 时钟 */",
   "issue": "DAM 应为 DMA。",
   "fix": "/* 1. 开启 DMA 时钟 */",
   "block": "v21-043"
  },
  {
   "id": "e34",
   "part": "v21",
   "pages": [
    74
   ],
   "pageText": "74",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "printf(\"ADC转换实验: 单通道\\r\\n\");   /* 双通道示例 */",
   "issue": "双通道（扫描）示例里提示语仍是“单通道”，复制粘贴遗留。",
   "fix": "printf(\"ADC转换实验: 双通道\\r\\n\");",
   "block": "v21-055"
  },
  {
   "id": "e35",
   "part": "v21",
   "pages": [
    70
   ],
   "pageText": "70",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "double Driver_ADC1_ReadV(void);\ndouble Driver_ADC1_ReadV(void);",
   "issue": "头文件里同一函数声明了两次（无害，复制遗留）。",
   "fix": "保留一行即可。",
   "block": "v21-052"
  },
  {
   "id": "e36",
   "part": "v21",
   "pages": [
    76
   ],
   "pageText": "76",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "ADC1->SQR3 |= 12 << 5;       /* 设置最后5位 */",
   "issue": "这句设置的是 SQ2（bit5~9），注释仍写“最后5位”。",
   "fix": "ADC1->SQR3 |= 12 << 5;       /* SQ2 = 通道12（bit5~9） */",
   "block": "v21-057"
  },
  {
   "id": "e37",
   "part": "v21",
   "pages": [
    86,
    87,
    88,
    89,
    90,
    91,
    92,
    93,
    94,
    95,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106
   ],
   "pageText": "86-106",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "Inf_W25Q32_WaiteNotBusy / Inf_W25q32_WriteDisanable / W25Q32 与 W25q32 混用",
   "issue": "函数名拼写：Waite→Wait，Disanable→Disable，大小写 Q/q 不统一，容易在调用时写错导致链接失败。",
   "fix": "统一为 Inf_W25Q32_WaitNotBusy / Inf_W25Q32_WriteDisable。",
   "block": "多处"
  },
  {
   "id": "e38",
   "part": "v21",
   "pages": [
    29,
    37,
    46,
    63
   ],
   "pageText": "29,37,46,63",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "“外设不则”“更新时间”“系统定时器实验开始”",
   "issue": "正文/注释错字：“外设不则”应为“外设不增”（p63）；“更新时间”应为“更新事件”；TIM 输入捕获/PWM 章节的提示语“系统定时器实验开始”是从前文复制的（p29/37/46）。",
   "fix": "按左述更正。",
   "block": "正文"
  },
  {
   "id": "e39",
   "part": "v21",
   "pages": [
    66
   ],
   "pageText": "PPT（对应 V2.1.0 约 p66）",
   "severity": "排版问题",
   "sev": "fmt",
   "original": "0xFE=244V（ADC 逐次逼近示意）",
   "issue": "数值算错：0xFE=254，按示意 1 位=1V 应为 254V。",
   "fix": "0xFE=254V",
   "block": "Presentation15.pptx"
  }
 ]
};
