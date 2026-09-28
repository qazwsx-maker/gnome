// Tiny timestamped logger: 2026-09-28T10:00:00.000Z [mqtt] message

function fmt(level: string, tag: string, args: unknown[]): string {
  const msg = args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  return `${new Date().toISOString()} ${level} [${tag}] ${msg}`;
}

export function logger(tag: string) {
  return {
    info: (...args: unknown[]) => console.log(fmt('INFO', tag, args)),
    warn: (...args: unknown[]) => console.warn(fmt('WARN', tag, args)),
    error: (...args: unknown[]) => console.error(fmt('ERR ', tag, args)),
  };
}
