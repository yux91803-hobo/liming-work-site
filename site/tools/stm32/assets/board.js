/* 尚硅谷 STM32F103ZET6 板载资源（由原理图提取，见 board.json） */
window.STM32_BOARD = {
 "board": "尚硅谷 STM32F103ZET6 开发板",
 "mcu": "STM32F103ZET6 (LQFP144)",
 "source": "尚硅谷 ZET6开发板 V1.0 原理图 (2024-02, 15页) 为主；核心板 Schematic4_1 + 扩展板 0.11 网络一致",
 "extracted": "2026-10-25",
 "note": "仅收录原理图上实际画出的连接；active=low/high 只在原理图能看出电平时给出；pin 为 LQFP144 引脚号（已与 ref-pins-from-schematic.json 核对）。page 对应 assets/ 下的原理图页。",
 "resources": [
  {
   "group": "LED",
   "name": "LED1 黄灯",
   "signal": "LED-1",
   "mcu": "PA0",
   "pin": 34,
   "active": "low",
   "note": "3V3→RN2 2kΩ→LED→IO，输出低电平点亮",
   "page": "board-08"
  },
  {
   "group": "LED",
   "name": "LED2 蓝灯",
   "signal": "LED-2",
   "mcu": "PA1",
   "pin": 35,
   "active": "low",
   "note": "3V3→RN2 2kΩ→LED→IO，输出低电平点亮",
   "page": "board-08"
  },
  {
   "group": "LED",
   "name": "LED3 绿灯",
   "signal": "LED-3",
   "mcu": "PA8",
   "pin": 100,
   "active": "low",
   "note": "3V3→RN2 2kΩ→LED→IO，输出低电平点亮",
   "page": "board-08"
  },
  {
   "group": "LED",
   "name": "LED5 WS2812 全彩灯",
   "signal": "LED-0",
   "mcu": "PG11",
   "pin": 126,
   "active": "data",
   "part": "WS2812",
   "note": "单线协议 DIN，5V 供电；排针丝印为 LED-5",
   "page": "board-08"
  },
  {
   "group": "LED",
   "name": "红灯 电源指示",
   "signal": "—",
   "note": "接 3V3/GND，常亮，不受 MCU 控制",
   "page": "board-08"
  },
  {
   "group": "KEY",
   "name": "KEY1",
   "signal": "KEY-1",
   "mcu": "PF8",
   "pin": 20,
   "active": "low",
   "note": "按下接 GND，原理图无外部上拉 → 配置 GPIO_PULLUP",
   "page": "board-08"
  },
  {
   "group": "KEY",
   "name": "KEY2",
   "signal": "KEY-2",
   "mcu": "PF9",
   "pin": 21,
   "active": "low",
   "note": "按下接 GND，原理图无外部上拉 → 配置 GPIO_PULLUP",
   "page": "board-08"
  },
  {
   "group": "KEY",
   "name": "KEY3",
   "signal": "KEY-3",
   "mcu": "PF10",
   "pin": 22,
   "active": "high",
   "note": "按下接 3V3，原理图无外部下拉 → 配置 GPIO_PULLDOWN",
   "page": "board-08"
  },
  {
   "group": "KEY",
   "name": "KEY4",
   "signal": "KEY-4",
   "mcu": "PF11",
   "pin": 49,
   "active": "high",
   "note": "按下接 3V3，原理图无外部下拉 → 配置 GPIO_PULLDOWN",
   "page": "board-08"
  },
  {
   "group": "KEY",
   "name": "RESET 复位键",
   "signal": "NRST",
   "mcu": "NRST",
   "pin": 25,
   "active": "low",
   "note": "SW2 按下拉低 NRST；10kΩ 上拉 + 100nF",
   "page": "board-02"
  },
  {
   "group": "BEEP",
   "name": "蜂鸣器",
   "signal": "BUZZER-EN",
   "mcu": "PB1",
   "pin": 47,
   "active": "high",
   "part": "AO3400A",
   "note": "PB1→1kΩ→AO3400A N-MOS(10kΩ 下拉)→蜂鸣器(5V)，高电平响",
   "page": "board-08"
  },
  {
   "group": "系统",
   "name": "HSE 晶振 8MHz",
   "signal": "OSC_IN/OSC_OUT",
   "mcu": "OSC_IN/OSC_OUT",
   "pin": [
    23,
    24
   ],
   "note": "X2 8MHz，20pF",
   "page": "board-02"
  },
  {
   "group": "系统",
   "name": "LSE 晶振 32.768kHz",
   "signal": "PC14/PC15",
   "mcu": "PC14/PC15",
   "pin": [
    8,
    9
   ],
   "note": "X1 32.768kHz，12pF",
   "page": "board-02"
  },
  {
   "group": "系统",
   "name": "BOOT0",
   "signal": "BOOT0",
   "mcu": "BOOT0",
   "pin": 138,
   "note": "10kΩ 下拉；跳线 H7 1-2 拉高",
   "page": "board-02"
  },
  {
   "group": "系统",
   "name": "BOOT1",
   "signal": "BOOT1",
   "mcu": "PB2",
   "pin": 48,
   "note": "跳线 H7 3-4 拉高 / 5-6 拉低",
   "page": "board-02"
  },
  {
   "group": "调试",
   "name": "SWD SWDIO",
   "signal": "SWDIO",
   "mcu": "PA13",
   "pin": 105,
   "note": "CN1 8针调试座(对接自产 STLink)/H8",
   "page": "board-02"
  },
  {
   "group": "调试",
   "name": "SWD SWCLK",
   "signal": "SWCLK",
   "mcu": "PA14",
   "pin": 109,
   "note": "CN1/H8",
   "page": "board-02"
  },
  {
   "group": "串口",
   "name": "USART1 TX（STLink 虚拟串口）",
   "signal": "UART1-TX",
   "mcu": "PA9",
   "pin": 101,
   "note": "默认经 CN1 接 STLink USB 虚拟串口；跳线 H11 可切到 RS485/RS232/ESP32 烧录",
   "page": "board-02"
  },
  {
   "group": "串口",
   "name": "USART1 RX（STLink 虚拟串口）",
   "signal": "UART1-RX",
   "mcu": "PA10",
   "pin": 102,
   "note": "同上",
   "page": "board-02"
  },
  {
   "group": "USB",
   "name": "USB D-",
   "signal": "USB-DN",
   "mcu": "PA11",
   "pin": 103,
   "note": "Type-C USB1，22Ω 串阻，MCU 原生 USB；无 USB 转串口芯片",
   "page": "board-01"
  },
  {
   "group": "USB",
   "name": "USB D+",
   "signal": "USB-DP",
   "mcu": "PA12",
   "pin": 104,
   "note": "同上",
   "page": "board-01"
  },
  {
   "group": "存储",
   "name": "EEPROM SCL",
   "signal": "I2C2-SCL",
   "mcu": "PB10",
   "pin": 69,
   "part": "M24C02-WMN6TP",
   "note": "M24C02，10kΩ 上拉",
   "page": "board-04"
  },
  {
   "group": "存储",
   "name": "EEPROM SDA",
   "signal": "I2C2-SDA",
   "mcu": "PB11",
   "pin": 70,
   "part": "M24C02-WMN6TP",
   "note": "M24C02，10kΩ 上拉",
   "page": "board-04"
  },
  {
   "group": "存储",
   "name": "NOR Flash CS",
   "signal": "W25Q-CS",
   "mcu": "PC13",
   "pin": 7,
   "part": "W25Q32JVSSIQ",
   "note": "W25Q32 (SPI1：PA5 SCK / PA6 MISO / PA7 MOSI)",
   "page": "board-05"
  },
  {
   "group": "存储",
   "name": "SPI1 SCK",
   "signal": "SPI1-SCK",
   "mcu": "PA5",
   "pin": 41,
   "note": "W25Q32 与 LoRa 共用",
   "page": "board-05"
  },
  {
   "group": "存储",
   "name": "SPI1 MISO",
   "signal": "SPI1-MISO",
   "mcu": "PA6",
   "pin": 42,
   "note": "共用",
   "page": "board-05"
  },
  {
   "group": "存储",
   "name": "SPI1 MOSI",
   "signal": "SPI1-MOSI",
   "mcu": "PA7",
   "pin": 43,
   "note": "共用",
   "page": "board-05"
  },
  {
   "group": "存储",
   "name": "NAND CE",
   "signal": "FSMC-NCE2",
   "mcu": "PD7",
   "pin": 123,
   "part": "W29N01HVSINA",
   "note": "W29N01HV；CLE=PD11(A16) ALE=PD12(A17) NWE=PD5 NOE=PD4 NWAIT=PD6 D0-D7",
   "page": "board-06"
  },
  {
   "group": "存储",
   "name": "SRAM CS",
   "signal": "FSMC-NE3",
   "mcu": "PG10",
   "pin": 125,
   "part": "IS62WV51216BLL-55TLI",
   "note": "IS62WV51216 512K×16，A0-A18/D0-D15，NBL0=PE0 NBL1=PE1（页标题写 SDRAM，实为 SRAM）",
   "page": "board-03"
  },
  {
   "group": "存储",
   "name": "SD 卡 SDIO",
   "signal": "SDIO D0-D3/CK/CMD",
   "mcu": "PC8-PC11/PC12/PD2",
   "pin": [
    98,
    99,
    111,
    112,
    113,
    116
   ],
   "note": "SDIO 4bit；PC10/PC11 与排针 UART3/UART4 网络、PC12/PD2 与 UART5 共用",
   "page": "board-07"
  },
  {
   "group": "存储",
   "name": "SD 卡检测",
   "signal": "SD-CD",
   "mcu": "PG8",
   "pin": 93,
   "note": "卡座检测脚",
   "page": "board-07"
  },
  {
   "group": "显示",
   "name": "LCD 片选",
   "signal": "FSMC-NE4",
   "mcu": "PG12",
   "pin": 127,
   "note": "FSMC Bank1 NE4，RS=FSMC_A10(PG0)，D0-D15，NWE/NOE",
   "page": "board-15"
  },
  {
   "group": "显示",
   "name": "LCD RS",
   "signal": "FSMC-A10",
   "mcu": "PG0",
   "pin": 56,
   "page": "board-15"
  },
  {
   "group": "显示",
   "name": "LCD 复位",
   "signal": "LCD-RST",
   "mcu": "PG15",
   "pin": 132,
   "page": "board-15"
  },
  {
   "group": "显示",
   "name": "LCD 背光",
   "signal": "LCD-BG",
   "mcu": "PB0",
   "pin": 46,
   "note": "背光控制（有效电平原理图未在接口页标注）",
   "page": "board-15"
  },
  {
   "group": "显示",
   "name": "触摸 I2C SCL",
   "signal": "I2C1-SCL",
   "mcu": "PB6",
   "pin": 136,
   "note": "电容触摸(GT 系列)",
   "page": "board-15"
  },
  {
   "group": "显示",
   "name": "触摸 I2C SDA",
   "signal": "I2C1-SDA",
   "mcu": "PB7",
   "pin": 137,
   "page": "board-15"
  },
  {
   "group": "显示",
   "name": "触摸 INT",
   "signal": "GT-INT",
   "mcu": "PC1",
   "pin": 27,
   "page": "board-15"
  },
  {
   "group": "显示",
   "name": "触摸 RST",
   "signal": "GT-RST",
   "mcu": "PC2",
   "pin": 28,
   "page": "board-15"
  },
  {
   "group": "通信",
   "name": "W5500 以太网 SPI2",
   "signal": "SPI2-SCK/MISO/MOSI",
   "mcu": "PB13/PB14/PB15",
   "pin": [
    74,
    75,
    76
   ],
   "part": "W5500",
   "note": "25MHz 晶振，HR911105A 网口",
   "page": "board-09"
  },
  {
   "group": "通信",
   "name": "W5500 CS",
   "signal": "W5500-CS",
   "mcu": "PD3",
   "pin": 117,
   "page": "board-09"
  },
  {
   "group": "通信",
   "name": "W5500 INT",
   "signal": "W5500-INT",
   "mcu": "PG6",
   "pin": 91,
   "page": "board-09"
  },
  {
   "group": "通信",
   "name": "W5500 RST",
   "signal": "W5500-RST",
   "mcu": "PG7",
   "pin": 92,
   "page": "board-09"
  },
  {
   "group": "通信",
   "name": "ESP32-C3 UART2",
   "signal": "UART2-TX/RX",
   "mcu": "PA2/PA3",
   "pin": [
    36,
    37
   ],
   "part": "ESP32-C3FN4",
   "note": "ESP32-C3FN4 WiFi/BLE",
   "page": "board-12"
  },
  {
   "group": "通信",
   "name": "ESP32-C3 EN",
   "signal": "ESP32-EN",
   "mcu": "PE4",
   "pin": 3,
   "page": "board-12"
  },
  {
   "group": "通信",
   "name": "LoRa CS",
   "signal": "LORA-CS",
   "mcu": "PG14",
   "pin": 129,
   "part": "E220-400M225",
   "note": "E220 LoRa 模块（丝印 E220-400M225），SPI1 共用",
   "page": "board-13"
  },
  {
   "group": "通信",
   "name": "LoRa RST",
   "signal": "LORA-RST",
   "mcu": "PG13",
   "pin": 128,
   "page": "board-13"
  },
  {
   "group": "通信",
   "name": "LoRa BUSY",
   "signal": "LORA-BUSY",
   "mcu": "PE2",
   "pin": 1,
   "page": "board-13"
  },
  {
   "group": "通信",
   "name": "LoRa TXEN/RXEN",
   "signal": "LORA-TXEN/RXEN",
   "mcu": "PE6/PE5",
   "pin": [
    5,
    4
   ],
   "page": "board-13"
  },
  {
   "group": "通信",
   "name": "RS485 方向",
   "signal": "485RX-EN",
   "mcu": "PE3",
   "pin": 2,
   "part": "SSP485N",
   "note": "SSP485N，复用 USART1（跳线 H11 1-3、2-4），120Ω 终端跳线",
   "page": "board-10"
  },
  {
   "group": "通信",
   "name": "RS232",
   "signal": "UART1",
   "mcu": "PA9/PA10",
   "pin": [
    101,
    102
   ],
   "part": "SP3232EEN",
   "note": "SP3232EEN + DB9，复用 USART1（跳线 H11 3-5、4-6）",
   "page": "board-10"
  },
  {
   "group": "通信",
   "name": "CAN RX",
   "signal": "CAN-RX",
   "mcu": "PB8",
   "pin": 139,
   "part": "PD1050S",
   "note": "PD1050S；PB8/PB9 需 CAN 重映射（AFIO CAN_REMAP=0b10）",
   "page": "board-11"
  },
  {
   "group": "通信",
   "name": "CAN TX",
   "signal": "CAN-TX",
   "mcu": "PB9",
   "pin": 140,
   "page": "board-11"
  },
  {
   "group": "传感",
   "name": "DS18B20 插座",
   "signal": "18B20",
   "mcu": "PC3",
   "pin": 29,
   "note": "H9，10kΩ 上拉",
   "page": "board-08"
  },
  {
   "group": "模拟",
   "name": "电位器",
   "signal": "ADC1-10",
   "mcu": "PC0",
   "pin": 26,
   "note": "ADC123_IN10",
   "page": "board-14"
  },
  {
   "group": "模拟",
   "name": "4-20mA 输入1",
   "signal": "ADC3-4",
   "mcu": "PF6",
   "pin": 18,
   "note": "ADC3_IN4，150Ω 采样电阻 + ZMM3V3 钳位",
   "page": "board-14"
  },
  {
   "group": "模拟",
   "name": "4-20mA 输入2",
   "signal": "ADC3-5",
   "mcu": "PF7",
   "pin": 19,
   "note": "ADC3_IN5，150Ω 采样电阻 + ZMM3V3 钳位",
   "page": "board-14"
  }
 ]
};
