#include <stdio.h>
#include <string.h>
#include <math.h>
#include "u8g2.h"
static u8g2_t u;

/* ภูตโนม 20x22 สไตล์พิกเซลขอบหนา: หมวกแหลม หน้ากลม ตาโต เครา */
static const unsigned char gnome_bits[] = {0x00,0x06,0x00,0x00,0x0f,0x00,0x80,0x19,0x00,0xc0,0x30,0x00,0x60,0x60,0x00,0x30,0xc0,0x00,0x18,0x80,0x01,0xfc,0xff,0x06,0xfe,0xff,0x1f,0x0c,0x00,0x0c,0xe4,0xe1,0x09,0x24,0x21,0x09,0xa4,0x61,0x09,0xe4,0xe1,0x09,0x04,0x0c,0x08,0x0c,0x1e,0x0c,0x34,0x00,0x0b,0xd4,0xff,0x0a,0x54,0x80,0x0a,0x24,0x3f,0x09,0xc8,0xc0,0x04,0x30,0x00,0x03,0xc0,0xf3,0x00,0x00,0x1e,0x00};
static void gnome(int x,int y){ u8g2_DrawXBM(&u,x,y,24,24,gnome_bits); }

/* ฟองอากาศ (บรรยากาศใต้น้ำของ DtD) */
static void bubbles(int seed){ int xs[]={118,124,112,121,116}; int ys[]={56,40,24,14,46}; int r[]={2,1,2,1,1};
  for(int i=0;i<5;i++){ int y=ys[i]-(seed*3)%20; if(y<12)y+=44; u8g2_DrawCircle(&u,xs[i],y,r[i],U8G2_DRAW_ALL);} }
/* เส้นคลื่น */
static void wave(int y){ for(int x=0;x<128;x++){ int yy=y+(int)lround(sin((x/4.0))*1.2); u8g2_DrawPixel(&u,x,yy);} }
/* กล่องมุมมนขอบหนาสองชั้น = ลายเซ็นของ UI เกมพิกเซล */
static void panel(int x,int y,int w,int h){ u8g2_DrawRFrame(&u,x,y,w,h,3); u8g2_DrawRFrame(&u,x+1,y+1,w-2,h-2,2); }
/* แถบพลังงานแบบเป็นช่อง (O2 bar ของ DtD) */
static void segbar(int x,int y,int segs,int on,int w,int h){ for(int i=0;i<segs;i++){ int sx=x+i*(w+1); if(i<on) u8g2_DrawBox(&u,sx,y,w,h); else u8g2_DrawFrame(&u,sx,y,w,h);} }
/* ป้ายตัวหนังสือกลับสี (ป้ายชื่อบอส) */
static void tag(int x,int y,const char*s){ u8g2_SetFont(&u,u8g2_font_4x6_tr); int w=u8g2_GetStrWidth(&u,s)+4; u8g2_DrawRBox(&u,x,y,w,8,1); u8g2_SetDrawColor(&u,0); u8g2_DrawStr(&u,x+2,y+6,s); u8g2_SetDrawColor(&u,1); }
/* แถบลายทางคาดบน-ล่าง (ฉากเปิดตัว / cutscene) */
static void stripes(int y,int h){ for(int x=-8;x<136;x+=8){ for(int i=0;i<4;i++){ int xx=x+i+ (y&1); if(xx>=0&&xx<128) u8g2_DrawVLine(&u,xx,y,h);} } }

/* ---------- หน้า A: HUD หลัก (เหมือน HUD ตอนดำน้ำ) ---------- */
static void screenA(void){
  /* แถบดิน = O2 bar */
  u8g2_SetFont(&u,u8g2_font_4x6_tr); u8g2_DrawStr(&u,2,7,"SOIL");
  segbar(22,1,8,5,5,7);
  /* อุณหภูมิ = เครื่องวัดความลึก */
  u8g2_SetFont(&u,u8g2_font_pressstart2p_8r); u8g2_DrawStr(&u,86,9,"29");
  u8g2_DrawCircle(&u,104,2,1,U8G2_DRAW_ALL); u8g2_DrawStr(&u,108,9,"C");
  wave(13);
  bubbles(2);
  gnome(6,20);
  u8g2_SetFont(&u,u8g2_font_HelvetiPixel_tr);
  u8g2_DrawStr(&u,36,29,"All good!");
  u8g2_SetFont(&u,u8g2_font_4x6_tr); u8g2_DrawStr(&u,36,39,"RH 82%  LUX 474");
  /* ช่องไอเท็ม = สถานะเซ็นเซอร์ */
  const char* slots[]={"T","RH","LX","S1"}; int on[]={1,1,1,0};
  for(int i=0;i<4;i++){ int x=36+i*18; u8g2_DrawRFrame(&u,x,47,16,14,2); if(on[i]) u8g2_DrawRBox(&u,x+2,49,12,10,1);
    u8g2_SetFont(&u,u8g2_font_4x6_tr); int tw=u8g2_GetStrWidth(&u,slots[i]); u8g2_SetDrawColor(&u,on[i]?0:1); u8g2_DrawStr(&u,x+8-tw/2,57,slots[i]); u8g2_SetDrawColor(&u,1);} 
}
/* ---------- หน้า B: บอลลูนคำพูด (โหมดคิด) ---------- */
static void screenB(void){
  gnome(2,38);
  panel(28,2,98,40);
  u8g2_DrawTriangle(&u,32,40,24,48,42,40); u8g2_SetDrawColor(&u,0); u8g2_DrawTriangle(&u,33,38,27,45,40,38); u8g2_SetDrawColor(&u,1);
  u8g2_SetFont(&u,u8g2_font_HelvetiPixel_tr);
  u8g2_DrawStr(&u,34,15,"White flowers");
  u8g2_DrawStr(&u,34,27,"blooming!");
  u8g2_SetFont(&u,u8g2_font_4x6_tr); u8g2_DrawStr(&u,34,37,"watcher 16:24");
  tag(94,52,"HAPPY");
  u8g2_DrawCircle(&u,70,52,2,U8G2_DRAW_ALL); u8g2_DrawCircle(&u,78,58,1,U8G2_DRAW_ALL);
}
/* ---------- หน้า C: ป้ายเตือนแบบเปิดตัวบอส ---------- */
static void screenC(void){
  stripes(0,6); stripes(58,6);
  u8g2_DrawRBox(&u,8,14,112,36,4);
  u8g2_SetDrawColor(&u,0);
  u8g2_SetFont(&u,u8g2_font_pressstart2p_8r); u8g2_DrawStr(&u,28,30,"RAIN!");
  u8g2_SetFont(&u,u8g2_font_4x6_tr); u8g2_DrawStr(&u,22,42,"skip watering today");
  u8g2_SetDrawColor(&u,1);
  /* หยดฝน */
  for(int i=0;i<6;i++){ int x=14+i*20, y=9+(i%3)*2; u8g2_DrawVLine(&u,x,y,3);} 
}
/* ---------- หน้า D: การ์ดค่าแบบสมุดสะสมปลา ---------- */
static void screenD(void){
  panel(0,0,128,64);
  /* ไอคอนหยดน้ำซ้าย */
  u8g2_DrawDisc(&u,20,34,9,U8G2_DRAW_ALL); u8g2_DrawTriangle(&u,11,34,29,34,20,16);
  u8g2_SetDrawColor(&u,0); u8g2_DrawDisc(&u,17,35,2,U8G2_DRAW_ALL); u8g2_SetDrawColor(&u,1);
  u8g2_SetFont(&u,u8g2_font_logisoso24_tn); u8g2_DrawStr(&u,44,40,"82");
  u8g2_SetFont(&u,u8g2_font_pressstart2p_8r); u8g2_DrawStr(&u,84,40,"%");
  u8g2_SetFont(&u,u8g2_font_HelvetiPixel_tr); u8g2_DrawStr(&u,44,15,"Humidity");
  tag(98,5,"EARTH");
  segbar(44,48,10,8,7,5);
  u8g2_SetFont(&u,u8g2_font_4x6_tr); u8g2_DrawStr(&u,44,61,"max 98  min 61");
}

static void dump(FILE*f){ uint8_t*b=u8g2_GetBufferPtr(&u); int w=128;
  for(int ty=0;ty<8;ty++) for(int bit=0;bit<8;bit++){ for(int x=0;x<w;x++) fputc(((b[ty*w+x]>>bit)&1)?'#':'.',f); fputc('\n',f);} }

int main(void){
  uint8_t tbh; uint8_t*buf;
  u8g2_SetupDisplay(&u,u8x8_d_sh1106_128x64_noname,u8x8_cad_001,u8x8_byte_empty,u8x8_dummy_cb);
  buf=u8g2_m_16_8_f(&tbh); u8g2_SetupBuffer(&u,buf,tbh,u8g2_ll_hvline_vertical_top_lsb,U8G2_R0);
  u8g2_InitDisplay(&u); u8g2_SetPowerSave(&u,0);
  void(*scr[])(void)={screenA,screenB,screenC,screenD};
  for(int i=0;i<4;i++){ u8g2_ClearBuffer(&u); u8g2_SetDrawColor(&u,1); scr[i](); char fn[16]; snprintf(fn,sizeof fn,"s%d.txt",i); FILE*f=fopen(fn,"w"); dump(f); fclose(f);} 
  return 0;
}
