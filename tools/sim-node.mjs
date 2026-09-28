#!/usr/bin/env node
// จำลอง node ของ GNOME (ตาม docs/PROTOCOL.md) ไว้ทดสอบ dashboard / rules ก่อนมีบอร์ดจริง
//   node tools/sim-node.mjs scout  [name]   → sensor node ส่ง temp/rh/lux/soil ทุก 10 s (ค่าวิ่งช้าๆ)
//   node tools/sim-node.mjs keeper [name]   → controller node รับ switch/<key>/command และเคารพ max_on
// ใช้ credentials จาก infra/.env · ปิดด้วย Ctrl-C (จะส่ง status offline ให้)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../core/package.json'));
const mqtt = require('mqtt');

const env = Object.fromEntries(readFileSync(path.join(here, '../infra/.env'), 'utf8').split('\n')
  .filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const role = process.argv[2] === 'keeper' ? 'keeper' : 'scout';
const node = process.argv[3] || `sim-${role}`;
const base = `gnome/${node}/`;
const client = mqtt.connect(`mqtt://${env.MQTT_HOST || '127.0.0.1'}:${env.MQTT_PORT || 1883}`, {
  username: env.MQTT_USER, password: env.MQTT_PASS, clientId: node,
  will: { topic: base + 'status', payload: 'offline', retain: true, qos: 1 },
});
const pub = (sub, payload, opts = {}) => client.publish(base + sub, String(payload), opts);
const log = (...a) => console.log(new Date().toLocaleTimeString('th-TH'), `[${node}]`, ...a);

// ---- scout ----
const sensors = [
  { key: 'temp_c', unit: '°C', src: 'sht3x', v: 31, min: 24, max: 38 },
  { key: 'rh_pct', unit: '%', src: 'sht3x', v: 65, min: 40, max: 95 },
  { key: 'lux', unit: 'lx', src: 'bh1750', v: 12000, min: 0, max: 60000 },
  { key: 'soil1_pct', unit: '%', src: 'adc', v: 55, min: 10, max: 95 },
  { key: 'soil2_pct', unit: '%', src: 'adc', v: 48, min: 10, max: 95 },
];
let soilDrift = -0.4; // ดินค่อยๆ แห้ง จนกว่า keeper จะรดน้ำ (ดู sim ทั้งสองตัวพร้อมกัน)
client.on('message', (t, p) => {
  if (t === 'gnomesim/water') { soilDrift = +3; setTimeout(() => (soilDrift = -0.4), 60000); log('💧 ได้รับน้ำ ดินจะชื้นขึ้น 1 นาที'); }
  if (t.startsWith(base)) handleCmd(t.slice(base.length), p.toString());
});

// ---- keeper ----
const switches = [
  { key: 'drip', pin: 26, active_low: true, max_on_s: 600, exclusive: ['mist'], on: false, timer: null },
  { key: 'mist', pin: 27, active_low: true, max_on_s: 600, exclusive: ['drip'], on: false, timer: null },
];
function setSwitch(sw, on, seconds, reason) {
  if (on) {
    for (const k of sw.exclusive) { const o = switches.find(x => x.key === k); if (o?.on) { setSwitch(o, false, 0, 'interlock'); pub('event', JSON.stringify({ type: 'interlock_blocked', node, key: o.key, by: sw.key }), { qos: 1 }); } }
    const dur = seconds > 0 && seconds < sw.max_on_s ? seconds : sw.max_on_s;
    clearTimeout(sw.timer); sw.on = true;
    sw.timer = setTimeout(() => { setSwitch(sw, false, 0, 'timer'); if (dur === sw.max_on_s) pub('event', JSON.stringify({ type: 'max_on_reached', node, key: sw.key }), { qos: 1 }); }, dur * 1000);
    if (sw.key === 'drip') client.publish('gnomesim/water', '1');
    log(`🔛 ${sw.key} ON ${dur}s (${reason})`);
  } else { clearTimeout(sw.timer); sw.on = false; log(`⏹ ${sw.key} OFF (${reason})`); }
  pub(`switch/${sw.key}/state`, sw.on ? 'ON' : 'OFF', { retain: true, qos: 1 });
}
function handleCmd(sub, payload) {
  if (sub === 'cmd/reboot') { log('reboot → ส่ง boot event'); pub('event', JSON.stringify({ type: 'boot', node, fw: `gnomeos-${role} sim` }), { qos: 1 }); return; }
  if (sub === 'cmd/identify') { log('✨ identify (LED กระพริบ)'); return; }
  if (sub === 'cmd/config') { log('config patch:', payload); pub('event', JSON.stringify({ type: 'config_changed', node }), { qos: 1 }); return; }
  const m = sub.match(/^switch\/([a-z0-9-]+)\/command$/);
  if (m && role === 'keeper') { const sw = switches.find(x => x.key === m[1]); if (!sw) return; const [s, sec] = payload.trim().toUpperCase().split(/\s+/); setSwitch(sw, s === 'ON', +sec || 0, 'mqtt'); }
}

client.on('connect', () => {
  log(`connected as ${role}`);
  pub('status', 'online', { retain: true, qos: 1 });
  const meta = { node, role, fw: `gnomeos-${role} 0.1.0-sim`, board: 'sim', mac: '00:11:22:33:44:55', ip: '127.0.0.1',
    sensors: role === 'scout' ? sensors.map(({ key, unit, src }) => ({ key, unit, src })) : [],
    switches: role === 'keeper' ? switches.map(({ key, pin, active_low, max_on_s, exclusive }) => ({ key, pin, active_low, max_on_s, exclusive })) : [] };
  pub('meta', JSON.stringify(meta), { retain: true, qos: 1 });
  pub('event', JSON.stringify({ type: 'boot', node, fw: meta.fw }), { qos: 1 });
  client.subscribe([base + 'switch/+/command', base + 'cmd/#', 'gnome/server/status', 'gnomesim/water']);
  if (role === 'scout') for (const s of sensors) pub(`sensor/${s.key}/meta`, JSON.stringify({ unit: s.unit, src: s.src }), { retain: true, qos: 1 });
  if (role === 'keeper') for (const sw of switches) { pub(`switch/${sw.key}/state`, 'OFF', { retain: true, qos: 1 }); pub(`switch/${sw.key}/meta`, JSON.stringify({ pin: sw.pin, active_low: sw.active_low, max_on_s: sw.max_on_s, exclusive: sw.exclusive }), { retain: true, qos: 1 }); }
});

setInterval(() => {
  if (!client.connected) return;
  if (role === 'scout') {
    const hour = new Date().getHours(); const day = hour >= 6 && hour <= 18;
    for (const s of sensors) {
      if (s.key.startsWith('soil')) s.v += soilDrift + (Math.random() - 0.5) * 0.3;
      else if (s.key === 'lux') s.v = day ? 8000 + 30000 * Math.sin(Math.PI * (hour - 6) / 12) + Math.random() * 2000 : Math.random() * 5;
      else s.v += (Math.random() - 0.5) * 0.4;
      s.v = Math.max(s.min, Math.min(s.max, s.v));
      pub(`sensor/${s.key}/state`, s.v.toFixed(s.key === 'lux' ? 0 : 1));
    }
    log(sensors.map(s => `${s.key}=${s.v.toFixed(1)}`).join(' '));
  }
}, 10000);
setInterval(() => client.connected && pub('debug', JSON.stringify({ rssi: -55 - Math.round(Math.random() * 10), uptime_s: Math.round(process.uptime()), heap: 180000, ip: '127.0.0.1' })), 60000);

process.on('SIGINT', () => { log('bye → status offline'); client.publish(base + 'status', 'offline', { retain: true, qos: 1 }, () => { client.end(); process.exit(0); }); });
