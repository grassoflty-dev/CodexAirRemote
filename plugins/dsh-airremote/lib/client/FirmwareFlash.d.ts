import { type FlashSocket } from './flash-socket.js';
/**
 * 设置区块：只有「固件身份 + 开始/取消 + 进度 + 日志」。
 * 串口选择、VID/PID、擦除整片这些都属于宿主侧决策，浏览器不再参与。
 */
export declare function FirmwareFlash({ onBoardChange, openSocket, socketCarrier, socketBase }: {
    onBoardChange?: (board: string | null) => void;
    /** 主路径由 DSH Connection service 提供；省略时用官方 base 解析兜底。 */
    openSocket?: () => FlashSocket;
    /** 诊断用：当前 carrier 与 base（不包含任何 token）。 */
    socketCarrier?: string;
    socketBase?: string;
}): import("react").JSX.Element;
