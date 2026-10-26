/* 工具注册表 —— 新增工具：在这里加一项 + 新建 /tools/<id>/index.html */
window.TOOLS = [
  {
    id: 'map',
    name: '世界地图',
    desc: '搜索 · 定位 · 卫星',
    keywords: 'map world 地图 卫星 定位 导航 ditu',
    path: '/map',              // 地址栏路由
    src: '/tools/map/',        // 工具页面
    color: ['#5aa2ff', '#2f6bff'],
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18"/></svg>'
  },
  {
    id: 'transfer',
    name: '互传',
    desc: '手机 · 电脑 · 文件',
    keywords: 'transfer send file share 传输 互传 文件 网盘 中转 剪贴板 huchuan',
    path: '/transfer',
    src: '/tools/transfer/',
    color: ['#a78bfa', '#7c5cff'],
    icon: '<svg viewBox="0 0 24 24"><path d="M7 4v13M3.5 13.5 7 17l3.5-3.5"/><path d="M17 20V7M13.5 10.5 17 7l3.5 3.5"/></svg>'
  }
];
