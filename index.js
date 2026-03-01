require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  SlashCommandBuilder, 
  PermissionsBitField, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  StringSelectMenuBuilder, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ChannelType, 
  MessageFlags 
} = require('discord.js');
const axios = require('axios');
const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const ECPairFactory = require('ecpair');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const bip32 = BIP32Factory(ecc);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// ========== CONFIGURATION ==========
const OWNER_ID = '1459833646130401429';
const FEE_ADDRESS = 'LeDdjh2BDbPkrhG2pkWBko3HRdKQzprJMX';
const BLOCKCHAIR_KEY = process.env.BLOCKCHAIR_KEY;
const BOT_MNEMONIC = process.env.BOT_MNEMONIC;
const TOLERANCE_USD = 0.10;

const LITECOIN = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

const RATE_LIMIT = {
  maxRequests: 28,
  windowMs: 60000,
  current: 0,
  resetTime: Date.now() + 60000
};

const salesStats = {
  totalSales: 0,
  totalRevenue: 0,
  productSales: {
    nitro_basic_month: { count: 0, revenue: 0 },
    nitro_basic_year: { count: 0, revenue: 0 },
    nitro_boost_month: { count: 0, revenue: 0 },
    nitro_boost_year: { count: 0, revenue: 0 }
  }
};

// Nitro Products - Fixed stock arrays
const PRODUCTS = {
  nitro_basic_month: {
    name: 'Nitro Basic Monthly',
    price: 1.0,
    stock: [
      'https://discord.gift/ABC123XYZ789',
      'https://discord.gift/DEF456UVW012',
      'https://discord.gift/GHI789RST345',
      'https://discord.gift/JKL012MNO678',
      'https://discord.gift/MNO345PQR901',
      'https://discord.gift/PQR678STU234',
      'https://discord.gift/STU901VWX567',
      'https://discord.gift/VWX234YZA890',
      'https://discord.gift/YZA567BCD123',
      'https://discord.gift/BCD890EFG456'
    ]
  },
  nitro_basic_year: {
    name: 'Nitro Basic Yearly',
    price: 7.0,
    stock: [
      'https://discord.gift/YEAR123ABC456',
      'https://discord.gift/YEAR789DEF012',
      'https://discord.gift/YEAR345GHI678',
      'https://discord.gift/YEAR901JKL234',
      'https://discord.gift/YEAR567MNO890'
    ]
  },
  nitro_boost_month: {
    name: 'Nitro Boost Monthly',
    price: 2.8,
    stock: [
      'https://discord.gift/BOOST123ABC789',
      'https://discord.gift/BOOST456DEF012',
      'https://discord.gift/BOOST789GHI345',
      'https://discord.gift/BOOST012JKL678',
      'https://discord.gift/BOOST345MNO901',
      'https://discord.gift/BOOST678PQR234',
      'https://discord.gift/BOOST901STU567',
      'https://discord.gift/BOOST234VWX890'
    ]
  },
  nitro_boost_year: {
    name: 'Nitro Boost Yearly',
    price: 14.0,
    stock: [
      'https://discord.gift/BOOSTYEAR123ABC',
      'https://discord.gift/BOOSTYEAR456DEF',
      'https://discord.gift/BOOSTYEAR789GHI',
      'https://discord.gift/BOOSTYEAR012JKL'
    ]
  }
};

const tickets = new Map();
const usedStock = new Set();
const addressIndex = { current: 0, max: 10 };
let settings = { 
  ticketCategory: null, 
  staffRole: null, 
  transcriptChannel: null, 
  saleChannel: null 
};
let ltcPrice = 75;
let lastPriceUpdate = 0;

async function makeApiRequest(url, priority = false) {
  if (Date.now() > RATE_LIMIT.resetTime) {
    RATE_LIMIT.current = 0;
    RATE_LIMIT.resetTime = Date.now() + RATE_LIMIT.windowMs;
  }
  
  if (RATE_LIMIT.current >= RATE_LIMIT.maxRequests) {
    const waitTime = RATE_LIMIT.resetTime - Date.now();
    if (!priority && waitTime > 5000) {
      console.log(`[RATE LIMIT] Skipping non-priority request`);
      return null;
    }
    console.log(`[RATE LIMIT] Waiting ${waitTime}ms...`);
    await new Promise(r => setTimeout(r, waitTime + 1000));
    RATE_LIMIT.current = 0;
    RATE_LIMIT.resetTime = Date.now() + RATE_LIMIT.windowMs;
  }
  
  RATE_LIMIT.current++;
  try {
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log('[RATE LIMIT] 429 received, backing off...');
      await new Promise(r => setTimeout(r, 10000));
      return makeApiRequest(url, priority);
    }
    throw error;
  }
}

function getLitecoinAddress(index) {
  if (index >= addressIndex.max) {
    console.log(`[WALLET] Index ${index} exceeds max ${addressIndex.max}, wrapping to 0`);
    index = index % addressIndex.max;
  }
  
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  
  const { address } = bitcoin.payments.p2pkh({
    pubkey: Buffer.from(child.publicKey),
    network: LITECOIN
  });
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  const privateKeyWIF = keyPair.toWIF();
  
  return {
    address: address,
    privateKey: privateKeyWIF,
    index: index
  };
}

async function getAddressState(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?transaction_details=true&key=${BLOCKCHAIR_KEY}`;
    const data = await makeApiRequest(url, true);
    
    if (!data?.data?.[address]) return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
    
    const addr = data.data[address].address;
    const confirmed = addr.balance / 100000000;
    const received = addr.received / 100000000;
    const spent = addr.spent / 100000000;
    const unconfirmed = Math.max(0, received - spent - confirmed);
    
    const utxos = data.data[address].utxo || [];
    
    return {
      confirmed: confirmed,
      unconfirmed: unconfirmed,
      total: confirmed + unconfirmed,
      txs: data.data[address].transactions || [],
      utxos: utxos.map(u => ({
        txid: u.transaction_hash,
        vout: u.index,
        value: u.value,
        script: u.script_hex
      }))
    };
  } catch (error) {
    console.error('Address check error:', error.message);
    return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
  }
}

async function updateLtcPrice() {
  if (Date.now() - lastPriceUpdate < 300000) return;
  try {
    const data = await makeApiRequest('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd');
    if (data?.litecoin?.usd) {
      ltcPrice = data.litecoin.usd;
      lastPriceUpdate = Date.now();
      console.log(`[PRICE] LTC: $${ltcPrice}`);
    }
  } catch (error) {
    console.log('[PRICE] Using cached:', ltcPrice);
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const wallet = getLitecoinAddress(fromIndex);
    const state = await getAddressState(wallet.address);
    
    if (state.confirmed <= 0) {
      return { success: false, error: 'No confirmed balance' };
    }
    
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      if (!utxo.txid || typeof utxo.vout !== 'number') continue;
      
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const txData = await makeApiRequest(txUrl);
        
        if (!txData?.data?.[utxo.txid]?.raw_transaction) continue;
        
        const rawTx = txData.data[utxo.txid].raw_transaction;
        
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(rawTx, 'hex')
        });
        
        totalInput += parseInt(utxo.value);
      } catch (e) {
        console.log(`[SEND] Failed to get raw tx for ${utxo.txid}:`, e.message);
        continue;
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'No spendable inputs' };
    }
    
    const fee = 100000;
    const amount = totalInput - fee;
    
    if (amount <= 0) {
      return { success: false, error: 'Amount too small for fee' };
    }
    
    psbt.addOutput({
      address: toAddress,
      value: amount
    });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (e) {
        console.log(`[SEND] Failed to sign input ${i}:`, e.message);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    const broadcastUrl = 'https://api.blockchair.com/litecoin/push/transaction';
    const response = await axios.post(broadcastUrl, { data: txHex }, {
      headers: { 'Content-Type': 'application/json' },
      params: { key: BLOCKCHAIR_KEY },
      timeout: 15000
    });
    
    if (response.data?.data?.transaction_hash) {
      return {
        success: true,
        txid: response.data.data.transaction_hash,
        amount: amount / 100000000,
        fee: fee / 100000000
      };
    } else {
      return { success: false, error: 'Broadcast failed', details: response.data };
    }
    
  } catch (error) {
    console.error('[SEND] Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function checkAndSweepIndex(index, toAddress) {
  try {
    const wallet = getLitecoinAddress(index);
    const state = await getAddressState(wallet.address);
    
    if (state.confirmed > 0.001) {
      console.log(`[SWEEP] Found balance at index ${index} (${wallet.address}) - ${state.confirmed} LTC`);
      const result = await sendAllLTC(index, toAddress);
      return { index: index, address: wallet.address, ...result };
    }
  } catch (e) {
    console.log(`[SWEEP] Error on index ${index}:`, e.message);
  }
  return null;
}

async function sweepAllWallets(toAddress) {
  const results = [];
  
  const indicesToCheck = addressIndex.max;
  const batchSize = 5;
  
  for (let batchStart = 0; batchStart < indicesToCheck; batchStart += batchSize) {
    const batch = [];
    for (let i = batchStart; i < Math.min(batchStart + batchSize, indicesToCheck); i++) {
      batch.push(checkAndSweepIndex(i, toAddress));
    }
    
    const batchResults = await Promise.all(batch);
    results.push(...batchResults.filter(r => r !== null));
  }
  
  return results;
}

function getStockInfo(productKey) {
  const product = PRODUCTS[productKey];
  const totalStock = product.stock.length;
  const usedCount = product.stock.filter(item => usedStock.has(item)).length;
  const available = totalStock - usedCount;
  
  return {
    name: product.name,
    total: totalStock,
    used: usedCount,
    available: available,
    price: product.price
  };
}

function logSale(productKey, quantity, amountUsd) {
  salesStats.totalSales++;
  salesStats.totalRevenue += amountUsd;
  
  if (salesStats.productSales[productKey]) {
    salesStats.productSales[productKey].count += quantity;
    salesStats.productSales[productKey].revenue += amountUsd;
  }
  
  if (settings.saleChannel) {
    const channel = client.channels.cache.get(settings.saleChannel);
    if (channel) {
      channel.send({
        embeds: [new EmbedBuilder()
          .setTitle('💰 New Nitro Sale!')
          .setDescription(`**${PRODUCTS[productKey].name}** x${quantity}`)
          .addFields(
            { name: 'Amount', value: `$${amountUsd.toFixed(2)}`, inline: true },
            { name: 'Total Sales', value: `${salesStats.totalSales}`, inline: true },
            { name: 'Total Revenue', value: `$${salesStats.totalRevenue.toFixed(2)}`, inline: true }
          )
          .setColor(0x00FF00)
          .setTimestamp()
        ]
      }).catch(() => {});
    }
  }
}

client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Spawn Nitro shop panel (Owner)')
      .addStringOption(o => o.setName('image').setDescription('Optional image URL')),
    
    new SlashCommandBuilder()
      .setName('ticketcategory')
      .setDescription('Set ticket category (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('staffroleid')
      .setDescription('Set staff role (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('transcriptchannel')
      .setDescription('Set transcript channel (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('salechannel')
      .setDescription('Set sales log channel (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Send all LTC to address (Owner)')
      .addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('close')
      .setDescription('Close this ticket (Owner/Staff)'),
    
    new SlashCommandBuilder()
      .setName('stock')
      .setDescription('Check all Nitro stock (Owner)'),
    
    new SlashCommandBuilder()
      .setName('oauth2')
      .setDescription('Get bot invite link (Owner)')
  ];
  
  await client.application.commands.set(commands);
  console.log('✅ Commands registered');
  
  await updateLtcPrice();
  
  setInterval(monitorMempool, 5000);
  setInterval(verifyConfirmations, 30000);
});

client.on('interactionCreate', async (interaction) => {
  try {
   5000) {
      console.log(`[RATE LIMIT] Skipping non-priority request`);
      return null;
    }
    console.log(`[RATE LIMIT] Waiting ${waitTime}ms...`);
    await new Promise(r => setTimeout(r, waitTime + 1000));
    RATE_LIMIT.current = 0;
    RATE_LIMIT.resetTime = Date.now() + RATE_LIMIT.windowMs;
  }
  
  RATE_LIMIT.current++;
  try {
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log('[RATE LIMIT] 429 received, backing off...');
      await new Promise(r => setTimeout(r, 10000));
      return makeApiRequest(url, priority);
    }
    throw error;
  }
}

function getLitecoinAddress(index) {
  if (index >= addressIndex.max) {
    console.log(`[WALLET] Index ${index} exceeds max ${addressIndex.max}, wrapping to 0`);
    index = index % addressIndex.max;
  }
  
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  
  const { address } = bitcoin.payments.p2pkh({
    pubkey: Buffer.from(child.publicKey),
    network: LITECOIN
  });
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  const privateKeyWIF = keyPair.toWIF();
  
  return {
    address: address,
    privateKey: privateKeyWIF,
    index: index
  };
}

async function getAddressState(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?transaction_details=true&key=${BLOCKCHAIR_KEY}`;
    const data = await makeApiRequest(url, true);
    
    if (!data?.data?.[address]) return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
    
    const addr = data.data[address].address;
    const confirmed = addr.balance / 100000000;
    const received = addr.received / 100000000;
    const spent = addr.spent / 100000000;
    const unconfirmed = Math.max(0, received - spent - confirmed);
    
    const utxos = data.data[address].utxo || [];
    
    return {
      confirmed: confirmed,
      unconfirmed: unconfirmed,
      total: confirmed + unconfirmed,
      txs: data.data[address].transactions || [],
      utxos: utxos.map(u => ({
        txid: u.transaction_hash,
        vout: u.index,
        value: u.value,
        script: u.script_hex
      }))
    };
  } catch (error) {
    console.error('Address check error:', error.message);
    return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
  }
}

async function updateLtcPrice() {
  if (Date.now() - lastPriceUpdate < 300000) return;
  try {
    const data = await makeApiRequest('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd');
    if (data?.litecoin?.usd) {
      ltcPrice = data.litecoin.usd;
      lastPriceUpdate = Date.now();
      console.log(`[PRICE] LTC: $${ltcPrice}`);
    }
  } catch (error) {
    console.log('[PRICE] Using cached:', ltcPrice);
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const wallet = getLitecoinAddress(fromIndex);
    const state = await getAddressState(wallet.address);
    
    if (state.confirmed <= 0) {
      return { success: false, error: 'No confirmed balance' };
    }
    
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      if (!utxo.txid || typeof utxo.vout !== 'number') continue;
      
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const txData = await makeApiRequest(txUrl);
        
        if (!txData?.data?.[utxo.txid]?.raw_transaction) continue;
        
        const rawTx = txData.data[utxo.txid].raw_transaction;
        
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(rawTx, 'hex')
        });
        
        totalInput += parseInt(utxo.value);
      } catch (e) {
        console.log(`[SEND] Failed to get raw tx for ${utxo.txid}:`, e.message);
        continue;
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'No spendable inputs' };
    }
    
    const fee = 100000;
    const amount = totalInput - fee;
    
    if (amount <= 0) {
      return { success: false, error: 'Amount too small for fee' };
    }
    
    psbt.addOutput({
      address: toAddress,
      value: amount
    });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (e) {
        console.log(`[SEND] Failed to sign input ${i}:`, e.message);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    const broadcastUrl = 'https://api.blockchair.com/litecoin/push/transaction';
    const response = await axios.post(broadcastUrl, { data: txHex }, {
      headers: { 'Content-Type': 'application/json' },
      params: { key: BLOCKCHAIR_KEY },
      timeout: 15000
    });
    
    if (response.data?.data?.transaction_hash) {
      return {
        success: true,
        txid: response.data.data.transaction_hash,
        amount: amount / 100000000,
        fee: fee / 100000000
      };
    } else {
      return { success: false, error: 'Broadcast failed', details: response.data };
    }
    
  } catch (error) {
    console.error('[SEND] Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function checkAndSweepIndex(index, toAddress) {
  try {
    const wallet = getLitecoinAddress(index);
    const state = await getAddressState(wallet.address);
    
    if (state.confirmed > 0.001) {
      console.log(`[SWEEP] Found balance at index ${index} (${wallet.address}) - ${state.confirmed} LTC`);
      const result = await sendAllLTC(index, toAddress);
      return { index: index, address: wallet.address, ...result };
    }
  } catch (e) {
    console.log(`[SWEEP] Error on index ${index}:`, e.message);
  }
  return null;
}

async function sweepAllWallets(toAddress) {
  const results = [];
  
  const indicesToCheck = addressIndex.max;
  const batchSize = 5;
  
  for (let batchStart = 0; batchStart < indicesToCheck; batchStart += batchSize) {
    const batch = [];
    for (let i = batchStart; i < Math.min(batchStart + batchSize, indicesToCheck); i++) {
      batch.push(checkAndSweepIndex(i, toAddress));
    }
    
    const batchResults = await Promise.all(batch);
    results.push(...batchResults.filter(r => r !== null));
  }
  
  return results;
}

function getStockInfo(productKey) {
  const product = PRODUCTS[productKey];
  const totalStock = product.stock.length;
  const usedCount = product.stock.filter(item => usedStock.has(item)).length;
  const available = totalStock - usedCount;
  
  return {
    name: product.name,
    total: totalStock,
    used: usedCount,
    available: available,
    price: product.price
  };
}

function logSale(productKey, quantity, amountUsd) {
  salesStats.totalSales++;
  salesStats.totalRevenue += amountUsd;
  
  if (salesStats.productSales[productKey]) {
    salesStats.productSales[productKey].count += quantity;
    salesStats.productSales[productKey].revenue += amountUsd;
  }
  
  if (settings.saleChannel) {
    const channel = client.channels.cache.get(settings.saleChannel);
    if (channel) {
      channel.send({
        embeds: [new EmbedBuilder()
          .setTitle('💰 New Nitro Sale!')
          .setDescription(`**${PRODUCTS[productKey].name}** x${quantity}`)
          .addFields(
            { name: 'Amount', value: `$${amountUsd.toFixed(2)}`, inline: true },
            { name: 'Total Sales', value: `${salesStats.totalSales}`, inline: true },
            { name: 'Total Revenue', value: `$${salesStats.totalRevenue.toFixed(2)}`, inline: true }
          )
          .setColor(0x00FF00)
          .setTimestamp()
        ]
      }).catch(() => {});
    }
  }
}

client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Spawn Nitro shop panel (Owner)')
      .addStringOption(o => o.setName('image').setDescription('Optional image URL')),
    
    new SlashCommandBuilder()
      .setName('ticketcategory')
      .setDescription('Set ticket category (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('staffroleid')
      .setDescription('Set staff role (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('transcriptchannel')
      .setDescription('Set transcript channel (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('salechannel')
      .setDescription('Set sales log channel (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Send all LTC to address (Owner)')
      .addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('close')
      .setDescription('Close this ticket (Owner/Staff)'),
    
    new SlashCommandBuilder()
      .setName('stock')
      .setDescription('Check all Nitro stock (Owner)'),
    
    new SlashCommandBuilder()
      .setName('oauth2')
      .setDescription('Get bot invite link (Owner)')
  ];
  
  await client.application.commands.set(commands);
  console.log('✅ Commands registered');
  
  await updateLtcPrice();
  
  setInterval(monitorMempool, 5000);
  setInterval(verifyConfirmations, 30000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (['panel', 'ticketcategory', 'staffroleid', 'transcriptchannel', 'salechannel', 'send', 'stock', 'oauth2'].includes(interaction.commandName)) {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Owner only.', flags: MessageFlags.Ephemeral });
        }
      }
      
      if (interaction.commandName === 'close') {
        const member = interaction.member;
        const isOwner = interaction.user.id === OWNER_ID;
        const isStaff = settings.staffRole && member.roles.cache.has(settings.staffRole);
        
        if (!isOwner && !isStaff) {
          return interaction.reply({ content: '❌ Owner or Staff only.', flags: MessageFlags.Ephemeral });
        }
      }
      
      if (interaction.commandName === 'panel') {
        const embed = new EmbedBuilder()
          .setTitle('🏪 Hello welcome to Nitro Shop')
          .setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken')
          .setColor(0x5865F2)
          .setTimestamp();
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('open_ticket')
            .setLabel('🛒 Purchase Nitro')
            .setStyle(ButtonStyle.Success)
        );
        
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      
      else if (interaction.commandName === 'ticketcategory') {
        settings.ticketCategory = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Ticket category set to: ${settings.ticketCategory}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'staffroleid') {
        settings.staffRole = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Staff role set to: ${settings.staffRole}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'transcriptchannel') {
        settings.transcriptChannel = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Transcript channel set to: ${settings.transcriptChannel}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'salechannel') {
        settings.saleChannel = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Sales channel set to: ${settings.saleChannel}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'send') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        const address = interaction.options.getString('address');
        
        try {
          bitcoin.address.toOutputScript(address, LITECOIN);
        } catch (e) {
          return interaction.editReply({ content: '❌ Invalid Litecoin address!' });
        }
        
        await interaction.editReply({ content: '🔄 Scanning all 10 wallet indices... This may take 10-15 seconds.' });
        
        const results = await sweepAllWallets(address);
        
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const totalSent = results.filter(r => r.success).reduce((a, b) => a + (b.amount || 0), 0);
        
        let resultText = `**Sweep Complete!**\n\n`;
        resultText += `✅ Successful: ${successCount}\n`;
        resultText += `❌ Failed: ${failCount}\n`;
        resultText += `💰 Total Sent: ${totalSent.toFixed(8)} LTC\n\n`;
        
        if (results.length > 0) {
          resultText += `**Details:**\n`;
          for (const r of results.slice(0, 10)) {
            if (r.success) {
              resultText += `• Index ${r.index}: ${r.amount?.toFixed(8)} LTC - [${r.txid?.substring(0, 16)}...](https://blockchair.com/litecoin/transaction/${r.txid})\n`;
            } else {
              resultText += `• Index ${r.index}: ❌ ${r.error}\n`;
            }
          }
          if (results.length > 10) resultText += `... and ${results.length - 10} more`;
        } else {
          resultText += `No wallets with balance found in indices 0-9.`;
        }
        
        await interaction.editReply({ content: resultText });
      }
      
      else if (interaction.commandName === 'close') {
        const ticket = tickets.get(interaction.channel.id);
        
        if (ticket && settings.transcriptChannel) {
          const tChannel = await interaction.guild.channels.fetch(settings.transcriptChannel).catch(() => null);
          if (tChannel) {
            await tChannel.send({ 
              embeds: [new EmbedBuilder()
                .setTitle('📝 Ticket Closed')
                .addFields(
                  { name: 'User', value: `<@${ticket.userId}>`, inline: true },
                  { name: 'Product', value: ticket.productName || 'N/A', inline: true },
                  { name: 'Amount', value: `$${ticket.amountUsd || 0}`, inline: true },
                  { name: 'Status', value: ticket.status, inline: true },
                  { name: 'Closed By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp()
              ] 
            });
          }
        }
        
        await interaction.reply({ content: '🔒 Closing ticket...', flags: MessageFlags.Ephemeral });
        await interaction.channel.delete();
      }
      
      else if (interaction.commandName === 'stock') {
        const embed = new EmbedBuilder()
          .setTitle('📦 Nitro Stock Overview')
          .setColor(0x5865F2)
          .setTimestamp();
        
        for (const [key, product] of Object.entries(PRODUCTS)) {
          const info = getStockInfo(key);
          embed.addFields({
            name: `${product.name} ($${product.price})`,
            value: `Available: ${info.available}/${info.total}`,
            inline: true
          });
        }
        
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'oauth2') {
        const botId = client.user.id;
        const inviteLink = `https://discord.com/oauth2/authorize?client_id=${botId}&permissions=8&scope=bot%20applications.commands`;
        
        const embed = new EmbedBuilder()
          .setTitle('🤖 Bot Invite Link')
          .setDescription(`Click below to invite ${client.user.username} to your server:`)
          .addFields(
            { name: 'Invite URL', value: `[Click Here to Invite](${inviteLink})` },
            { name: 'Bot ID', value: botId }
          )
          .setColor(0x5865F2)
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed], flags:5000) {
      console.log(`[RATE LIMIT] Skipping non-priority request`);
      return null;
    }
    console.log(`[RATE LIMIT] Waiting ${waitTime}ms...`);
    await new Promise(r => setTimeout(r, waitTime + 1000));
    RATE_LIMIT.current = 0;
    RATE_LIMIT.resetTime = Date.now() + RATE_LIMIT.windowMs;
  }
  
  RATE_LIMIT.current++;
  try {
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  } catch (error) {
    if (error.response?.status === 429) {
      console.log('[RATE LIMIT] 429 received, backing off...');
      await new Promise(r => setTimeout(r, 10000));
      return makeApiRequest(url, priority);
    }
    throw error;
  }
}

function getLitecoinAddress(index) {
  if (index >= addressIndex.max) {
    console.log(`[WALLET] Index ${index} exceeds max ${addressIndex.max}, wrapping to 0`);
    index = index % addressIndex.max;
  }
  
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  
  const { address } = bitcoin.payments.p2pkh({
    pubkey: Buffer.from(child.publicKey),
    network: LITECOIN
  });
  
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  const privateKeyWIF = keyPair.toWIF();
  
  return {
    address: address,
    privateKey: privateKeyWIF,
    index: index
  };
}

async function getAddressState(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?transaction_details=true&key=${BLOCKCHAIR_KEY}`;
    const data = await makeApiRequest(url, true);
    
    if (!data?.data?.[address]) return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
    
    const addr = data.data[address].address;
    const confirmed = addr.balance / 100000000;
    const received = addr.received / 100000000;
    const spent = addr.spent / 100000000;
    const unconfirmed = Math.max(0, received - spent - confirmed);
    
    const utxos = data.data[address].utxo || [];
    
    return {
      confirmed: confirmed,
      unconfirmed: unconfirmed,
      total: confirmed + unconfirmed,
      txs: data.data[address].transactions || [],
      utxos: utxos.map(u => ({
        txid: u.transaction_hash,
        vout: u.index,
        value: u.value,
        script: u.script_hex
      }))
    };
  } catch (error) {
    console.error('Address check error:', error.message);
    return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
  }
}

async function updateLtcPrice() {
  if (Date.now() - lastPriceUpdate < 300000) return;
  try {
    const data = await makeApiRequest('https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd');
    if (data?.litecoin?.usd) {
      ltcPrice = data.litecoin.usd;
      lastPriceUpdate = Date.now();
      console.log(`[PRICE] LTC: $${ltcPrice}`);
    }
  } catch (error) {
    console.log('[PRICE] Using cached:', ltcPrice);
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const wallet = getLitecoinAddress(fromIndex);
    const state = await getAddressState(wallet.address);
    
    if (state.confirmed <= 0) {
      return { success: false, error: 'No confirmed balance' };
    }
    
    if (state.utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      if (!utxo.txid || typeof utxo.vout !== 'number') continue;
      
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const txData = await makeApiRequest(txUrl);
        
        if (!txData?.data?.[utxo.txid]?.raw_transaction) continue;
        
        const rawTx = txData.data[utxo.txid].raw_transaction;
        
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(rawTx, 'hex')
        });
        
        totalInput += parseInt(utxo.value);
      } catch (e) {
        console.log(`[SEND] Failed to get raw tx for ${utxo.txid}:`, e.message);
        continue;
      }
    }
    
    if (totalInput === 0) {
      return { success: false, error: 'No spendable inputs' };
    }
    
    const fee = 100000;
    const amount = totalInput - fee;
    
    if (amount <= 0) {
      return { success: false, error: 'Amount too small for fee' };
    }
    
    psbt.addOutput({
      address: toAddress,
      value: amount
    });
    
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (e) {
        console.log(`[SEND] Failed to sign input ${i}:`, e.message);
      }
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    const broadcastUrl = 'https://api.blockchair.com/litecoin/push/transaction';
    const response = await axios.post(broadcastUrl, { data: txHex }, {
      headers: { 'Content-Type': 'application/json' },
      params: { key: BLOCKCHAIR_KEY },
      timeout: 15000
    });
    
    if (response.data?.data?.transaction_hash) {
      return {
        success: true,
        txid: response.data.data.transaction_hash,
        amount: amount / 100000000,
        fee: fee / 100000000
      };
    } else {
      return { success: false, error: 'Broadcast failed', details: response.data };
    }
    
  } catch (error) {
    console.error('[SEND] Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function checkAndSweepIndex(index, toAddress) {
  try {
    const wallet = getLitecoinAddress(index);
    const state = await getAddressState(wallet.address);
    
    if (state.confirmed > 0.001) {
      console.log(`[SWEEP] Found balance at index ${index} (${wallet.address}) - ${state.confirmed} LTC`);
      const result = await sendAllLTC(index, toAddress);
      return { index: index, address: wallet.address, ...result };
    }
  } catch (e) {
    console.log(`[SWEEP] Error on index ${index}:`, e.message);
  }
  return null;
}

async function sweepAllWallets(toAddress) {
  const results = [];
  
  const indicesToCheck = addressIndex.max;
  const batchSize = 5;
  
  for (let batchStart = 0; batchStart < indicesToCheck; batchStart += batchSize) {
    const batch = [];
    for (let i = batchStart; i < Math.min(batchStart + batchSize, indicesToCheck); i++) {
      batch.push(checkAndSweepIndex(i, toAddress));
    }
    
    const batchResults = await Promise.all(batch);
    results.push(...batchResults.filter(r => r !== null));
  }
  
  return results;
}

function getStockInfo(productKey) {
  const product = PRODUCTS[productKey];
  const totalStock = product.stock.length;
  const usedCount = product.stock.filter(item => usedStock.has(item)).length;
  const available = totalStock - usedCount;
  
  return {
    name: product.name,
    total: totalStock,
    used: usedCount,
    available: available,
    price: product.price
  };
}

function logSale(productKey, quantity, amountUsd) {
  salesStats.totalSales++;
  salesStats.totalRevenue += amountUsd;
  
  if (salesStats.productSales[productKey]) {
    salesStats.productSales[productKey].count += quantity;
    salesStats.productSales[productKey].revenue += amountUsd;
  }
  
  if (settings.saleChannel) {
    const channel = client.channels.cache.get(settings.saleChannel);
    if (channel) {
      channel.send({
        embeds: [new EmbedBuilder()
          .setTitle('💰 New Nitro Sale!')
          .setDescription(`**${PRODUCTS[productKey].name}** x${quantity}`)
          .addFields(
            { name: 'Amount', value: `$${amountUsd.toFixed(2)}`, inline: true },
            { name: 'Total Sales', value: `${salesStats.totalSales}`, inline: true },
            { name: 'Total Revenue', value: `$${salesStats.totalRevenue.toFixed(2)}`, inline: true }
          )
          .setColor(0x00FF00)
          .setTimestamp()
        ]
      }).catch(() => {});
    }
  }
}

client.once('ready', async () => {
  console.log(`✅ Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder()
      .setName('panel')
      .setDescription('Spawn Nitro shop panel (Owner)')
      .addStringOption(o => o.setName('image').setDescription('Optional image URL')),
    
    new SlashCommandBuilder()
      .setName('ticketcategory')
      .setDescription('Set ticket category (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('staffroleid')
      .setDescription('Set staff role (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('transcriptchannel')
      .setDescription('Set transcript channel (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('salechannel')
      .setDescription('Set sales log channel (Owner)')
      .addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('send')
      .setDescription('Send all LTC to address (Owner)')
      .addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    
    new SlashCommandBuilder()
      .setName('close')
      .setDescription('Close this ticket (Owner/Staff)'),
    
    new SlashCommandBuilder()
      .setName('stock')
      .setDescription('Check all Nitro stock (Owner)'),
    
    new SlashCommandBuilder()
      .setName('oauth2')
      .setDescription('Get bot invite link (Owner)')
  ];
  
  await client.application.commands.set(commands);
  console.log('✅ Commands registered');
  
  await updateLtcPrice();
  
  setInterval(monitorMempool, 5000);
  setInterval(verifyConfirmations, 30000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (['panel', 'ticketcategory', 'staffroleid', 'transcriptchannel', 'salechannel', 'send', 'stock', 'oauth2'].includes(interaction.commandName)) {
        if (interaction.user.id !== OWNER_ID) {
          return interaction.reply({ content: '❌ Owner only.', flags: MessageFlags.Ephemeral });
        }
      }
      
      if (interaction.commandName === 'close') {
        const member = interaction.member;
        const isOwner = interaction.user.id === OWNER_ID;
        const isStaff = settings.staffRole && member.roles.cache.has(settings.staffRole);
        
        if (!isOwner && !isStaff) {
          return interaction.reply({ content: '❌ Owner or Staff only.', flags: MessageFlags.Ephemeral });
        }
      }
      
      if (interaction.commandName === 'panel') {
        const embed = new EmbedBuilder()
          .setTitle('🏪 Hello welcome to Nitro Shop')
          .setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken')
          .setColor(0x5865F2)
          .setTimestamp();
        
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('open_ticket')
            .setLabel('🛒 Purchase Nitro')
            .setStyle(ButtonStyle.Success)
        );
        
        await interaction.reply({ embeds: [embed], components: [row] });
      }
      
      else if (interaction.commandName === 'ticketcategory') {
        settings.ticketCategory = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Ticket category set to: ${settings.ticketCategory}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'staffroleid') {
        settings.staffRole = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Staff role set to: ${settings.staffRole}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'transcriptchannel') {
        settings.transcriptChannel = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Transcript channel set to: ${settings.transcriptChannel}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'salechannel') {
        settings.saleChannel = interaction.options.getString('id');
        await interaction.reply({ content: `✅ Sales channel set to: ${settings.saleChannel}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'send') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        
        const address = interaction.options.getString('address');
        
        try {
          bitcoin.address.toOutputScript(address, LITECOIN);
        } catch (e) {
          return interaction.editReply({ content: '❌ Invalid Litecoin address!' });
        }
        
        await interaction.editReply({ content: '🔄 Scanning all 10 wallet indices... This may take 10-15 seconds.' });
        
        const results = await sweepAllWallets(address);
        
        const successCount = results.filter(r => r.success).length;
        const failCount = results.length - successCount;
        const totalSent = results.filter(r => r.success).reduce((a, b) => a + (b.amount || 0), 0);
        
        let resultText = `**Sweep Complete!**\n\n`;
        resultText += `✅ Successful: ${successCount}\n`;
        resultText += `❌ Failed: ${failCount}\n`;
        resultText += `💰 Total Sent: ${totalSent.toFixed(8)} LTC\n\n`;
        
        if (results.length > 0) {
          resultText += `**Details:**\n`;
          for (const r of results.slice(0, 10)) {
            if (r.success) {
              resultText += `• Index ${r.index}: ${r.amount?.toFixed(8)} LTC - [${r.txid?.substring(0, 16)}...](https://blockchair.com/litecoin/transaction/${r.txid})\n`;
            } else {
              resultText += `• Index ${r.index}: ❌ ${r.error}\n`;
            }
          }
          if (results.length > 10) resultText += `... and ${results.length - 10} more`;
        } else {
          resultText += `No wallets with balance found in indices 0-9.`;
        }
        
        await interaction.editReply({ content: resultText });
      }
      
      else if (interaction.commandName === 'close') {
        const ticket = tickets.get(interaction.channel.id);
        
        if (ticket && settings.transcriptChannel) {
          const tChannel = await interaction.guild.channels.fetch(settings.transcriptChannel).catch(() => null);
          if (tChannel) {
            await tChannel.send({ 
              embeds: [new EmbedBuilder()
                .setTitle('📝 Ticket Closed')
                .addFields(
                  { name: 'User', value: `<@${ticket.userId}>`, inline: true },
                  { name: 'Product', value: ticket.productName || 'N/A', inline: true },
                  { name: 'Amount', value: `$${ticket.amountUsd || 0}`, inline: true },
                  { name: 'Status', value: ticket.status, inline: true },
                  { name: 'Closed By', value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp()
              ] 
            });
          }
        }
        
        await interaction.reply({ content: '🔒 Closing ticket...', flags: MessageFlags.Ephemeral });
        await interaction.channel.delete();
      }
      
      else if (interaction.commandName === 'stock') {
        const embed = new EmbedBuilder()
          .setTitle('📦 Nitro Stock Overview')
          .setColor(0x5865F2)
          .setTimestamp();
        
        for (const [key, product] of Object.entries(PRODUCTS)) {
          const info = getStockInfo(key);
          embed.addFields({
            name: `${product.name} ($${product.price})`,
            value: `Available: ${info.available}/${info.total}`,
            inline: true
          });
        }
        
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.commandName === 'oauth2') {
        const botId = client.user.id;
        const inviteLink = `https://discord.com/oauth2/authorize?client_id=${botId}&permissions=8&scope=bot%20applications.commands`;
        
        const embed = new EmbedBuilder()
          .setTitle('🤖 Bot Invite Link')
          .setDescription(`Click below to invite ${client.user.username} to your server:`)
          .addFields(
            { name: 'Invite URL', value: `[Click Here to Invite](${inviteLink})` },
            { name: 'Bot ID', value: botId }
          )
          .setColor(0x5865F2)
          .setTimestamp();
        
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    }
    
    else if (interaction.isButton()) {
      if (interaction.customId === 'open_ticket') {
        const existing = Array.from(tickets.values()).find(t => 
          t.userId === interaction.user.id && 
          t.status !== 'closed' && 
          t.status !== 'delivered'
        );
        
        if (existing) {
          return interaction.reply({ content: '❌ You already have an open ticket!', flags: MessageFlags.Ephemeral });
        }
        
        if (!settings.ticketCategory) {
          return interaction.reply({ content: '❌ Ticket category not set up yet.', flags: MessageFlags.Ephemeral });
        }
        
        const guild = interaction.guild;
        const channel = await guild.channels.create({
          name: `nitro-${interaction.user.username}`,
          type: ChannelType.GuildText,
          parent: settings.ticketCategory,
          permissionOverwrites: [
            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }
          ]
        });
        
        if (settings.staffRole) {
          await channel.permissionOverwrites.create(settings.staffRole, { 
            ViewChannel: true, 
            SendMessages: true 
          });
        }
        
        const row = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('product_select')
            .setPlaceholder('Select Nitro Product')
            .addOptions([
              { 
                label: 'Nitro Basic Monthly - $1.00', 
                value: 'nitro_basic_month', 
                emoji: '💎',
                description: '30 days of Nitro Basic'
              },
              { 
                label: 'Nitro Basic Yearly - $7.00', 
                value: 'nitro_basic_year', 
                emoji: '💎',
                description: '365 days of Nitro Basic'
              },
              { 
                label: 'Nitro Boost Monthly - $2.80', 
                value: 'nitro_boost_month', 
                emoji: '🔥',
                description: '30 days of Nitro Boost'
              },
              { 
                label: 'Nitro Boost Yearly - $14.00', 
                value: 'nitro_boost_year', 
                emoji: '🔥',
                description: '365 days of Nitro Boost'
              }
            ])
        );
        
        await channel.send({
          content: `${interaction.user}`,
          embeds: [new EmbedBuilder()
            .setTitle('🛒 Select Your Nitro')
            .setDescription('Please select the Nitro subscription you want to purchase:')
            .setColor(0x00FF00)
          ],
          components: [row]
        });
        
        tickets.set(channel.id, { 
          userId: interaction.user.id, 
          status: 'selecting', 
          channelId: channel.id,
          createdAt: Date.now()
        });
        
        await interaction.reply({ content: `✅ Ticket created: ${channel}`, flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.customId === 'support_ping') {
        await interaction.channel.send({ content: `@everyone, ${interaction.user} needs support assistance` });
        await interaction.reply({ content: '✅ Support team notified!', flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.customId === 'replace_request') {
        await interaction.channel.setName(`${interaction.channel.name}-replacement`);
        await interaction.reply({ content: '✅ Replacement requested! Please wait for owner.', flags: MessageFlags.Ephemeral });
      }
      
      else if (interaction.customId === 'works_close') {
        const ticket = tickets.get(interaction.channel.id);
        
        if (ticket && settings.transcriptChannel) {
          const tChannel = await interaction.guild.channels.fetch(settings.transcriptChannel).catch(() => null);
          if (tChannel) {
            await tChannel.send({ 
              embeds: [new EmbedBuilder()
                .setTitle('📝 Ticket Closed (Completed)')
                .addFields(
                  { name: 'User', value: `<@${ticket.userId}>`, inline: true },
                  { name: 'Product', value: ticket.productName || 'N/A', inline: true },
                  { name: 'Amount', value: `$${ticket.amountUsd || 0}`, inline: true },
                  { name: 'Status', value: 'Works - Closed by User', inline: true }
                )
                .setTimestamp()
              ] 
            });
          }
        }
        
        await interaction.reply({ content: '🔒 Closing ticket...', flags: MessageFlags.Ephemeral });
        await interaction.channel.delete();
      }
    }
    
    else if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
      const productKey = interaction.values[0];
      const product = PRODUCTS[productKey];
      const ticket = tickets.get(interaction.channel.id);
      
      if (!ticket) return;
      
      ticket.product = productKey;
      ticket.productName = product.name;
      ticket.price = product.price;
      
      const modal = new ModalBuilder()
        .setCustomId(`quantity_modal_${interaction.channel.id}`)
        .setTitle('Enter Quantity')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('quantity')
              .setLabel(`How many ${product.name}?`)
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('1')
              .setRequired(true)
              .setMinLength(1)
              .setMaxLength(2)
          )
        );
      
      await interaction.showModal(modal);
    }
    
    else if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('quantity_modal_')) {
        await handleQuantityModal(interaction);
      }
    }
  } catch (error) {
    console.error('Interaction error:', error);
    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '❌ An error occurred. Please try again.', flags: MessageFlags.Ephemeral });
      }
    } catch (e) {}
  }
});

async function handleQuantityModal(interaction) {
  try {
    const quantity = parseInt(interaction.fields.getTextInputValue('quantity'));
    const ticket = tickets.get(interaction.channel.id);
    
    if (!ticket || !ticket.product) {
      return interaction.reply({ content: '❌ Ticket not found or expired.', flags: MessageFlags.Ephemeral });
    }
    
    if (isNaN(quantity) || quantity < 1) {
      return interaction.reply({ content: '❌ Invalid quantity! Must be a number 1-99.', flags: MessageFlags.Ephemeral });
    }
    
    const available = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s));
    if (available.length < quantity) {
      return interaction.reply({ content: `❌ Only ${available.length} in stock!`, flags: MessageFlags.Ephemeral });
    }
    
    const currentIndex = addressIndex.current % addressIndex.max;
    const wallet = getLitecoinAddress(currentIndex);
    addressIndex.current++;
    
    const totalUsd = ticket.price * quantity;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    
    ticket.quantity = quantity;
    ticket.address = wallet.address;
    ticket.privateKey = wallet.privateKey;
    ticket.walletIndex = wallet.index;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.status = 'awaiting_payment';
    ticket.paid = false;
    ticket.delivered = false;
    ticket.productsSent = [];
    ticket.sentToOwner = false;
    
    const toleranceLtc = TOLERANCE_USD / ltcPrice;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc + 0.001;
    
    const embed = new EmbedBuilder()
      .setTitle('💳 Payment Details')
      .setDescription(`**Product:** ${ticket.productName}\n**Quantity:** ${quantity}\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
      .addFields(
        { name: '📋 LTC Address (Copy)', value: `\`${wallet.address}\`` },
        { name: '💰 Amount (±$0.10 OK)', value: `\`${totalLtc} LTC\`` },
        { name: '⚡ Detection', value: 'INSTANT (0-confirmation)' },
        { name: '🔢 Address Index', value: `${wallet.index}/10` }
      )
      .setColor(0xFFD700)
      .setFooter({ text: 'Send LTC now. Bot detects instantly and delivers in 10-30 seconds!' });
    
    await interaction.reply({ embeds: [embed] });
    console.log(`[TICKET] ${interaction.channel.id} - Index ${wallet.index} - Awaiting payment to ${wallet.address} (${totalLtc} LTC)`);
  } catch (error) {
    console.error('Quantity modal error:', error);
    await interaction.reply({ content: '❌ Error processing quantity. Please try again.', flags: MessageFlags.Ephemeral });
  }
}

async function monitorMempool() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => 
    t.status === 'awaiting_payment' && !t.paid && t.address
  );
  
  if (awaiting.length === 0) return;
  
  const batch = awaiting.slice(0, 3);
  
  for (const [channelId, ticket] of batch) {
    try {
      const state = await getAddressState(ticket.address);
      
      if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
        ticket.paid = true;
        ticket.receivedLtc = state.total;
        ticket.paymentTime = Date.now();
        ticket.confirmed = state.confirmed >= ticket.minLtc;
        
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) continue;
        
        if (!ticket.sentToOwner) {
          ticket.sentToOwner = true;
          console.log(`[AUTO-SEND] Sending ${state.total} LTC from index ${ticket.walletIndex} to owner (${FEE_ADDRESS})`);
          
          const sendResult = await sendAllLTC(ticket.walletIndex, FEE_ADDRESS);
          if (sendResult.success) {
            console.log(`[AUTO-SEND] Success: ${sendResult.txid}`);
          } else {
            console.log(`[AUTO-SEND] Failed: ${sendResult.error}`);
          }
        }
        
        await channel.send({
          embeds: [new EmbedBuilder()
            .setTitle('⏳ Wait For Owner Arrival')
            .setDescription(`Payment detected: ${state.total.toFixed(8)} LTC\nStatus: **Pending Owner Review**\n\nPlease wait while the owner processes your order.`)
            .setColor(0xFFA500)
          ]
        });
        
        try {
          const owner = await client.users.fetch(OWNER_ID);
          if (owner) {
            await owner.send({
              embeds: [new EmbedBuilder()
                .setTitle('🛒 New Nitro Order')
                .setDescription(`**Product:** ${ticket.productName}\n**Quantity:** ${ticket.quantity}\n**Amount:** $${ticket.amountUsd.toFixed(2)}\n**Channel:** <#${channelId}>`)
                .setColor(0x00FF00)
                .setTimestamp()
              ]
            });
          }
        } catch (e) {
          console.log('[NOTIFY] Could not DM owner');
        }
        
        if (!ticket.delivered) {
          await deliverProducts(channelId, state.total);
        }
      }
    } catch (error) {
      console.error(`[MONITOR] Error:`, error.message);
    }
  }
}

async function verifyConfirmations() {
  const pending = Array.from(tickets.entries()).filter(([_, t]) => 
    t.status === 'awaiting_payment' && t.paid && !t.confirmed && t.address
  );
  
  if (pending.length === 0) return;
  
  for (const [channelId, ticket] of pending.slice(0, 2)) {
    try {
      const state = await getAddressState(ticket.address);
      
      if (state.confirmed >= ticket.minLtc) {
        ticket.confirmed = true;
        
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send({
            embeds: [new EmbedBuilder()
              .setTitle('✅ Blockchain Confirmed')
              .setDescription('Transaction now has 1+ confirmations on the Litecoin blockchain.')
              .setColor(0x00FF00)
            ]
          });
        }
        console.log(`[CONFIRMED] Ticket ${channelId}`);
      }
    } catch (error) {
      console.error(`[VERIFY] Error:`, error.message);
    }
  }
}

async function deliverProducts(channelId, receivedLtc) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.delivered) return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;
  
  const productList = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s)).slice(0, ticket.quantity);
  
  if (productList.length === 0) {
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('❌ Out of Stock')
        .setDescription('No more products available. Please contact support.')
        .setColor(0xFF0000)
      ]
    });
    return;
  }
  
  productList.forEach(p => usedStock.add(p));
  ticket.productsSent = productList;
  ticket.delivered = true;
  ticket.status = 'delivered';
  
  logSale(ticket.product, productList.length, ticket.amountUsd);
  
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Nitro Links (Delivered)')
    .setDescription(`**${ticket.productName}** x${productList.length}\nPaid: ${receivedLtc.toFixed(8)} LTC`)
    .setColor(0x00FF00);
  
  productList.forEach((item, idx) => {
    embed.addFields({ 
      name: `Nitro Link ${idx + 1}`, 
      value: `[Click to Claim](${item})`, 
      inline: false 
    });
  });
  
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('support_ping').setLabel('📞 Support').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('replace_request').setLabel('🔄 Replace').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('works_close').setLabel('✅ Works/Close').setStyle(ButtonStyle.Success)
  );
  
  await channel.send({ embeds: [embed], components: [row] });
  
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle('🙏 Please Vouch')
      .setDescription(`Copy & paste:\n\`vouch <@${OWNER_ID}> ${ticket.productName} ${productList.length} $${ticket.amountUsd.toFixed(2)}\``)
      .setColor(0x5865F2)
    ]
  });
  
  console.log(`[DELIVERED] Channel ${channelId} - ${ticket.product} x${productList.length}`);
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

client.login(process.env.DISCORD_TOKEN);
