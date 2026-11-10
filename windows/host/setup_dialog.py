"""USB flashing and Wi-Fi provisioning dialog for the Windows app."""

from queue import Empty, SimpleQueue
import os
import subprocess
from threading import Thread
import tkinter as tk
from tkinter import messagebox, ttk

from app_runtime import LOCAL, read_json, set_voice_target, voice_target
from flash import run_setup, validate_wifi


class SetupDialog:
    def __init__(self, parent):
        self.window = tk.Toplevel(parent)
        self.window.title("烧录开发板与配网")
        self.window.transient(parent)
        self.window.resizable(False, False)
        self.window.protocol("WM_DELETE_WINDOW", self.close)
        self.window.grab_set()
        self.busy = False
        self.events = SimpleQueue()

        content = ttk.Frame(self.window, padding=22)
        content.pack(fill="both", expand=True)
        ttk.Label(content, text="用 USB-C 数据线接好开发板，只连接要操作的这一块。",
                  wraplength=520).pack(anchor="w")
        ttk.Label(content, text="烧录会先备份原始 Flash，再写入并校验固件。两种配网方式任选其一。",
                  wraplength=520).pack(anchor="w", pady=(4, 14))

        saved = read_json(LOCAL / "network.json").get("mode")
        self.mode = tk.StringVar(value="lan" if saved == "lan" else "hotspot")
        ttk.Radiobutton(content, text="电脑开启 2.4 GHz 热点（自动配置）", value="hotspot",
                        variable=self.mode, command=self.update_fields).pack(anchor="w")
        ttk.Radiobutton(content, text="连接已有的 2.4 GHz Wi-Fi（与电脑在同一局域网）", value="lan",
                        variable=self.mode, command=self.update_fields).pack(anchor="w", pady=(4, 0))
        self.radios = tuple(widget for widget in content.winfo_children() if isinstance(widget, ttk.Radiobutton))

        network = ttk.Frame(content)
        network.pack(fill="x", pady=(10, 8))
        network.columnconfigure(1, weight=1)
        self.ssid = tk.StringVar()
        self.password = tk.StringVar()
        ttk.Label(network, text="Wi-Fi 名称").grid(row=0, column=0, sticky="w", padx=(0, 12))
        ttk.Label(network, text="Wi-Fi 密码").grid(row=1, column=0, sticky="w", padx=(0, 12))
        ssid_entry = ttk.Entry(network, textvariable=self.ssid, width=37)
        password_entry = ttk.Entry(network, textvariable=self.password, show="•", width=37)
        ssid_entry.grid(row=0, column=1, sticky="ew", pady=3)
        password_entry.grid(row=1, column=1, sticky="ew", pady=3)
        self.entries = (ssid_entry, password_entry)

        self.status = tk.StringVar(value="准备就绪后选择下方操作。")
        ttk.Label(content, textvariable=self.status, wraplength=520).pack(anchor="w", pady=(6, 7))
        self.progress = ttk.Progressbar(content, mode="indeterminate")
        self.progress.pack(fill="x")

        target = ttk.Frame(content)
        target.pack(fill="x", pady=(12, 0))
        ttk.Label(target, text="语音目标（板端 Voice 按钮接到哪里）",
                  font=("Microsoft YaHei UI", 10, "bold")).pack(anchor="w")
        self.voice_target = tk.StringVar(value=voice_target())
        self.target_radios = (
            ttk.Radiobutton(target, text="Codex 桌面听写（默认）", value="codex",
                            variable=self.voice_target, command=self.save_target),
            ttk.Radiobutton(target, text="DeepSeek Harness 语音输入（实验）", value="dsh",
                            variable=self.voice_target, command=self.save_target),
        )
        for radio in self.target_radios:
            radio.pack(anchor="w")
        self.target_hint = ttk.Label(target, text="", wraplength=520)
        self.target_hint.pack(anchor="w", pady=(4, 0))
        ttk.Label(target, text="设置立即保存，下一次语音会话生效（无需重启服务）。",
                  foreground="#506476").pack(anchor="w", pady=(4, 0))
        self.refresh_target_hint()

        actions = ttk.Frame(content)
        actions.pack(fill="x", pady=(14, 0))
        self.flash = ttk.Button(actions, text="开始烧录", style="Accent.TButton",
                                command=lambda: self.start(False))
        self.flash.pack(side="left")
        self.provision = ttk.Button(actions, text="只重新配网", command=lambda: self.start(True))
        self.provision.pack(side="left", padx=6)
        ttk.Button(actions, text="烧录日志", command=self.show_log).pack(side="right")
        self.update_fields()

    def update_fields(self):
        editable = not self.busy and self.mode.get() == "lan"
        for entry in self.entries:
            entry.configure(state="normal" if editable else "disabled")

    def refresh_target_hint(self):
        if self.voice_target.get() == "dsh":
            hint = ("音频经 VB-CABLE 作为 DeepSeek Harness 的麦克风：DSH 需在插件里启用「录音输入」、"
                    "准备好 SenseVoice 模型，并在语音插件详情把“输入设备”选为 CABLE Output。"
                    "若辅助程序无法自动点击 DSH 麦克风，请手动点“开始录音”，说完再点“停止并识别”；"
                    "识别结果进入 DSH 草稿，需要你自行发送。")
        else:
            hint = ("音频经 VB-CABLE 送入 Codex 听写；开始前把目标 Codex 对话放在前台，"
                    "A 发送、B 取消。")
        self.target_hint.configure(text=hint)

    def save_target(self):
        set_voice_target(self.voice_target.get())
        self.refresh_target_hint()
        name = "DeepSeek Harness 语音输入" if self.voice_target.get() == "dsh" else "Codex 桌面听写"
        self.status.set(f"语音目标已切换为：{name}（下一次语音会话生效）。")

    def start(self, provision_only):
        if self.busy:
            return
        wifi = (self.ssid.get(), self.password.get()) if self.mode.get() == "lan" else None
        if wifi is not None:
            try:
                validate_wifi(*wifi)
            except ValueError as exc:
                self.status.set(str(exc))
                return

        self.busy = True
        self.status.set("正在准备，请保持 USB 连接……")
        for widget in (*self.radios, *self.target_radios, self.flash, self.provision):
            widget.configure(state="disabled")
        self.update_fields()
        self.progress.start(16)
        Thread(target=self.worker, args=(wifi, provision_only), name="board-setup").start()
        self.window.after(100, self.poll)

    def worker(self, wifi, provision_only):
        try:
            paired = run_setup(wifi=wifi, provision_only=provision_only,
                               report=lambda message: self.events.put(("progress", message)))
        except subprocess.TimeoutExpired:
            self.events.put(("error", "操作超时。请查看烧录日志，再决定是否重试。"))
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
            self.events.put(("error", str(exc)))
        else:
            message = ("配置完成，蓝牙鼠标已配对。" if paired else
                       "配置完成。请在 Windows 蓝牙设置中添加 Codex Air Remote。")
            self.events.put(("done", message))

    def poll(self):
        while True:
            try:
                kind, message = self.events.get_nowait()
            except Empty:
                break
            self.status.set(message)
            if kind == "progress":
                continue
            self.busy = False
            self.progress.stop()
            for widget in (*self.radios, *self.target_radios, self.flash, self.provision):
                widget.configure(state="normal")
            if kind == "done":
                self.password.set("")
            self.update_fields()
        if self.busy:
            self.window.after(100, self.poll)

    def show_log(self):
        log = LOCAL / "setup.log"
        try:
            if log.is_file():
                os.startfile(log)
            else:
                messagebox.showinfo("烧录日志", "开始烧录或配网后会生成日志。", parent=self.window)
        except OSError as exc:
            messagebox.showerror("无法打开日志", str(exc), parent=self.window)

    def close(self):
        if self.busy:
            self.window.bell()
        else:
            self.window.destroy()
