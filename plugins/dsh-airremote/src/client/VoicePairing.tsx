import { useState } from 'react'

/** 只处理用户主动点击；浏览器不接触配对令牌或私钥。 */
export function VoicePairing() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run(rotate: boolean) {
    if (busy) return
    if (rotate && !window.confirm('更换后，所有已配对的电脑都要重新通过 USB 配对。继续吗？')) return
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch(rotate ? '/airremote/rotate-usb' : '/airremote/pair-usb', {
        method: 'POST', headers: { 'X-AirRemote-Pairing': '1' }
      })
      const data = await response.json() as { ok?: boolean; code?: string }
      if (response.ok && data.ok) {
        setMessage(rotate ? '板子正在重启。启动后请点「USB 配对」。' : '已配对。TLS 连接只信任这块板的证书。')
      } else if (data.code === 'busy') {
        setMessage('串口正在使用，请稍后重试。')
      } else if (data.code === 'local-only') {
        setMessage('请在这台电脑的本地 DSH 界面操作。')
      } else {
        setMessage('USB 操作失败。请只连接一块已更新固件的开发板并重试。')
      }
    } catch {
      setMessage('无法连接本机插件，请检查插件状态。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section style={{ display: 'grid', gap: '8px' }} aria-label="语音设备配对">
      <strong>语音设备配对</strong>
      <span>烧录新版固件后，用数据线连接开发板，再点 USB 配对。更换密钥不会清除蓝牙配对、Wi-Fi 或时区。</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
        <button type="button" disabled={busy} onClick={() => void run(false)}>USB 配对</button>
        <button type="button" disabled={busy} onClick={() => void run(true)}>更换设备密钥</button>
      </div>
      <span role="status" aria-live="polite">{message}</span>
    </section>
  )
}
