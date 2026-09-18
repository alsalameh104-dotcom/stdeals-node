require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { config, readClients, writeClients } = require('./config');
const { login, register, requireAuth,requireUploadApiKey } = require('./auth');
const deals = require('./deals');
const multer = require('multer');

fs.mkdirSync(config.imageRoot, { recursive: true });

const imageUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(config.imageRoot, req.body.provider);
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            cb(null, req.body.filename);
        }
    })
});

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin(origin, cb) { if (!origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) return cb(null,true); cb(new Error('CORS blocked')); }, credentials:true, exposedHeaders:['Authorization'] }));
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit:'5mb' }));
app.use(express.text({ type:['text/yaml','application/x-yaml'], limit:'1mb' }));
app.use('/images', express.static(config.imageRoot, { maxAge:'7d', immutable:false }));

const contactLimiter=rateLimit({windowMs:10*60*1000,max:5,standardHeaders:true,legacyHeaders:false});
const loginLimiter=rateLimit({windowMs:10*60*1000,max:5,standardHeaders:true,legacyHeaders:false});
const dealsLimiter=rateLimit({windowMs:60*1000,max:100,standardHeaders:true,legacyHeaders:false});
const defaultLimiter=rateLimit({windowMs:60*1000,max:200,standardHeaders:true,legacyHeaders:false});

app.use((req,res,next)=>{ if(req.path.startsWith('/api/contact')) return contactLimiter(req,res,next); if(req.path.startsWith('/auth/login')) return loginLimiter(req,res,next); if(req.path.startsWith('/api/deals')) return dealsLimiter(req,res,next); if(req.path.startsWith('/api')||req.path.startsWith('/auth')) return defaultLimiter(req,res,next); next(); });

function admin(req,res,next){ return requireAuth(req,res,next); }
function slugify(text){ return String(text||'').toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu,'').replace(/\s+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'').slice(0,100).replace(/-$/,''); }
function xmlEscape(v){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}

app.post(
    '/api/internal/images/upload',
    requireUploadApiKey,
    imageUpload.single('file'),
    (req, res) => res.sendStatus(204)
);

app.post('/auth/login', async(req,res,next)=>{try{res.json({token:await login(req.body.email,req.body.password)});}catch(e){next(e);}});
app.post('/auth/register', async(req,res,next)=>{try{res.json(await register(req.body.email,req.body.password));}catch(e){next(e);}});

app.get('/api/deals', async(req,res,next)=>{try{res.set('Cache-Control','public, max-age=600');res.json(await deals.activeDeals());}catch(e){next(e);}});
app.get('/api/deals/store/:storeName', async(req,res,next)=>{try{res.set('Cache-Control','public, max-age=600');res.json(await deals.activeDeals({store:req.params.storeName}));}catch(e){next(e);}});
app.get('/api/deals/:id', async(req,res,next)=>{try{const d=await deals.getById(req.params.id);if(!d)return res.sendStatus(404);res.set('Cache-Control','public, max-age=600');res.json(d);}catch(e){next(e);}});

app.get('/api/common/providers', async(req,res,next)=>{try{const cfg=readClients();res.json(Object.entries(cfg.clients||{}).filter(([,c])=>c.enabled).map(([k])=>k));}catch(e){next(e);}});
app.get('/api/common/deal-types', async(req,res,next)=>{try{const cfg=readClients();const s=new Set();for(const c of Object.values(cfg.clients||{})){if(c.enabled)for(const t of Object.keys(c.types||{}))s.add(t.toLowerCase());}res.json([...s]);}catch(e){next(e);}});

app.get('/api/admin/deals', admin, async(req,res,next)=>{try{res.json(await deals.getAdmin(req.query.status));}catch(e){next(e);}});
app.get('/api/admin/deals/pageable-deals', admin, async(req,res,next)=>{try{res.json(await deals.pageable({provider:req.query.provider,type:req.query.type,search:req.query.search,page:Number(req.query.page||0),size:Number(req.query.size||30)}));}catch(e){next(e);}});
app.get('/api/admin/deals/:id', admin, async(req,res,next)=>{try{const d=await deals.getById(req.params.id);if(!d)return res.sendStatus(404);res.json(d);}catch(e){next(e);}});
app.post('/api/admin/deals', admin, async(req,res,next)=>{try{res.status(201).json(await deals.create(req.body));}catch(e){next(e);}});
app.put('/api/admin/deals/:id', admin, async(req,res,next)=>{try{res.json(await deals.update(req.params.id,req.body));}catch(e){next(e);}});
app.delete('/api/admin/deals/:id', admin, async(req,res,next)=>{try{await deals.remove(req.params.id);res.sendStatus(204);}catch(e){next(e);}});
app.post('/api/admin/deals/bulk', admin, async(req,res,next)=>{try{res.status(201).json(await deals.bulkCreate(req.body));}catch(e){next(e);}});
app.put('/api/admin/deals/bulk-status', admin, async(req,res,next)=>{try{res.json(await deals.bulkStatus(req.body.ids,req.body.status));}catch(e){next(e);}});

app.get('/api/admin/deals/providers', admin, (req,res,next)=>{try{const cfg=readClients();res.json(Object.entries(cfg.clients||{}).filter(([,c])=>c.enabled).map(([k])=>k));}catch(e){next(e);}});
app.get('/api/admin/deals/config', admin, (req,res,next)=>{try{res.type('text/yaml').send(require('yaml').stringify(readClients()));}catch(e){next(e);}});
app.put('/api/admin/deals/config', admin, (req,res,next)=>{try{const YAML=require('yaml');const value=YAML.parse(req.body);res.type('text/yaml').send(writeClients(value));}catch(e){next(e);}});
app.post('/api/admin/deals/reload-config', admin, (req,res,next)=>{try{res.type('text/yaml').send(require('yaml').stringify(readClients()));}catch(e){next(e);}});

let syncState={running:false,provider:null,startedAt:null,status:'IDLE',message:null};
app.post('/api/admin/deals/sync', admin, async(req,res,next)=>{try{const provider=req.query.provider||null;if(syncState.running)return res.status(409).send(provider?`${provider} sync already running`:'Global sync already running');syncState={running:true,provider,startedAt:new Date().toISOString(),status:'RUNNING',message:null};if(!config.scraperUrl){syncState={...syncState,running:false,status:'ERROR',message:'SCRAPER_URL is not configured'};return res.status(503).send('SCRAPER_URL is not configured');}res.status(202).send(provider?`Sync started for ${provider}`:'Global sync started');fetch(`${config.scraperUrl}/api/admin/deals/sync${provider?`?provider=${encodeURIComponent(provider)}`:''}`,{method:'POST',signal:AbortSignal.timeout(config.scraperTimeoutMs)}).then(async r=>{syncState={...syncState,running:false,status:r.ok?'COMPLETED':'ERROR',message:await r.text()};}).catch(e=>{syncState={...syncState,running:false,status:'ERROR',message:e.message};});}catch(e){next(e);}});
app.get('/api/admin/deals/sync/status', admin, (req,res)=>res.json(syncState));

app.post('/api/contact',async(req,res,next)=>{try{if(!config.mail.host||!config.mail.user)return res.status(503).send('Mail is not configured');const t=nodemailer.createTransport({host:config.mail.host,port:config.mail.port,secure:config.mail.port===465,auth:{user:config.mail.user,pass:config.mail.password}});await t.sendMail({from:config.mail.from,to:config.mail.user,replyTo:req.body.email,subject:'New Contact Message from STDeals',text:`Name: ${req.body.name}\nEmail: ${req.body.email}\n\nMessage:\n${req.body.message}`});res.sendStatus(204);}catch(e){next(e);}});

app.get('/sitemap.xml',async(req,res,next)=>{try{const ds=await deals.activeDeals();const urls=new Set([`${config.baseUrl}/`,`${config.baseUrl}/stores`]);for(const d of ds){if(d.storeName){const s=slugify(d.storeName);if(s)urls.add(`${config.baseUrl}/store/${s}`);}if(d.id){let u=`${config.baseUrl}/deal/${d.id}`;const s=slugify(d.title);if(s)u+=`/${s}`;urls.add(u);}}let xml='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';for(const u of urls)xml+=`  <url><loc>${xmlEscape(u)}</loc></url>\n`;xml+='</urlset>';res.type('application/xml').send(xml);}catch(e){next(e);}});
app.get('/robots.txt',(req,res)=>res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${config.baseUrl}/sitemap.xml\n`));

// Optional: serve the built React application from public/.
app.use(express.static(path.join(config.root,'public'),{maxAge:'1h'}));
app.get('/{*splat}',(req,res,next)=>{if(req.path.startsWith('/api')||req.path.startsWith('/auth')||req.path==='/sitemap.xml'||req.path==='/robots.txt'||req.path.startsWith('/images'))return next();const index=path.join(config.root,'public','index.html');if(fs.existsSync(index))return res.sendFile(index);res.status(404).json({error:'Not found'});});

app.use((err,req,res,next)=>{console.error(err);const status=err.status||500;res.status(status).json({error:status===500?'Internal server error':err.message});});

app.listen(config.port,()=>console.log(`STDeals Node server listening on :${config.port}`));
