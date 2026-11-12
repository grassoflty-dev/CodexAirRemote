/**
 * 设置区块：只有「固件身份 + 开始/取消 + 进度 + 日志」。
 * 串口选择、VID/PID、擦除整片这些都属于宿主侧决策，浏览器不再参与。
 */
export declare function FirmwareFlash(): import("react").JSX.Element;
