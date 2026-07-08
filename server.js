const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = 3000;
const COOLDOWN = 15 * 60 * 1000;
const DB_FILE = './database.json';
const SESSION_FILE = './bots.json';
const BACKUP_FOLDER = './backups/';

let VOTE_HISTORY = {};
let BOTS = [];
const ALL_SOCKS = [];
let VOTE_OPTION = 1;

// ====== LOAD/SAVE ======
function loadDB(){
    if(fs.existsSync(DB_FILE)) VOTE_HISTORY = JSON.parse(fs.readFileSync(DB_FILE));
    if(fs.existsSync(SESSION_FILE)) BOTS = JSON.parse(fs.readFileSync(SESSION_FILE));
}
function saveDB(){
    fs.writeFileSync(DB_FILE, JSON.stringify(VOTE_HISTORY, null, 2));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(BOTS, null, 2));
}
setInterval(saveDB, 10000);

// ====== AUTO BACKUP ======
function autoBackup(){
    if(!fs.existsSync(BACKUP_FOLDER)) fs.mkdirSync(BACKUP_FOLDER);
    const time = new Date().toISOString().replace(/[:.]/g,'-');
    if(fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, `${BACKUP_FOLDER}database_${time}.json`);
    if(fs.existsSync(SESSION_FILE)) fs.copyFileSync(SESSION_FILE, `${BACKUP_FOLDER}bots_${time}.json`);
}

// ====== START WHATSAPP BOT ======
async function startBot(botInfo) {
    const sessionFolder = `./sessions/session_${botInfo.id}`;
    if(!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const sock = makeWASocket({ 
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false, 
        auth: state,
        browser: Browsers.macOS("Chrome")
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if(qr){
            const qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr)}`;
            io.emit('qr', {id: botInfo.id, qr: qrCode});
        }
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode!== DisconnectReason.loggedOut;
            if(shouldReconnect){ await delay(5000); startBot(botInfo); }
            else { 
                io.emit('log', `❌ ${botInfo.name} Logout`);
                const index = ALL_SOCKS.findIndex(s=>s.id===botInfo.id);
                if(index > -1) ALL_SOCKS.splice(index,1);
                io.emit('updateList');
            }
        } else if(connection === 'open') {
            if(!ALL_SOCKS.find(s=>s.id===botInfo.id)) ALL_SOCKS.push({ id: botInfo.id, name: botInfo.name, sock });
            io.emit('log', `✅ ${botInfo.name} Online`);
            io.emit('updateList');
        }
    });
}

// ====== VOTE ======
async function masterVote(groupLink){
    const inviteCode = groupLink.split('/').pop();
    let success = 0; let skipped = 0; let fail = 0;
    io.emit('log', `🚀 Voting Start... Option: ${VOTE_OPTION}`);

    for(let bot of ALL_SOCKS){
        const key = `${groupLink}_${bot.id}`;
        if(VOTE_HISTORY[key] && Date.now() - VOTE_HISTORY[key] < COOLDOWN){ skipped++; continue; }
        await delay(2000);
        try {
            await bot.sock.groupAcceptInvite(inviteCode);
            await delay(1000);
            // یہاں تمہارا Poll Vote والا logic آئے گا
            io.emit('log', `✅ ${bot.name} joined group`);
            VOTE_HISTORY[key] = Date.now(); success++;
        } catch(e){ 
            io.emit('log', `❌ ${bot.name} Failed: ${e.message}`);
            fail++; 
        }
    }
    saveDB();
    io.emit('log', `✅ Done | Voted: ${success} | Skipped: ${skipped} | Failed: ${fail}`);
}

// ====== API ROUTES ======
app.post('/api/addsession', (req,res)=>{
    const {id,name} = req.body;
    if(BOTS.find(b=>b.id===id)) return res.json({msg:"❌ Bot Already Exists"});
    BOTS.push({id,name}); saveDB(); startBot({id,name});
    res.json({msg:`✅ ${name} Added. Now Get QR`});
});

app.post('/api/qr', (req,res)=>{
    const {id} = req.body;
    if(!BOTS.find(b=>b.id===id)) BOTS.push({id,name:`Bot-${id}`});
    saveDB(); startBot({id,name:`Bot-${id}`});
    res.json({msg:`📲 QR Generating... Wait 3 sec`});
});

app.post('/api/extract', (req,res)=>{
    const {id} = req.body;
    const credsFile = `./sessions/session_${id}/creds.json`;
    if(!fs.existsSync(credsFile)) return res.json({msg:"❌ Session نہیں ملا"});
    const jsonData = fs.readFileSync(credsFile, 'utf-8');
    const base64Data = Buffer.from(jsonData).toString('base64');
    const sessionId = `KnightBot!${base64Data}`;
    res.json({msg:`✅ Session ID Copied`, sessionId});
});

app.post('/api/session', async (req,res)=>{
    const {id,sessionId} = req.body;
    const name = `Bot-${id}`;
    const sessionFolder = `./sessions/session_${id}`;
    if(!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });
    try {
        const base64Data = sessionId.replace("KnightBot!", "");
        const jsonData = Buffer.from(base64Data, 'base64').toString('utf-8');
        fs.writeFileSync(`${sessionFolder}/creds.json`, jsonData);
    } catch(e){ return res.json({msg:"❌ Invalid Session ID"}) }
    if(!BOTS.find(b=>b.id===id)) BOTS.push({id,name});
    saveDB(); startBot({id,name});
    res.json({msg:`✅ ${name} Login`});
});

app.post('/api/rmsession', (req,res)=>{
    const {id} = req.body;
    BOTS = BOTS.filter(b=>b.id!==id);
    fs.rmSync(`./sessions/session_${id}`, { recursive: true, force: true });
    saveDB();
    res.json({msg:`✅ Bot-${id} Removed`});
});

app.post('/api/option', (req,res)=>{
    VOTE_OPTION = parseInt(req.body.option);
    res.json({msg:`✅ Vote Option: ${VOTE_OPTION}`});
});

app.post('/api/vote', (req,res)=>{
    masterVote(req.body.link);
    res.json({msg:`🚀 Voting Started`});
});

app.get('/api/list', (req,res)=>{
    let list = BOTS.map(b=>({
        id:b.id, name:b.name, 
        status: ALL_SOCKS.find(s=>s.id===b.id)?'Online':'Offline'
    }));
    res.json({list, option:VOTE_OPTION, total:BOTS.length, online:ALL_SOCKS.length});
});

app.post('/api/backup', (req,res)=>{ autoBackup(); res.json({msg:"✅ Backup Done"}) });
app.post('/api/resetdb', (req,res)=>{ VOTE_HISTORY={}; saveDB(); res.json({msg:"✅ DB Reset"}) });

// ====== START ======
io.on('connection', ()=>{});

loadDB();
if(!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');
BOTS.forEach(bot => startBot(bot));
autoBackup();

server.listen(PORT, ()=>console.log(`✅ Panel Running: http://localhost:${PORT}`));    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update)=>{
        if(update.qr){
            sessions[id].qr = update.qr; // QR save kar lo
            console.log(`QR for ${id} ready`);
        }
        if(update.connection === 'open'){
            console.log(`✅ Bot ${id} Connected`);
            sessions[id].qr = null; // QR clear
        }
        if(update.connection === 'close'){
            delete sessions[id];
        }
    });

    res.json({msg:`Bot ${id} - ${name} Added ✅. Ab QR lo`});
});

// 2. QR Get - Panel me dikhega
app.post('/api/qr', async (req,res)=>{
    const {id} = req.body;
    if(!sessions[id]) return res.json({msg:"Pehle bot add karo"});
    if(!sessions[id].qr) return res.json({msg:"QR nahi mila. 5 sec wait karke dobara try karo"});

    res.json({msg:"QR Ready", qr: sessions[id].qr});
});

// 3. Vote
app.post('/api/vote', async (req,res)=>{
    const {link} = req.body;
    if(!link) return res.json({msg:"Group link do"});
    if(!link.includes('chat.whatsapp.com/')) return res.json({msg:"Sahi group link do"});

    const groupId = link.split('/')[3];
    let count = 0;
    for(let id in sessions){
        try{
            await sessions[id].sock.sendMessage(groupId+'@g.us', {text: `Vote from ${sessions[id].name}`});
            count++;
            await new Promise(r => setTimeout(r, 2000)); // 2 sec delay
        }catch(e){}
    }
    res.json({msg:`${count} Bot se Vote bhej diya ✅`});
});

app.listen(PORT, ()=>console.log(`✅ Panel Running: http://localhost:${PORT}`));
