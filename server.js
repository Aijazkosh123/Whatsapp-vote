const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = 3000;
const sessions = {};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. Bot Add
app.post('/api/addsession', async (req,res)=>{
    const {id, name} = req.body;
    if(!id) return res.json({msg:"Bot ID chahiye"});
    if(sessions[id]) return res.json({msg:"Bot already running"});

    const sessionPath = `./sessions/${id}`;
    if(!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, {recursive: true});

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({
        auth: state,
        logger: pino({level: "silent"}),
        browser: Browsers.macOS('Desktop')
    });

    sessions[id] = { sock, name, qr: null };
    sock.ev.on('creds.update', saveCreds);

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
