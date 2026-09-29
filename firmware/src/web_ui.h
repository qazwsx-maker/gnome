#pragma once
#include <pgmspace.h>
// หน้าเว็บบน node — ใช้ทั้งตอน captive portal (AP) และตอนอยู่ใน LAN
static const char WEB_UI[] PROGMEM = R"HTML(<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GnomeOS</title><style>
:root{color-scheme:light dark;--bg:#f9f9f7;--sf:#fff;--ink:#0b0b0b;--mut:#6b6a66;--bd:rgba(0,0,0,.12);--ac:#1f7a3a;--bad:#d03b3b;--ok:#0ca30c}
@media(prefers-color-scheme:dark){:root{--bg:#0d0d0d;--sf:#1a1a19;--ink:#fff;--mut:#a5a49c;--bd:rgba(255,255,255,.12);--ac:#4cc06f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,sans-serif}
.w{max-width:640px;margin:0 auto;padding:16px}h1{font-size:22px;margin:4px 0 2px}h2{font-size:16px;margin:18px 0 8px}
.c{background:var(--sf);border:1px solid var(--bd);border-radius:12px;padding:14px;margin-bottom:12px}
.mut{color:var(--mut);font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
label{display:block;font-size:12px;color:var(--mut);margin-top:8px}input,select,textarea{width:100%;padding:8px;border:1px solid var(--bd);border-radius:8px;background:transparent;color:var(--ink);font:inherit}
button{padding:8px 14px;border-radius:9px;border:1px solid var(--bd);background:var(--sf);color:var(--ink);font:inherit;cursor:pointer}button.p{background:var(--ac);color:#fff;border-color:transparent}button.d{color:var(--bad)}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--bad);margin-right:6px}.dot.on{background:var(--ok)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}.t{border:1px solid var(--bd);border-radius:10px;padding:8px 10px}.t b{font-size:20px;display:block}.t span{font-size:12px;color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:4px;border-bottom:1px solid var(--bd);text-align:left}td input{padding:5px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:8px}#msg{font-size:13px;color:var(--ac);min-height:18px}
</style></head><body><div class="w">
<h1>🌿 GnomeOS <span id="role" class="mut"></span></h1><div class="mut" id="sub">กำลังโหลด…</div>
<div class="c" id="st"><h2 style="margin-top:0">สถานะ</h2><div id="stbody"></div></div>
<div class="c"><h2 style="margin-top:0">ตั้งค่า</h2>
<label>ชื่อ node (a-z 0-9 -)</label><input id="node">
<div class="g2"><div><label>WiFi SSID</label><div class="row"><input id="wifi_ssid" style="flex:1"><button type="button" onclick="scan()">สแกน</button></div><select id="ssids" style="margin-top:6px;display:none" onchange="document.getElementById('wifi_ssid').value=this.value"></select></div>
<div><label>WiFi password</label><input id="wifi_pass" type="password" placeholder="(คงเดิมถ้าเว้นว่าง)"></div></div>
<div class="g2"><div><label>MQTT host (IP ของ Mac mini)</label><input id="mqtt_host"></div><div><label>MQTT port</label><input id="mqtt_port" type="number"></div></div>
<div class="g2"><div><label>MQTT user</label><input id="mqtt_user"></div><div><label>MQTT password</label><input id="mqtt_pass" type="password" placeholder="(คงเดิมถ้าเว้นว่าง)"></div></div>
<div class="g2"><div><label>I2C SDA</label><input id="i2c_sda" type="number"></div><div><label>I2C SCL</label><input id="i2c_scl" type="number"></div></div>
<div id="scoutcfg"><div class="g2"><div><label>ส่งค่าทุก (วินาที)</label><input id="interval_s" type="number"></div><div><label>DHT22 pin (-1 = ไม่ใช้)</label><input id="dht_pin" type="number"></div></div>
<label>หัววัด analog: ความชื้นดิน / ฝน (ADC1: 32 33 34 35 36 39) — key ว่าง = soil1, soil2… ใส่ <b>rain</b> สำหรับแผ่นวัดฝน · dry/wet = ค่า raw ที่วัดจริง</label>
<table><thead><tr><th>pin</th><th>key</th><th>dry (แห้ง)</th><th>wet (จุ่มน้ำ)</th><th></th></tr></thead><tbody id="soil"></tbody></table>
<div class="g2"><div><label>ขาจ่ายไฟหัววัด (VCC ของโมดูลต่อขานี้ เปิดเฉพาะตอนวัด ลดการกร่อน · -1 = ต่อ 3V3 ตรง)</label><input id="soil_power_pin" type="number"></div></div><button type="button" onclick="addSoil()">+ เพิ่มหัววัดดิน</button></div>
<div class="g2"><div><label>จอ OLED (I2C 0x3C)</label><select id="oled"><option value="sh1106">SH1106 (1.3")</option><option value="ssd1306">SSD1306 (0.96")</option><option value="none">ไม่มีจอ</option></select></div><div><label>บอร์ด</label><input id="board" disabled></div></div>
<div id="camcfg"><div class="g2"><div><label>ถ่ายภาพทุก (วินาที)</label><input id="cam_interval" type="number"></div><div><label>Hut URL (ว่าง = http://MQTT host:8080)</label><input id="hut_url" placeholder="http://192.168.1.111:8080"></div></div>
<label>Servo หัน (pan) — ขาว่างของ ESP32-CAM: 13, 14, 15 · -1 = ไม่มี servo</label>
<div class="g2"><div><label>servo pin</label><input id="servo_pin" type="number"></div><div><label>มุมปัจจุบัน <span id="ang_v" class="mut"></span></label><input id="servo_angle" type="range" min="0" max="180" oninput="document.getElementById('ang_v').textContent=this.value+'\u00B0'" onchange="post('/api/switch',{key:'pan',state:'ON',seconds:+this.value})"></div></div>
<div class="g2"><div><label>pulse min (µs)</label><input id="servo_min_us" type="number"></div><div><label>pulse max (µs)</label><input id="servo_max_us" type="number"></div></div>
<label><input type="checkbox" id="servo_invert" style="width:auto"> กลับทิศ servo</label>
<label>ตำแหน่งที่ตั้งไว้ (preset) — ใช้ถ่ายหลายมุม/หลายแปลงจากกล้องตัวเดียว</label>
<table><thead><tr><th>ชื่อ</th><th>มุม</th><th></th></tr></thead><tbody id="pre"></tbody></table>
<div class="row"><button type="button" onclick="addPre()">+ เพิ่ม preset</button><button type="button" onclick="post('/api/switch',{key:'patrol',state:'ON'})">ถ่ายทุก preset</button></div>
<div class="g2"><div><label>ขนาดภาพ</label><select id="cam_size"><option value="vga">VGA 640×480</option><option value="svga">SVGA 800×600</option><option value="xga">XGA 1024×768</option><option value="uxga">UXGA 1600×1200</option></select></div><div><label>ตัวเลือก</label><div class="row" style="margin-top:8px"><label style="margin:0"><input type="checkbox" id="cam_flash" style="width:auto"> ไฟแฟลชตอนถ่าย</label><label style="margin:0"><input type="checkbox" id="cam_flip" style="width:auto"> กลับภาพ 180°</label></div></div></div></div>
<div id="keepercfg"><div class="g2"><div><label>failsafe: ปิดทุกตัวถ้าขาด MQTT เกิน (วินาที)</label><input id="failsafe_s" type="number"></div></div>
<label>สวิตช์ / relay (สูงสุด 4)</label>
<table><thead><tr><th>key</th><th>pin</th><th>active low</th><th>max on (s)</th><th>exclusive</th><th></th></tr></thead><tbody id="sw"></tbody></table><button type="button" onclick="addSw()">+ เพิ่มสวิตช์</button></div>
<div class="row" style="margin-top:14px"><button class="p" onclick="save()">บันทึกและรีบูต</button><button onclick="post('/api/identify')">กระพริบไฟ</button><button onclick="post('/api/rescan')" id="rescan">สแกนเซ็นเซอร์</button><button class="d" onclick="if(confirm('รีบูต?'))post('/api/reboot')">รีบูต</button></div><div id="msg"></div></div>
<div class="c"><h2 style="margin-top:0">อัปเดต firmware (OTA)</h2><form method="POST" action="/update" enctype="multipart/form-data" class="row"><input type="file" name="fw" accept=".bin" style="flex:1"><button class="p">อัปโหลด</button></form><div class="mut">ไฟล์ firmware.bin จากหน้า flash ของ GNOME</div></div>
<div class="mut">GnomeOS <span id="fw"></span> · <a href="https://github.com/qazwsx-maker/gnome">github.com/qazwsx-maker/gnome</a></div></div>
<script>
const $=id=>document.getElementById(id);let role='';
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:b?JSON.stringify(b):''});const j=await r.json().catch(()=>({}));$('msg').textContent=j.msg||(j.ok?'สำเร็จ':'ผิดพลาด');return j}
function num(v){return v===''?undefined:+v}
async function load(){const c=await (await fetch('/api/config')).json();role=c.role;$('role').textContent=role==='keeper'?'Keeper · controller node':role==='cam'?'Watcher · camera node':'Scout · sensor node';
for(const k of ['node','wifi_ssid','mqtt_host','mqtt_port','mqtt_user','interval_s','dht_pin','soil_power_pin','i2c_sda','i2c_scl','failsafe_s','oled','board'])if($(k))$(k).value=c[k]??'';
$('scoutcfg').style.display=role==='scout'?'':'none';$('keepercfg').style.display=role==='keeper'?'':'none';$('rescan').style.display=role==='scout'?'':'none';$('camcfg').style.display=role==='cam'?'':'none';if(role==='cam'){$('cam_interval').value=c.interval_s??60;$('hut_url').value=c.hut_url||'';$('cam_size').value=c.cam_size||'svga';$('cam_flash').checked=!!c.cam_flash;$('cam_flip').checked=!!c.cam_flip;
$('servo_pin').value=c.servo_pin??-1;$('servo_min_us').value=c.servo_min_us??500;$('servo_max_us').value=c.servo_max_us??2400;$('servo_angle').value=c.servo_angle??90;$('ang_v').textContent=(c.servo_angle??90)+'\u00B0';$('servo_invert').checked=!!c.servo_invert;$('pre').innerHTML='';(c.presets||[]).forEach(p=>addPre(p))}
$('soil').innerHTML='';(c.soil||[]).forEach(s=>addSoil(s));$('sw').innerHTML='';(c.switches||[]).forEach(s=>addSw(s));status()}
function addSoil(s={}){const tr=document.createElement('tr');tr.innerHTML=`<td><input value="${s.pin??34}" type="number"></td><td><input value="${s.key??''}" placeholder="soil1"></td><td><input value="${s.dry??3100}" type="number"></td><td><input value="${s.wet??1300}" type="number"></td><td><button type="button" onclick="this.closest('tr').remove()">ลบ</button></td>`;$('soil').appendChild(tr)}
function addPre(p={}){const tr=document.createElement('tr');tr.innerHTML=`<td><input value="${p.name??''}" placeholder="plot-a"></td><td><input value="${p.angle??90}" type="number" min="0" max="180"></td><td><button type="button" onclick="post('/api/switch',{key:'pan',state:'ON',seconds:+this.closest('tr').querySelectorAll('input')[1].value})">ดู</button><button type="button" onclick="this.closest('tr').remove()">ลบ</button></td>`;$('pre').appendChild(tr)}
function addSw(s={}){const tr=document.createElement('tr');tr.innerHTML=`<td><input value="${s.key??''}" placeholder="drip"></td><td><input value="${s.pin??26}" type="number"></td><td><input type="checkbox" ${s.active_low!==false?'checked':''}></td><td><input value="${s.max_on_s??600}" type="number"></td><td><input value="${(s.exclusive||[]).join(',')}" placeholder="mist"></td><td><button type="button" onclick="this.closest('tr').remove()">ลบ</button></td>`;$('sw').appendChild(tr)}
async function save(){const b={};for(const k of ['node','wifi_ssid','mqtt_host','mqtt_user','oled'])b[k]=$(k).value;for(const k of ['mqtt_port','interval_s','dht_pin','soil_power_pin','i2c_sda','i2c_scl','failsafe_s'])if($(k).value!=='')b[k]=+$(k).value;
if($('wifi_pass').value)b.wifi_pass=$('wifi_pass').value;if($('mqtt_pass').value)b.mqtt_pass=$('mqtt_pass').value;
if(role==='cam'){b.interval_s=+$('cam_interval').value||60;b.hut_url=$('hut_url').value;b.cam_size=$('cam_size').value;b.cam_flash=$('cam_flash').checked;b.cam_flip=$('cam_flip').checked;
b.servo_pin=+$('servo_pin').value;b.servo_min_us=+$('servo_min_us').value;b.servo_max_us=+$('servo_max_us').value;b.servo_angle=+$('servo_angle').value;b.servo_invert=$('servo_invert').checked;
b.presets=[...$('pre').querySelectorAll('tr')].map(tr=>{const i=tr.querySelectorAll('input');return{name:i[0].value,angle:+i[1].value}}).filter(p=>p.name)}
b.soil=[...$('soil').querySelectorAll('tr')].map(tr=>{const i=tr.querySelectorAll('input');return{pin:+i[0].value,key:i[1].value,dry:+i[2].value,wet:+i[3].value}});
b.switches=[...$('sw').querySelectorAll('tr')].map(tr=>{const i=tr.querySelectorAll('input');return{key:i[0].value,pin:+i[1].value,active_low:i[2].checked,max_on_s:+i[3].value,exclusive:i[4].value.split(',').map(x=>x.trim()).filter(Boolean)}});
$('msg').textContent='กำลังบันทึก…';await post('/api/config',b);$('msg').textContent='บันทึกแล้ว กำลังรีบูต… ถ้าเปลี่ยน WiFi ให้กลับไปต่อ WiFi บ้านแล้วเปิด http://'+(b.node||'node')+'.local'}
async function scan(){$('msg').textContent='กำลังสแกน WiFi…';const l=await (await fetch('/api/scan')).json();const s=$('ssids');s.innerHTML='<option value="">— เลือก —</option>'+l.map(n=>`<option value="${n.ssid}">${n.ssid} (${n.rssi} dBm)</option>`).join('');s.style.display='';$('msg').textContent=''}
async function status(){try{const s=await (await fetch('/api/status')).json();$('fw').textContent=s.fw;$('sub').textContent=`${s.node} · ${s.ip} · RSSI ${s.rssi} dBm · uptime ${Math.floor(s.uptime_s/60)} นาที`;
let h=`<div class="row"><span><span class="dot ${s.wifi?'on':''}"></span>WiFi ${s.wifi?'ต่อแล้ว':'ยังไม่ต่อ'}${s.portal?' (โหมดตั้งค่า)':''}</span><span><span class="dot ${s.mqtt?'on':''}"></span>MQTT ${s.mqtt?'ต่อแล้ว':(s.mqtt_host?'ต่อไม่ได้':'ยังไม่ได้ตั้ง')}</span></div>`;
if(s.sensors&&Object.keys(s.sensors).length){h+='<div class="tiles" style="margin-top:10px">'+Object.entries(s.sensors).map(([k,v])=>`<div class="t"><b>${v.value==null?'—':(+v.value).toFixed(1)}</b><span>${k} ${v.unit||''} · ${v.src||''}</span></div>`).join('')+'</div>'}else if(role==='scout'){h+='<div class="mut" style="margin-top:8px">ยังไม่พบเซ็นเซอร์ — ต่อ I2C (SDA/SCL) แล้วกด "สแกนเซ็นเซอร์" หรือเพิ่มหัววัดดิน</div>'}
if(s.cam){h+=`<div style="margin-top:10px"><div class="mut">กล้อง ${s.cam.ok?'พร้อม':'<b>ไม่พบกล้อง</b>'}${s.cam.servo?` · หันอยู่ที่ ${s.cam.angle}\u00B0`:''} · ส่งแล้ว ${s.cam.uploads} ครั้ง (ล้มเหลว ${s.cam.fails}) · ล่าสุด ${s.cam.last_kb} kB → HTTP ${s.cam.last_code} ${s.cam.last_upload_s_ago>=0?s.cam.last_upload_s_ago+' วิ.ที่แล้ว':''}</div><div class="row" style="margin:6px 0"><button onclick="post('/api/switch',{key:'snap',state:'ON'})">ถ่ายและส่งตอนนี้</button><a href="${s.cam.stream}" target="_blank"><button>ดูสด</button></a><button onclick="post('/api/switch',{key:'flash',state:'${s.cam.flash?'OFF':'ON'}'})">ไฟแฟลช ${s.cam.flash?'ปิด':'เปิด'}</button></div><img src="${s.cam.snapshot}?t=${Date.now()}" style="width:100%;border-radius:10px;margin-top:6px" onerror="this.style.display='none'"></div>`}
if(s.switches&&s.switches.length){h+='<div style="margin-top:10px">'+s.switches.map(w=>`<div class="row" style="margin:6px 0"><span class="dot ${w.state==='ON'?'on':''}"></span><b style="min-width:70px">${w.key}</b><span class="mut">${w.state}${w.remaining_s?' · เหลือ '+w.remaining_s+' s':''}</span><button onclick="post('/api/switch',{key:'${w.key}',state:'ON',seconds:+document.getElementById('sec_${w.key}').value})">ON</button><input id="sec_${w.key}" type="number" value="60" style="width:70px"><span class="mut">s</span><button onclick="post('/api/switch',{key:'${w.key}',state:'OFF'})">OFF</button></div>`).join('')+'</div>'}
$('stbody').innerHTML=h}catch(e){}}
load();setInterval(status,5000);
</script></body></html>)HTML";
