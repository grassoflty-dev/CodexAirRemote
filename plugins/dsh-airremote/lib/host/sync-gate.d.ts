/**
 * host 侧「同一时刻只允许一次串口校时」的闸门。
 *
 * 手动同步（`POST /airremote/sync-time`）和自动对时（`AutoTimeSync`）是两条独立路径，
 * 但写的是同一个串口；只靠各自的 busy 标记挡不住对方（串口锁对同名的 `sync` 是幂等的），
 * 所以由 `index.ts` 建一个实例注入两边共享。
 *
 * 纯内存、同步、不排队：抢不到就跳过，绝不让请求或对时等着。
 */
export declare class SyncGate {
    private busy;
    /** 抢闸门：已经有人用时返回 false。 */
    tryEnter(): boolean;
    /** 放闸门：无论之前是谁抢到的，都直接清空（调用方保证成对使用）。 */
    leave(): void;
    /** 当前是否有人正在同步（只读，供日志 / 测试）。 */
    get locked(): boolean;
}
