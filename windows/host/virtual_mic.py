"""Send board PCM only to the dedicated VB-CABLE playback endpoint."""

import asyncio
import audioop
from collections import deque
import ctypes as ct
from ctypes import wintypes as wt

WINMM = ct.WinDLL("winmm")
PCM_HZ = 16000
CABLE_HZ = 48000


class CableSetupError(RuntimeError):
    pass


class WaveCaps(ct.Structure):
    _fields_ = [("manufacturer", wt.WORD), ("product", wt.WORD), ("version", wt.DWORD),
                ("name", wt.WCHAR * 32), ("formats", wt.DWORD), ("channels", wt.WORD),
                ("reserved", wt.WORD), ("support", wt.DWORD)]


class WaveFormat(ct.Structure):
    _pack_ = 1
    _fields_ = [("tag", wt.WORD), ("channels", wt.WORD), ("rate", wt.DWORD),
                ("byte_rate", wt.DWORD), ("align", wt.WORD), ("bits", wt.WORD),
                ("extra", wt.WORD)]


class WaveHeader(ct.Structure):
    _fields_ = [("data", ct.c_void_p), ("length", wt.DWORD), ("recorded", wt.DWORD),
                ("user", ct.c_size_t), ("flags", wt.DWORD), ("loops", wt.DWORD),
                ("next", ct.c_void_p), ("reserved", ct.c_size_t)]


def device_name(api, device):
    caps = WaveCaps()
    if api(device, ct.byref(caps), ct.sizeof(caps)):
        return ""
    return caps.name.casefold()


def cable_device():
    outputs = [index for index in range(WINMM.waveOutGetNumDevs())
               if device_name(WINMM.waveOutGetDevCapsW, index).startswith("cable input (vb-audio")]
    inputs = [index for index in range(WINMM.waveInGetNumDevs())
              if device_name(WINMM.waveInGetDevCapsW, index).startswith("cable output (vb-audio")]
    if len(outputs) != 1 or len(inputs) != 1:
        raise CableSetupError("CABLE_MISSING")

    preferred, flags = wt.DWORD(), wt.DWORD()
    # DRVM_MAPPER_PREFERRED_GET for the Windows default recording endpoint.
    result = WINMM.waveInMessage(ct.c_void_p(0xFFFFFFFF), 0x2015,
                                 ct.byref(preferred), ct.byref(flags))
    if result or preferred.value != inputs[0]:
        raise CableSetupError("CABLE_NOT_DEFAULT")
    return outputs[0]


def audio_check():
    try:
        cable_device()
    except CableSetupError as exc:
        return str(exc)
    return "CABLE_READY"


def check(result):
    if result:
        raise RuntimeError(f"Windows audio error {result}")


class CablePlayback:
    def __init__(self, device):
        self.handle = ct.c_void_p()
        self.buffers = deque()
        self.conversion = None
        fmt = WaveFormat(1, 1, CABLE_HZ, 2 * CABLE_HZ, 2, 16, 0)
        check(WINMM.waveOutOpen(ct.byref(self.handle), device, ct.byref(fmt), 0, 0, 0))

    def reclaim(self):
        while self.buffers and self.buffers[0][0].flags & 1:  # WHDR_DONE
            header, _ = self.buffers[0]
            check(WINMM.waveOutUnprepareHeader(self.handle, ct.byref(header), ct.sizeof(header)))
            self.buffers.popleft()

    async def write(self, pcm):
        self.reclaim()
        if len(self.buffers) >= 30:
            async with asyncio.timeout(4):
                while len(self.buffers) >= 30:
                    await asyncio.sleep(0.01)
                    self.reclaim()
        converted, self.conversion = audioop.ratecv(pcm, 2, 1, PCM_HZ, CABLE_HZ, self.conversion)
        data = ct.create_string_buffer(converted)
        header = WaveHeader(ct.addressof(data), len(converted))
        check(WINMM.waveOutPrepareHeader(self.handle, ct.byref(header), ct.sizeof(header)))
        result = WINMM.waveOutWrite(self.handle, ct.byref(header), ct.sizeof(header))
        if result:
            WINMM.waveOutUnprepareHeader(self.handle, ct.byref(header), ct.sizeof(header))
            check(result)
        self.buffers.append((header, data))

    async def drain(self):
        await self.write(bytes(PCM_HZ // 2))  # Allow the capture endpoint to receive the tail.
        async with asyncio.timeout(6):
            while self.buffers:
                self.reclaim()
                await asyncio.sleep(0.01)

    def close(self):
        try:
            check(WINMM.waveOutReset(self.handle))
            self.reclaim()
        finally:
            check(WINMM.waveOutClose(self.handle))
