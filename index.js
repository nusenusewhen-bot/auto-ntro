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

const LITECOIN = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

const ADDRESSES = [
  { index: 0, address: 'Lc1m5wtQ8g9mJJP9cV1Db3S7DCxuot98CU', inUse: false, ticketChannel: null, type: 'bech32' },
  { index: 1, address: 'LPtT2PJ9V2h2cJR6qAz8RSAVKpSHoLodQg', inUse: false, ticketChannel: null, type: 'legacy' },
  { index: 2, address: null, inUse: false, ticketChannel: null, type: 'legacy' }
];

let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const usedStock = new Set();

function getWallet(index, type) {
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  const pubkey = Buffer.from(child.publicKey);
  
  let payment;
  if (type === 'bech32') {
    payment = bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
  } else {
    payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
  }
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
}

ADDRESSES[2].address = getWallet(2, 'legacy').address;

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

async function getBalance(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    const funded = (data.chain_stats?.funded_txo_sum || 0) - (data.chain_stats?.spent_txo_sum || 0);
    const mempool = (data.mempool_stats?.funded_txo_sum || 0) - (data.mempool_stats?.spent_txo_sum || 0);
    return (funded + mempool) / 100000000;
  } catch (e) {
    return 0;
  }
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

async function sendLTC(fromIndex, toAddress) {
  const addrInfo = ADDRESSES[fromIndex];
  const wallet = getWallet(fromIndex, addrInfo.type);
  const balance = await getBalance(addrInfo.address);
  
  if (balance <= 0.0001) return { success: false, error: 'No balance' };
  
  const utxos = await getUTXOs(addrInfo.address);
  if (utxos.length === 0) return { success: false, error: 'No UTXOs' };
  
  const psbt = new bitcoin.Psbt({ network: LITECOIN });
  let total = 0;
  
  for (let utxo of utxos) {
    const raw = await getRawTx(utxo.txid);
    if (!raw) continue;
    
    if (addrInfo.type === 'bech32') {
      // Native SegWit - use witnessUtxo
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptpubkey, 'hex'),
          value: utxo.value
        }
      });
    } else {
      // Legacy - use nonWitnessUtxo
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(raw, 'hex')
      });
    }
    total += utxo.value;
  }
  
  if (total === 0) return { success: false, error: 'No inputs' };
  
  const fee = 100000;
  const amount = total - fee;
  if (amount <= 0) return { success: false, error: 'Too small' };
  
  psbt.addOutput({ address: toAddress, value: amount });
  
  const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
  for (let i = 0; i < psbt.inputCount; i++) {
    try { psbt.signInput(i, keyPair); } catch (e) {
      console.log(`[SIGN ERROR] Input ${i}: ${e.message}`);
    }
  }
  
  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();
  
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data, amount: amount / 100000000 };
  } catch (e) {
    return { success: false, error: 'Broadcast failed' };
  }
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  for (let addr of ADDRESSES) {
    const bal = await getBalance(addr.address);
    console.log(`[${addr.index}] ${addr.address} (${addr.type}): ${bal.toFixed(8)} LTC`);
  }
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set category').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
   new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)) 
// - Index 0: `0.07153965 LTC` ✅
// - Index 1: `0.01883948 LTC` ✅

// But the **sending is failing** because of `Can not finalize input #0`. This happens because:

1. **Your `Lc1...` address is Bech32 (SegWit)** but the code is trying to sign it as Legacy
2. **The `LP...` address is Legacy** and should work with the current code

// The issue is that `Lc1m5wtQ8g9mJJP9cV1Db3S7DCxuot98CU` is a **Native SegWit (P2WPKH)** address, not Legacy. I need to detect the address type and use the correct signing method.

// Here's the fix:

```javascript
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

const LITECOIN = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

const ADDRESSES = [
  { index: 0, address: 'Lc1m5wtQ8g9mJJP9cV1Db3S7DCxuot98CU', inUse: false, ticketChannel: null, type: 'bech32' },
  { index: 1, address: 'LPtT2PJ9V2h2cJR6qAz8RSAVKpSHoLodQg', inUse: false, ticketChannel: null, type: 'legacy' },
  { index: 2, address: null, inUse: false, ticketChannel: null, type: 'legacy' }
];

let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const usedStock = new Set();

function getWallet(index, type) {
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  const pubkey = Buffer.from(child.publicKey);
  
  let payment;
  if (type === 'bech32') {
    payment = bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
  } else {
    payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
  }
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  return { address: payment.address, privateKey: keyPair.toWIF(), type: type };
}

ADDRESSES[2].address = getWallet(2, 'legacy').address;

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

async function getBalance(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    const funded = (data.chain_stats?.funded_txo_sum || 0) - (data.chain_stats?.spent_txo_sum || 0);
    const mempool = (data.mempool_stats?.funded_txo_sum || 0) - (data.mempool_stats?.spent_txo_sum || 0);
    return (funded + mempool) / 100000000;
  } catch (e) {
    return 0;
  }
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

async function sendLTC(fromIndex, toAddress) {
  const addrInfo = ADDRESSES[fromIndex];
  const wallet = getWallet(fromIndex, addrInfo.type);
  const balance = await getBalance(addrInfo.address);
  
  if (balance <= 0.0001) return { success: false, error: 'No balance' };
  
  const utxos = await getUTXOs(addrInfo.address);
  if (utxos.length === 0) return { success: false, error: 'No UTXOs' };
  
  const psbt = new bitcoin.Psbt({ network: LITECOIN });
  let total = 0;
  
  for (let utxo of utxos) {
    const raw = await getRawTx(utxo.txid);
    if (!raw) continue;
    
    if (addrInfo.type === 'bech32') {
      // Native SegWit - use witnessUtxo
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: Buffer.from(utxo.scriptpubkey, 'hex'),
          value: utxo.value
        }
      });
    } else {
      // Legacy - use nonWitnessUtxo
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(raw, 'hex')
      });
    }
    total += utxo.value;
  }
  
  if (total === 0) return { success: false, error: 'No inputs' };
  
  const fee = 100000;
  const amount = total - fee;
  if (amount <= 0) return { success: false, error: 'Too small' };
  
  psbt.addOutput({ address: toAddress, value: amount });
  
  const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
  for (let i = 0; i < psbt.inputCount; i++) {
    try { psbt.signInput(i, keyPair); } catch (e) {
      console.log(`[SIGN ERROR] Input ${i}: ${e.message}`);
    }
  }
  
  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();
  
  try {
    const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' },
      timeout: 15000
    });
    return { success: true, txid: res.data, amount: amount / 100000000 };
  } catch (e) {
    return { success: false, error: 'Broadcast failed' };
  }
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  
  for (let addr of ADDRESSES) {
    const bal = await getBalance(addr.address);
    console.log(`[${addr.index}] ${addr.address} (${addr.type}): ${bal.toFixed(8)} LTC`);
  }
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set category').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales').addStringOption(o => o.setName('id').setDescription('ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send LTC').addStringOption(o => o.setName('address').setDescription('Address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check balance').addIntegerOption(o => o.setName('index').setDescription('0-2').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Check payment'),
    new SlashCommandBuilder().setName('status').setDescription('Status')
  ];
  
  await client.application.commands.set(commands);
  setInterval(checkPayments, 5000);
});

async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment') continue;
    const bal = await getBalance(ticket.address);
    if (bal >= ticket.minLtc && bal <= ticket.maxLtc) {
      await processPayment(channelId, bal);
    }
  }
}

async function processPayment(channelId, amount) {
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
  
  const sendResult = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  
  await channel.send(`Payment received: ${amount.toFixed(8)} LTC. Auto-send: ${sendResult.success ? 'Success' : 'Failed'}`);
  
  const owner = await client.users.fetch(OWNER_ID).catch(() => null);
  if (owner) {
    await owner.send(`New order: ${ticket.product} x${ticket.quantity} - ${amount.toFixed(8)} LTC`);
  }
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  const isOwner = interaction.user.id === OWNER_ID;
  
  if (!isOwner && interaction.commandName !== 'close') {
    return interaction.reply({ content: 'Owner only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) return interaction.reply({ content: 'Setup first', flags: MessageFlags.Ephemeral });
    const embed = new EmbedBuilder().setTitle('Nitro Shop').setDescription('Click below').setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('Purchase').setStyle(ButtonStyle.Success));
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  
  else if (interaction.commandName === 'status') {
    let text = 'Address Status:\n';
    for (let addr of ADDRESSES) {
      const bal = await getBalance(addr.address);
      text += `\n[${addr.index}] ${addr.type} - ${addr.address}\n${bal.toFixed(8)} LTC - ${addr.inUse ? 'In Use' : 'Free'}\n`;
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    const bal = await getBalance(ADDRESSES[idx].address);
    await interaction.reply({ content: `[${idx}] ${ADDRESSES[idx].type} - ${bal.toFixed(8)} LTC`, flags: MessageFlags.Ephemeral });
  }
  
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const to = interaction.options.getString('address');
    let results = [];
    for (let i = 0; i <= 2; i++) {
      const res = await sendLTC(i, to);
      results.push(res.success ? `✅ [${i}] Sent ${res.amount.toFixed(8)} LTC` : `❌ [${i}] ${res.error}`);
    }
    await interaction.editReply({ content: results.join('\n') });
  }
  
  else if (interaction.commandName === 'close') {
    releaseAddress(interaction.channel.id);
    tickets.delete(interaction.channel.id);
    await interaction.reply({ content: 'Closing...', flags: MessageFlags.Ephemeral });
    await interaction.channel.delete();
  }
  
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: 'No ticket', flags: MessageFlags.Ephemeral });
    const bal = await getBalance(ticket.address);
    await interaction.reply({ content: `Balance: ${bal.toFixed(8)} LTC. Need: ${ticket.minLtc?.toFixed(8)} - ${ticket.maxLtc?.toFixed(8)}` });
  }
  
  else {
    const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : 
                interaction.commandName === 'staffroleid' ? 'staffRole' :
                interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
    settings[key] = interaction.options.getString('id');
    await interaction.reply({ content: 'Set', flags: MessageFlags.Ephemeral });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) return interaction.reply({ content: 'Not setup', flags: MessageFlags.Ephemeral });
    
    for (let [chId, t] of tickets) {
      if (t.userId === interaction.user.id && !t.paid) {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `You have ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    const addr = getAvailableAddress();
    if (!addr) return interaction.reply({ content: 'All busy', flags: MessageFlags.Ephemeral });
    
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
        .setPlaceholder('Select')
        .addOptions(
          { label: 'Nitro Basic Monthly - $1', value: 'basic_month', emoji: '💎' },
          { label: 'Nitro Basic Yearly - $7', value: 'basic_year', emoji: '💎' },
          { label: 'Nitro Boost Monthly - $2.80', value: 'boost_month', emoji: '🔥' },
          { label: 'Nitro Boost Yearly - $14', value: 'boost_year', emoji: '🔥' }
        )
    );
    
    await channel.send({
      content: `${interaction.user}`,
      embeds: [new EmbedBuilder().setTitle('Select').setDescription(`Pay to: ${addr.address}`).setColor(0x00FF00)],
      components: [row]
    });
    
    tickets.set(channel.id, {
      userId: interaction.user.id,
      status: 'selecting',
      walletIndex: addr.index,
      address: addr.address,
      product: null,
      price: null,
      quantity: 1,
      amountLtc: null,
      minLtc: null,
      maxLtc: null,
      paid: false
    });
    
    await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_product') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const prices = { basic_month: 1, basic_year: 7, boost_month: 2.8, boost_year: 14 };
    ticket.product = interaction.values[0];
    ticket.price = prices[ticket.product];
    
    const modal = new ModalBuilder()
      .setCustomId('qty_modal')
      .setTitle('Quantity')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('qty').setLabel('How many?').setStyle(TextInputStyle.Short).setPlaceholder('1').setRequired(true)));
    
    await interaction.showModal(modal);
  }
  
  if (interaction.isModalSubmit() && interaction.customId === 'qty_modal') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const qty = parseInt(interaction.fields.getTextInputValue('qty')) || 1;
    const totalUsd = ticket.price * qty;
    const totalLtc = (totalUsd / 75).toFixed(8);
    const tolerance = parseFloat(totalLtc) * 0.5;
    
    ticket.quantity = qty;
    ticket.amountLtc = parseFloat(totalLtc);
    ticket.minLtc = parseFloat(totalLtc) - tolerance;
    ticket.maxLtc = parseFloat(totalLtc) + tolerance;
    ticket.status = 'awaiting_payment';
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('Pay')
        .setDescription(`Send ${totalLtc} LTC to:\n${ticket.address}\n(±50% accepted)`)
        .setColor(0xFFD700)
      ]
    });
  }
});

client.login(process.env.DISCORD_TOKEN);
