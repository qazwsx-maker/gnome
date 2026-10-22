declare module 'multicast-dns' {
  interface MDNS { on(ev: string, cb: (...a: any[]) => void): void; query(q: any): void; respond(r: any): void; destroy(): void; }
  function mdns(opts?: any): MDNS;
  export default mdns;
}
