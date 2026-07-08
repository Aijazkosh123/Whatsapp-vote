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

// Bot Add
app.post('/api/addsession', async (req,res)=>{
    const {id, name} = req.body;
    if(!id) return res.json({msg:"Bot ID chahiye"});
    
    const sessionPath = `./sessions/${id}`;
    if(!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, {recursive: true});
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({level: "silent"}),
        browser: Browsers.macOS('Desktop')
    });
    
    sessions[id] = { sock, name };
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', (update)=>{
        if(update.qr){
            console.log("QR for", id, update.qr);
        }
        if(update.connection === 'open'){
            console.log(`✅ Bot ${id} Connected`);
        }
    });
    
    res.json({msg:`Bot ${id} Add ho gaya. QR ke liye /api/qr use karo`});
});

// QR Get
app.post('/api/qr', async (req,res)=>{
    const {id} = req.body;
    if(!sessions[id]) return res.json({msg:"Pehle bot add karo"});
    res.json({msg:`Termux me QR aa raha hai. Waha se scan karo`});
});

// Vote
app.post('/api/vote', async (req,res)=>{
    const {link} = req.body;
    if(!link) return res.json({msg:"Group link do"});
    
    const groupId = link.split('/')[3];
    for(let id in sessions){
        try{
            await sessions[id].sock.groupJoin(groupId);
            await sessions[id].sock.sendMessage(groupId+'@g.us', {text: `Vote from ${sessions[id].name}`});
        }catch(e){}
    }
    res.json({msg:"Vote bhej diya ✅"});
});

app.listen(PORT, ()=>console.log(`✅ Panel Running: http://localhost:${PORT}`));
