import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SerialHolder } from './serial-holder.js';
/** USB identity operations are local-only and never return credentials to the browser. */
export declare function pairingHandler(dataDir: string, holder: SerialHolder, rotate?: boolean): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
