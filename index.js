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
  { index: 1, address: 'LPtT2PJ9V2h2cJR6qAz8RSAVKpSHoLodQg', inUse: false, ticketChannel: null, type: 'p2pkh' },
  { index: 2, address: null, inUse: false, ticketChannel: null, type: 'p2pkh' }
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

function getLitecoinAddress(index, addressType = 'p2pkh') {
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  const pubkey = Buffer.from(child.publicKey);
  let payment = addressType === 'bech32' ? bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN }) : bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  return { address: payment.address, privateKey: keyPair.toWIF(), index: index, type: addressType };
}

const wallet2 = getLitecoinAddress(2, 'p2pkh');
ADDRESSES[2].address = wallet2.address;

function getAvailableAddress() {
  for (let addr of ADDRESSES) if (!addr.inUse) return addr;
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

// ============ 3XPL SANDBOX API (PRIMARY) ============
// Base: https://sandbox-api.3xpl.com (no API key, rate limited)

async function check3xplBalance(address) {
  try {
    // 3xpl sandbox endpoint for Litecoin address
    const url = `https://sandbox-api.3xpl.com/ltc/address/${address}`;
    console.log(`[3XPL] Checking: ${address}`);
    
    const { data } = await axios.get(url, { timeout: 15000 });
    
    // Check context code
    if (data.context?.code !== 200) {
      console.log(`[3XPL] Error code: ${data.context?.code}`);
      return { success: false, error: `API error: ${data.context?.code}` };
    }
    
    if (data.data) {
      // Parse balance from 3xpl format
      const balanceData = data.data;
      
      // Balance is usually in satoshis
      const confirmed = parseInt(balanceData.balance?.confirmed || balanceData.confirmed || 0) / 100000000;
      const unconfirmed = parseInt(balanceData.balance?.unconfirmed || balanceData.unconfirmed || 0) / 100000000;
      const total = confirmed + unconfirmed;
      
      console.log(`[3XPL] ✅ ${address}: ${total.toFixed(8)} LTC`);
      return { success: true, confirmed, unconfirmed, total, utxos: [], source: '3xpl' };
    }
    return { success: false, error: 'No data' };
  } catch (error) {
    console.log(`[3XPL ERROR] ${error.response?.status || error.message}`);
    if (error.response?.data) {
      console.log(`[3XPL ERROR] Response:`, error.response.data);
    }
    return { success: false, error: error.message };
  }
}

// Get UTXOs from 3xpl
async function get3xplUTXOs(address) {
  try {
    const url = `https://sandbox-api.3xpl.com/ltc/address/${address}/utxos`;
    const { data } = await axios.get(url, { timeout: 15000 });
    
    if (data.context?.code !== 200) {
      return [];
    }
    
    if (data.data && Array.isArray(data.data)) {
      return data.data.map(u => ({
        txid: u.txid || u.transaction_hash,
        vout: u.vout || u.index,
        value: parseInt(u.value),
        script: u.script || u.script_hex,
        type: (u.script || u.script_hex)?.startsWith('0014') ? 'bech32' : 'legacy'
      }));
    }
    return [];
  } catch (error) {
    console.log(`[3XPL UTXO ERROR] ${error.message}`);
    return [];
  }
}

// ============ FALLBACK APIs ============

async function checkSoChainBalance(address) {
  try {
    const url = `https://chain.so/api/v2/get_address_balance/LTC/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (data?.status === 'success' && data.data) {
      const confirmed = parseFloat(data.data.confirmed_balance) || 0;
      const unconfirmed = parseFloat(data.data.unconfirmed_balance) || 0;
      return { success: true, confirmed, unconfirmed, total: confirmed + unconfirmed, utxos: [], source: 'sochain' };
    }
    return { success: false, error: 'No data' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function checkLitecoinspaceBalance(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (data) {
      const confirmed = ((data.chain_stats?.funded_txo_sum || 0) - (data.chain_stats?.spent_txo_sum || 0)) / 100000000;
      const unconfirmed = ((data.mempool_stats?.funded_txo_sum || 0) - (data.mempool_stats?.spent_txo_sum || 0)) / 100000000;
      return { success: true, confirmed, unconfirmed, total: confirmed + unconfirmed, utxos: [], source: 'ltcspace' };
    }
    return { success: false, error: 'No data' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// MASTER: Try 3xpl first, then fallbacks
async function checkAddressBalance(address) {
  // Try 3xpl sandbox first (free, no key)
  const xpl = await check3xplBalance(address);
  if (xpl.success) return xpl;
  
  // Fallback to SoChain
  const sochain = await checkSoChainBalance(address);
  if (sochain.success) return sochain;
  
  // Final fallback to Litecoinspace
  const ltcspace = await checkLitecoinspaceBalance(address);
  if (ltcspace.success) return ltcspace;
  
  return { success: false, total: 0, utxos: [], source: 'failed' };
}

async function getUTXOs(address) {
  // Try 3xpl first
  const utxos = await get3xplUTXOs(address);
  if (utxos.length > 0) return utxos;
  
  // Fallback to litecoinspace
  try {
    const url = `https://litecoinspace.org/api/address/${address}/utxo`;
    const { data } = await axios.get(url, { timeout: 15000 });
    if (Array.isArray(data)) {
      return data.map(u => ({
        txid: u.txid,
        vout: u.vout,
        value: u.value,
        script: u.scriptpubkey,
        type: u.scriptpubkey?.startsWith('0014') ? 'bech32' : 'legacy'
      }));
    }
  } catch (e) {}
  
  return [];
}

async function getAddressState(addressIndex) {
  const addrInfo = ADDRESSES.find(a => a.index === addressIndex);
  if (!addrInfo) return { confirmed: 0, unconfirmed: 0, total: 0, utxos: [], address: null };
  const state = await checkAddressBalance(addrInfo.address);
  const wallet = getLitecoinAddress(addressIndex, addrInfo.type);
  let utxos = state.utxos || [];
  if (state.total > 0 && utxos.length === 0) utxos = await getUTXOs(addrInfo.address);
  return {
    confirmed: state.confirmed || 0, unconfirmed: state.unconfirmed || 0, total: state.total || 0,
    utxos, address: addrInfo.address, privateKey: wallet.privateKey, addressIndex, type: addrInfo.type, source: state.source
  };
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const state = await getAddressState(fromIndex);
    if (state.total <= 0.0001) return { success: false, error: 'No balance' };
    if (state.utxos.length === 0) return { success: false, error: 'No UTXOs' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        // Get raw tx from 3xpl
        const txUrl = `https://sandbox-api.3xpl.com/ltc/transaction/${utxo.txid}`;
        const { data } = await axios.get(txUrl, { timeout: 10000 });
        
        if (data.context?.code === 200 && data.data?.hex) {
          const rawTx = Buffer.from(data.data.hex, 'hex');
          if (utxo.type === 'bech32') {
            psbt.addInput({ hash: utxo.txid, index: utxo.vout, witnessUtxo: { script: Buffer.from(utxo.script, 'hex'), value: utxo.value } });
          } else {
            psbt.addInput({ hash: utxo.txid, index: utxo.vout, nonWitnessUtxo: rawTx });
          }
          totalInput += utxo.value;
        }
      } catch (e) {}
    }
    
    if (totalInput === 0) return { success: false, error: 'No inputs added' };
    const fee = 100000;
    const amount = totalInput - fee;
    if (amount <= 0) return { success: false, error: 'Balance too small for fee' };
    
    psbt.addOutput({ address: toAddress, value: amount });
    const keyPair = ECPair.fromWIF(state.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) try { psbt.signInput(i, keyPair); } catch (e) {}
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    // Broadcast via 3xpl
    const broadcast = await axios.post('https://sandbox-api.3xpl.com/ltc/push', { tx: txHex }, { timeout: 15000 });
    
    if (broadcast.data?.data?.txid || broadcast.data?.data) {
      const txid = broadcast.data.data.txid || broadcast.data.data;
      return { success: true, txid, amount: amount / 100000000, fee: fee / 100000000 };
    }
    return { success: false, error: 'Broadcast failed' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============ DISCORD EVENTS ============

client.once('ready', async () => {
  console.log(`[READY] Bot: ${client.user.tag}`);
  console.log('[INIT] Checking balances via 3xpl sandbox...');
  
  for (let addr of ADDRESSES) {
    const state = await checkAddressBalance(addr.address);
    console.log(`  [${addr.index}] ${addr.address}`);
    console.log(`       Balance: ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})`);
    console.log(`       Source: ${state.source || 'FAILED'}`);
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
      text += `API: ${state.source || '❌'}\n\n`;
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    const state = await getAddressState(idx);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`**Address:** \`${state.address}\`\n**Total:** ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})\n**API:** ${state.source || '❌'}`)
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
    text += `Detected: **${state.total.toFixed(8)} LTC** (via ${state.source})\n`;
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
    if (!availableAddr) return interaction.reply({ content: '❌ All addresses in use!', flags: MessageFlags.Ephemeral });
    
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
      embeds: [new EmbedBuilder().setTitle('🛒 Select Product').setDescription(`**Payment Address:**\n\`${availableAddr.address}\``).setColor(0x00FF00)],
      components: [row]
    });
    
    tickets.set(channel.id, {
      userId: interaction.user.id, status: 'selecting', channelId: channel.id,
      walletIndex: availableAddr.index, address: availableAddr.address,
      product: null, productName: null, price: null, quantity: null,
      amountUsd: null, amountLtc: null, minLtc: null, maxLtc: null,
      paid: false, delivered: false
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
