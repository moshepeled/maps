/**
 * Client-IP trust (SPEC section 10.7.6): TRUST_PROXY is `false`, a hop count or a proxy-addr list. Fastify 5 deliberately
 * fails closed on a bare number, so a hop count is turned into the equivalent function: trust the first `n` hops
 * counted from the socket peer (`1` = nginx, which overwrites X-Forwarded-For with $remote_addr).
 */
export type TrustProxySetting = boolean | number | string[];
export type TrustProxyOption = boolean | string[] | ((address: string, hop: number) => boolean);

export function toFastifyTrustProxy(setting: TrustProxySetting): TrustProxyOption {
  if (typeof setting !== 'number') return setting;
  const hops = setting;
  return (_address, hop) => hop < hops;
}
