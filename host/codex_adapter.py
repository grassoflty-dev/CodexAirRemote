"""Submit recognized text using the signed-in Codex app server."""

import asyncio
import json
import os
import re
import shutil
import subprocess
import winreg
from pathlib import Path

from app_runtime import LOCAL, ROOT


def codex_executable():
    ps = (
        "$p=Get-AppxPackage OpenAI.Codex | Select-Object -First 1; "
        "if($p){Join-Path $p.InstallLocation 'app/resources/codex.exe'}"
    )
    path = subprocess.check_output(
        ["powershell.exe", "-NoProfile", "-Command", ps],
        text=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=10,
    ).strip()
    if path and Path(path).is_file():
        return path
    cli = shutil.which("codex.exe")
    if cli:
        return cli
    raise RuntimeError("Codex installation could not be found")


def codex_environment():
    env = os.environ.copy()
    if not env.get("HTTPS_PROXY"):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings") as key:
                enabled = winreg.QueryValueEx(key, "ProxyEnable")[0]
                proxy = winreg.QueryValueEx(key, "ProxyServer")[0]
            if enabled and re.fullmatch(r"(?:127\.0\.0\.1|localhost):\d+", proxy):
                env["HTTPS_PROXY"] = env["HTTP_PROXY"] = f"http://{proxy}"
        except OSError:
            pass
    return env


class Codex:
    def __init__(self):
        self.process = None
        self.reader = None
        self.pending = {}
        self.next_id = 1
        self.thread = None
        self.active_turn = None
        self.completed_turns = set()
        self.thread_file = LOCAL / "codex-thread.json"

    async def send(self, message):
        self.process.stdin.write(json.dumps(message, ensure_ascii=False).encode("utf-8") + b"\n")
        await self.process.stdin.drain()

    async def request(self, method, params):
        rpc_id = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[rpc_id] = future
        try:
            await self.send({"id": rpc_id, "method": method, "params": params})
            return await asyncio.wait_for(future, 15)
        finally:
            self.pending.pop(rpc_id, None)

    async def receive(self):
        try:
            async for line in self.process.stdout:
                message = json.loads(line)
                if "method" in message and "id" in message:
                    await self.send({"id": message["id"], "error": {
                        "code": -32000, "message": "Air Remote has no interactive approval interface"
                    }})
                elif "id" in message:
                    future = self.pending.get(message["id"])
                    if future is not None and not future.done():
                        if "error" in message:
                            future.set_exception(RuntimeError(message["error"].get("message", "Codex error")))
                        else:
                            future.set_result(message["result"])
                elif message.get("method") == "turn/completed":
                    params = message["params"]
                    if params.get("threadId") == self.thread:
                        turn = params["turn"]
                        self.completed_turns = {turn["id"]}
                        if self.active_turn == turn["id"]:
                            self.active_turn = None
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(RuntimeError("Codex connection ended"))

    async def start(self):
        cli = await asyncio.to_thread(codex_executable)
        self.process = await asyncio.create_subprocess_exec(
            cli, "app-server", "--listen", "stdio://",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, limit=8 * 1024 * 1024,
            cwd=str(ROOT), env=codex_environment(), creationflags=subprocess.CREATE_NO_WINDOW,
        )
        self.reader = asyncio.create_task(self.receive())
        await self.request("initialize", {"clientInfo": {
            "name": "codex_air_remote", "title": "Codex Air Remote", "version": "1.0.0",
        }})
        await self.send({"method": "initialized", "params": {}})

    async def close(self):
        if self.process:
            if self.process.returncode is None:
                self.process.terminate()
            await self.process.wait()
        if self.reader:
            await asyncio.gather(self.reader, return_exceptions=True)
        self.process = self.reader = self.thread = self.active_turn = None
        self.completed_turns.clear()

    async def open_thread(self):
        settings = {"cwd": str(ROOT), "sandbox": "read-only", "approvalPolicy": "never"}
        if self.thread_file.is_file():
            thread_id = json.loads(self.thread_file.read_text(encoding="utf-8"))["id"]
            result = await self.request("thread/resume", {"threadId": thread_id, **settings})
            if result["thread"]["id"] != thread_id:
                raise RuntimeError("Unexpected Codex conversation")
            self.thread = thread_id
            return
        result = await self.request("thread/start", settings)
        self.thread = result["thread"]["id"]
        tmp = self.thread_file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"id": self.thread}), encoding="utf-8")
        tmp.replace(self.thread_file)
        try:
            await self.request("thread/name/set", {"threadId": self.thread, "name": "Codex Air Remote"})
        except (RuntimeError, TimeoutError):
            pass

    async def submit(self, text):
        if not self.process or self.process.returncode is not None or self.reader.done():
            await self.close()
            try:
                await self.start()
            except Exception:
                await self.close()
                raise
        if not self.thread:
            await self.open_thread()
        if self.active_turn:
            raise RuntimeError("The Air Remote conversation is still working")
        result = await self.request("turn/start", {
            "threadId": self.thread,
            "input": [{"type": "text", "text": text, "text_elements": []}],
        })
        turn = result["turn"]
        if turn["status"] in {"failed", "interrupted"}:
            raise RuntimeError("Codex rejected the turn")
        if turn["status"] == "inProgress" and turn["id"] not in self.completed_turns:
            self.active_turn = turn["id"]
