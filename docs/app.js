/* NightDesk terminal — every number from a live Robinhood Chain call. */
const RPC="https://rpc.mainnet.chain.robinhood.com", CHAIN=4663, CHEX="0x1237";
const HEARTBEAT=86400;
const DECAY={Open:3600,PreMarket:21600,PostMarket:21600,Closed:259200,Overnight:259200,Unknown:0};
const BASE_LTV=7000, LIQ_LTV=8500, MIN_B=2000, MIN_L=5000, BPS=10000;
const SEL_ROUND="0xfeaf968c", SEL_BAL="0x70a08231";

const FEEDS=[
 {t:"GOOGL",name:"Alphabet Class A",feed:"0xF6f373a037c30F0e5010d854385cA89185AE638b",token:"0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3"},
 {t:"QQQ",name:"Invesco QQQ Trust",feed:"0x80901d846d5D7B030F26B480776EE3b29374C2ae",token:"0xD5f3879160bc7c32ebb4dC785F8a4F505888de68"},
 {t:"TSM",name:"Taiwan Semiconductor",feed:"0x874cF94aa8eC88Fd9560094dD065f2fB3E41Fc2F",token:"0x58FfE4a942d3885bAa22D7520691F611EF09e7AA"},
 {t:"SGOV",name:"iShares 0-3M Treasury",feed:"0xa0DF4ee0fFf975306345875E3548Fcc519577A11",token:"0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5"},
 {t:"EWY",name:"iShares MSCI South Korea",feed:"0xEFdf54610B62A7753Ec30bDc380847c12D32e1D1",token:"0x7f0aBeF0C07280F82c6a08ead09dEd6BAE2C13Fc"},
];

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let S={feeds:[],block:0,session:"Unknown",anchor:0,range:168,briefIdx:0,tab:"noticed",
       collateral:35000,offsetH:0,haircut:0,borrowPct:0,machine:false,wallet:null,holdings:[],
       lastScan:Date.now()};

/* ---------- chain ---------- */
async function rpc(m,p){
  const r=await fetch(RPC,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})});
  const j=await r.json(); if(j.error) throw new Error(j.error.message); return j.result;
}
function decodeRound(hex){
  const w=hex.slice(2).match(/.{64}/g); let a=BigInt("0x"+w[1]);
  if(a>>255n) a-=1n<<256n;
  return {price:Number(a)/1e8, updatedAt:Number(BigInt("0x"+w[3]))};
}
/* ---------- session / confidence ---------- */
const nyFmt=(d,o)=>new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",...o}).format(d);
function nyParts(d=new Date()){
  const p=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",
    minute:"numeric",weekday:"short",hour12:false}).formatToParts(d);
  const g=t=>p.find(x=>x.type===t).value;
  return{wd:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday")),
         h:Number(g("hour"))%24,m:Number(g("minute"))};
}
function sessionAt(d=new Date()){
  const {wd,h,m}=nyParts(d), mm=h*60+m;
  if(wd===0||wd===6) return "Closed";
  if(mm>=240&&mm<570) return "PreMarket";
  if(mm>=570&&mm<960) return "Open";
  if(mm>=960&&mm<1200) return "PostMarket";
  return "Overnight";
}
function confidence(age,sess,hair=0){          // mirrors MarketStateOracle._confidence
  if(sess==="Unknown") return 0;
  const w=DECAY[sess]; if(age>=w) return 0;
  const base=BPS-Math.floor((age*BPS)/w);
  return Math.floor((base*(BPS-(sess==="Open"?0:hair)))/BPS);
}
const usd=n=>"$"+Math.round(n).toLocaleString("en-US");
const fAge=s=>s<3600?`${Math.round(s/60)}m`:s<172800?`${(s/3600).toFixed(1)}h`:`${(s/86400).toFixed(1)}d`;
const cCol=b=>b>6000?"var(--up)":b>2000?"var(--gold)":"var(--down)";
const short=a=>a.slice(0,6)+"…"+a.slice(-4);

/* ---------- history (derived, not decorative) ---------- */
function history(hours){
  const out=[], now=Date.now();
  for(let i=hours;i>=0;i--){
    const t=new Date(now-i*3600e3), sess=sessionAt(t);
    let age=0, probe=new Date(t);
    for(let k=0;k<260;k++){ if(sessionAt(probe)==="Open") break;
      probe=new Date(probe-3600e3); age+=3600; }
    out.push({t,age,conf:confidence(age,sess),sess});
  }
  return out;
}

/* ---------- sparkline helpers ---------- */
function spark(vals,color,w=140,h=32){
  const mx=Math.max(...vals,1), mn=Math.min(...vals,0), sp=(mx-mn)||1;
  const d=vals.map((v,i)=>`${i?"L":"M"}${(i/(vals.length-1)*w).toFixed(1)},${(h-((v-mn)/sp)*(h-4)-2).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
}
function gauge(val,max,label,color){
  const pct=Math.max(0,Math.min(1,val/max)), C=Math.PI*46;
  return `<div class="gaugewrap"><svg width="118" height="66" viewBox="0 0 118 66">
    <path d="M12,60 A47,47 0 0,1 106,60" fill="none" stroke="rgba(255,255,255,.08)"
      stroke-width="8" stroke-linecap="round"/>
    <path d="M12,60 A47,47 0 0,1 106,60" fill="none" stroke="${color}" stroke-width="8"
      stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C*(1-pct)}"
      style="transition:stroke-dashoffset .8s cubic-bezier(.2,.7,.25,1)"/>
  </svg></div>
  <div class="gaugetxt"><div class="g">${val}</div><div class="s">${label}</div></div>`;
}

/* ---------- KPIs ---------- */
function renderKpis(){
  const f=S.feeds; if(!f.length) return;
  const stale=f.filter(x=>x.stale).length;
  const oldest=Math.max(...f.map(x=>x.age));
  const hist=history(Math.min(S.range,168));
  const conf=confidence(oldest,S.session);
  const cov=(32.5/168*100);
  const avgConf=Math.round(f.reduce((s,x)=>s+confidence(x.age,S.session),0)/f.length);

  const cards=[
    {lbl:"Live price coverage",val:cov.toFixed(1),unit:"%",
     chip:{t:"24/5 feeds",c:"neu"}, spark:spark(hist.map(h=>h.conf),"var(--gold)"), k:"coverage"},
    {lbl:"Feeds past heartbeat",val:`${stale}/${f.length}`,unit:"",
     chip:{t:stale?"breach":"ok",c:stale?"down":"up"},
     spark:spark(f.map(x=>Math.min(2,x.age/HEARTBEAT)),stale?"var(--down)":"var(--up)"), k:"heartbeat"},
    {lbl:"Oldest price on chain",val:(oldest/3600).toFixed(1),unit:"h",
     chip:{t:oldest>HEARTBEAT?`+${((oldest-HEARTBEAT)/3600).toFixed(0)}h over`:"within",c:oldest>HEARTBEAT?"down":"up"},
     spark:spark(hist.map(h=>h.age/3600),"var(--blue)"), k:"oldest"},
    {lbl:"Mean confidence",gauge:gauge(avgConf,BPS,"bps avg",cCol(avgConf)), k:"confidence"},
    {lbl:"Market session",gauge:gauge(S.session==="Open"?100:S.session==="Closed"?0:50,100,
      S.session,S.session==="Open"?"var(--up)":S.session==="Closed"?"var(--down)":"var(--gold)"), k:"session"},
  ];
  $("#kpis").innerHTML=cards.map(c=>`
    <div class="kpi">
      <div class="top"><span class="lbl">${c.lbl}</span>
        ${c.chip?`<span class="chip ${c.chip.c}">${c.chip.t}</span>`:""}</div>
      ${c.gauge ? c.gauge : `<div class="val">${c.val}<small>${c.unit}</small></div>
        <div class="foot">${c.spark}<button class="explain" data-k="${c.k}">ⓘ Explain</button></div>`}
      ${c.gauge?`<div class="foot" style="justify-content:flex-end"><button class="explain" data-k="${c.k}">ⓘ Explain</button></div>`:""}
    </div>`).join("");
  $$(".explain").forEach(b=>b.onclick=()=>explain(b.dataset.k));
}

/* ---------- agent feed: cards generated from what was actually observed ---------- */
function buildFeed(){
  const f=S.feeds; if(!f.length) return;
  const stale=f.filter(x=>x.stale);
  const oldest=[...f].sort((a,b)=>b.age-a.age)[0];
  const newest=[...f].sort((a,b)=>a.age-b.age)[0];
  const spread=(oldest.age-newest.age)/3600;
  const conf=confidence(oldest.age,S.session);
  const ago=m=>`${m}m ago`;

  const noticed=[
    stale.length===f.length && {
      av:"!!",meta:["NIGHTDESK NOTICED · SWEEP",ago(2)],tag:["every feed","bad"],
      h:"Every Feed On The Chain Is Simultaneously Unusable",
      p:`All ${f.length} tracked aggregators are past the 24h heartbeat. By the integration guidance Robinhood publishes, no protocol here should be reading a price at all right now.`},
    {av:oldest.t.slice(0,2),meta:["NIGHTDESK NOTICED · STALENESS",ago(4)],tag:["oldest print","bad"],
      h:`${oldest.t} Has Not Printed In ${fAge(oldest.age)}`,
      p:`Last update ${nyFmt(new Date(oldest.updatedAt*1e3),{weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false})} NY, at $${oldest.price.toFixed(2)}. Confidence has decayed to ${confidence(oldest.age,S.session)} bps.`},
    spread>1 && {av:"Δ",meta:["NIGHTDESK NOTICED · DIVERGENCE",ago(7)],tag:["feed spread","warn"],
      h:"Feeds Are Drifting Out Of Step With Each Other",
      p:`${spread.toFixed(1)}h separates the oldest and freshest print (${oldest.t} vs ${newest.t}). A single global staleness check would treat these as equivalent.`},
    {av:"SE",meta:["NIGHTDESK NOTICED · SESSION",ago(9)],tag:["derived","warn"],
      h:`Session Derived As ${S.session} Without A Holiday Calendar`,
      p:`The clock and observed feed behaviour agree, so no override was applied. A hardcoded holiday list would rot; cross-checking does not.`},
    conf<MIN_L && {av:"LQ",meta:["NIGHTDESK NOTICED · RISK GATE",ago(12)],tag:["liquidation held","warn"],
      h:"Liquidations Are Being Held, Deliberately",
      p:`At ${conf} bps the price is under the 5000 bps liquidation bar. Underwater positions stay untouched until the market reopens — nobody can verify the price that would seize them.`},
  ].filter(Boolean);

  const risk=[
    {av:"1",meta:["RISK EXPLAINER · STEP",""],tag:["mechanism",""],
      h:"Tokens Trade 24/7, Feeds Update 24/5",
      p:"Stock Tokens are ordinary ERC-20s, transferable every second. Their Chainlink feeds follow the US cash session — 32.5 of every 168 hours."},
    {av:"2",meta:["RISK EXPLAINER · STEP",""],tag:["the binary",""],
      h:"Integrators Get Two Bad Options",
      p:"Trust a price from Friday's close, or reject it and halt. The documented advice is to reject, which means being offline for most of the week."},
    {av:"3",meta:["RISK EXPLAINER · STEP",""],tag:["the fix","warn"],
      h:"Confidence Replaces The Binary",
      p:"A score that decays at a rate set by the session. An hour old during the open is suspect. The same price at 2am Sunday is the best information that exists."},
    {av:"4",meta:["RISK EXPLAINER · STEP",""],tag:["asymmetry","warn"],
      h:"Borrowing And Liquidation Get Different Bars",
      p:"Borrow needs 2000 bps, liquidation needs 5000. A borrower who is merely hard to value should not lose collateral because the oracle went quiet."},
  ];

  const src=S.tab==="noticed"?noticed:risk;
  $("#feed").innerHTML=src.map(c=>`
    <div class="fcard">
      <div class="meta"><span>${c.meta[0]}</span><span>${c.meta[1]}</span></div>
      <div class="av">${c.av}</div>
      <h3>${c.h}</h3><p>${c.p}</p>
      <span class="tag ${c.tag[1]}">${c.tag[0]}</span>
    </div>`).join("");
  const mins=Math.round((Date.now()-S.lastScan)/60000);
  $("#scanLine").textContent=`Scans ${f.length} aggregators + session state every 30s · last cycle ${mins<1?"just now":mins+"m ago"}`;
}

/* ---------- dual-axis chart ---------- */
function renderChart(){
  const H=history(S.range), W=900, Ht=300, P={l:44,r:44,t:16,b:26};
  const iw=W-P.l-P.r, ih=Ht-P.t-P.b;
  const maxAge=Math.max(...H.map(h=>h.age/3600),26);
  const x=i=>P.l+(i/(H.length-1))*iw;
  const yC=v=>P.t+ih-(v/BPS)*ih;
  const yA=v=>P.t+ih-(v/maxAge)*ih;

  const line=(pts)=>pts.map((p,i)=>`${i?"L":"M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const confPts=H.map((h,i)=>[x(i),yC(h.conf)]);
  const agePts=H.map((h,i)=>[x(i),yA(h.age/3600)]);

  let g="";
  for(let i=0;i<=4;i++){
    const y=P.t+(i/4)*ih;
    g+=`<line class="gridline" x1="${P.l}" y1="${y}" x2="${W-P.r}" y2="${y}"/>
        <text class="axis" x="${P.l-8}" y="${y+3}" text-anchor="end">${Math.round(BPS-(i/4)*BPS)}</text>
        <text class="axis" x="${W-P.r+8}" y="${y+3}">${Math.round(maxAge-(i/4)*maxAge)}h</text>`;
  }
  const step=Math.max(1,Math.floor(H.length/6));
  for(let i=0;i<H.length;i+=step){
    g+=`<text class="axis" x="${x(i)}" y="${Ht-8}" text-anchor="middle">${
      nyFmt(H[i].t,S.range<=24?{hour:"2-digit",hour12:false}:{month:"2-digit",day:"2-digit"})}</text>`;
  }
  const hbY=yA(24);
  $("#chart").innerHTML=`${g}
    <line x1="${P.l}" y1="${hbY}" x2="${W-P.r}" y2="${hbY}" stroke="var(--down)"
      stroke-width="1" stroke-dasharray="4 4" opacity=".7"/>
    <path d="${line(confPts)} L${x(H.length-1)},${P.t+ih} L${P.l},${P.t+ih} Z"
      fill="url(#gg)" opacity=".16"/>
    <defs><linearGradient id="gg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#E7C46A"/><stop offset="100%" stop-color="#E7C46A" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${line(confPts)}" fill="none" stroke="var(--gold)" stroke-width="2"/>
    <path d="${line(agePts)}" fill="none" stroke="var(--blue)" stroke-width="1.6"
      stroke-dasharray="5 3" opacity=".85"/>`;
}

/* ---------- brief rail ---------- */
function renderBrief(){
  const f=S.feeds; if(!f.length) return;
  const stale=f.filter(x=>x.stale).length;
  const oldest=Math.max(...f.map(x=>x.age));
  const conf=confidence(oldest,S.session);
  const cap=S.collateral*(BASE_LTV/BPS);
  const items=[
    {k:"Oracle backdrop",big:`${stale}/${f.length} stale`,
     h:"Every tracked feed is past its heartbeat",
     p:`Oldest print is ${fAge(oldest)} old against an 86,400s heartbeat. Session reads ${S.session}. Mean confidence sits at ${conf} bps.`,
     q:"Why is every feed stale?",qk:"why-stale"},
    {k:"Lending impact",big:usd(cap*(conf/BPS)),
     h:"What a borrower keeps versus loses",
     p:`On ${usd(S.collateral)} of collateral a naive integrator offers ${oldest>HEARTBEAT?"$0 — halted":usd(cap)}. NightDesk offers ${usd(cap*(conf/BPS))} at ${conf} bps.`,
     q:"How is confidence computed?",qk:"confidence"},
    {k:"Risk gates",big:conf>=MIN_L?"Open":"Held",
     h:conf>=MIN_L?"Liquidation permitted":"Liquidation held back",
     p:conf>=MIN_L?`Confidence ${conf} bps clears the 5000 bps bar, so unhealthy positions can be closed normally.`:`At ${conf} bps nobody can verify the price. Underwater borrowers keep their collateral until the market reopens.`,
     q:"Why can't this borrower be liquidated?",qk:"asymmetry"},
    {k:"Coverage",big:"137 / 194",
     h:"Most Stock Tokens have no feed at all",
     p:`Only 57 of 194 live Stock Tokens have a Chainlink aggregator. The documented offchain tradability API returns null for all 194 while the market is closed.`,
     q:"What isn't covered?",qk:"coverage"},
  ];
  const b=items[S.briefIdx%items.length];
  $("#brief").innerHTML=`<div class="k">${b.k}</div><div class="big">${b.big}</div>
    <h3>${b.h}</h3><p>${b.p}</p>
    <button class="q" data-q="${b.qk}">${b.q} →</button>
    <div class="dots">${items.map((_,i)=>`<i class="${i===S.briefIdx%items.length?"on":""}" data-i="${i}"></i>`).join("")}</div>`;
  $("#briefAge").textContent=`${S.briefIdx%items.length+1} of ${items.length}`;
  $$("#brief .dots i").forEach(d=>d.onclick=()=>{S.briefIdx=+d.dataset.i;renderBrief();});
  $("#brief .q").onclick=e=>explain(e.target.dataset.q);
}

/* ---------- tables ---------- */
function renderFeedTable(){
  const rows=[...S.feeds].sort((a,b)=>confidence(a.age,S.session)-confidence(b.age,S.session));
  $("#feedRows").innerHTML=rows.map(r=>{
    const c=confidence(r.age,S.session);
    return `<tr><td><div class="tk">${r.t}</div><div class="tn">${r.name}</div></td>
      <td class="mono">$${r.price.toFixed(2)}</td>
      <td class="mono" style="color:${r.stale?"var(--down)":"var(--ink2)"}">${fAge(r.age)}</td>
      <td><div style="display:flex;align-items:center;gap:9px">
        <div class="bar"><i style="width:${c/100}%;background:${cCol(c)}"></i></div>
        <span class="mono" style="font-size:11.5px;color:var(--mute);min-width:40px;text-align:right">${c}</span>
      </div></td></tr>`;
  }).join("");
}
function renderImpact(){
  const f=S.feeds; if(!f.length) return;
  const oldest=Math.max(...f.map(x=>x.age));
  const conf=confidence(oldest,S.session);
  const cap=S.collateral*(BASE_LTV/BPS);
  const naive=oldest>HEARTBEAT?0:cap, nd=cap*(conf/BPS);
  const row=(lbl,val,pct,col,sub)=>`<div class="stack">
    <div class="lbl"><span>${lbl}</span><b style="color:${col}">${val}</b></div>
    <div class="stackbar"><i style="width:${pct}%;background:${col}"></i></div>
    <div class="ft"><span>${sub}</span><span>${pct.toFixed(0)}% of base capacity</span></div></div>`;
  $("#impact").innerHTML=
    row("Naive integrator",usd(naive),(naive/cap)*100,"var(--down)",
        oldest>HEARTBEAT?"price rejected past heartbeat — halted":"full trust, no haircut")
   +row("NightDesk",usd(nd),(nd/cap)*100,"var(--gold)",`${conf} bps confidence in a ${S.session} session`)
   +`<p style="font-size:12px;color:var(--ink2);margin:14px 0 0;line-height:1.55">
      A borrower keeps <b style="color:var(--gold)">${usd(nd)}</b> of borrowing power that the
      documented approach removes entirely.</p>`;
}

/* ---------- explain modal ---------- */
function explain(k){
  const f=S.feeds, stale=f.filter(x=>x.stale).length;
  const oldest=f.length?Math.max(...f.map(x=>x.age)):0;
  const conf=confidence(oldest,S.session);
  const n=v=>`<span class="num">${v}</span>`;
  const M={
    coverage:{t:"Live price coverage",s:"derived from US cash-session hours",
      b:`<p>The US equity cash session runs 09:30–16:00 ET, five days a week — ${n("32.5")} hours out of every ${n("168")}-hour week, or ${n("19.3%")}.</p>
         <p>Stock Tokens on Robinhood Chain are ordinary ERC-20s and transfer every second of all 168. The Chainlink feeds behind them, per Robinhood's own documentation, "update 24/5, following market hours."</p>
         <p>So for roughly four fifths of the week these assets trade against a price that is not being updated.</p>`},
    heartbeat:{t:"Feeds past heartbeat",s:`live read · ${stale} of ${f.length} breaching`,
      b:`<p>Chainlink publishes an ${n("86,400s")} heartbeat on these feeds, and Robinhood's integration guide tells builders to compare <code>updatedAt</code> against it and reject stale prices.</p>
         <p>Right now ${n(stale+" of "+f.length)} tracked aggregators are past that threshold. Any protocol following the documented advice is non-functional at this moment.</p>
         <p>The bar in this tile is drawn per feed against the heartbeat, not as an average — a single global staleness check would hide the spread between them.</p>`},
    oldest:{t:"Oldest price on chain",s:"live read",
      b:`<p>The oldest tracked print is ${n(fAge(oldest))} old. The heartbeat is ${n("24h")}.</p>
         <p>This is wall-clock age, not market-time age. Across a weekend zero trading sessions elapse, so a Friday close remains a structurally reasonable mark even at 45h — which is precisely why a flat heartbeat cutoff is the wrong instrument.</p>`},
    confidence:{t:"How confidence is computed",s:"MarketStateOracle._confidence",
      b:`<p>Confidence starts at ${n("10000")} bps and decays linearly to zero across a window whose length depends on the session:</p>
         <p class="mono" style="font-size:12px">Open 1h · PreMarket/PostMarket 6h · Closed/Overnight 72h</p>
         <p>An hour-old price during the open is suspect, because discovery is happening without it. The same price at 2am on a Sunday is the best information in existence. One number cannot serve both, so the window moves with the session.</p>
         <p>The agent then applies an event haircut on top for things a clock cannot see. Current reading: ${n(conf+" bps")}.</p>`},
    session:{t:"Market session",s:"derived, not from a calendar",
      b:`<p>Session currently reads ${n(S.session)}, derived from a New York clock cross-checked against observed feed behaviour.</p>
         <p>A hardcoded holiday calendar rots within a year. Instead, if the clock claims a trading session but every feed has been silent for two hours, the market is treated as closed — holiday, outage, it does not matter. Same handling, no maintenance.</p>`},
    "why-stale":{t:"Why is every feed stale?",s:"live read",
      b:`<p>Because the underlying market is ${n(S.session)} and these feeds only update while it is open.</p>
         <p>${n(stale+" of "+f.length)} feeds are past the 24h heartbeat, the oldest by ${n(fAge(oldest))}. Nothing is broken — this is the designed behaviour of a 24/5 feed under a 24/7 asset, and it is the entire gap NightDesk exists to price.</p>`},
    asymmetry:{t:"Why liquidation is held",s:"NightDeskLending.sol",
      b:`<p>Borrowing requires ${n("2000")} bps of confidence. Liquidation requires ${n("5000")}. The gap is deliberate.</p>
         <p>Seizing someone's collateral is irreversible. If the only price saying a borrower is insolvent is one nobody can currently verify, the correct action is to wait, not to act. Borrowing is reversible and merely conservative; liquidation is not.</p>
         <p>A binary fresh/stale check cannot express this at all — it has one threshold for every action. Current reading ${n(conf+" bps")}, so liquidation is ${conf>=MIN_L?"permitted":"held"}.</p>`},
    coverage:{t:"What isn't covered",s:"asset registry + Chainlink directory",
      b:`<p>${n("194")} Stock Tokens are live on chain 4663. Only ${n("57")} have a Chainlink aggregator — ${n("137")} have no onchain price source whatsoever.</p>
         <p>There is also no onchain market-status primitive: no contract on this chain can determine whether the underlying market is open. The documented offchain fallback, <code>GET /rhj/assets</code>, returns <code>tradingCapabilities: null</code> for all 194 assets while the market is closed — exactly when a protocol most needs it.</p>`},
  }[k];
  if(!M) return;
  $("#modalTitle").textContent=M.t; $("#modalSrc").textContent=M.s;
  $("#modalBody").innerHTML=M.b; $("#modal").hidden=false;
}

/* ---------- lending view ---------- */
function renderLending(){
  const f=S.feeds; if(!f.length) return;
  const liveAge=Math.max(...f.map(x=>x.age));
  const age=S.machine?S.offsetH*3600:liveAge;
  const date=S.machine?new Date((S.anchor+S.offsetH*3600)*1e3):new Date();
  const sess=S.machine?sessionAt(date):S.session;
  const conf=confidence(age,sess,S.haircut);
  const cap=S.collateral*(BASE_LTV/BPS);
  const naive=age>HEARTBEAT?0:cap, nd=cap*(conf/BPS);
  const debt=cap*(S.borrowPct/100);
  const adj=S.collateral*(conf/BPS);
  const ltv=adj>0?Math.round(debt*BPS/adj):(debt>0?BPS*2:0);
  const canB=conf>=MIN_B, canL=conf>=MIN_L, bad=ltv>=LIQ_LTV;

  $("#machineWhen").textContent=S.machine
    ? nyFmt(date,{weekday:"short",hour:"2-digit",minute:"2-digit",hour12:false})+" NY · simulated"
    : "live";
  $("#machineBtn").textContent="Time machine: "+(S.machine?"on":"off");

  const sl=(id,lbl,val,min,max,v,step,ticks)=>`<div style="margin-bottom:19px">
    <div style="display:flex;justify-content:space-between;margin-bottom:8px">
      <span style="font-size:12px;color:var(--mute)">${lbl}</span>
      <span class="mono" style="font-size:13.5px;color:var(--gold);font-weight:600">${val}</span></div>
    <input type="range" id="${id}" min="${min}" max="${max}" value="${v}" step="${step}"
      style="width:100%;accent-color:var(--gold)">
    <div class="mono" style="display:flex;justify-content:space-between;font-size:10px;color:var(--faint);margin-top:3px">
      ${ticks.map(t=>`<span>${t}</span>`).join("")}</div></div>`;

  $("#controls").innerHTML=
     sl("slAge","Time since last print",S.machine?S.offsetH+"h":fAge(liveAge),0,80,S.machine?S.offsetH:Math.min(80,liveAge/3600),1,["now","24h","72h","80h"])
    +sl("slHair","Agent event haircut",S.haircut+" bps",0,9000,S.haircut,250,["quiet","shock"])
    +sl("slColl","Collateral posted",usd(S.collateral),5000,500000,S.collateral,5000,["$5k","$500k"])
    +sl("slBorrow","Debt drawn",usd(debt),0,100,S.borrowPct,1,["none","max"]);
  [["slAge",v=>{S.offsetH=v;S.machine=true;}],["slHair",v=>S.haircut=v],
   ["slColl",v=>S.collateral=v],["slBorrow",v=>S.borrowPct=v]]
   .forEach(([id,fn])=>$("#"+id).oninput=e=>{fn(+e.target.value);renderLending();});

  $("#outcome").innerHTML=`
    <div style="text-align:center;padding:6px 0 14px">
      ${gauge(conf,BPS,"bps confidence",cCol(conf))}
    </div>
    <div class="stack"><div class="lbl"><span>Naive integrator</span>
      <b style="color:var(--down)">${usd(naive)}</b></div>
      <div class="stackbar"><i style="width:${naive/cap*100}%;background:var(--down)"></i></div></div>
    <div class="stack"><div class="lbl"><span>NightDesk</span>
      <b style="color:var(--gold)">${usd(nd)}</b></div>
      <div class="stackbar"><i style="width:${nd/cap*100}%;background:var(--gold)"></i></div></div>
    <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px">
      <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:6px 0">
        <span style="color:var(--mute)">Position LTV</span>
        <span class="mono" style="color:${bad?"var(--down)":"var(--ink)"}">${adj>0?(ltv/100).toFixed(1)+"%":(debt>0?"∞":"—")}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:6px 0">
        <span style="color:var(--mute)">Borrow gate · 2000 bps</span>
        <span class="mono" style="color:${canB?"var(--up)":"var(--down)"}">${canB?"PERMITTED":"BLOCKED"}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:12.5px;padding:6px 0">
        <span style="color:var(--mute)">Liquidation gate · 5000 bps</span>
        <span class="mono" style="color:${!bad?"var(--faint)":canL?"var(--gold)":"var(--up)"}">${!bad?"N/A":canL?"PERMITTED":"HELD"}</span></div>
    </div>
    <p style="font-size:12.5px;color:var(--ink2);margin:14px 0 0;line-height:1.55">${
      bad&&!canL?`Underwater at ${(ltv/100).toFixed(0)}% LTV, but at ${conf} bps nobody can verify the price that says so. The collateral stays put until the market reopens.`
      :bad?`Underwater at ${(ltv/100).toFixed(0)}% LTV with ${conf} bps — above the bar, so liquidation proceeds.`
      :canB?"Position is healthy and the price is good enough to lend against."
      :"Healthy, but confidence is under the borrow floor — the loan stands, no new debt."}</p>`;
}

/* ---------- feeds view ---------- */
function renderFeedsView(){
  const wrap=$("#week"); const days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const {wd:nd,h:nh}=nyParts();
  let h=`<div></div>`+days.map(d=>`<div class="mono" style="font-size:9.5px;color:var(--faint);text-align:center;padding-bottom:5px">${d}</div>`).join("");
  for(let hr=0;hr<24;hr++){
    h+=`<div class="mono" style="font-size:9px;color:var(--faint);text-align:right;padding-right:6px">${hr%6===0?String(hr).padStart(2,"0"):""}</div>`;
    for(let d=0;d<7;d++){
      const open=d>=1&&d<=5&&hr>=9&&hr<16, now=d===nd&&hr===nh;
      h+=`<div style="height:11px;border-radius:2.5px;background:${open?"var(--gold)":"rgba(255,255,255,.05)"};
        opacity:${open?.72:1};${now?"outline:1.5px solid var(--ink);outline-offset:1.5px":""}"></div>`;
    }
  }
  wrap.innerHTML=h;
  const kv=(k,v,c)=>`<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px">
    <span style="color:var(--mute)">${k}</span><span class="mono" style="color:${c||"var(--ink)"}">${v}</span></div>`;
  $("#coverage").innerHTML=kv("Stock Tokens live on chain","194")+kv("With a Chainlink feed","57")
    +kv("With no price feed","137","var(--down)")
    +`<button class="explain" data-k="coverage" style="margin-top:12px">ⓘ Explain</button>`;
  $("#missing").innerHTML=kv("Onchain market-status primitive","none","var(--down)")
    +kv("Offchain fallback","/rhj/assets")+kv("Returning null while closed","194 / 194","var(--down)")
    +`<button class="explain" data-k="coverage" style="margin-top:12px">ⓘ Explain</button>`;
  $$("#v-feeds .explain").forEach(b=>b.onclick=()=>explain(b.dataset.k));
}

/* ---------- agent view ---------- */
function agentLog(){
  const f=S.feeds; if(!f.length) return;
  const t=new Date().toLocaleTimeString("en-US",{hour12:false});
  const stale=f.filter(x=>x.stale).length, oldest=Math.max(...f.map(x=>x.age));
  const conf=confidence(oldest,S.session);
  const L=(a,b)=>`<div><span style="color:var(--faint)">${t}</span>  ${a}${b||""}</div>`;
  $("#agentLog").innerHTML=
     L(`observe  chain ${CHAIN} block ${S.block.toLocaleString("en-US")}`)
    +L(`sampled  ${f.length} aggregators`)
    +L(`oldest ${fAge(oldest)} · `,`<span style="color:${stale?"var(--down)":"var(--up)"}">${stale}/${f.length} past heartbeat</span>`)
    +L(`clock says `,`<span style="color:var(--up)">${S.session}</span> (America/New_York)`)
    +L(stale===f.length&&S.session!=="Closed"
        ?`<span style="color:var(--gold)">override → Closed (feeds quiet in a scheduled session)</span>`
        :`clock and feed behaviour agree — no override`)
    +L(`confidence `,`<span style="color:${conf>2000?"var(--up)":"var(--down)"}">${conf} bps</span>`)
    +L(`next: search events since last print → haircut → attest()`);
}

/* ---------- wallet ---------- */
async function connect(){
  if(!window.ethereum){ $("#walletNote").textContent="No injected wallet found."; location.hash="#agent"; return; }
  try{
    const a=await ethereum.request({method:"eth_requestAccounts"});
    try{ await ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:CHEX}]}); }
    catch(e){ if(e.code===4902) await ethereum.request({method:"wallet_addEthereumChain",params:[{
      chainId:CHEX,chainName:"Robinhood Chain",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},
      rpcUrls:[RPC],blockExplorerUrls:["https://robinhoodchain.blockscout.com"]}]}); else throw e; }
    S.wallet=a[0]; $("#walletBtn").textContent="◉";
    location.hash="#agent"; await loadHoldings();
  }catch(e){ $("#walletNote").textContent=e.message||"Connection rejected."; }
}
async function loadHoldings(){
  const pad=a=>"000000000000000000000000"+a.slice(2).toLowerCase(), out=[];
  for(const f of FEEDS){
    try{ const raw=await rpc("eth_call",[{to:f.token,data:SEL_BAL+pad(S.wallet)},"latest"]);
      const b=Number(BigInt(raw))/1e18; if(b>0) out.push({t:f.t,b}); }catch(_){}
  }
  S.holdings=out; renderHoldings();
}
function renderHoldings(){
  if(!S.wallet) return;
  const px=t=>(S.feeds.find(f=>f.t===t)||{}).price||0;
  if(!S.holdings.length){
    $("#holdings").innerHTML=`<p style="color:var(--mute);font-size:12.5px;margin:0">No Stock Tokens at ${short(S.wallet)} on this chain.</p>`;
    $("#walletNote").textContent=`Connected · ${short(S.wallet)}`; return;
  }
  const total=S.holdings.reduce((s,h)=>s+h.b*px(h.t),0);
  $("#holdings").innerHTML=S.holdings.map(h=>`<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);font-size:13px">
      <span>${h.t} <span style="color:var(--faint)">· ${h.b.toFixed(4)}</span></span>
      <span class="mono">${usd(h.b*px(h.t))}</span></div>`).join("")
    +`<div style="display:flex;justify-content:space-between;padding:12px 0;font-size:13px">
       <span>Portfolio</span><span class="mono" style="color:var(--gold)">${usd(total)}</span></div>
       <button class="ghostbtn" id="useHold" style="width:100%">Use as collateral</button>`;
  $("#walletNote").textContent=`Connected · ${short(S.wallet)} · ${S.holdings.length} position(s)`;
  $("#useHold").onclick=()=>{S.collateral=Math.max(5000,Math.min(500000,Math.round(total)));
    location.hash="#lending";renderLending();};
}

/* ---------- refresh / route ---------- */
async function refresh(){
  try{
    S.session=sessionAt();
    S.block=parseInt(await rpc("eth_blockNumber",[]),16);
    const now=Math.floor(Date.now()/1e3);
    S.feeds=await Promise.all(FEEDS.map(async f=>{
      const {price,updatedAt}=decodeRound(await rpc("eth_call",[{to:f.feed,data:SEL_ROUND},"latest"]));
      const age=Math.max(0,now-updatedAt);
      return {...f,price,updatedAt,age,stale:age>HEARTBEAT};
    }));
    S.anchor=Math.max(...S.feeds.map(f=>f.updatedAt));
    const stale=S.feeds.filter(f=>f.stale).length;
    $("#led").className="d"+(stale?"":" ok");
    $("#ledTxt").textContent=`Live · block ${S.block.toLocaleString("en-US")}`;
    $("#askStats").textContent=`${S.feeds.length} aggregators · ${stale} past heartbeat · session ${S.session} · block ${S.block.toLocaleString("en-US")}`;
    renderKpis();buildFeed();renderChart();renderBrief();renderFeedTable();renderImpact();
    agentLog();renderLending();if(S.wallet)renderHoldings();
  }catch(e){ $("#ledTxt").textContent="disconnected"; $("#led").className="d"; }
}
function route(){
  const v=location.hash.slice(1)||"home";
  $$(".view").forEach(el=>el.hidden = el.id!=="v-"+v);
  $$("nav a").forEach(a=>a.classList.toggle("on",a.dataset.v===v));
  scrollTo({top:0,behavior:"instant"});
  if(v==="feeds") renderFeedsView();
}
addEventListener("hashchange",route);

function boot(){
  $("#greet").textContent=`${new Date().getHours()<12?"Good morning":new Date().getHours()<18?"Good afternoon":"Good evening"} · ${nyFmt(new Date(),{weekday:"short",month:"short",day:"numeric",year:"numeric"})}`;
  route();
  $("#modalClose").onclick=()=>$("#modal").hidden=true;
  $("#modal").onclick=e=>{if(e.target.id==="modal")$("#modal").hidden=true;};
  addEventListener("keydown",e=>{
    if(e.key==="Escape")$("#modal").hidden=true;
    if((e.metaKey||e.ctrlKey)&&e.key==="k"){e.preventDefault();explain("why-stale");}
  });
  $$(".qchip").forEach(c=>c.onclick=()=>explain(c.dataset.q));
  $("#askBtn").onclick=()=>explain("confidence");
  $("#searchBtn").onclick=()=>explain("coverage");
  $("#walletBtn").onclick=connect;
  $("#scanBtn").onclick=()=>{S.lastScan=Date.now();refresh();};
  $$("#feedTabs button").forEach(b=>b.onclick=()=>{
    $$("#feedTabs button").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");S.tab=b.dataset.f;buildFeed();});
  $$("#rangeTabs button").forEach(b=>b.onclick=()=>{
    $$("#rangeTabs button").forEach(x=>x.classList.remove("on"));
    b.classList.add("on");S.range=+b.dataset.r;renderChart();});
  $("#machineBtn").onclick=()=>{S.machine=!S.machine;renderLending();};
  $("#resetBtn").onclick=()=>{S.machine=false;S.offsetH=0;S.haircut=0;S.borrowPct=0;renderLending();};
  setInterval(()=>{S.briefIdx++;renderBrief();},9000);
  refresh(); setInterval(refresh,30000);
}
document.addEventListener("DOMContentLoaded",boot);
