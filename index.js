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
const TOLERANCE_PERCENT = 0.50;

const LITECOIN = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

const ADDRESSES = [
  { index: 0, address: 'Lc1m5wtQ8g9mJJP9cV1Db3S7DCxuot98CU', inUse: false, ticketChannel: null, type: 'bech32' },
  { index: 1, address: 'LPtT2PJ9V2h2cJR6qAz8RSAVKpSHoLodQg', inUse: false, ticketChannel: null, type: 'legacy' },
  { index: 2, address: null, inUse: false, ticketChannel: null, type: 'legacy' }
];

let ltcPrice = 75;
let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const usedStock = new Set();

const PRODUCTS = {
  nitro_basic_month: { name: 'Nitro Basic Monthly', price: 1.0, stock: ['link1','link2','link3','link4','link5'] },
  nitro_basic_year: { name: 'Nitro Basic Yearly', price: 7.0, stock: ['link1','link2','link3'] },
  nitro_boost_month: { name: 'Nitro Boost Monthly', price: 2.8, stock: ['link1','link2','link3','link4'] },
  nitro_boost_year: { name: 'Nitro Boost Yearly', price: 14.0, stock: ['link1','link2'] },
  members_offline: { name: 'Members (Offline)', price: 0.7, unit: 1000, type: 'calculated' },
  members_online: { name: 'Members (Online)', price: 1.5, unit: 1000, type: 'calculated' }
};

function getLitecoinAddress(index, addressType) {
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  const pubkey = Buffer.from(child.publicKey);
  let payment;
  if (addressType === 'bech32') {
    payment = bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
  } else {
    payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
  }
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  return { address: payment.address, privateKey: keyPair.toWIF(), index: index, type: addressType };
}

const wallet2 = getLitecoinAddress(2, 'p2pkh');
ADDRESSES[2].address = wallet2.address;

function getAvailableAddress() {
  for (let addr of ADDRESSES) {
    if (!addr.inUse) return addr;
  }
  return null;
}

function releaseAddress(channelId) {
  for (let addr of ADDRESSES) {
    if (addr.ticketChannel === channelId) {
      addr.inUse = false;
      addr.ticketChannel = null;
      return true;
    }
  }
  return false;
}

async function checkLitecoinspaceBalance(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    console.log(`[LTCSPACE] Checking: ${address}`);
    const { data } = await axios.get(url, { timeout: 15000 });
    
    if (data) {
      const funded = data.chain_stats?.funded_txo_sum || 0;
      const spent = data.chain_stats?.spent_txo_sum || 0;
      const confirmed = (funded - spent) / 100000000;
      const mempoolFunded = data.mempool_stats?.funded_txo_sum || 0;
      const mempoolSpent = data.mempool_stats?.spent_txo_sum || 0;
      const unconfirmed = (mempoolFunded - mempoolSpent) / 100000000;
      const total = confirmed + unconfirmed;
      console.log(`[LTCSPACE] ${address}: ${total.toFixed(8)} LTC`);
      return { success: true, confirmed, unconfirmed, total, source: 'ltcspace' };
    }
    return { success: false, error: 'No data' };
  } catch (error) {
    console.log(`[LTCSPACE ERROR] ${address}: ${error.response?.status || error.message}`);
    return { success: false, error: error.message };
  }
}

async function getLitecoinspaceUTXOs(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(data)) {
      return data.map(u => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        script: u.scriptpubkey
      }));
    }
    return [];
  } catch (error) {
    console.log(`[UTXO ERROR] ${error.message}`);
    return [];
  }
}

async function getRawTransaction(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (error) {
    console.log(`[RAW TX ERROR] ${txid}: ${error.message}`);
    return null;
  }
}

async function checkAddressBalance(address) {
  return await checkLitecoinspaceBalance(address);
}

async function getAddressState(addressIndex) {
  const addrInfo = ADDRESSES.find(a => a.index === addressIndex);
  if (!addrInfo) return { confirmed: 0, unconfirmed: 0, total: 0, utxos: [], address: null };
  const state = await checkAddressBalance(addrInfo.address);
  const wallet = getLitecoinAddress(addressIndex, addrInfo.type);
  let utxos = [];
  if (state.total > 0) {
    utxos = await getLitecoinspaceUTXOs(addrInfo.address);
  }
  return {
    confirmed: state.confirmed || 0,
    unconfirmed: state.unconfirmed || 0,
    total: state.total || 0,
    utxos: utxos,
    address: addrInfo.address,
    privateKey: wallet.privateKey,
    addressIndex: addressIndex,
    type: addrInfo.type,
    source: state.source
  };
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const state = await getAddressState(fromIndex);
    console.log(`[SEND] Index ${fromIndex}: ${state.total.toFixed(8)} LTC, ${state.utxos.length} UTXOs`);
    
    if (state.total <= 0.0001) {
      return { success: false, error: `No balance on index ${fromIndex}` };
    }
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs available' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        const rawHex = await getRawTransaction(utxo.txid);
        if (!rawHex) continue;
        const rawTx = Buffer.from(rawHex, 'hex');
        
        if (state.type === 'bech32' || (utxo.script && utxo.script.startsWith('0014'))) {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: Buffer.from(utxo.script, 'hex'),
              value: utxo.value
            }
          });
        } else {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: rawTx
          });
        }
        totalInput += utxo.value;
        console.log(`[SEND] Added input: ${utxo.txid.slice(0,16)}...`);
      } catch (e) {
        console.log(`[SEND] Failed to add input: ${e.message}`);
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'Could not add any inputs' };
    }
    
    const fee = 100000;
    const amount = totalInput - fee;
    if (amount <= 0) {
      return { success: false, error: 'Balance too small for fee' };
    }
    
    console.log(`[SEND] Total: ${totalInput}, Fee: ${fee}, Sending: ${amount}`);
    psbt.addOutput({ address: toAddress, value: amount });
    
    const keyPair = ECPair.fromWIF(state.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
        console.log(`[SEND] Signed input ${i}`);
      } catch (e) {
        console.log(`[SEND] Sign error ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    try {
      const broadcast = await axios.post('https://litecoinspace.org/api/tx', txHex, {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 15000
      });
      
      const txid = broadcast.data;
      if (txid && txid.length === 64) {
        console.log(`[SEND] Broadcasted: ${txid}`);
        return {
          success: true,
          txid: txid,
          amount: amount / 100000000,
          fee: fee / 100000000,
          fromAddress: state.address
        };
      }
    } catch (broadcastError) {
      console.log(`[BROADCAST ERROR] ${broadcastError.response?.data || broadcastError.message}`);
      return { success: false, error: `Broadcast failed: ${broadcastError.response?.data || broadcastError.message}` };
    }
    
    return { success: false, error: 'Broadcast returned invalid txid' };
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot: ${client.user.tag}`);
  console.log('[INIT] Checking 3 addresses...');
  
  for (let addr of ADDRESSES) {
    const state = await checkAddressBalance(addr.address);
    console.log(`  [${addr.index}] ${addr.address}`);
    console.log(`       Balance: ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`);
  }
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View settings'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check balance').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-2').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid'),
    new SlashCommandBuilder().setName('status').setDescription('Show address status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(monitorMempool, 5000);
  console.log('[SYSTEM] Payment monitoring started');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const isOwner = interaction.user.id === OWNER_ID;
  const isStaff = settings.staffRole && interaction.member?.roles?.cache?.has(settings.staffRole);
  
  if (!isOwner && !['close'].includes(interaction.commandName)) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder().setTitle('🏪 Hello welcome to Nitro Shop').setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken').setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛒 Purchase Nitro').setStyle(ButtonStyle.Success));
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  else if (interaction.commandName === 'status') {
    let text = '**3-Address Status:**\n\n';
    for (let addr of ADDRESSES) {
      const state = await checkAddressBalance(addr.address);
      text += `**[${addr.index}]** \`${addr.address}\`\n`;
      text += `Balance: **${state.total.toFixed(8)} LTC** ($${(state.total * ltcPrice).toFixed(2)})\n`;
      text += `${addr.inUse ? '🔴 In Use' : '🟢 Available'}\n\n`;
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 2) return interaction.reply({ content: '❌ Index 0-2 only', flags: MessageFlags.Ephemeral });
    const state = await getAddressState(idx);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`**Address:** \`${state.address}\`\n**Total:** ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`)
        .setColor(state.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const state = await getAddressState(ticket.walletIndex);
    
    let text = `**Payment Check [${ticket.walletIndex}]**\n`;
    text += `Detected: **${state.total.toFixed(8)} LTC**\n`;
    text += `Need: ${ticket.minLtc?.toFixed(8)} - ${ticket.maxLtc?.toFixed(8)} LTC\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED!**`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else {
      text += `❌ No payment in range`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await processPayment(interaction.channel.id, ticket.amountLtc || 0.01);
  }
  else if (interaction.commandName === 'close') {
    releaseAddress(interaction.channel.id);
    tickets.delete(interaction.channel.id);
    await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
    await interaction.channel.delete();
  }
  else if (['ticketcategory','staffroleid','transcriptchannel','salechannel'].includes(interaction.commandName)) {
    const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : 
                interaction.commandName === 'staffroleid' ? 'staffRole' :
                interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
    settings[key] = interaction.options.getString('id');
    await interaction.reply({ content: '✅ Set', flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    let results = [];
    for (let i = 0; i <= 2; i++) {
      const result = await sendAllLTC(i, address);
      results.push(result.success ? `✅ Index ${i}: Sent ${result.amount.toFixed(8)} LTC` : `❌ Index ${i}: ${result.error}`);
    }
    await interaction.editReply({ content: results.join('\n') });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(data)) {
      return data.map(u => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        script: u.scriptpubkey
      }));
    }
    return [];
  } catch (error) {
    console.log(`[UTXO ERROR] ${error.message}`);
    return [];
  }
}

async function getRawTransaction(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (error) {
    console.log(`[RAW TX ERROR] ${txid}: ${error.message}`);
    return null;
  }
}

async function checkAddressBalance(address) {
  return await checkLitecoinspaceBalance(address);
}

async function getAddressState(addressIndex) {
  const addrInfo = ADDRESSES.find(a => a.index === addressIndex);
  if (!addrInfo) return { confirmed: 0, unconfirmed: 0, total: 0, utxos: [], address: null };
  const state = await checkAddressBalance(addrInfo.address);
  const wallet = getLitecoinAddress(addressIndex, addrInfo.type);
  let utxos = [];
  if (state.total > 0) {
    utxos = await getLitecoinspaceUTXOs(addrInfo.address);
  }
  return {
    confirmed: state.confirmed || 0,
    unconfirmed: state.unconfirmed || 0,
    total: state.total || 0,
    utxos: utxos,
    address: addrInfo.address,
    privateKey: wallet.privateKey,
    addressIndex: addressIndex,
    type: addrInfo.type,
    source: state.source
  };
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const state = await getAddressState(fromIndex);
    console.log(`[SEND] Index ${fromIndex}: ${state.total.toFixed(8)} LTC, ${state.utxos.length} UTXOs`);
    
    if (state.total <= 0.0001) {
      return { success: false, error: `No balance on index ${fromIndex}` };
    }
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs available' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        const rawHex = await getRawTransaction(utxo.txid);
        if (!rawHex) continue;
        const rawTx = Buffer.from(rawHex, 'hex');
        
        if (state.type === 'bech32' || (utxo.script && utxo.script.startsWith('0014'))) {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: Buffer.from(utxo.script, 'hex'),
              value: utxo.value
            }
          });
        } else {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: rawTx
          });
        }
        totalInput += utxo.value;
        console.log(`[SEND] Added input: ${utxo.txid.slice(0,16)}...`);
      } catch (e) {
        console.log(`[SEND] Failed to add input: ${e.message}`);
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'Could not add any inputs' };
    }
    
    const fee = 100000;
    const amount = totalInput - fee;
    if (amount <= 0) {
      return { success: false, error: 'Balance too small for fee' };
    }
    
    console.log(`[SEND] Total: ${totalInput}, Fee: ${fee}, Sending: ${amount}`);
    psbt.addOutput({ address: toAddress, value: amount });
    
    const keyPair = ECPair.fromWIF(state.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
        console.log(`[SEND] Signed input ${i}`);
      } catch (e) {
        console.log(`[SEND] Sign error ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    try {
      const broadcast = await axios.post('https://litecoinspace.org/api/tx', txHex, {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 15000
      });
      
      const txid = broadcast.data;
      if (txid && txid.length === 64) {
        console.log(`[SEND] Broadcasted: ${txid}`);
        return {
          success: true,
          txid: txid,
          amount: amount / 100000000,
          fee: fee / 100000000,
          fromAddress: state.address
        };
      }
    } catch (broadcastError) {
      console.log(`[BROADCAST ERROR] ${broadcastError.response?.data || broadcastError.message}`);
      return { success: false, error: `Broadcast failed: ${broadcastError.response?.data || broadcastError.message}` };
    }
    
    return { success: false, error: 'Broadcast returned invalid txid' };
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot: ${client.user.tag}`);
  console.log('[INIT] Checking 3 addresses...');
  
  for (let addr of ADDRESSES) {
    const state = await checkAddressBalance(addr.address);
    console.log(`  [${addr.index}] ${addr.address}`);
    console.log(`       Balance: ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`);
  }
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View settings'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check balance').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-2').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid'),
    new SlashCommandBuilder().setName('status').setDescription('Show address status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(monitorMempool, 5000);
  console.log('[SYSTEM] Payment monitoring started');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const isOwner = interaction.user.id === OWNER_ID;
  const isStaff = settings.staffRole && interaction.member?.roles?.cache?.has(settings.staffRole);
  
  if (!isOwner && !['close'].includes(interaction.commandName)) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder().setTitle('🏪 Hello welcome to Nitro Shop').setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken').setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛒 Purchase Nitro').setStyle(ButtonStyle.Success));
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  else if (interaction.commandName === 'status') {
    let text = '**3-Address Status:**\n\n';
    for (let addr of ADDRESSES) {
      const state = await checkAddressBalance(addr.address);
      text += `**[${addr.index}]** \`${addr.address}\`\n`;
      text += `Balance: **${state.total.toFixed(8)} LTC** ($${(state.total * ltcPrice).toFixed(2)})\n`;
      text += `${addr.inUse ? '🔴 In Use' : '🟢 Available'}\n\n`;
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 2) return interaction.reply({ content: '❌ Index 0-2 only', flags: MessageFlags.Ephemeral });
    const state = await getAddressState(idx);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`**Address:** \`${state.address}\`\n**Total:** ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`)
        .setColor(state.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const state = await getAddressState(ticket.walletIndex);
    
    let text = `**Payment Check [${ticket.walletIndex}]**\n`;
    text += `Detected: **${state.total.toFixed(8)} LTC**\n`;
    text += `Need: ${ticket.minLtc?.toFixed(8)} - ${ticket.maxLtc?.toFixed(8)} LTC\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED!**`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else {
      text += `❌ No payment in range`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await processPayment(interaction.channel.id, ticket.amountLtc || 0.01);
  }
  else if (interaction.commandName === 'close') {
    releaseAddress(interaction.channel.id);
    tickets.delete(interaction.channel.id);
    await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
    await interaction.channel.delete();
  }
  else if (['ticketcategory','staffroleid','transcriptchannel','salechannel'].includes(interaction.commandName)) {
    const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : 
                interaction.commandName === 'staffroleid' ? 'staffRole' :
                interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
    settings[key] = interaction.options.getString('id');
    await interaction.reply({ content: '✅ Set', flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    let results = [];
    for (let i = 0; i <= 2; i++) {
      const result = await sendAllLTC(i, address);
      results.push(result.success ? `✅ Index ${i}: Sent ${result.amount.toFixed(8)} LTC` : `❌ Index ${i}: ${result.error}`);
    }
    await interaction.editReply({ content: results.join('\n') });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    const availableAddr = getAvailableAddress();
    if (!availableAddr) return interaction.reply({ content: '❌ All 3 addresses in use!', flags: MessageFlags.Ephemeral });
    
    availableAddr.inUse = true;
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
    
    availableAddr.ticketChannel = channel.id;
    
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('product_select')
        .setPlaceholder('Select Product')
        .addOptions(
          { label: 'Nitro Basic Monthly - $1.00', value: 'nitro_basic_month', emoji: '💎' },
          { label: 'Nitro Basic Yearly - $7.00', value: 'nitro_basic_year', emoji: '💎' },
          { label: 'Nitro Boost Monthly - $2.80', value: 'nitro_boost_month', emoji: '🔥' },
          { label: 'Nitro Boost Yearly - $14.00', value: 'nitro_boost_year', emoji: '🔥' },
          { label: 'Members', value: 'members', emoji: '👥' }
        )
    );
    
    await channel.send({
      content: `${interaction.user}`,
      embeds: [new EmbedBuilder()
        .setTitle('🛒 Select Product')
        .setDescription(`**Your Payment Address:**\n\`${availableAddr.address}\``)
        .setColor(0x00FF00)
      ],
      components: [row]
    });
    
    tickets.set(channel.id, {
      userId: interaction.user.id,
      status: 'selecting',
      channelId: channel.id,
      walletIndex: availableAddr.index,
      address: availableAddr.address,
      product: null,
      productName: null,
      price: null,
      quantity: null,
      amountUsd: null,
      amountLtc: null,
      minLtc: null,
      maxLtc: null,
      paid: false,
      delivered: false
    });
    
    await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
    const productKey = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    if (productKey === 'members') {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('members_type_select')
          .setPlaceholder('Choose Members Type')
          .addOptions(
            { label: 'Offline Members - $0.70 per 1000', value: 'members_offline', emoji: '⚫' },
            { label: 'Online Members - $1.50 per 1000', value: 'members_online', emoji: '🟢' }
          )
      );
      return interaction.update({ embeds: [new EmbedBuilder().setTitle('👥 Choose Type').setColor(0x00FF00)], components: [row] });
    }
    
    const product = PRODUCTS[productKey];
    ticket.product = productKey;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.productType = 'standard';
    
    const modal = new ModalBuilder()
      .setCustomId('qty')
      .setTitle('Quantity')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('How many?').setStyle(TextInputStyle.Short).setPlaceholder('1').setRequired(true)));
    await interaction.showModal(modal);
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'members_type_select') {
    const membersType = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    const product = PRODUCTS[membersType];
    ticket.product = membersType;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.unit = product.unit;
    ticket.productType = 'calculated';
    
    const modal = new ModalBuilder()
      .setCustomId('members_qty')
      .setTitle('Enter Amount')
      .addComponents(new ActionRowBuilder().addComponents) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(data)) {
      return data.map(u => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        script: u.scriptpubkey
      }));
    }
    return [];
  } catch (error) {
    console.log(`[UTXO ERROR] ${error.message}`);
    return [];
  }
}

async function getRawTransaction(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (error) {
    console.log(`[RAW TX ERROR] ${txid}: ${error.message}`);
    return null;
  }
}

async function checkAddressBalance(address) {
  return await checkLitecoinspaceBalance(address);
}

async function getAddressState(addressIndex) {
  const addrInfo = ADDRESSES.find(a => a.index === addressIndex);
  if (!addrInfo) return { confirmed: 0, unconfirmed: 0, total: 0, utxos: [], address: null };
  const state = await checkAddressBalance(addrInfo.address);
  const wallet = getLitecoinAddress(addressIndex, addrInfo.type);
  let utxos = [];
  if (state.total > 0) {
    utxos = await getLitecoinspaceUTXOs(addrInfo.address);
  }
  return {
    confirmed: state.confirmed || 0,
    unconfirmed: state.unconfirmed || 0,
    total: state.total || 0,
    utxos: utxos,
    address: addrInfo.address,
    privateKey: wallet.privateKey,
    addressIndex: addressIndex,
    type: addrInfo.type,
    source: state.source
  };
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const state = await getAddressState(fromIndex);
    console.log(`[SEND] Index ${fromIndex}: ${state.total.toFixed(8)} LTC, ${state.utxos.length} UTXOs`);
    
    if (state.total <= 0.0001) {
      return { success: false, error: `No balance on index ${fromIndex}` };
    }
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs available' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        const rawHex = await getRawTransaction(utxo.txid);
        if (!rawHex) continue;
        const rawTx = Buffer.from(rawHex, 'hex');
        
        if (state.type === 'bech32' || (utxo.script && utxo.script.startsWith('0014'))) {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: Buffer.from(utxo.script, 'hex'),
              value: utxo.value
            }
          });
        } else {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: rawTx
          });
        }
        totalInput += utxo.value;
        console.log(`[SEND] Added input: ${utxo.txid.slice(0,16)}...`);
      } catch (e) {
        console.log(`[SEND] Failed to add input: ${e.message}`);
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'Could not add any inputs' };
    }
    
    const fee = 100000;
    const amount = totalInput - fee;
    if (amount <= 0) {
      return { success: false, error: 'Balance too small for fee' };
    }
    
    console.log(`[SEND] Total: ${totalInput}, Fee: ${fee}, Sending: ${amount}`);
    psbt.addOutput({ address: toAddress, value: amount });
    
    const keyPair = ECPair.fromWIF(state.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
        console.log(`[SEND] Signed input ${i}`);
      } catch (e) {
        console.log(`[SEND] Sign error ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    try {
      const broadcast = await axios.post('https://litecoinspace.org/api/tx', txHex, {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 15000
      });
      
      const txid = broadcast.data;
      if (txid && txid.length === 64) {
        console.log(`[SEND] Broadcasted: ${txid}`);
        return {
          success: true,
          txid: txid,
          amount: amount / 100000000,
          fee: fee / 100000000,
          fromAddress: state.address
        };
      }
    } catch (broadcastError) {
      console.log(`[BROADCAST ERROR] ${broadcastError.response?.data || broadcastError.message}`);
      return { success: false, error: `Broadcast failed: ${broadcastError.response?.data || broadcastError.message}` };
    }
    
    return { success: false, error: 'Broadcast returned invalid txid' };
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot: ${client.user.tag}`);
  console.log('[INIT] Checking 3 addresses...');
  
  for (let addr of ADDRESSES) {
    const state = await checkAddressBalance(addr.address);
    console.log(`  [${addr.index}] ${addr.address}`);
    console.log(`       Balance: ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`);
  }
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View settings'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check balance').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-2').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid'),
    new SlashCommandBuilder().setName('status').setDescription('Show address status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(monitorMempool, 5000);
  console.log('[SYSTEM] Payment monitoring started');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const isOwner = interaction.user.id === OWNER_ID;
  const isStaff = settings.staffRole && interaction.member?.roles?.cache?.has(settings.staffRole);
  
  if (!isOwner && !['close'].includes(interaction.commandName)) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder().setTitle('🏪 Hello welcome to Nitro Shop').setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken').setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛒 Purchase Nitro').setStyle(ButtonStyle.Success));
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  else if (interaction.commandName === 'status') {
    let text = '**3-Address Status:**\n\n';
    for (let addr of ADDRESSES) {
      const state = await checkAddressBalance(addr.address);
      text += `**[${addr.index}]** \`${addr.address}\`\n`;
      text += `Balance: **${state.total.toFixed(8)} LTC** ($${(state.total * ltcPrice).toFixed(2)})\n`;
      text += `${addr.inUse ? '🔴 In Use' : '🟢 Available'}\n\n`;
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 2) return interaction.reply({ content: '❌ Index 0-2 only', flags: MessageFlags.Ephemeral });
    const state = await getAddressState(idx);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`**Address:** \`${state.address}\`\n**Total:** ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`)
        .setColor(state.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const state = await getAddressState(ticket.walletIndex);
    
    let text = `**Payment Check [${ticket.walletIndex}]**\n`;
    text += `Detected: **${state.total.toFixed(8)} LTC**\n`;
    text += `Need: ${ticket.minLtc?.toFixed(8)} - ${ticket.maxLtc?.toFixed(8)} LTC\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED!**`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else {
      text += `❌ No payment in range`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await processPayment(interaction.channel.id, ticket.amountLtc || 0.01);
  }
  else if (interaction.commandName === 'close') {
    releaseAddress(interaction.channel.id);
    tickets.delete(interaction.channel.id);
    await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
    await interaction.channel.delete();
  }
  else if (['ticketcategory','staffroleid','transcriptchannel','salechannel'].includes(interaction.commandName)) {
    const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : 
                interaction.commandName === 'staffroleid' ? 'staffRole' :
                interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
    settings[key] = interaction.options.getString('id');
    await interaction.reply({ content: '✅ Set', flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    let results = [];
    for (let i = 0; i <= 2; i++) {
      const result = await sendAllLTC(i, address);
      results.push(result.success ? `✅ Index ${i}: Sent ${result.amount.toFixed(8)} LTC` : `❌ Index ${i}: ${result.error}`);
    }
    await interaction.editReply({ content: results.join('\n') });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    const availableAddr = getAvailableAddress();
    if (!availableAddr) return interaction.reply({ content: '❌ All 3 addresses in use!', flags: MessageFlags.Ephemeral });
    
    availableAddr.inUse = true;
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
    
    availableAddr.ticketChannel = channel.id;
    
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('product_select')
        .setPlaceholder('Select Product')
        .addOptions(
          { label: 'Nitro Basic Monthly - $1.00', value: 'nitro_basic_month', emoji: '💎' },
          { label: 'Nitro Basic Yearly - $7.00', value: 'nitro_basic_year', emoji: '💎' },
          { label: 'Nitro Boost Monthly - $2.80', value: 'nitro_boost_month', emoji: '🔥' },
          { label: 'Nitro Boost Yearly - $14.00', value: 'nitro_boost_year', emoji: '🔥' },
          { label: 'Members', value: 'members', emoji: '👥' }
        )
    );
    
    await channel.send({
      content: `${interaction.user}`,
      embeds: [new EmbedBuilder()
        .setTitle('🛒 Select Product')
        .setDescription(`**Your Payment Address:**\n\`${availableAddr.address}\``)
        .setColor(0x00FF00)
      ],
      components: [row]
    });
    
    tickets.set(channel.id, {
      userId: interaction.user.id,
      status: 'selecting',
      channelId: channel.id,
      walletIndex: availableAddr.index,
      address: availableAddr.address,
      product: null,
      productName: null,
      price: null,
      quantity: null,
      amountUsd: null,
      amountLtc: null,
      minLtc: null,
      maxLtc: null,
      paid: false,
      delivered: false
    });
    
    await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
    const productKey = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    if (productKey === 'members') {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('members_type_select')
          .setPlaceholder('Choose Members Type')
          .addOptions(
            { label: 'Offline Members - $0.70 per 1000', value: 'members_offline', emoji: '⚫' },
            { label: 'Online Members - $1.50 per 1000', value: 'members_online', emoji: '🟢' }
          )
      );
      return interaction.update({ embeds: [new EmbedBuilder().setTitle('👥 Choose Type').setColor(0x00FF00)], components: [row] });
    }
    
    const product = PRODUCTS[productKey];
    ticket.product = productKey;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.productType = 'standard';
    
    const modal = new ModalBuilder()
      .setCustomId('qty')
      .setTitle('Quantity')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('How many?').setStyle(TextInputStyle.Short).setPlaceholder('1').setRequired(true)));
    await interaction.showModal(modal);
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'members_type_select') {
    const membersType = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    const product = PRODUCTS[membersType];
    ticket.product = membersType;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.unit = product.unit;
    ticket.productType = 'calculated';
    
    const modal = new ModalBuilder()
      .setCustomId('members_qty')
      .setTitle('Enter Amount')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('member_amount').setLabel('How many members?').setStyle(TextInputStyle.Short).setPlaceholder('1000').setRequired(true)));
    await interaction.showModal(modal);
  }
  
  if (interaction.isModalSubmit() && interaction.customId === 'qty') {
    const qty = parseInt(interaction.fields.getTextInputValue('quantity'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const available = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s));
    if (available.length < qty) return interaction.reply({ content: `❌ Only ${available.length} left`, flags: MessageFlags.Ephemeral });
    
    const totalUsd = ticket.price * qty;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    const toleranceLtc = parseFloat(totalLtc) * TOLERANCE_PERCENT;
    
    ticket.quantity = qty;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc;
    ticket.status = 'awaiting_payment';
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment')
        .setDescription(`**${ticket.productName}** x${qty}\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 Your LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` }
        )
        .setColor(0xFFD700)
      ]
    });
  }
  
  if (interaction.isModalSubmit() && interaction.customId === 'members_qty') {
    const memberAmount = parseInt(interaction.fields.getTextInputValue('member_amount'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    if (isNaN(memberAmount) || memberAmount < 1000) return interaction.reply({ content: '❌ Minimum 1000', flags: MessageFlags.Ephemeral });
    
    const units = memberAmount / ticket.unit;
    const totalUsd = units * ticket.price;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    const toleranceLtc = parseFloat(totalLtc) * TOLERANCE_PERCENT;
    
    ticket.quantity = memberAmount;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc;
    ticket.status = 'awaiting_payment';
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment - Members')
        .setDescription(`**${ticket.productName}**\n**Amount:** ${memberAmount.toLocaleString()} members\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 Your LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` }
        )
        .setColor(0xFFD700)
      ]
    });
  }
});

async function monitorMempool() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => t.status === 'awaiting_payment');
  for (const [channelId, ticket] of awaiting) {
    try {
      const state = await getAddressState(ticket.walletIndex);
      console.log(`[MONITOR] [${ticket.walletIndex}]: ${state.total.toFixed(8)} LTC`);
      if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
        console.log(`[MONITOR] ✅ PAYMENT DETECTED!`);
        await processPayment(channelId, state.total);
      }
    } catch (error) {
      console.error(`[MONITOR] Error:`, error.message);
    }
  }
}

async function processPayment(channelId, receivedLtc) {
  const ticket =) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(data)) {
      return data.map(u => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        script: u.scriptpubkey
      }));
    }
    return [];
  } catch (error) {
    console.log(`[UTXO ERROR] ${error.message}`);
    return [];
  }
}

async function getRawTransaction(txid) {
  try {
    const url = `https://litecoinspace.org/api/tx/${txid}/hex`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return data;
  } catch (error) {
    console.log(`[RAW TX ERROR] ${txid}: ${error.message}`);
    return null;
  }
}

async function checkAddressBalance(address) {
  return await checkLitecoinspaceBalance(address);
}

async function getAddressState(addressIndex) {
  const addrInfo = ADDRESSES.find(a => a.index === addressIndex);
  if (!addrInfo) return { confirmed: 0, unconfirmed: 0, total: 0, utxos: [], address: null };
  const state = await checkAddressBalance(addrInfo.address);
  const wallet = getLitecoinAddress(addressIndex, addrInfo.type);
  let utxos = [];
  if (state.total > 0) {
    utxos = await getLitecoinspaceUTXOs(addrInfo.address);
  }
  return {
    confirmed: state.confirmed || 0,
    unconfirmed: state.unconfirmed || 0,
    total: state.total || 0,
    utxos: utxos,
    address: addrInfo.address,
    privateKey: wallet.privateKey,
    addressIndex: addressIndex,
    type: addrInfo.type,
    source: state.source
  };
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const state = await getAddressState(fromIndex);
    console.log(`[SEND] Index ${fromIndex}: ${state.total.toFixed(8)} LTC, ${state.utxos.length} UTXOs`);
    
    if (state.total <= 0.0001) {
      return { success: false, error: `No balance on index ${fromIndex}` };
    }
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs available' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        const rawHex = await getRawTransaction(utxo.txid);
        if (!rawHex) continue;
        const rawTx = Buffer.from(rawHex, 'hex');
        
        if (state.type === 'bech32' || (utxo.script && utxo.script.startsWith('0014'))) {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            witnessUtxo: {
              script: Buffer.from(utxo.script, 'hex'),
              value: utxo.value
            }
          });
        } else {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: rawTx
          });
        }
        totalInput += utxo.value;
        console.log(`[SEND] Added input: ${utxo.txid.slice(0,16)}...`);
      } catch (e) {
        console.log(`[SEND] Failed to add input: ${e.message}`);
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'Could not add any inputs' };
    }
    
    const fee = 100000;
    const amount = totalInput - fee;
    if (amount <= 0) {
      return { success: false, error: 'Balance too small for fee' };
    }
    
    console.log(`[SEND] Total: ${totalInput}, Fee: ${fee}, Sending: ${amount}`);
    psbt.addOutput({ address: toAddress, value: amount });
    
    const keyPair = ECPair.fromWIF(state.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
        console.log(`[SEND] Signed input ${i}`);
      } catch (e) {
        console.log(`[SEND] Sign error ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    try {
      const broadcast = await axios.post('https://litecoinspace.org/api/tx', txHex, {
        headers: { 'Content-Type': 'text/plain' },
        timeout: 15000
      });
      
      const txid = broadcast.data;
      if (txid && txid.length === 64) {
        console.log(`[SEND] Broadcasted: ${txid}`);
        return {
          success: true,
          txid: txid,
          amount: amount / 100000000,
          fee: fee / 100000000,
          fromAddress: state.address
        };
      }
    } catch (broadcastError) {
      console.log(`[BROADCAST ERROR] ${broadcastError.response?.data || broadcastError.message}`);
      return { success: false, error: `Broadcast failed: ${broadcastError.response?.data || broadcastError.message}` };
    }
    
    return { success: false, error: 'Broadcast returned invalid txid' };
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot: ${client.user.tag}`);
  console.log('[INIT] Checking 3 addresses...');
  
  for (let addr of ADDRESSES) {
    const state = await checkAddressBalance(addr.address);
    console.log(`  [${addr.index}] ${addr.address}`);
    console.log(`       Balance: ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`);
  }
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View settings'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check balance').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-2').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid'),
    new SlashCommandBuilder().setName('status').setDescription('Show address status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(monitorMempool, 5000);
  console.log('[SYSTEM] Payment monitoring started');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const isOwner = interaction.user.id === OWNER_ID;
  const isStaff = settings.staffRole && interaction.member?.roles?.cache?.has(settings.staffRole);
  
  if (!isOwner && !['close'].includes(interaction.commandName)) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder().setTitle('🏪 Hello welcome to Nitro Shop').setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken').setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('🛒 Purchase Nitro').setStyle(ButtonStyle.Success));
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  else if (interaction.commandName === 'status') {
    let text = '**3-Address Status:**\n\n';
    for (let addr of ADDRESSES) {
      const state = await checkAddressBalance(addr.address);
      text += `**[${addr.index}]** \`${addr.address}\`\n`;
      text += `Balance: **${state.total.toFixed(8)} LTC** ($${(state.total * ltcPrice).toFixed(2)})\n`;
      text += `${addr.inUse ? '🔴 In Use' : '🟢 Available'}\n\n`;
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 2) return interaction.reply({ content: '❌ Index 0-2 only', flags: MessageFlags.Ephemeral });
    const state = await getAddressState(idx);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`**Address:** \`${state.address}\`\n**Total:** ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`)
        .setColor(state.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    const state = await getAddressState(ticket.walletIndex);
    
    let text = `**Payment Check [${ticket.walletIndex}]**\n`;
    text += `Detected: **${state.total.toFixed(8)} LTC**\n`;
    text += `Need: ${ticket.minLtc?.toFixed(8)} - ${ticket.maxLtc?.toFixed(8)} LTC\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED!**`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else {
      text += `❌ No payment in range`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    await processPayment(interaction.channel.id, ticket.amountLtc || 0.01);
  }
  else if (interaction.commandName === 'close') {
    releaseAddress(interaction.channel.id);
    tickets.delete(interaction.channel.id);
    await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
    await interaction.channel.delete();
  }
  else if (['ticketcategory','staffroleid','transcriptchannel','salechannel'].includes(interaction.commandName)) {
    const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : 
                interaction.commandName === 'staffroleid' ? 'staffRole' :
                interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
    settings[key] = interaction.options.getString('id');
    await interaction.reply({ content: '✅ Set', flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    let results = [];
    for (let i = 0; i <= 2; i++) {
      const result = await sendAllLTC(i, address);
      results.push(result.success ? `✅ Index ${i}: Sent ${result.amount.toFixed(8)} LTC` : `❌ Index ${i}: ${result.error}`);
    }
    await interaction.editReply({ content: results.join('\n') });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup!', flags: MessageFlags.Ephemeral });
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    const availableAddr = getAvailableAddress();
    if (!availableAddr) return interaction.reply({ content: '❌ All 3 addresses in use!', flags: MessageFlags.Ephemeral });
    
    availableAddr.inUse = true;
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
    
    availableAddr.ticketChannel = channel.id;
    
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('product_select')
        .setPlaceholder('Select Product')
        .addOptions(
          { label: 'Nitro Basic Monthly - $1.00', value: 'nitro_basic_month', emoji: '💎' },
          { label: 'Nitro Basic Yearly - $7.00', value: 'nitro_basic_year', emoji: '💎' },
          { label: 'Nitro Boost Monthly - $2.80', value: 'nitro_boost_month', emoji: '🔥' },
          { label: 'Nitro Boost Yearly - $14.00', value: 'nitro_boost_year', emoji: '🔥' },
          { label: 'Members', value: 'members', emoji: '👥' }
        )
    );
    
    await channel.send({
      content: `${interaction.user}`,
      embeds: [new EmbedBuilder()
        .setTitle('🛒 Select Product')
        .setDescription(`**Your Payment Address:**\n\`${availableAddr.address}\``)
        .setColor(0x00FF00)
      ],
      components: [row]
    });
    
    tickets.set(channel.id, {
      userId: interaction.user.id,
      status: 'selecting',
      channelId: channel.id,
      walletIndex: availableAddr.index,
      address: availableAddr.address,
      product: null,
      productName: null,
      price: null,
      quantity: null,
      amountUsd: null,
      amountLtc: null,
      minLtc: null,
      maxLtc: null,
      paid: false,
      delivered: false
    });
    
    await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
    const productKey = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    if (productKey === 'members') {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('members_type_select')
          .setPlaceholder('Choose Members Type')
          .addOptions(
            { label: 'Offline Members - $0.70 per 1000', value: 'members_offline', emoji: '⚫' },
            { label: 'Online Members - $1.50 per 1000', value: 'members_online', emoji: '🟢' }
          )
      );
      return interaction.update({ embeds: [new EmbedBuilder().setTitle('👥 Choose Type').setColor(0x00FF00)], components: [row] });
    }
    
    const product = PRODUCTS[productKey];
    ticket.product = productKey;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.productType = 'standard';
    
    const modal = new ModalBuilder()
      .setCustomId('qty')
      .setTitle('Quantity')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantity').setLabel('How many?').setStyle(TextInputStyle.Short).setPlaceholder('1').setRequired(true)));
    await interaction.showModal(modal);
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'members_type_select') {
    const membersType = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    const product = PRODUCTS[membersType];
    ticket.product = membersType;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.unit = product.unit;
    ticket.productType = 'calculated';
    
    const modal = new ModalBuilder()
      .setCustomId('members_qty')
      .setTitle('Enter Amount')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('member_amount').setLabel('How many members?').setStyle(TextInputStyle.Short).setPlaceholder('1000').setRequired(true)));
    await interaction.showModal(modal);
  }
  
  if (interaction.isModalSubmit() && interaction.customId === 'qty') {
    const qty = parseInt(interaction.fields.getTextInputValue('quantity'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const available = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s));
    if (available.length < qty) return interaction.reply({ content: `❌ Only ${available.length} left`, flags: MessageFlags.Ephemeral });
    
    const totalUsd = ticket.price * qty;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    const toleranceLtc = parseFloat(totalLtc) * TOLERANCE_PERCENT;
    
    ticket.quantity = qty;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc;
    ticket.status = 'awaiting_payment';
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment')
        .setDescription(`**${ticket.productName}** x${qty}\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 Your LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` }
        )
        .setColor(0xFFD700)
      ]
    });
  }
  
  if (interaction.isModalSubmit() && interaction.customId === 'members_qty') {
    const memberAmount = parseInt(interaction.fields.getTextInputValue('member_amount'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    if (isNaN(memberAmount) || memberAmount < 1000) return interaction.reply({ content: '❌ Minimum 1000', flags: MessageFlags.Ephemeral });
    
    const units = memberAmount / ticket.unit;
    const totalUsd = units * ticket.price;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    const toleranceLtc = parseFloat(totalLtc) * TOLERANCE_PERCENT;
    
    ticket.quantity = memberAmount;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc;
    ticket.status = 'awaiting_payment';
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment - Members')
        .setDescription(`**${ticket.productName}**\n**Amount:** ${memberAmount.toLocaleString()} members\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 Your LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` }
        )
        .setColor(0xFFD700)
      ]
    });
  }
});

async function monitorMempool() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => t.status === 'awaiting_payment');
  for (const [channelId, ticket] of awaiting) {
    try {
      const state = await getAddressState(ticket.walletIndex);
      console.log(`[MONITOR] [${ticket.walletIndex}]: ${state.total.toFixed(8)} LTC`);
      if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
        console.log(`[MONITOR] ✅ PAYMENT DETECTED!`);
        await processPayment(channelId, state.total);
      }
    } catch (error) {
      console.error(`[MONITOR] Error:`, error.message);
    }
  }
}

async function processPayment(channelId, receivedLtc) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.status === 'delivered') return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    releaseAddress(channelId);
    tickets.delete(channelId);
    return;
  }
  
  ticket.status = 'delivered';
  ticket.paid = true;
  
  const sendResult = await sendAllLTC(ticket.walletIndex, FEE_ADDRESS);
  
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle('✅ Payment Confirmed!')
      .setDescription(`**Address [${ticket.walletIndex}]** received: **${receivedLtc.toFixed(8)} LTC**\nAuto-send: ${sendResult.success ? '✅' : '❌'}`)
      .setColor(0x00FF00)
    ]
  });
  
  const owner = await client.users.fetch(OWNER_ID).catch(() => null);
  if (owner) {
    owner.send({
      embeds: [new EmbedBuilder()
        .setTitle('🛒 New Order Paid')
        .setDescription(`**Product:** ${ticket.productName}\n**Qty:** ${ticket.quantity}\n**Amount:** $${ticket.amountUsd.toFixed(2)}\n**LTC:** ${receivedLtc.toFixed(8)}\n**Channel:** <#${channelId}>`)
        .setColor(0x00FF00)
      ]
    });
  }
  
  await deliverProducts(channelId, receivedLtc);
}

async function deliverProducts(channelId, receivedLtc) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.delivered) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  
  if (ticket.productType === 'calculated') {
    ticket.delivered = true;
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('🎁 Order Confirmed')
        .setDescription(`**${ticket.productName}**\n**Amount:** ${ticket.quantity.toLocaleString()} members`)
        .setColor(0x00FF00)
      ]
    });
    return;
  }
  
  const productList = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s)).slice(0, ticket.quantity);
  if (productList.length === 0) {
    return channel.send({ embeds: [new EmbedBuilder().setTitle('❌ Out of Stock').setColor(0xFF0000)] });
  }
  
  productList.forEach(p => usedStock.add(p));
  ticket.productsSent = productList;
  ticket.delivered = true;
  
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Products')
    .setDescription(`**${ticket.productName}** x${productList.length}`)
    .setColor(0x00FF00);
  productList.forEach((item, idx) => embed.addFields({ name: `Product ${idx + 1}`, value: item }));
  await channel.send({ embeds: [embed] });
}

client.login(process.env.DISCORD_TOKEN);
