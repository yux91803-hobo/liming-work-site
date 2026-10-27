/* STM32 HAL 常用代码片段（STM32CubeMX 生成的 HAL 工程写法）
   引脚宏与尚硅谷 STM32F103ZET6 开发板原理图一致（见 assets/board.js）
   每项 { cat, title, code }，code 用 String.raw 保留反斜杠原样 */
window.STM32_SNIPPETS = [
{ cat: 'GPIO', title: 'LED 亮灭 / 翻转', code: String.raw`/* main.h —— CubeMX User Label：LED1 / LED2 / LED3（GPIO_Output，初始高电平=灭） */
#define LED1_Pin        GPIO_PIN_0      /* PA0 黄 */
#define LED1_GPIO_Port  GPIOA
#define LED2_Pin        GPIO_PIN_1      /* PA1 蓝 */
#define LED2_GPIO_Port  GPIOA
#define LED3_Pin        GPIO_PIN_8      /* PA8 绿 */
#define LED3_GPIO_Port  GPIOA

/* 低电平点亮：GPIO_PIN_RESET = 亮，GPIO_PIN_SET = 灭 */
#define LED_ON(x)      HAL_GPIO_WritePin(x##_GPIO_Port, x##_Pin, GPIO_PIN_RESET)
#define LED_OFF(x)     HAL_GPIO_WritePin(x##_GPIO_Port, x##_Pin, GPIO_PIN_SET)
#define LED_TOGGLE(x)  HAL_GPIO_TogglePin(x##_GPIO_Port, x##_Pin)

/* main.c —— USER CODE BEGIN WHILE */
  LED_OFF(LED1); LED_OFF(LED2); LED_OFF(LED3);
  while (1)
  {
    LED_TOGGLE(LED1);
    HAL_Delay(500);
  }

/* 流水灯 */
  while (1)
  {
    LED_ON(LED1); HAL_Delay(200); LED_OFF(LED1);
    LED_ON(LED2); HAL_Delay(200); LED_OFF(LED2);
    LED_ON(LED3); HAL_Delay(200); LED_OFF(LED3);
  }` },

{ cat: 'GPIO', title: '蜂鸣器', code: String.raw`/* main.h —— CubeMX：PB1 GPIO_Output，User Label = BEEP，初始低电平（不响） */
#define BEEP_Pin        GPIO_PIN_1
#define BEEP_GPIO_Port  GPIOB

/* 高电平响（经 N-MOS 驱动） */
#define BEEP_ON()      HAL_GPIO_WritePin(BEEP_GPIO_Port, BEEP_Pin, GPIO_PIN_SET)
#define BEEP_OFF()     HAL_GPIO_WritePin(BEEP_GPIO_Port, BEEP_Pin, GPIO_PIN_RESET)

/* 响 ms 毫秒 */
void Beep(uint32_t ms)
{
  BEEP_ON();
  HAL_Delay(ms);
  BEEP_OFF();
}` },

{ cat: '输入', title: '按键输入（消抖）', code: String.raw`/* main.h —— CubeMX：GPIO_Input
   KEY1 PF8 / KEY2 PF9：按下为低电平 → Pull-up（GPIO_PULLUP）
   KEY3 PF10 / KEY4 PF11：按下为高电平 → Pull-down（GPIO_PULLDOWN） */
#define KEY1_Pin        GPIO_PIN_8
#define KEY1_GPIO_Port  GPIOF
#define KEY2_Pin        GPIO_PIN_9
#define KEY2_GPIO_Port  GPIOF
#define KEY3_Pin        GPIO_PIN_10
#define KEY3_GPIO_Port  GPIOF
#define KEY4_Pin        GPIO_PIN_11
#define KEY4_GPIO_Port  GPIOF

typedef struct {
  GPIO_TypeDef  *port;
  uint16_t       pin;
  GPIO_PinState  press;          /* 按下时的电平 */
} Key_t;

static const Key_t keys[4] = {
  { KEY1_GPIO_Port, KEY1_Pin, GPIO_PIN_RESET },
  { KEY2_GPIO_Port, KEY2_Pin, GPIO_PIN_RESET },
  { KEY3_GPIO_Port, KEY3_Pin, GPIO_PIN_SET   },
  { KEY4_GPIO_Port, KEY4_Pin, GPIO_PIN_SET   },
};

/* 非阻塞扫描：主循环里反复调用；每 10ms 采样一次，连续 3 次一致才确认（约 30ms 消抖）
   返回刚按下的键号 1~4，没有新按下返回 0 */
uint8_t Key_Scan(void)
{
  static uint32_t last;
  static uint8_t  state[4], cnt[4];
  uint8_t ret = 0;

  if (HAL_GetTick() - last < 10) return 0;
  last = HAL_GetTick();

  for (uint8_t i = 0; i < 4; i++) {
    uint8_t down = (HAL_GPIO_ReadPin(keys[i].port, keys[i].pin) == keys[i].press);
    if (down != state[i]) {
      if (++cnt[i] >= 3) {
        if (down && ret) continue;   /* 本轮已报了别的键：这次先不确认，下一轮（10ms 后）再报，同时按下也不丢 */
        state[i] = down;
        cnt[i] = 0;
        if (down) ret = i + 1;
      }
    } else {
      cnt[i] = 0;
    }
  }
  return ret;
}

/* 阻塞式写法（入门）：按下 → 延时 20ms 再确认 → 等待松开 */
uint8_t KEY1_Pressed(void)
{
  if (HAL_GPIO_ReadPin(KEY1_GPIO_Port, KEY1_Pin) == GPIO_PIN_RESET) {
    HAL_Delay(20);
    if (HAL_GPIO_ReadPin(KEY1_GPIO_Port, KEY1_Pin) == GPIO_PIN_RESET) {
      while (HAL_GPIO_ReadPin(KEY1_GPIO_Port, KEY1_Pin) == GPIO_PIN_RESET) {}
      return 1;
    }
  }
  return 0;
}

/* main.c —— USER CODE BEGIN WHILE */
  while (1)
  {
    switch (Key_Scan()) {
      case 1: HAL_GPIO_TogglePin(LED1_GPIO_Port, LED1_Pin); break;
      case 2: HAL_GPIO_TogglePin(LED2_GPIO_Port, LED2_Pin); break;
      case 3: HAL_GPIO_TogglePin(LED3_GPIO_Port, LED3_Pin); break;
      case 4: HAL_GPIO_TogglePin(BEEP_GPIO_Port, BEEP_Pin); break;
      default: break;
    }
  }` },

{ cat: '输入', title: 'EXTI 外部中断（KEY1 下降沿）', code: String.raw`/* CubeMX：PF8 选 GPIO_EXTI8，User Label = KEY1
   GPIO mode = External Interrupt Mode with Falling edge trigger detection，Pull-up
   NVIC：勾选 EXTI line[9:5] interrupts */

/* main.c —— MX_GPIO_Init() 中 CubeMX 生成的关键部分 */
  GPIO_InitStruct.Pin = KEY1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_IT_FALLING;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(KEY1_GPIO_Port, &GPIO_InitStruct);

  HAL_NVIC_SetPriority(EXTI9_5_IRQn, 2, 0);
  HAL_NVIC_EnableIRQ(EXTI9_5_IRQn);

/* stm32f1xx_it.c —— CubeMX 生成 */
void EXTI9_5_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(KEY1_Pin);
}

/* main.c —— USER CODE BEGIN 4：回调里不要用 HAL_Delay，用时间戳消抖 */
void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
  static uint32_t last;
  if (GPIO_Pin == KEY1_Pin) {
    uint32_t now = HAL_GetTick();
    if (now - last > 50) {
      last = now;
      HAL_GPIO_TogglePin(LED1_GPIO_Port, LED1_Pin);
    }
  }
}` },

{ cat: '串口', title: 'USART1 中断收发', code: String.raw`/* CubeMX：USART1 Asynchronous，115200 8N1（PA9 TX / PA10 RX，板上默认接 STLink USB 虚拟串口）
   NVIC：勾选 USART1 global interrupt */
#include <string.h>

extern UART_HandleTypeDef huart1;

static uint8_t           rx_byte;
static char              rx_line[64];
static volatile uint16_t rx_len;
static volatile uint8_t  line_ready;
static uint8_t           tx_buf[128];

/* 启动接收：main() 初始化后调用一次 */
void UART1_StartRx(void)
{
  HAL_UART_Receive_IT(&huart1, &rx_byte, 1);
}

/* 中断发送：等上一次发完再发（数据先拷到发送缓冲） */
void UART1_SendIT(const char *s)
{
  uint16_t n = strlen(s);
  if (n > sizeof(tx_buf)) n = sizeof(tx_buf);
  while (huart1.gState != HAL_UART_STATE_READY) {}
  memcpy(tx_buf, s, n);
  HAL_UART_Transmit_IT(&huart1, tx_buf, n);
}

/* 每收到 1 字节进一次：按 \r 或 \n 断行 */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1) {
    if (!line_ready) {
      if (rx_byte == '\r' || rx_byte == '\n') {
        if (rx_len) { rx_line[rx_len] = '\0'; line_ready = 1; }
      } else if (rx_len < sizeof(rx_line) - 1) {
        rx_line[rx_len++] = rx_byte;
      }
    }
    HAL_UART_Receive_IT(&huart1, &rx_byte, 1);
  }
}

void HAL_UART_TxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1) {
    /* 发送完成 */
  }
}

/* 溢出等错误后重新开启接收 */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1) {
    HAL_UART_Receive_IT(&huart1, &rx_byte, 1);
  }
}

/* main.c —— 回显一整行 */
  UART1_StartRx();
  UART1_SendIT("hello\r\n");
  while (1)
  {
    if (line_ready) {
      UART1_SendIT(rx_line);
      UART1_SendIT("\r\n");
      rx_len = 0;
      line_ready = 0;
    }
  }` },

{ cat: '串口', title: 'printf 重定向到 USART1', code: String.raw`/* main.c —— USER CODE BEGIN Includes */
#include <stdio.h>

/* USER CODE BEGIN 0 */
extern UART_HandleTypeDef huart1;

#if defined(__CC_ARM) || defined(__ARMCC_VERSION)
/* Keil MDK（AC5 / AC6）：Options → Target 勾选 Use MicroLIB */
int fputc(int ch, FILE *f)
{
  HAL_UART_Transmit(&huart1, (uint8_t *)&ch, 1, HAL_MAX_DELAY);
  return ch;
}
#else
/* STM32CubeIDE / arm-none-eabi-gcc：由 syscalls.c 的 _write() 调用 */
int __io_putchar(int ch)
{
  HAL_UART_Transmit(&huart1, (uint8_t *)&ch, 1, HAL_MAX_DELAY);
  return ch;
}
#endif

/* main() —— USER CODE BEGIN 2 */
  setvbuf(stdout, NULL, _IONBF, 0);      /* GCC：关闭缓冲，不带 \n 也立即输出 */
  printf("STM32F103ZET6 @ %lu Hz\r\n", HAL_RCC_GetSysClockFreq());

/* GCC 打印浮点：链接选项加 -u _printf_float */` },

{ cat: '定时器', title: '定时器中断（TIM6 1s）', code: String.raw`/* CubeMX：TIM6 Activated，Prescaler = 7199，Counter Period = 9999
   72MHz / 7200 / 10000 = 1Hz；NVIC：勾选 TIM6 global interrupt */
extern TIM_HandleTypeDef htim6;

/* main() —— USER CODE BEGIN 2
   初始化时产生的更新事件会置位 UIF：不清的话一启动就立刻进一次中断（LED 在 0s 就翻转，而不是 1s 后） */
  __HAL_TIM_CLEAR_FLAG(&htim6, TIM_FLAG_UPDATE);
  HAL_TIM_Base_Start_IT(&htim6);

/* main.c —— USER CODE BEGIN 4
   若 CubeMX 的 Timebase Source 选了某个 TIM，main.c 里已生成此回调，把代码加进它的 USER CODE 段 */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM6) {
    HAL_GPIO_TogglePin(LED2_GPIO_Port, LED2_Pin);
  }
}` },

{ cat: '定时器', title: 'PWM 呼吸灯（LED1 · TIM2_CH1）', code: String.raw`/* CubeMX：PA0 选 TIM2_CH1（不再作 GPIO_Output）
   TIM2 Channel1 = PWM Generation CH1，Prescaler = 71，Counter Period = 999
   72MHz / 72 / 1000 = 1kHz，CH Polarity = High */
extern TIM_HandleTypeDef htim2;

#define PWM_PERIOD  1000          /* = Counter Period + 1 */

/* LED1 低电平点亮：比较值越大，高电平越久，灯越暗 → 占空比反相
   bright：0（灭）~ 1000（最亮） */
static void LED1_SetBright(uint16_t bright)
{
  if (bright > PWM_PERIOD) bright = PWM_PERIOD;
  __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, PWM_PERIOD - bright);
}

/* main() —— USER CODE BEGIN 2 */
  HAL_TIM_PWM_Start(&htim2, TIM_CHANNEL_1);

/* USER CODE BEGIN WHILE */
  int16_t b = 0, step = 10;
  while (1)
  {
    LED1_SetBright(b);
    b += step;
    if (b >= PWM_PERIOD) { b = PWM_PERIOD; step = -step; }
    if (b <= 0)          { b = 0;          step = -step; }
    HAL_Delay(10);
  }` },

{ cat: '模拟', title: 'ADC 读电位器（ADC1 · IN10 · PC0）', code: String.raw`/* CubeMX：ADC1 勾选 IN10（PC0），Continuous Conversion Mode = Disabled
   Rank 1：Channel 10，Sampling Time = 239.5 Cycles
   Clock Configuration：ADC Prescaler /6 → 12MHz（F1 ADC 时钟 ≤ 14MHz） */
extern ADC_HandleTypeDef hadc1;

/* MX_ADC1_Init() 中 CubeMX 生成的通道配置 */
  ADC_ChannelConfTypeDef sConfig = {0};
  sConfig.Channel = ADC_CHANNEL_10;
  sConfig.Rank = ADC_REGULAR_RANK_1;
  sConfig.SamplingTime = ADC_SAMPLETIME_239CYCLES_5;
  HAL_ADC_ConfigChannel(&hadc1, &sConfig);

/* main() —— USER CODE BEGIN 2：上电校准一次 */
  HAL_ADCEx_Calibration_Start(&hadc1);

/* 单次轮询读取 0~4095 */
uint16_t ADC1_Read(void)
{
  uint16_t v = 0;
  HAL_ADC_Start(&hadc1);
  if (HAL_ADC_PollForConversion(&hadc1, 10) == HAL_OK) {
    v = HAL_ADC_GetValue(&hadc1);
  }
  HAL_ADC_Stop(&hadc1);
  return v;
}

/* 8 次平均并换算成 mV（VREF+ = 3.3V） */
uint32_t ADC1_ReadmV(void)
{
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 8; i++) sum += ADC1_Read();
  return (sum / 8) * 3300 / 4095;
}

/* 用法 */
  printf("POT = %lu mV\r\n", ADC1_ReadmV());` },

{ cat: '总线', title: 'I2C 读写 EEPROM（M24C02 · I2C2）', code: String.raw`/* CubeMX：I2C2（PB10 SCL / PB11 SDA），I2C Speed Mode = Standard 100kHz
   M24C02：器件地址 0xA0，256 字节，页 16 字节，写周期 ≤ 5ms */
extern I2C_HandleTypeDef hi2c2;

#define EE_ADDR   0xA0
#define EE_SIZE   256
#define EE_PAGE   16

/* 写周期内器件不应答，轮询 ACK 直到就绪 */
static HAL_StatusTypeDef EE_WaitReady(void)
{
  return HAL_I2C_IsDeviceReady(&hi2c2, EE_ADDR, 100, 10);
}

HAL_StatusTypeDef EE_Write(uint16_t addr, const uint8_t *buf, uint16_t len)
{
  if (addr + len > EE_SIZE) return HAL_ERROR;
  while (len) {
    uint16_t n = EE_PAGE - (addr % EE_PAGE);          /* 按页拆分，不跨页 */
    if (n > len) n = len;
    if (HAL_I2C_Mem_Write(&hi2c2, EE_ADDR, addr, I2C_MEMADD_SIZE_8BIT,
                          (uint8_t *)buf, n, 100) != HAL_OK) return HAL_ERROR;
    if (EE_WaitReady() != HAL_OK) return HAL_TIMEOUT; /* 等待内部写完成 */
    addr += n; buf += n; len -= n;
  }
  return HAL_OK;
}

HAL_StatusTypeDef EE_Read(uint16_t addr, uint8_t *buf, uint16_t len)
{
  if (addr + len > EE_SIZE) return HAL_ERROR;
  return HAL_I2C_Mem_Read(&hi2c2, EE_ADDR, addr, I2C_MEMADD_SIZE_8BIT, buf, len, 100);
}

/* 用法 */
  uint8_t w[4] = { 0x11, 0x22, 0x33, 0x44 };
  uint8_t r[4] = { 0 };
  EE_Write(0x00, w, sizeof(w));
  EE_Read(0x00, r, sizeof(r));
  printf("EE: %02X %02X %02X %02X\r\n", r[0], r[1], r[2], r[3]);` },

{ cat: '总线', title: 'SPI 读 Flash ID（W25Q32 · SPI1）', code: String.raw`/* CubeMX：SPI1 Full-Duplex Master（PA5 SCK / PA6 MISO / PA7 MOSI）
   Data Size 8 Bits，MSB First，CPOL Low，CPHA 1 Edge（Mode 0），NSS = Software
   Prescaler = 4（72MHz / 4 = 18MHz）
   PC13 GPIO_Output，User Label = W25Q_CS，初始高电平；SPI1 上其他器件的片选也保持高电平 */
#define W25Q_CS_Pin        GPIO_PIN_13
#define W25Q_CS_GPIO_Port  GPIOC

extern SPI_HandleTypeDef hspi1;

#define W25Q_CS_LOW()   HAL_GPIO_WritePin(W25Q_CS_GPIO_Port, W25Q_CS_Pin, GPIO_PIN_RESET)
#define W25Q_CS_HIGH()  HAL_GPIO_WritePin(W25Q_CS_GPIO_Port, W25Q_CS_Pin, GPIO_PIN_SET)

/* 0x9F：JEDEC ID = 厂商 + 类型 + 容量，W25Q32JV 为 0xEF4016 */
uint32_t W25Q_ReadJEDEC(void)
{
  uint8_t tx[4] = { 0x9F, 0xFF, 0xFF, 0xFF };
  uint8_t rx[4] = { 0 };
  W25Q_CS_LOW();
  HAL_SPI_TransmitReceive(&hspi1, tx, rx, 4, 100);
  W25Q_CS_HIGH();
  return ((uint32_t)rx[1] << 16) | ((uint32_t)rx[2] << 8) | rx[3];
}

/* 用法 */
  printf("W25Q JEDEC ID = 0x%06lX\r\n", W25Q_ReadJEDEC());` },

{ cat: '系统', title: '延时 / SysTick', code: String.raw`/* HAL 默认用 SysTick 产生 1ms 时基：HAL_Delay() / HAL_GetTick() 都基于它 */
  HAL_Delay(500);                              /* 阻塞延时 500ms */

/* 非阻塞定时：主循环里同时跑多个周期任务 */
  uint32_t t_led = 0, t_key = 0;
  while (1)
  {
    uint32_t now = HAL_GetTick();
    if (now - t_led >= 500) { t_led = now; HAL_GPIO_TogglePin(LED3_GPIO_Port, LED3_Pin); }
    if (now - t_key >= 10)  { t_key = now; /* 扫描按键 */ }
  }

/* stm32f1xx_it.c —— CubeMX 生成：每 1ms 进一次，uwTick++ */
void SysTick_Handler(void)
{
  HAL_IncTick();
}

/* 微秒延时：Cortex-M3 DWT 周期计数器（72MHz → 72 个周期 / us） */
void DWT_Init(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

void delay_us(uint32_t us)
{
  uint32_t start = DWT->CYCCNT;
  uint32_t ticks = us * (SystemCoreClock / 1000000U);
  while ((DWT->CYCCNT - start) < ticks) {}
}` }
];
