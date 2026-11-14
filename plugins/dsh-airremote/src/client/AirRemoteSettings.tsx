import { DevBoardTime } from './DevBoardTime.js'
import { FirmwareFlash } from './FirmwareFlash.js'

/**
 * Single settings page for the plugin: board time on top, firmware flashing
 * below. Both blocks keep their own state and host routes; this component only
 * puts them on one page so Settings shows one "Air remote" entry instead of two.
 */
export function AirRemoteSettings() {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '20px', padding: '4px 2px' }}>
      <DevBoardTime />
      <div aria-hidden="true" style={{ height: '1px', background: 'rgba(128, 128, 128, 0.25)' }} />
      <FirmwareFlash />
    </section>
  )
}

/** Icon for the settings rail row; same motif as the bundle icon. */
export function AirRemoteSettingsIcon() {
  return (
    <svg viewBox="0 0 36 36" width="20" height="20" aria-hidden="true">
      <rect x="5.5" y="4.5" width="25" height="17.5" rx="3" fill="#101a2b" stroke="#3f7ae0" strokeWidth="2" />
      <rect x="11.2" y="10.8" width="2.4" height="5.2" rx="1.2" fill="#4f8cff" />
      <rect x="15.6" y="8.4" width="2.4" height="10" rx="1.2" fill="#7fb0ff" />
      <rect x="20" y="9.8" width="2.4" height="7.2" rx="1.2" fill="#4f8cff" />
      <rect x="24.4" y="11.6" width="2.4" height="3.6" rx="1.2" fill="#7fb0ff" />
      <rect x="13.5" y="25.5" width="9" height="7" rx="2.4" fill="#2b3a52" />
      <circle cx="18" cy="28.4" r="1.2" fill="#9fb6d6" />
      <rect x="15.6" y="30.2" width="4.8" height="1.1" rx="0.55" fill="#6f88a8" />
    </svg>
  )
}
