#!/bin/sh
# 在小芯的云电脑（InstaBox，Debian）上准备 STM32F103ZET6 的编译环境：
#   1. 装 ARM 交叉编译器（arm-none-eabi-gcc + newlib + make）
#   2. 在 /data/workspace/stm32-template 放一个空工程：学习台的寄存器代码（#include "stm32f10x.h"）直接能编译
# 头文件和启动文件从官方仓库下载（固定版本）：
#   ST cmsis_device_f1（stm32f1xx.h、stm32f103xe.h、启动文件、system_stm32f1xx.c，Apache-2.0）
#   ARM CMSIS_5（core_cm3.h 等，Apache-2.0）
# 链接脚本自己写（ZET6：Flash 512K @0x08000000，RAM 64K @0x20000000）。
# 可以重复跑：已经有的不重下；工程目录里自己的 main.c 不会被覆盖。
set -eu
T=${STM32_TEMPLATE:-/data/workspace/stm32-template}
ST=https://raw.githubusercontent.com/STMicroelectronics/cmsis_device_f1/v4.3.5
ARM=https://raw.githubusercontent.com/ARM-software/CMSIS_5/5.9.0/CMSIS/Core/Include

if ! command -v arm-none-eabi-gcc >/dev/null 2>&1 || [ ! -d /usr/lib/arm-none-eabi/newlib ]; then
  sudo apt-get update -q
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q gcc-arm-none-eabi libnewlib-arm-none-eabi binutils-arm-none-eabi make
fi

mkdir -p "$T/inc"
get() { [ -s "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"; }
get "$ST/Include/stm32f1xx.h" "$T/inc/stm32f1xx.h"
get "$ST/Include/stm32f103xe.h" "$T/inc/stm32f103xe.h"
get "$ST/Include/system_stm32f1xx.h" "$T/inc/system_stm32f1xx.h"
get "$ST/Source/Templates/gcc/startup_stm32f103xe.s" "$T/startup_stm32f103xe.s"
get "$ST/Source/Templates/system_stm32f1xx.c" "$T/system_stm32f1xx.c"
for f in core_cm3.h cmsis_compiler.h cmsis_gcc.h cmsis_version.h; do get "$ARM/$f" "$T/inc/$f"; done

# 学习台的代码写的是 #include "stm32f10x.h"（老标准库的名字），这里转到 ST 现在的 CMSIS 头文件
cat > "$T/inc/stm32f10x.h" <<'EOF'
/* 学习台的代码用 #include "stm32f10x.h"：转到 ST 现在的 CMSIS 头文件（STM32F103ZET6 = 大容量 xE） */
#ifndef STM32F10X_SHIM_H
#define STM32F10X_SHIM_H
#ifndef STM32F103xE
#define STM32F103xE
#endif
#include "stm32f1xx.h"
#endif
EOF

cat > "$T/STM32F103ZETx_FLASH.ld" <<'EOF'
/* STM32F103ZET6：Flash 512K，RAM 64K */
ENTRY(Reset_Handler)
_estack = ORIGIN(RAM) + LENGTH(RAM);
_Min_Heap_Size = 0x200;
_Min_Stack_Size = 0x400;
MEMORY
{
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = 512K
  RAM   (xrw) : ORIGIN = 0x20000000, LENGTH = 64K
}
SECTIONS
{
  .isr_vector : { . = ALIGN(4); KEEP(*(.isr_vector)) . = ALIGN(4); } >FLASH
  .text : { . = ALIGN(4); *(.text) *(.text*) *(.glue_7) *(.glue_7t) *(.eh_frame) KEEP(*(.init)) KEEP(*(.fini)) . = ALIGN(4); _etext = .; } >FLASH
  .rodata : { . = ALIGN(4); *(.rodata) *(.rodata*) . = ALIGN(4); } >FLASH
  .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } >FLASH
  .ARM : { __exidx_start = .; *(.ARM.exidx*) __exidx_end = .; } >FLASH
  .preinit_array : { PROVIDE_HIDDEN(__preinit_array_start = .); KEEP(*(.preinit_array*)) PROVIDE_HIDDEN(__preinit_array_end = .); } >FLASH
  .init_array : { PROVIDE_HIDDEN(__init_array_start = .); KEEP(*(SORT(.init_array.*))) KEEP(*(.init_array*)) PROVIDE_HIDDEN(__init_array_end = .); } >FLASH
  .fini_array : { PROVIDE_HIDDEN(__fini_array_start = .); KEEP(*(SORT(.fini_array.*))) KEEP(*(.fini_array*)) PROVIDE_HIDDEN(__fini_array_end = .); } >FLASH
  _sidata = LOADADDR(.data);
  .data : { . = ALIGN(4); _sdata = .; *(.data) *(.data*) . = ALIGN(4); _edata = .; } >RAM AT> FLASH
  . = ALIGN(4);
  .bss : { _sbss = .; __bss_start__ = _sbss; *(.bss) *(.bss*) *(COMMON) . = ALIGN(4); _ebss = .; __bss_end__ = _ebss; } >RAM
  ._user_heap_stack : { . = ALIGN(8); PROVIDE(end = .); PROVIDE(_end = .); . = . + _Min_Heap_Size; . = . + _Min_Stack_Size; . = ALIGN(8); } >RAM
  .ARM.attributes 0 : { *(.ARM.attributes) }
}
EOF

cat > "$T/Makefile" <<'EOF'
# STM32F103ZET6 空工程：make 生成 build/app.elf、app.hex、app.bin；make clean 清掉
# 多个 .c 文件直接放在这个目录里就会一起编译
TARGET  = app
CC      = arm-none-eabi-gcc
OBJCOPY = arm-none-eabi-objcopy
SIZE    = arm-none-eabi-size
MCU     = -mcpu=cortex-m3 -mthumb
CFLAGS  = $(MCU) -O2 -g -Wall -ffunction-sections -fdata-sections -DSTM32F103xE -DSTM32F10X_HD -Iinc -I.
LDFLAGS = $(MCU) -T STM32F103ZETx_FLASH.ld -Wl,--gc-sections -specs=nano.specs -Wl,-Map=build/$(TARGET).map
SRCS    = $(wildcard *.c)
OBJS    = $(SRCS:%.c=build/%.o) build/startup_stm32f103xe.o

all: build/$(TARGET).hex build/$(TARGET).bin
	@$(SIZE) build/$(TARGET).elf

build/%.o: %.c | build
	$(CC) $(CFLAGS) -c $< -o $@
build/startup_stm32f103xe.o: startup_stm32f103xe.s | build
	$(CC) $(MCU) -c $< -o $@
build/$(TARGET).elf: $(OBJS)
	$(CC) $(OBJS) $(LDFLAGS) -o $@
build/$(TARGET).hex: build/$(TARGET).elf
	$(OBJCOPY) -O ihex $< $@
build/$(TARGET).bin: build/$(TARGET).elf
	$(OBJCOPY) -O binary $< $@
build:
	mkdir -p build
clean:
	rm -rf build
.PHONY: all clean
EOF

# printf / malloc 要用到的几个底层函数（newlib 的 syscalls）。都是 weak：自己写同名函数就会顶替它
#（比如自己写一个 _write，printf 就从串口出来）
cat > "$T/syscalls.c" <<'EOF'
/* 让 printf / malloc 能链接上的最小 syscalls。都是 weak，自己写同名函数会顶替这里的 */
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/stat.h>
#undef errno
extern int errno;

extern char end[];      /* 链接脚本：.bss 结束处，堆从这里开始 */
extern char _estack[];  /* 链接脚本：RAM 顶，栈从这里往下长 */
static char *heap_top;

__attribute__((weak)) void *_sbrk(ptrdiff_t incr)
{
    char *prev;
    if (heap_top == NULL) heap_top = end;
    if ((uintptr_t)heap_top + incr > (uintptr_t)_estack - 0x400) { errno = ENOMEM; return (void *)-1; }  /* 给栈留 1K */
    prev = heap_top;
    heap_top += incr;
    return prev;
}
__attribute__((weak)) int _write(int fd, const char *buf, int n) { (void)fd; (void)buf; return n; }
__attribute__((weak)) int _read(int fd, char *buf, int n) { (void)fd; (void)buf; (void)n; return 0; }
__attribute__((weak)) int _close(int fd) { (void)fd; return -1; }
__attribute__((weak)) int _lseek(int fd, int off, int whence) { (void)fd; (void)off; (void)whence; return 0; }
__attribute__((weak)) int _fstat(int fd, struct stat *st) { (void)fd; st->st_mode = S_IFCHR; return 0; }
__attribute__((weak)) int _isatty(int fd) { (void)fd; return 1; }
__attribute__((weak)) int _getpid(void) { return 1; }
__attribute__((weak)) int _kill(int pid, int sig) { (void)pid; (void)sig; errno = EINVAL; return -1; }
__attribute__((weak)) void _exit(int status) { (void)status; while (1) { } }
EOF

[ -f "$T/main.c" ] || cat > "$T/main.c" <<'EOF'
/* 例子：PA0 接 LED1（低电平亮），一亮一灭。和学习台 GPIO 一章的第一版写法一样 */
#include "stm32f10x.h"

static void delay(volatile uint32_t n) { while (n--) { } }

int main(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;            /* ① 开 GPIOA 时钟 */
    GPIOA->BSRR = GPIO_BSRR_BS0;                   /* 先输出 1（灭），免得上电闪一下 */
    GPIOA->CRL &= ~(GPIO_CRL_CNF0 | GPIO_CRL_MODE0);
    GPIOA->CRL |= GPIO_CRL_MODE0;                  /* ② PA0 推挽输出 50MHz */
    while (1) {
        GPIOA->ODR ^= 1u << 0;                     /* 翻转 PA0 */
        delay(500000);
    }
}
EOF

cat > "$T/README.md" <<'EOF'
# STM32F103ZET6 空工程

- 复制一份再改：`cp -r /data/workspace/stm32-template /data/workspace/我的工程 && cd /data/workspace/我的工程`
- 编译：`make`，生成 `build/app.hex`（烧录用）、`build/app.bin`、`build/app.elf`（调试用）；`make clean` 清掉
- 代码直接写 `#include "stm32f10x.h"`，和学习台里的写法一样（寄存器名来自 ST 的 CMSIS 头文件）
- 多个 .c 放在同一目录就会一起编译；头文件放 `inc/` 或同一目录
- `syscalls.c` 让 printf / malloc 能链接；printf 默认不输出，想从串口打印就自己写一个 `_write`
EOF

cd "$T" && make -s clean >/dev/null && make -s
echo "STM32 模板就绪：$T"
