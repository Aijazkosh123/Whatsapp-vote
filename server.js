const express = require('express');
const cors = require('cors');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, delay, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = 3000;
const COOLDOWN = 15 * 60 * 1000;
const EXPIRE_CHECK = 15 * 60 * 1000;
const DB_FILE = './database.json';
const SESSION_FILE = './bots.json';

let VOTE_HISTORY = {};
let BOTS = [];
const ALL_SOCKS = [];
let VOTE_OPTION = "A";
let VOTING_ACTIVE = false;
let CURRENT_LINK = "";
let VOTE_INTERVAL;
let VOTE_COUNT = 1;
let currentVoteRound = 0;

function loadDB(){
    if(fs.existsSync(DB_FILE)) VOTE_HISTORY = JSON.parse(fs.readFileSync(DB_FILE));
    if(fs.existsSync(SESSION_FILE)) BOTS = JSON.parse(fs.readFileSync(SESSION_FILE));
}
function saveDB(){
    fs.writeFileSync(DB_FILE, JSON.stringify(VOTE_HISTORY, null, 2));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(BOTS, null, 2));
}
setInterval(saveDB, 10000);

function checkExpiredSessions(){
    let removed = 0;
    BOTS.forEach(bot => {
        const creds = `./sessions/session_${bot.id}/creds.json`;
        const isOnline = ALL_SOCKS.find(s=>s.id===bot.id);
        if(!isOnline &&!fs.existsSync(creds)){
            BOTS = BOTS.filter(b=>b.id!== bot.id);
            if(fs.existsSync(`./sessions/session_${bot.id}`)) fs.rmSync(`./sessions/session_${bot.id}`, { recursive: true, force: true });
            removed++;
            io.emit('log', `🗑️ ${bot.name} Auto Removed - Session Expired`);
        }
    });
    if(removed > 0){ saveDB(); io.emit('updateList'); }
}
setInterval(checkExpiredSessions, EXPIRE_CHECK);

async function startBot(botInfo) {
    const sessionFolder = `./sessions/session_${botInfo.id}`;
    if(!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const sock = makeWASocket({ logger: pino({ level: 'silent' }), printQRInTerminal: false, auth: state, browser: Browsers.macOS("Chrome") });

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
                io.emit('log', `❌ ${botInfo.name} Logged Out`);
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

async function masterVote(){
    if(!VOTING_ACTIVE) return;
    if(currentVoteRound >= VOTE_COUNT){
        VOTING_ACTIVE = false;
        clearInterval(VOTE_INTERVAL);
        io.emit('log', `✅ Voting Finished - ${VOTE_COUNT} Rounds Complete`);
        return;
    }

    const inviteCode = CURRENT_LINK.split('/').pop();
    let success = 0; let skipped = 0; let fail = 0;
    currentVoteRound++;

    for(let bot of ALL_SOCKS){
        if(!VOTING_ACTIVE) break;
        const key = `${CURRENT_LINK}_${bot.id}_${currentVoteRound}`;
        if(VOTE_HISTORY[key] && Date.now() - VOTE_HISTORY[key] < COOLDOWN){ skipped++; continue; }

        await delay(2000);
        try {
            await bot.sock.groupAcceptInvite(inviteCode);
            await delay(2000);
            const msgs = await bot.sock.fetchMessageHistory(20, bot.sock.user.id, 'before');
            const pollMsg = msgs.find(m => m.message?.pollCreationMessage);
            if(pollMsg){
                const options = pollMsg.message.pollCreationMessage.options;
                const optionIndex = "ABCDE".indexOf(VOTE_OPTION.toUpperCase());
                if(optionIndex < options.length){
                    await bot.sock.sendMessage(pollMsg.key.remoteJid, { pollUpdateMessage: { pollCreationMessageKey: pollMsg.key, pollUpdate: { optionVotes: [options[optionIndex].optionName] } });
                    VOTE_HISTORY[key] = Date.now(); success++;
                    io.emit('log', `🗳️ Round ${currentVoteRound}: ${bot.name} voted ${VOTE_OPTION}`);
                }
            }
        } catch(e){ fail++; io.emit('log', `❌ ${bot.name} Failed`); }
    }
    saveDB();
    io.emit('log', `📊 Round ${currentVoteRound} Done | Voted: ${success} | Skipped: ${skipped} | Failed: ${fail}`);
}

app.post('/api/addsession', (req,res)=>{
    const {id,name} = req.body;
    if(BOTS.find(b=>b.id===id)) return res.json({msg:"❌ Bot ID Already Exists"});
    BOTS.push({id,name}); saveDB(); startBot({id,name});
    res.json({msg:`✅ ${name} Created. Please Get QR`});
});

app.post('/api/rmsession', (req,res)=>{
    const {id} = req.body;
    BOTS = BOTS.filter(b=>b.id!==id);
    if(fs.existsSync(`./sessions/session_${id}`)) fs.rmSync(`./sessions/session_${id}`, { recursive: true, force: true });
    const sockIndex = ALL_SOCKS.findIndex(s=>s.id===id);
    if(sockIndex > -1) ALL_SOCKS.splice(sockIndex,1);
    saveDB(); io.emit('updateList');
    res.json({msg:`🗑️ Bot-${id} Removed Successfully`});
});

app.post('/api/qr', (req,res)=>{
    const {id} = req.body;
    if(!BOTS.find(b=>b.id===id)) return res.json({msg:"❌ Please Add Bot First"});
    startBot({id,name:`Bot-${id}`});
    res.json({msg:`📲 Generating QR for Bot-${id}...`});
});

app.post('/api/session', async (req,res)=>{
    const {id,sessionId} = req.body;
    const name = `Bot-${id}`;
    const sessionFolder = `./sessions/session_${id}`;
    if(!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });
    try {
        const base64Data = sessionId.replace("KnightBot!", "");
        fs.writeFileSync(`${sessionFolder}/creds.json`, Buffer.from(base64Data, 'base64').toString('utf-8'));
    } catch(e){ return res.json({msg:"❌ Invalid Session ID"}) }
    if(!BOTS.find(b=>b.id===id)) BOTS.push({id,name});
    saveDB(); startBot({id,name});
    res.json({msg:`✅ ${name} Login Success`});
});

app.post('/api/option', (req,res)=>{ VOTE_OPTION = req.body.option.toUpperCase(); res.json({msg:`✅ Vote Option Set: ${VOTE_OPTION}`}); });

app.post('/api/startvote', (req,res)=>{
    VOTING_ACTIVE = true;
    CURRENT_LINK = req.body.link;
    VOTE_COUNT = parseInt(req.body.count) || 1;
    if(VOTE_COUNT < 1) VOTE_COUNT = 1; // CHANGED TO 1
    currentVoteRound = 0;
    io.emit('log', `🚀 Voting STARTED | Rounds: ${VOTE_COUNT} | Option: ${VOTE_OPTION}`);
    res.json({msg:`🚀 Voting Started - ${VOTE_COUNT} Rounds`});
    clearInterval(VOTE_INTERVAL);
    VOTE_INTERVAL = setInterval(()=>{ if(VOTING_ACTIVE) masterVote(); }, 5000);
});

app.post('/api/stopvote', (req,res)=>{ VOTING_ACTIVE = false; clearInterval(VOTE_INTERVAL); res.json({msg:`🛑 Voting Stopped`}); });
app.get('/api/list', (req,res)=>{ let list = BOTS.map(b=>({ id:b.id, name:b.name, status: ALL_SOCKS.find(s=>s.id===b.id)?'Online':'Offline' })); res.json({list, option:VOTE_OPTION, total:BOTS.length, online:ALL_SOCKS.length, active:VOTING_ACTIVE}); });
app.post('/api/resetdb', (req,res)=>{ VOTE_HISTORY={}; saveDB(); res.json({msg:"✅ Database Reset"}) });

io.on('connection', ()=>{});
loadDB();
if(!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');
BOTS.forEach(bot => startBot(bot));

server.listen(PORT, '0.0.0.0', ()=>console.log(`✅ KoSh Panel Running: http://0.0.0.0:${PORT}`));
