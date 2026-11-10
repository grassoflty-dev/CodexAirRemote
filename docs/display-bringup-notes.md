# AMOLED bring-up notes (2026-11-10)

Field notes from the first real-hardware bring-up of the ESP32-C6 firmware on the
Waveshare ESP32-C6-Touch-AMOLED-2.16. Keep this file short: it exists so the next
person does not repeat a two-hour false alarm.

## 1. "Black screen" was an observation error, not a hardware or driver fault

The panel was **lit and rendering the whole time**. The UI background is
`#0b121d` (very dark) and the idle policy dimmed the AMOLED to 24 %, so at a
glance the screen looked dead, and the red diagnostic background merely read as
"still black" under the same dim light.

Lessons:

- Bring the panel up at **100 % brightness for the first seconds** after boot and
  only dim when idle. `app_ui.c` now starts at 100 %, drops to 70 % while active
  and to 24 % after 25 s without input.
- Any future "screen is black" report must be cross-checked with a **full
  brightness, high-contrast** frame (e.g. solid red at 100 %) before touching
  drivers.

## 2. Board-level code now mirrors the vendor example

`09_LVGL_V9_Test` from
`waveshareteam/ESP32-C6-Touch-AMOLED-2.16` (`02_Example/ESP-IDF-v5.5.3`) is the
reference for the board layer:

| Piece | Decision |
| --- | --- |
| `display_bsp.cpp` | Vendor copy, byte for byte. Do **not** clear `mosi/miso/quadwp/quadhd` to `-1`; in QSPI mode `quadwp/quadhd` carry data2/data3. |
| `i2c_bsp.cpp` | Identical to the vendor copy. |
| `power_bsp.cpp` | Vendor sequence: VBUS limit, DC1/ALDO1..4 = 3.3 V, charger currents. No extra rail enables, no second ALDO3 power cycle. |
| Pins | I2C 7/8, I2S 19/20/21/22/23, LCD CLK 0 / D0..D3 1..4 / CS 15, touch INT 5 / RST 11, SPI2_HOST. |
| `esp_lcd_sh8601` | Pinned to `1.0.0` in `main/idf_component.yml` (vendor example version). |

## 3. Memory budget on the 512 KiB C6

Three consumers that never run simultaneously were fighting for the same heap:

| Stage | Heap free (after) |
| --- | --- |
| boot | 169 920 |
| nvs + USB provisioning | 145 416 |
| voice init (task stack only now; PCM ring is lazy) | 138 928 |
| I2C + PMU | 137 612 |
| IMU | 133 016 |
| audio codec | 118 888 |
| display + LVGL | 82 904 |
| BLE (controller + HID) | 23 048 |
| UI widgets | 23 048 |
| LVGL heap in use | 12 272 of 18 164 |

Rules that fell out of this:

- The 16 KiB PCM ring is allocated **per voice session** (`voice.c`), because
  BLE is released before the session and resumed afterwards.
- `CONFIG_LV_MEM_SIZE=20480` is enough (UI peak 12.3 KiB). Raising it to 40 / 64
  KiB starves the BLE controller (`ESP_ERR_NO_MEM`).
- LVGL draw buffer: `buffer_height = 12` (11.5 KiB). The vendor value of 100
  needs 96 KiB and fails to allocate here.

## 4. BLE advertising

`esp_ble_gap_start_advertising()` returning `ESP_OK` does not mean the
advertising is on: the controller can answer the HCI command with
`0x07 Memory Full`. `ble_mouse.c` now

- reports success only from `ESP_GAP_BLE_ADV_START_COMPLETE_EVT` with
  `status == 0`, and
- retries the (idempotent) enable with a 200 / 500 / 1000 ms backoff on failure.

Verified boot log on the board:

```
I (1794) air_remote: heap after display+lvgl   free=82904
I (1903) ble_mouse: BLE HID started
I (1906) ble_mouse: BLE advertising started
I (1906) air_remote: heap after ble            free=23048
I (2013) air_remote: AIRREMOTE UI READY; IMU=1 BLE=1 VOICE=1 PMIC=1
$ AR1? -> AR1 READY 7 84c7bb3d7b76
```

## 5. Windows keeps the HID subscription, the device does not

The GATT server drops CCCD state on every reset, but Windows remembers the
subscription of a bonded device and does not rewrite the CCCD on reconnect.
Result: after a reboot (or after flashing a new image) the board advertises and
reconnects, yet every `esp_hidd_dev_input_set()` fails with "not enabled by
host", so the cursor never moves and A/B do nothing.

Storing a flag is not enough: `esp_hid` checks the GATT server CCCD *attribute*,
which is cleared on reset. `ble_mouse.c` therefore

1. remembers the CCCD handles (43 and 65 for this HID descriptor) and the
   subscribed flag in NVS (`airremote_ble/ccc`, `h0`, `h1`) when the host writes
   the CCCD, and
2. on every host connection calls
   `esp_ble_gatts_set_attr_value(handle, 2, {1,0})` before the first report.

Verified boot log after a plain reset, no re-pairing:

```
I (1899) ble_mouse: BLE HID started
I (1902) ble_mouse: CCCD load known=1 h0=43 h1=65
I (2974) ble_mouse: restore CCCD handle=43 -> ESP_OK
I (2975) ble_mouse: report dx=0 dy=0 btn=00 ret=ok
I (2976) ble_mouse: restoring CCCD subscription from NVS
```

## 6. IMU zero-rate calibration

`air_mouse.c` needs ~0.6 s of stillness after tapping Gyro (150 samples at
4 ms). The original thresholds (0.75 g / gyro² 25 / 200 samples) were too strict
for a hand-held board and timed out after 15 s; they are now 1.0 g / 64 /
150 samples with a 30 s timeout, and the UI shows
"Calibrating - hold the board still" and "Calibration failed, tap Gyro and hold
still" so the state is visible.

## 7. Physical buttons

| Key | Behaviour | Where |
| --- | --- | --- |
| PWR | Hold ~4 s to power off, short press to power on | `bsp_board/power_bsp.cpp` `Custom_PmicRegisterInit()`: AXP2101 `0x22 = 0x06` (PWRON long press is a power-off source) and `0x27 = 0x10` (4 s hold). Same values as the vendor example `02_Example/XiaoZhi-v2.2.5/main/boards/waveshare/esp32-c6-touch-amoled-2.16/esp32-c6-touch-amoled-2.16.cc` (Pmic constructor, `WriteReg(0x22, 0b110)` / `WriteReg(0x27, 0x10)`). Verified at boot: `PWRKEY long-press power-off enabled (0x22=6 0x27=16)`. |
| BOOT (GPIO9) | No firmware function (deliberate: the user only asked for the power key; GPIO9 is also a strapping pin) | — |
| RST | Hardware reset, firmware not involved | — |

The on-screen Voice/Gyro/A/B buttons are unchanged.
