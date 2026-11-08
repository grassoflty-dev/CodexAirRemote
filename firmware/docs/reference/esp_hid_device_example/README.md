# ESP-IDF BLE HID device example (reference copy)

This directory is a reference copy of the ESP-IDF `esp_hid` BLE HID device
example (`examples/bluetooth/esp_hid/device`). It is **not** built as part of
the firmware: `firmware/main/ble_mouse.c` contains the minimal BLE HID mouse
code that Codex Air Remote actually uses.

Kept in the project so the BLE HID report-map, GAP advertising and pairing
logic can be compared against the reference implementation without needing a
local ESP-IDF source tree.

- Source: ESP-IDF 5.5.x, `examples/bluetooth/esp_hid/device`
- License: Apache License 2.0 (Espressif Systems)
- See `../../THIRD_PARTY_NOTICES.md` in the repository root for the full list.
