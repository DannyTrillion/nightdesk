/* NightDesk — reads Robinhood Chain mainnet directly. No backend. */

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663, CHAIN_HEX = "0x" + (4663).toString(16);
const HEARTBEAT = 86400;
const DECAY = {Open:3600, PreMarket:21600, PostMarket:21600, Closed:259200, Overnight:259200, Unknown:0};
const BASE_LTV = 7000, LIQ_LTV = 8500, MIN_BORROW = 2000, MIN_LIQ = 5000, BPS = 10000;

const FEEDS = [
  {t:"GOOGL", name:"Alphabet Class A",        feed:"0xF6f373a037c30F0e5010d854385cA89185AE638b", token:"0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3"},
  {t:"QQQ",   name:"Invesco QQQ Trust",       feed:"0x80901d846d5D7B030F26B480776EE3b29374C2ae", token:"0xD5f3879160bc7c32ebb4dC785F8a4F505888de68"},
  {t:"TSM",   name:"Taiwan Semiconductor",    feed:"0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F", token:"0x58FfE4a942d3885bAa22D7520691F611EF09e7AA"},
  {t:"SGOV",  name:"iShares 0-3M Treasury",   feed:"0xa0DF4ee0fFf975306345875E3548Fcc519577A11", token:"0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5"},
  {t:"EWY",   name:"iShares MSCI South Korea",feed:"0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1", token:"0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc"},
];
const SEL_ROUND = "0xfeaf968c", SEL_BAL = "0x70a08231";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let S = {
  feeds:[], block:0, session:"Unknown", anchor:0, seeded:false,
  sel:"GOOGL", offsetH:0, haircut:0, collateral:35000, borrowPct:0,
  machineOn:false, range:7, wallet:null, holdings:[],
};

/* ---------------- motion ---------------- */
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = t => t===1 ? 1 : 1 - Math.pow(2,-10*t);
function tween(el, to, fmt, dur=600){
  if(!el) return;
  const from = el._tv ?? to; el._tv = to;
  if(REDUCED || from===to){ el.textContent = fmt(to); return; }
  cancelAnimationFrame(el._raf);
  const t0 = performance.now();
  const step = n => {
    const p = Math.min(1,(n-t0)/dur);
    el.textContent = fmt(from + (to-from)*ease(p));
    if(p<1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

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
  let a = BigInt("0x"+w[1]);
  if(a >> 255n) a -= 1n << 256n;
  return {price:Number(a)/1e8, updatedAt:Number(BigInt("0x"+w[3]))};
}

/* ---------------- session + confidence ---------------- */
function nyFmt(d, opts){ return new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",...opts}).format(d); }
function nyParts(d=new Date()){
  const p = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",
    minute:"numeric",weekday:"short",hour12:false}).formatToParts(d);
  const g = t => p.find(x=>x.type===t).value;
  return {wd:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday")),
          h:Number(g("hour"))%24, m:Number(g("minute"))};
}
function sessionAt(d=new Date()){
  const {wd,h,m} = nyParts(d), mins = h*60+m;
  if(wd===0||wd===6) return "Closed";
  if(mins>=240 && mins<570)  return "PreMarket";
  if(mins>=570 && mins<960)  return "Open";
  if(mins>=960 && mins<1200) return "PostMarket";
  return "Overnight";
}
/* Mirrors MarketStateOracle._confidence exactly. */
function confidence(age, session, haircut=0){
  if(session==="Unknown") return 0;
  const w = DECAY[session];
  if(age >= w) return 0;
  const base = BPS - Math.floor((age*BPS)/w);
  return Math.floor((base*(BPS-(session==="Open"?0:haircut)))/BPS);
}

const usd = n => "$"+Math.round(n).toLocaleString("en-US");
const fmtAge = s => s<3600 ? `${Math.round(s/60)}m` : s<172800 ? `${(s/3600).toFixed(1)}h` : `${(s/86400).toFixed(1)}d`;
const cColor = b => b>6000 ? "var(--green)" : b>2000 ? "var(--gold)" : "var(--red)";
const short = a => a.slice(0,6)+"…"+a.slice(-4);

/* ---------------- sparklines ---------------- */
/* Real curves, not decoration: what confidence would have scored each hour
   across the window, given market hours and the decay model. */
function sparkPath(vals, w=190, h=34){
  const max = Math.max(...vals,1), min = Math.min(...vals,0);
  const span = (max-min)||1;
  return vals.map((v,i)=>{
    const x = (i/(vals.length-1))*w;
    const y = h - ((v-min)/span)*(h-4) - 2;
    return `${i?"L":"M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}
function sparkBars(vals, w=190, h=34){
  const max = Math.max(...vals,1);
  const bw = w/vals.length;
  return vals.map((v,i)=>{
    const bh = Math.max(1.5,(v/max)*(h-3));
    return `<rect x="${(i*bw).toFixed(1)}" y="${(h-bh).toFixed(1)}" width="${(bw*.62).toFixed(1)}"
      height="${bh.toFixed(1)}" rx="1" fill="currentColor" opacity="${.35+.55*(v/max)}"/>`;
  }).join("");
}
function confidenceHistory(hours){
  // Walk backwards hour by hour; at each point compute what the last print's
  // age would have been and score it under that hour's session.
  const out = [], now = Date.now();
  for(let i=hours; i>=0; i--){
    const t = new Date(now - i*3600*1000);
    const sess = sessionAt(t);
    // Age since the most recent close preceding t.
    let age = 0, probe = new Date(t);
    for(let k=0;k<200;k++){
      if(sessionAt(probe)==="Open") break;
      probe = new Date(probe.getTime() - 3600*1000); age += 3600;
    }
    out.push(confidence(age, sess));
  }
  return out;
}

/* ---------------- tiles ---------------- */
/* Every sparkline answers its own tile. A flat line means the chart was
   decoration; these are each derived from the model or the live reads. */
function renderTiles(){
  const rows = S.feeds; if(!rows.length) return;
  const stale = rows.filter(r=>r.stale).length;
  const oldest = Math.max(...rows.map(r=>r.age));
  const hrs = S.range===7 ? 168 : 24;

  // 1. Coverage: confidence hour by hour across the window - the sawtooth of
  //    market days rising and weekends bleeding out.
  const hist = confidenceHistory(hrs);
  const covSeries = S.range===7 ? hist.filter((_,i)=>i%4===0) : hist;
  const openHrs = S.range===7 ? 32.5 : (sessionAt()==="Closed" ? 0 : 6.5);
  const cov = (openHrs/hrs)*100;

  // 2. Heartbeat: one bar per feed, height is age against the 24h heartbeat,
  //    with the heartbeat itself drawn as a threshold line.
  const ratios = rows.map(r => Math.min(2, r.age/HEARTBEAT));
  const hbBars = rows.map((r,i)=>{
    const bw = 190/rows.length, hgt = Math.max(2,(ratios[i]/2)*30);
    return `<rect x="${(i*bw+bw*.18).toFixed(1)}" y="${(34-hgt).toFixed(1)}"
      width="${(bw*.64).toFixed(1)}" height="${hgt.toFixed(1)}" rx="1.5"
      fill="${r.stale?"var(--red)":"var(--green)"}" opacity=".85"/>`;
  }).join("");

  // 3. Oldest price: the decay curve, with a marker at where we actually are.
  const win = DECAY[S.session] || DECAY.Closed;
  const curve = Array.from({length:40},(_,i)=>confidence((i/39)*win*1.1, S.session));
  const posX = Math.min(1, oldest/(win*1.1))*190;

  // 4. Session: the coming 24 hours, open hours lit.
  const next24 = Array.from({length:24},(_,i)=>{
    const d = new Date(Date.now()+i*3600*1000);
    return sessionAt(d)==="Open" ? 1 : sessionAt(d)==="Closed" ? .12 : .4;
  });

  const tiles = [
    {k:"Live price coverage", v:cov.toFixed(1), unit:"%", cls:"warn",
     spark:`<svg class="spark" viewBox="0 0 190 34" preserveAspectRatio="none" style="color:var(--gold)">
       ${sparkBars(covSeries.map(v=>v+120))}</svg>`},
    {k:"Feeds past heartbeat", v:`${stale}/${rows.length}`, unit:"", cls:stale?"bad":"good",
     spark:`<svg class="spark" viewBox="0 0 190 34" preserveAspectRatio="none">
       ${hbBars}
       <line x1="0" y1="19" x2="190" y2="19" stroke="var(--stroke-2)" stroke-width="1"
         stroke-dasharray="3 3"/></svg>`},
    {k:"Oldest price on chain", v:(oldest/3600).toFixed(1), unit:"h", cls:oldest>HEARTBEAT?"bad":"good",
     spark:`<svg class="spark" viewBox="0 0 190 34" preserveAspectRatio="none" style="color:var(--gold)">
       <path d="${sparkPath(curve)}" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" opacity=".55"/>
       <line x1="${posX.toFixed(1)}" y1="0" x2="${posX.toFixed(1)}" y2="34"
         stroke="var(--red)" stroke-width="1.5"/></svg>`},
    {k:"Market session", v:S.session, unit:"", cls:S.session==="Open"?"good":"warn",
     spark:`<svg class="spark" viewBox="0 0 190 34" preserveAspectRatio="none" style="color:var(--gold)">
       ${sparkBars(next24)}</svg>`},
  ];
  $("#statTiles").innerHTML = tiles.map(t=>`
    <div class="tile ${t.cls}">
      <div class="k">${t.k}</div>
      <div class="v">${t.v}${t.unit?`<small>${t.unit}</small>`:""}</div>
      ${t.spark}
    </div>`).join("");
}

/* ---------------- asset list ---------------- */
function renderList(){
  if(!S.feeds.length) return;
  $("#assetCount").textContent = `${S.feeds.length} tracked`;
  $("#assetList").innerHTML = S.feeds.map(f=>{
    const c = confidence(f.age, S.session);
    return `<button class="acard ${f.t===S.sel?"on":""}" data-t="${f.t}">
      <div class="av">${f.t.slice(0,2)}</div>
      <div class="meta"><div class="tkr">${f.t}</div><div class="nm">${f.name}</div></div>
      <div class="rt"><div class="px">$${f.price.toFixed(2)}</div>
        <div class="cf" style="color:${cColor(c)}">${c} bps</div></div>
    </button>`;
  }).join("");
  $$(".acard").forEach(b => b.addEventListener("click", ()=>{
    S.sel = b.dataset.t; renderList(); sim();
  }));
}

/* ---------------- detail + simulation ---------------- */
function selected(){ return S.feeds.find(f=>f.t===S.sel) || S.feeds[0]; }

function machineTime(){
  const f = selected();
  const anchor = S.anchor || Math.floor(Date.now()/1000);
  if(!S.machineOn) return {date:new Date(), age:f?f.age:0, session:S.session};
  const t = anchor + S.offsetH*3600;
  const d = new Date(t*1000);
  return {date:d, age:S.offsetH*3600, session:sessionAt(d)};
}

function sim(){
  const f = selected(); if(!f) return;
  const {date, age, session} = machineTime();
  const conf = confidence(age, session, S.haircut);

  // hero
  $("#ringFill").style.strokeDashoffset = 452.4*(1-conf/BPS);
  $("#ringFill").style.stroke = cColor(conf);
  tween($("#ringVal"), conf, v=>Math.round(v));
  $("#dPrice").textContent = "$"+f.price.toFixed(2);
  $("#dTagTxt").textContent = `${f.t} · ${session.toUpperCase()}`;
  $("#dTag").style.color = session==="Open" ? "var(--green)" : session==="Closed" ? "var(--red)" : "var(--gold)";
  $("#dCap").textContent = f.name + " — " + (conf===0
    ? "no usable price right now."
    : conf<MIN_BORROW ? "priced, but under the borrow floor."
    : "priced with a confidence haircut.");

  // specs
  $("#sAge").textContent = fmtAge(age);
  $("#sSession").textContent = session;
  $("#sWindow").textContent = DECAY[session] ? fmtAge(DECAY[session]) : "—";
  $("#sPrint").textContent = nyFmt(new Date(f.updatedAt*1000),{weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false});
  $("#machineWhen").textContent = S.machineOn
    ? nyFmt(date,{weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false})+" NY · simulated"
    : "walks forward from the last real print";

  // heat cursor
  const {wd,h} = nyParts(date);
  $$("#week .cell").forEach(c=>c.classList.remove("now"));
  const cell = $(`#week .cell[data-d="${wd}"][data-h="${h}"]`);
  if(cell) cell.classList.add("now");

  // capacities
  const naive = age > HEARTBEAT ? 0 : S.collateral*(BASE_LTV/BPS);
  const nd = S.collateral*(BASE_LTV/BPS)*(conf/BPS);
  const debt = S.collateral*(BASE_LTV/BPS)*(S.borrowPct/100);

  tween($("#naiveCap"), naive, usd);
  tween($("#ndCap"), nd, usd);
  tween($("#borrowOut"), debt, usd);
  tween($("#collOut"), S.collateral, usd);
  $("#ageOut").textContent = S.machineOn ? S.offsetH+"h" : fmtAge(age);
  $("#haircutOut").textContent = S.haircut+" bps";
  $("#naiveCap").style.color = naive ? "var(--ink)" : "var(--red)";
  $("#ndCap").style.color = nd ? "var(--gold)" : "var(--red)";

  $("#naiveVerdict").textContent = age > HEARTBEAT
    ? "Price rejected past the heartbeat. Protocol halted — the borrower is locked out."
    : age < 60 ? "Operating normally on a fresh print."
    : `Lending against a ${fmtAge(age)}-old price as though it were current. No haircut.`;

  const reopened = conf===0 && age < DECAY.Closed &&
    ["PreMarket","Open","PostMarket"].includes(session);
  $("#ndVerdict").textContent = reopened
    ? `${session} has begun — discovery is resuming, so a ${fmtAge(age)}-old close stops being the best estimate. Confidence drops on purpose, exactly when the information changes.`
    : conf===0 ? "Confidence exhausted. The price is genuinely worthless now, and we say so."
    : conf < MIN_BORROW ? `${conf} bps — under the ${MIN_BORROW} bps floor. Existing loans stand; no new debt.`
    : `${conf} bps in a ${session} session. Open at an honest haircut.`;

  // health
  const adj = S.collateral*(conf/BPS);
  const ltv = adj>0 ? Math.round((debt*BPS)/adj) : (debt>0 ? BPS*2 : 0);
  $("#healthFill").style.width = Math.min(100,(ltv/LIQ_LTV)*100)+"%";
  $("#healthFill").style.background = ltv>=LIQ_LTV ? "var(--red)" : ltv>LIQ_LTV*.7 ? "var(--gold)" : "var(--green)";
  $("#ltvOut").textContent = adj>0 ? (ltv/100).toFixed(1)+"%" : (debt>0?"∞":"—");

  const canB = conf>=MIN_BORROW, canL = conf>=MIN_LIQ, bad = ltv>=LIQ_LTV;
  $("#gBorrow").textContent = canB ? "PERMITTED" : "BLOCKED";
  $("#gBorrow").style.color = canB ? "var(--green)" : "var(--red)";
  $("#gLiq").textContent = !bad ? "N/A" : canL ? "PERMITTED" : "BLOCKED";
  $("#gLiq").style.color = !bad ? "var(--faint)" : canL ? "var(--gold)" : "var(--green)";
  $("#borrowBtn").disabled = !canB;

  $("#gSummary").textContent = !bad
    ? (canB ? "Position is healthy and the price is good enough to lend against."
            : "Position is healthy, but confidence is under the borrow floor — the loan stands, no new debt.")
    : !canL
      ? `Underwater on paper at ${(ltv/100).toFixed(0)}% LTV, but confidence is only ${conf} bps — under the ${MIN_LIQ} bps bar. Nobody can verify the price that says this borrower is insolvent, so the collateral stays put until the market reopens.`
      : `Underwater at ${(ltv/100).toFixed(0)}% LTV with ${conf} bps confidence, at or above the ${MIN_LIQ} bps bar. The price is trustworthy enough to act on, so liquidation proceeds.`;
}

/* ---------------- week heat ---------------- */
function buildWeek(){
  const wrap = $("#week"); if(!wrap) return;
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  let html = "<div></div>" + days.map(d=>`<div class="hd">${d}</div>`).join("");
  for(let h=0;h<24;h++){
    html += `<div class="hr">${h%6===0 ? String(h).padStart(2,"0") : ""}</div>`;
    for(let d=0;d<7;d++){
      const open = d>=1 && d<=5 && h>=9 && h<16;
      html += `<div class="cell${open?" open":""}" data-d="${d}" data-h="${h}"></div>`;
    }
  }
  wrap.innerHTML = html;
}

/* ---------------- agent log ---------------- */
function agentLog(){
  if(!S.feeds.length) return;
  const t = new Date().toLocaleTimeString("en-US",{hour12:false});
  const oldest = Math.max(...S.feeds.map(r=>r.age));
  const stale = S.feeds.filter(r=>r.stale).length;
  const conf = confidence(oldest, S.session);
  $("#agentLog").innerHTML = [
    `<div><span class="t">${t}</span>  observe  chain ${CHAIN_ID} block ${S.block.toLocaleString("en-US")}</div>`,
    `<div><span class="t">${t}</span>  sampled  ${S.feeds.length} aggregators</div>`,
    `<div><span class="t">${t}</span>  oldest ${fmtAge(oldest)} · <span class="${stale?"bad":"ok"}">${stale}/${S.feeds.length} past heartbeat</span></div>`,
    `<div><span class="t">${t}</span>  clock says <span class="ok">${S.session}</span> (America/New_York)</div>`,
    stale===S.feeds.length && S.session!=="Closed"
      ? `<div><span class="t">${t}</span>  <span class="warn">override → Closed (feeds quiet in a scheduled session)</span></div>`
      : `<div><span class="t">${t}</span>  clock and feed behaviour agree — no override</div>`,
    `<div><span class="t">${t}</span>  confidence <span class="${conf>2000?"ok":"bad"}">${conf} bps</span></div>`,
    `<div><span class="t">${t}</span>  next: search events since last print → haircut → attest()</div>`,
  ].join("");
}

/* ---------------- wallet ---------------- */
async function ensureChain(){
  try{ await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:CHAIN_HEX}]}); }
  catch(e){
    if(e.code===4902){
      await ethereum.request({method:"wallet_addEthereumChain",params:[{
        chainId:CHAIN_HEX, chainName:"Robinhood Chain",
        nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},
        rpcUrls:[RPC], blockExplorerUrls:["https://robinhoodchain.blockscout.com"]}]});
    } else throw e;
  }
}
async function connectWallet(){
  const btn = $("#connectBtn");
  if(!window.ethereum){ wNote("No injected wallet found. Install MetaMask or Rabby.", true); return; }
  try{
    btn.disabled = true; btn.textContent = "Connecting…";
    const a = await ethereum.request({method:"eth_requestAccounts"});
    await ensureChain();
    S.wallet = a[0]; btn.textContent = short(S.wallet);
    wNote("Reading Stock Token balances…"); await loadHoldings();
  }catch(e){ wNote(e.message||"Connection rejected.", true); btn.textContent = "Connect wallet"; }
  finally{ btn.disabled = false; }
}
function wNote(m,bad){ const e=$("#walletNote"); e.textContent=m; e.style.color = bad?"var(--red)":"var(--faint)"; }

async function loadHoldings(){
  const pad = a => "000000000000000000000000"+a.slice(2).toLowerCase();
  const out = [];
  for(const f of FEEDS){
    try{
      const raw = await rpc("eth_call",[{to:f.token,data:SEL_BAL+pad(S.wallet)},"latest"]);
      const bal = Number(BigInt(raw))/1e18;
      if(bal>0) out.push({t:f.t, bal});
    }catch(_){}
  }
  S.holdings = out; renderHoldings();
}
function renderHoldings(){
  const box = $("#holdings"); if(!S.wallet) return;
  if(!S.holdings.length){
    box.innerHTML = `<p style="color:var(--mute);font-size:13px;margin:0">No Stock Tokens at
      ${short(S.wallet)} on this chain. The simulator keeps its preset collateral.</p>`;
    wNote(`Connected · ${short(S.wallet)} · no holdings`); return;
  }
  const px = t => (S.feeds.find(f=>f.t===t)||{}).price || 0;
  const total = S.holdings.reduce((s,h)=>s+h.bal*px(h.t),0);
  box.innerHTML = S.holdings.map(h=>`<div class="kv"><span class="k">${h.t}
      <span style="color:var(--faint)">· ${h.bal.toFixed(4)}</span></span>
      <span class="v">${usd(h.bal*px(h.t))}</span></div>`).join("")
    + `<div class="kv"><span class="k" style="color:var(--ink)">Portfolio</span>
       <span class="v" style="color:var(--gold)">${usd(total)}</span></div>
       <button class="btn gold" id="useHold" style="width:100%;margin-top:14px">Use as collateral</button>`;
  wNote(`Connected · ${short(S.wallet)} · ${S.holdings.length} position(s)`);
  $("#useHold").addEventListener("click", ()=>{
    S.collateral = Math.max(5000, Math.min(500000, Math.round(total)));
    $("#collSlider").value = S.collateral;
    location.hash = "#dashboard"; sim();
  });
}

/* ---------------- refresh ---------------- */
async function refresh(){
  try{
    S.session = sessionAt();
    S.block = parseInt(await rpc("eth_blockNumber",[]),16);
    const now = Math.floor(Date.now()/1000);
    S.feeds = await Promise.all(FEEDS.map(async f=>{
      const {price,updatedAt} = decodeRound(await rpc("eth_call",[{to:f.feed,data:SEL_ROUND},"latest"]));
      const age = Math.max(0, now-updatedAt);
      return {...f, price, updatedAt, age, stale:age>HEARTBEAT};
    }));
    S.anchor = Math.max(...S.feeds.map(f=>f.updatedAt));
    S.seeded = true;

    renderTiles(); renderList(); agentLog(); sim();
    if(S.wallet) renderHoldings();
    const stale = S.feeds.filter(f=>f.stale).length;
    $("#led").className = "led" + (stale ? "" : " live");
    $("#liveTxt").textContent = `block ${S.block.toLocaleString("en-US")}`;
  }catch(e){
    $("#liveTxt").textContent = "disconnected";
    $("#led").className = "led";
  }
}

/* ---------------- router + boot ---------------- */
function route(){
  const v = location.hash.slice(1) || "dashboard";
  $$(".view").forEach(el=>el.classList.toggle("on", el.id==="v-"+v));
  $$("nav.pills a").forEach(a=>a.classList.toggle("on", a.dataset.v===v));
  scrollTo({top:0,behavior:"instant"});
}
addEventListener("hashchange", route);

function boot(){
  buildWeek(); route();

  $("#ageSlider").addEventListener("input", e=>{
    S.offsetH = +e.target.value;
    if(!S.machineOn){ S.machineOn = true; $("#machineSw").classList.add("on"); }
    sim();
  });
  $("#haircutSlider").addEventListener("input", e=>{ S.haircut = +e.target.value; sim(); });
  $("#collSlider").addEventListener("input", e=>{ S.collateral = +e.target.value; sim(); });
  $("#borrowSlider").addEventListener("input", e=>{ S.borrowPct = +e.target.value; sim(); });

  $("#machineSw").addEventListener("click", ()=>{
    S.machineOn = !S.machineOn;
    $("#machineSw").classList.toggle("on", S.machineOn);
    sim();
  });
  $("#resetBtn").addEventListener("click", ()=>{
    S.machineOn=false; S.offsetH=0; S.haircut=0; S.borrowPct=0;
    $("#machineSw").classList.remove("on");
    $("#ageSlider").value=0; $("#haircutSlider").value=0; $("#borrowSlider").value=0;
    sim();
  });
  $("#borrowBtn").addEventListener("click", ()=>{
    const {age,session} = machineTime();
    const conf = confidence(age, session, S.haircut);
    S.borrowPct = Math.floor(conf/BPS*100);
    $("#borrowSlider").value = S.borrowPct; sim();
  });
  $("#connectBtn").addEventListener("click", connectWallet);
  $$("#rangeSeg button").forEach(b=>b.addEventListener("click", ()=>{
    $$("#rangeSeg button").forEach(x=>x.classList.remove("on"));
    b.classList.add("on"); S.range = +b.dataset.r; renderTiles();
  }));

  addEventListener("keydown", e=>{
    if(!$("#v-dashboard").classList.contains("on")) return;
    if(e.key!=="ArrowLeft" && e.key!=="ArrowRight") return;
    const s = $("#ageSlider");
    s.value = Math.max(0, Math.min(80, +s.value + (e.key==="ArrowRight"?1:-1)));
    s.dispatchEvent(new Event("input")); e.preventDefault();
  });

  const tick = () => $("#clock").textContent = nyFmt(new Date(),{hour:"2-digit",minute:"2-digit",hour12:false})+" NY";
  tick(); setInterval(tick, 20000);

  if(window.ethereum?.on) ethereum.on("accountsChanged", a=>{
    S.wallet = a[0]||null; S.holdings=[];
    $("#connectBtn").textContent = S.wallet ? short(S.wallet) : "Connect wallet";
    S.wallet ? loadHoldings() : wNote("Disconnected.");
  });

  refresh(); setInterval(refresh, 30000);
}
document.addEventListener("DOMContentLoaded", boot);
