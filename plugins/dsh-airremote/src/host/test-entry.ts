/** Internal exports used by the local integration tests (`lib/host-test.js`). */
export { AudioRoute } from './audio-route.js'
export { BoardSession } from './board-session.js'
export { BoardDiscovery } from './discovery.js'
export { FakeBoard } from './fake-board.js'
export { acceptWebSocket, connectWebSocket } from './ws.js'
export { parseAudioFrame, encodeAudioFrame, authMessage } from './protocol.js'
