import type { RpcMethod, RpcParams, RpcResults } from "@openorc/protocol";

export type Handlers = { [M in RpcMethod]: (params: RpcParams<M>) => Promise<RpcResults[M]> | RpcResults[M] };
type HandlerGroup = Partial<Handlers>;
type Combined<Groups extends readonly HandlerGroup[]> = Groups extends readonly [infer Head, ...infer Tail extends HandlerGroup[]] ? Head & Combined<Tail> : unknown;
type Disjoint<Groups extends readonly HandlerGroup[], Seen = never> = Groups extends readonly [infer Head, ...infer Tail extends HandlerGroup[]]
  ? Extract<keyof Head, Seen> extends never
    ? Disjoint<Tail, Seen | keyof Head>
    : false
  : true;
type Complete<Groups extends readonly HandlerGroup[]> = Exclude<RpcMethod, keyof Combined<Groups>> extends never ? true : false;

/** Explicit area groups must cover every RPC exactly once. Their method signatures are checked at their definitions. */
export function composeHandlers<const Groups extends readonly HandlerGroup[]>(
  ...groups: Groups & (Disjoint<Groups> extends true ? unknown : never) & (Complete<Groups> extends true ? unknown : never)
): Handlers {
  return Object.assign({}, ...groups) as Handlers;
}
