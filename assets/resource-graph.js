/* PHEME-8 typed economic network editor. Local-only drafts, no brokerage APIs. */
(function () {
  'use strict';
  var KEY = 'pheme8:resource-network:v1';
  var TYPES = ['primary','secondary','process','company','financial'];
  var RELATIONS = {
    produces: [['primary','process'],['process','secondary'],['process','process']],
    requires: [['primary','process'],['secondary','process'],['primary','secondary']],
    supplies: [['primary','secondary'],['secondary','process'],['secondary','company']],
    affects_cost: [['primary','secondary'],['secondary','company'],['process','company'],['primary','company'],['company','financial']]
  };
  var SEED = {
    nodes: [
      {id:'gas',label:'Natural gas',type:'primary'},
      {id:'copper',label:'Copper',type:'primary'},
      {id:'silicon',label:'Silicon',type:'primary'},
      {id:'labour',label:'Skilled labour',type:'primary'},
      {id:'powerplant',label:'Power generation',type:'process'},
      {id:'semifab',label:'Chip fabrication',type:'process'},
      {id:'power',label:'Electricity',type:'secondary'},
      {id:'chips',label:'GPUs / accelerators',type:'secondary'},
      {id:'equipment',label:'Electrical equipment',type:'secondary'},
      {id:'build',label:'Data-centre build',type:'process'},
      {id:'dc',label:'AI data centre',type:'company'},
      {id:'margin',label:'Operating margin',type:'financial'}
    ],
    edges: [
      {source:'gas',target:'powerplant',relation:'requires'},
      {source:'powerplant',target:'power',relation:'produces'},
      {source:'silicon',target:'semifab',relation:'requires'},
      {source:'power',target:'semifab',relation:'requires'},
      {source:'semifab',target:'chips',relation:'produces'},
      {source:'copper',target:'equipment',relation:'supplies'},
      {source:'equipment',target:'build',relation:'requires'},
      {source:'labour',target:'build',relation:'requires'},
      {source:'power',target:'dc',relation:'affects_cost'},
      {source:'chips',target:'dc',relation:'supplies'},
      {source:'build',target:'dc',relation:'affects_cost'},
      {source:'dc',target:'margin',relation:'affects_cost'}
    ]
  };
  var graph = JSON.parse(JSON.stringify(SEED));
  var active = 'dc', notice = '';

  /* Stage 4: source-backed candidates; never evidence that an edge is causal. */
  var evidence = null, evidenceStatus = 'idle', fetchedAt = 0;
  var EVIDENCE_API = 'https://pheme-reader-api-production.up.railway.app/v1/resource-evidence';
  function articleUrl(value) {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return '';
    try { var u=new URL(value); return u.protocol==='https:'&&!u.username&&!u.password?u.href:''; }
    catch(e) { return ''; }
  }
  function refreshEvidence(force) {
    if (!document.getElementById('rg-root')) return;
    if (evidenceStatus==='loading' || (!force && evidence && Date.now()-fetchedAt<300000)) return;
    evidenceStatus='loading';paint();
    fetch(EVIDENCE_API,{mode:'cors',credentials:'omit',cache:'no-store'})
      .then(function(response){ if(!response.ok)throw Error('API unavailable');return response.json(); })
      .then(function(data){
        if(!data || data.model!=='rss-resource-candidates-v1'||!data.resources)throw Error('Invalid response');
        evidence=data.resources;evidenceStatus='ready';fetchedAt=Date.now();paint();
      })
      .catch(function(){evidenceStatus='error';paint();});
  }
  function candidateLabel(id) {
    var entry=evidence&&evidence[id];
    if(!entry)return 'No evidence';
    if(entry.status==='contested')return 'Contested';
    if(entry.octalCorroboration!==null&&entry.octalCorroboration!==undefined)
      return String(entry.octalCorroboration)+'₈ / '+String(entry.direction||'unknown');
    return entry.status==='unverified'?'Unverified':'No evidence';
  }
  function newsInspector(node) {
    var entry=evidence&&evidence[node.id];
    var heading='<div class="rg-evidence-head"><h3>News propositions</h3><button type="button" data-rg="refresh-evidence">Refresh</button></div>'+
      '<p class="rg-evidence-caution">Publisher headline matches only; no graph edge, financial exposure or price change is verified.</p>';
    if(evidenceStatus==='loading')return heading+'<p>Loading publisher articles…</p>';
    if(evidenceStatus==='error')return heading+'<p>Evidence service unavailable. Editing works offline.</p>';
    if(!entry)return heading+'<p>No matching extractor for this custom node.</p>';
    var links=(entry.articles||[]).filter(function(row){return articleUrl(row.url);}).slice(0,8).map(function(row){
      return '<li><a href="'+escapeText(articleUrl(row.url))+'" target="_blank" rel="noopener noreferrer">'+
        escapeText(row.headline)+'</a><small>'+escapeText(row.publisher)+' · '+escapeText(row.direction)+
        ' · '+escapeText(String(row.published||'').slice(0,10))+'</small></li>';
    }).join('');
    return heading+'<div class="rg-evidence-score"><strong>'+escapeText(candidateLabel(node.id))+
      '</strong><span>'+Number(entry.publisherCount||0)+' directional publisher candidates</span></div>'+
      (links?'<ul class="rg-evidence-list">'+links+'</ul>':'<p>No recent matching publisher articles.</p>');
  }

  try {
    var stored = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (stored) { validate(stored); graph = stored; }
  } catch (err) { /* Keep the validated demonstration seed. */ }

  function escapeText(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function validate(candidate) {
    if (!candidate || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges) ||
        candidate.nodes.length > 120 || candidate.edges.length > 360) throw Error('Graph exceeds size limits');
    var ids = Object.create(null), next = Object.create(null), pairs = Object.create(null);
    candidate.nodes.forEach(function (n) {
      if (!n || !/^[a-z][a-z0-9_-]{0,39}$/.test(n.id) || ids[n.id] || TYPES.indexOf(n.type)<0 ||
          typeof n.label!=='string' || n.label.length<1 || n.label.length>90) throw Error('Invalid or duplicate node');
      ids[n.id] = n; next[n.id] = [];
    });
    candidate.edges.forEach(function (e) {
      if (!e || !ids[e.source] || !ids[e.target] || e.source===e.target || !RELATIONS[e.relation] ||
          !RELATIONS[e.relation].some(function(pair) { return pair[0]===ids[e.source].type && pair[1]===ids[e.target].type; }))
        throw Error('This relationship is not allowed between the selected resource types');
      var pairKey = e.source+'→'+e.target;
      if (pairs[pairKey]) throw Error('Duplicate resource relationship');
      pairs[pairKey] = true;
      next[e.source].push(e.target);
      if (e.quantity !== undefined && (!Number.isFinite(e.quantity) || e.quantity<=0 || e.quantity>1e12 ||
          ['unit','kg','tonne','MWh','kWh','litre','m3','hour','GPU-hour','GBP','USD','percent'].indexOf(e.unit)<0)) throw Error('Invalid quantity or unit');
    });
    var color = Object.create(null);
    function walk(id) {
      if (color[id]===1) throw Error('Cycle detected: a production chain cannot depend on itself');
      if (color[id]===2) return;
      color[id]=1;
      next[id].forEach(walk);
      color[id]=2;
    }
    Object.keys(ids).forEach(walk);
    return candidate;
  }
  function save() { try { localStorage.setItem(KEY,JSON.stringify(graph)); } catch(e) { notice='Storage unavailable; changes are temporary.'; } }
  function commit(fn) {
    try {
      var clone = JSON.parse(JSON.stringify(graph));
      fn(clone); validate(clone); graph=clone; save(); notice='Changes saved in this browser.';
    } catch(err) { notice=err.message; }
    paint();
  }
  function find(id) { return graph.nodes.find(function(n){return n.id===id;}); }
  function options(list, chosen) { return list.map(function(v){return '<option value="'+escapeText(v)+'"'+(v===chosen?' selected':'')+'>'+escapeText(v.replace(/_/g,' '))+'</option>';}).join(''); }
  function layout() {
    var order={primary:0,process:1,secondary:2,company:3,financial:4};
    // Iteratively promote process nodes after their upstream secondary outputs,
    // without changing semantic node types or assigning fabricated economic values.
    var depths={};
    graph.nodes.forEach(function(n){depths[n.id]=order[n.type];});
    for(var i=0;i<graph.nodes.length;i++) graph.edges.forEach(function(e){
      depths[e.target]=Math.max(depths[e.target],Math.min(7,depths[e.source]+1));
    });
    var columns={};
    graph.nodes.forEach(function(n){var d=depths[n.id]; (columns[d]||(columns[d]=[])).push(n);});
    var position={};
    Object.keys(columns).forEach(function(d){
      columns[d].forEach(function(n,i){position[n.id]={x:22+Number(d)*204,y:54+i*80};});
    });
    return {positions:position,width:Math.max(720, 60+(Math.max.apply(null,Object.values(depths).concat([3]))+1)*204),height:Math.max(410,110+Math.max.apply(null,Object.values(columns).map(function(x){return x.length;}).concat([3]))*80)};
  }
  function svg() {
    var l=layout();
    var paths=graph.edges.map(function(e){
      var a=l.positions[e.source], b=l.positions[e.target], ax=a.x+166, ay=a.y+25, bx=b.x, by=b.y+25;
      var xmid=(ax+bx)/2;
      return '<path class="rg-edge" d="M'+ax+' '+ay+' C'+xmid+' '+ay+' '+xmid+' '+by+' '+bx+' '+by+'" marker-end="url(#rg-arrow)" />'
    }).join('');
    var nodes=graph.nodes.map(function(n){
      var p=l.positions[n.id];
      return '<g class="rg-svg-node rg-'+n.type+(n.id===active?' rg-selected':'')+'" data-rg-node="'+escapeText(n.id)+'" tabindex="0" role="button" aria-label="Inspect '+escapeText(n.label)+'"><rect x="'+p.x+'" y="'+p.y+'" width="166" height="50" rx="10"/><text x="'+(p.x+12)+'" y="'+(p.y+18)+'" class="rg-node-type">'+escapeText(n.type)+'</text><text x="'+(p.x+12)+'" y="'+(p.y+36)+'">'+escapeText(n.label.length>23?n.label.slice(0,21)+'…':n.label)+'</text></g>';
    }).join('');
    return '<svg class="rg-canvas" viewBox="0 0 '+l.width+' '+l.height+'" width="'+l.width+'" height="'+l.height+'" role="group" aria-label="Interactive economic production and resource dependency network"><defs><marker id="rg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#789286"/></marker></defs>'+paths+nodes+'</svg>';
  }
  function inspector() {
    var node=find(active)||graph.nodes[0];
    if (!node) return '<p>Select or add a resource to begin.</p>';
    var incoming=graph.edges.filter(function(e){return e.target===node.id;});
    var outgoing=graph.edges.filter(function(e){return e.source===node.id;});
    return '<div class="rg-inspector-title">Node inspector <span>'+escapeText(node.type)+'</span></div>'+
      '<label class="rg-label">Resource name<input id="rg-label" maxlength="90" value="'+escapeText(node.label)+'"></label>'+
      '<label class="rg-label">Type<select id="rg-type">'+options(TYPES,node.type)+'</select></label>'+
      '<div class="rg-inspector-actions"><button type="button" data-rg="save-node">Save node</button><button type="button" data-rg="delete-node" class="rg-danger">Delete</button></div>'+
      '<h3>Inputs ('+incoming.length+')</h3>'+
      '<ul class="rg-rel-list">'+(incoming.map(function(e){
        return '<li>'+escapeText(find(e.source).label)+' <em>'+escapeText(e.relation.replace(/_/g,' '))+'</em><button type="button" data-rg="delete-edge" data-from="'+escapeText(e.source)+'" data-to="'+escapeText(e.target)+'" aria-label="Remove relationship">×</button></li>';
      }).join('')||'<li>None</li>')+'</ul>'+
      '<h3>Outputs ('+outgoing.length+')</h3>'+
      '<ul class="rg-rel-list">'+(outgoing.map(function(e){
        return '<li>'+escapeText(find(e.target).label)+' <em>'+escapeText(e.relation.replace(/_/g,' '))+'</em><button type="button" data-rg="delete-edge" data-from="'+escapeText(e.source)+'" data-to="'+escapeText(e.target)+'" aria-label="Remove relationship">×</button></li>';
      }).join('')||'<li>None</li>')+'</ul>'+newsInspector(node);
  }
  function html() {
    return '<section class="rg-workspace"><div class="rg-header"><div><h2>Economic dependency network</h2><p>Primary resources → production → secondary resources → companies → financial results</p></div><span class="rg-tag">Stage 4 · News-linked prototype</span></div>'+
      '<p class="rg-disclaimer">Illustrative production relationships. Publisher headline matches do not establish causal edges or financial exposures. No broker orders.</p>'+
      '<div class="rg-toolbar"><label>New node <input id="rg-new-label" placeholder="e.g. LNG shipping" maxlength="90"></label><label>Type<select id="rg-new-type">'+options(TYPES,'primary')+'</select></label><button type="button" data-rg="add-node">Add resource</button><button type="button" data-rg="reset">Reset demo</button></div>'+
      '<div class="rg-toolbar rg-connect"><label>From<select id="rg-from">'+graph.nodes.map(function(n){return '<option value="'+escapeText(n.id)+'"'+(n.id===active?' selected':'')+'>'+escapeText(n.label)+'</option>';}).join('')+'</select></label>'+
      '<label>Relation<select id="rg-relation">'+options(Object.keys(RELATIONS),'requires')+'</select></label>'+
      '<label>To<select id="rg-to">'+graph.nodes.map(function(n){return '<option value="'+escapeText(n.id)+'">'+escapeText(n.label)+'</option>';}).join('')+'</select></label>'+
      '<button type="button" data-rg="connect">Connect nodes</button></div>'+
      '<div class="rg-main"><div class="rg-graph-wrap"><div class="rg-scroll" tabindex="0" aria-label="Scroll resource network horizontally">'+svg()+'</div><div class="rg-legend"><span>● Primary</span><span>● Process</span><span>● Secondary</span><span>● Company</span><span>● Financial</span></div></div>'+
      '<aside class="rg-inspector" id="rg-inspector">'+inspector()+'</aside></div>'+
      '<p class="rg-notice" role="status" id="rg-notice">'+escapeText(notice||'Select a node to inspect its dependencies; add resources or connect nodes to edit.')+'</p>'+
      '<div class="rg-footer"><span>'+graph.nodes.length+' nodes · '+graph.edges.length+' connections</span><button type="button" data-rg="export">Export JSON</button></div></section>';
  }
  function paint() {
    var root=document.getElementById('rg-root');
    if(!root) return;
    var scroll=root.querySelector('.rg-scroll'), sx=scroll?scroll.scrollLeft:0, sy=scroll?scroll.scrollTop:0;
    root.innerHTML=html();
    scroll=root.querySelector('.rg-scroll'); if(scroll){scroll.scrollLeft=sx;scroll.scrollTop=sy;}
  }
  function handleClick(e) {
    var root=e.target.closest('#rg-root');
    if(!root) return;
    var node=e.target.closest('[data-rg-node]');
    if(node){active=node.getAttribute('data-rg-node');notice='';paint();return;}
    var button=e.target.closest('[data-rg]');
    if(!button) return;
    var act=button.getAttribute('data-rg');
    if(act==='refresh-evidence'){refreshEvidence(true);return;}
    if(act==='add-node'){
      var label=(root.querySelector('#rg-new-label').value||'').trim(),type=root.querySelector('#rg-new-type').value;
      if(!label){notice='Enter a resource name.';paint();return;}
      commit(function(g){
        var base=label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,30);
        if(!/^[a-z]/.test(base))base='resource-'+base;
        var id=base,n=2;while(g.nodes.some(function(x){return x.id===id;}))id=base+'-'+(n++);
        g.nodes.push({id:id,label:label,type:type});active=id;
      });
    } else if(act==='connect') {
      var from=root.querySelector('#rg-from').value,to=root.querySelector('#rg-to').value,relation=root.querySelector('#rg-relation').value;
      commit(function(g){g.edges.push({source:from,target:to,relation:relation});active=to;});
    } else if(act==='save-node'){
      var name=(root.querySelector('#rg-label').value||'').trim(),kind=root.querySelector('#rg-type').value;
      commit(function(g){var n=g.nodes.find(function(n){return n.id===active;});n.label=name;n.type=kind;});
    } else if(act==='delete-node'){
      commit(function(g){g.nodes=g.nodes.filter(function(n){return n.id!==active;});g.edges=g.edges.filter(function(e){return e.source!==active&&e.target!==active;});active=g.nodes.length?g.nodes[0].id:null;});
    } else if(act==='delete-edge'){
      var a=button.getAttribute('data-from'),b=button.getAttribute('data-to');
      commit(function(g){g.edges=g.edges.filter(function(e){return e.source!==a||e.target!==b;});});
    } else if(act==='reset'){
      graph=JSON.parse(JSON.stringify(SEED));active='dc';notice='Demo graph restored.';save();paint();
    } else if(act==='export'){
      var blob=new Blob([JSON.stringify(graph,null,2)],{type:'application/json'});
      var url=URL.createObjectURL(blob),a=document.createElement('a');
      a.href=url;a.download='pheme-8-resource-network.json';a.click();
      setTimeout(function(){URL.revokeObjectURL(url);},0);
    }
  }
  document.addEventListener('click', handleClick);
  document.addEventListener('keydown',function(e){
    if((e.key==='Enter'||e.key===' ')&&e.target.matches('#rg-root [data-rg-node]')){
      e.preventDefault();active=e.target.getAttribute('data-rg-node');notice='';paint();
    }
  });
  window.PhemeResourceGraph={html:function(){return '<div id="rg-root">'+html()+'</div>';},paint:paint,refresh:refreshEvidence};
})();
