/* modules.js — 开发板上的模块：数据（每个脚接到哪里）+ 模拟图（SVG，可点）
   数据按原理图（assets/board-*.svg）整理；接到 MCU 的脚写 mcu（引脚名），接电源 / 地的写 net。
   数据部分不碰 DOM（Node 里测试用）；画图部分要 STM.ui，在页面里才有。 */
(function () {
  'use strict';
  var W = typeof window === 'object' ? window : this;

  /* ---------- 数据 ---------- */
  // pin: { k 唯一键, name 脚名, no 物理脚号, mcu 接到的 MCU 引脚, net 接到的电源网络, note 一句话 }
  function sop(list) { return list.map(function (x, i) { return Object.assign({ k: 'p' + (i + 1), no: i + 1 }, x); }); }

  // FSMC 信号 → 芯片引脚（DS5792 LQFP144）；测试里再对一遍引脚表
  var FS = { A0: 'PF0', A1: 'PF1', A2: 'PF2', A3: 'PF3', A4: 'PF4', A5: 'PF5', A6: 'PF12', A7: 'PF13', A8: 'PF14', A9: 'PF15', A10: 'PG0', A11: 'PG1', A12: 'PG2', A13: 'PG3',
    A14: 'PG4', A15: 'PG5', A16: 'PD11', A17: 'PD12', A18: 'PD13', D0: 'PD14', D1: 'PD15', D2: 'PD0', D3: 'PD1', D4: 'PE7', D5: 'PE8', D6: 'PE9', D7: 'PE10', D8: 'PE11', D9: 'PE12',
    D10: 'PE13', D11: 'PE14', D12: 'PE15', D13: 'PD8', D14: 'PD9', D15: 'PD10', NOE: 'PD4', NWE: 'PD5', NWAIT: 'PD6', NCE2: 'PD7', NE3: 'PG10', NE4: 'PG12', NBL0: 'PE0', NBL1: 'PE1' };
  // [脚号, 脚名, FSMC 信号 或 '=网络', 说明]
  function bus(list) {
    return list.map(function (x) {
      var o = { k: 'p' + x[0], no: x[0], name: x[1] };
      if (x[2] && x[2].charAt(0) === '=') o.net = x[2].slice(1); else if (x[2]) { o.sig = 'FSMC_' + x[2]; o.mcu = FS[x[2]]; }
      if (x[3]) o.note = x[3]; else if (o.sig) o.note = o.sig;
      return o;
    });
  }
  function sramPins() {
    var L = ['A4', 'A3', 'A2', 'A1', 'A0', 'CS', 'IO0', 'IO1', 'IO2', 'IO3', 'VDD', 'GND', 'IO4', 'IO5', 'IO6', 'IO7', 'WE', 'A16', 'A15', 'A14', 'A13', 'A12'];
    var R = ['A17', 'A11', 'A10', 'A9', 'A8', 'A18', 'IO8', 'IO9', 'IO10', 'IO11', 'VDD', 'GND', 'IO12', 'IO13', 'IO14', 'IO15', 'LB', 'UB', 'OE', 'A7', 'A6', 'A5'];
    var SIG = { CS: 'NE3', WE: 'NWE', OE: 'NOE', LB: 'NBL0', UB: 'NBL1' }, NOTE = { CS: '片选，FSMC Bank1 第 3 区：地址 0x6800 0000 起', WE: '写使能', OE: '读使能', LB: '低字节使能', UB: '高字节使能' };
    return bus(L.concat(R).map(function (n, i) {
      var sig = n === 'VDD' ? '=3V3' : n === 'GND' ? '=GND' : SIG[n] || (/^IO/.test(n) ? 'D' + n.slice(2) : n);
      return [i + 1, n, sig, NOTE[n]];
    }));
  }
  var MODULES = [
    { id: 'xtal', tag: '晶振', topic: 'sys', sch: 'board-02', kind: 'xtal',
      pins: [
        { k: 'hi', name: 'HSE IN', short: 'IN', grp: 'HSE', freq: '8MHz', mcu: 'OSC_IN', note: '外部高速晶振 X2，8 MHz，两端各 20pF 到地；经 PLL ×9 得到 72 MHz' },
        { k: 'ho', name: 'HSE OUT', short: 'OUT', grp: 'HSE', freq: '8MHz', mcu: 'OSC_OUT', note: '外部高速晶振 X2 的另一端' },
        { k: 'li', name: 'LSE IN', short: 'IN', grp: 'LSE', freq: '32.768k', mcu: 'PC14', note: '外部低速晶振 X1，32.768 kHz，给 RTC 用；两端各 12pF' },
        { k: 'lo', name: 'LSE OUT', short: 'OUT', grp: 'LSE', freq: '32.768k', mcu: 'PC15', note: '外部低速晶振 X1 的另一端' }
      ] },
    { id: 'boot', tag: 'BOOT', topic: 'sys', sch: 'board-02', kind: 'header', label: 'H7',
      pins: [
        { k: 'p1', no: 1, name: '3V3', net: '3V3' },
        { k: 'p2', no: 2, name: 'BOOT0', mcu: 'BOOT0', note: '平时 10kΩ 下拉 = 0：从 Flash 启动。跳线帽短接 1-2 → BOOT0 = 1：从系统存储器启动（串口下载）' },
        { k: 'p3', no: 3, name: '3V3', net: '3V3' },
        { k: 'p4', no: 4, name: 'BOOT1', mcu: 'PB2', note: '经 10kΩ 接 PB2。短接 3-4 → BOOT1 = 1' },
        { k: 'p5', no: 5, name: 'GND', net: 'GND' },
        { k: 'p6', no: 6, name: 'BOOT1', mcu: 'PB2', note: '经 10kΩ 接 PB2。短接 5-6 → BOOT1 = 0' }
      ] },
    { id: 'usb', tag: 'USB', sch: 'board-01', kind: 'usbc', part: 'Type-C',
      pins: [
        { k: 'vbus', name: 'VBUS', net: '5V', note: 'USB 口取电，给板子供 5V' },
        { k: 'dm', name: 'D−', mcu: 'PA11', note: 'USB D−，经 22Ω 接 PA11（MCU 自带的 USB，没有 USB 转串口芯片）' },
        { k: 'dp', name: 'D+', mcu: 'PA12', note: 'USB D+，经 22Ω 接 PA12；10kΩ 上拉到 3V3' },
        { k: 'cc', name: 'CC', net: 'GND', note: 'CC1 / CC2 经 10kΩ 接地：告诉电脑这是一个设备' },
        { k: 'gnd', name: 'GND', net: 'GND' }
      ] },
    { id: 'led', tag: 'LED', topic: 'gpio', sch: 'board-08', kind: 'leds',
      pins: [
        { k: 'led1', name: 'LED1', color: 'y', mcu: 'PA0', note: '黄灯，3V3 → 2kΩ → LED → PA0，输出 0 亮' },
        { k: 'led2', name: 'LED2', color: 'b', mcu: 'PA1', note: '蓝灯，输出 0 亮' },
        { k: 'led3', name: 'LED3', color: 'g', mcu: 'PA8', note: '绿灯，输出 0 亮' },
        { k: 'led5', name: 'LED5', color: 'rgb', mcu: 'PG11', part: 'WS2812', note: 'WS2812 全彩灯，单线串行数据，5V 供电' },
        { k: 'pwr', name: 'PWR', color: 'r', net: '3V3', note: '电源指示灯，上电常亮，不受 MCU 控制' }
      ] },
    { id: 'key', tag: '按键', topic: 'gpio', sch: 'board-08', kind: 'keys',
      pins: [
        { k: 'key1', name: 'KEY1', mcu: 'PF8', note: '按下接 GND，没有外部上拉 → 配上拉输入' },
        { k: 'key2', name: 'KEY2', mcu: 'PF9', note: '按下接 GND，没有外部上拉 → 配上拉输入' },
        { k: 'key3', name: 'KEY3', mcu: 'PF10', note: '按下接 3V3，没有外部下拉 → 配下拉输入' },
        { k: 'key4', name: 'KEY4', mcu: 'PF11', note: '按下接 3V3，没有外部下拉 → 配下拉输入' },
        { k: 'rst', name: 'RESET', mcu: 'NRST', note: '按下拉低 NRST，芯片复位；10kΩ 上拉 + 100nF' }
      ] },
    { id: 'beep', tag: '蜂鸣器', topic: 'gpio', sch: 'board-08', kind: 'beep', part: 'AO3400A',
      pins: [
        { k: 'g', name: 'G', mcu: 'PB1', note: 'MOS 管栅极：PB1 经 1kΩ 接到这里，10kΩ 下拉。PB1 输出 1 → 管子导通 → 蜂鸣器响' },
        { k: 'd', name: 'D', note: 'MOS 管漏极，接蜂鸣器负极' },
        { k: 's', name: 'S', net: 'GND', note: 'MOS 管源极，接地' },
        { k: 'bp', name: '+', net: '5V', note: '蜂鸣器正极，接 5V（并联续流二极管 D4）' },
        { k: 'bn', name: '−', note: '蜂鸣器负极，接 MOS 管漏极' }
      ] },
    { id: 'ma420', tag: '4-20mA', topic: 'adc', sch: 'board-14', kind: 'legs', look: 'term', part: 'P4',
      pins: [
        { k: 'p1', no: 1, name: 'IN1', mcu: 'PF6', note: '电流经 150Ω 采样电阻变成电压：4 mA → 0.6 V，20 mA → 3.0 V；ZMM3V3 稳压管钳位。ADC3 通道 4' },
        { k: 'p2', no: 2, name: 'VIN', net: 'VIN', note: '给变送器供电' },
        { k: 'p3', no: 3, name: 'IN2', mcu: 'PF7', note: '同 IN1，ADC3 通道 5' }
      ] },
    { id: 'ds18b20', tag: 'DS18B20', topic: 'gpio', sch: 'board-08', kind: 'legs', look: 'to92', part: 'H9',
      pins: [
        { k: 'p1', no: 1, name: 'GND', net: 'GND' },
        { k: 'p2', no: 2, name: 'DQ', mcu: 'PC3', note: '单总线数据，10kΩ 上拉到 3V3；插座 H9，DS18B20 平面朝自己插' },
        { k: 'p3', no: 3, name: 'VDD', net: '3V3' }
      ] },
    { id: 'eeprom', tag: 'M24C02', topic: 'i2c', sch: 'board-04', kind: 'dual', part: 'M24C02-WMN6TP', mark: '24C02', bus: 'I2C2',
      pins: sop([
        { name: 'E0', net: 'GND', note: '地址位，接地（原理图上标作 E1）' },
        { name: 'E1', net: 'GND', note: '地址位，接地（原理图上标作 E2）' },
        { name: 'E2', net: 'GND', note: '地址位，接地（原理图上标作 E3）；三个都接地 → 地址 0xA0' },
        { name: 'VSS', net: 'GND' },
        { name: 'SDA', mcu: 'PB11', note: '数据线，10kΩ 上拉到 3V3' },
        { name: 'SCL', mcu: 'PB10', note: '时钟线，10kΩ 上拉到 3V3' },
        { name: 'WC', net: 'GND', note: '写保护，接地 = 允许写' },
        { name: 'VCC', net: '3V3', note: '旁边 100nF 去耦电容' }
      ]) },
    { id: 'flash', tag: 'W25Q32', topic: 'spi', sch: 'board-05', kind: 'dual', part: 'W25Q32JVSSIQ', mark: '25Q32', bus: 'SPI1',
      pins: sop([
        { name: 'CS', mcu: 'PC13', note: '片选，低电平选中' },
        { name: 'DO', mcu: 'PA6', note: 'Flash 输出 → MCU 的 MISO；SPI1 和 LoRa 共用' },
        { name: 'WP', net: '3V3', note: '写保护，接 3V3 = 不保护' },
        { name: 'GND', net: 'GND' },
        { name: 'DI', mcu: 'PA7', note: 'MCU 的 MOSI → Flash 输入；SPI1 和 LoRa 共用' },
        { name: 'CLK', mcu: 'PA5', note: 'SPI1 时钟；和 LoRa 共用' },
        { name: 'HOLD', net: '3V3', note: '接 3V3 = 不暂停' },
        { name: 'VCC', net: '3V3', note: '旁边 100nF 去耦电容' }
      ]) },
    { id: 'pot', tag: '电位器', topic: 'adc', sch: 'board-14', kind: 'legs', look: 'pot', part: '100kΩ',
      pins: [
        { k: 'p1', no: 1, name: '1', net: '3V3', note: '一端接 3V3' },
        { k: 'p2', no: 2, name: '2', mcu: 'PC0', note: '滑动端，经 0Ω 电阻到 PC0（ADC 通道 10），0 ~ 3.3 V' },
        { k: 'p3', no: 3, name: '3', net: 'GND', note: '另一端接地' }
      ] },
    { id: 'stlink', tag: 'ST-Link', topic: 'usart', sch: 'board-02', kind: 'header', label: 'CN1',
      pins: [
        { k: 'p1', no: 1, name: 'NC', net: 'NC' },
        { k: 'p2', no: 2, name: 'NRST', mcu: 'NRST' },
        { k: 'p3', no: 3, name: 'SWDIO', mcu: 'PA13', note: '下载调试：数据' },
        { k: 'p4', no: 4, name: 'RX', mcu: 'PA10', note: 'USART1 RX：电脑 → 板子（STLink 虚拟串口）' },
        { k: 'p5', no: 5, name: 'SWCLK', mcu: 'PA14', note: '下载调试：时钟' },
        { k: 'p6', no: 6, name: 'TX', mcu: 'PA9', note: 'USART1 TX：板子 → 电脑（STLink 虚拟串口）；跳线 H11 可切到 RS485 / RS232' },
        { k: 'p7', no: 7, name: 'GND', net: 'GND' },
        { k: 'p8', no: 8, name: '5V', net: '5V' }
      ] },
    { id: 'sd', tag: 'SD 卡', sch: 'board-07', kind: 'sd', part: 'microSD',
      pins: [
        { k: 'p1', no: 1, name: 'DAT2', mcu: 'PC10', note: 'SDIO_D2，10kΩ 上拉' },
        { k: 'p2', no: 2, name: 'DAT3', mcu: 'PC11', note: 'SDIO_D3，10kΩ 上拉' },
        { k: 'p3', no: 3, name: 'CMD', mcu: 'PD2', note: 'SDIO_CMD，10kΩ 上拉' },
        { k: 'p4', no: 4, name: 'VDD', net: '3V3' },
        { k: 'p5', no: 5, name: 'CLK', mcu: 'PC12', note: 'SDIO_CK' },
        { k: 'p6', no: 6, name: 'VSS', net: 'GND' },
        { k: 'p7', no: 7, name: 'DAT0', mcu: 'PC8', note: 'SDIO_D0，10kΩ 上拉' },
        { k: 'p8', no: 8, name: 'DAT1', mcu: 'PC9', note: 'SDIO_D1，10kΩ 上拉' },
        { k: 'cd', name: 'CD', mcu: 'PG8', note: '卡座的检测开关：有没有插卡' }
      ] },
    { id: 'sram', tag: 'SRAM', topic: 'fsmc', sch: 'board-03', kind: 'dual', n: 44, part: 'IS62WV51216BLL-55TLI', mark: '62WV51216', bus: 'FSMC',
      pins: sramPins() },
    { id: 'nand', tag: 'NAND', topic: 'fsmc', sch: 'board-06', kind: 'dual', n: 48, part: 'W29N01HVSINA', mark: 'W29N01HV', bus: 'FSMC',
      pins: bus([[7, 'R/B', 'NWAIT', '忙 / 就绪，接 FSMC_NWAIT'], [8, 'RE', 'NOE', '读使能'], [9, 'CE', 'NCE2', '片选，FSMC Bank2（NAND）'], [12, 'VCC', '=3V3'], [13, 'VSS', '=GND'],
        [16, 'CLE', 'A16', '命令锁存：接 FSMC_A16，往 0x7001 0000 写就是写命令'], [17, 'ALE', 'A17', '地址锁存：接 FSMC_A17，往 0x7002 0000 写就是写地址'], [18, 'WE', 'NWE', '写使能'],
        [19, 'WP', '=3V3', '写保护，10kΩ 上拉 = 允许写'], [29, 'IO0', 'D0'], [30, 'IO1', 'D1'], [31, 'IO2', 'D2'], [32, 'IO3', 'D3'], [36, 'VSS', '=GND'], [37, 'VCC', '=3V3'],
        [41, 'IO4', 'D4'], [42, 'IO5', 'D5'], [43, 'IO6', 'D6'], [44, 'IO7', 'D7']]) },
    { id: 'lcd', tag: 'LCD', topic: 'fsmc', sch: 'board-15', kind: 'header', label: 'TFT-LCD', screen: true,
      pins: (function () {
        // U13 2×14 排母：奇数脚在左，偶数脚在右
        var L = [['GND', null, 'GND'], ['GND', null, 'GND'], ['T_SDA', 'PB7', null, '触摸芯片 I2C1 数据'], ['T_SCL', 'PB6', null, '触摸芯片 I2C1 时钟'], ['T_INT', 'PC1', null, '触摸中断'],
          ['BL', 'PB0', null, '背光'], ['RST', 'PG15', null, '屏复位'], ['CS', 'PG12', null, 'FSMC_NE4：Bank1 第 4 区，地址 0x6C00 0000 起'], ['RS', 'PG0', null, 'FSMC_A10：0 = 命令，1 = 数据'],
          ['WR', 'PD5', null, 'FSMC_NWE 写'], ['RD', 'PD4', null, 'FSMC_NOE 读'], ['D15', 'PD10'], ['D14', 'PD9'], ['D13', 'PD8']];
        var R = [['3V3', null, '3V3'], ['D0', 'PD14'], ['D1', 'PD15'], ['D2', 'PD0'], ['D3', 'PD1'], ['D4', 'PE7'], ['D5', 'PE8'], ['D6', 'PE9'],
          ['D7', 'PE10'], ['D8', 'PE11'], ['D9', 'PE12'], ['D10', 'PE13'], ['D11', 'PE14'], ['D12', 'PE15']];
        var out = [];
        for (var i = 0; i < 14; i++) [L[i], R[i]].forEach(function (x, j) {
          var no = i * 2 + 1 + j, o = { k: 'p' + no, no: no, name: x[0] };
          if (x[1]) o.mcu = x[1]; if (x[2]) o.net = x[2];
          o.note = x[3] || (/^D\d+$/.test(x[0]) ? 'FSMC 数据线 ' + x[0] : '');
          out.push(o);
        });
        return out;
      })() },
    { id: 'rs232', tag: 'RS232', topic: 'usart', sch: 'board-10', kind: 'dual', n: 16, part: 'SP3232EEN', mark: 'SP3232', bus: 'RS232',
      pins: [
        { k: 'p1', no: 1, name: 'C1+', note: '电荷泵电容 100nF，片内产生 ±5.5 V' }, { k: 'p2', no: 2, name: 'V+', note: '电荷泵输出，100nF 到地' }, { k: 'p3', no: 3, name: 'C1−' },
        { k: 'p4', no: 4, name: 'C2+' }, { k: 'p5', no: 5, name: 'C2−' }, { k: 'p6', no: 6, name: 'V−', note: '电荷泵输出，100nF 到地' },
        { k: 'p11', no: 11, name: 'T1IN', mcu: 'PA9', note: '跳线 H11 短接 4-6 → 接 USART1 TX' },
        { k: 'p12', no: 12, name: 'R1OUT', mcu: 'PA10', note: '跳线 H11 短接 3-5 → 接 USART1 RX' },
        { k: 'p13', no: 13, name: 'R1IN', net: 'DB9', note: '来自 DB9 接口的 RS232 电平（±3~15 V）' },
        { k: 'p14', no: 14, name: 'T1OUT', net: 'DB9', note: '发到 DB9 接口' },
        { k: 'p15', no: 15, name: 'GND', net: 'GND' }, { k: 'p16', no: 16, name: 'VCC', net: '5V' }
      ] },
    { id: 'rs485', tag: 'RS485', topic: 'usart', sch: 'board-10', kind: 'dual', part: 'SSP485N', mark: 'SSP485', bus: 'RS485',
      pins: sop([
        { name: 'RO', mcu: 'PA10', note: '收到的数据；跳线 H11 短接 1-3 → 接 USART1 RX' },
        { name: 'RE', mcu: 'PE3', note: '接收使能（低有效），和 DE 连在一起接 PE3：PE3 = 0 收，= 1 发' },
        { name: 'DE', mcu: 'PE3', note: '发送使能（高有效），和 RE 连在一起' },
        { name: 'DI', mcu: 'PA9', note: '要发的数据；跳线 H11 短接 2-4 → 接 USART1 TX' },
        { name: 'GND', net: 'GND' },
        { name: 'A', net: 'P1-3', note: '485A，4.7kΩ 偏置；接线端子 P1 第 3 脚' },
        { name: 'B', net: 'P1-2', note: '485B，4.7kΩ 偏置；接线端子 P1 第 2 脚；跳线 H10 接 120Ω 终端电阻' },
        { name: 'VCC', net: '5V' }
      ]) },
    { id: 'can', tag: 'CAN', sch: 'board-11', kind: 'dual', part: 'PD1050S', mark: 'PD1050', bus: 'CAN',
      pins: sop([
        { name: 'TXD', mcu: 'PB9', note: 'CAN_TX：PB9 要开 CAN 重映射（AFIO CAN_REMAP = 10）' },
        { name: 'GND', net: 'GND' },
        { name: 'VCC', net: '5V' },
        { name: 'RXD', mcu: 'PB8', note: 'CAN_RX：PB8，同样要重映射' },
        { name: 'VREF', net: 'NC' },
        { name: 'CANL', net: 'P3-3', note: '接线端子 P3 第 3 脚；跳线 H12 接 120Ω 终端电阻' },
        { name: 'CANH', net: 'P3-2', note: '接线端子 P3 第 2 脚' },
        { name: 'S', net: 'NC', note: '静默模式脚，悬空 = 正常收发' }
      ]) },
    { id: 'w5500', tag: 'W5500', topic: 'spi', sch: 'board-09', kind: 'qfp', n: 48, part: 'W5500', mark: 'W5500', bus: 'SPI2',
      pins: [
        { k: 'p1', no: 1, name: 'TXN', net: 'RJ45' }, { k: 'p2', no: 2, name: 'TXP', net: 'RJ45', note: '经网络变压器到 RJ45 网口（HR911105A）' },
        { k: 'p5', no: 5, name: 'RXN', net: 'RJ45' }, { k: 'p6', no: 6, name: 'RXP', net: 'RJ45' },
        { k: 'p30', no: 30, name: 'XI', net: '25MHz', note: '25 MHz 晶振 X3' }, { k: 'p31', no: 31, name: 'XO', net: '25MHz' },
        { k: 'p32', no: 32, name: 'SCSn', mcu: 'PD3', note: 'SPI 片选，低电平选中' },
        { k: 'p33', no: 33, name: 'SCLK', mcu: 'PB13', note: 'SPI2_SCK' },
        { k: 'p34', no: 34, name: 'MISO', mcu: 'PB14', note: 'SPI2_MISO' },
        { k: 'p35', no: 35, name: 'MOSI', mcu: 'PB15', note: 'SPI2_MOSI' },
        { k: 'p36', no: 36, name: 'INTn', mcu: 'PG6', note: '中断输出，低有效' },
        { k: 'p37', no: 37, name: 'RSTn', mcu: 'PG7', note: '复位，低有效' }
      ] },
    { id: 'esp32', tag: 'ESP32-C3', topic: 'usart', sch: 'board-12', kind: 'qfp', n: 32, qfn: true, part: 'ESP32-C3FN4', mark: 'ESP32-C3', bus: 'WiFi / BLE',
      pins: [
        { k: 'p1', no: 1, name: 'LNA_IN', net: '天线', note: '射频，经匹配电路到板载天线' },
        { k: 'p7', no: 7, name: 'CHIP_EN', mcu: 'PE4', note: '使能，10kΩ 上拉；PE4 拉低可以让 ESP32 复位' },
        { k: 'p12', no: 12, name: 'GPIO6', mcu: 'PA2', note: 'ESP32 的 UART1 RX ← STM32 的 USART2 TX（PA2）' },
        { k: 'p13', no: 13, name: 'GPIO7', mcu: 'PA3', note: 'ESP32 的 UART1 TX → STM32 的 USART2 RX（PA3）' },
        { k: 'p15', no: 15, name: 'GPIO9', net: 'LED12', note: '接 LED12（3kΩ 到 3V3）；也是启动模式选择脚' },
        { k: 'p25', no: 25, name: 'GPIO18', net: 'USB2', note: 'USB D−，接第二个 Type-C 口 USB2' },
        { k: 'p26', no: 26, name: 'GPIO19', net: 'USB2', note: 'USB D+' },
        { k: 'p29', no: 29, name: 'XTAL_N', net: '40MHz' }, { k: 'p30', no: 30, name: 'XTAL_P', net: '40MHz', note: '晶振 X4' }
      ] },
    { id: 'lora', tag: 'LoRa', topic: 'spi', sch: 'board-13', kind: 'dual', n: 22, look: 'shield', part: 'E220-400M22S', mark: 'E220', bus: 'LoRa',
      pins: [
        { k: 'p6', no: 6, name: 'RXEN', mcu: 'PE5', note: '射频开关：接收时置 1' },
        { k: 'p7', no: 7, name: 'TXEN', mcu: 'PE6', note: '射频开关：发送时置 1' },
        { k: 'p9', no: 9, name: 'VCC', net: '3V3' },
        { k: 'p14', no: 14, name: 'BUSY', mcu: 'PE2', note: '忙标志：为 1 时先别发命令' },
        { k: 'p15', no: 15, name: 'RST', mcu: 'PG13', note: '复位，低有效' },
        { k: 'p16', no: 16, name: 'MISO', mcu: 'PA6', note: '和 W25Q32 共用 SPI1，靠片选分开' },
        { k: 'p17', no: 17, name: 'MOSI', mcu: 'PA7', note: '和 W25Q32 共用 SPI1' },
        { k: 'p18', no: 18, name: 'SCK', mcu: 'PA5', note: '和 W25Q32 共用 SPI1' },
        { k: 'p19', no: 19, name: 'NSS', mcu: 'PG14', note: 'SPI 片选，低电平选中' },
        { k: 'p21', no: 21, name: 'ANT', net: '天线' }
      ] }
  ];
  MODULES.forEach(function (m) { m.pins.forEach(function (p) { if (!p.note) delete p.note; }); });
  W.STM32_MODULES = MODULES;

  /* ---------- 画图 ---------- */
  var STM = W.STM;
  if (!STM || !STM.ui) return;
  var sv = STM.ui.sv;

  function txt(g, x, y, s, cls, anchor) { var t = sv('text', { x: x, y: y, 'class': cls, 'text-anchor': anchor || 'middle', 'dominant-baseline': 'central' }, s); g.appendChild(t); return t; }
  function conn(p) { var c = p.mcu || p.net || ''; return c === p.name ? '' : c; }
  function connCls(p) { return 'mc ' + (p.mcu ? 'to-mcu' : 'to-net'); }
  // 一个可点的脚：g.mp[data-mp]，带一个透明的点击区
  function mpGroup(p, hit) {
    var g = sv('g', { 'class': 'mp', 'data-mp': p.k, tabindex: '-1', role: 'button', 'aria-label': p.name + (conn(p) ? '，接 ' + conn(p) : '') });
    hit['class'] = 'hit'; g.appendChild(sv('rect', hit));
    return g;
  }

  // 双列封装（SOP / TSOP / 邮票孔模块）：1 ~ n/2 在左边自上而下，其余在右边自下而上
  function dual(m) {
    var n = m.n || 8, half = n / 2, pitch = n > 16 ? 24 : n > 8 ? 30 : 36, lw = Math.max(7, pitch * .3), LD = m.look === 'shield' ? 8 : 16;
    var bw = m.look === 'shield' ? 170 : n > 16 ? 168 : 112, bh = half * pitch + 24, Wd = bw + 2 * (LD + 150), bx = (Wd - bw) / 2, by = 30, H = bh + 2 * by;
    var s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {}, P = {};
    m.pins.forEach(function (p) { P[p.no] = p; });
    var body = sv('g', { 'class': 'mod-body' });
    body.appendChild(sv('rect', { x: bx, y: by, width: bw, height: bh, rx: m.look === 'shield' ? 4 : 6, 'class': m.look === 'shield' ? 'shield' : 'pkg' }));
    if (m.look === 'shield') body.appendChild(sv('rect', { x: bx + 12, y: by + 12, width: bw - 24, height: bh - 24, rx: 3, 'class': 'shield-in' }));
    body.appendChild(sv('circle', { cx: bx + 16, cy: by + 16, r: 5, 'class': 'dot' }));
    txt(body, bx + bw / 2, by + bh / 2 - 9, m.mark || m.tag, 'mark');
    txt(body, bx + bw / 2, by + bh / 2 + 13, m.bus || '', 'mark2');
    s.appendChild(body);
    function y(no) { var left = no <= half, k = left ? no - 1 : n - no; return by + 12 + k * pitch + pitch / 2; }
    for (var no = 1; no <= n; no++) {
      var left = no <= half, cy = y(no), p = P[no];
      var g = p ? mpGroup(p, left ? { x: 0, y: cy - pitch / 2, width: bx + 14, height: pitch } : { x: bx + bw - 14, y: cy - pitch / 2, width: Wd - bx - bw + 14, height: pitch }) : sv('g', { 'class': 'nc' });
      g.appendChild(sv('rect', { x: left ? bx - LD : bx + bw, y: cy - lw / 2, width: LD, height: lw, rx: 1.5, 'class': 'ld' }));
      txt(g, left ? bx + 10 : bx + bw - 10, cy, no, 'no', left ? 'start' : 'end');
      if (p) {
        txt(g, left ? bx - LD - 8 : bx + bw + LD + 8, cy, p.name, 'nm', left ? 'end' : 'start');
        txt(g, left ? bx - LD - 74 : bx + bw + LD + 74, cy, conn(p), connCls(p), left ? 'end' : 'start');
        pos[p.k] = { x: left ? bx - LD : bx + bw + LD, y: cy };
      }
      s.appendChild(g);
    }
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // 四边扁平封装（QFP / QFN）：1 脚在左上，逆时针；只给用到的脚写名字
  function qfp(m) {
    var n = m.n, k = n / 4, pitch = 20, LD = m.qfn ? 7 : 14, side = k * pitch + 28, M = LD + 136;
    var Wd = side + 2 * M, H = Wd, bx = M, by = M, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {}, P = {};
    m.pins.forEach(function (p) { P[p.no] = p; });
    var body = sv('g', { 'class': 'mod-body' });
    body.appendChild(sv('rect', { x: bx, y: by, width: side, height: side, rx: m.qfn ? 8 : 5, 'class': 'pkg' }));
    if (!m.qfn) body.appendChild(sv('rect', { x: bx + 8, y: by + 8, width: side - 16, height: side - 16, rx: 3, 'class': 'bevel' }));
    body.appendChild(sv('circle', { cx: bx + 20, cy: by + 20, r: 5, 'class': 'dot' }));
    txt(body, bx + side / 2, by + side / 2 - 9, m.mark, 'mark');
    txt(body, bx + side / 2, by + side / 2 + 13, m.bus || '', 'mark2');
    s.appendChild(body);
    for (var no = 1; no <= n; no++) {
      var sd = no <= k ? 'L' : no <= 2 * k ? 'B' : no <= 3 * k ? 'R' : 'T', j = (no - 1) % k, off = 14 + j * pitch + pitch / 2, cx, cy, lead, nm, mc, hit, p = P[no];
      var w = 7, q = m.qfn ? 3 : 0;   // QFN 的焊盘一半在封装下面
      if (sd === 'L') { cx = bx; cy = by + off; lead = { x: bx - LD + q, y: cy - w / 2, width: LD, height: w }; nm = [bx - LD - 6, cy, 'end', 0]; mc = [bx - LD - 70, cy, 'end', 0]; hit = { x: 0, y: cy - pitch / 2, width: bx + 6, height: pitch }; }
      else if (sd === 'B') { cx = bx + off; cy = by + side; lead = { x: cx - w / 2, y: cy - q, width: w, height: LD }; nm = [cx, cy + LD + 6, 'end', 1]; mc = [cx, cy + LD + 70, 'end', 1]; hit = { x: cx - pitch / 2, y: cy - 6, width: pitch, height: M + 6 }; }
      else if (sd === 'R') { cx = bx + side; cy = by + side - off; lead = { x: cx - q, y: cy - w / 2, width: LD, height: w }; nm = [cx + LD + 6, cy, 'start', 0]; mc = [cx + LD + 70, cy, 'start', 0]; hit = { x: cx - 6, y: cy - pitch / 2, width: M + 6, height: pitch }; }
      else { cx = bx + side - off; cy = by; lead = { x: cx - w / 2, y: cy - LD + q, width: w, height: LD }; nm = [cx, cy - LD - 6, 'start', 1]; mc = [cx, cy - LD - 70, 'start', 1]; hit = { x: cx - pitch / 2, y: 0, width: pitch, height: M + 6 }; }
      var g = p ? mpGroup(p, hit) : sv('g', { 'class': 'nc' });
      lead.rx = 1.5; lead['class'] = 'ld'; g.appendChild(sv('rect', lead));
      if (p) {
        [[nm, p.name, 'nm'], [mc, conn(p), connCls(p)]].forEach(function (x) {
          var t = txt(g, x[0][0], x[0][1], x[1], x[2], x[0][2]);
          if (x[0][3]) t.setAttribute('transform', 'rotate(-90 ' + x[0][0] + ' ' + x[0][1] + ')');
        });
        pos[p.k] = { x: lead.x + lead.width / 2, y: lead.y + lead.height / 2 };
      }
      s.appendChild(g);
    }
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // 2×N 排针 / 排母：奇数脚左列，偶数脚右列，自上而下
  function header(m) {
    var rows = Math.ceil(m.pins.length / 2), pitch = 26, top = m.screen ? 128 : 52, cx = 230, hw = 30;
    var Wd = 460, H = top + rows * pitch + 26, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    var body = sv('g', { 'class': 'mod-body' });
    if (m.screen) {
      body.appendChild(sv('rect', { x: cx - 120, y: 14, width: 240, height: 84, rx: 8, 'class': 'glass' }));
      body.appendChild(sv('rect', { x: cx - 108, y: 24, width: 216, height: 64, rx: 3, 'class': 'glass-in' }));
      txt(body, cx, 56, m.label, 'mark');
      body.appendChild(sv('path', { d: 'M' + (cx - 40) + ' 98V' + (top - 14) + 'M' + (cx + 40) + ' 98V' + (top - 14), 'class': 'fpc' }));
    } else txt(body, cx, 24, m.label || m.tag, 'mark-o');
    body.appendChild(sv('rect', { x: cx - hw, y: top - 12, width: hw * 2, height: rows * pitch + 4, rx: 4, 'class': 'hdr' }));
    s.appendChild(body);
    m.pins.forEach(function (p) {
      var left = p.no % 2 === 1, r = Math.floor((p.no - 1) / 2), cy = top + r * pitch, px = cx + (left ? -13 : 13);
      var g = mpGroup(p, left ? { x: 0, y: cy - pitch / 2, width: cx, height: pitch } : { x: cx, y: cy - pitch / 2, width: Wd - cx, height: pitch });
      g.appendChild(sv('rect', { x: px - 5, y: cy - 5, width: 10, height: 10, rx: p.no === 1 ? 1 : 5, 'class': 'ld pinhd' }));
      txt(g, left ? cx - hw - 10 : cx + hw + 10, cy, p.name, 'nm', left ? 'end' : 'start');
      txt(g, left ? cx - hw - 82 : cx + hw + 82, cy, conn(p), connCls(p), left ? 'end' : 'start');
      txt(g, left ? cx - hw - 160 : cx + hw + 160, cy, p.no, 'no2', left ? 'end' : 'start');
      s.appendChild(g); pos[p.k] = { x: px, y: cy };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // 一排器件（LED / 按键）：每个一格，下面写名字和接的脚
  function row(m, draw) {
    var n = m.pins.length, cw = 92, Wd = n * cw + 20, H = 190, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    m.pins.forEach(function (p, i) {
      var cx = 10 + cw * i + cw / 2, g = mpGroup(p, { x: cx - cw / 2, y: 0, width: cw, height: H });
      draw(g, p, cx, 70);
      txt(g, cx, 138, p.name, 'nm');
      txt(g, cx, 162, conn(p), connCls(p));
      s.appendChild(g); pos[p.k] = { x: cx, y: 70 };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }
  function ledPart(g, p, cx, cy) {
    g.appendChild(sv('rect', { x: cx - 24, y: cy - 9, width: 10, height: 18, rx: 2, 'class': 'ld' }));
    g.appendChild(sv('rect', { x: cx + 14, y: cy - 9, width: 10, height: 18, rx: 2, 'class': 'ld' }));
    if (p.color === 'rgb') {
      g.appendChild(sv('rect', { x: cx - 20, y: cy - 20, width: 40, height: 40, rx: 4, 'class': 'ledbody' }));
      g.appendChild(sv('circle', { cx: cx, cy: cy, r: 14, 'class': 'lens lens-rgb' }));
      [['r', -6, -4], ['g', 6, -4], ['b', 0, 6]].forEach(function (d) { g.appendChild(sv('circle', { cx: cx + d[1], cy: cy + d[2], r: 4, 'class': 'lens rgb-' + d[0] })); });
    } else {
      g.appendChild(sv('rect', { x: cx - 16, y: cy - 12, width: 32, height: 24, rx: 3, 'class': 'ledbody' }));
      g.appendChild(sv('rect', { x: cx - 10, y: cy - 8, width: 20, height: 16, rx: 3, 'class': 'lens lens-' + p.color }));
    }
  }
  function keyPart(g, p, cx, cy) {
    [[-26, -22], [26, -22], [-26, 22], [26, 22]].forEach(function (d) { g.appendChild(sv('rect', { x: cx + d[0] - (d[0] < 0 ? 8 : 0), y: cy + d[1] - 3, width: 8, height: 6, rx: 1, 'class': 'ld' })); });
    g.appendChild(sv('rect', { x: cx - 26, y: cy - 26, width: 52, height: 52, rx: 4, 'class': 'keybody' }));
    g.appendChild(sv('circle', { cx: cx, cy: cy, r: 15, 'class': 'keycap' + (p.k === 'rst' ? ' rst' : '') }));
  }

  function beep(m) {
    var Wd = 470, H = 260, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {}, P = {};
    m.pins.forEach(function (p) { P[p.k] = p; });
    var bx = 130, by = 96, mx = 320, my = 186;
    var body = sv('g', { 'class': 'mod-body' });
    // 走线：蜂鸣器负极 → MOS 管 D
    body.appendChild(sv('path', { d: 'M' + (bx + 22) + ' ' + (by + 82) + 'V' + my + 'H' + (mx - 32), 'class': 'trace' }));
    body.appendChild(sv('circle', { cx: bx, cy: by, r: 62, 'class': 'pkg' }));
    body.appendChild(sv('circle', { cx: bx, cy: by, r: 46, 'class': 'ring' }));
    body.appendChild(sv('circle', { cx: bx, cy: by, r: 7, 'class': 'hole' }));
    txt(body, bx - 34, by - 30, '+', 'mark');
    body.appendChild(sv('rect', { x: mx - 18, y: my - 24, width: 36, height: 48, rx: 3, 'class': 'pkg' }));
    txt(body, mx, my, 'Q', 'mark2');
    txt(body, mx, my - 40, m.part, 'mark-o');
    s.appendChild(body);
    function leg(p, rect, lx, ly, anchor, hit, cx2, horiz) {
      var g = mpGroup(p, hit);
      rect.rx = 2; rect['class'] = 'ld'; g.appendChild(sv('rect', rect));
      txt(g, lx, ly, p.name, 'nm', anchor);
      if (conn(p)) txt(g, horiz ? lx + 26 : lx, horiz ? ly : ly + 22, conn(p), connCls(p), anchor);
      s.appendChild(g); pos[p.k] = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    leg(P.bp, { x: bx - 26, y: by + 58, width: 8, height: 24 }, bx - 22, by + 104, 'middle', { x: bx - 60, y: by + 40, width: 60, height: 110 });
    leg(P.bn, { x: bx + 18, y: by + 58, width: 8, height: 24 }, bx + 22, by + 104, 'middle', { x: bx, y: by + 40, width: 60, height: 110 });
    leg(P.d, { x: mx - 32, y: my - 4, width: 14, height: 8 }, mx - 26, my - 20, 'middle', { x: mx - 60, y: my - 40, width: 42, height: 70 });
    leg(P.g, { x: mx + 18, y: my - 16, width: 14, height: 8 }, mx + 42, my - 12, 'start', { x: mx + 18, y: my - 34, width: Wd - mx - 18, height: 34 }, 0, true);
    leg(P.s, { x: mx + 18, y: my + 8, width: 14, height: 8 }, mx + 42, my + 12, 'start', { x: mx + 18, y: my, width: Wd - mx - 18, height: 34 }, 0, true);
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // 三条腿的器件：电位器 / TO-92（DS18B20）/ 接线端子
  function legs(m) {
    var Wd = 360, H = 270, cx = 180, cy = 96, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {}, sp = m.look === 'term' ? 54 : 40;
    var body = sv('g', { 'class': 'mod-body' });
    if (m.look === 'pot') {
      body.appendChild(sv('rect', { x: cx - 48, y: cy - 48, width: 96, height: 96, rx: 8, 'class': 'potbody' }));
      body.appendChild(sv('circle', { cx: cx, cy: cy, r: 32, 'class': 'rotor' }));
      body.appendChild(sv('path', { d: 'M' + (cx - 18) + ' ' + cy + 'H' + (cx + 18) + 'M' + cx + ' ' + (cy - 18) + 'V' + (cy + 18), 'class': 'slot' }));
    } else if (m.look === 'to92') {
      body.appendChild(sv('path', { d: 'M' + (cx - 44) + ' ' + (cy + 40) + 'V' + (cy - 6) + 'A44 44 0 0 1 ' + (cx + 44) + ' ' + (cy - 6) + 'V' + (cy + 40) + 'Z', 'class': 'pkg' }));
      txt(body, cx, cy + 6, m.tag, 'mark2');
    } else {
      body.appendChild(sv('rect', { x: cx - 88, y: cy - 44, width: 176, height: 88, rx: 6, 'class': 'termbody' }));
      for (var i = 0; i < 3; i++) {
        var x = cx + (i - 1) * sp;
        body.appendChild(sv('circle', { cx: x, cy: cy - 6, r: 17, 'class': 'screw' }));
        body.appendChild(sv('path', { d: 'M' + (x - 10) + ' ' + (cy - 6) + 'H' + (x + 10), 'class': 'slot' }));
        body.appendChild(sv('rect', { x: x - 13, y: cy + 18, width: 26, height: 16, rx: 3, 'class': 'termhole' }));
      }
    }
    txt(body, cx, cy - 66, m.part, 'mark-o');
    s.appendChild(body);
    m.pins.forEach(function (p, i) {
      var x = cx + (i - 1) * sp, g = mpGroup(p, { x: x - sp / 2, y: cy + 40, width: sp, height: H - cy - 40 });
      g.appendChild(sv('rect', { x: x - 4, y: cy + (m.look === 'term' ? 44 : 40), width: 8, height: 44, rx: 2, 'class': 'ld' }));
      txt(g, x, cy + 108, p.name, 'nm');
      txt(g, x, cy + 132, conn(p), connCls(p));
      s.appendChild(g); pos[p.k] = { x: x, y: cy + 84 };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // 晶振：HSE、LSE 两颗，每颗两只脚
  function xtal(m) {
    var Wd = 500, H = 250, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    ['HSE', 'LSE'].forEach(function (grp, i) {
      var cx = 130 + i * 240, cy = 86, ps = m.pins.filter(function (p) { return p.grp === grp; });
      var body = sv('g', { 'class': 'mod-body' });
      txt(body, cx, 26, grp, 'mark-o');
      body.appendChild(sv('rect', { x: cx - 70, y: cy - 26, width: 140, height: 52, rx: 26, 'class': 'can' }));
      body.appendChild(sv('rect', { x: cx - 60, y: cy - 18, width: 120, height: 36, rx: 18, 'class': 'can-in' }));
      txt(body, cx, cy, ps[0].freq, 'mark3');
      s.appendChild(body);
      ps.forEach(function (p, j) {
        var x = cx + (j ? 36 : -36), g = mpGroup(p, { x: x - 40, y: cy + 26, width: 80, height: H - cy - 26 });
        g.appendChild(sv('rect', { x: x - 4, y: cy + 26, width: 8, height: 44, rx: 2, 'class': 'ld' }));
        txt(g, x, cy + 92, p.short, 'nm');
        txt(g, x, cy + 116, conn(p), connCls(p));
        s.appendChild(g); pos[p.k] = { x: x, y: cy + 70 };
      });
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // Type-C 插座：上面画口，下面一排触点
  function usbc(m) {
    var n = m.pins.length, cw = 84, Wd = n * cw + 40, H = 260, cx = Wd / 2, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    var body = sv('g', { 'class': 'mod-body' });
    body.appendChild(sv('rect', { x: cx - 110, y: 24, width: 220, height: 70, rx: 35, 'class': 'can' }));
    body.appendChild(sv('rect', { x: cx - 92, y: 38, width: 184, height: 42, rx: 21, 'class': 'usb-hole' }));
    body.appendChild(sv('rect', { x: cx - 64, y: 52, width: 128, height: 14, rx: 4, 'class': 'usb-tongue' }));
    s.appendChild(body);
    m.pins.forEach(function (p, i) {
      var x = 20 + cw * i + cw / 2, g = mpGroup(p, { x: x - cw / 2, y: 100, width: cw, height: H - 100 });
      g.appendChild(sv('path', { d: 'M' + cx + ' 94L' + x + ' 128', 'class': 'trace thin' }));
      g.appendChild(sv('rect', { x: x - 10, y: 128, width: 20, height: 30, rx: 3, 'class': 'ld pinhd' }));
      txt(g, x, 182, p.name, 'nm');
      txt(g, x, 206, conn(p), connCls(p));
      s.appendChild(g); pos[p.k] = { x: x, y: 143 };
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  // microSD 卡座：卡的轮廓 + 8 个金手指，旁边是检测开关
  function sd(m) {
    var cw = 52, Wd = 9 * cw + 120, H = 320, x0 = 40, s = sv('svg', { viewBox: '0 0 ' + Wd + ' ' + H }), pos = {};
    var body = sv('g', { 'class': 'mod-body' });
    var cardW = 8 * cw + 24, cy0 = 30, ch = 150;
    body.appendChild(sv('path', { d: 'M' + x0 + ' ' + cy0 + 'H' + (x0 + cardW) + 'V' + (cy0 + ch) + 'H' + (x0 + 60) + 'L' + x0 + ' ' + (cy0 + ch - 40) + 'Z', 'class': 'sdcard' }));
    txt(body, x0 + cardW / 2, cy0 + 116, 'microSD', 'mark3');
    s.appendChild(body);
    m.pins.forEach(function (p, i) {
      var g, x;
      if (p.k === 'cd') {
        x = x0 + cardW + 58; g = mpGroup(p, { x: x - 40, y: 20, width: 80, height: H - 20 });
        g.appendChild(sv('rect', { x: x - 16, y: cy0 + 20, width: 32, height: 70, rx: 4, 'class': 'keybody' }));
        g.appendChild(sv('path', { d: 'M' + (x - 8) + ' ' + (cy0 + 80) + 'L' + (x + 8) + ' ' + (cy0 + 34), 'class': 'slot thin' }));
        txt(g, x, 236, p.name, 'nm'); txt(g, x, 262, conn(p), connCls(p));
        pos[p.k] = { x: x, y: cy0 + 55 };
      } else {
        x = x0 + 12 + i * cw + cw / 2; g = mpGroup(p, { x: x - cw / 2, y: 20, width: cw, height: H - 20 });
        g.appendChild(sv('rect', { x: x - 14, y: cy0 + 14, width: 28, height: 62, rx: 4, 'class': 'ld pinhd' }));
        txt(g, x, cy0 + 94, p.no, 'no2');
        var t1 = txt(g, x, 214, p.name, 'nm', 'end'); t1.setAttribute('transform', 'rotate(-90 ' + x + ' 214)');
        var t2 = txt(g, x, 226, conn(p), connCls(p), 'start'); t2.setAttribute('transform', 'rotate(-90 ' + x + ' 300)');
        t2.setAttribute('y', 300); t2.setAttribute('text-anchor', 'start');
        pos[p.k] = { x: x, y: cy0 + 45 };
      }
      s.appendChild(g);
    });
    return { svg: s, w: Wd, h: H, pos: pos };
  }

  var DRAW = { dual: dual, qfp: qfp, header: header, beep: beep, legs: legs, xtal: xtal, usbc: usbc, sd: sd,
    leds: function (m) { return row(m, ledPart); }, keys: function (m) { return row(m, keyPart); } };

  /* draw(id, {onPick}) → { svg, w, h, pos, select(k) } */
  function draw(id, opt) {
    opt = opt || {};
    var m = byId[id]; if (!m) return null;
    var d = DRAW[m.kind](m), g = {};
    d.svg.setAttribute('class', 'mod mod-' + m.kind);
    d.svg.setAttribute('role', 'group'); d.svg.setAttribute('aria-label', m.tag);
    Array.prototype.forEach.call(d.svg.querySelectorAll('[data-mp]'), function (n) { g[n.getAttribute('data-mp')] = n; });
    var first = m.pins[0] && g[m.pins[0].k]; if (first) first.setAttribute('tabindex', '0');
    d.select = function (k) {
      Object.keys(g).forEach(function (x) { g[x].classList.toggle('sel', x === k); g[x].setAttribute('tabindex', x === k ? '0' : '-1'); });
      if (!k && first) first.setAttribute('tabindex', '0');
    };
    var pick = opt.onPick || function () {};
    d.svg.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('[data-mp]'); if (t) pick(t.getAttribute('data-mp')); });
    d.svg.addEventListener('keydown', function (e) {
      var t = e.target.closest && e.target.closest('[data-mp]'); if (!t) return;
      var keys = m.pins.map(function (p) { return p.k; }), i = keys.indexOf(t.getAttribute('data-mp'));
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(keys[i]); return; }
      var dd = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!dd) return;
      e.preventDefault();
      var nx = g[keys[(i + dd + keys.length) % keys.length]];
      t.setAttribute('tabindex', '-1'); nx.setAttribute('tabindex', '0'); try { nx.focus({ preventScroll: true }); } catch (err) { nx.focus(); }
    });
    return d;
  }
  var byId = {}; MODULES.forEach(function (m) { byId[m.id] = m; });
  STM.modules = { list: MODULES, byId: byId, draw: draw };
})();
