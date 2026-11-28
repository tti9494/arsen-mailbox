/* 아르센 우편함 — libraries.dev 효과 연결 (eunho-fx). CSP(script-src 'self') 때문에 따로 둔 파일. 우편함·열쇠·전송 로직은 건드리지 않는다. */
(function(){
  if(!window.EunhoFX) return;
  var FX = window.EunhoFX;
  FX.auto({
    magnetic: '.btn-primary, .action-row > a.btn',                                         // Magnetic UI (마우스 화면만)
    light: '.hero-card, .room-card, .settings-card, .flow-card, .pwa-guide-card, .doc-section, .banner', // 커서 빛 (마우스 화면만)
    custom: [
      ['.seg-group', function(el){ FX.gooTabs(el, {item:'.seg-btn', active:'[aria-pressed="true"]', inset:2}); }]  // Gooey: 분할 단추 선택 표시
    ]
  });
  // Thinking orb: '이전 글 불러오는 중…' 동안 작은 구슬
  FX.auto({ custom: [['.action-row > button', function(btn){
    var orb = null; var sync = function(){ var busy = /불러오는 중/.test(btn.textContent);
      if(busy && !orb){ orb = FX.orbEl('searching', 20, {label:'이전 글 불러오는 중'}); orb.classList.add('fx-inline-orb'); btn.prepend(orb); }
      else if(!busy && orb){ FX.orb(orb, null); orb.remove(); orb = null; } };
    new MutationObserver(sync).observe(btn, {childList:true, characterData:true, subtree:true}); sync(); }]] });
  // Settle (EasyUI SettleModal): 시트·창이 열릴 때 바탕은 스며들고 창은 0.94→1.02→1 로 살짝 넘쳤다가 자리 잡는다
  if(FX.settleOn) FX.settleOn(document.getElementById('sheet-root'), {children:'.sheet-backdrop', panel:'.sheet-panel', backdrop:'.sheet-backdrop'});
  // Image generation: 새로 도착한 글만 현상되듯 드러난다 (방을 열 때 한꺼번에 그려지는 지난 글은 그대로)
  var seen = new Set(), batch = [], raf = 0;
  var keyOf = function(row){ return (row.textContent || '').slice(0, 240); };
  new MutationObserver(function(ms){
    ms.forEach(function(m){ m.addedNodes.forEach(function(n){ if(n.nodeType !== 1) return;
      if(n.classList && n.classList.contains('msg-row')) batch.push(n); else if(n.querySelectorAll) n.querySelectorAll('.msg-row').forEach(function(r){ batch.push(r); }); }); });
    if(batch.length && !raf) raf = requestAnimationFrame(function(){ raf = 0; var rows = batch; batch = [];
      var fresh = rows.filter(function(r){ return !seen.has(keyOf(r)); });
      rows.forEach(function(r){ seen.add(keyOf(r)); });
      if(fresh.length && fresh.length <= 2 && seen.size > fresh.length) fresh.forEach(function(r){ var b = r.querySelector('.msg-bubble'); if(b) FX.develop(b, 700); });
    });
  }).observe(document.body, {childList:true, subtree:true});
})();
