// จำลอง Sonoff DIY mode 1 ตัว (ประกาศ mDNS + HTTP :8081) ไว้ทดสอบ bridge โดยไม่ต้องมีของจริง
// ใช้: node tools/sonoff-mock.js [deviceid] [port] [encrypted]
import mdns from 'multicast-dns';
import http from 'node:http';
import os from 'node:os';
const id = (process.argv[2] || '100000140e').toLowerCase();
const port = Number(process.argv[3] || 8081);
const encrypted = process.argv[4] === 'encrypted';
const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';
const st = { switch: 'off', startup: 'stay', pulse: 'off', pulseWidth: 500, rssi: -58, fwVersion: '3.6.0' };
let pulseTimer = null; let seq = 1;
const inst = `eWeLink_${id}._ewelink._tcp.local`; const host = `eWeLink_${id}.local`;
const txt = () => [`txtvers=1`, `id=${id}`, `type=diy_plug`, `apivers=1`, `seq=${seq}`, encrypted ? `encrypt=true` : `encrypt=false`,
  `data1=${encrypted ? 'Zm9vYmFy' : JSON.stringify({ switch: st.switch, startup: st.startup, pulse: st.pulse, pulseWidth: st.pulseWidth, rssi: st.rssi })}`];
const m = mdns();
const answer = () => m.respond({ answers: [
  { name: '_ewelink._tcp.local', type: 'PTR', ttl: 120, data: inst },
  { name: inst, type: 'SRV', ttl: 120, data: { port, target: host } },
  { name: inst, type: 'TXT', ttl: 120, data: txt() },
  { name: host, type: 'A', ttl: 120, data: ip },
] });
m.on('query', (q) => { if (q.questions.some((x) => x.name === '_ewelink._tcp.local')) answer(); });
setInterval(answer, 20000); answer();
http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ seq: ++seq, error: 0, ...o })); };
    if (encrypted) { res.statusCode = 401; return res.end(JSON.stringify({ seq, error: 401 })); }
    if (!j.deviceid || j.deviceid !== id) { res.statusCode = 200; return res.end(JSON.stringify({ seq, error: 404 })); }
    const d = j.data || {};
    console.log(new Date().toISOString(), req.url, JSON.stringify(d));
    switch (req.url) {
      case '/zeroconf/info': return send({ data: { ...st, deviceid: id, ssid: 'home', otaUnlock: false, signalStrength: st.rssi } });
      case '/zeroconf/switch':
        st.switch = d.switch === 'on' ? 'on' : 'off';
        if (pulseTimer) { clearTimeout(pulseTimer); pulseTimer = null; }
        if (st.switch === 'on' && st.pulse === 'on') pulseTimer = setTimeout(() => { st.switch = 'off'; console.log(new Date().toISOString(), 'pulse auto-off'); }, st.pulseWidth);
        return send({});
      case '/zeroconf/pulse': st.pulse = d.pulse === 'on' ? 'on' : 'off'; if (typeof d.pulseWidth === 'number') st.pulseWidth = d.pulseWidth; return send({});
      case '/zeroconf/startup': st.startup = d.startup; return send({});
      case '/zeroconf/signal_strength': return send({ data: { signalStrength: st.rssi } });
      default: res.statusCode = 404; return res.end(JSON.stringify({ seq, error: 404 }));
    }
  });
}).listen(port, () => console.log(`mock sonoff ${id} ${encrypted ? '(encrypted)' : '(DIY)'} at http://${ip}:${port}`));
