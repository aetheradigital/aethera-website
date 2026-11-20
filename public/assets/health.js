/* Aethera Digital Health: SEO + AI search (AISO) checks, scoring and the page analyzer.
 * Shared by the Desk (browser) and the server (check names and weights only; the analyzer needs DOMParser). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AetheraHealth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const TYPES = {page:"Website page", landing:"Landing page", article:"Blog / article", product:"Product / service page", gbp:"Google Business Profile", social:"Social / video profile"};
const kindOf = t => t==="gbp" ? "gbp" : t==="social" ? "social" : "web";
const ENGINES = ["ChatGPT","Google AI Overview","Perplexity","Gemini","Claude","Copilot"];

const CHECKS = [
 // WEB · SEO · Technical
 {id:"https",kind:"web",pillar:"seo",cat:"Technical",name:"Served over HTTPS",w:3,auto:true,fix:"Force HTTPS sitewide and redirect every http:// URL."},
 {id:"indexable",kind:"web",pillar:"seo",cat:"Technical",name:"Indexable (no noindex)",w:5,auto:true,fix:"Remove the noindex robots meta tag so search engines can index the page."},
 {id:"canonical",kind:"web",pillar:"seo",cat:"Technical",name:"Canonical tag set",w:2,auto:true,fix:"Add a self-referencing rel=canonical link to the preferred URL."},
 {id:"viewport",kind:"web",pillar:"seo",cat:"Technical",name:"Mobile viewport configured",w:3,auto:true,fix:"Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">."},
 {id:"lang",kind:"web",pillar:"seo",cat:"Technical",name:"Page language declared",w:1,auto:true,fix:"Set the lang attribute on the <html> tag (e.g. lang=\"en\")."},
 {id:"cwv",kind:"web",pillar:"seo",cat:"Technical",name:"Core Web Vitals pass (PageSpeed Insights, mobile)",w:4,auto:false,fix:"Compress images, defer heavy scripts and apps, and re-test in PageSpeed Insights until LCP, INP and CLS pass."},
 {id:"sitemap",kind:"web",pillar:"seo",cat:"Technical",name:"In XML sitemap and submitted to Search Console",w:3,auto:false,fix:"Confirm the URL is in sitemap.xml and the sitemap is submitted in Google Search Console."},
 {id:"gsc_indexed",kind:"web",pillar:"seo",cat:"Technical",name:"Confirmed indexed in Search Console",w:3,auto:false,fix:"Run URL Inspection in Search Console and request indexing if it isn't indexed."},
 // WEB · SEO · On-page
 {id:"title",kind:"web",pillar:"seo",cat:"On-page",name:"Title tag 30–60 characters",w:5,auto:true,fix:"Write a unique 30–60 character title: primary keyword first, brand last."},
 {id:"meta_desc",kind:"web",pillar:"seo",cat:"On-page",name:"Meta description 70–160 characters",w:3,auto:true,fix:"Write a 70–160 character meta description with the offer, location and a reason to click."},
 {id:"h1",kind:"web",pillar:"seo",cat:"On-page",name:"Exactly one H1",w:4,auto:true,fix:"Use one H1 that states the page topic; demote extra H1s to H2."},
 {id:"headings",kind:"web",pillar:"seo",cat:"On-page",name:"Section headings (2+ H2s)",w:2,auto:true,fix:"Break content into sections with descriptive H2/H3 headings."},
 {id:"alt",kind:"web",pillar:"seo",cat:"On-page",name:"Images have alt text",w:2,auto:true,fix:"Add descriptive alt text to every meaningful image."},
 {id:"internal_links",kind:"web",pillar:"seo",cat:"On-page",name:"Internal links (3+)",w:2,auto:true,fix:"Link to at least three related pages on the site with descriptive anchor text."},
 {id:"og",kind:"web",pillar:"seo",cat:"On-page",name:"Open Graph tags for sharing",w:1,auto:true,fix:"Add og:title, og:description and og:image."},
 {id:"keyword",kind:"web",pillar:"seo",cat:"On-page",name:"Primary keyword in title, H1 and opening copy",w:3,auto:false,fix:"Pick one primary keyword and use it naturally in the title, H1 and first paragraph."},
 // WEB · SEO · Content & authority
 {id:"word_count",kind:"web",pillar:"seo",cat:"Content & authority",name:"Substantive content (300+ words)",w:3,auto:true,fix:"Expand the page to at least 300 words of useful, specific copy."},
 {id:"intent",kind:"web",pillar:"seo",cat:"Content & authority",name:"Matches search intent",w:3,auto:false,fix:"Check what ranks for the target query and match its format (service page, guide, comparison)."},
 {id:"backlinks",kind:"web",pillar:"seo",cat:"Content & authority",name:"Earning quality backlinks",w:3,auto:false,fix:"Earn links from local directories, partners, suppliers and industry associations."},
 {id:"local_nap",kind:"web",pillar:"seo",cat:"Content & authority",name:"Name, address, phone match listings",w:2,auto:false,fix:"Make the business name, address and phone identical on the site, Google Business Profile and directories."},
 // WEB · AISO · Structured data
 {id:"schema_any",kind:"web",pillar:"aiso",cat:"Structured data",name:"JSON-LD structured data present",w:4,auto:true,fix:"Add JSON-LD structured data to the page."},
 {id:"schema_entity",kind:"web",pillar:"aiso",cat:"Structured data",name:"Organization or LocalBusiness schema",w:4,auto:true,fix:"Add Organization or LocalBusiness schema with name, logo, address, phone and URL."},
 {id:"schema_sameas",kind:"web",pillar:"aiso",cat:"Structured data",name:"Schema sameAs links to official profiles",w:2,auto:true,fix:"Add sameAs links to the Google Business Profile, LinkedIn, Facebook, Instagram and YouTube."},
 {id:"schema_content",kind:"web",pillar:"aiso",cat:"Structured data",name:"Content schema (FAQ, Article, Product, Service, HowTo)",w:3,auto:true,fix:"Add the schema type that matches the content: FAQPage, Service, Product, Article or HowTo."},
 {id:"breadcrumbs",kind:"web",pillar:"aiso",cat:"Structured data",name:"BreadcrumbList schema",w:1,auto:true,fix:"Add BreadcrumbList schema so AI and search engines understand where the page sits in the site."},
 // WEB · AISO · Answer readiness
 {id:"direct_answer",kind:"web",pillar:"aiso",cat:"Answer readiness",name:"Direct answer in the first 2–3 sentences",w:4,auto:false,fix:"Open with a plain-language answer: who you are, what you do, for whom, and where."},
 {id:"question_headings",kind:"web",pillar:"aiso",cat:"Answer readiness",name:"Question-style headings (2+)",w:3,auto:true,fix:"Phrase some H2/H3s as the questions customers ask (\"How much does a roof replacement cost?\")."},
 {id:"faq",kind:"web",pillar:"aiso",cat:"Answer readiness",name:"FAQ section on the page",w:3,auto:true,fix:"Add an FAQ block of 4–8 real customer questions with short, factual answers."},
 {id:"lists_tables",kind:"web",pillar:"aiso",cat:"Answer readiness",name:"Lists or tables that summarize key facts",w:2,auto:true,fix:"Summarize services, steps, pricing or specs in bullet lists or a table AI can lift cleanly."},
 {id:"stats",kind:"web",pillar:"aiso",cat:"Answer readiness",name:"Specific facts, numbers or prices",w:2,auto:false,fix:"Add concrete facts: years in business, service areas, price ranges, turnaround times, results."},
 // WEB · AISO · Trust & entity
 {id:"author_date",kind:"web",pillar:"aiso",cat:"Trust & entity",name:"Author and published/updated date",w:2,auto:true,fix:"Show the author and a published or updated date, and add them to Article schema."},
 {id:"about_contact",kind:"web",pillar:"aiso",cat:"Trust & entity",name:"About and Contact pages linked",w:2,auto:true,fix:"Link to About and Contact pages from the navigation or footer."},
 {id:"entity_consistent",kind:"web",pillar:"aiso",cat:"Trust & entity",name:"Brand, services and location stated consistently",w:3,auto:false,fix:"Use the same brand name, service list and service area wording on the site and every profile."},
 {id:"reviews",kind:"web",pillar:"aiso",cat:"Trust & entity",name:"Reviews or testimonials visible",w:2,auto:false,fix:"Show named testimonials and link to third-party reviews."},
 // WEB · AISO · Crawler access
 {id:"ai_crawlers",kind:"web",pillar:"aiso",cat:"AI crawler access",name:"AI crawlers allowed in robots.txt",w:4,auto:true,fix:"Allow GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and Google-Extended in robots.txt."},
 {id:"ssr",kind:"web",pillar:"aiso",cat:"AI crawler access",name:"Main content readable without JavaScript",w:3,auto:true,fix:"Make sure the main copy is in the HTML the server sends, not only injected by scripts."},
 {id:"llms_txt",kind:"web",pillar:"aiso",cat:"AI crawler access",name:"llms.txt published",w:1,auto:false,fix:"Publish /llms.txt with a short brand summary and links to the key pages."},
 // GBP
 {id:"gbp_verified",kind:"gbp",pillar:"seo",cat:"Listing basics",name:"Verified and owner-managed",w:5,auto:false,fix:"Verify the profile and make sure the client and Aethera both have manager access."},
 {id:"gbp_category",kind:"gbp",pillar:"seo",cat:"Listing basics",name:"Primary and secondary categories correct",w:4,auto:false,fix:"Set the most specific primary category and add relevant secondary categories."},
 {id:"gbp_nap",kind:"gbp",pillar:"seo",cat:"Listing basics",name:"Name, address, phone match the website",w:4,auto:false,fix:"Make the name, address and phone match the website exactly."},
 {id:"gbp_hours",kind:"gbp",pillar:"seo",cat:"Listing basics",name:"Hours, service area and holiday hours current",w:2,auto:false,fix:"Update hours, service areas and holiday hours."},
 {id:"gbp_photos",kind:"gbp",pillar:"seo",cat:"Listing basics",name:"10+ real photos, refreshed quarterly",w:2,auto:false,fix:"Upload real job, team and storefront photos; add new ones every quarter."},
 {id:"gbp_link",kind:"gbp",pillar:"seo",cat:"Listing basics",name:"Website link set, with UTM tracking",w:2,auto:false,fix:"Link to the website with UTM parameters so GBP traffic shows in analytics."},
 {id:"gbp_desc",kind:"gbp",pillar:"aiso",cat:"Answer readiness",name:"Description names services, location and differentiator",w:3,auto:false,fix:"Rewrite the description: what you do, where, for whom, and why you."},
 {id:"gbp_services",kind:"gbp",pillar:"aiso",cat:"Answer readiness",name:"Services or products listed with descriptions",w:3,auto:false,fix:"List every service with a short description and price range where possible."},
 {id:"gbp_qa",kind:"gbp",pillar:"aiso",cat:"Answer readiness",name:"Q&A seeded with real customer questions",w:2,auto:false,fix:"Add and answer the five questions customers ask most."},
 {id:"gbp_reviews",kind:"gbp",pillar:"aiso",cat:"Trust & entity",name:"Steady reviews, 4.3+ average",w:5,auto:false,fix:"Set up a review request after every job; aim for new reviews every month."},
 {id:"gbp_responses",kind:"gbp",pillar:"aiso",cat:"Trust & entity",name:"Owner responds to reviews",w:3,auto:false,fix:"Respond to every review within a week, mentioning the service and location naturally."},
 {id:"gbp_posts",kind:"gbp",pillar:"aiso",cat:"Trust & entity",name:"Posted in the last 30 days",w:2,auto:false,fix:"Publish a GBP update, offer or project post at least monthly."},
 // SOCIAL
 {id:"so_name",kind:"social",pillar:"seo",cat:"Profile basics",name:"Name and handle match the brand",w:3,auto:false,fix:"Use the exact brand name and a consistent handle across platforms."},
 {id:"so_bio",kind:"social",pillar:"seo",cat:"Profile basics",name:"Bio says what, for whom and where",w:3,auto:false,fix:"Rewrite the bio with services, audience, location and a keyword."},
 {id:"so_link",kind:"social",pillar:"seo",cat:"Profile basics",name:"Tracked link to the website",w:2,auto:false,fix:"Add a website link with UTM parameters."},
 {id:"so_complete",kind:"social",pillar:"seo",cat:"Profile basics",name:"Profile complete (category, contact, location)",w:2,auto:false,fix:"Fill in category, contact buttons, location and hours."},
 {id:"so_sameas",kind:"social",pillar:"aiso",cat:"Entity signals",name:"Listed in the website's schema sameAs",w:3,auto:false,fix:"Add this profile URL to the site's Organization schema sameAs."},
 {id:"so_cadence",kind:"social",pillar:"aiso",cat:"Entity signals",name:"Posting on a steady cadence",w:3,auto:false,fix:"Set a posting rhythm the client can sustain and stick to it."},
 {id:"so_captions",kind:"social",pillar:"aiso",cat:"Entity signals",name:"Descriptive captions, alt text or transcripts",w:3,auto:false,fix:"Write captions that name the service and place; add alt text and video transcripts."},
 {id:"so_engagement",kind:"social",pillar:"aiso",cat:"Entity signals",name:"Real engagement (comments, shares)",w:2,auto:false,fix:"Reply to comments and encourage customers to tag and share."},
 // ALL
 {id:"ai_visibility",kind:"all",pillar:"aiso",cat:"AI visibility",name:"Appears in AI answers for tracked prompts",w:5,auto:false,derived:true,fix:"Strengthen entity signals and answer content for the prompts where the brand is missing, then re-test."}
];
const CHECK_BY_ID = Object.fromEntries(CHECKS.map(c=>[c.id,c]));
const checksFor = type => CHECKS.filter(c=>c.kind===kindOf(type)||c.kind==="all");

const STATUSES = ["pass","partial","fail","na"];
const ASSET_STATUS = ["live","in_progress","planned","archived"];
const PROMPT_RESULTS = ["untested","cited","mentioned","absent"];
const MANUAL_AI = ["keyword","intent","direct_answer","stats","entity_consistent"];

function grade(s){
  if(s==null) return {label:"Not Scored",cls:"h-none"};
  if(s>=85) return {label:"Excellent",cls:"h-good"};
  if(s>=70) return {label:"Good",cls:"h-ok"};
  if(s>=50) return {label:"Needs Work",cls:"h-warn"};
  return {label:"Critical",cls:"h-bad"};
}
const impactOf = w => w>=4 ? "High" : w===3 ? "Medium" : "Low";
function visibility(a){
  const tested=(a.prompts||[]).filter(p=>p.result&&p.result!=="untested");
  if(!tested.length) return {status:"",ratio:null,tested:0,cited:0,mentioned:0};
  const cited=tested.filter(p=>p.result==="cited").length, mentioned=tested.filter(p=>p.result==="mentioned").length;
  const ratio=(cited+mentioned*0.6)/tested.length;
  return {status: ratio>=0.6?"pass":ratio>0?"partial":"fail", ratio, tested:tested.length, cited, mentioned};
}
function statusOf(a,c){ return c.derived ? visibility(a).status : ((a.checks||{})[c.id]||{}).s || ""; }
const VAL = {pass:1,partial:0.5,fail:0};
// Every applicable check counts: pass = full weight, partial = half, fail or not yet checked = 0. Only N/A is
// left out. A set with nothing checked yet has no score.
function scoreSet(a,list){
  let tot=0,got=0,any=false;
  list.forEach(c=>{const s=statusOf(a,c); if(s==="na") return; tot+=c.w; if(s in VAL){got+=c.w*VAL[s]; any=true;}});
  return (any&&tot)? Math.round(got/tot*100) : null;
}
// Digital Health Score = SEO and AISO blended (default 50/50).
function scores(a, seoWeight){
  const w = typeof seoWeight === "number" ? seoWeight : 0.5;
  const list=checksFor(a.type);
  const seo=scoreSet(a,list.filter(c=>c.pillar==="seo")), aiso=scoreSet(a,list.filter(c=>c.pillar==="aiso"));
  const dhs = (seo!=null&&aiso!=null) ? Math.round(seo*w+aiso*(1-w)) : (seo??aiso);
  const scored=list.filter(c=>statusOf(a,c)!=="").length;
  const cats={};
  list.forEach(c=>{(cats[c.pillar+"|"+c.cat] ||= []).push(c);});
  const catScores=Object.entries(cats).map(([k,l])=>{const [p,cat]=k.split("|");return {pillar:p,cat,score:scoreSet(a,l)};});
  return {seo,aiso,dhs,scored,total:list.length,catScores};
}
function priorities(a){
  return checksFor(a.type).map(c=>({c,s:statusOf(a,c)})).filter(x=>x.s==="fail"||x.s==="partial")
    .sort((x,y)=>(y.c.w*(y.s==="fail"?1:0.5))-(x.c.w*(x.s==="fail"?1:0.5)));
}
const ENTITY_TYPES=/^(Organization|Corporation|LocalBusiness|ProfessionalService|HomeAndConstructionBusiness|RoofingContractor|GeneralContractor|Plumber|Electrician|HVACBusiness|Store|OnlineStore|OnlineBusiness|Restaurant|Dentist|LegalService|FinancialService|AccountingService|AutomotiveBusiness|MedicalBusiness|NGO)$|(Business|Contractor|Store)$/;
const CONTENT_TYPES=/^(FAQPage|Article|BlogPosting|NewsArticle|Product|Service|HowTo|Offer|Course|Event|Recipe|SoftwareApplication|Review|QAPage)$/;
function robotsBlocked(txt,bot){
  const groups=[]; let cur=null, lastUA=false;
  txt.split(/\r?\n/).forEach(raw=>{
    const l=raw.replace(/#.*/,"").trim(); if(!l) return;
    const m=l.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if(!m) return;
    const k=m[1].toLowerCase(), v=m[2].trim();
    if(k==="user-agent"){ if(!cur||!lastUA){cur={uas:[],dis:[],allow:[]};groups.push(cur);} cur.uas.push(v.toLowerCase()); lastUA=true; }
    else { lastUA=false; if(!cur) return; if(k==="disallow") cur.dis.push(v); if(k==="allow") cur.allow.push(v); }
  });
  const g=groups.find(g=>g.uas.includes(bot.toLowerCase()))||groups.find(g=>g.uas.includes("*"));
  if(!g) return false;
  return g.dis.includes("/") && !g.allow.includes("/");
}
function analyze(html,url,robots,type){
  const doc=new DOMParser().parseFromString(html,"text/html");
  const R=[]; const set=(id,s,note)=>R.push({id,s,note});
  const q=sel=>doc.querySelector(sel), qa=sel=>[...doc.querySelectorAll(sel)];
  const metaC=sel=>{const m=q(sel);return m?(m.getAttribute("content")||"").trim():"";};
  const canonical=(q('link[rel="canonical"]')||{}).getAttribute?.("href")||"";
  const ogUrl=metaC('meta[property="og:url"]');
  const pageUrl=url||canonical||ogUrl||"";
  // https
  if(pageUrl) set("https",/^https:/i.test(pageUrl)?"pass":"fail",/^https:/i.test(pageUrl)?"URL uses HTTPS.":`URL is not HTTPS: ${pageUrl}`);
  const robotsMeta=(metaC('meta[name="robots"]')+" "+metaC('meta[name="googlebot"]')).toLowerCase();
  set("indexable",robotsMeta.includes("noindex")?"fail":"pass",robotsMeta.includes("noindex")?"Robots meta contains noindex.":"No noindex directive found.");
  set("canonical",canonical?"pass":"fail",canonical?`Canonical: ${canonical}`:"No canonical link tag.");
  set("viewport",q('meta[name="viewport"]')?"pass":"fail",q('meta[name="viewport"]')?"Viewport meta tag present.":"No viewport meta tag.");
  const lang=(doc.documentElement.getAttribute("lang")||"").trim();
  set("lang",lang?"pass":"fail",lang?`lang="${lang}"`:"No lang attribute on <html>.");
  const title=(q("title")?.textContent||"").trim();
  const tl=title.length;
  set("title",!tl?"fail":(tl>=30&&tl<=60)?"pass":(tl>=15&&tl<=70)?"partial":"fail",tl?`${tl} characters: “${title}”`:"No title tag.");
  const md=metaC('meta[name="description"]'); const ml=md.length;
  set("meta_desc",!ml?"fail":(ml>=70&&ml<=160)?"pass":(ml>=50&&ml<=200)?"partial":"fail",ml?`${ml} characters: “${md.slice(0,170)}”`:"No meta description.");
  const h1s=qa("h1").map(h=>h.textContent.trim().replace(/\s+/g," ")).filter(Boolean);
  set("h1",h1s.length===1?"pass":h1s.length>1?"partial":"fail",h1s.length?`${h1s.length} H1: “${h1s.slice(0,2).join("” / “")}”`:"No H1 found.");
  const heads=qa("h2,h3,h4").map(h=>h.textContent.trim().replace(/\s+/g," ")).filter(Boolean);
  const h2n=qa("h2").filter(h=>h.textContent.trim()).length;
  set("headings",h2n>=2?"pass":h2n===1?"partial":"fail",`${h2n} H2 heading${h2n===1?"":"s"}, ${heads.length} H2–H4 total.`);
  const imgs=qa("img").filter(i=>i.getAttribute("role")!=="presentation"&&!i.closest('[aria-hidden="true"]'));
  if(imgs.length){ const withAlt=imgs.filter(i=>i.hasAttribute("alt")).length, deco=imgs.filter(i=>i.hasAttribute("alt")&&i.getAttribute("alt").trim()==="").length; const r=withAlt/imgs.length;
    set("alt",r>=0.9?"pass":r>=0.5?"partial":"fail",`${withAlt} of ${imgs.length} images have an alt attribute${deco?` (${deco} marked decorative with alt="")`:""}.`); }
  else set("alt","na","No images in the page source, or all are hidden from assistive tech.");
  let base; try{base=new URL(pageUrl||"https://example.invalid/");}catch(e){base=new URL("https://example.invalid/");}
  const host=base.hostname.replace(/^www\./,"");
  const anchors=qa("a[href]");
  const internal=new Set();
  anchors.forEach(an=>{const h=an.getAttribute("href").trim(); if(!h||h.startsWith("#")||/^(mailto|tel|javascript):/i.test(h)) return; try{const u=new URL(h,base); if(u.hostname.replace(/^www\./,"")===host && u.pathname!==base.pathname) internal.add(u.pathname);}catch(e){}});
  set("internal_links",internal.size>=3?"pass":internal.size>0?"partial":"fail",`${internal.size} unique internal link${internal.size===1?"":"s"}${host==="example.invalid"?" (add the page URL for accurate counting)":""}.`);
  const ogt=metaC('meta[property="og:title"]'), ogd=metaC('meta[property="og:description"]'), ogi=metaC('meta[property="og:image"]');
  const ogn=[ogt,ogd,ogi].filter(Boolean).length;
  set("og",ogn===3?"pass":ogn>0?"partial":"fail",`${ogn} of 3 core Open Graph tags (title, description, image).`);
  // text
  const body=(doc.body||doc.documentElement).cloneNode(true);
  body.querySelectorAll("script,style,noscript,svg,template,iframe").forEach(n=>n.remove());
  const text=(body.textContent||"").replace(/\s+/g," ").trim();
  const words=text?text.split(" ").filter(w=>/[A-Za-z0-9]/.test(w)).length:0;
  set("word_count",words>=300?"pass":words>=150?"partial":"fail",`${words} words of visible text in the source.`);
  set("ssr",words>=150?"pass":words>=40?"partial":"fail",words>=150?"Main copy is present in the HTML.":"Little text in the raw HTML. The page may build its content with JavaScript, which many AI crawlers can't run.");
  // schema
  const types=new Set(); let sameAs=0, ldDate=false, ldAuthor=false, ldBad=0, ldCount=0;
  const walk=o=>{ if(Array.isArray(o)) return o.forEach(walk); if(o&&typeof o==="object"){ const t=o["@type"]; if(t)(Array.isArray(t)?t:[t]).forEach(x=>types.add(String(x).replace(/^.*[\/#]/,""))); if(o.sameAs) sameAs+=Array.isArray(o.sameAs)?o.sameAs.length:1; if(o.datePublished||o.dateModified) ldDate=true; if(o.author) ldAuthor=true; Object.values(o).forEach(v=>{if(v&&typeof v==="object") walk(v);}); } };
  qa('script[type="application/ld+json"]').forEach(sc=>{ ldCount++; try{walk(JSON.parse(sc.textContent));}catch(e){ldBad++;} });
  qa("[itemtype]").forEach(el=>{const t=(el.getAttribute("itemtype")||"").split("/").pop(); if(t) types.add(t);});
  const tlist=[...types];
  set("schema_any",tlist.length?"pass":"fail",tlist.length?`${ldCount} JSON-LD block${ldCount===1?"":"s"}${ldBad?` (${ldBad} invalid)`:""}; types: ${tlist.join(", ")}`:ldBad?`${ldBad} JSON-LD block(s) failed to parse.`:"No structured data found.");
  const ent=tlist.filter(t=>ENTITY_TYPES.test(t));
  set("schema_entity",ent.length?"pass":"fail",ent.length?`Entity type: ${ent.join(", ")}`:"No Organization or LocalBusiness schema.");
  set("schema_sameas",sameAs>=2?"pass":sameAs===1?"partial":"fail",sameAs?`${sameAs} sameAs link${sameAs===1?"":"s"}.`:"No sameAs links in schema.");
  const cont=tlist.filter(t=>CONTENT_TYPES.test(t));
  set("schema_content",cont.length?"pass":"fail",cont.length?`Content types: ${cont.join(", ")}`:"No FAQ, Article, Product, Service or HowTo schema.");
  const isHome=base.hostname!=="example.invalid"&&(base.pathname==="/"||base.pathname==="");
  set("breadcrumbs",tlist.includes("BreadcrumbList")?"pass":isHome?"na":"fail",tlist.includes("BreadcrumbList")?"BreadcrumbList present.":isHome?"Not needed on a home page.":"No BreadcrumbList schema.");
  // answers
  const qh=heads.filter(h=>/\?\s*$/.test(h)||/^(how|what|why|when|where|who|which|can|do|does|is|are|should|will)\b/i.test(h));
  set("question_headings",qh.length>=2?"pass":qh.length===1?"partial":"fail",qh.length?`${qh.length} question-style heading${qh.length===1?"":"s"}, e.g. “${qh[0]}”`:"No question-style headings.");
  const faqHead=heads.some(h=>/faq|frequently asked|common questions/i.test(h));
  const details=qa("details").length;
  const faqOk=types.has("FAQPage")||faqHead||details>=2||qh.length>=3;
  set("faq",faqOk?"pass":qh.length?"partial":"fail",types.has("FAQPage")?"FAQPage schema present.":faqHead?"FAQ heading found.":details>=2?`${details} expandable Q&A items.`:qh.length>=3?"Several question headings act as an FAQ.":"No FAQ section found.");
  const inChrome=el=>!!el.closest("nav,header,footer");
  const lists=qa("ul,ol").filter(l=>!inChrome(l)&&l.querySelectorAll(":scope > li").length>=3).length;
  const tables=qa("table").filter(t=>!inChrome(t)).length;
  set("lists_tables",(lists+tables)>0?"pass":"fail",`${lists} content list${lists===1?"":"s"}, ${tables} table${tables===1?"":"s"} (outside nav/footer).`);
  const hasAuthor=ldAuthor||!!metaC('meta[name="author"]')||!!metaC('meta[property="article:author"]')||!!q('[rel="author"]');
  const hasDate=ldDate||!!metaC('meta[property="article:published_time"]')||!!metaC('meta[property="article:modified_time"]')||!!q("time[datetime]");
  if(type==="article") set("author_date",hasAuthor&&hasDate?"pass":(hasAuthor||hasDate)?"partial":"fail",`Author ${hasAuthor?"found":"missing"}, date ${hasDate?"found":"missing"}.`);
  else set("author_date",hasAuthor&&hasDate?"pass":"na",hasAuthor&&hasDate?"Author and date found.":"Not expected on this page type.");
  const about=anchors.some(an=>/about/i.test(an.getAttribute("href")+" "+an.textContent)), contact=anchors.some(an=>/contact/i.test(an.getAttribute("href")+" "+an.textContent));
  set("about_contact",about&&contact?"pass":(about||contact)?"partial":"fail",`About link ${about?"found":"missing"}, Contact link ${contact?"found":"missing"}.`);
  if(robots&&robots.trim()){
    const bots=["GPTBot","OAI-SearchBot","ClaudeBot","PerplexityBot","Google-Extended"];
    const blocked=bots.filter(b=>robotsBlocked(robots,b));
    set("ai_crawlers",!blocked.length?"pass":blocked.length<bots.length?"partial":"fail",blocked.length?`Blocked: ${blocked.join(", ")}.`:`All five AI crawlers allowed (${bots.join(", ")}).`);
  }
  const scan={date:Date.now(),title,meta:md,h1:h1s.slice(0,3),headings:heads.slice(0,40),schema:tlist,words,text:text.slice(0,6000)};
  return {results:R,scan};
}


// Analyze a page's HTML. When the page builds its content from a <template> with JavaScript, the raw HTML is
// what crawlers that don't run JavaScript see (used for the "readable without JavaScript" check) and the
// template's content is scored for everything else.
function analyzePage(html, url, robots, type){
  const raw = analyze(html, url, robots, type);
  if (raw.scan.words >= 150 || !/<template[\s>]/i.test(html)) return Object.assign(raw, {rendered:false});
  const unwrapped = html.replace(/<template\b[^>]*>/gi, "<div>").replace(/<\/template>/gi, "</div>");
  const r = analyze(unwrapped, url, robots, type);
  if (r.scan.words <= raw.scan.words) return Object.assign(raw, {rendered:false});
  r.results = r.results.map(x => x.id === "ssr"
    ? {id:"ssr", s: raw.scan.words >= 40 ? "partial" : "fail", note: "Raw HTML has " + raw.scan.words + " words; the rest is built by JavaScript from a <template>, so AI crawlers that don't run JavaScript miss it."}
    : x);
  return Object.assign(r, {rendered:true});
}

return { TYPES, ENGINES, CHECKS, CHECK_BY_ID, STATUSES, ASSET_STATUS, PROMPT_RESULTS, MANUAL_AI, kindOf, checksFor,
  grade, impactOf, visibility, statusOf, scores, priorities, robotsBlocked, analyze, analyzePage };
});
