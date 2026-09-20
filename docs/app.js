/* NightDesk webapp. Reads Robinhood Chain mainnet directly; no backend. */

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const CHAIN_ID = 4663;
const HEARTBEAT = 86400;
const DECAY = {Open:3600, PreMarket:21600, PostMarket:21600, Closed:259200, Overnight:259200, Unknown:0};

// Contract constants, mirrored from NightDeskLending.sol.
const BASE_LTV = 7000, LIQ_LTV = 8500, MIN_BORROW = 2000, MIN_LIQ = 5000, BPS = 10000;

// Stock Token contracts on chain 4663, from the live asset registry.
const TOKENS = {
  GOOGL:"0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  QQQ:  "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68",
  TSM:  "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA",
  SGOV: "0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5",
  EWY:  "0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc",
};
const SEL_BALANCE = "0x70a08231";  // balanceOf(address)

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

let state = {
  feeds:[], block:0, session:"Unknown", lastOk:0,
  collateral:35000, asset:"GOOGL",
  anchor:0,              // unix seconds of the last real print - the time machine's origin
  offsetH:0,             // hours forward from the anchor
  wallet:null, holdings:[], usingWallet:false,
};

/* ---------------- motion ---------------- */
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const easeOutExpo = t => t===1 ? 1 : 1 - Math.pow(2, -10*t);

/* Tweens an element's number so a value change is felt rather than just seen. */
function tween(el, to, fmt, dur=620){
  if(!el) return;
  const from = el._tv ?? to;
  el._tv = to;
  if(REDUCED || from === to){ el.textContent = fmt(to); return; }
  cancelAnimationFrame(el._raf);
  const t0 = performance.now();
  const step = now => {
    const p = Math.min(1,(now-t0)/dur);
    el.textContent = fmt(from + (to-from)*easeOutExpo(p));
    if(p<1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

/* Confidence ring: circumference 2*pi*52 ~= 326.7 */
const RING_C = 326.7;
function setRing(bps){
  const ring = $("#ringFill"), lbl = $("#ringVal");
  if(!ring) return;
  ring.style.strokeDashoffset = RING_C * (1 - bps/BPS);
  ring.style.stroke = confColor(bps);
  tween(lbl, bps, v => Math.round(v));
  $("#ringSub").textContent = bps === 0 ? "no usable price"
    : bps < MIN_BORROW ? "below borrow floor"
    : bps < MIN_LIQ ? "borrow only" : "fully actionable";
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
  let answer = BigInt("0x"+w[1]);
  if(answer >> 255n) answer -= 1n << 256n;          // int256
  return {price:Number(answer)/1e8, updatedAt:Number(BigInt("0x"+w[3]))};
}

/* ---------------- wallet ---------------- */
const CHAIN_HEX = "0x" + CHAIN_ID.toString(16);   // 0x1237

function short(a){ return a.slice(0,6)+"…"+a.slice(-4); }

async function ensureChain(){
  try{
    await window.ethereum.request({method:"wallet_switchEthereumChain",
      params:[{chainId:CHAIN_HEX}]});
  }catch(e){
    // 4902 = chain unknown to the wallet; add it, then the switch sticks.
    if(e.code === 4902){
      await window.ethereum.request({method:"wallet_addEthereumChain", params:[{
        chainId:CHAIN_HEX, chainName:"Robinhood Chain",
        nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},
        rpcUrls:[RPC], blockExplorerUrls:["https://robinhoodchain.blockscout.com"],
      }]});
    } else throw e;
  }
}

async function connectWallet(){
  const btn = $("#connectBtn");
  if(!window.ethereum){
    walletNote("No injected wallet found. Install MetaMask or Rabby to load real balances.", true);
    return;
  }
  try{
    btn.disabled = true; btn.textContent = "Connecting…";
    const accts = await window.ethereum.request({method:"eth_requestAccounts"});
    await ensureChain();
    state.wallet = accts[0];
    btn.textContent = short(state.wallet);
    walletNote("Reading Stock Token balances…");
    await loadHoldings();
  }catch(e){
    walletNote(e.message || "Connection rejected.", true);
    btn.textContent = "Connect wallet";
  }finally{
    btn.disabled = false;
  }
}

function walletNote(msg, bad){
  const el = $("#walletNote");
  el.textContent = msg;
  el.style.color = bad ? "var(--coral)" : "var(--mute)";
}

/* Reads balanceOf for each tracked Stock Token. The Chainlink price already
   includes the corporate-action multiplier, so it is never applied twice. */
async function loadHoldings(){
  const pad = a => "000000000000000000000000" + a.slice(2).toLowerCase();
  const out = [];
  for(const f of FEEDS){
    const token = TOKENS[f.t];
    if(!token) continue;
    try{
      const raw = await rpc("eth_call",[{to:token, data:SEL_BALANCE + pad(state.wallet)},"latest"]);
      const bal = Number(BigInt(raw)) / 1e18;
      if(bal > 0) out.push({ticker:f.t, token, balance:bal});
    }catch(_){ /* a token that does not answer is simply not held */ }
  }
  state.holdings = out;
  renderHoldings();
}

function renderHoldings(){
  const box = $("#holdings");
  if(!state.wallet){ return; }
  if(!state.holdings.length){
    box.innerHTML = `<p style="color:var(--mute);font-size:14px;margin:0">
      No Stock Token balances at ${short(state.wallet)} on Robinhood Chain.
      The simulator below stays on its preset collateral.</p>`;
    walletNote(`Connected · ${short(state.wallet)} · no Stock Tokens held`);
    return;
  }
  const priceOf = t => (state.feeds.find(f=>f.t===t)||{}).price || 0;
  const total = state.holdings.reduce((s,h)=> s + h.balance*priceOf(h.ticker), 0);

  box.innerHTML = state.holdings.map(h=>`
    <div class="kv"><span class="k">${h.ticker}
      <span style="color:var(--faint)">· ${h.balance.toFixed(4)}</span></span>
      <span class="v">${usd(h.balance*priceOf(h.ticker))}</span></div>`).join("")
    + `<div class="kv" style="border-top:1px solid var(--line);margin-top:6px;padding-top:12px">
        <span class="k" style="color:var(--cream)">Portfolio</span>
        <span class="v" style="color:var(--sage)">${usd(total)}</span></div>
       <button class="btn ghost" id="useHoldings" style="width:100%;margin-top:14px">
        Use ${usd(total)} as collateral</button>`;

  walletNote(`Connected · ${short(state.wallet)} · ${state.holdings.length} position${state.holdings.length>1?"s":""}`);
  $("#useHoldings").addEventListener("click", ()=>{
    state.collateral = Math.round(total);
    state.usingWallet = true;
    $("#collateralSel").insertAdjacentHTML("afterbegin",
      `<option value="${Math.round(total)}" selected>${usd(total)} — your wallet</option>`);
    $("#collateralSel").value = String(Math.round(total));
    location.hash = "#position";
    sim();
  });
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
/* Opening beat: the live numbers count up as soon as the chain answers, so the
   first thing a visitor sees is the gap measuring itself. */
function landing(){
  const rows = state.feeds;
  const stale = rows.filter(r=>r.stale).length;
  const oldest = Math.max(...rows.map(r=>r.age));
  tween($("#coverage"), 19.3, v=>v.toFixed(1), 900);
  tween($("#oldest"), oldest/3600, v=>v.toFixed(1)+"h", 1100);
  const el = $("#staleCount");
  el._tv = 0;
  tween(el, stale, v=>`${Math.round(v)}/${rows.length}`, 850);
}

function renderStats(){
  const rows = state.feeds;
  if(!rows.length) return;
  const stale = rows.filter(r=>r.stale).length;
  const oldest = Math.max(...rows.map(r=>r.age));

  if(state.seeded){ $("#staleCount").textContent = `${stale}/${rows.length}`; }
  $("#staleCount").className = "v " + (stale ? "coral":"sage");
  $("#staleSub").textContent = stale===rows.length
    ? "every feed unusable by the documented rule"
    : stale ? "past the 24h heartbeat" : "all feeds within heartbeat";
  if(state.seeded) $("#oldest").textContent = fmtAge(oldest);
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
      html += `<div class="cell${open?" open":""}${now?" now":""}" data-d="${d}" data-h="${h}"></div>`;
    }
  }
  wrap.innerHTML = html;
}

/* ---------------- position builder + time machine ---------------- */

/* The slider is wall-clock time, not an abstract age. It starts at the last
   real print on chain and walks forward, so the session changes underneath you
   exactly as it would in life: Friday close, the long weekend, Monday's open. */
function machineTime(){
  const anchor = state.anchor || Math.floor(Date.now()/1000);
  const t = anchor + state.offsetH*3600;
  return {t, date:new Date(t*1000), age:state.offsetH*3600};
}

function renderMachineLabel(date, session){
  const f = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",weekday:"short",
    hour:"2-digit",minute:"2-digit",hour12:false});
  $("#machineWhen").textContent = f.format(date) + " NY";
  $("#machineSession").textContent = session;
  $("#machineSession").style.color =
    session==="Open" ? "var(--sage)" : session==="Closed" ? "var(--coral)" : "var(--amber)";
  // Move the heatmap cursor to wherever the machine is pointing.
  const {wd,h} = nyParts(date);
  $$("#week .cell").forEach(c=>c.classList.remove("now"));
  const cell = $(`#week .cell[data-d="${wd}"][data-h="${h}"]`);
  if(cell) cell.classList.add("now");
}

function sim(){
  state.offsetH = Number($("#ageSlider").value);
  const haircut = Number($("#haircutSlider").value);
  const borrowPct = Number($("#borrowSlider").value);
  const {date, age} = machineTime();
  const session = state.anchor ? sessionAt(date) : "Closed";
  const collateral = state.collateral;

  $("#ageOut").textContent = state.offsetH + "h";
  $("#haircutOut").textContent = haircut + " bps";
  renderMachineLabel(date, session);

  const conf = confidence(age, session, haircut);
  setRing(conf);

  const naiveCap = age > HEARTBEAT ? 0 : collateral*(BASE_LTV/BPS);
  const ndCap = collateral*(BASE_LTV/BPS)*(conf/BPS);
  const debt = collateral*(BASE_LTV/BPS)*(borrowPct/100);

  tween($("#borrowOut"), debt, usd);
  tween($("#naiveCap"), naiveCap, usd);
  tween($("#ndCap"), ndCap, usd);
  $("#naiveCap").style.color = naiveCap ? "var(--cream)" : "var(--coral)";
  $("#ndCap").style.color = ndCap ? "var(--sage)" : "var(--coral)";

  $("#naiveVerdict").textContent = age > HEARTBEAT
    ? "Price rejected past the heartbeat. Protocol halted — the borrower is locked out."
    : state.offsetH===0 ? "Operating normally on the last real print."
    : `Lending against a ${state.offsetH}h-old price as though it were current. No haircut.`;

  // A zero can arrive two ways, and they mean different things. Time simply
  // running out is decay. The session reopening is new information arriving -
  // the old print stops being the best estimate the moment discovery resumes.
  const reopened = conf===0 && age < DECAY.Closed &&
    (session==="PreMarket" || session==="Open" || session==="PostMarket");
  $("#ndVerdict").textContent = reopened
    ? `${session} has begun — real price discovery is resuming, so a ${state.offsetH}h-old close is no longer the best estimate. Confidence drops on purpose, at the moment the information changes.`
    : conf===0
      ? "Confidence exhausted. The price is genuinely worthless now, and we say so."
      : conf < MIN_BORROW
        ? `${conf} bps — under the ${MIN_BORROW} bps borrow floor. Existing loans stand; no new debt.`
        : `${conf} bps confidence in a ${session} session. Open at an honest haircut.`;

  const adjValue = collateral*(conf/BPS);
  const ltv = adjValue>0 ? Math.round((debt*BPS)/adjValue) : (debt>0 ? BPS*2 : 0);
  const pct = Math.min(100,(ltv/LIQ_LTV)*100);
  $("#healthFill").style.width = pct+"%";
  $("#healthFill").style.background =
    ltv>=LIQ_LTV ? "var(--coral)" : ltv>LIQ_LTV*.7 ? "var(--amber)" : "var(--sage)";
  $("#ltvOut").textContent = adjValue>0 ? (ltv/100).toFixed(1)+"%" : (debt>0 ? "∞" : "—");

  const canBorrow = conf >= MIN_BORROW, canLiq = conf >= MIN_LIQ, unhealthy = ltv >= LIQ_LTV;

  $("#gBorrow").textContent = canBorrow ? "PERMITTED" : "BLOCKED";
  $("#gBorrow").style.color = canBorrow ? "var(--sage)" : "var(--coral)";
  $("#gLiq").textContent = !unhealthy ? "N/A — POSITION HEALTHY"
    : canLiq ? "PERMITTED" : "BLOCKED — PRICE UNVERIFIABLE";
  $("#gLiq").style.color = !unhealthy ? "var(--faint)" : canLiq ? "var(--amber)" : "var(--sage)";

  $("#gSummary").textContent = !unhealthy
    ? (canBorrow
        ? "Position is healthy and the price is good enough to lend against."
        : "Position is healthy, but confidence is under the borrow floor — the loan stands, no new debt.")
    : !canLiq
      ? `Underwater on paper at ${(ltv/100).toFixed(0)}% LTV, but confidence is only ${conf} bps — under the ${MIN_LIQ} bps bar. Nobody can verify the price that says this borrower is insolvent, so the collateral stays put until the market reopens.`
      : `Underwater at ${(ltv/100).toFixed(0)}% LTV and confidence is ${conf} bps, at or above the ${MIN_LIQ} bps bar. The price is trustworthy enough to act on, so liquidation proceeds.`;
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
    // The time machine starts wherever the chain last actually printed.
    state.anchor = Math.max(...state.feeds.map(r=>r.updatedAt));
    if(state.wallet) renderHoldings();

    renderStats(); renderTable(); buildWeek(); agentLog();
    $("#chainNote").textContent =
      `chain ${CHAIN_ID} · block ${state.block.toLocaleString("en-US")} · ${new Date().toLocaleTimeString("en-US",{hour12:false})}`;
    $("#connState").textContent = "connected";
    $("#connState").style.color = "var(--sage)";

    if(!state.seeded && state.feeds.length){
      state.seeded = true;
      landing();          // the problem announces itself before any prose
      sim();
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
  $("#connectBtn").addEventListener("click", connectWallet);

  // Arrow keys scrub the time machine when the Position view is open.
  document.addEventListener("keydown", e=>{
    if(!$("#v-position").classList.contains("on")) return;
    if(e.key!=="ArrowLeft" && e.key!=="ArrowRight") return;
    const s = $("#ageSlider");
    s.value = Math.max(0, Math.min(80, Number(s.value) + (e.key==="ArrowRight"?1:-1)));
    sim(); e.preventDefault();
  });

  if(window.ethereum?.on){
    window.ethereum.on("accountsChanged", a=>{
      state.wallet = a[0]||null; state.holdings=[];
      $("#connectBtn").textContent = state.wallet ? short(state.wallet) : "Connect wallet";
      if(state.wallet) loadHoldings(); else walletNote("Disconnected.");
    });
  }
  $("#clock").textContent = new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",
    hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date())+" NY";
  setInterval(()=>{ $("#clock").textContent =
    new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"2-digit",
      minute:"2-digit",hour12:false}).format(new Date())+" NY"; }, 20000);

  route(); sim(); refresh();
  setInterval(refresh, 30000);
}
document.addEventListener("DOMContentLoaded", boot);
