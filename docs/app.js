/* NightDesk webapp. Reads Robinhood Chain mainnet directly; no backend. */

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;
const HEARTBEAT = 86400;
const DECAY = {Open:3600, PreMarket:21600, PostMarket:21600, Closed:259200, Overnight:259200, Unknown:0};

// Contract constants, mirrored from NightDeskLending.sol.
const BASE_LTV = 7000, LIQ_LTV = 8500, MIN_BORROW = 2000, MIN_LIQ = 5000, BPS = 10000;

const FEEDS = [
  {t:"GOOGL", name:"Alphabet",            a:"0xF6f373a037c30F0e5010d854385cA89185AE638b"},
  {t:"QQQ",   name:"Invesco QQQ",         a:"0x80901d846d5D7B030F26B480776EE3b29374C2ae"},
  {t:"TSM",   name:"Taiwan Semiconductor",a:"0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F"},
  {t:"SGOV",  name:"iShares 0-3M Treasury",a:"0xa0DF4ee0fFf975306345875E3548Fcc519577A11"},
  {t:"EWY",   name:"MSCI South Korea",    a:"0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1"},
];
const SEL = "0xfeaf968c"; // latestRoundData()

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let state = {feeds:[], block:0, session:"Unknown", lastOk:0, ageOffset:0, collateral:35000, asset:"GOOGL"};

/* ---------------- chain ---------------- */
async function rpc(method, params){
  const r = await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method,params})});
  const j = await r.json();
  if(j.error) throw new Error(j.error.message);
  return j.result;
}
function decodeRound(hex){
  const w = hex.slice(2).match(/.{64}/g);
  let answer = BigInt("0x"+w[1]);
  if(answer >> 255n) answer -= 1n << 256n;          // int256
  return {price:Number(answer)/1e8, updatedAt:Number(BigInt("0x"+w[3]))};
}

/* ---------------- session ---------------- */
function sessionAt(d=new Date()){
  const p = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",
    minute:"numeric",weekday:"short",hour12:false}).formatToParts(d);
  const g = t => p.find(x=>x.type===t).value;
  const wd = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday"));
  const m = (Number(g("hour"))%24)*60 + Number(g("minute"));
  if(wd===0||wd===6) return "Closed";
  if(m>=240 && m<570)  return "PreMarket";
  if(m>=570 && m<960)  return "Open";
  if(m>=960 && m<1200) return "PostMarket";
  return "Overnight";
}
function nyParts(d=new Date()){
  const p = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",
    weekday:"short",hour12:false}).formatToParts(d);
  const g=t=>p.find(x=>x.type===t).value;
  return {wd:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday")), h:Number(g("hour"))%24};
}

/* Mirrors MarketStateOracle._confidence exactly. */
function confidence(ageSec, session, haircutBps=0){
  if(session==="Unknown") return 0;
  const w = DECAY[session];
  if(ageSec >= w) return 0;
  const base = BPS - Math.floor((ageSec*BPS)/w);
  const hair = session==="Open" ? 0 : haircutBps;
  return Math.floor((base*(BPS-hair))/BPS);
}

/* ---------------- format ---------------- */
const usd = n => "$"+Math.round(n).toLocaleString("en-US");
const fmtAge = s => s<3600 ? `${Math.round(s/60)}m` : s<172800 ? `${(s/3600).toFixed(1)}h` : `${(s/86400).toFixed(1)}d`;
function confColor(b){ return b>6000?"var(--sage)":b>2000?"var(--amber)":"var(--coral)"; }

/* ---------------- router ---------------- */
function route(){
  const v = (location.hash.slice(1) || "overview");
  $$(".view").forEach(el => el.classList.toggle("on", el.id === "v-"+v));
  $$("nav.tabs a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
  window.scrollTo({top:0,behavior:"instant"});
}
window.addEventListener("hashchange", route);

/* ---------------- render ---------------- */
function renderStats(){
  const rows = state.feeds;
  if(!rows.length) return;
  const stale = rows.filter(r=>r.stale).length;
  const oldest = Math.max(...rows.map(r=>r.age));

  $("#staleCount").textContent = `${stale}/${rows.length}`;
  $("#staleCount").className = "v " + (stale ? "coral":"sage");
  $("#staleSub").textContent = stale===rows.length
    ? "every feed unusable by the documented rule"
    : stale ? "past the 24h heartbeat" : "all feeds within heartbeat";
  $("#oldest").textContent = fmtAge(oldest);
  $("#sessionV").textContent = state.session;
  $("#sessionV").className = "v " + (state.session==="Open" ? "sage":"");
  $("#orb").className = "orb " + (stale ? "" : "fresh");
}

function renderTable(){
  const tb = $("#feedRows");
  if(!state.feeds.length){ return; }
  tb.innerHTML = state.feeds.map(r=>{
    const c = confidence(r.age, state.session);
    return `<tr>
      <td><div class="tk">${r.t}</div><div style="font-size:12.5px;color:var(--faint)">${r.name}</div></td>
      <td class="mono">$${r.price.toFixed(2)}</td>
      <td class="mono">${fmtAge(r.age)}</td>
      <td><div class="confrow">
        <div class="bar"><i style="width:${c/100}%;background:${confColor(c)}"></i></div>
        <span class="n">${c}</span></div></td>
      <td><span class="pill ${r.stale?'stale':'ok'}"><i></i>${r.stale?'STALE':'LIVE'}</span></td>
    </tr>`;
  }).join("");
}

function buildWeek(){
  const wrap = $("#week");
  const {wd:nowD, h:nowH} = nyParts();
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  let html = '<div></div>' + days.map(d=>`<div class="hd">${d}</div>`).join("");

  for(let h=0; h<24; h++){
    // Label every sixth hour so the axis reads without crowding.
    html += `<div class="hr">${h%6===0 ? String(h).padStart(2,"0")+":00" : ""}</div>`;
    for(let d=0; d<7; d++){
      const open = d>=1 && d<=5 && h>=9 && h<16;   // 09:30-16:00 ET cash session
      const now  = d===nowD && h===nowH;
      html += `<div class="cell${open?" open":""}${now?" now":""}"></div>`;
    }
  }
  wrap.innerHTML = html;
}

/* ---------------- position builder ---------------- */
function sim(){
  const hours = Number($("#ageSlider").value);
  const haircut = Number($("#haircutSlider").value);
  const borrowPct = Number($("#borrowSlider").value);
  const age = hours*3600;
  const collateral = state.collateral;

  $("#ageOut").textContent = hours+"h";
  $("#haircutOut").textContent = haircut+" bps";

  const conf = confidence(age, "Closed", haircut);

  // Naive: trust fully until the heartbeat, then refuse outright.
  const naiveCap = age > HEARTBEAT ? 0 : collateral*(BASE_LTV/BPS);
  const ndCap = collateral*(BASE_LTV/BPS)*(conf/BPS);

  const debt = collateral*(BASE_LTV/BPS)*(borrowPct/100);
  $("#borrowOut").textContent = usd(debt);

  $("#naiveCap").textContent = usd(naiveCap);
  $("#naiveCap").style.color = naiveCap ? "var(--cream)" : "var(--coral)";
  $("#naiveVerdict").textContent = age > HEARTBEAT
    ? "Price rejected past the heartbeat. Protocol halted — the borrower is locked out until Monday."
    : hours===0 ? "Operating normally on a fresh price."
    : `Lending against a ${hours}h-old price as though it were current. No haircut applied.`;

  $("#ndCap").textContent = usd(ndCap);
  $("#ndCap").style.color = ndCap ? "var(--sage)" : "var(--coral)";
  $("#ndVerdict").textContent = conf===0
    ? "Confidence exhausted. The price is genuinely worthless now, and we say so."
    : conf < MIN_BORROW
      ? `${conf} bps — under the ${MIN_BORROW} bps borrow floor. Existing loans stand; no new debt.`
      : `${conf} bps confidence. Open for business at an honest haircut.`;

  // Health, using confidence-adjusted collateral like the contract does.
  const adjValue = collateral*(conf/BPS);
  const ltv = adjValue>0 ? Math.round((debt*BPS)/adjValue) : (debt>0?BPS*2:0);
  const pct = Math.min(100,(ltv/LIQ_LTV)*100);
  $("#healthFill").style.width = pct+"%";
  $("#healthFill").style.background = ltv>=LIQ_LTV ? "var(--coral)" : ltv>LIQ_LTV*.7 ? "var(--amber)" : "var(--sage)";
  $("#ltvOut").textContent = adjValue>0 ? (ltv/100).toFixed(1)+"%" : "—";

  // Gate states - the asymmetry made visible.
  const canBorrow = conf >= MIN_BORROW;
  const canLiq = conf >= MIN_LIQ;
  const unhealthy = ltv >= LIQ_LTV;

  $("#gBorrow").textContent = canBorrow ? "PERMITTED" : "BLOCKED";
  $("#gBorrow").style.color = canBorrow ? "var(--sage)" : "var(--coral)";

  $("#gLiq").textContent = !unhealthy ? "N/A — POSITION HEALTHY"
    : canLiq ? "PERMITTED" : "BLOCKED — PRICE UNVERIFIABLE";
  $("#gLiq").style.color = !unhealthy ? "var(--faint)" : canLiq ? "var(--amber)" : "var(--sage)";

  $("#gSummary").textContent = unhealthy && !canLiq
    ? "This borrower is underwater on paper but cannot be liquidated, because nobody can currently verify the price that says so. They keep their collateral until Monday."
    : unhealthy && canLiq
      ? "The market is open and the price is real. Liquidation proceeds normally."
      : "Position is healthy. Nothing to do.";
}

/* ---------------- agent log ---------------- */
function agentLog(){
  const el = $("#agentLog");
  if(!state.feeds.length) return;
  const t = new Date().toLocaleTimeString("en-US",{hour12:false});
  const oldest = Math.max(...state.feeds.map(r=>r.age));
  const stale = state.feeds.filter(r=>r.stale).length;
  const conf = confidence(oldest, state.session);
  const lines = [
    `<div><span class="t">${t}</span>  observe  chain ${CHAIN_ID} block ${state.block.toLocaleString("en-US")}</div>`,
    `<div><span class="t">${t}</span>  sampled  ${state.feeds.length} aggregators</div>`,
    `<div><span class="t">${t}</span>  median age ${fmtAge(oldest)} · <span class="${stale?'bad':'ok'}">${stale}/${state.feeds.length} past heartbeat</span></div>`,
    `<div><span class="t">${t}</span>  clock says <span class="ok">${state.session}</span> (America/New_York)</div>`,
    stale===state.feeds.length && state.session!=="Closed"
      ? `<div><span class="t">${t}</span>  <span class="warn">override → Closed (feeds quiet during a scheduled session)</span></div>`
      : `<div><span class="t">${t}</span>  clock and feed behaviour agree — no override</div>`,
    `<div><span class="t">${t}</span>  confidence <span class="${conf>2000?'ok':'bad'}">${conf} bps</span></div>`,
    `<div><span class="t">${t}</span>  next: web search for events since last print → haircut → attest()</div>`,
  ];
  el.innerHTML = lines.join("");
}

/* ---------------- refresh ---------------- */
async function refresh(){
  try{
    state.session = sessionAt();
    const blk = await rpc("eth_blockNumber",[]);
    state.block = parseInt(blk,16);
    const now = Math.floor(Date.now()/1000);

    state.feeds = await Promise.all(FEEDS.map(async f=>{
      const raw = await rpc("eth_call",[{to:f.a,data:SEL},"latest"]);
      const {price,updatedAt} = decodeRound(raw);
      const age = Math.max(0, now-updatedAt);
      return {...f, price, updatedAt, age, stale: age>HEARTBEAT};
    }));
    state.lastOk = Date.now();

    renderStats(); renderTable(); buildWeek(); agentLog();
    $("#chainNote").textContent =
      `chain ${CHAIN_ID} · block ${state.block.toLocaleString("en-US")} · ${new Date().toLocaleTimeString("en-US",{hour12:false})}`;
    $("#connState").textContent = "connected";
    $("#connState").style.color = "var(--sage)";

    // Anchor the simulator to the real observed age the first time through.
    if(!state.seeded && state.feeds.length){
      const h = Math.min(80, Math.round(Math.max(...state.feeds.map(r=>r.age))/3600));
      $("#ageSlider").value = h; state.seeded = true; sim();
    }
  }catch(e){
    $("#chainNote").textContent = "mainnet unreachable — "+e.message;
    $("#connState").textContent = "disconnected";
    $("#connState").style.color = "var(--coral)";
  }
}

/* ---------------- boot ---------------- */
function boot(){
  ["ageSlider","haircutSlider","borrowSlider"].forEach(id =>
    $("#"+id).addEventListener("input", sim));
  $("#collateralSel").addEventListener("change", e=>{
    state.collateral = Number(e.target.value); sim();
  });
  $("#nowBtn").addEventListener("click", ()=>{
    if(!state.feeds.length) return;
    $("#ageSlider").value = Math.min(80, Math.round(Math.max(...state.feeds.map(r=>r.age))/3600));
    sim();
  });
  $("#clock").textContent = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",
    hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date())+" NY";
  setInterval(()=>{ $("#clock").textContent =
    new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",
      minute:"2-digit",hour12:false}).format(new Date())+" NY"; }, 20000);

  route(); sim(); refresh();
  setInterval(refresh, 30000);
}
document.addEventListener("DOMContentLoaded", boot);
