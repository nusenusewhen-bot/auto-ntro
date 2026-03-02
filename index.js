require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, MessageFlags } = require('discord.js');
const axios = require('axios');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const ECPairFactory = require('ecpair');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

const OWNER_ID = '1459833646130401429';
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
const BOT_MNEMONIC = process.env.BOT_MNEMONIC;

// Check if mnemonic is set
if (!BOT_MNEMONIC) {
  console.error('❌ ERROR: BOT_MNEMONIC not set in .env file!');
  process.exit(1);
}

const LITECOIN = { 
  messagePrefix: '\x19Litecoin Signed Message:\n', 
  bech32: 'ltc', 
  bip32: { public: 0x019da462, private: 0x019d9cfe }, 
  pubKeyHash: 0x30, 
  scriptHash: 0x32, 
  wif: 0xb0 
};

const ADDRESSES = [
  { index: 0, address: 'Lc1m5wtQ8g9mJJP9cV1Db3S7DCxuot98CU', inUse: false, ticketChannel: null, type: 'bech32' }
];

let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const processedTxs = new Set();

function getWallet(index, type) {
  try {
    const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
    const root = bip32.fromSeed(seed, LITECOIN);
    const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
    
    if (!child.privateKey) {
      throw new Error('No private key generated');
    }
    
    const pubkey = Buffer.from(child.publicKey);
    let payment;
    if (type === 'bech32') {
      payment = bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
    } else {
      payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
    }
    
    const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
    return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
  } catch (e) {
    console.error(`[WALLET ERROR] ${e.message}`);
    return null;
  }
}

function releaseAddress(channelId) {
  const addr = ADDRESSES[0];
  if (addr.ticketChannel === channelId) {
    addr.inUse = false;
    addr.ticketChannel = null;
    return true;
  }
  return false;
}

async function getAddressData(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function getBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  const mempoolFunded = (data.mempool_stats?.funded_txo_sum || 0);
  const mempoolSpent = (data.mempool_stats?.spent_txo_sum || 0);
  return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  return (funded - spent) / 100000000;
}

async function getUTXOs(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getRawTx(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function broadcastTx(txHex) {
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

async function sendLTC(fromIndex, toAddress, amount = null) {
  try {
    const addrInfo = ADDRESSES[fromIndex];
    const wallet = getWallet(fromIndex, addrInfo.type);
    
    if (!wallet || !wallet.privateKey) {
      return { success: false, error: 'Wallet not initialized - check BOT_MNEMONIC' };
    }
    
    const utxos = await getUTXOs(addrInfo.address);
    if (utxos.length === 0) else {
      payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
    }
    
    const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
    return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
  } catch (e) {
    console.error(`[WALLET ERROR] ${e.message}`);
    return null;
  }
}

function releaseAddress(channelId) {
  const addr = ADDRESSES[0];
  if (addr.ticketChannel === channelId) {
    addr.inUse = false;
    addr.ticketChannel = null;
    return true;
  }
  return false;
}

async function getAddressData(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function getBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  const mempoolFunded = (data.mempool_stats?.funded_txo_sum || 0);
  const mempoolSpent = (data.mempool_stats?.spent_txo_sum || 0);
  return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  return (funded - spent) / 100000000;
}

async function getUTXOs(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getRawTx(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function broadcastTx(txHex) {
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

async function sendLTC(fromIndex, toAddress, amount = null) {
  try {
    const addrInfo = ADDRESSES[fromIndex];
    const wallet = getWallet(fromIndex, addrInfo.type);
    
    if (!wallet || !wallet.privateKey) {
      return { success: false, error: 'Wallet not initialized - check BOT_MNEMONIC' };
    }
    
    const utxos = await getUTXOs(addrInfo.address);
    if (utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let total = 0;
    
    for (let utxo of utxos) {
      if (utxo.status?.spent) continue;
      const raw = await getRawTx(utxo.txid);
      if (!raw) continue;
      
      if (addrInfo.type === 'bech32') {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: Buffer.from(utxo.scriptpubkey, 'hex'),
            value: utxo.value
          }
        });
      } else {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(raw, 'hex')
        });
      }
      total += utxo.value;
    }
    
    if (total === 0) return { success: false, error: 'No valid inputs' };
    
    const fee = 100000;
    let sendAmount = amount === null ? total - fee : Math.floor(amount * 100000000);
    if (sendAmount <= 0) return { success: false, error: 'Amount too small after fee' };
    
    psbt.addOutput({ address: toAddress, value: sendAmount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) { console.log(`[SIGN ERROR] ${e.message}`); }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    return await broadcastTx(txHex);
  } catch (e) {
    console.error(`[SEND ERROR] ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    try {
      const confirmedBal = await getConfirmedBalance(ticket.address);
      const pendingBal = await getBalance(ticket.address);
      
      if (confirmedBal >= ticket.minLtc && confirmedBal <= ticket.maxLtc * 1.5) {
        await processPayment(channelId, confirmedBal);
      }
      
      if (pendingBal > confirmedBal && !ticket.pendingNotified) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`⏳ Pending payment detected! Waiting for confirmation...`);
          ticket.pendingNotified = true;
        }
      }
    } catch (e) {
      console.error(`[CHECK ERROR] ${e.message}`);
    }
  }
}

async function processPayment(channelId, amount, txid = null else {
      payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
    }
    
    const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
    return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
  } catch (e) {
    console.error(`[WALLET ERROR] ${e.message}`);
    return null;
  }
}

function releaseAddress(channelId) {
  const addr = ADDRESSES[0];
  if (addr.ticketChannel === channelId) {
    addr.inUse = false;
    addr.ticketChannel = null;
    return true;
  }
  return false;
}

async function getAddressData(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function getBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  const mempoolFunded = (data.mempool_stats?.funded_txo_sum || 0);
  const mempoolSpent = (data.mempool_stats?.spent_txo_sum || 0);
  return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  return (funded - spent) / 100000000;
}

async function getUTXOs(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getRawTx(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function broadcastTx(txHex) {
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

async function sendLTC(fromIndex, toAddress, amount = null) {
  try {
    const addrInfo = ADDRESSES[fromIndex];
    const wallet = getWallet(fromIndex, addrInfo.type);
    
    if (!wallet || !wallet.privateKey) {
      return { success: false, error: 'Wallet not initialized - check BOT_MNEMONIC' };
    }
    
    const utxos = await getUTXOs(addrInfo.address);
    if (utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let total = 0;
    
    for (let utxo of utxos) {
      if (utxo.status?.spent) continue;
      const raw = await getRawTx(utxo.txid);
      if (!raw) continue;
      
      if (addrInfo.type === 'bech32') {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: Buffer.from(utxo.scriptpubkey, 'hex'),
            value: utxo.value
          }
        });
      } else {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(raw, 'hex')
        });
      }
      total += utxo.value;
    }
    
    if (total === 0) return { success: false, error: 'No valid inputs' };
    
    const fee = 100000;
    let sendAmount = amount === null ? total - fee : Math.floor(amount * 100000000);
    if (sendAmount <= 0) return { success: false, error: 'Amount too small after fee' };
    
    psbt.addOutput({ address: toAddress, value: sendAmount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) { console.log(`[SIGN ERROR] ${e.message}`); }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    return await broadcastTx(txHex);
  } catch (e) {
    console.error(`[SEND ERROR] ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    try {
      const confirmedBal = await getConfirmedBalance(ticket.address);
      const pendingBal = await getBalance(ticket.address);
      
      if (confirmedBal >= ticket.minLtc && confirmedBal <= ticket.maxLtc * 1.5) {
        await processPayment(channelId, confirmedBal);
      }
      
      if (pendingBal > confirmedBal && !ticket.pendingNotified) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`⏳ Pending payment detected! Waiting for confirmation...`);
          ticket.pendingNotified = true;
        }
      }
    } catch (e) {
      console.error(`[CHECK ERROR] ${e.message}`);
    }
  }
}

async function processPayment(channelId, amount, txid = null) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.paid) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    releaseAddress(channelId);
    tickets.delete(channelId);
    return;
  }
  
  ticket.paid = true;
  ticket.status = 'delivered';
  ticket.paidAmount = amount;
  ticket.txid = txid;
  
  await channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Payment Confirmed!').setDescription(`Received: **${amount.toFixed(8)} LTC**`).setColor(0x00FF00)] });
  
  const sendResult = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  if (sendResult.success) {
    await channel.send(`✅ Funds transferred to secure wallet`);
    await deliverProduct(channel, ticket);
  } else {
    await channel.send(`⚠️ Transfer failed: ${sendResult.error}`);
  }
}

async function deliverProduct(channel, ticket) {
  const products = { 'basic_month': 'Nitro Basic Monthly', 'basic_year': 'Nitro Basic Yearly', 'boost_month': 'Nitro Boost Monthly', 'boost_year': 'Nitro Boost Yearly' };
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Order')
    .setDescription(`**${products[ticket.product]}** x${ticket.quantity}\n\n\`\`\`diff\n+ CODE_${Date.now()}\n\`\`\`\nRedeem: https://discord.com/gifts`)
    .setColor(0x5865F2);
  
  await channel.send({ content: `<@${ticket.userId}>`, embeds: [embed] });
  await channel.send('⚠️ Channel closes in 5 minutes. Save your code!');
  
  setTimeout(async () => {
    releaseAddress(channel.id);
    tickets.delete(channel.id);
    await channel.delete().catch(() => {});
  }, 300000);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  // Test wallet generation
  const testWallet = getWallet(0, 'bech32');
  if (!testWallet) {
    console.error('❌ Wallet generation failed! Check BOT_MNEMONIC');
    return;
  }
  console.log(`[WALLET] Address: ${testWallet.address}`);
  
  const bal = await getBalance(ADDRESSES[0].address);
  console.log(`[BALANCE] ${bal.toFixed(8)} LTC`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Display shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales log channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address').addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close this ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance'),
    new SlashCommand else {
      payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
    }
    
    const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
    return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
  } catch (e) {
    console.error(`[WALLET ERROR] ${e.message}`);
    return null;
  }
}

function releaseAddress(channelId) {
  const addr = ADDRESSES[0];
  if (addr.ticketChannel === channelId) {
    addr.inUse = false;
    addr.ticketChannel = null;
    return true;
  }
  return false;
}

async function getAddressData(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function getBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  const mempoolFunded = (data.mempool_stats?.funded_txo_sum || 0);
  const mempoolSpent = (data.mempool_stats?.spent_txo_sum || 0);
  return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  return (funded - spent) / 100000000;
}

async function getUTXOs(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getRawTx(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function broadcastTx(txHex) {
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

async function sendLTC(fromIndex, toAddress, amount = null) {
  try {
    const addrInfo = ADDRESSES[fromIndex];
    const wallet = getWallet(fromIndex, addrInfo.type);
    
    if (!wallet || !wallet.privateKey) {
      return { success: false, error: 'Wallet not initialized - check BOT_MNEMONIC' };
    }
    
    const utxos = await getUTXOs(addrInfo.address);
    if (utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let total = 0;
    
    for (let utxo of utxos) {
      if (utxo.status?.spent) continue;
      const raw = await getRawTx(utxo.txid);
      if (!raw) continue;
      
      if (addrInfo.type === 'bech32') {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: Buffer.from(utxo.scriptpubkey, 'hex'),
            value: utxo.value
          }
        });
      } else {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(raw, 'hex')
        });
      }
      total += utxo.value;
    }
    
    if (total === 0) return { success: false, error: 'No valid inputs' };
    
    const fee = 100000;
    let sendAmount = amount === null ? total - fee : Math.floor(amount * 100000000);
    if (sendAmount <= 0) return { success: false, error: 'Amount too small after fee' };
    
    psbt.addOutput({ address: toAddress, value: sendAmount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) { console.log(`[SIGN ERROR] ${e.message}`); }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    return await broadcastTx(txHex);
  } catch (e) {
    console.error(`[SEND ERROR] ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    try {
      const confirmedBal = await getConfirmedBalance(ticket.address);
      const pendingBal = await getBalance(ticket.address);
      
      if (confirmedBal >= ticket.minLtc && confirmedBal <= ticket.maxLtc * 1.5) {
        await processPayment(channelId, confirmedBal);
      }
      
      if (pendingBal > confirmedBal && !ticket.pendingNotified) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`⏳ Pending payment detected! Waiting for confirmation...`);
          ticket.pendingNotified = true;
        }
      }
    } catch (e) {
      console.error(`[CHECK ERROR] ${e.message}`);
    }
  }
}

async function processPayment(channelId, amount, txid = null) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.paid) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    releaseAddress(channelId);
    tickets.delete(channelId);
    return;
  }
  
  ticket.paid = true;
  ticket.status = 'delivered';
  ticket.paidAmount = amount;
  ticket.txid = txid;
  
  await channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Payment Confirmed!').setDescription(`Received: **${amount.toFixed(8)} LTC**`).setColor(0x00FF00)] });
  
  const sendResult = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  if (sendResult.success) {
    await channel.send(`✅ Funds transferred to secure wallet`);
    await deliverProduct(channel, ticket);
  } else {
    await channel.send(`⚠️ Transfer failed: ${sendResult.error}`);
  }
}

async function deliverProduct(channel, ticket) {
  const products = { 'basic_month': 'Nitro Basic Monthly', 'basic_year': 'Nitro Basic Yearly', 'boost_month': 'Nitro Boost Monthly', 'boost_year': 'Nitro Boost Yearly' };
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Order')
    .setDescription(`**${products[ticket.product]}** x${ticket.quantity}\n\n\`\`\`diff\n+ CODE_${Date.now()}\n\`\`\`\nRedeem: https://discord.com/gifts`)
    .setColor(0x5865F2);
  
  await channel.send({ content: `<@${ticket.userId}>`, embeds: [embed] });
  await channel.send('⚠️ Channel closes in 5 minutes. Save your code!');
  
  setTimeout(async () => {
    releaseAddress(channel.id);
    tickets.delete(channel.id);
    await channel.delete().catch(() => {});
  }, 300000);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  // Test wallet generation
  const testWallet = getWallet(0, 'bech32');
  if (!testWallet) {
    console.error('❌ Wallet generation failed! Check BOT_MNEMONIC');
    return;
  }
  console.log(`[WALLET] Address: ${testWallet.address}`);
  
  const bal = await getBalance(ADDRESSES[0].address);
  console.log(`[BALANCE] ${bal.toFixed(8)} LTC`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Display shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales log channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address').addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close this ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance'),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('status').setDescription('Show bot status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(checkPayments, 10000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const isOwner = interaction.user.id === OWNER_ID;
      
      if (interaction.commandName === 'panel') {
        if (!settings.ticketCategory) return interaction.reply({ content: '❌ Setup required: /ticketcategory', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle('🛒 Nitro Shop').setDescription('💎 Nitro Basic - $1/mo or $7/yr\n🔥 Nitro Boost - $2.80/mo or $14/yr').setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛍️ Purchase').setStyle(ButtonStyle.Success));
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      
      else if (interaction.commandName === 'status') {
        let text = '📊 **Status**\n\n';
        for (let addr of ADDRESSES) {
          const bal = await getBalance(addr.address);
          text += `[${addr.index}] ${bal.toFixed(8)} LTC ${addr.inUse ? '(In Use)' : '(Free)'}\n`;
        }
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'balance') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ADDRESSES[0].address);
        await interaction.reply({ content: `💰 Wallet 0: ${bal.toFixed(8)} LTC`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'send') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const to = interaction.options.getString('address');
        const result = await sendLTC(0, to);
        await interaction.editReply({ content: result.success ? `✅ Sent! TX: ${result.txid}` : `❌ Failed: ${result.error}` });
      }
      
      else if (interaction.commandName === 'close') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket', flags: MessageFlags.Ephemeral });
        if (ticket.userId !== interaction.user.id && !isOwner) return interaction.reply({ content: '❌ No permission', flags: MessageFlags.Ephemeral });
        await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
        releaseAddress(interaction.channel.id);
        tickets.delete(interaction.channel.id);
        setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
      }
      
      else if (interaction.commandName === 'check') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ No ticket here', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ticket.address);
        await interaction.reply({ content: `Required: ${ticket.amountLtc} LTC\nCurrent: ${bal.toFixed(8)} LTC\nStatus: ${ticket.paid ? '✅ Paid' : '⏳ Waiting'}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (['ticketcategory', 'staffroleid', 'transcriptchannel', 'salechannel'].includes(interaction.commandName)) {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : interaction.commandName === 'staffroleid' ? 'staffRole' : interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
        settings[key] = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Set ${interaction.commandName}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    if (interaction.isButton() && interaction.customId === 'open_ticket') {
      if (!settings.ticketCategory) return interaction.reply({ content: '❌ Bot not setup', flags: MessageFlags.Ephemeral });
      
      for (let [chId, t] of tickets) {
        if (t.userId === interaction.user.id && !t.paid) {
          const ch = interaction.guild else {
      payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
    }
    
    const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
    return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
  } catch (e) {
    console.error(`[WALLET ERROR] ${e.message}`);
    return null;
  }
}

function releaseAddress(channelId) {
  const addr = ADDRESSES[0];
  if (addr.ticketChannel === channelId) {
    addr.inUse = false;
    addr.ticketChannel = null;
    return true;
  }
  return false;
}

async function getAddressData(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function getBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  const mempoolFunded = (data.mempool_stats?.funded_txo_sum || 0);
  const mempoolSpent = (data.mempool_stats?.spent_txo_sum || 0);
  return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  return (funded - spent) / 100000000;
}

async function getUTXOs(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getRawTx(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function broadcastTx(txHex) {
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

async function sendLTC(fromIndex, toAddress, amount = null) {
  try {
    const addrInfo = ADDRESSES[fromIndex];
    const wallet = getWallet(fromIndex, addrInfo.type);
    
    if (!wallet || !wallet.privateKey) {
      return { success: false, error: 'Wallet not initialized - check BOT_MNEMONIC' };
    }
    
    const utxos = await getUTXOs(addrInfo.address);
    if (utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let total = 0;
    
    for (let utxo of utxos) {
      if (utxo.status?.spent) continue;
      const raw = await getRawTx(utxo.txid);
      if (!raw) continue;
      
      if (addrInfo.type === 'bech32') {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: Buffer.from(utxo.scriptpubkey, 'hex'),
            value: utxo.value
          }
        });
      } else {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(raw, 'hex')
        });
      }
      total += utxo.value;
    }
    
    if (total === 0) return { success: false, error: 'No valid inputs' };
    
    const fee = 100000;
    let sendAmount = amount === null ? total - fee : Math.floor(amount * 100000000);
    if (sendAmount <= 0) return { success: false, error: 'Amount too small after fee' };
    
    psbt.addOutput({ address: toAddress, value: sendAmount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) { console.log(`[SIGN ERROR] ${e.message}`); }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    return await broadcastTx(txHex);
  } catch (e) {
    console.error(`[SEND ERROR] ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    try {
      const confirmedBal = await getConfirmedBalance(ticket.address);
      const pendingBal = await getBalance(ticket.address);
      
      if (confirmedBal >= ticket.minLtc && confirmedBal <= ticket.maxLtc * 1.5) {
        await processPayment(channelId, confirmedBal);
      }
      
      if (pendingBal > confirmedBal && !ticket.pendingNotified) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`⏳ Pending payment detected! Waiting for confirmation...`);
          ticket.pendingNotified = true;
        }
      }
    } catch (e) {
      console.error(`[CHECK ERROR] ${e.message}`);
    }
  }
}

async function processPayment(channelId, amount, txid = null) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.paid) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    releaseAddress(channelId);
    tickets.delete(channelId);
    return;
  }
  
  ticket.paid = true;
  ticket.status = 'delivered';
  ticket.paidAmount = amount;
  ticket.txid = txid;
  
  await channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Payment Confirmed!').setDescription(`Received: **${amount.toFixed(8)} LTC**`).setColor(0x00FF00)] });
  
  const sendResult = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  if (sendResult.success) {
    await channel.send(`✅ Funds transferred to secure wallet`);
    await deliverProduct(channel, ticket);
  } else {
    await channel.send(`⚠️ Transfer failed: ${sendResult.error}`);
  }
}

async function deliverProduct(channel, ticket) {
  const products = { 'basic_month': 'Nitro Basic Monthly', 'basic_year': 'Nitro Basic Yearly', 'boost_month': 'Nitro Boost Monthly', 'boost_year': 'Nitro Boost Yearly' };
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Order')
    .setDescription(`**${products[ticket.product]}** x${ticket.quantity}\n\n\`\`\`diff\n+ CODE_${Date.now()}\n\`\`\`\nRedeem: https://discord.com/gifts`)
    .setColor(0x5865F2);
  
  await channel.send({ content: `<@${ticket.userId}>`, embeds: [embed] });
  await channel.send('⚠️ Channel closes in 5 minutes. Save your code!');
  
  setTimeout(async () => {
    releaseAddress(channel.id);
    tickets.delete(channel.id);
    await channel.delete().catch(() => {});
  }, 300000);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  // Test wallet generation
  const testWallet = getWallet(0, 'bech32');
  if (!testWallet) {
    console.error('❌ Wallet generation failed! Check BOT_MNEMONIC');
    return;
  }
  console.log(`[WALLET] Address: ${testWallet.address}`);
  
  const bal = await getBalance(ADDRESSES[0].address);
  console.log(`[BALANCE] ${bal.toFixed(8)} LTC`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Display shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales log channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address').addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close this ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance'),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('status').setDescription('Show bot status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(checkPayments, 10000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const isOwner = interaction.user.id === OWNER_ID;
      
      if (interaction.commandName === 'panel') {
        if (!settings.ticketCategory) return interaction.reply({ content: '❌ Setup required: /ticketcategory', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle('🛒 Nitro Shop').setDescription('💎 Nitro Basic - $1/mo or $7/yr\n🔥 Nitro Boost - $2.80/mo or $14/yr').setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛍️ Purchase').setStyle(ButtonStyle.Success));
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      
      else if (interaction.commandName === 'status') {
        let text = '📊 **Status**\n\n';
        for (let addr of ADDRESSES) {
          const bal = await getBalance(addr.address);
          text += `[${addr.index}] ${bal.toFixed(8)} LTC ${addr.inUse ? '(In Use)' : '(Free)'}\n`;
        }
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'balance') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ADDRESSES[0].address);
        await interaction.reply({ content: `💰 Wallet 0: ${bal.toFixed(8)} LTC`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'send') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const to = interaction.options.getString('address');
        const result = await sendLTC(0, to);
        await interaction.editReply({ content: result.success ? `✅ Sent! TX: ${result.txid}` : `❌ Failed: ${result.error}` });
      }
      
      else if (interaction.commandName === 'close') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket', flags: MessageFlags.Ephemeral });
        if (ticket.userId !== interaction.user.id && !isOwner) return interaction.reply({ content: '❌ No permission', flags: MessageFlags.Ephemeral });
        await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
        releaseAddress(interaction.channel.id);
        tickets.delete(interaction.channel.id);
        setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
      }
      
      else if (interaction.commandName === 'check') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ No ticket here', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ticket.address);
        await interaction.reply({ content: `Required: ${ticket.amountLtc} LTC\nCurrent: ${bal.toFixed(8)} LTC\nStatus: ${ticket.paid ? '✅ Paid' : '⏳ Waiting'}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (['ticketcategory', 'staffroleid', 'transcriptchannel', 'salechannel'].includes(interaction.commandName)) {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : interaction.commandName === 'staffroleid' ? 'staffRole' : interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
        settings[key] = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Set ${interaction.commandName}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    if (interaction.isButton() && interaction.customId === 'open_ticket') {
      if (!settings.ticketCategory) return interaction.reply({ content: '❌ Bot not setup', flags: MessageFlags.Ephemeral });
      
      for (let [chId, t] of tickets) {
        if (t.userId === interaction.user.id && !t.paid) {
          const ch = interaction.guild.channels.cache.get(chId);
          if (ch) return interaction.reply({ content: `❌ You have ${ch}`, flags: MessageFlags.Ephemeral });
        }
      }
      
      const addr = ADDRESSES[0];
      if (addr.inUse) return interaction.reply({ content: '❌ All busy, try again later', flags: MessageFlags.Ephemeral });
      
      addr.inUse = true;
      const channel = await interaction.guild.channels.create({
        name: `nitro-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: settings.ticketCategory,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          ...(settings.staffRole ? [{ id: settings.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : [])
        ]
      });
      
      addr.ticketChannel = channel.id;
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_product')
          .setPlaceholder('Select product...')
          .addOptions(
            { label: 'Nitro Basic Monthly - $1.00', value: 'basic_month', emoji: '💎' },
            { label: 'Nitro Basic Yearly - $7.00', value: 'basic_year', emoji: '💎' },
            { label: 'Nitro Boost Monthly - $2.80', value: 'boost_month', emoji: '🔥' },
            { label: 'Nitro Boost Yearly - $14.00', value: 'boost_year', emoji: '🔥' }
          )
      );
      
      const embed = new EmbedBuilder().setTitle('🛒 Select Product').setDescription(`Welcome! Select below.\n\nPayment Address:\n\`${addr.address}\``).setColor(0x5865F2);
      await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });
      
      tickets.set(channel.id, {
        userId: interaction.user.id,
        status: 'selecting',
        walletIndex: 0,
        address: addr.address,
        product: null,
        price: null,
        quantity: 1,
        amountLtc: null,
        minLtc: null,
        maxLtc: null,
        paid: false,
        pendingNotified: false
      });
      
      await interaction.reply({ content: `✅ Ticket: ${channel}`, flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_product') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket || ticket.userId !== interaction.user.id) return interaction.reply({ content: '❌ Not your ticket', flags: MessageFlags.Ephemeral });
      
      const prices = { basic_month: 1, basic_year: 7, boost_month: 2.8, boost_year: 14 };
      ticket.product = interaction.values[0];
      ticket.price = prices[ticket.product];
      
      const modal = new ModalBuilder().setCustomId('qty_modal').setTitle(' else {
      payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
    }
    
    const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
    return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
  } catch (e) {
    console.error(`[WALLET ERROR] ${e.message}`);
    return null;
  }
}

function releaseAddress(channelId) {
  const addr = ADDRESSES[0];
  if (addr.ticketChannel === channelId) {
    addr.inUse = false;
    addr.ticketChannel = null;
    return true;
  }
  return false;
}

async function getAddressData(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function getBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  const mempoolFunded = (data.mempool_stats?.funded_txo_sum || 0);
  const mempoolSpent = (data.mempool_stats?.spent_txo_sum || 0);
  return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  return (funded - spent) / 100000000;
}

async function getUTXOs(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function getRawTx(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (e) {
    return null;
  }
}

async function broadcastTx(txHex) {
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

async function sendLTC(fromIndex, toAddress, amount = null) {
  try {
    const addrInfo = ADDRESSES[fromIndex];
    const wallet = getWallet(fromIndex, addrInfo.type);
    
    if (!wallet || !wallet.privateKey) {
      return { success: false, error: 'Wallet not initialized - check BOT_MNEMONIC' };
    }
    
    const utxos = await getUTXOs(addrInfo.address);
    if (utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let total = 0;
    
    for (let utxo of utxos) {
      if (utxo.status?.spent) continue;
      const raw = await getRawTx(utxo.txid);
      if (!raw) continue;
      
      if (addrInfo.type === 'bech32') {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          witnessUtxo: {
            script: Buffer.from(utxo.scriptpubkey, 'hex'),
            value: utxo.value
          }
        });
      } else {
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(raw, 'hex')
        });
      }
      total += utxo.value;
    }
    
    if (total === 0) return { success: false, error: 'No valid inputs' };
    
    const fee = 100000;
    let sendAmount = amount === null ? total - fee : Math.floor(amount * 100000000);
    if (sendAmount <= 0) return { success: false, error: 'Amount too small after fee' };
    
    psbt.addOutput({ address: toAddress, value: sendAmount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) { console.log(`[SIGN ERROR] ${e.message}`); }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    return await broadcastTx(txHex);
  } catch (e) {
    console.error(`[SEND ERROR] ${e.message}`);
    return { success: false, error: e.message };
  }
}

async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    try {
      const confirmedBal = await getConfirmedBalance(ticket.address);
      const pendingBal = await getBalance(ticket.address);
      
      if (confirmedBal >= ticket.minLtc && confirmedBal <= ticket.maxLtc * 1.5) {
        await processPayment(channelId, confirmedBal);
      }
      
      if (pendingBal > confirmedBal && !ticket.pendingNotified) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`⏳ Pending payment detected! Waiting for confirmation...`);
          ticket.pendingNotified = true;
        }
      }
    } catch (e) {
      console.error(`[CHECK ERROR] ${e.message}`);
    }
  }
}

async function processPayment(channelId, amount, txid = null) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.paid) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    releaseAddress(channelId);
    tickets.delete(channelId);
    return;
  }
  
  ticket.paid = true;
  ticket.status = 'delivered';
  ticket.paidAmount = amount;
  ticket.txid = txid;
  
  await channel.send({ embeds: [new EmbedBuilder().setTitle('✅ Payment Confirmed!').setDescription(`Received: **${amount.toFixed(8)} LTC**`).setColor(0x00FF00)] });
  
  const sendResult = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  if (sendResult.success) {
    await channel.send(`✅ Funds transferred to secure wallet`);
    await deliverProduct(channel, ticket);
  } else {
    await channel.send(`⚠️ Transfer failed: ${sendResult.error}`);
  }
}

async function deliverProduct(channel, ticket) {
  const products = { 'basic_month': 'Nitro Basic Monthly', 'basic_year': 'Nitro Basic Yearly', 'boost_month': 'Nitro Boost Monthly', 'boost_year': 'Nitro Boost Yearly' };
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Order')
    .setDescription(`**${products[ticket.product]}** x${ticket.quantity}\n\n\`\`\`diff\n+ CODE_${Date.now()}\n\`\`\`\nRedeem: https://discord.com/gifts`)
    .setColor(0x5865F2);
  
  await channel.send({ content: `<@${ticket.userId}>`, embeds: [embed] });
  await channel.send('⚠️ Channel closes in 5 minutes. Save your code!');
  
  setTimeout(async () => {
    releaseAddress(channel.id);
    tickets.delete(channel.id);
    await channel.delete().catch(() => {});
  }, 300000);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  // Test wallet generation
  const testWallet = getWallet(0, 'bech32');
  if (!testWallet) {
    console.error('❌ Wallet generation failed! Check BOT_MNEMONIC');
    return;
  }
  console.log(`[WALLET] Address: ${testWallet.address}`);
  
  const bal = await getBalance(ADDRESSES[0].address);
  console.log(`[BALANCE] ${bal.toFixed(8)} LTC`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Display shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales log channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address').addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close this ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance'),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('status').setDescription('Show bot status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(checkPayments, 10000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const isOwner = interaction.user.id === OWNER_ID;
      
      if (interaction.commandName === 'panel') {
        if (!settings.ticketCategory) return interaction.reply({ content: '❌ Setup required: /ticketcategory', flags: MessageFlags.Ephemeral });
        const embed = new EmbedBuilder().setTitle('🛒 Nitro Shop').setDescription('💎 Nitro Basic - $1/mo or $7/yr\n🔥 Nitro Boost - $2.80/mo or $14/yr').setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛍️ Purchase').setStyle(ButtonStyle.Success));
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      
      else if (interaction.commandName === 'status') {
        let text = '📊 **Status**\n\n';
        for (let addr of ADDRESSES) {
          const bal = await getBalance(addr.address);
          text += `[${addr.index}] ${bal.toFixed(8)} LTC ${addr.inUse ? '(In Use)' : '(Free)'}\n`;
        }
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'balance') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ADDRESSES[0].address);
        await interaction.reply({ content: `💰 Wallet 0: ${bal.toFixed(8)} LTC`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'send') {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const to = interaction.options.getString('address');
        const result = await sendLTC(0, to);
        await interaction.editReply({ content: result.success ? `✅ Sent! TX: ${result.txid}` : `❌ Failed: ${result.error}` });
      }
      
      else if (interaction.commandName === 'close') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ Not a ticket', flags: MessageFlags.Ephemeral });
        if (ticket.userId !== interaction.user.id && !isOwner) return interaction.reply({ content: '❌ No permission', flags: MessageFlags.Ephemeral });
        await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
        releaseAddress(interaction.channel.id);
        tickets.delete(interaction.channel.id);
        setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
      }
      
      else if (interaction.commandName === 'check') {
        const ticket = tickets.get(interaction.channel.id);
        if (!ticket) return interaction.reply({ content: '❌ No ticket here', flags: MessageFlags.Ephemeral });
        const bal = await getBalance(ticket.address);
        await interaction.reply({ content: `Required: ${ticket.amountLtc} LTC\nCurrent: ${bal.toFixed(8)} LTC\nStatus: ${ticket.paid ? '✅ Paid' : '⏳ Waiting'}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (['ticketcategory', 'staffroleid', 'transcriptchannel', 'salechannel'].includes(interaction.commandName)) {
        if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
        const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : interaction.commandName === 'staffroleid' ? 'staffRole' : interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
        settings[key] = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Set ${interaction.commandName}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    if (interaction.isButton() && interaction.customId === 'open_ticket') {
      if (!settings.ticketCategory) return interaction.reply({ content: '❌ Bot not setup', flags: MessageFlags.Ephemeral });
      
      for (let [chId, t] of tickets) {
        if (t.userId === interaction.user.id && !t.paid) {
          const ch = interaction.guild.channels.cache.get(chId);
          if (ch) return interaction.reply({ content: `❌ You have ${ch}`, flags: MessageFlags.Ephemeral });
        }
      }
      
      const addr = ADDRESSES[0];
      if (addr.inUse) return interaction.reply({ content: '❌ All busy, try again later', flags: MessageFlags.Ephemeral });
      
      addr.inUse = true;
      const channel = await interaction.guild.channels.create({
        name: `nitro-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: settings.ticketCategory,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          ...(settings.staffRole ? [{ id: settings.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : [])
        ]
      });
      
      addr.ticketChannel = channel.id;
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_product')
          .setPlaceholder('Select product...')
          .addOptions(
            { label: 'Nitro Basic Monthly - $1.00', value: 'basic_month', emoji: '💎' },
            { label: 'Nitro Basic Yearly - $7.00', value: 'basic_year', emoji: '💎' },
            { label: 'Nitro Boost Monthly - $2.80', value: 'boost_month', emoji: '🔥' },
            { label: 'Nitro Boost Yearly - $14.00', value: 'boost_year', emoji: '🔥' }
          )
      );
      
      const embed = new EmbedBuilder().setTitle('🛒 Select Product').setDescription(`Welcome! Select below.\n\nPayment Address:\n\`${addr.address}\``).setColor(0x5865F2);
      await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });
      
      tickets.set(channel.id, {
        userId: interaction.user.id,
        status: 'selecting',
        walletIndex: 0,
        address: addr.address,
        product: null,
        price: null,
        quantity: 1,
        amountLtc: null,
        minLtc: null,
        maxLtc: null,
        paid: false,
        pendingNotified: false
      });
      
      await interaction.reply({ content: `✅ Ticket: ${channel}`, flags: MessageFlags.Ephemeral });
    }
    
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_product') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket || ticket.userId !== interaction.user.id) return interaction.reply({ content: '❌ Not your ticket', flags: MessageFlags.Ephemeral });
      
      const prices = { basic_month: 1, basic_year: 7, boost_month: 2.8, boost_year: 14 };
      ticket.product = interaction.values[0];
      ticket.price = prices[ticket.product];
      
      const modal = new ModalBuilder().setCustomId('qty_modal').setTitle('Quantity').addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('qty').setLabel('How many?').setStyle(TextInputStyle.Short).setValue('1').setRequired(true))
      );
      await interaction.showModal(modal);
    }
    
    if (interaction.isModalSubmit() && interaction.customId === 'qty_modal') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket) return;
      
      const qty = parseInt(interaction.fields.getTextInputValue('qty')) || 1;
      if (qty < 1 || qty > 100) return interaction.reply({ content: '❌ Invalid qty', flags: MessageFlags.Ephemeral });
      
      const totalUsd = ticket.price * qty;
      const totalLtc = (totalUsd / 75);
      const tolerance = totalLtc * 0.5;
      
      ticket.quantity = qty;
      ticket.amountLtc = totalLtc;
      ticket.minLtc = totalLtc - tolerance;
      ticket.maxLtc = totalLtc + tolerance;
      ticket.status = 'awaiting_payment';
      
      const embed = new EmbedBuilder()
        .setTitle('💳 Payment Required')
        .setDescription(`Order: ${ticket.product}\nQty: ${qty}\nTotal: $${totalUsd.toFixed(2)}\n\nSend: \`${totalLtc.toFixed(8)} LTC\`\nTo: \`${ticket.address}\`\n\nMin: ${ticket.minLtc.toFixed(8)} | Max: ${ticket.maxLtc.toFixed(8)}`)
        .setColor(0xFFD700);
      
      await interaction.reply({ embeds: [embed] });
    }
  } catch (e) {
    console.error(`[INTERACTION ERROR] ${e.message}`);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '❌ An error occurred', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
