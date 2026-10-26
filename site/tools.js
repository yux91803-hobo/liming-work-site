/* 工具注册表 —— 新增工具：在这里加一项 + 新建 /tools/<id>/index.html
   icon：SVG 图元列表 [标签, 属性]，由 shell.js 用 createElementNS 绘制（24×24 网格，线宽统一）。
   class:'a' 的图元用强调色（陶土橙），每个图标只放一处强调。 */
window.TOOLS = [
  {
    id: 'map',
    name: '世界地图',
    keywords: 'map world 地图 卫星 定位 导航 搜索 ditu',
    path: '/map',              // 地址栏路由
    src: '/tools/map/',        // 工具页面
    icon: [
      ['circle', { cx: '12', cy: '12', r: '8.5' }],
      ['path', { d: 'M12 3.5c-2.5 2.3-3.75 5.13-3.75 8.5S9.5 18.2 12 20.5' }],
      ['path', { d: 'M12 3.5c2.5 2.3 3.75 5.13 3.75 8.5S14.5 18.2 12 20.5' }],
      ['path', { d: 'M4.1 9h15.8M4.1 15h15.8', 'class': 'a' }]
    ]
  },
  {
    id: 'transfer',
    name: '互传',
    keywords: 'transfer send file share 传输 互传 文件 手机 电脑 网盘 中转 剪贴板 huchuan',
    path: '/transfer',
    src: '/tools/transfer/',
    icon: [
      ['path', { d: 'M4.5 10.5a7.5 7.5 0 0 1 13.4-3.9' }],
      ['path', { d: 'M18.4 3.2V7h-3.8' }],
      ['path', { d: 'M19.5 13.5a7.5 7.5 0 0 1-13.4 3.9', 'class': 'a' }],
      ['path', { d: 'M5.6 20.8V17h3.8', 'class': 'a' }]
    ]
  },
  {
    id: 'hub',
    name: '协作中心',
    keywords: 'hub ai 协作 任务 看板 群聊 日志 xiezuo',
    path: '/hub',
    src: '/tools/hub/',
    icon: [
      ['path', { d: 'M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v7.5a2.5 2.5 0 0 1-2.5 2.5h-6l-4.5 3.5V17H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5Z' }],
      ['path', { d: 'M12 7.75v6M9.4 9.25l5.2 3M9.4 12.25l5.2-3', 'class': 'a' }]
    ]
  },
  {
    id: 'stm32',
    name: 'STM32',
    keywords: 'stm32 f103 f103zet6 zet6 stm32f103 arm cortex m3 mcu 单片机 嵌入式 开发板 尚硅谷 引脚 管脚 pin pinout 外设 复用 重映射 remap afio gpio usart uart spi i2c adc dac tim 定时器 pwm can usb sdio fsmc swd jtag hal cubemx 代码 片段 原理图 芯片 封装 lqfp144 架构图 时钟树 rm0008 danpianji yinjiao',
    path: '/stm32',
    src: '/tools/stm32/',
    icon: [
      ['rect', { x: '6.5', y: '6.5', width: '11', height: '11', rx: '1.8' }],
      ['path', { d: 'M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3' }],
      ['circle', { cx: '9.6', cy: '9.6', r: '0.9', 'class': 'a' }]
    ]
  }
];
