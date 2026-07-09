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
let TOTAL_VOTES = 0;

function loadDB(){
    if(fs.existsSync(DB_FILE)) VOTE_HISTORY = JSON.parse(fs.readFileSync(DB_FILE));
    if(fs.existsSync(SESSION_FILE)) BOTS = JSON.parse(fs.readFileSync(SESSION_FILE));
}
function saveDB(){
    fs.writeFileSync(DB_FILE, JSON.stringify(VOTE_HISTORY, null, 2));
    fs.writeFileSync(SESSION_FILE, JSON.stringify(BOTS, null, 2));
}
setInterval(saveDB, 10000);

async function startBot(botInfo, showQR = false) {
    if(ALL_SOCKS.find(s=>s.id===botInfo.id)) return io.emit('log', `⚠️ ${botInfo.name} Already Online`);
    const sessionFolder = `./sessions/session_${botInfo.id}`;
    if(!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const sock = makeWASocket({ logger: pino({ level: 'silent' }), printQRInTerminal: false, auth: state, browser: Browsers.macOS("Chrome") });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if(qr && showQR){
            const qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr)}`;
            io.emit('qr', {id: botInfo.id, qr: qrCode});
        }
        if(connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            const index = ALL_SOCKS.findIndex(s=>s.id===botInfo.id);
            if(index > -1) ALL_SOCKS.splice(index,1);
            io.emit('updateList');
            if(shouldReconnect){ await delay(5000); startBot(botInfo, false); }
            else { io.emit('log', `❌ ${botInfo.name} Logged Out`); }
        } else if(connection === 'open') {
            if(!ALL_SOCKS.find(s=>s.id===botInfo.id)) ALL_SOCKS.push({ id: botInfo.id, name: botInfo.name, sock });
            io.emit('log', `✅ ${botInfo.name} Online`);
            io.emit('updateList');
        }
    });
}

async function findAndVotePoll(sock, jid, isChannel){
    try {
        let msgs = isChannel ? await sock.newsletterFetchMessages(jid, 20) : (await sock.fetchMessageHistory(30, sock.user.id, 'before')).messages;
        const pollMsg = msgs.find(m => m.message?.pollCreationMessage || m.pollName);
        if(!pollMsg) return {status: "fail", reason: "No poll found"};
        const optionIndex = "ABCDE".indexOf(VOTE_OPTION.toUpperCase());
        if(isChannel){
            await sock.newsletterVote(jid, pollMsg.id, optionIndex);
            return {status: "success"};
        } else {
            const options = pollMsg.message.pollCreationMessage.options;
            if(optionIndex >= options.length) return {status: "fail", reason: "Option not found"};
            await sock.sendMessage(jid, { pollUpdateMessage: { pollCreationMessageKey: pollMsg.key, pollUpdate: { optionVotes: [options[optionIndex].optionName] } });
            return {status: "success"};
        }
    } catch(e){ return {status: "fail", reason: e.message} }
}

async function masterVote(){
    if(!VOTING_ACTIVE) return;
    if(currentVoteRound >= VOTE_COUNT){
        VOTING_ACTIVE = false; clearInterval(VOTE_INTERVAL);
        return io.emit('log', `✅ Voting Finished - Total Votes: ${TOTAL_VOTES}`);
    }

    let success = 0; let skipped = 0; let fail = 0;
    currentVoteRound++;
    const isChannel = CURRENT_LINK.includes("whatsapp.com/channel");

    for(let bot of ALL_SOCKS){
        if(!VOTING_ACTIVE) break;
        const key = `${CURRENT_LINK}_${bot.id}_${currentVoteRound}`;
        if(VOTE_HISTORY[key] && Date.now() - VOTE_HISTORY[key] < COOLDOWN){ skipped++; continue; }

        await delay(3000);
        try {
            if(isChannel){
                const channelId = CURRENT_LINK.split('/').pop();
                const voteRes = await findAndVotePoll(bot.sock, channelId, true);
                if(voteRes.status === "success"){ VOTE_HISTORY[key] = Date.now(); success++; TOTAL_VOTES++; io.emit('log', `🗳️ Channel Round ${currentVoteRound}: ${bot.name} voted ${VOTE_OPTION}`); io.emit('voteUpdate', TOTAL_VOTES); }
                else { fail++; io.emit('log', `❌ ${bot.name} Failed: ${voteRes.reason}`); }
            } else {
                const inviteCode = CURRENT_LINK.split('/').pop();
                await bot.sock.groupAcceptInvite(inviteCode);
                io.emit('log', `⏳ ${bot.name} Joined Group. Waiting 1 min...`);
                await delay(60000); // 1 MIN WAIT
                const group = await bot.sock.groupGetInviteInfo(inviteCode);
                const voteRes = await findAndVotePoll(bot.sock, group.id, false);
                if(voteRes.status === "success"){ VOTE_HISTORY[key] = Date.now(); success++; TOTAL_VOTES++; io.emit('log', `🗳️ Group Round ${currentVoteRound}: ${bot.name} voted ${VOTE_OPTION}`); io.emit('voteUpdate', TOTAL_VOTES); }
                else { fail++; io.emit('log', `❌ ${bot.name} Failed: ${voteRes.reason}`); }
            }
        } catch(e){ fail++; io.emit('log', `❌ ${bot.name} Error: ${e.message}`); }
    }
    saveDB();
    io.emit('log', `📊 Round ${currentVoteRound} Done | Voted: ${success} | Total: ${TOTAL_VOTES}`);
}

// API ROUTES
app.post('/api/addsession', (req,res)=>{ const {id,name} = req.body; if(BOTS.find(b=>b.id===id)) return res.json({msg:"❌ Bot ID Already Exists"}); BOTS.push({id,name}); saveDB(); io.emit('log', `✅ ${name} Added`); res.json({msg:`✅ ${name} Added`}); });
app.post('/api/rmsession', (req,res)=>{ const {id} = req.body; BOTS = BOTS.filter(b=>b.id!==id); if(fs.existsSync(`./sessions/session_${id}`)) fs.rmSync(`./sessions/session_${id}`, { recursive: true, force: true }); const sockIndex = ALL_SOCKS.findIndex(s=>s.id===id); if(sockIndex > -1) ALL_SOCKS.splice(sockIndex,1); saveDB(); io.emit('updateList'); res.json({msg:`🗑️ Bot-${id} Removed`}); });
app.post('/api/qr', (req,res)=>{ const {id} = req.body; const bot = BOTS.find(b=>b.id===id); if(!bot) return res.json({msg:"❌ Please Add Bot First"}); startBot(bot, true); res.json({msg:`📲 Generating QR for Bot-${id}`}); });
app.post('/api/session', async (req,res)=>{ const {id,sessionId} = req.body; const name = `Bot-${id}`; if(BOTS.find(b=>b.id===id)) return res.json({msg:"❌ Bot ID Already Exists"}); const sessionFolder = `./sessions/session_${id}`; if(!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true }); try { const base64Data = sessionId.replace("KoShBot!", ""); fs.writeFileSync(`${sessionFolder}/creds.json`, Buffer.from(base64Data, 'base64').toString('utf-8')); } catch(e){ return res.json({msg:"❌ Invalid Session ID"}) } BOTS.push({id,name}); saveDB(); startBot({id,name}, false); res.json({msg:`✅ ${name} Login Success`}); });

app.post('/api/gen/start', async (req,res)=>{
    const {number} = req.body;
    const sessionId = `gen_${Date.now()}`;
    const sessionFolder = `./sessions/gen_${sessionId}`;
    if(fs.existsSync(sessionFolder)) fs.rmSync(sessionFolder, { recursive: true, force: true });
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const sock = makeWASocket({ auth: state, browser: Browsers.macOS("Chrome"), logger: pino({ level: 'silent' }) });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (update) => {
        if(update.connection === 'open'){
            await delay(3000);
            const creds = fs.readFileSync(`${sessionFolder}/creds.json`, 'utf-8');
            const finalSessionId = "KoShBot!" + Buffer.from(creds).toString('base64');
            io.emit('gen_session', {id: sessionId, session: finalSessionId});
            fs.rmSync(sessionFolder, { recursive: true, force: true });
        }
    });
    const code = await sock.requestPairingCode(number.replace(/[^0-9]/g, ''));
    res.json({msg:`📲 Code Generated`, code: code, genId: sessionId});
});

app.post('/api/option', (req,res)=>{ VOTE_OPTION = req.body.option.toUpperCase(); res.json({msg:`✅ Vote Option Set: ${VOTE_OPTION}`}); });
app.post('/api/startvote', (req,res)=>{
    VOTING_ACTIVE = true;
    CURRENT_LINK = req.body.link;
    VOTE_COUNT = parseInt(req.body.count) || 1;
    if(VOTE_COUNT < 1) VOTE_COUNT = 1;
    currentVoteRound = 0;
    TOTAL_VOTES = 0;
    io.emit('voteUpdate', 0);
    io.emit('log', `🚀 Voting STARTED | Rounds: ${VOTE_COUNT} | Option: ${VOTE_OPTION}`);
    res.json({msg:`🚀 Voting Started`});
    clearInterval(VOTE_INTERVAL);
    VOTE_INTERVAL = setInterval(()=>{ if(VOTING_ACTIVE) masterVote(); }, 7000);
});
app.post('/api/stopvote', (req,res)=>{ VOTING_ACTIVE = false; clearInterval(VOTE_INTERVAL); res.json({msg:`🛑 Voting Stopped. Total Votes: ${TOTAL_VOTES}`}); });
app.get('/api/list', (req,res)=>{ let list = BOTS.map(b=>({ id:b.id, name:b.name, status: ALL_SOCKS.find(s=>s.id===b.id)?'Online':'Offline' })); res.json({list, option:VOTE_OPTION, total:BOTS.length, online:ALL_SOCKS.length, active:VOTING_ACTIVE, totalVotes: TOTAL_VOTES}); });
app.post('/api/resetdb', (req,res)=>{ VOTE_HISTORY={}; TOTAL_VOTES=0; saveDB(); res.json({msg:"✅ Database Reset"}) });

io.on('connection', ()=>{});
loadDB();
if(!fs.existsSync('./sessions')) fs.mkdirSync('./sessions');
server.listen(PORT, '0.0.0.0', ()=>console.log(`✅ KoSh Panel Running: http://0.0.0.0:${PORT}`));
