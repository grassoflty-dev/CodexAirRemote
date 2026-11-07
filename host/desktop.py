"""Windows interface and frozen executable entry point for Codex Air Remote."""

import argparse
import os
from pathlib import Path
import sys
import time
from virtual_mic import audio_check

from app_runtime import (
    LOCAL, STATE, launch_service, preferences, provisioned, read_json,
    service_running, set_preferences, write_json,
)

PHASES = {
    "loading": "正在启动服务",
    "listening": "等待设备录音",
    "connecting": "正在连接设备",
    "receiving": "正在连接 Codex 听写或接收录音",
    "finishing": "正在结束 Codex 听写",
    "network_error": "热点启动失败",
    "stopping": "正在结束当前任务",
}
RESULTS = {
    "SENT": "Codex 已接收",
    "SAVED": "发送未确认，文字已保存",
    "EMPTY": "录音太短或没有音频",
    "FAILED": "听写失败，查看运行日志",
    "CANCELLED": "本次听写已取消",
    "DRAFTED": "已触发保留草稿，请在 Codex 查看",
    "SUBMITTED": "已触发转录并发送，请在 Codex 查看",
    "CABLE_MISSING": "没有检测到 VB-CABLE",
    "CABLE_NOT_DEFAULT": "请将 CABLE Output 设为默认麦克风",
    "DICTATION_UNAVAILABLE": "听写未就绪，请将目标 Codex 窗口放在前台",
    "DICTATION_UNCONFIRMED": "操作结果未确认，请在 Codex 查看",
    "CONNECTION_ERROR": "设备连接中断",
}


def open_window():
    import tkinter as tk
    from tkinter import messagebox, ttk
    from setup_dialog import SetupDialog

    root = tk.Tk()
    root.title("Codex Air Remote")
    root.geometry("680x655")
    root.minsize(605, 630)
    root.configure(background="#edf3f6")

    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", font=("Microsoft YaHei UI", 10), foreground="#192a39")
    style.configure("Paper.TFrame", background="#ffffff")
    style.configure("Paper.TLabel", background="#ffffff")
    style.configure("Muted.TLabel", background="#ffffff", foreground="#506476")
    style.configure("Status.TLabel", background="#ffffff", font=("Microsoft YaHei UI", 19, "bold"))
    style.configure("Accent.TButton", background="#12635d", foreground="#ffffff", padding=(15, 8))
    style.map("Accent.TButton", background=[("disabled", "#cbd5dc"), ("active", "#0b514b")],
              foreground=[("disabled", "#556572")])
    style.configure("TButton", padding=(13, 8))
    style.configure("Plain.TLabel", background="#edf3f6", foreground="#506476")

    top = tk.Frame(root, background="#123545", padx=28, pady=21)
    top.pack(fill="x")
    tk.Label(top, text="CODEX  /  AIR REMOTE", font=("Segoe UI", 10, "bold"),
             background="#123545", foreground="#99ddd2").pack(anchor="w")
    tk.Label(top, text="开发板辅助程序", font=("Microsoft YaHei UI", 23, "bold"),
             background="#123545", foreground="#ffffff").pack(anchor="w", pady=(3, 0))

    body = tk.Frame(root, background="#edf3f6", padx=24, pady=17)
    body.pack(fill="both", expand=True)

    status_card = ttk.Frame(body, padding=(19, 14), style="Paper.TFrame")
    status_card.pack(fill="x")
    ttk.Label(status_card, text="服务状态", style="Muted.TLabel").pack(anchor="w")
    phase = tk.StringVar()
    ttk.Label(status_card, textvariable=phase, style="Status.TLabel").pack(anchor="w", pady=(3, 4))
    detail = tk.StringVar()
    ttk.Label(status_card, textvariable=detail, style="Muted.TLabel").pack(anchor="w")

    setup = ttk.Frame(body, padding=(19, 12), style="Paper.TFrame")
    setup.pack(fill="x", pady=(12, 0))
    ttk.Label(setup, text="设备连接", style="Paper.TLabel",
              font=("Microsoft YaHei UI", 11, "bold")).pack(anchor="w")
    network_status = tk.StringVar()
    ttk.Label(setup, textvariable=network_status, style="Muted.TLabel",
              wraplength=540).pack(anchor="w", pady=(4, 0))
    setup_actions = ttk.Frame(setup, style="Paper.TFrame")
    setup_actions.pack(fill="x", pady=(8, 0))
    dialog = None

    def open_setup():
        nonlocal dialog
        if dialog is not None and dialog.window.winfo_exists():
            dialog.window.lift()
        else:
            dialog = SetupDialog(root)

    def close():
        if dialog is not None and dialog.window.winfo_exists() and dialog.busy:
            dialog.window.bell()
        else:
            root.destroy()

    root.protocol("WM_DELETE_WINDOW", close)
    ttk.Button(setup_actions, text="烧录开发板", command=open_setup,
               style="Accent.TButton").pack(side="left")
    ttk.Button(setup_actions, text="蓝牙设置",
               command=lambda: open_link("ms-settings:bluetooth")).pack(side="left", padx=6)

    voice = ttk.Frame(body, padding=(19, 12), style="Paper.TFrame")
    voice.pack(fill="x", pady=(12, 0))
    ttk.Label(voice, text="Codex 桌面听写", style="Paper.TLabel",
              font=("Microsoft YaHei UI", 11, "bold")).pack(anchor="w")
    ttk.Label(voice, text="板载麦克风通过 VB-CABLE 接入 Codex。开始前请将目标 Codex 对话放在前台。",
              style="Muted.TLabel", wraplength=560).pack(anchor="w", pady=(4, 0))
    audio_status = tk.StringVar()
    ttk.Label(voice, textvariable=audio_status, style="Muted.TLabel").pack(anchor="w", pady=(4, 0))

    def open_link(uri):
        try:
            os.startfile(uri)
        except OSError as exc:
            messagebox.showerror("无法打开", str(exc), parent=root)

    voice_actions = ttk.Frame(voice, style="Paper.TFrame")
    voice_actions.pack(fill="x", pady=(8, 0))
    ttk.Button(voice_actions, text="Windows 声音设置",
               command=lambda: open_link("ms-settings:sound")).pack(side="left", padx=(0, 6))
    ttk.Button(voice_actions, text="VB-CABLE 下载",
               command=lambda: open_link("https://vb-audio.com/Cable/")).pack(side="left")
    last_result = tk.StringVar()
    launching_at = 0.0
    ttk.Label(body, textvariable=last_result, style="Plain.TLabel").pack(anchor="w", pady=(13, 8))

    actions = tk.Frame(body, background="#edf3f6")
    actions.pack(fill="x")

    def start():
        nonlocal launching_at
        try:
            set_preferences(True)
            if not service_running():
                launch_service()
                launching_at = time.monotonic()
        except (OSError, RuntimeError) as exc:
            messagebox.showerror("启动失败", str(exc), parent=root)
        refresh_state()

    def stop():
        try:
            set_preferences(False)
        except OSError as exc:
            messagebox.showerror("停止失败", str(exc), parent=root)
        refresh_state()

    def reveal(path):
        try:
            os.startfile(path)
        except OSError as exc:
            messagebox.showerror("无法打开", str(exc), parent=root)

    def open_log():
        log = LOCAL / "companion.log"
        if log.exists():
            reveal(log)
        else:
            messagebox.showinfo("运行日志", "服务启动后会生成日志。", parent=root)

    start_button = ttk.Button(actions, text="启动服务", command=start, style="Accent.TButton")
    start_button.pack(side="left")
    stop_button = ttk.Button(actions, text="停止服务", command=stop)
    stop_button.pack(side="left", padx=(8, 0))
    ttk.Button(actions, text="运行日志", command=open_log).pack(side="right", padx=(0, 8))

    def refresh_state():
        enabled = preferences()
        running = service_running()
        launching = not running and launching_at != 0 and time.monotonic() - launching_at < 4
        mode = read_json(LOCAL / "network.json").get("mode")
        ready = mode in {"lan", "hotspot"}
        network = {"lan": "同一局域网", "hotspot": "Windows 2.4 GHz 热点"}.get(mode, "待配网")
        network_status.set(f"鼠标 · 蓝牙    麦克风 · {network}")
        state = read_json(STATE)
        current = state.get("phase")
        last_result.set("最近一次设备语音状态  ·  " + RESULTS.get(state.get("last"), "暂无记录"))
        if not ready:
            phase.set("等待首次烧录")
            detail.set("用 USB-C 数据线连接开发板，再点「烧录开发板」。")
        elif running or launching:
            if not enabled:
                phase.set("正在停止服务")
                detail.set("当前录音和已提交的 Codex 请求完成后停止。")
            elif launching or current in {None, "stopped", "error"}:
                phase.set("正在启动服务")
                detail.set("正在准备连接开发板。")
            else:
                phase.set(PHASES.get(current, "正在启动服务"))
                if current == "network_error":
                    detail.set("请查看运行日志。服务会重试启动热点。")
                else:
                    detail.set("设备连接服务运行中。")
        elif current == "error":
            phase.set("服务启动失败")
            detail.set("查看运行日志，再尝试启动服务。")
        else:
            phase.set("服务已停止")
            detail.set("启动服务后，使用开发板 Voice 控制 Codex 听写。")
        start_button.configure(state="disabled" if not ready or ((running or launching) and enabled) else "normal")
        stop_button.configure(state="normal" if (running or launching) and enabled else "disabled")

    def refresh_audio():
        status = audio_check()
        audio_status.set("虚拟麦克风已就绪" if status == "CABLE_READY" else RESULTS[status])
        root.after(2500, refresh_audio)

    def refresh():
        refresh_state()
        root.after(600, refresh)

    if provisioned() and preferences() and not service_running():
        start()
    refresh_audio()
    refresh()
    root.mainloop()


def self_test(report):
    import asyncio
    from companion import check_codex

    result = {"ok": False}
    try:
        asyncio.run(check_codex())
        result["ok"] = True
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
    write_json(report, result)
    return 0 if result["ok"] else 1


def esptool_worker():
    output = Path(sys.argv[2])
    sys.argv = ["esptool", *sys.argv[3:]]
    with output.open("w", encoding="utf-8", buffering=1) as stream:
        previous_stdout, previous_stderr = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = stream
        try:
            import esptool
            esptool._main()
        finally:
            sys.stdout, sys.stderr = previous_stdout, previous_stderr
    return 0


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "--esptool-worker":
        return esptool_worker()
    parser = argparse.ArgumentParser()
    parser.add_argument("--service", action="store_true")
    parser.add_argument("--test-report", type=Path)
    args = parser.parse_args()
    if args.test_report:
        return self_test(args.test_report)
    if args.service:
        from companion import run_service
        run_service()
        return 0
    open_window()
    return 0


if __name__ == "__main__":
    from multiprocessing import freeze_support
    freeze_support()
    raise SystemExit(main())
