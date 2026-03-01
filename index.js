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
const BLOCKCHAIR_KEY = process.env.BLOCKCHAIR_KEY;
const BOT_MNEMONIC = process.env.BOT_MNEMONIC;
const TOLERANCE_PERCENT = 0.50;

const LITECOIN = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

// EXACTLY 3 ADDRESSES WITH YOUR MONEY
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
  
  let payment;
  if (addressType === 'bech32') {
    payment = bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
  } else {
    payment = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
  }
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  return { address: payment.address, privateKey: keyPair.toWIF(), index: index, type: addressType };
}

// Initialize address 2 (P2PKH)
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
      console.log(`[RELEASE] Address ${addr.index} is now available`);
      return true;
    }
  }
  return false;
}

// Find address data in Blockchair response (case-insensitive)
function findAddressInResponse(data, address) {
  if (!data || !data.data) return null;
  
  // Try exact match first
  if (data.data[address]) return data.data[address];
  
  // Try lowercase
  const lowerAddr = address.toLowerCase();
  if (data.data[lowerAddr]) return data.data[lowerAddr];
  
  // Try uppercase
  const upperAddr = address.toUpperCase();
  if (data.data[upperAddr]) return data.data[upperAddr];
  
  // Iterate through keys to find case-insensitive match
  for (const key of Object.keys(data.data)) {
    if (key.toLowerCase() === lowerAddr) {
      return data.data[key];
    }
  }
  
  return null;
}

// PRIMARY: Blockchair API with your key
async function checkBlockchairBalance(address) {
  try {
    // Use original casing for API call - Blockchair handles both
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?key=${BLOCKCHAIR_KEY}`;
    console.log(`[BLOCKCHAIR] Checking: ${address}`);
    
    const { data } = await axios.get(url, { timeout: 15000 });
    
    const addrData = findAddressInResponse(data, address);
    
    if (addrData && addrData.address) {
      const addr = addrData.address;
      const balance = (addr.balance || 0) / 100000000;
      const received = (addr.received || 0) / 100000000;
      const spent = (addr.spent || 0) / 100000000;
      const unconfirmed = Math.max(0, received - spent - balance);
      
      const utxos = (addrData.utxo || []).map(u => ({
        txid: u.transaction_hash,
        vout: u.index,
        value: parseInt(u.value),
        script: u.script_hex,
        type: u.script_hex?.startsWith('0014') ? 'bech32' : 'legacy'
      }));
      
      console.log(`[BLOCKCHAIR] ${address}: ${balance.toFixed(8)} LTC confirmed, ${unconfirmed.toFixed(8)} unconfirmed`);
      
      return { 
        success: true, 
        confirmed: balance, 
        unconfirmed: unconfirmed,
        total: balance + unconfirmed,
        utxos: utxos,
        address: address
      };
    }
    console.log(`[BLOCKCHAIR] No data found for ${address}`);
    return { success: false, error: 'No data', raw: data };
  } catch (error) {
    console.log(`[BLOCKCHAIR ERROR] ${address}: ${error.message}`);
    if (error.response) {
      console.log(`[BLOCKCHAIR ERROR] Status: ${error.response.status}, Data:`, error.response.data);
    }
    return { success: false, error: error.message };
  }
}

// FALLBACK: SoChain API (FIXED URL)
async function checkSoChainBalance(address) {
  try {
    // SoChain v2 API (v3 doesn't exist)
    const url = `https://chain.so/api/v2/get_address_balance/LTC/${address}`;
    console.log(`[SOCHAIN] Checking: ${address}`);
    
    const { data } = await axios.get(url, { timeout: 15000 });
    
    if (data?.status === 'success' && data.data) {
      const confirmed = parseFloat(data.data.confirmed_balance) || 0;
      const unconfirmed = parseFloat(data.data.unconfirmed_balance) || 0;
      
      console.log(`[SOCHAIN] ${address}: ${confirmed.toFixed(8)} LTC`);
      
      return {
        success: true,
        confirmed: confirmed,
        unconfirmed: unconfirmed,
        total: confirmed + unconfirmed,
        utxos: [],
        address: address
      };
    }
    return { success: false, error: 'No data', raw: data };
  } catch (error) {
    console.log(`[SOCHAIN ERROR] ${address}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Get UTXOs from Blockchair for sending
async function getUTXOs(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?transaction_details=true&key=${BLOCKCHAIR_KEY}`;
    
    const { data } = await axios.get(url, { timeout: 15000 });
    
    const addrData = findAddressInResponse(data, address);
    
    if (addrData?.utxo) {
      return addrData.utxo.map(u => ({
        txid: u.transaction_hash,
        vout: u.index,
        value: parseInt(u.value),
        script: u.script_hex,
        type: u.script_hex?.startsWith('0014') ? 'bech32' : 'legacy'
      }));
    }
    return [];
  } catch (error) {
    console.log(`[UTXO ERROR] ${error.message}`);
    return [];
  }
}

// MASTER CHECK: Tries Blockchair first, then SoChain
async function checkAddressBalance(address) {
  // Try Blockchair first (with your API key)
  let result = await checkBlockchairBalance(address);
  
  if (result.success && result.total > 0) {
    return result;
  }
  
  // Fallback to SoChain if Blockchair fails or returns 0
  console.log(`[FALLBACK] Trying SoChain for ${address}`);
  result = await checkSoChainBalance(address);
  
  if (result.success) {
    // If SoChain found balance but no UTXOs, fetch UTXOs from Blockchair
    if (result.utxos.length === 0 && result.total > 0) {
      result.utxos = await getUTXOs(address);
    }
    return result;
  }
  
  return { success: false, total: 0, utxos: [], address: address };
}

async function getAddressState(addressIndex) {
  const addrInfo = ADDRESSES.find(a => a.index === addressIndex);
  if (!addrInfo) return { confirmed: 0, unconfirmed: 0, total: 0, utxos: [], address: null };
  
  const state = await checkAddressBalance(addrInfo.address);
  const wallet = getLitecoinAddress(addressIndex, addrInfo.type);
  
  return {
    confirmed: state.confirmed || 0,
    unconfirmed: state.unconfirmed || 0,
    total: state.total || 0,
    utxos: state.utxos || [],
    address: addrInfo.address,
    privateKey: wallet.privateKey,
    addressIndex: addressIndex,
    type: addrInfo.type
  };
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const state = await getAddressState(fromIndex);
    
    console.log(`[SEND] Index ${fromIndex} (${state.address}): ${state.total.toFixed(8)} LTC, ${state.utxos.length} UTXOs, type: ${state.type}`);
    
    if (state.total <= 0.0001) {
      return { success: false, error: `No balance on index ${fromIndex}` };
    }
    
    if (state.utxos.length === 0) {
      // Try to get UTXOs one more time
      state.utxos = await getUTXOs(state.address);
      if (state.utxos.length === 0) {
        return { success: false, error: 'No UTXOs available - cannot spend' };
      }
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const { data } = await axios.get(txUrl, { timeout: 10000 });
        
        if (data?.data?.[utxo.txid]?.raw_transaction) {
          const rawTx = Buffer.from(data.data[utxo.txid].raw_transaction, 'hex');
          
          if (utxo.type === 'bech32' || state.type === 'bech32') {
            // For SegWit (bech32), use witnessUtxo
            psbt.addInput({
              hash: utxo.txid,
              index: utxo.vout,
              witnessUtxo: {
                script: Buffer.from(utxo.script, 'hex'),
                value: utxo.value
              }
            });
          } else {
            // For legacy, use nonWitnessUtxo
            psbt.addInput({
              hash: utxo.txid,
              index: utxo.vout,
              nonWitnessUtxo: rawTx
            });
          }
          totalInput += utxo.value;
          console.log(`[SEND] Added input: ${utxo.txid.slice(0,16)}... value: ${utxo.value}`);
        }
      } catch (e) {
        console.log(`[SEND] Failed to add input: ${e.message}`);
      }
    }
    
    if (totalInput === 0) return { success: false, error: 'Could not add any inputs' };
    
    const fee = 100000; // 0.001 LTC
    const amount = totalInput - fee;
    
    if (amount <= 0) return { success: false, error: 'Balance too small for fee' };
    
    psbt.addOutput({ address: toAddress, value: amount });
    
    const keyPair = ECPair.fromWIF(state.privateKey, LITECOIN);
    for (let i = 0; i < psbt.inputCount; i++) {
      try { 
        psbt.signInput(i, keyPair); 
      } catch (e) {
        console.log(`[SEND] Sign error for input ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    console.log(`[SEND] Broadcasting transaction...`);
    const broadcast = await axios.post(
      `https://api.blockchair.com/litecoin/push/transaction?key=${BLOCKCHAIR_KEY}`,
      { data: txHex },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    
    if (broadcast.data?.data?.transaction_hash) {
      console.log(`[SEND] Success! TX: ${broadcast.data.data.transaction_hash}`);
      return {
        success: true,
        txid: broadcast.data.data.transaction_hash,
        amount: amount / 100000000,
        fee: fee / 100000000,
        fromAddress: state.address
      };
    } else {
      console.log(`[SEND] Broadcast failed:`, broadcast.data);
      return { success: false, error: 'Broadcast failed', details: broadcast.data };
    }
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot logged in as ${client.user.tag}`);
  console.log('[INIT] Checking 3 addresses with BLOCKCHAIR KEY:', BLOCKCHAIR_KEY ? 'YES' : 'NO');
  
  for (let addr of ADDRESSES) {
    const state = await checkAddressBalance(addr.address);
    console.log(`  [${addr.index}] ${addr.address} (${addr.type})`);
    console.log(`       Balance: ${state.total.toFixed(8)} LTC (${(state.total * ltcPrice).toFixed(2)} USD)`);
    console.log(`       Status: ${state.success ? '✅ API OK' : '❌ API FAIL'}`);
  }
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel (Owner)'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category (Owner)').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role (Owner)').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View current settings (Owner)'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address (Owner)').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket (Owner/Staff)'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-2').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Manually check payment status (Owner)'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid and deliver (Owner)'),
    new SlashCommandBuilder().setName('oauth2').setDescription('Get bot invite (Owner)'),
    new SlashCommandBuilder().setName('status').setDescription('Show address status (Owner)'),
    new SlashCommandBuilder().setName('debug').setDescription('Debug API response for address (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-2').setRequired(true))
  ];
  
  await client.application.commands.set(commands);
  setInterval(monitorMempool, 5000);
  console.log('[SYSTEM] Payment monitoring started (5s)');
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  const isOwner = interaction.user.id === OWNER_ID;
  const isStaff = settings.staffRole && interaction.member?.roles?.cache?.has(settings.staffRole);
  
  if (!isOwner && !['close'].includes(interaction.commandName)) {
    return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'close' && !isOwner && !isStaff) {
    return interaction.reply({ content: '❌ Owner or Staff only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) {
      return interaction.reply({ content: `❌ **Not setup!** Use:\n/ticketcategory\n/staffroleid\n/transcriptchannel\n/salechannel`, flags: MessageFlags.Ephemeral });
    }
    
    const embed = new EmbedBuilder()
      .setTitle('🏪 Hello welcome to Nitro Shop')
      .setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken')
      .setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_ticket').setLabel('🛒 Purchase Nitro').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  else if (interaction.commandName === 'debug') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 2) return interaction.reply({ content: '❌ Index 0-2 only', flags: MessageFlags.Ephemeral });
    
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const addrInfo = ADDRESSES.find(a => a.index === idx);
    
    // Raw API call to see what's happening
    try {
      const url = `https://api.blockchair.com/litecoin/dashboards/address/${addrInfo.address}?key=${BLOCKCHAIR_KEY}`;
      const { data } = await axios.get(url, { timeout: 15000 });
      
      const addrData = findAddressInResponse(data, addrInfo.address);
      
      let debugText = `**Debug for Address [${idx}]:** \`${addrInfo.address}\`\n\n`;
      debugText += `**API Response Keys:** ${Object.keys(data.data || {}).join(', ')}\n\n`;
      
      if (addrData) {
        debugText += `**Found Address Data:** ✅\n`;
        debugText += `Balance (satoshis): ${addrData.address?.balance || 0}\n`;
        debugText += `Balance (LTC): ${((addrData.address?.balance || 0) / 100000000).toFixed(8)}\n`;
        debugText += `UTXOs: ${(addrData.utxo || []).length}\n`;
      } else {
        debugText += `**Found Address Data:** ❌ Not found in response\n`;
        debugText += `**Raw data keys:** ${JSON.stringify(Object.keys(data.data || {})).slice(0, 500)}`;
      }
      
      await interaction.editReply({ content: debugText });
    } catch (error) {
      await interaction.editReply({ content: `**API Error:** ${error.message}` });
    }
  }
  else if (interaction.commandName === 'status') {
    let text = '**3-Address Status:**\n\n';
    for (let addr of ADDRESSES) {
      const state = await checkAddressBalance(addr.address);
      text += `**[${addr.index}]** \`${addr.address}\` (${addr.type})\n`;
      text += `Balance: **${state.total.toFixed(8)} LTC** ($${(state.total * ltcPrice).toFixed(2)})\n`;
      text += `Status: ${addr.inUse ? `🔴 In Use (Ticket: ${addr.ticketChannel?.slice(0,8)}...)` : '🟢 Available'}\n\n`;
    }
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
  else if (interaction.commandName === 'settings') {
    await interaction.reply({
      content: `**Settings:**\nCategory: ${settings.ticketCategory || '❌'}\nStaff: ${settings.staffRole || '❌'}\nTranscript: ${settings.transcriptChannel || '❌'}\nSale: ${settings.saleChannel || '❌'}`,
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'ticketcategory') { 
    settings.ticketCategory = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Category set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'staffroleid') { 
    settings.staffRole = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Staff role set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'transcriptchannel') { 
    settings.transcriptChannel = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Transcript set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'salechannel') { 
    settings.saleChannel = interaction.options.getString('id');
    await interaction.reply({ content: `✅ Sale channel set`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    
    let results = [];
    for (let i = 0; i <= 2; i++) {
      const result = await sendAllLTC(i, address);
      if (result.success) {
        results.push(`✅ Index ${i}: Sent ${result.amount.toFixed(8)} LTC from ${result.fromAddress}\nTX: ${result.txid}`);
      } else {
        results.push(`❌ Index ${i}: ${result.error}`);
      }
    }
    
    await interaction.editReply({ content: results.join('\n\n') });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 2) return interaction.reply({ content: '❌ Index 0-2 only', flags: MessageFlags.Ephemeral });
    
    const state = await getAddressState(idx);
    const addrInfo = ADDRESSES.find(a => a.index === idx);
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`**Address:** \`${state.address}\`\n**Type:** ${addrInfo.type}\n**Confirmed:** ${state.confirmed.toFixed(8)} LTC\n**Unconfirmed:** ${state.unconfirmed.toFixed(8)} LTC\n**TOTAL:** ${state.total.toFixed(8)} LTC ($${(state.total * ltcPrice).toFixed(2)})\n**Status:** ${addrInfo.inUse ? '🔴 In Use' : '🟢 Available'}`)
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
    
    let text = `**Payment Check - Address [${ticket.walletIndex}]**\n`;
    text += `Address: \`${state.address}\`\n`;
    text += `Expected: ${ticket.amountLtc} LTC\n`;
    text += `Detected: **${state.total.toFixed(8)} LTC**\n`;
    text += `Min: ${ticket.minLtc?.toFixed(8)} / Max: ${ticket.maxLtc?.toFixed(8)}\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED! Processing...**`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else if (state.total > 0 && state.total < ticket.minLtc) {
      text += `⚠️ Partial payment detected (${state.total.toFixed(8)} LTC). Need ${ticket.minLtc.toFixed(8)} LTC minimum.`;
      await interaction.editReply({ content: text });
    } else if (state.total > ticket.maxLtc) {
      text += `⚠️ Overpayment detected (${state.total.toFixed(8)} LTC). Max allowed: ${ticket.maxLtc.toFixed(8)} LTC`;
      await interaction.editReply({ content: text });
    } else {
      text += `❌ No payment detected (0 LTC)`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    
    await interaction.reply({ content: '🔄 Forcing payment...', flags: MessageFlags.Ephemeral });
    const state = await getAddressState(ticket.walletIndex);
    await processPayment(interaction.channel.id, state.total > 0 ? state.total : (ticket.amountLtc || 0.01));
  }
  else if (interaction.commandName === 'close') {
    const ticket = tickets.get(interaction.channel.id);
    if (ticket) {
      releaseAddress(interaction.channel.id);
      tickets.delete(interaction.channel.id);
    }
    await interaction.reply({ content: '🔒 Closing...', flags: MessageFlags.Ephemeral });
    await interaction.channel.delete();
  }
  else if (interaction.commandName === 'oauth2') {
    await interaction.reply({ 
      content: `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot%20applications.commands`, 
      flags: MessageFlags.Ephemeral 
    });
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) {
      return interaction.reply({ content: `❌ Not setup! Use /ticketcategory first.`, flags: MessageFlags.Ephemeral });
    }
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    const availableAddr = getAvailableAddress();
    if (!availableAddr) {
      return interaction.reply({ content: `❌ **All 3 addresses are currently in use!** Wait for a ticket to close.`, flags: MessageFlags.Ephemeral });
    }
    
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
        .setDescription(`**Payment Address:**\n\`${availableAddr.address}\`\n\nThis address is assigned specifically to your ticket.`)
        .setColor(0x00FF00)], 
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
    
    console.log(`[TICKET] ${channel.id} -> Address [${availableAddr.index}] ${availableAddr.address} is now IN USE`);
    
    await interaction.reply({ content: `✅ ${channel}\n**Using Address [${availableAddr.index}]:** \`${availableAddr.address}\``, flags: MessageFlags.Ephemeral });
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
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` },
          { name: '⚡ Auto-Detection', value: 'Active - Send LTC to the address above' }
        )
        .setColor(0xFFD700)
        .setFooter({ text: `Address [${ticket.walletIndex}] - Send ONLY LTC` })
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
        .setFooter({ text: `Address [${ticket.walletIndex}] - Send ONLY LTC` })
      ] 
    });
  }
});

async function monitorMempool() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => t.status === 'awaiting_payment');
  
  for (const [channelId, ticket] of awaiting) {
    try {
      const state = await getAddressState(ticket.walletIndex);
      console.log(`[MONITOR] Address [${ticket.walletIndex}]: ${state.total.toFixed(8)} LTC (need ${ticket.minLtc?.toFixed(8)}-${ticket.maxLtc?.toFixed(8)})`);
      
      if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
        console.log(`[MONITOR] ✅ PAYMENT DETECTED on Address [${ticket.walletIndex}]`);
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
  
  console.log(`[AUTO-SEND] From Address [${ticket.walletIndex}] to ${FEE_ADDRESS}`);
  const sendResult = await sendAllLTC(ticket.walletIndex, FEE_ADDRESS);
  
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle('✅ Payment Confirmed!')
      .setDescription(`**Address [${ticket.walletIndex}]** received: **${receivedLtc.toFixed(8)} LTC**\nAuto-send to fee wallet: ${sendResult.success ? '✅ Sent' : '❌ Failed'}\n\nDelivering your products...`)
      .setColor(0x00FF00)
    ]
  });
  
  const owner = await client.users.fetch(OWNER_ID).catch(() => null);
  if (owner) {
    owner.send({
      embeds: [new EmbedBuilder()
        .setTitle('🛒 New Order Paid')
        .setDescription(`**Product:** ${ticket.productName}\n**Qty:** ${ticket.quantity}\n**Amount:** $${ticket.amountUsd.toFixed(2)}\n**LTC Received:** ${receivedLtc.toFixed(8)}\n**Address:** [${ticket.walletIndex}] ${ticket.address}\n**Channel:** <#${channelId}>\n**Auto-send:** ${sendResult.success ? '✅' : '❌'}`)
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
        .setDescription(`**${ticket.productName}**\n**Amount:** ${ticket.quantity.toLocaleString()} members\n\nOwner has been notified and will process this manually.`)
        .setColor(0x00FF00)
      ]
    });
    return;
  }
  
  const productList = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s)).slice(0, ticket.quantity);
  if (productList.length === 0) {
    return channel.send({ embeds: [new EmbedBuilder().setTitle('❌ Out of Stock').setDescription('Please contact owner for refund.').setColor(0xFF0000)] });
  }
  
  productList.forEach(p => usedStock.add(p));
  ticket.productsSent = productList;
  ticket.delivered = true;
  
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Products')
    .setDescription(`**${ticket.productName}** x${productList.length}\nPaid: ${receivedLtc.toFixed(8)} LTC`)
    .setColor(0x00FF00);
  
  productList.forEach((item, idx) => embed.addFields({ name: `Product ${idx + 1}`, value: item }));
  
  await channel.send({ embeds: [embed] });
  console.log(`[DELIVERED] ${channelId} - ${ticket.productName} x${productList.length}`);
}

client.login(process.env.DISCORD_TOKEN);
