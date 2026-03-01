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

let ltcPrice = 75;
let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const usedStock = new Set();
let addressIndex = 0;

const PRODUCTS = {
  nitro_basic_month: { name: 'Nitro Basic Monthly', price: 1.0, stock: ['link1','link2','link3','link4','link5'] },
  nitro_basic_year: { name: 'Nitro Basic Yearly', price: 7.0, stock: ['link1','link2','link3'] },
  nitro_boost_month: { name: 'Nitro Boost Monthly', price: 2.8, stock: ['link1','link2','link3','link4'] },
  nitro_boost_year: { name: 'Nitro Boost Yearly', price: 14.0, stock: ['link1','link2'] },
  members_offline: { name: 'Members (Offline)', price: 0.7, unit: 1000, type: 'calculated' },
  members_online: { name: 'Members (Online)', price: 1.5, unit: 1000, type: 'calculated' }
};

function getLitecoinAddress(index) {
  const safeIndex = Math.max(0, Math.min(9, parseInt(index) || 0));
  
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${safeIndex}`);
  const pubkey = Buffer.from(child.publicKey);
  
  // Generate ALL address types to check which one has balance
  const legacy = bitcoin.payments.p2pkh({ pubkey, network: LITECOIN });
  const segwit = bitcoin.payments.p2sh({ redeem: bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN }), network: LITECOIN });
  const nativeSegwit = bitcoin.payments.p2wpkh({ pubkey, network: LITECOIN });
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  
  return { 
    address: legacy.address, // Default to legacy for compatibility
    segwitAddress: segwit.address, // M... address
    nativeSegwitAddress: nativeSegwit.address, // ltc1... address
    privateKey: keyPair.toWIF(), 
    index: safeIndex,
    publicKey: pubkey.toString('hex')
  };
}

async function getAddressState(address) {
  try {
    // Try the address as-is first
    let url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?transaction_details=true&key=${BLOCKCHAIR_KEY}`;
    let { data } = await axios.get(url, { timeout: 10000 });
    
    // If no data, try alternative address formats
    if (!data?.data?.[address]) {
      console.log(`[API] No data for ${address}, trying to find correct format...`);
      
      // Check if it's a known address we can map
      for (let i = 0; i <= 9; i++) {
        const wallet = getLitecoinAddress(i);
        if (wallet.address === address || wallet.segwitAddress === address || wallet.nativeSegwitAddress === address) {
          // Try all formats for this index
          const formats = [wallet.address, wallet.segwitAddress, wallet.nativeSegwitAddress];
          for (const fmt of formats) {
            if (!fmt) continue;
            try {
              url = `https://api.blockchair.com/litecoin/dashboards/address/${fmt}?transaction_details=true&key=${BLOCKCHAIR_KEY}`;
              const test = await axios.get(url, { timeout: 10000 });
              if (test?.data?.data?.[fmt]) {
                console.log(`[API] Found balance on format: ${fmt}`);
                data = test.data;
                address = fmt;
                break;
              }
            } catch (e) {}
          }
          break;
        }
      }
    }
    
    if (!data?.data?.[address]) {
      console.log(`[API] No data found for any format of ${address}`);
      return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [], address: address };
    }
    
    const addr = data.data[address].address;
    // Blockchair returns values in satoshis
    const confirmed = (addr.balance || 0) / 100000000;
    const received = (addr.received || 0) / 100000000;
    const spent = (addr.spent || 0) / 100000000;
    const unconfirmed = Math.max(0, received - spent - confirmed);
    
    const utxos = [];
    if (data.data[address].utxo && Array.isArray(data.data[address].utxo)) {
      for (const u of data.data[address].utxo) {
        if (u.value > 0) {
          utxos.push({
            txid: u.transaction_hash,
            vout: u.index,
            value: parseInt(u.value),
            script: u.script_hex,
            address: address // Keep track of which address format this UTXO belongs to
          });
        }
      }
    }
    
    console.log(`[BALANCE] ${address}: ${confirmed.toFixed(8)} LTC confirmed, ${utxos.length} UTXOs`);
    
    return { confirmed, unconfirmed, total: confirmed + unconfirmed, txs: data.data[address].transactions || [], utxos, address };
  } catch (error) {
    console.error(`[API ERROR] ${address}: ${error.message}`);
    return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [], address };
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const safeIndex = Math.max(0, Math.min(9, parseInt(fromIndex) || 0));
    const wallet = getLitecoinAddress(safeIndex);
    
    // Check ALL address formats for this index
    const formats = [
      { address: wallet.address, type: 'legacy' },
      { address: wallet.segwitAddress, type: 'segwit' },
      { address: wallet.nativeSegwitAddress, type: 'native' }
    ];
    
    let totalState = { confirmed: 0, unconfirmed: 0, total: 0, utxos: [] };
    let usedFormat = null;
    
    for (const fmt of formats) {
      if (!fmt.address) continue;
      const state = await getAddressState(fmt.address);
      if (state.total > totalState.total) {
        totalState = state;
        usedFormat = fmt;
      }
    }
    
    console.log(`[SEND] Index ${safeIndex}: Best format ${usedFormat?.type} (${usedFormat?.address}) with ${totalState.total.toFixed(8)} LTC`);
    
    if (totalState.total <= 0.0001) return { success: false, error: 'No balance on any address format' };
    if (totalState.utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    let addedInputs = 0;
    
    for (const utxo of totalState.utxos) {
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const { data } = await axios.get(txUrl, { timeout: 10000 });
        
        if (data?.data?.[utxo.txid]?.raw_transaction) {
          const rawTx = Buffer.from(data.data[utxo.txid].raw_transaction, 'hex');
          
          // Determine input type based on address format
          const inputData = {
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: rawTx
          };
          
          // If SegWit, add witnessUtxo
          if (usedFormat.type !== 'legacy') {
            inputData.witnessUtxo = {
              script: Buffer.from(utxo.script, 'hex'),
              value: utxo.value
            };
          }
          
          psbt.addInput(inputData);
          totalInput += utxo.value;
          addedInputs++;
        }
      } catch (e) {
        console.log(`[SEND] Failed to add input ${utxo.txid}: ${e.message}`);
        continue;
      }
    }
    
    if (addedInputs === 0) return { success: false, error: 'No spendable inputs found' };
    
    const fee = 100000; // 0.001 LTC
    const amount = totalInput - fee;
    
    if (amount <= 0) return { success: false, error: `Amount too small for fee` };
    
    psbt.addOutput({ address: toAddress, value: amount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (e) {
        console.log(`[SEND] Failed to sign input ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    const broadcast = await axios.post(
      `https://api.blockchair.com/litecoin/push/transaction?key=${BLOCKCHAIR_KEY}`,
      { data: txHex },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    
    if (broadcast.data?.data?.transaction_hash) {
      return { 
        success: true, 
        txid: broadcast.data.data.transaction_hash, 
        amount: amount / 100000000, 
        fee: fee / 100000000,
        fromAddress: usedFormat.address
      };
    } else {
      return { success: false, error: 'Broadcast failed', details: broadcast.data };
    }
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel (Owner)'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category (Owner)').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role (Owner)').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View current settings (Owner)'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address (Owner)').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket (Owner/Staff)'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-9').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Manually check payment status (Owner)'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid and deliver (Owner)'),
    new SlashCommandBuilder().setName('oauth2').setDescription('Get bot invite (Owner)'),
    new SlashCommandBuilder().setName('debug').setDescription('Debug wallet addresses (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-9').setRequired(true))
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
  
  if (interaction.commandName === 'close' && !is [], address: address };
    }
    
    const addr = data.data[address].address;
    // Blockchair returns values in satoshis
    const confirmed = (addr.balance || 0) / 100000000;
    const received = (addr.received || 0) / 100000000;
    const spent = (addr.spent || 0) / 100000000;
    const unconfirmed = Math.max(0, received - spent - confirmed);
    
    const utxos = [];
    if (data.data[address].utxo && Array.isArray(data.data[address].utxo)) {
      for (const u of data.data[address].utxo) {
        if (u.value > 0) {
          utxos.push({
            txid: u.transaction_hash,
            vout: u.index,
            value: parseInt(u.value),
            script: u.script_hex,
            address: address // Keep track of which address format this UTXO belongs to
          });
        }
      }
    }
    
    console.log(`[BALANCE] ${address}: ${confirmed.toFixed(8)} LTC confirmed, ${utxos.length} UTXOs`);
    
    return { confirmed, unconfirmed, total: confirmed + unconfirmed, txs: data.data[address].transactions || [], utxos, address };
  } catch (error) {
    console.error(`[API ERROR] ${address}: ${error.message}`);
    return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [], address };
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const safeIndex = Math.max(0, Math.min(9, parseInt(fromIndex) || 0));
    const wallet = getLitecoinAddress(safeIndex);
    
    // Check ALL address formats for this index
    const formats = [
      { address: wallet.address, type: 'legacy' },
      { address: wallet.segwitAddress, type: 'segwit' },
      { address: wallet.nativeSegwitAddress, type: 'native' }
    ];
    
    let totalState = { confirmed: 0, unconfirmed: 0, total: 0, utxos: [] };
    let usedFormat = null;
    
    for (const fmt of formats) {
      if (!fmt.address) continue;
      const state = await getAddressState(fmt.address);
      if (state.total > totalState.total) {
        totalState = state;
        usedFormat = fmt;
      }
    }
    
    console.log(`[SEND] Index ${safeIndex}: Best format ${usedFormat?.type} (${usedFormat?.address}) with ${totalState.total.toFixed(8)} LTC`);
    
    if (totalState.total <= 0.0001) return { success: false, error: 'No balance on any address format' };
    if (totalState.utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    let addedInputs = 0;
    
    for (const utxo of totalState.utxos) {
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const { data } = await axios.get(txUrl, { timeout: 10000 });
        
        if (data?.data?.[utxo.txid]?.raw_transaction) {
          const rawTx = Buffer.from(data.data[utxo.txid].raw_transaction, 'hex');
          
          // Determine input type based on address format
          const inputData = {
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: rawTx
          };
          
          // If SegWit, add witnessUtxo
          if (usedFormat.type !== 'legacy') {
            inputData.witnessUtxo = {
              script: Buffer.from(utxo.script, 'hex'),
              value: utxo.value
            };
          }
          
          psbt.addInput(inputData);
          totalInput += utxo.value;
          addedInputs++;
        }
      } catch (e) {
        console.log(`[SEND] Failed to add input ${utxo.txid}: ${e.message}`);
        continue;
      }
    }
    
    if (addedInputs === 0) return { success: false, error: 'No spendable inputs found' };
    
    const fee = 100000; // 0.001 LTC
    const amount = totalInput - fee;
    
    if (amount <= 0) return { success: false, error: `Amount too small for fee` };
    
    psbt.addOutput({ address: toAddress, value: amount });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (e) {
        console.log(`[SEND] Failed to sign input ${i}: ${e.message}`);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    const broadcast = await axios.post(
      `https://api.blockchair.com/litecoin/push/transaction?key=${BLOCKCHAIR_KEY}`,
      { data: txHex },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    
    if (broadcast.data?.data?.transaction_hash) {
      return { 
        success: true, 
        txid: broadcast.data.data.transaction_hash, 
        amount: amount / 100000000, 
        fee: fee / 100000000,
        fromAddress: usedFormat.address
      };
    } else {
      return { success: false, error: 'Broadcast failed', details: broadcast.data };
    }
  } catch (error) {
    console.error(`[SEND ERROR]`, error);
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel (Owner)'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category (Owner)').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role (Owner)').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('settings').setDescription('View current settings (Owner)'),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address (Owner)').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket (Owner/Staff)'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-9').setRequired(true)),
    new SlashCommandBuilder().setName('check').setDescription('Manually check payment status (Owner)'),
    new SlashCommandBuilder().setName('forcepay').setDescription('Force mark as paid and deliver (Owner)'),
    new SlashCommandBuilder().setName('oauth2').setDescription('Get bot invite (Owner)'),
    new SlashCommandBuilder().setName('debug').setDescription('Debug wallet addresses (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-9').setRequired(true))
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
  
  if (interaction.commandName === 'close' && !isOwner && !isStaff) {
    return interaction.reply({ content: '❌ Owner or Staff only', flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.commandName === 'panel') {
    if (!settings.ticketCategory) {
      return interaction.reply({ 
        content: `❌ **Not setup!** Use:\n1. \`/ticketcategory\`\n2. \`/staffroleid\`\n3. \`/transcriptchannel\`\n4. \`/salechannel\``, 
        flags: MessageFlags.Ephemeral 
      });
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
    if (idx < 0 || idx > 9) return interaction.reply({ content: '❌ Index 0-9 only', flags: MessageFlags.Ephemeral });
    
    const wallet = getLitecoinAddress(idx);
    
    // Check all formats
    const legacyState = await getAddressState(wallet.address);
    const segwitState = await getAddressState(wallet.segwitAddress);
    const nativeState = await getAddressState(wallet.nativeSegwitAddress);
    
    const embed = new EmbedBuilder()
      .setTitle(`🔍 Debug Wallet ${idx}`)
      .addFields(
        { name: 'Legacy (L...)', value: `\`${wallet.address}\`\nBalance: ${legacyState.total.toFixed(8)} LTC`, inline: false },
        { name: 'SegWit (M...)', value: `\`${wallet.segwitAddress}\`\nBalance: ${segwitState.total.toFixed(8)} LTC`, inline: false },
        { name: 'Native SegWit (ltc1...)', value: `\`${wallet.nativeSegwitAddress}\`\nBalance: ${nativeState.total.toFixed(8)} LTC`, inline: false }
      )
      .setColor(0x00FF00);
    
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
    
    const results = [];
    for (let i = 0; i <= 9; i++) {
      const result = await sendAllLTC(i, address);
      if (result.success || result.balance > 0) {
        results.push({ index: i, ...result });
      }
    }
    
    let text = `**Sweep Results:**\n`;
    for (const r of results) {
      if (r.success) {
        text += `✅ Index ${r.index} (${r.fromAddress?.slice(0,10)}...): Sent ${r.amount?.toFixed(8)} LTC\n`;
      } else if (r.balance > 0) {
        text += `⚠️ Index ${r.index}: ${r.balance.toFixed(8)} LTC but failed to send (${r.error})\n`;
      }
    }
    if (results.length === 0) text += 'No balances found on indices 0-9';
    await interaction.editReply({ content: text });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 9) return interaction.reply({ content: '❌ Index 0-9 only', flags: MessageFlags.Ephemeral });
    
    const wallet = getLitecoinAddress(idx);
    
    // Check all formats and pick the one with balance
    const formats = [
      { name: 'Legacy', addr: wallet.address },
      { name: 'SegWit', addr: wallet.segwitAddress },
      { name: 'Native', addr: wallet.nativeSegwitAddress }
    ];
    
    let bestState = null;
    let bestFormat = null;
    
    for (const fmt of formats) {
      const state = await getAddressState(fmt.addr);
      if (!bestState || state.total > bestState.total) {
        bestState = state;
        bestFormat = fmt;
      }
    }
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx} (${bestFormat.name})`)
        .setDescription(`Address: \`${bestFormat.addr}\`\nConfirmed: ${bestState.confirmed.toFixed(8)} LTC\nUnconfirmed: ${bestState.unconfirmed.toFixed(8)} LTC\n**Total: ${bestState.total.toFixed(8)} LTC**`)
        .setColor(bestState.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    
    await interaction.deferReply();
    
    // Check the specific address stored in ticket
    const state = await getAddressState(ticket.address);
    
    let text = `**Payment Check**\nAddress: \`${ticket.address}\`\nExpected: ${ticket.amountLtc} LTC\nDetected: ${state.total.toFixed(8)} LTC\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED!**`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else {
      text += `❌ Waiting for payment...`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    
    await interaction.reply({ content: '🔄 Forcing...', flags: MessageFlags.Ephemeral });
    await processPayment(interaction.channel.id, ticket.amountLtc || 0.01);
  }
  else if (interaction.commandName === 'close') {
    const ticket = tickets.get(interaction.channel.id);
    tickets.delete(interaction.channel.id);
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
    
    if (addressIndex > 9) addressIndex = 0;
    
    const wallet = getLitecoinAddress(addressIndex);
    
    // Use the address format that has balance, default to legacy
    const legacyState = await getAddressState(wallet.address);
    const segwitState = await getAddressState(wallet.segwitAddress);
    
    let useAddress = wallet.address;
    if (segwitState.total > legacyState.total) useAddress = wallet.segwitAddress;
    
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
      embeds: [new EmbedBuilder().setTitle('🛒 Select Product').setColor(0x00FF00)], 
      components: [row] 
    });
    
    tickets.set(channel.id, { 
      userId: interaction.user.id, 
      status: 'selecting', 
      channelId: channel.id,
      walletIndex: addressIndex,
      address: useAddress,
      privateKey: wallet.privateKey
    });
    
    console.log(`[TICKET] ${channel.id} index ${addressIndex}, address: ${useAddress}`);
    addressIndex++;
    if (addressIndex > 9) addressIndex = 0;
    
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
          { name: '📋 LTC Address', value: `\`${ticket.address}\`` },
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
        .addFields({ name: '📋 LTC Address', value: `\`${ticket.address}\`` })
        .setColor(0xFFD700)
      ] 
    });
  }
});

async function monitorMempool() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => t.status === 'awaiting_payment');
  
  for (const [channelId, ticket] of awaiting) {
    try {
      const state = await getAddressState(ticket.address);
      console.log(`[MONITOR] ${ticket.address}: ${state.total.toFixed(8)} LTC`);
      
      if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
        console.log(`[MONITOR] ✅ PAYMENT DETECTED`);
        await processPayment(channelId, state.total);
      }
    } catch (error) {
      console.error(`[MONITOR] Error:`, error.message);
