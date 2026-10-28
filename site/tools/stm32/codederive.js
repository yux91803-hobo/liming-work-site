/* codederive.js — 代码推导：用「写驱动的通用套路」把每个外设的代码一步步推出来
   每个外设一章：goal（要写成什么样的模块）、steps（连着讲的几步）、files（最后拼出来的 .h / .c / main.c）。
   files 里每一行是 [代码, 注释, 为什么这样写, 属于哪一步]；某一步要展示的代码就是各文件里标了这一步的行。
   不碰 DOM；Node 里测试：每一步都有代码、每行都有注释、步骤 id 都对得上。 */
(function () {
  'use strict';
  var W = typeof window === 'object' ? window : this;

  // 所有外设通用的写法：每一章都按这个顺序推
  var METHOD = ['对外接口', '.h 框架', '硬件连接', '.c 骨架', '初始化', '功能函数', 'main.c', '改需求'];

  var CD = {
    gpio: {
      module: 'led', title: 'LED 驱动',
      goal: '写一个 LED 驱动：main.c 里只写 LED_On(LED1)、LED_Toggle(LED2) 这样的话，不用知道 LED 接在 PA0、是低电平亮。',
      steps: [
        { id: 's1', q: '对外接口', say: [
          '写驱动不要从寄存器开始，先站在「用的人」那边想：main 里想干什么？——让某个灯亮、灭、翻转，开机先初始化一次。',
          '把这几件事各写成一个函数，就是这个模块对外的全部接口。参数用灯的编号（1、2、3），不用引脚号：用的人不需要知道灯接在哪个脚上，以后换板子 main.c 一行都不用改。',
          '这些函数要让别的 .c 文件能调用，所以声明（只写函数头，不写函数体）放进头文件 led.h；编号也写成宏放在这里，调用时写 LED1 比写 1 好懂。'] },
        { id: 's2', q: '.h 框架', say: [
          '每个 .h 都有同样的「外壳」：#ifndef / #define / #endif 把整个文件包起来。好几个 .c 都 #include "led.h"、或者一个 .c 间接包含了两次时，第二次会被整个跳过，不会出现「重复定义」的编译错误。',
          '函数声明里用到了 uint8_t，所以 .h 里要先包含芯片头文件（它会带上 stdint.h）。原则是：一个头文件自己用到什么就自己 include 什么，别指望使用者替它先包含。'] },
        { id: 's3', q: '硬件连接', say: [
          '「LED1 接 PA0」是这块板子的细节，只有 led.c 自己需要知道，所以写在 led.c 里，不放进 .h：别人看不见，也就不会依赖它。',
          '三个灯都在 GPIOA 上，端口写成一个宏；每个灯占 ODR 的哪一位放进一个小表（用宏名 GPIO_ODR_ODR0 这样写），按编号查。换板子时只改这两处，函数体一行不动。'] },
        { id: 's4', q: '.c 骨架', say: [
          '.c 文件一般是这个顺序：先 #include 自己的 .h（顺带检查声明和实现对不对得上），再写只在本文件用的宏和变量，然后是初始化函数，最后是各个功能函数。',
          '只在本文件用的变量、函数前面加 static：别的文件看不见它，名字也不会和别的模块撞车。'],
          extra: { name: 'led.c 的骨架', lines: [
            ['#include "led.h"', '① 自己的头文件', ''],
            ['/* 只在本文件用的宏、变量（static） */', '② 硬件连接、内部状态', ''],
            ['/* 初始化函数 */', '③ LED_Init', ''],
            ['/* 功能函数 */', '④ LED_On / LED_Off / LED_Toggle', ''],
            ['/* 中断服务函数 */', '⑤ 用到中断的模块才有（这个没有）', '']
          ] } },
        { id: 's5', q: '初始化', say: [
          '几乎所有外设的初始化都是同样四步：① 开时钟 → ② 配引脚 → ③ 配外设自己的参数 → ④ 使能（需要中断的再开中断）。GPIO 本身就是「引脚」，所以只有前两步。',
          '顺序不能乱：时钟没开，后面写的寄存器全都无效。配成输出之前先把输出值写成 1（灭），上电那一刻灯才不会闪一下。',
          '每个脚占 CRL / CRH 里的 4 位（CNFy + MODEy），用宏名写：先 &= ~(…) 清掉，再 |= (…) 置上，别的脚不受影响。'] },
        { id: 's6', q: '功能函数', say: [
          '亮 = 引脚输出 0（低电平亮），灭 = 输出 1。用 BSRR 一次只改一个脚：低 16 位写 1 = 置 1，高 16 位写 1 = 清 0。它是「只写」的，不需要先读，被中断打断也不会改错别的脚。',
          '编号是外面传进来的，先检查一下范围，传错了就什么都不做，不会去乱写别的脚。',
          '翻转需要知道当前状态，用 ODR 异或。这是「读-改-写」：先读出整个 ODR、改一位、再写回去。如果中断里也会改同一个端口，改之前要先关中断，不然中断里改的那一位可能被这里写回去覆盖掉。'] },
        { id: 's7', q: 'main.c', say: [
          'main 只包含 led.h，看不到任何寄存器：先初始化一次，然后在循环里调用功能函数。延时由另一个模块（delay.h）提供——一个模块只管一件事。',
          '这里写的是课件里的流水灯：三个灯轮流亮 0.5 秒。因为接口用的是编号，轮流点灯就是一个 for 循环。'] },
        { id: 's8', q: '改需求：加 LED4（PB5）', say: [
          '接口层面：led.h 里多一个 #define LED4 4，其它声明都不变。',
          '实现层面：LED4 不在 GPIOA 上，一个端口宏不够用了 → 把「端口」也放进表里，函数里按编号查端口和脚号；初始化里多开 GPIOB 的时钟、多配 PB5。',
          'main.c 一行不用改，这就是先定接口、再写实现的好处。'],
          extra: { name: 'led.c（改法示意）', lines: [
            ['static GPIO_TypeDef * const led_port[] = { 0, GPIOA, GPIOA, GPIOA, GPIOB };', '每个灯在哪个端口', '端口也按编号查表，GPIO_TypeDef 是芯片头文件里定义的「一个 GPIO 端口的寄存器结构」。'],
            ['static const uint16_t led_pin[] = { 0, GPIO_ODR_ODR0, GPIO_ODR_ODR1, GPIO_ODR_ODR8, GPIO_ODR_ODR5 };', '每个灯是哪一位', '多一个 PB5。'],
            ['led_port[n]->BSRR = (uint32_t)led_pin[n] << 16;', 'LED_On 里改成查表', '端口和那一位都从表里取，函数本身不再写死 GPIOA。']
          ] } }
      ],
      files: [
        { name: 'led.h', lines: [
          ['#ifndef __LED_H', '如果还没定义过 __LED_H……', '头文件保护：第一次包含时 __LED_H 没定义，往下走；第二次包含时已经定义过，直接跳到 #endif。', 's2'],
          ['#define __LED_H', '……就定义它，并处理下面的内容', '名字一般用文件名大写，保证每个头文件不一样。', 's2'],
          ['', '', '', 's2'],
          ['#include "stm32f10x.h"', '芯片头文件：寄存器名、uint8_t 都在里面', '和课件的 Keil 工程一样，用标准库的 stm32f10x.h（CubeMX 生成的 HAL 工程里叫 stm32f1xx.h）。.h 里用到了 uint8_t，所以在这里包含。', 's2'],
          ['', '', '', 's1'],
          ['#define LED1  1', '灯的编号：调用时写 LED1，比写 1 好懂', '对外只暴露编号，不暴露引脚。', 's1'],
          ['#define LED2  2', '', '', 's1'],
          ['#define LED3  3', '', '', 's1'],
          ['', '', '', 's1'],
          ['void LED_Init(void);', '初始化：开机调用一次', '只有声明（函数头 + 分号），实现在 led.c。别的 .c 包含 led.h 以后就能调用它。', 's1'],
          ['void LED_On(uint8_t n);', '点亮第 n 个灯', '模块名做前缀（LED_），一看就知道是哪个模块的函数，也不会和别的模块重名。', 's1'],
          ['void LED_Off(uint8_t n);', '熄灭第 n 个灯', '', 's1'],
          ['void LED_Toggle(uint8_t n);', '翻转第 n 个灯', '', 's1'],
          ['', '', '', 's2'],
          ['#endif', '头文件保护到这里结束', '和第一行的 #ifndef 配对。', 's2']
        ] },
        { name: 'led.c', lines: [
          ['#include "led.h"', '先包含自己的头文件', '既拿到了芯片头文件，编译器也会检查这里的函数和 .h 里的声明是否一致。', 's4'],
          ['', '', '', 's3'],
          ['#define LED_PORT  GPIOA', '三个灯都在 GPIOA', '端口写成宏：换板子只改这里。', 's3'],
          ['static const uint16_t led_pin[] = { 0, GPIO_ODR_ODR0, GPIO_ODR_ODR1, GPIO_ODR_ODR8 };', 'led_pin[n] = LEDn 那一位（下标 0 不用）', 'LED1 → PA0、LED2 → PA1、LED3 → PA8（原理图第 8 页）。存的是「这一位的掩码」，用宏名写，一看就知道是哪个脚。static：只有 led.c 能用；const：放在 Flash 里、不会被改。下标 0 空着，好让编号直接当下标。', 's3'],
          ['', '', '', 's5'],
          ['void LED_Init(void)', '', '', 's5'],
          ['{', '', '', 's5'],
          ['    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;', '① 开 GPIOA 的时钟', '时钟没开，后面写 GPIOA 的寄存器都不起作用。用 |= 只开这一位，不影响别的外设。', 's5'],
          ['    LED_PORT->BSRR = GPIO_BSRR_BS0 | GPIO_BSRR_BS1 | GPIO_BSRR_BS8;', '先把三个脚的输出写成 1（灭）', '这时它们还是输入，写 ODR 不影响引脚；等一切成输出，输出的就是「灭」，上电不会闪。', 's5'],
          ['    LED_PORT->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0 | GPIO_CRL_CNF1 | GPIO_CRL_MODE1);', '先清掉 PA0、PA1 的配置位', '每个脚在 CR 里占 4 位（CNF + MODE）。先把要用的脚这几位清成 0，再置上要的位：直接 |= 的话，复位值里的 1（CNF = 01）会留下来。', 's5'],
        ['    LED_PORT->CRL |= (GPIO_CRL_MODE0 | GPIO_CRL_MODE1);', '② PA0、PA1：推挽输出 50 MHz', 'MODE = 11：输出、最高 50 MHz；CNF = 00：通用推挽（清零后 CNF 已经是 00，不用再写）。', 's5'],
          ['    LED_PORT->CRH &= ~(GPIO_CRH_CNF8 | GPIO_CRH_MODE8);', '先清掉 PA8 的配置位', '每个脚在 CR 里占 4 位（CNF + MODE）。先把要用的脚这几位清成 0，再置上要的位：直接 |= 的话，复位值里的 1（CNF = 01）会留下来。', 's5'],
        ['    LED_PORT->CRH |= (GPIO_CRH_MODE8);', '② PA8：推挽输出 50 MHz', 'PA8~15 在 CRH 里，宏名里的数字就是脚号。GPIO 没有第 ③④ 步：它本身就是引脚，配好就能用。', 's5'],
          ['}', '', '', 's5'],
          ['', '', '', 's6'],
          ['void LED_On(uint8_t n)', '', '', 's6'],
          ['{', '', '', 's6'],
          ['    if (n < 1 || n > 3) return;', '编号不对就什么都不做', '外面传进来的参数不可信，检查一下，免得 led_pin[n] 读到表外面去。', 's6'],
          ['    LED_PORT->BSRR = (uint32_t)led_pin[n] << 16;', '高 16 位写 1 = 输出 0 = 亮', 'BSRR 的高 16 位（BR）写 1 把对应的脚清 0：掩码左移 16 位就到了高半部分。只写不读，一次只动一个脚。', 's6'],
          ['}', '', '', 's6'],
          ['', '', '', 's6'],
          ['void LED_Off(uint8_t n)', '', '', 's6'],
          ['{', '', '', 's6'],
          ['    if (n < 1 || n > 3) return;', '同样先检查编号', '', 's6'],
          ['    LED_PORT->BSRR = led_pin[n];', '低 16 位写 1 = 输出 1 = 灭', 'BSRR 的低 16 位（BS）写 1 把对应的脚置 1，和 ODR 的位一一对应。', 's6'],
          ['}', '', '', 's6'],
          ['', '', '', 's6'],
          ['void LED_Toggle(uint8_t n)', '', '', 's6'],
          ['{', '', '', 's6'],
          ['    if (n < 1 || n > 3) return;', '同样先检查编号', '', 's6'],
          ['    LED_PORT->ODR ^= led_pin[n];', '输出取反', '异或 1 = 取反。这是读-改-写：中断里也改 GPIOA 的 ODR 时要注意，可能被打断改错。', 's6'],
          ['}', '', '', 's6']
        ] },
        { name: 'main.c', lines: [
          ['#include "led.h"', '只需要 LED 模块的接口', 'main 看不到 GPIOA、PA0，只看到 LED_ 开头的几个函数。', 's7'],
          ['#include "delay.h"', '延时由另一个模块提供', '一个模块只管一件事：LED 驱动不负责延时。', 's7'],
          ['', '', '', 's7'],
          ['int main(void)', '', '', 's7'],
          ['{', '', '', 's7'],
          ['    LED_Init();', '先初始化一次', '用之前必须先初始化，一般放在 main 的最前面。', 's7'],
          ['    while (1) {', '一直循环', '单片机程序不会「结束」，主循环一直跑。', 's7'],
          ['        for (uint8_t n = LED1; n <= LED3; n++) {', '三个灯轮流', '编号连着，直接循环；这里写的是「做什么」，不是「怎么做」。', 's7'],
          ['            LED_On(n);', '点亮第 n 个', '', 's7'],
          ['            Delay_ms(500);', '亮 0.5 秒', '', 's7'],
          ['            LED_Off(n);', '熄灭，轮到下一个', '', 's7'],
          ['        }', '', '', 's7'],
          ['    }', '', '', 's7'],
          ['}', '', '', 's7']
        ] }
      ]
    }
  };

  /* ---------- 「自己写」模式用：哪些行挡起来让人写、写的对不对 ---------- */
  // 结构行（括号、空行、头文件保护、include、函数头、占位注释、while (1)）和特别长的行不挡，其余都挡
  function blankable(c) {
    var t = String(c || '').trim();
    if (!t || /^[{}]\s*;?$/.test(t) || t === 'else' || t === 'while (1) {') return false;
    if (t.length > 140) return false;   // 一行十几个宏的引脚配置（FSMC）照抄没意义，直接给出
    if (/^#\s*(include|ifndef|endif)\b/.test(t) || /^#define __\w+_H$/.test(t) || /^\/\*.*\*\/$/.test(t)) return false;
    if (!/;/.test(t) && !/^(if|for|while|else)\b/.test(t) && /^[\w\s\*]+\([^)]*\)$/.test(t)) return false;   // 函数头
    return true;
  }
  // 比较时不管空格、结尾分号、十六进制大小写和 u 后缀；「a |= (X | Y)」这类只由宏名组成的或运算不管顺序和括号
  function canon(s) {
    s = String(s || '').replace(/\/\/.*$/, '').replace(/\s+/g, ' ').trim().replace(/ ?([^\w ]) ?/g, '$1').replace(/;+$/, '');   // 两个词之间留一个空格，符号两边的空格去掉
    s = s.replace(/\b(0x[0-9a-f]+|\d+)u\b/gi, '$1').replace(/\b0x[0-9a-f]+\b/gi, function (h) { return h.toLowerCase(); });
    var m = /^([\w\->\[\]\.]+)(\|=|&=|=)(.+)$/.exec(s);
    if (m && /^[~()\w|]+$/.test(m[3]) && m[3].indexOf('|') >= 0) {
      var neg = /^~/.test(m[3]), terms = m[3].replace(/^~/, '').replace(/[()]/g, '').split('|').filter(Boolean).sort();
      if (terms.every(function (x) { return /^\w+$/.test(x); })) return m[1] + m[2] + (neg ? '~' : '') + terms.join('|');
    }
    return s;
  }
  function same(answer, input) { return canon(answer) === canon(input) && canon(input) !== ''; }

  W.STM32_CODEDERIVE = { METHOD: METHOD, CD: CD, blankable: blankable, same: same, canon: canon };
})();
