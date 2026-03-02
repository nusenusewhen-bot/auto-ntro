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

const LITECOIN = { 
  messagePrefix: '\x19Litecoin Signed Message:\n', 
  bech32: 'ltc', 
  bip32: { public: 0x019da462, private: 0x019d9cfe }, 
  pubKeyHash: 0x30, 
  scriptHash: 0x32, 
  wif: 0xb0 
};

// ONLY USE INDEX 0 - Everything goes through here
const ADDRESSES = [
  { index: 0, address: 'Lc1m5wtQ8g9mJJP9cV1Db3S7DCxuot98CU', inUse: false, ticketChannel: null, type: 'bech32' }
];

let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const processedTxs = new Set(); // Track processed transactions

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

function getAvailableAddress() {
  // Always return index 0, create new ticket channel mapping
  const addr = ADDRESSES[0];
  if (!addr.inUse) return addr;
  
  // If index 0 is in use, we need to check if that ticket is still active
  // If not active, we can reuse it
  return null; // Only one ticket at a time with single address
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
    console.error(`[API ERROR] ${e.message}`);
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
  
  // Include mempool for pending detection
  return ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  
  return (funded - spent) / 100000000;
}

async function getRecentTransactions(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/txs`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
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
  const addrInfo = ADDRESSES[fromIndex];
  const wallet = getWallet(fromIndex, addrInfo.type);
  
  const utxos = await getUTXOs(addrInfo.address);
  if (utxos.length === 0) return { success: false, error: 'No UTXOs found' };
  
  const psbt = new bitcoin.Psbt({ network: LITECOIN });
  let total = 0;
  
  for (let utxo of utxos) {
    // Skip if already spent
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
  
  const fee = 100000; // 0.001 LTC fee
  
  let sendAmount;
  if (amount === null) {
    // Send all (sweep)
    sendAmount = total - fee;
  } else {
    // Send specific amount
    sendAmount = Math.floor(amount * 100000000);
  }
  
  if (sendAmount <= 0) return { success: false, error: 'Amount too small after fee' };
  
  psbt.addOutput({ address: toAddress, value: sendAmount });
  
  // Add change output if not sweeping
  if (amount !== null && (total - sendAmount - fee) > 546) {
    psbt.addOutput({ address: addrInfo.address, value: total - sendAmount - fee });
  }
  
  const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
  
  for (let i = 0; i < psbt.inputCount; i++) {
    try {
      psbt.signInput(i, keyPair);
    } catch (e) {
      console.log(`[SIGN ERROR] Input ${i}: ${e.message}`);
    }
  }
  
  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();
  
  return await broadcastTx(txHex);
}

// Check payments every 10 seconds
async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    
    try {
      // Get confirmed balance only (wait for 1 confirmation)
      const confirmedBal = await getConfirmedBalance(ticket.address);
      const pendingBal = await getBalance(ticket.address);
      
      console.log(`[CHECK] Channel ${channelId}: Confirmed=${confirmedBal.toFixed(8)}, Pending=${pendingBal.toFixed(8)}, Required=${ticket.minLtc?.toFixed(8)}-${ticket.maxLtc?.toFixed(8)}`);
      
      // Check if we have enough confirmed balance
      if (confirmedBal >= ticket.minLtc && confirmedBal <= ticket.maxLtc * 1.5) {
        // Check for new transaction
        const txs = await getRecentTransactions(ticket.address);
        const newTx = txs.find(tx => {
          // Find incoming tx to this address that we haven't processed
          const outputs = tx.vout || [];
          const hasOutputToAddress = outputs.some(vout => 
            vout.scriptpubkey_address === ticket.address && 
            !processedTxs.has(tx.txid)
          );
          return hasOutputToAddress && tx.status?.confirmed;
        });
        
        if (newTx || confirmedBal > 0) {
          await processPayment(channelId, confirmedBal, newTx?.txid);
        }
      }
      
      // Update display if pending but not confirmed
      if (pendingBal > confirmedBal && !ticket.pendingNotified) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`⏳ **Pending payment detected!** Waiting for confirmation...\nDetected: ${pendingBal.toFixed(8)} LTC\nRequired: ${ticket.amountLtc} LTC`);
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
  
  // Mark as paid immediately to prevent double-processing
  ticket.paid = true;
  ticket.status = 'delivered';
  ticket.paidAmount = amount;
  ticket.txid = txid;
  
  if (txid) processedTxs.add(txid);
  
  // Send success message
  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Payment Confirmed!')
    .setDescription(`Received: **${amount.toFixed(8)} LTC**\nTransaction: ${txid ? `[View](https://litecoinspace.org/tx/${txid})` : 'N/A'}`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  await channel.send({ embeds: [successEmbed] });
  
  // Auto-send to fee address
  await channel.send('🔄 Processing auto-transfer...');
  
  const sendResult = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  
  if (sendResult.success) {
    await channel.send(`✅ **Funds transferred to secure wallet**\nTX: [${sendResult.txid}](https://litecoinspace.org/tx/${sendResult.txid})`);
    
    // Send product
    await deliverProduct(channel, ticket);
  } else {
    await channel.send(`⚠️ **Auto-transfer failed**: ${sendResult.error}\nOwner has been notified.`);
    
    // Notify owner of failed transfer
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      await owner.send(`🚨 **Transfer Failed**\nChannel: ${channel}\nAmount: ${amount.toFixed(8)} LTC\nError: ${sendResult.error}\nManual transfer required!`);
    }
  }
  
  // Log sale
  if (settings.saleChannel) {
    const saleCh = await client.channels.fetch(settings.saleChannel).catch(() => null);
    if (saleCh) {
      const logEmbed = new EmbedBuilder()
        .setTitle('💰 New Sale')
        .addFields(
          { name: 'Product', value: ticket.product, inline: true },
          { name: 'Quantity', value: ticket.quantity.toString(), inline: true },
          { name: 'Amount', value: `${amount.toFixed(8)} LTC`, inline: true },
          { name: 'Buyer', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Channel', value: `<#${channelId}>`, inline: true }
        )
        .setColor(0x00FF00)
        .setTimestamp();
      await saleCh.send({ embeds: [logEmbed] });
    }
  }
}

async function deliverProduct(channel, ticket) {
  // Generate or fetch product
  const products = {
    'basic_month': 'Nitro Basic Monthly Code',
    'basic_year': 'Nitro Basic Yearly Code',
    'boost_month': 'Nitro Boost Monthly Code',
    'boost_year': 'Nitro Boost Yearly Code'
  };
  
  const productName = products[ticket.product] || 'Product';
  
  // Create delivery embed
  const deliveryEmbed = new EmbedBuilder()
    .setTitle('🎁 Your Order')
    .setDescription(`**${productName}** x${ticket.quantity}\n\n\`\`\`diff\n+ CODE_PLACEHOLDER_${Date.now()}\n\`\`\`\n\nRedeem at: https://discord.com/gifts`)
    .setColor(0x5865F2)
    .setFooter({ text: 'Thanks for your purchase!' });
  
  await channel.send({ content: `<@${ticket.userId}>`, embeds: [deliveryEmbed] });
  await channel.send('⚠️ **Important**: This channel will close in 5 minutes. Save your code!');
  
  // Auto-close after 5 minutes
  setTimeout(async () => {
    try {
      releaseAddress(channel.id);
      tickets.delete(channel.id);
      await channel.delete();
    } catch (e) {
      console.error(`[AUTO-CLOSE ERROR] ${e.message}`);
    }
  }, 300000);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  console.log(`[CONFIG] Owner: ${OWNER_ID}`);
  console.log(`[CONFIG] Fee Address: ${FEE_ADDRESS}`);
  
  // Check wallet balances
  for (let addr of ADDRESSES) {
    const bal = await getBalance(addr.address);
    const confirmed = await getConfirmedBalance(addr.address);
    console.log(`[WALLET ${addr.index}] ${addr.address}`);
    console.log(`  Confirmed: ${confirmed.toFixed(8)} LTC`);
    console.log(`  Pending: ${(bal - confirmed).toFixed(8)} LTC`);
  }
  
  // Register commands
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Display shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales log channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address (Owner only)').addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true())),
    new SlashCommandBuilder().setName('close').setDescription('Close this ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance'),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('status').setDescription('Show bot status')
  ];
  
  await client.application.commands.set(commands);
  console.log(`[COMMANDS] Registered ${commands.length} commands`);
  
  // Start payment checker
  setInterval(checkPayments, 10000);
  console.log('[PAYMENT] Checker started (10s interval)');
});

client.on('interactionCreate', async (interaction) => {
  // Handle commands
  if (interaction.isChatInputCommand()) {
    const isOwner = interaction.user.id === OWNER_ID;
    
    if (interaction.commandName === 'panel') {
      if (!settings.ticketCategory) {
        return interaction.reply({ content: '❌ Setup required: Use /ticketcategory first', flags: MessageFlags.Ephemeral });
      }
      
      const embed = new EmbedBuilder()
        .setTitle('🛒 Nitro Shop')
        .setDescription('Welcome! Click below to purchase Discord Nitro.\n\n💎 **Nitro Basic** - $1/mo or $7/yr\n🔥 **Nitro Boost** - $2.80/mo or $14/yr')
        .setColor(0x5865F2)
        .setImage('https://i.postimg.cc/rmNhJMw9/10d8aff99fc9a6a3878c3333114b5752.png');
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_ticket')
          .setLabel('🛍️ Purchase')
          .setStyle(ButtonStyle.Success)
      );
      
      await interaction.reply({ embeds: [embed], components: [row] });
    }
    
    else if (interaction.commandName === 'status') {
      let text = '📊 **Bot Status**\n\n**Wallets:**\n';
      for (let addr of ADDRESSES) {
        const bal = await getBalance(addr.address);
        const confirmed = await getConfirmedBalance(addr.address);
        text += `\`[${addr.index}]\` ${addr.type}\n${addr.address}\n💰 ${confirmed.toFixed(8)} LTC (${(bal-confirmed).toFixed(8)} pending)\n${addr.inUse ? '🔴 In Use' : '🟢 Available'}\n\n`;
      }
      
      text += `\n**Active Tickets:** ${tickets.size}\n**Settings:**\nCategory: ${settings.ticketCategory || 'Not Set'}\nStaff Role: ${settings.staffRole || 'Not Set'}\nSales Channel: ${settings.saleChannel || 'Not Set'}`;
      
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
    
    else if (interaction.commandName === 'balance') {
      if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
      
      const bal = await getBalance(ADDRESSES[0].address);
      const confirmed = await getConfirmedBalance(ADDRESSES[0].address);
      
      await interaction.reply({ 
        content: `💰 **Wallet 0**\nAddress: ${ADDRESSES[0].address}\nConfirmed: ${confirmed.toFixed(8)} LTC\nPending: ${(bal - confirmed).toFixed(8)} LTC\nTotal: ${bal.toFixed(8)} LTC`, 
        flags: MessageFlags.Ephemeral 
      });
    }
    
    else if (interaction.commandName === 'send') {
      if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const to = interaction.options.getString('address');
      const result = await sendLTC(0, to);
      
      if (result.success) {
        await interaction.editReply({ 
          content: `✅ **Sent successfully!**\nAmount: ${result.amount ? (result.amount/100000000).toFixed(8) : 'All'} LTC\nTXID: \`${result.txid}\`\n[View Transaction](https://litecoinspace.org/tx/${result.txid})` 
        });
      } else {
        await interaction.editReply({ content: `❌ **Failed**: ${result.error}` });
      }
    }
    
    else if (interaction.commandName === 'close') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel', flags: MessageFlags.Ephemeral });
      
      if (ticket.userId !== interaction.user.id && !isOwner) {
        return interaction.reply({ content: '❌ Only ticket owner or bot owner can close', flags: MessageFlags.Ephemeral });
      }
      
      await interaction.reply({ content: '🔒 Closing ticket...', flags: MessageFlags.Ephemeral });
      
      releaseAddress(interaction.channel.id);
      tickets.delete(interaction.channel.id);
      
      setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
    }
    
    else if (interaction.commandName === 'check') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket) return interaction.reply({ content: '❌ No active ticket in this channel', flags: MessageFlags.Ephemeral });
      
      const bal = await getBalance(ticket.address);
      const confirmed = await getConfirmedBalance(ticket.address);
      
      const embed = new EmbedBuilder()
        .setTitle('💳 Payment Status')
        .addFields(
          { name: 'Required', value: `${ticket.amountLtc} LTC (±50%)`, inline: true },
          { name: 'Confirmed', value: `${confirmed.toFixed(8)} LTC`, inline: true },
          { name: 'Pending', value: `${(bal - confirmed).toFixed(8)} LTC`, inline: true },
          { name: 'Status', value: ticket.paid ? '✅ Paid' : ticket.pendingNotified ? '⏳ Confirming...' : '⏳ Waiting...', inline: true }
        )
        .setColor(ticket.paid ? 0x00FF00 : 0xFFD700);
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    
    else if (['ticketcategory', 'staffroleid', 'transcriptchannel', 'salechannel'].includes(interaction.commandName)) {
      if (!isOwner) return interaction.reply({ content: ((funded - spent) + (mempoolFunded - mempoolSpent)) / 100000000;
}

async function getConfirmedBalance(address) {
  const data = await getAddressData(address);
  if (!data) return 0;
  
  const funded = (data.chain_stats?.funded_txo_sum || 0);
  const spent = (data.chain_stats?.spent_txo_sum || 0);
  
  return (funded - spent) / 100000000;
}

async function getRecentTransactions(address) {
  try {
    const url = `https://litecoinspace.org/api/address/${address}/txs`;
    const { data } = await axios.get(url, { timeout: 15000 });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
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
  const addrInfo = ADDRESSES[fromIndex];
  const wallet = getWallet(fromIndex, addrInfo.type);
  
  const utxos = await getUTXOs(addrInfo.address);
  if (utxos.length === 0) return { success: false, error: 'No UTXOs found' };
  
  const psbt = new bitcoin.Psbt({ network: LITECOIN });
  let total = 0;
  
  for (let utxo of utxos) {
    // Skip if already spent
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
  
  const fee = 100000; // 0.001 LTC fee
  
  let sendAmount;
  if (amount === null) {
    // Send all (sweep)
    sendAmount = total - fee;
  } else {
    // Send specific amount
    sendAmount = Math.floor(amount * 100000000);
  }
  
  if (sendAmount <= 0) return { success: false, error: 'Amount too small after fee' };
  
  psbt.addOutput({ address: toAddress, value: sendAmount });
  
  // Add change output if not sweeping
  if (amount !== null && (total - sendAmount - fee) > 546) {
    psbt.addOutput({ address: addrInfo.address, value: total - sendAmount - fee });
  }
  
  const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
  
  for (let i = 0; i < psbt.inputCount; i++) {
    try {
      psbt.signInput(i, keyPair);
    } catch (e) {
      console.log(`[SIGN ERROR] Input ${i}: ${e.message}`);
    }
  }
  
  psbt.finalizeAllInputs();
  const txHex = psbt.extractTransaction().toHex();
  
  return await broadcastTx(txHex);
}

// Check payments every 10 seconds
async function checkPayments() {
  for (let [channelId, ticket] of tickets) {
    if (ticket.status !== 'awaiting_payment' || ticket.paid) continue;
    
    try {
      // Get confirmed balance only (wait for 1 confirmation)
      const confirmedBal = await getConfirmedBalance(ticket.address);
      const pendingBal = await getBalance(ticket.address);
      
      console.log(`[CHECK] Channel ${channelId}: Confirmed=${confirmedBal.toFixed(8)}, Pending=${pendingBal.toFixed(8)}, Required=${ticket.minLtc?.toFixed(8)}-${ticket.maxLtc?.toFixed(8)}`);
      
      // Check if we have enough confirmed balance
      if (confirmedBal >= ticket.minLtc && confirmedBal <= ticket.maxLtc * 1.5) {
        // Check for new transaction
        const txs = await getRecentTransactions(ticket.address);
        const newTx = txs.find(tx => {
          // Find incoming tx to this address that we haven't processed
          const outputs = tx.vout || [];
          const hasOutputToAddress = outputs.some(vout => 
            vout.scriptpubkey_address === ticket.address && 
            !processedTxs.has(tx.txid)
          );
          return hasOutputToAddress && tx.status?.confirmed;
        });
        
        if (newTx || confirmedBal > 0) {
          await processPayment(channelId, confirmedBal, newTx?.txid);
        }
      }
      
      // Update display if pending but not confirmed
      if (pendingBal > confirmedBal && !ticket.pendingNotified) {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (channel) {
          await channel.send(`⏳ **Pending payment detected!** Waiting for confirmation...\nDetected: ${pendingBal.toFixed(8)} LTC\nRequired: ${ticket.amountLtc} LTC`);
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
  
  // Mark as paid immediately to prevent double-processing
  ticket.paid = true;
  ticket.status = 'delivered';
  ticket.paidAmount = amount;
  ticket.txid = txid;
  
  if (txid) processedTxs.add(txid);
  
  // Send success message
  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Payment Confirmed!')
    .setDescription(`Received: **${amount.toFixed(8)} LTC**\nTransaction: ${txid ? `[View](https://litecoinspace.org/tx/${txid})` : 'N/A'}`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  await channel.send({ embeds: [successEmbed] });
  
  // Auto-send to fee address
  await channel.send('🔄 Processing auto-transfer...');
  
  const sendResult = await sendLTC(ticket.walletIndex, FEE_ADDRESS);
  
  if (sendResult.success) {
    await channel.send(`✅ **Funds transferred to secure wallet**\nTX: [${sendResult.txid}](https://litecoinspace.org/tx/${sendResult.txid})`);
    
    // Send product
    await deliverProduct(channel, ticket);
  } else {
    await channel.send(`⚠️ **Auto-transfer failed**: ${sendResult.error}\nOwner has been notified.`);
    
    // Notify owner of failed transfer
    const owner = await client.users.fetch(OWNER_ID).catch(() => null);
    if (owner) {
      await owner.send(`🚨 **Transfer Failed**\nChannel: ${channel}\nAmount: ${amount.toFixed(8)} LTC\nError: ${sendResult.error}\nManual transfer required!`);
    }
  }
  
  // Log sale
  if (settings.saleChannel) {
    const saleCh = await client.channels.fetch(settings.saleChannel).catch(() => null);
    if (saleCh) {
      const logEmbed = new EmbedBuilder()
        .setTitle('💰 New Sale')
        .addFields(
          { name: 'Product', value: ticket.product, inline: true },
          { name: 'Quantity', value: ticket.quantity.toString(), inline: true },
          { name: 'Amount', value: `${amount.toFixed(8)} LTC`, inline: true },
          { name: 'Buyer', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Channel', value: `<#${channelId}>`, inline: true }
        )
        .setColor(0x00FF00)
        .setTimestamp();
      await saleCh.send({ embeds: [logEmbed] });
    }
  }
}

async function deliverProduct(channel, ticket) {
  // Generate or fetch product
  const products = {
    'basic_month': 'Nitro Basic Monthly Code',
    'basic_year': 'Nitro Basic Yearly Code',
    'boost_month': 'Nitro Boost Monthly Code',
    'boost_year': 'Nitro Boost Yearly Code'
  };
  
  const productName = products[ticket.product] || 'Product';
  
  // Create delivery embed
  const deliveryEmbed = new EmbedBuilder()
    .setTitle('🎁 Your Order')
    .setDescription(`**${productName}** x${ticket.quantity}\n\n\`\`\`diff\n+ CODE_PLACEHOLDER_${Date.now()}\n\`\`\`\n\nRedeem at: https://discord.com/gifts`)
    .setColor(0x5865F2)
    .setFooter({ text: 'Thanks for your purchase!' });
  
  await channel.send({ content: `<@${ticket.userId}>`, embeds: [deliveryEmbed] });
  await channel.send('⚠️ **Important**: This channel will close in 5 minutes. Save your code!');
  
  // Auto-close after 5 minutes
  setTimeout(async () => {
    try {
      releaseAddress(channel.id);
      tickets.delete(channel.id);
      await channel.delete();
    } catch (e) {
      console.error(`[AUTO-CLOSE ERROR] ${e.message}`);
    }
  }, 300000);
}

client.once('ready', async () => {
  console.log(`[READY] ${client.user.tag}`);
  console.log(`[CONFIG] Owner: ${OWNER_ID}`);
  console.log(`[CONFIG] Fee Address: ${FEE_ADDRESS}`);
  
  // Check wallet balances
  for (let addr of ADDRESSES) {
    const bal = await getBalance(addr.address);
    const confirmed = await getConfirmedBalance(addr.address);
    console.log(`[WALLET ${addr.index}] ${addr.address}`);
    console.log(`  Confirmed: ${confirmed.toFixed(8)} LTC`);
    console.log(`  Pending: ${(bal - confirmed).toFixed(8)} LTC`);
  }
  
  // Register commands
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Display shop panel'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales log channel').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address (Owner only)').addStringOption(o => o.setName('address').setDescription('LTC Address').setRequired(true())),
    new SlashCommandBuilder().setName('close').setDescription('Close this ticket'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance'),
    new SlashCommandBuilder().setName('check').setDescription('Check payment status'),
    new SlashCommandBuilder().setName('status').setDescription('Show bot status')
  ];
  
  await client.application.commands.set(commands);
  console.log(`[COMMANDS] Registered ${commands.length} commands`);
  
  // Start payment checker
  setInterval(checkPayments, 10000);
  console.log('[PAYMENT] Checker started (10s interval)');
});

client.on('interactionCreate', async (interaction) => {
  // Handle commands
  if (interaction.isChatInputCommand()) {
    const isOwner = interaction.user.id === OWNER_ID;
    
    if (interaction.commandName === 'panel') {
      if (!settings.ticketCategory) {
        return interaction.reply({ content: '❌ Setup required: Use /ticketcategory first', flags: MessageFlags.Ephemeral });
      }
      
      const embed = new EmbedBuilder()
        .setTitle('🛒 Nitro Shop')
        .setDescription('Welcome! Click below to purchase Discord Nitro.\n\n💎 **Nitro Basic** - $1/mo or $7/yr\n🔥 **Nitro Boost** - $2.80/mo or $14/yr')
        .setColor(0x5865F2)
        .setImage('https://i.postimg.cc/rmNhJMw9/10d8aff99fc9a6a3878c3333114b5752.png');
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('open_ticket')
          .setLabel('🛍️ Purchase')
          .setStyle(ButtonStyle.Success)
      );
      
      await interaction.reply({ embeds: [embed], components: [row] });
    }
    
    else if (interaction.commandName === 'status') {
      let text = '📊 **Bot Status**\n\n**Wallets:**\n';
      for (let addr of ADDRESSES) {
        const bal = await getBalance(addr.address);
        const confirmed = await getConfirmedBalance(addr.address);
        text += `\`[${addr.index}]\` ${addr.type}\n${addr.address}\n💰 ${confirmed.toFixed(8)} LTC (${(bal-confirmed).toFixed(8)} pending)\n${addr.inUse ? '🔴 In Use' : '🟢 Available'}\n\n`;
      }
      
      text += `\n**Active Tickets:** ${tickets.size}\n**Settings:**\nCategory: ${settings.ticketCategory || 'Not Set'}\nStaff Role: ${settings.staffRole || 'Not Set'}\nSales Channel: ${settings.saleChannel || 'Not Set'}`;
      
      await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
    }
    
    else if (interaction.commandName === 'balance') {
      if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
      
      const bal = await getBalance(ADDRESSES[0].address);
      const confirmed = await getConfirmedBalance(ADDRESSES[0].address);
      
      await interaction.reply({ 
        content: `💰 **Wallet 0**\nAddress: ${ADDRESSES[0].address}\nConfirmed: ${confirmed.toFixed(8)} LTC\nPending: ${(bal - confirmed).toFixed(8)} LTC\nTotal: ${bal.toFixed(8)} LTC`, 
        flags: MessageFlags.Ephemeral 
      });
    }
    
    else if (interaction.commandName === 'send') {
      if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      
      const to = interaction.options.getString('address');
      const result = await sendLTC(0, to);
      
      if (result.success) {
        await interaction.editReply({ 
          content: `✅ **Sent successfully!**\nAmount: ${result.amount ? (result.amount/100000000).toFixed(8) : 'All'} LTC\nTXID: \`${result.txid}\`\n[View Transaction](https://litecoinspace.org/tx/${result.txid})` 
        });
      } else {
        await interaction.editReply({ content: `❌ **Failed**: ${result.error}` });
      }
    }
    
    else if (interaction.commandName === 'close') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket) return interaction.reply({ content: '❌ Not a ticket channel', flags: MessageFlags.Ephemeral });
      
      if (ticket.userId !== interaction.user.id && !isOwner) {
        return interaction.reply({ content: '❌ Only ticket owner or bot owner can close', flags: MessageFlags.Ephemeral });
      }
      
      await interaction.reply({ content: '🔒 Closing ticket...', flags: MessageFlags.Ephemeral });
      
      releaseAddress(interaction.channel.id);
      tickets.delete(interaction.channel.id);
      
      setTimeout(() => interaction.channel.delete().catch(() => {}), 2000);
    }
    
    else if (interaction.commandName === 'check') {
      const ticket = tickets.get(interaction.channel.id);
      if (!ticket) return interaction.reply({ content: '❌ No active ticket in this channel', flags: MessageFlags.Ephemeral });
      
      const bal = await getBalance(ticket.address);
      const confirmed = await getConfirmedBalance(ticket.address);
      
      const embed = new EmbedBuilder()
        .setTitle('💳 Payment Status')
        .addFields(
          { name: 'Required', value: `${ticket.amountLtc} LTC (±50%)`, inline: true },
          { name: 'Confirmed', value: `${confirmed.toFixed(8)} LTC`, inline: true },
          { name: 'Pending', value: `${(bal - confirmed).toFixed(8)} LTC`, inline: true },
          { name: 'Status', value: ticket.paid ? '✅ Paid' : ticket.pendingNotified ? '⏳ Confirming...' : '⏳ Waiting...', inline: true }
        )
        .setColor(ticket.paid ? 0x00FF00 : 0xFFD700);
      
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
    
    else if (['ticketcategory', 'staffroleid', 'transcriptchannel', 'salechannel'].includes(interaction.commandName)) {
      if (!isOwner) return interaction.reply({ content: '❌ Owner only', flags: MessageFlags.Ephemeral });
      
      const key = interaction.commandName === 'ticketcategory' ? 'ticketCategory' : 
                  interaction.commandName === 'staffroleid' ? 'staffRole' :
                  interaction.commandName === 'transcriptchannel' ? 'transcriptChannel' : 'saleChannel';
      
      settings[key] = interaction.options.getString('id');
      await interaction.reply({ content: `✅ **${interaction.commandName}** set to: ${settings[key]}`, flags: MessageFlags.Ephemeral });
    }
  }
  
  // Handle buttons
  if (interaction.isButton() && interaction.customId === 'open_ticket') {
    if (!settings.ticketCategory) {
      return interaction.reply({ content: '❌ Bot not fully setup yet', flags: MessageFlags.Ephemeral });
    }
    
    // Check if user already has an active ticket
    for (let [chId, t] of tickets) {
      if (t.userId === interaction.user.id && !t.paid) {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You already have an active ticket: ${ch}`, flags: MessageFlags.Ephemeral });
      }
    }
    
    // Check if address is available (only index 0)
    const addr = ADDRESSES[0];
    if (addr.inUse) {
      return interaction.reply({ content: '❌ All agents are currently busy. Please try again in a few minutes.', flags: MessageFlags.Ephemeral });
    }
    
    // Mark as in use
    addr.inUse = true;
    
    try {
      const channel = await interaction.guild.channels.create({
        name: `nitro-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: settings.ticketCategory,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
          ...(settings.staffRole ? [{ id: settings.staffRole, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] : [])
        ]
      });
      
      addr.ticketChannel = channel.id;
      
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('select_product')
          .setPlaceholder('Select your product...')
          .addOptions(
            { label: 'Nitro Basic Monthly - $1.00', value: 'basic_month', emoji: '💎', description: '1 Month of Nitro Basic' },
            { label: 'Nitro Basic Yearly - $7.00', value: 'basic_year', emoji: '💎', description: '12 Months of Nitro Basic' },
            { label: 'Nitro Boost Monthly - $2.80', value: 'boost_month', emoji: '🔥', description: '1 Month of Nitro Boost' },
            { label: 'Nitro Boost Yearly - $14.00', value: 'boost_year', emoji: '🔥', description: '12 Months of Nitro Boost' }
          )
      );
      
      const embed = new EmbedBuilder()
        .setTitle('🛒 Select Product')
        .setDescription(`Welcome <@${interaction.user.id}>!\n\nPlease select your product from the menu below.\n\n**Payment Address:**\n\`${addr.address}\`\n\n*This address is unique to your order.*`)
        .setColor(0x5865F2)
        .setFooter({ text: 'Prices shown in USD, paid in LTC' });
      
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
      
      await interaction.reply({ content: `✅ Ticket created: ${channel}`, flags: MessageFlags.Ephemeral });
      
    } catch (e) {
      addr.inUse = false;
      addr.ticketChannel = null;
      console.error(`[TICKET ERROR] ${e.message}`);
      await interaction.reply({ content: '❌ Failed to create ticket. Please try again.', flags: MessageFlags.Ephemeral });
    }
  }
  
  // Handle select menu
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_product') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket || ticket.userId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Not your ticket', flags: MessageFlags.Ephemeral });
    }
    
    const prices = { 
      basic_month: 1, 
      basic_year: 7, 
      boost_month: 2.8, 
      boost_year: 14 
    };
    
    const productNames = {
      basic_month: 'Nitro Basic Monthly',
      basic_year: 'Nitro Basic Yearly',
      boost_month: 'Nitro Boost Monthly',
      boost_year: 'Nitro Boost Yearly'
    };
    
    ticket.product = interaction.values[0];
    ticket.price = prices[ticket.product];
    
    const modal = new ModalBuilder()
      .setCustomId('qty_modal')
      .setTitle('Quantity')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('qty')
            .setLabel('How many do you want?')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1')
            .setValue('1')
            .setRequired(true)
            .setMaxLength(3)
        )
      );
    
    await interaction.showModal(modal);
  }
  
  // Handle modal
  if (interaction.isModalSubmit() && interaction.customId === 'qty_modal') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const qtyInput = interaction.fields.getTextInputValue('qty');
    const qty = parseInt(qtyInput);
    
    if (isNaN(qty) || qty < 1 || qty > 100) {
      return interaction.reply({ content: '❌ Invalid quantity (1-100)', flags: MessageFlags.Ephemeral });
    }
    
    const totalUsd = ticket.price * qty;
    // LTC price ~$75 (you should fetch real price)
    const ltcPrice = 75;
    const totalLtc = (totalUsd / ltcPrice);
    const tolerance = totalLtc * 0.5; // 50% tolerance
    
    ticket.quantity = qty;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = totalLtc - tolerance;
    ticket.maxLtc = totalLtc + tolerance;
    ticket.status = 'awaiting_payment';
    
    const productNames = {
      basic_month: 'Nitro Basic Monthly',
      basic_year: 'Nitro Basic Yearly',
      boost_month: 'Nitro Boost Monthly',
      boost_year: 'Nitro Boost Yearly'
    };
    
    const embed = new EmbedBuilder()
      .setTitle('💳 Payment Required')
      .setDescription(`**Order Summary:**\nProduct: ${productNames[ticket.product]}\nQuantity: ${qty}\nTotal: $${totalUsd.toFixed(2)} USD\n\n**Send exactly:**\n\`${totalLtc.toFixed(8)} LTC\`\n\n**To Address:**\n\`${ticket.address}\`\n\n⚠️ **Important:**\n• Send within ±50% of the amount\n• Wait for 1 confirmation\n• Minimum accepted: ${ticket.minLtc.toFixed(8)} LTC\n• Maximum accepted: ${ticket.maxLtc.toFixed(8)} LTC`)
      .setColor(0xFFD700)
      .setFooter({ text: 'Payment will be detected automatically' });
    
    await interaction.reply({ embeds: [embed] });
    
    // Send QR code link
    await interaction.channel.send(`**QR Code:** https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=litecoin:${ticket.address}?amount=${totalLtc.toFixed(8)}`);
  }
});

client.login(process.env.DISCORD_TOKEN);
