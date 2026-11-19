/* 工具注册表 —— 新增工具：在这里加一项 + 新建 /tools/<id>/index.html
   cat：属于哪一类（见 TOOL_CATS，首页按类分区，空的类不显示）；art：首页卡片上的插画（shell.js 里画，没有就用放大的图标）
   icon：SVG 图元列表 [标签, 属性]，由 shell.js 用 createElementNS 绘制（24×24 网格，线宽统一）。
   class:'a' 的图元用强调色（陶土橙），每个图标只放一处强调。 */
window.TOOLS = [
  {
    id: 'map',
    name: '世界地图',
    cat: 'tool', art: 'world',
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
    id: 'stm32',
    name: 'STM32',
    cat: 'learn', art: 'chip',
    keywords: 'stm32 f103 f103zet6 zet6 stm32f103 arm cortex m3 mcu 单片机 嵌入式 开发板 尚硅谷 引脚 管脚 pin pinout 外设 复用 重映射 remap afio gpio usart uart spi i2c adc dac tim 定时器 pwm can usb sdio fsmc swd jtag hal cubemx 代码 片段 原理图 芯片 封装 lqfp144 架构图 时钟树 rm0008 danpianji yinjiao',
    path: '/stm32',
    src: '/tools/stm32/',
    icon: [
      ['rect', { x: '6.5', y: '6.5', width: '11', height: '11', rx: '1.8' }],
      ['path', { d: 'M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3' }],
      ['circle', { cx: '9.6', cy: '9.6', r: '0.9', 'class': 'a' }]
    ]
  },
  {
    id: 'tianqi',
    name: '天启',
    cat: 'ai',
    keywords: '天启 tianqi harness 模型 聊天 ai',
    path: '/tianqi',
    src: '/tools/tianqi/',
    icon: [
      ['path', { d: 'M12 3l1.9 7.1L21 12l-7.1 1.9L12 21l-1.9-7.1L3 12l7.1-1.9Z' }],
      ['circle', { cx: '18.5', cy: '5.5', r: '0.9', 'class': 'a' }]
    ]
  }
];

/* 首页分类（按这个顺序显示）。站长 2026-11-19：小芯、天启放最上面（小芯那块在分类前面），世界地图第三，学习最后。
   每类的第一张卡是宽卡：天启单独一类，世界地图不会再因为天启排在前面被挤成半张 */
window.TOOL_CATS = [
  { id: 'ai', name: '天启' },
  { id: 'tool', name: '工具' },
  { id: 'learn', name: '学习' }
];
