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
<div id="scoutcfg"><div class="g2"><div><label>ส่งค่าทุก (วินาที)</label><input id="interval_s" type="number"></div><div><label>DHT22 pin (-1 = ไม่ใช้)</label><input id="dht_pin" type="number"></div></div>
<div class="g2"><div><label>I2C SDA</label><input id="i2c_sda" type="number"></div><div><label>I2C SCL</label><input id="i2c_scl" type="number"></div></div>
<label>ความชื้นดิน (ADC1: 32 33 34 35 36 39) — ค่า dry/wet จากการวัดจริง</label>
<table><thead><tr><th>pin</th><th>dry (แห้ง)</th><th>wet (จุ่มน้ำ)</th><th></th></tr></thead><tbody id="soil"></tbody></table><button type="button" onclick="addSoil()">+ เพิ่มหัววัดดิน</button></div>
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
async function load(){const c=await (await fetch('/api/config')).json();role=c.role;$('role').textContent=role==='keeper'?'Keeper · controller node':'Scout · sensor node';
for(const k of ['node','wifi_ssid','mqtt_host','mqtt_port','mqtt_user','interval_s','dht_pin','i2c_sda','i2c_scl','failsafe_s'])if($(k))$(k).value=c[k]??'';
$('scoutcfg').style.display=role==='scout'?'':'none';$('keepercfg').style.display=role==='keeper'?'':'none';$('rescan').style.display=role==='scout'?'':'none';
$('soil').innerHTML='';(c.soil||[]).forEach(s=>addSoil(s));$('sw').innerHTML='';(c.switches||[]).forEach(s=>addSw(s));status()}
function addSoil(s={}){const tr=document.createElement('tr');tr.innerHTML=`<td><input value="${s.pin??34}" type="number"></td><td><input value="${s.dry??3100}" type="number"></td><td><input value="${s.wet??1300}" type="number"></td><td><button type="button" onclick="this.closest('tr').remove()">ลบ</button></td>`;$('soil').appendChild(tr)}
function addSw(s={}){const tr=document.createElement('tr');tr.innerHTML=`<td><input value="${s.key??''}" placeholder="drip"></td><td><input value="${s.pin??26}" type="number"></td><td><input type="checkbox" ${s.active_low!==false?'checked':''}></td><td><input value="${s.max_on_s??600}" type="number"></td><td><input value="${(s.exclusive||[]).join(',')}" placeholder="mist"></td><td><button type="button" onclick="this.closest('tr').remove()">ลบ</button></td>`;$('sw').appendChild(tr)}
async function save(){const b={};for(const k of ['node','wifi_ssid','mqtt_host','mqtt_user'])b[k]=$(k).value;for(const k of ['mqtt_port','interval_s','dht_pin','i2c_sda','i2c_scl','failsafe_s'])if($(k).value!=='')b[k]=+$(k).value;
if($('wifi_pass').value)b.wifi_pass=$('wifi_pass').value;if($('mqtt_pass').value)b.mqtt_pass=$('mqtt_pass').value;
b.soil=[...$('soil').querySelectorAll('tr')].map(tr=>{const i=tr.querySelectorAll('input');return{pin:+i[0].value,dry:+i[1].value,wet:+i[2].value}});
b.switches=[...$('sw').querySelectorAll('tr')].map(tr=>{const i=tr.querySelectorAll('input');return{key:i[0].value,pin:+i[1].value,active_low:i[2].checked,max_on_s:+i[3].value,exclusive:i[4].value.split(',').map(x=>x.trim()).filter(Boolean)}});
$('msg').textContent='กำลังบันทึก…';await post('/api/config',b);$('msg').textContent='บันทึกแล้ว กำลังรีบูต… ถ้าเปลี่ยน WiFi ให้กลับไปต่อ WiFi บ้านแล้วเปิด http://'+(b.node||'node')+'.local'}
async function scan(){$('msg').textContent='กำลังสแกน WiFi…';const l=await (await fetch('/api/scan')).json();const s=$('ssids');s.innerHTML='<option value="">— เลือก —</option>'+l.map(n=>`<option value="${n.ssid}">${n.ssid} (${n.rssi} dBm)</option>`).join('');s.style.display='';$('msg').textContent=''}
async function status(){try{const s=await (await fetch('/api/status')).json();$('fw').textContent=s.fw;$('sub').textContent=`${s.node} · ${s.ip} · RSSI ${s.rssi} dBm · uptime ${Math.floor(s.uptime_s/60)} นาที`;
let h=`<div class="row"><span><span class="dot ${s.wifi?'on':''}"></span>WiFi ${s.wifi?'ต่อแล้ว':'ยังไม่ต่อ'}${s.portal?' (โหมดตั้งค่า)':''}</span><span><span class="dot ${s.mqtt?'on':''}"></span>MQTT ${s.mqtt?'ต่อแล้ว':(s.mqtt_host?'ต่อไม่ได้':'ยังไม่ได้ตั้ง')}</span></div>`;
if(s.sensors&&Object.keys(s.sensors).length){h+='<div class="tiles" style="margin-top:10px">'+Object.entries(s.sensors).map(([k,v])=>`<div class="t"><b>${v.value==null?'—':(+v.value).toFixed(1)}</b><span>${k} ${v.unit||''} · ${v.src||''}</span></div>`).join('')+'</div>'}else if(role==='scout'){h+='<div class="mut" style="margin-top:8px">ยังไม่พบเซ็นเซอร์ — ต่อ I2C (SDA/SCL) แล้วกด "สแกนเซ็นเซอร์" หรือเพิ่มหัววัดดิน</div>'}
if(s.switches&&s.switches.length){h+='<div style="margin-top:10px">'+s.switches.map(w=>`<div class="row" style="margin:6px 0"><span class="dot ${w.state==='ON'?'on':''}"></span><b style="min-width:70px">${w.key}</b><span class="mut">${w.state}${w.remaining_s?' · เหลือ '+w.remaining_s+' s':''}</span><button onclick="post('/api/switch',{key:'${w.key}',state:'ON',seconds:+document.getElementById('sec_${w.key}').value})">ON</button><input id="sec_${w.key}" type="number" value="60" style="width:70px"><span class="mut">s</span><button onclick="post('/api/switch',{key:'${w.key}',state:'OFF'})">OFF</button></div>`).join('')+'</div>'}
$('stbody').innerHTML=h}catch(e){}}
load();setInterval(status,5000);
</script></body></html>)HTML";
