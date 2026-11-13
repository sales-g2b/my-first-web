// 나라장터 계약정보 자동 수집 (Node 20+)
// 출력: data/live_tx.json (조달 납품내역, V6 업로드 형식) / data/live_maint.json (유지보수 계약)
//       data/meta.json (기준일자) / data/sample_raw.json (API 원본 샘플: 필드 확인용)
import fs from 'node:fs/promises';

const KEY = process.env.G2B_KEY;
if (!KEY) throw new Error('환경변수 G2B_KEY(인증키)가 없습니다.');
const BASE = 'https://apis.data.go.kr/1230000/ao/CntrctInfoService';
const CODES = ['4323300401','8111180901','4321150701','4321190201','4320181801','4321170201','4321159301'];
const LOOKBACK = Number(process.env.LOOKBACK_DAYS || 21);
const CHUNK = Number(process.env.CHUNK_DAYS || 7);          // 조달청 API 조회기간 제한: 7일 (2026-11-10 변경)
const BACKFILL_FROM = process.env.BACKFILL_FROM;
const MAINT = /유지보수|유지관리|유지 보수|유지 관리/;
const NAMES = {'4321150701':'데스크톱컴퓨터','4321190201':'액정모니터','4321159301':'일체형컴퓨터','4323300401':'운영체제','8111180901':'컴퓨터및주변기기설치','4320181801':'DVD드라이브','4321170201':'마그네틱카드판독기'};
const HEAD = ['연도','계약일자','계약번호','수요기관코드','수요기관','소관구분','지역','세부품명번호','세부품명','물품식별번호','품목명','업체명','단가','수량','공급금액'];

const ymd = d => d.toISOString().slice(0,10).replace(/-/g,'');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const kstToday = () => new Date(Date.now() + 9*3600e3).toISOString().slice(0,10);
const sample = {};

function chunks(from, to) {                 // 조회기간 제한(7일)에 맞춰 분할
  const out = []; let s = new Date(from);
  while (s <= to) {
    const e = new Date(Math.min(s.getTime() + (CHUNK-1)*864e5, to.getTime()));
    out.push([ymd(s)+'0000', ymd(e)+'2359']); s = new Date(e.getTime() + 864e5);
  }
  return out;
}
async function call(op, params) {
  const q = new URLSearchParams({ serviceKey: KEY, type: 'json', ...params });
  for (let i = 1; i <= 3; i++) {
    try {
      const j = JSON.parse(await (await fetch(`${BASE}/${op}?${q}`)).text());
      const h = j.response?.header;
      if (h && h.resultCode !== '00') throw new Error(`${h.resultCode} ${h.resultMsg}`);
      return j.response.body;
    } catch (e) { if (i === 3) throw new Error(`${op} 실패: ${e.message}`); await sleep(1500*i); }
  }
}
async function fetchAll(op, params) {
  const rows = []; let page = 1;
  while (true) {
    const b = await call(op, { ...params, numOfRows: 999, pageNo: page });
    let items = b.items?.item ?? b.items ?? [];
    if (!Array.isArray(items)) items = [items];
    if (page === 1 && items[0] && !sample[op]) sample[op] = items.slice(0, 2);
    rows.push(...items);
    if (!items.length || rows.length >= Number(b.totalCount || 0)) break;
    page++; await sleep(150);
  }
  return rows;
}
// "[1^1234567^기관명^...]" 형태 문자열에서 코드/이름 추출 (필드 순서가 달라도 동작하도록 보수적으로 파싱)
function parseList(s, codeRe) {
  const out = [];
  for (const m of String(s || '').matchAll(/\[([^\]]*)\]/g)) {
    const f = m[1].split('^').map(x => x.trim());
    const ci = f.findIndex(x => codeRe.test(x));
    const name = f.slice(ci + 1).find(x => /[가-힣A-Za-z]/.test(x) && !/^\d+$/.test(x)) || '';
    out.push({ code: ci >= 0 ? f[ci] : '', name });
  }
  return out;
}
const num = v => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

function toTxRow(it) {
  const cls = String(it.dtilPrdctClsfcNo || it.prdctClsfcNo || '').trim();
  if (!CODES.includes(cls)) return null;
  const dm = parseList(it.dminsttList, /^\d{6,7}$/)[0] || {};
  const corp = parseList(it.corpList, /^(\d{10}|\d{3}-\d{2}-\d{5})$/)[0] || {};
  const dt = String(it.cntrctDate || it.cntrctCnclsDate || it.rgstDt || '').replace(/[^0-9]/g,'').slice(0,8);
  return [dt.slice(0,4), dt, it.untyCntrctNo || it.cntrctNo || '',
    it.dminsttCd || dm.code || '', it.dminsttNm || it.orderInsttNm || dm.name || '',
    it.dminsttDivNm || '기타기관', it.dminsttRgnNm || '', cls,
    it.dtilPrdctClsfcNm || it.prdctClsfcNm || NAMES[cls] || '', it.prdctIdntNo || '', it.prdctNm || it.cntrctNm || '',
    it.corpNm || it.entrprsNm || corp.name || '', num(it.prdctUprc), num(it.prdctQty || it.cntrctQty) || 1,
    num(it.prdctAmt || it.totCntrctAmt)];
}
function toMaintRow(it) {
  const dm = parseList(it.dminsttList, /^\d{6,7}$/)[0] || {};
  const corp = parseList(it.corpList, /^(\d{10}|\d{3}-\d{2}-\d{5})$/)[0] || {};
  const bno = corp.code || '';
  return [it.dminsttNm || dm.name || it.cntrctInsttNm || '', it.cntrctNm || '',
    it.corpNm || corp.name || '', bno, num(it.thtmCntrctAmt || it.totCntrctAmt),
    String(it.cntrctCnclsDate || '').slice(0,10), ''];
}
async function load(f) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return null; } }

const today = new Date();
const from = BACKFILL_FROM ? new Date(BACKFILL_FROM) : new Date(today.getTime() - LOOKBACK*864e5);
const periods = chunks(from, today);
console.log(`수집기간 ${ymd(from)}~${ymd(today)} (${periods.length}구간)`);

const tx = [], mt = [];
const errors = [];
for (const [bgn, end] of periods) {
  try {
  const a = await fetchAll('getCntrctInfoListThngDetail', { inqryDiv: 1, inqryBgnDt: bgn, inqryEndDt: end });
  const t = a.map(toTxRow).filter(Boolean); tx.push(...t);
  const b = await fetchAll('getCntrctInfoListServcPPSSrch', { inqryDiv: 1, inqryBgnDt: bgn, inqryEndDt: end });
  const m = b.filter(r => MAINT.test(r.cntrctNm || '')).map(toMaintRow).filter(r => r[0] && r[2]); mt.push(...m);
  console.log(`${bgn.slice(0,8)}: 물품 ${a.length}→7대품목 ${t.length} / 용역 ${b.length}→유지보수 ${m.length}`);
  } catch (e) { errors.push(`${bgn.slice(0,8)}~${end.slice(0,8)}: ${e.message}`); console.error('구간 실패', bgn, e.message); }
}
if (errors.length === periods.length) { console.error('모든 구간 실패 — 인증키·활용신청·파라미터를 확인하세요'); process.exit(1); }

const txKey = r => [r[2], r[9], r[10], r[12]].join('|');
const mtKey = r => [r[0], r[1], r[2], r[5], r[4]].join('|');
const oldTx = ((await load('data/live_tx.json')) || []).slice(1);
const oldMt = (await load('data/live_maint.json')) || [];
const mTx = new Map(oldTx.map(r => [txKey(r), r])); tx.forEach(r => mTx.set(txKey(r), r));
const mMt = new Map(oldMt.map(r => [mtKey(r), r])); mt.forEach(r => mMt.set(mtKey(r), r));

await fs.mkdir('data', { recursive: true });
await fs.writeFile('data/live_tx.json', JSON.stringify([HEAD, ...mTx.values()]));
await fs.writeFile('data/live_maint.json', JSON.stringify([...mMt.values()]));
await fs.writeFile('data/sample_raw.json', JSON.stringify(sample, null, 1));
await fs.writeFile('data/meta.json', JSON.stringify({
  baseDate: kstToday(),                      // 기준일자 = 업데이트 진행일
  updatedAt: new Date().toISOString(),
  latestContractDate: [...mTx.values()].reduce((a, r) => (r[1] > a ? r[1] : a), ''),   // 수집된 최신 계약일
  counts: { tx: mTx.size, maint: mMt.size }, fetchedThisRun: { tx: tx.length, maint: mt.length }, errors
}, null, 2));
console.log('완료', mTx.size, mMt.size);
