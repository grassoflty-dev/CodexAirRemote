#include <stdio.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <esp_log.h>
#include <esp_rom_sys.h>
#include <esp_timer.h>
#include "lvgl_bsp.h"
#include <esp_lcd_touch.h>
#include "esp_lv_adapter.h"
#include "user_config.h"
/* disp->flushing：给 flush 等待加超时，见 flush_wait_timeout_cb()。 */
#include "display/lv_display_private.h"

static const char *TAG = "lvgl_bsp";

/* flush_wait 的超时上限。正常一帧的 DMA 传输是个位数毫秒，超过这个数说明
 * flush_ready 不会再来了，必须放弃等待而不是自旋到死。 */
#define FLUSH_WAIT_TIMEOUT_MS 100
/* 旋转请求等待"没有帧在飞"的上限：超过就放弃本次旋转，避免永久 pending。 */
#define ROTATION_FLUSH_TIMEOUT_MS 200

/* 旋转请求的消费周期：20 ms 一次，比一帧的传输时间短，用户感觉不到延迟。 */
#define ROTATION_TICK_MS 20

static lv_display_t *disp = NULL;
static DisplayPort *disp_port = NULL;
static int display_rotation = 0;
/* 旋转请求：按钮回调只置 pending_rotation，由 rotation_timer_cb() 在 LVGL
 * tick 里、确认没有帧在飞之后才真正写 MADCTL。 */
static volatile int pending_rotation = 0;
static volatile bool rotation_pending = false;
/* 旋转请求等待"无帧在飞"的起点；超过 ROTATION_FLUSH_TIMEOUT_MS 就放弃本次旋转。 */
static uint32_t rotation_flush_since = 0;
/* 一次性的旋转完成回调（settings_panel 注册，用于恢复 overlay）。 */
static lvgl_rotation_done_cb_t rotation_done_cb = NULL;
static unsigned flush_wait_timeouts = 0;

/*
 * 屏幕旋转由 SH8601 的 MADCTL(0x36) 在硬件里完成，软件不再碰像素：
 *
 *  - 面板自己交换行列/镜像，所以刷屏回调可以直接把 LVGL 给的逻辑坐标区域
 *    （以及 RGB565 数据）原样交给 adapter，不需要转置，也不需要那 11.5 KB 的
 *    DMA scratch 缓冲区。0.6.1 的死机正是这块 scratch 引起的：BLE 起来后
 *    DMA 池只剩 free 4932 / largest 3520，分配失败后回退 non-DMA，SPI 驱动的
 *    私有 DMA 反弹缓冲同样分配失败，flush_ready 永不回调，LVGL 在
 *    `while(disp->flushing)` 里自旋，整机连串口都不再响应。
 *
 *  - lv_display_set_rotation() 仍然要调：它负责更新逻辑分辨率（480x480 方形屏
 *    四个方向都不变）、让 LVGL 重绘，并且让 LVGL 自己把触摸原始坐标按旋转角
 *    变换回逻辑坐标（src/indev/lv_indev.c:763-768 -> lv_display_rotate_point()，
 *    默认的顺时针方向正好是 LVGL 画布旋转的逆变换）。因此触摸 read_cb 里
 *    绝对不能再转一次，否则就是二次旋转；触摸的 hor_res/ver_res 也来自显示
 *    分辨率，四个方向都是 480x480，不需要改。
 *
 *  - 逻辑坐标与物理坐标的对应关系仍然是 LVGL 的约定：
 *    LV_DISPLAY_ROTATION_90 时逻辑 (x,y) 落在物理 (y, 479-x)，与 MADCTL 表里
 *    90 度那一项（0x50）完全一致，所以像素和触摸永远同向。
 */

/* 把 0/90/180/270 映射成 LVGL 的旋转枚举，其它值按 0 处理。 */
static lv_display_rotation_t lvgl_rotation_of(int degrees)
{
    switch (degrees)
    {
    case 90:
        return LV_DISPLAY_ROTATION_90;
    case 180:
        return LV_DISPLAY_ROTATION_180;
    case 270:
        return LV_DISPLAY_ROTATION_270;
    default:
        return LV_DISPLAY_ROTATION_0;
    }
}

/*
 * LVGL 9 默认在 wait_for_flushing() 里 `while(disp->flushing);` 自旋。这里换成
 * 带超时的等待：正常情况下一帧 SPI 传输完成即返回；一旦 flush_ready 因为
 * DMA/驱动错误不再回来，最多等 FLUSH_WAIT_TIMEOUT_MS，打一条 E 日志后放弃，
 * 由 LVGL 自己清 flushing。结果是"掉一帧 + 报错"，而不是整机卡死。
 */
static void flush_wait_timeout_cb(lv_display_t *display)
{
    uint32_t start = lv_tick_get();

    while (display->flushing)
    {
        if (lv_tick_elaps(start) >= FLUSH_WAIT_TIMEOUT_MS)
        {
            flush_wait_timeouts++;
            ESP_LOGE(TAG, "flush_wait: display %p (%dx%d) still flushing after %d ms, frame dropped",
                     (void *)display, (int)lv_display_get_horizontal_resolution(display),
                     (int)lv_display_get_vertical_resolution(display), FLUSH_WAIT_TIMEOUT_MS);
            break;
        }
        esp_rom_delay_us(200);
    }
}

/* 刷新一帧（设置页/待机页切换等需要立即看到结果的场合用）。 */
extern "C" lv_display_t *Lvgl_GetDisplay(void)
{
    return disp;
}

extern "C" int Lvgl_GetDisplayRotation(void)
{
    return display_rotation;
}

/*
 * 设置屏幕方向：先写面板 MADCTL（硬件旋转），再让 LVGL 更新旋转状态并整屏
 * 重绘，旧像素全部作废。MADCTL 是 QSPI 写命令，和像素流不能交叠，所以这里
 * 会先等当前帧的 DMA 传完（只等传输，不等 LCD 刷新）。写失败时保持原方向，
 * 返回当前真正生效的角度。必须持有 LVGL 锁；运行中改方向请走
 * Lvgl_RequestDisplayRotation()。
 */
/* 写 MADCTL -> 改 LVGL 逻辑方向 -> 整屏 invalidate；返回实际生效角度，reason 报结果。
 * 必须在 LVGL 任务里、且 overlay 已隐藏（调用方保证）之后调用：
 * 整屏重绘需要 LVGL 池里的绘制任务内存，设置页 overlay 占满时只剩 ~1 KB 会 panic。 */
static int apply_display_rotation(int degrees, lvgl_rotation_result_t *result)
{
    lv_mem_monitor_t mon;

    *result = LVGL_ROTATION_OK;
    if (disp == NULL || disp_port == NULL)
    {
        ESP_LOGE(TAG, "rotation: display not ready");
        *result = LVGL_ROTATION_SPI_FAIL;
        return display_rotation;
    }

    degrees %= 360;
    if (degrees < 0)
    {
        degrees += 360;
    }
    degrees = (degrees / 90) * 90;

    /* 内存安全门：LVGL 池不足以完成一次整屏重绘时宁可放弃旋转，也不触发
     * lv_draw_add_task 的空指针 Store access fault（2026-11-15 真机事故）。 */
    lv_mem_monitor(&mon);
    if (mon.free_size < 4096 || mon.free_biggest_size < 2048)
    {
        ESP_LOGE(TAG,
                 "rotation skipped: lvgl memory too low free=%u biggest=%u (need >=4096/2048), keeping %d deg",
                 (unsigned)mon.free_size, (unsigned)mon.free_biggest_size, display_rotation);
        *result = LVGL_ROTATION_LOW_MEM;
        return display_rotation;
    }

    if (disp->flushing)
    {
        flush_wait_timeout_cb(disp);
    }
    if (disp->flushing)
    {
        ESP_LOGE(TAG, "rotation aborted: frame still flushing after %d ms, keeping %d deg",
                 FLUSH_WAIT_TIMEOUT_MS, display_rotation);
        *result = LVGL_ROTATION_FLUSH_BUSY;
        return display_rotation;
    }

    int previous = display_rotation;
    if (disp_port->Set_Rotate((uint16_t)degrees) != ESP_OK)
    {
        ESP_LOGE(TAG, "rotation: MADCTL write failed, keeping %d deg", previous);
        /* 写失败时最好回滚一次（多数失败是总线错误，回滚也可能失败，忽略返回值）。 */
        (void)disp_port->Set_Rotate((uint16_t)previous);
        *result = LVGL_ROTATION_SPI_FAIL;
        return display_rotation;
    }

    display_rotation = degrees;
    lv_display_set_rotation(disp, lvgl_rotation_of(degrees));
    lv_obj_invalidate(lv_display_get_screen_active(disp));

    lv_mem_monitor(&mon);
    ESP_LOGI(TAG, "rotation -> %d via MADCTL 0x%02x, logical %dx%d, lvgl free=%u biggest=%u, flush_wait_timeouts=%u",
             display_rotation, (unsigned)disp_port->Get_Madctl(),
             (int)lv_display_get_horizontal_resolution(disp),
             (int)lv_display_get_vertical_resolution(disp),
             (unsigned)mon.free_size, (unsigned)mon.free_biggest_size, flush_wait_timeouts);
    return display_rotation;
}

extern "C" int Lvgl_SetDisplayRotation(int degrees)
{
    lvgl_rotation_result_t unused;
    return apply_display_rotation(degrees, &unused);
}

extern "C" void Lvgl_SetRotationDoneCallback(lvgl_rotation_done_cb_t callback)
{
    rotation_done_cb = callback;
}

/*
 * 请求改方向：在触摸事件回调里调用，只置位，不碰面板寄存器（此时可能正有
 * 一帧 QSPI 像素在飞，改 MADCTL 会让面板显示错位甚至白屏）。
 */
extern "C" int Lvgl_RequestDisplayRotation(int degrees)
{
    degrees %= 360;
    if (degrees < 0)
    {
        degrees += 360;
    }
    degrees = (degrees / 90) * 90;

    pending_rotation = degrees;
    rotation_flush_since = 0;
    rotation_pending = true;

    /* 返回当前已生效角度（请求是异步的；真正结果由完成回调给出）。 */
    return display_rotation;
}

/*
 * 消费旋转请求：必须是"没有帧在飞"的 tick 才动硬件，否则推迟到下一个 tick，
 * 不 busy-wait。顺序固定为 写 MADCTL -> lv_display_set_rotation() -> 整屏
 * invalidate，这样逻辑坐标和面板方向在同一帧里一起换，用户看不到中间态。
 */
static void rotation_timer_cb(lv_timer_t *timer)
{
    int degrees;
    lvgl_rotation_result_t result = LVGL_ROTATION_OK;
    lvgl_rotation_done_cb_t done;

    (void)timer;
    if (!rotation_pending || disp == NULL || disp_port == NULL)
    {
        return;
    }

    /* 有帧在飞：先等，但最多等 ROTATION_FLUSH_TIMEOUT_MS（20 ms 一 tick 轮询）。
     * 超时就放弃本次旋转、保留原方向并通知调用方，绝不无限 pending。 */
    if (disp->flushing)
    {
        uint32_t waited;

        if (rotation_flush_since == 0)
        {
            rotation_flush_since = lv_tick_get();
        }
        waited = lv_tick_elaps(rotation_flush_since);
        if (waited <= ROTATION_FLUSH_TIMEOUT_MS)
        {
            return;
        }
        rotation_pending = false;
        rotation_flush_since = 0;
        ESP_LOGE(TAG, "settings: rotation aborted (flush busy %u ms), keeping %d deg",
                 (unsigned)waited, display_rotation);
        done = rotation_done_cb;
        rotation_done_cb = NULL;
        if (done != NULL)
        {
            done(display_rotation, LVGL_ROTATION_FLUSH_BUSY);
        }
        return;
    }

    rotation_flush_since = 0;
    degrees = pending_rotation;
    rotation_pending = false;
    (void)apply_display_rotation(degrees, &result);
    done = rotation_done_cb;
    rotation_done_cb = NULL;
    if (done != NULL)
    {
        done(display_rotation, result);
    }
}

esp_err_t Lvgl_lock(int timeout_ms)
{
  	return esp_lv_adapter_lock(timeout_ms);      
}

void Lvgl_unlock(void)
{
  	esp_lv_adapter_unlock();
}

#if LVGL_VERSION_MAJOR >= 9
static void rounder_event_cb(lv_event_t *e)
{
    lv_area_t *area = (lv_area_t *)lv_event_get_param(e);
    uint16_t x1 = area->x1;
    uint16_t x2 = area->x2;

    uint16_t y1 = area->y1;
    uint16_t y2 = area->y2;

    // round the start of coordinate down to the nearest 2M number
    area->x1 = (x1 >> 1) << 1;
    area->y1 = (y1 >> 1) << 1;
    // round the end of coordinate up to the nearest 2N+1 number
    area->x2 = ((x2 >> 1) << 1) + 1;
    area->y2 = ((y2 >> 1) << 1) + 1;
}
#else
static void bsp_lvgl_rounder_cb(lv_disp_drv_t *disp_drv, lv_area_t *area)
{
    uint16_t x1 = area->x1;
    uint16_t x2 = area->x2;

    uint16_t y1 = area->y1;
    uint16_t y2 = area->y2;

    // round the start of coordinate down to the nearest 2M number
    area->x1 = (x1 >> 1) << 1;
    area->y1 = (y1 >> 1) << 1;
    // round the end of coordinate up to the nearest 2N+1 number
    area->x2 = ((x2 >> 1) << 1) + 1;
    area->y2 = ((y2 >> 1) << 1) + 1;
}
#endif

void Lvgl_PortInit(DisplayPort &display) {
    esp_lv_adapter_config_t cfg = ESP_LV_ADAPTER_DEFAULT_CONFIG();
    /* ESP32-C6 has a single core and no PSRAM: keep the LVGL task lean. */
    cfg.task_stack_size = 20 * 1024;
    cfg.task_priority = 8;
    cfg.task_core_id = 0;
    cfg.stack_in_psram = false;

    ESP_ERROR_CHECK(esp_lv_adapter_init(&cfg));
    esp_lcd_panel_handle_t panel_handle = display.Get_PanelHandle();
    esp_lcd_panel_io_handle_t io_handle = display.Get_IoHandle();
    esp_lv_adapter_display_config_t disp_cfg = ESP_LV_ADAPTER_DISPLAY_SPI_WITHOUT_PSRAM_DEFAULT_CONFIG(
        panel_handle,
        io_handle,
        BSP_LCD_H_RES,
        BSP_LCD_V_RES,
        ESP_LV_ADAPTER_ROTATE_0
    );
    /* 480 x 12 x 2 bytes = 11.25 KiB draw buffer, single buffered. */
    disp_cfg.profile.buffer_height = 12;
	
	disp = esp_lv_adapter_register_display(&disp_cfg);
    assert(disp != NULL);
    disp_port = &display;
    /* 启动时把当前方向（0 度）再写一遍，既覆盖 init 序列里的 0x36，也把
     * "MADCTL 写成功"打进日志，便于确认 QSPI 写通路正常。写失败不阻止启动：
     * 面板会停在 init 的 0 度，只是旋转按钮不可用。 */
    if (display.Set_Rotate(0) != ESP_OK)
    {
        ESP_LOGE(TAG, "rotation: baseline MADCTL write failed, rotation disabled");
    }
#if LVGL_VERSION_MAJOR >= 9
    lv_display_add_event_cb(disp, rounder_event_cb, LV_EVENT_INVALIDATE_AREA, NULL);

    /* 旋转在面板里做，这里只保留 adapter 自己的刷屏回调（它在 SPI 传输完成
     * 的中断里回调 flush_ready）；另外给 flush 等待加 100 ms 超时兜底。 */
    lv_display_set_flush_wait_cb(disp, flush_wait_timeout_cb);
    lv_timer_create(rotation_timer_cb, ROTATION_TICK_MS, NULL);
    ESP_LOGI(TAG, "display: %dx%d, render mode %d, draw buf %u B, rotation via SH8601 MADCTL",
             (int)BSP_LCD_H_RES, (int)BSP_LCD_V_RES, (int)lv_display_get_render_mode(disp),
             (unsigned)lv_display_get_draw_buf_size(disp));
#else
    lv_disp_t *disp_v8 = (lv_disp_t *)disp;
    if (disp_v8 && disp_v8->driver) {
        disp_v8->driver->rounder_cb = bsp_lvgl_rounder_cb;
    }
#endif

    if(display.Get_TouchInitialized()) {
        esp_lcd_touch_handle_t touch_handle = display.Get_TouchHandle();
        esp_lv_adapter_touch_config_t touch_cfg = ESP_LV_ADAPTER_TOUCH_DEFAULT_CONFIG(disp, touch_handle);
        lv_indev_t *touch = esp_lv_adapter_register_touch(&touch_cfg);
        assert(touch != NULL);
    }

	ESP_ERROR_CHECK(esp_lv_adapter_start());
}

void Lvgl_Refresh(void) {
    esp_lv_adapter_refresh_now(disp);
}
