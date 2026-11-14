/** Human reason for a failed sync; unknown codes fall back to the host message. */
export declare function syncFailureText(error: string | undefined, message: string | undefined): string;
/**
 * Settings section: the board keeps UTC in its RTC, the display offset lives in
 * NVS. Picking a zone only persists the choice. A serial round-trip happens on
 * the explicit button press, or automatically on host startup / board session
 * when 「自动对时」 is on (the default); this panel never polls.
 */
export declare function DevBoardTime({ port }: {
    port?: string | null;
}): import("react").JSX.Element;
