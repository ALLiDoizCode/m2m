(function(){const n=document.createElement("link").relList;if(n&&n.supports&&n.supports("modulepreload"))return;for(const i of document.querySelectorAll('link[rel="modulepreload"]'))a(i);new MutationObserver(i=>{for(const r of i)if(r.type==="childList")for(const c of r.addedNodes)c.tagName==="LINK"&&c.rel==="modulepreload"&&a(c)}).observe(document,{childList:!0,subtree:!0});function o(i){const r={};return i.integrity&&(r.integrity=i.integrity),i.referrerPolicy&&(r.referrerPolicy=i.referrerPolicy),i.crossOrigin==="use-credentials"?r.credentials="include":i.crossOrigin==="anonymous"?r.credentials="omit":r.credentials="same-origin",r}function a(i){if(i.ep)return;i.ep=!0;const r=o(i);fetch(i.href,r)}})();const k="B62qnZnmV3jADwYCpofKdbS23Z6vP89w7TC6rsXw9ejR53YfTwmKLsa",M="B62qk3RsLgL38Vk7nDzGT3XHBjtzN9W9zz4A6WS2a6DhBMac9N8NKDs",U="wwLYGJExaeGvWGqUThMiF8TpFyhuByCXh4SCKocCtRAQUQdsyq",L="https://api.minascan.io/node/devnet/v1/graphql",_=6,v=10n**BigInt(_),S=1000n,C=1000n,x=480n,B=e=>`https://minascan.io/devnet/tx/${e}`,A=e=>`https://minascan.io/devnet/account/${e}`,$="https://www.aurowallet.com/",R="https://faucet.minaprotocol.com",O=["devnet","testnet"],P=1n<<32n;function q(e){return{windowStart:e>>32n,mintedInWindow:e&P-1n}}async function D(e){return(await(await fetch(L,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:e})})).json()).data}async function W(){try{const n=(await D("query { bestChain(maxLength: 1) { protocolState { consensusState { slotSinceGenesis } } } }")).bestChain?.[0]?.protocolState.consensusState.slotSinceGenesis;return n?BigInt(n):0n}catch{return 0n}}async function j(e){const o=(await D(`query { account(publicKey: "${e}", token: "${U}") { balance { total } } }`)).account?.balance?.total;return o?BigInt(o):0n}async function H(e){const n=S*v,[o,a]=await Promise.all([j(e),W()]),{windowStart:i,mintedInWindow:r}=q(o),c=a>0n&&a>=i+x&&o>0n,f=c?0n:r,w=n>f?n-f:0n;return{mintedBaseUnits:f,remainingBaseUnits:w,capWholeUsdc:S,exhausted:w===0n,windowReset:c}}function z(e){const n=e/v,o=e%v;if(o===0n)return n.toString();const a=o.toString().padStart(6,"0").replace(/0+$/,"");return`${n}.${a}`}function h(){return typeof window<"u"&&!!window.mina}function g(){if(!window.mina)throw new Error("Auro wallet not found");return window.mina}async function K(){const e=await g().requestAccounts();if(!e.length)throw new Error("No account returned by Auro");return e[0]}async function N(){const e=g();if(!e.requestNetwork)return null;try{const n=await e.requestNetwork(),o=(n.networkID||n.chainId||n.name||"").toLowerCase(),a=O.some(i=>o.includes(i));return{raw:o,isDevnet:a}}catch{return null}}async function G(e,n=.1){return(await g().sendTransaction({transaction:e,feePayer:{fee:n,memo:"devnet USDC faucet mint"}})).hash}function F(e){const n=window.mina;n?.on&&(n.on("accountsChanged",e),n.on("chainChanged",e))}const E=new Worker(new URL(""+new URL("prover.worker-BzhsNRb9.js",import.meta.url).href,import.meta.url),{type:"module"});let J=1,m=!1,d=!1;const p=new Map;let u=null;E.onmessage=e=>{const n=e.data;if(n.kind==="progress"){u?.(n.stage,n.message);return}const o=p.get(n.id);n.kind==="compiled"?(d=!0,o?.resolve({txJson:"",fundNewAccounts:0}),p.delete(n.id),s()):n.kind==="proven"?(o?.resolve({txJson:n.txJson,fundNewAccounts:n.fundNewAccounts}),p.delete(n.id)):n.kind==="error"&&(o?.reject(new Error(n.message)),p.delete(n.id))};function T(e,n){const o=J++;return n&&(u=n),new Promise((a,i)=>{p.set(o,{resolve:r=>{n&&u===n&&(u=null),a(r)},reject:r=>{n&&u===n&&(u=null),i(r)}}),E.postMessage({...e,id:o})})}function I(){m||d||(m=!0,t.compileError=!1,s(),T({kind:"compile"}).catch(e=>{m=!1,t.compileError=!0,console.error("compile failed",e),l("err","Could not prepare the proving circuits. Please retry.")}))}const t={account:null,networkOk:null,networkRaw:"",recipient:"",allowance:null,allowanceLoading:!1,banner:null,proving:!1,proveStage:null,proveMessage:"",txHash:null,compileError:!1};function l(e,n){t.banner={kind:e,html:n},s()}const V=e=>e.length>16?`${e.slice(0,8)}…${e.slice(-6)}`:e,y=e=>/^B62q[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(e.trim());async function Y(){if(!h()){l("err",`Auro wallet is not installed. <a href="${$}" target="_blank" rel="noopener">Install Auro</a> and reload.`);return}try{const e=await K();t.account=e,t.recipient||(t.recipient=e),t.banner=null;const n=await N();t.networkOk=n?n.isDevnet:null,t.networkRaw=n?.raw??"",I(),s(),b()}catch(e){l("err",`Could not connect: ${e.message}`)}}async function b(){const e=t.recipient.trim();if(!y(e)){t.allowance=null,s();return}t.allowanceLoading=!0,s();try{t.allowance=await H(e)}catch(n){console.error("allowance fetch failed",n),t.allowance=null}finally{t.allowanceLoading=!1,s()}}async function X(){const e=t.recipient.trim();if(!y(e)){l("err","Enter a valid Mina address (starts with B62q).");return}if(t.account){t.proving=!0,t.txHash=null,t.banner=null,t.proveStage=d?"building":"compiling",t.proveMessage=d?"Preparing…":"Compiling circuits (first time, ~10–30s)…",s();try{const{txJson:n}=await T({kind:"buildAndProve",feePayer:t.account,recipient:e,wholeUsdc:C.toString()},(a,i)=>{t.proveStage=a,t.proveMessage=i,s()});t.proveStage="done",t.proveMessage="Proof ready — approve the fee in Auro to broadcast…",s();const o=await G(n,.1);t.txHash=o,t.proving=!1,l("ok",`Mint submitted! <a href="${B(o)}" target="_blank" rel="noopener">View on minascan ↗</a> — 1000 USDC will land after inclusion (a few minutes).`),b()}catch(n){t.proving=!1,t.proveStage=null;const o=n.message||String(n);/reject|denied|cancel/i.test(o)?l("warn","Transaction was rejected in Auro. You can try again."):/global context|inconsistent state|parallel|concurrently/i.test(o)?l("err","The prover hit a transient error. Please click the button to try again."):l("err",`Mint failed: ${o}`)}}}const Q=document.getElementById("app");function s(){Q.innerHTML=te(),oe()}function Z(){if(!t.proving&&!t.txHash)return"";const e=[{key:"compiling",label:"Compile circuits"},{key:"fetching",label:"Read on-chain state"},{key:"building",label:"Build mint transaction"},{key:"proving",label:"Generate zero-knowledge proof"},{key:"done",label:"Sign in Auro + broadcast"}],o=(a=>e.findIndex(i=>i.key===a))(t.proveStage);return`<ul class="progress-list">${e.map((a,i)=>{const r=i<o||t.txHash&&a.key==="done",c=i===o&&t.proving;return`<li class="${r?"done":c?"active":""}"><span class="ic">${r?"✓":c?'<span class="spin"></span>':"○"}</span>${a.label}</li>`}).join("")}</ul>`}function ee(){if(!t.account)return"";if(t.allowanceLoading&&!t.allowance)return`<div class="card"><div class="hint">Reading today's allowance…</div></div>`;const e=t.allowance;if(!e)return"";const n=z(e.remainingBaseUnits),o=Number(e.remainingBaseUnits*100n/(e.capWholeUsdc*1000000n));return`
    <div class="card">
      <div class="allowance">
        <div><span class="big">${n}</span> / ${e.capWholeUsdc} USDC</div>
        <div class="hint">remaining in today's window</div>
      </div>
      <div class="meter"><span style="width:${Math.max(0,Math.min(100,o))}%"></span></div>
      ${e.exhausted?`<div class="hint" style="margin-top:8px">This address hit its 1000 USDC daily cap. The window resets ~24h after the first mint${e.windowReset,""}. Try a different address, or come back later.</div>`:'<div class="hint" style="margin-top:8px">Each address may receive up to 1000 test-USDC per ~24h, enforced on-chain by the mint proof.</div>'}
    </div>`}function ne(){return t.banner?`<div class="status ${t.banner.kind==="info"?"warn":t.banner.kind}" style="margin-bottom:16px">${t.banner.html}</div>`:""}function te(){const e=!!t.account,n=e&&t.networkOk===!1?`<div class="status warn" style="margin-bottom:16px">Auro is on <b>${t.networkRaw||"an unknown network"}</b>. Switch Auro to <b>Devnet</b> or the mint will fail.</div>`:"",o=t.proving||!e||!d||!y(t.recipient)||t.allowance?.exhausted===!0,a=t.proving?t.proveMessage||"Working…":e&&!d?"Compiling circuits… (~30s, one time)":`Get ${C} test USDC`;return`
    <div class="brand">
      <div class="logo">$</div>
      <div>
        <h1>Mina Devnet USDC Faucet</h1>
        <div class="sub">Free mock-USDC for testing — no real value.</div>
      </div>
    </div>

    <div class="card explain">
      This faucet mints <b>mock USDC</b> on the <b>Mina devnet</b> to any address you choose.
      It's <b>permissionless</b>: the recipient never signs — you (the connected wallet) only
      pay the network fee.
      <ul>
        <li>Up to <b>1000 test-USDC per address per ~24h</b>, enforced on-chain by a zero-knowledge proof.</li>
        <li>You need <a href="${$}" target="_blank" rel="noopener">Auro wallet</a> on <b>Devnet</b> and a little devnet MINA for the ~0.1 MINA fee — get some at the <a href="${R}" target="_blank" rel="noopener">MINA faucet ↗</a>.</li>
        <li>Proving runs in your browser and takes ~10–40s the first time (circuits compile once).</li>
      </ul>
    </div>

    ${ne()}
    ${n}

    ${e?`<div class="card">
             <div class="row wrap" style="justify-content:space-between">
               <span class="chip"><span class="dot ${t.networkOk===!1?"warn":""}"></span>${V(t.account)}</span>
               <span class="hint">${d?"circuits ready":t.compileError?'<button class="ghost" id="retry-compile" style="width:auto;padding:4px 10px;font-size:0.8rem">Retry compile</button>':"compiling circuits…"}</span>
             </div>
           </div>`:`<div class="card">
             <button class="primary" id="connect">${h()?"Connect Auro wallet":"Install Auro wallet"}</button>
             ${h()?"":'<div class="hint" style="margin-top:8px">Then reload this page.</div>'}
           </div>`}

    ${e?`<div class="card">
             <label for="recipient">Mint to address</label>
             <input type="text" id="recipient" value="${t.recipient}" spellcheck="false" autocapitalize="off" placeholder="B62q…" />
             <div class="hint">Defaults to your wallet. Edit it to send test-USDC to <b>any</b> Mina address.</div>
             <div class="spacer"></div>
             ${ee()}
             <button class="primary" id="mint" ${o?"disabled":""}>${a}</button>
             ${Z()}
           </div>`:""}

    <div class="card tokenline">
      Token: <span class="mono break">${k}</span>
      <div style="margin-top:6px"><a href="${A(k)}" target="_blank" rel="noopener">Token on minascan ↗</a> · <a href="${A(M)}" target="_blank" rel="noopener">Admin contract ↗</a></div>
    </div>

    <div class="footer">Devnet test tokens only · built with o1js + Auro</div>
  `}function oe(){const e=document.getElementById("connect");e&&e.addEventListener("click",()=>void Y());const n=document.getElementById("mint");n&&n.addEventListener("click",()=>void X());const o=document.getElementById("retry-compile");o&&o.addEventListener("click",()=>I());const a=document.getElementById("recipient");if(a){a.addEventListener("input",()=>{t.recipient=a.value});let i;a.addEventListener("input",()=>{clearTimeout(i),i=setTimeout(()=>void b(),500)})}}F(()=>{(async()=>{try{const e=await N();t.networkOk=e?e.isDevnet:null,t.networkRaw=e?.raw??""}catch{}s()})()});s();
