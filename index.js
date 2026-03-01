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
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(child.publicKey), network: LITECOIN });
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  return { address, privateKey: keyPair.toWIF(), index };
}

async function getAddressState(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?transaction_details=true&key=${BLOCKCHAIR_KEY}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    
    if (!data?.data?.[address]) return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
    
    const addr = data.data[address].address;
    const confirmed = addr.balance / 100000000;
    const received = addr.received / 100000000;
    const spent = addr.spent / 100000000;
    const unconfirmed = Math.max(0, received - spent - confirmed);
    
    const utxos = (data.data[address].utxo || []).map(u => ({
      txid: u.transaction_hash,
      vout: u.index,
      value: u.value,
      script: u.script_hex
    }));
    
    return { confirmed, unconfirmed, total: confirmed + unconfirmed, txs: data.data[address].transactions || [], utxos };
  } catch (error) {
    console.error(`[API ERROR] ${error.message}`);
    return { confirmed: 0, unconfirmed: 0, total: 0, txs: [], utxos: [] };
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const wallet = getLitecoinAddress(fromIndex);
    const state = await getAddressState(wallet.address);
    
    if (state.confirmed <= 0) return { success: false, error: 'No confirmed balance' };
    if (state.utxos.length === 0) return { success: false, error: 'No UTXOs found' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of state.utxos) {
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.txid}?key=${BLOCKCHAIR_KEY}`;
        const { data } = await axios.get(txUrl);
        if (data?.data?.[utxo.txid]?.raw_transaction) {
          psbt.addInput({
            hash: utxo.txid,
            index: utxo.vout,
            nonWitnessUtxo: Buffer.from(data.data[utxo.txid].raw_transaction, 'hex')
          });
          totalInput += parseInt(utxo.value);
        }
      } catch (e) { continue; }
    }
    
    if (totalInput === 0) return { success: false, error: 'No spendable inputs' };
    
    const fee = 100000;
    const amount = totalInput - fee;
    if (amount <= 0) return { success: false, error: 'Amount too small for fee' };
    
    psbt.addOutput({ address: toAddress, value: amount });
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) {}
    }
    
    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();
    
    const broadcast = await axios.post('https://api.blockchair.com/litecoin/push/transaction', { data: txHex }, {
      headers: { 'Content-Type': 'application/json' },
      params: { key: BLOCKCHAIR_KEY },
      timeout: 15000
    });
    
    if (broadcast.data?.data?.transaction_hash) {
      return { success: true, txid: broadcast.data.data.transaction_hash, amount: amount / 100000000, fee: fee / 100000000 };
    } else {
      return { success: false, error: 'Broadcast failed', details: broadcast.data };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

client.once('ready', async () => {
  console.log(`[READY] Bot logged in as ${client.user.tag}`);
  console.log('[SETTINGS] Current:', JSON.stringify(settings));
  
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
    new SlashCommandBuilder().setName('oauth2').setDescription('Get bot invite (Owner)')
  ];
  
  await client.application.commands.set(commands);
  
  setInterval(monitorMempool, 3000);
  console.log('[SYSTEM] Payment monitoring started (3s intervals)');
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
    console.log(`[DEBUG] /panel used. Category: ${settings.ticketCategory}`);
    
    if (!settings.ticketCategory) {
      return interaction.reply({ 
        content: `❌ **Not setup!** Use these commands first:\n\n` +
                `1. \`/ticketcategory\` (ID: ${settings.ticketCategory || 'NOT SET'})\n` +
                `2. \`/staffroleid\` (ID: ${settings.staffRole || 'NOT SET'})\n` +
                `3. \`/transcriptchannel\` (ID: ${settings.transcriptChannel || 'NOT SET'})\n` +
                `4. \`/salechannel\` (ID: ${settings.saleChannel || 'NOT SET'})\n\n` +
                `Use \`/settings\` to check current values.`, 
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
  else if (interaction.commandName === 'settings') {
    await interaction.reply({
      content: `**Current Settings:**\n` +
               `Ticket Category: ${settings.ticketCategory || '❌ Not set'}\n` +
               `Staff Role: ${settings.staffRole || '❌ Not set'}\n` +
               `Transcript Channel: ${settings.transcriptChannel || '❌ Not set'}\n` +
               `Sale Channel: ${settings.saleChannel || '❌ Not set'}`,
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'ticketcategory') { 
    const id = interaction.options.getString('id');
    settings.ticketCategory = id;
    console.log(`[SETTINGS] Category set to: ${id}`);
    await interaction.reply({ content: `✅ Category set to: ${id}\n\nNow use \`/panel\` to spawn the shop.`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'staffroleid') { 
    const id = interaction.options.getString('id');
    settings.staffRole = id;
    console.log(`[SETTINGS] Staff role set to: ${id}`);
    await interaction.reply({ content: `✅ Staff role set to: ${id}`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'transcriptchannel') { 
    const id = interaction.options.getString('id');
    settings.transcriptChannel = id;
    console.log(`[SETTINGS] Transcript set to: ${id}`);
    await interaction.reply({ content: `✅ Transcript channel set to: ${id}`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'salechannel') { 
    const id = interaction.options.getString('id');
    settings.saleChannel = id;
    console.log(`[SETTINGS] Sale channel set to: ${id}`);
    await interaction.reply({ content: `✅ Sales channel set to: ${id}`, flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    
    try { 
      bitcoin.address.toOutputScript(address, LITECOIN); 
    } catch (e) { 
      return interaction.editReplyReply({ content: '❌ Invalid LTC address!' }); 
    }
    
    await interaction.editReply({ content: '🔄 Scanning wallets 0-9...' });
    
    const results = [];
    for (let i = 0; i < 10; i++) {
      const wallet = getLitecoinAddress(i);
      const state = await getAddressState(wallet.address);
      if (state.total > 0.001) {
        const result = await sendAllLTC(i, address);
        results.push({ index: i, ...result, balance: state.total });
      }
    }
    
    let text = `**Sweep Complete!**\nFound ${results.length} wallets with balance\n\n`;
    for (const r of results) {
      if (r.success) {
        text += `✅ Index ${r.index}: ${r.balance?.toFixed(8)} LTC sent\nTx: ${r.txid?.slice(0,20)}...\n`;
      } else {
        text += `❌ Index ${r.index}: ${r.error}\n`;
      }
    }
    
    if (results.length === 0) text += 'No wallets with balance found.';
    await interaction.editReply({ content: text });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 9) return interaction.reply({ content: '❌ Index 0-9 only', flags: MessageFlags.Ephemeral });
    
    const wallet = getLitecoinAddress(idx);
    const state = await getAddressState(wallet.address);
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`Address: \`${wallet.address}\`\nConfirmed: ${state.confirmed.toFixed(8)} LTC\nUnconfirmed: ${state.unconfirmed.toFixed(8)} LTC\n**Total: ${state.total.toFixed(8)} LTC**`)
        .setColor(state.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
  }
  else if (interaction.commandName === 'check') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket in this channel', flags: MessageFlags.Ephemeral });
    if (!ticket.address) return interaction.reply({ content: '❌ No payment address set', flags: MessageFlags.Ephemeral });
    
    await interaction.deferReply();
    const state = await getAddressState(ticket.address);
    
    let text = `**Payment Check**\n`;
    text += `Address: \`${ticket.address}\`\n`;
    text += `Expected: ${ticket.amountLtc} LTC (±${(TOLERANCE_PERCENT * 100).toFixed(0)}%)\n`;
    text += `Range: ${ticket.minLtc?.toFixed(8)} - ${ticket.maxLtc?.toFixed(8)} LTC\n`;
    text += `Confirmed: ${state.confirmed.toFixed(8)} LTC\n`;
    text += `Unconfirmed: ${state.unconfirmed.toFixed(8)} LTC\n`;
    text += `**Total: ${state.total.toFixed(8)} LTC**\n\n`;
    
    if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
      text += `✅ **PAYMENT DETECTED!** Triggering delivery...`;
      await interaction.editReply({ content: text });
      await processPayment(interaction.channel.id, state.total);
    } else if (state.total > 0) {
      text += `⚠️ Payment received but outside tolerance range\nTry using /forcepay to deliver anyway`;
      await interaction.editReply({ content: text });
    } else {
      text += `❌ No payment detected yet`;
      await interaction.editReply({ content: text });
    }
  }
  else if (interaction.commandName === 'forcepay') {
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ No active ticket', flags: MessageFlags.Ephemeral });
    
    await interaction.reply({ content: '🔄 Forcing payment processing...', flags: MessageFlags.Ephemeral });
    const state = await getAddressState(ticket.address);
    await processPayment(interaction.channel.id, state.total > 0 ? state.total : (ticket.amountLtc || 0.01));
  }
  else if (interaction.commandName === 'close') {
    const ticket = tickets.get(interaction.channel.id);
    if (ticket && settings.transcriptChannel) {
      const ch = await interaction.guild.channels.fetch(settings.transcriptChannel).catch(() => null);
      if (ch) ch.send({ 
        embeds: [new EmbedBuilder()
          .setTitle('Ticket Closed')
          .addFields(
            { name: 'User', value: `<@${ticket.userId}>`, inline: true },
            { name: 'Product', value: ticket.productName || 'N/A', inline: true }
          )
          .setTimestamp()
        ] 
      });
    }
    
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
    console.log(`[DEBUG] open_ticket clicked. Category: ${settings.ticketCategory}`);
    
    if (!settings.ticketCategory) {
      return interaction.reply({ 
        content: `❌ **Not setup!** Category not set.\n\nUse \`/ticketcategory\` with a category ID first.\nCurrent value: ${settings.ticketCategory || 'NULL'}\n\nUse \`/settings\` to see all settings.`, 
        flags: MessageFlags.Ephemeral 
      });
    }
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered' && t.status !== 'closed') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
        else tickets.delete(chId);
      }
    }
    
    const wallet = getLitecoinAddress(addressIndex);
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
      address: wallet.address,
      privateKey: wallet.privateKey
    });
    
    console.log(`[TICKET] ${channel.id} using index ${addressIndex}, address: ${wallet.address}`);
    addressIndex++;
    await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
    const productKey = interaction.values[0];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    // Handle Members product
    if (productKey === 'members') {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('members_type_select')
          .setPlaceholder('Choose Members Type')
          .addOptions(
            { label: 'Offline Members - $0.70 per 1000', value: 'members_offline', emoji: '⚫', description: 'Offline server members' },
            { label: 'Online Members - $1.50 per 1000', value: 'members_online', emoji: '🟢', description: 'Online server members' }
          )
      );
      
      await interaction.update({ 
        embeds: [new EmbedBuilder().setTitle('👥 Choose Members Type').setDescription('Select the type of members you want:').setColor(0x00FF00)], 
        components: [row] 
      });
      return;
    }
    
    // Handle regular products
    const product = PRODUCTS[productKey];
    ticket.product = productKey;
    ticket.productName = product.name;
    ticket.price = product.price;
    ticket.productType = 'standard';
    
    const modal = new ModalBuilder()
      .setCustomId('qty')
      .setTitle('Quantity')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quantity')
            .setLabel('How many?')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1')
            .setRequired(true)
        )
      );
    
    await interaction.showModal(modal);
  }
  
  // Handle Members type selection
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
      .setTitle('Enter Amount of Members')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('member_amount')
            .setLabel(`How many members? (in multiples of ${product.unit})`)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('1000')
            .setRequired(true)
        )
      );
    
    await interaction.showModal(modal);
  }
  
  // Handle standard product quantity
  if (interaction.isModalSubmit() && interaction.customId === 'qty') {
    const qty = parseInt(interaction.fields.getTextInputValue('quantity'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    const available = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s));
    if (available.length < qty) {
      return interaction.reply({ content: `❌ Only ${available.length} left`, flags: MessageFlags.Ephemeral });
    }
    
    const totalUsd = ticket.price * qty;
    const totalLtc = (totalUsd / ltcPrice).toFixed(8);
    
    const toleranceLtc = parseFloat(totalLtc) * TOLERANCE_PERCENT;
    
    ticket.quantity = qty;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc;
    ticket.status = 'awaiting_payment';
    ticket.paid = false;
    ticket.delivered = false;
    
    console.log(`[AWAITING] ${ticket.address} | Expected: ${totalLtc} LTC | Range: ${ticket.minLtc.toFixed(8)}-${ticket.maxLtc.toFixed(8)} LTC (±${(TOLERANCE_PERCENT * 100).toFixed(0)}%)`);
    
    await interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment')
        .setDescription(`**${ticket.productName}** x${qty}\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` },
          { name: '⚡ Detection', value: 'INSTANT (0-confirmation)' }
        )
        .setColor(0xFFD700)
        .setFooter({ text: 'Send LTC now. Bot detects instantly and auto-sends!' })
      ] 
    });
  }
  
  // Handle Members quantity
  if (interaction.isModalSubmit() && interaction.customId === 'members_qty') {
    const memberAmount = parseInt(interaction.fields.getTextInputValue('member_amount'));
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    if (isNaN(memberAmount) || memberAmount < 1000) {
      return interaction.reply({ content: '❌ Minimum order is 1000 members', flags: MessageFlags.Ephemeral });
    }
    
    // Calculate price: (amount / 1000) * price_per_1000
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
    ticket.paid = false;
    ticket.delivered = false;
    
    console.log(`[AWAITING-MEMBERS] ${ticket.address} | ${memberAmount} members | $${totalUsd.toFixed(2)} | ${totalLtc} LTC`);
    
    await interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment - Members Order')
        .setDescription(`**${ticket.productName}**\n**Amount:** ${memberAmount.toLocaleString()} members\n**Rate:** $${ticket.price} per ${ticket.unit}\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±50% OK)', value: `\`${totalLtc} LTC\`` },
          { name: '⚡ Detection', value: 'INSTANT (0-confirmation)' }
        )
        .setColor(0xFFD700)
        .setFooter({ text: 'Send LTC now. Bot detects instantly and auto-sends!' })
      ] 
    });
  }
});

async function monitorMempool() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => t.status === 'awaiting_payment' && t.address);
  
  if (awaiting.length > 0) {
    console.log(`[MONITOR] Checking ${awaiting.length} awaiting tickets`);
  }
  
  for (const [channelId, ticket] of awaiting) {
    try {
      console.log(`[MONITOR] Checking ticket ${channelId}, address: ${ticket.address}, range: ${ticket.minLtc?.toFixed(8)}-${ticket.maxLtc?.toFixed(8)}`);
      
      const state = await getAddressState(ticket.address);
      
      console.log(`[MONITOR] ${ticket.address}: total=${state.total.toFixed(8)}, need=${ticket.minLtc?.toFixed(8)}-${ticket.maxLtc?.toFixed(8)}`);
      
      if (state.total >= ticket.minLtc && state.total <= ticket.maxLtc) {
        console.log(`[MONITOR] ✅ PAYMENT DETECTED for ${channelId}`);
        await processPayment(channelId, state.total);
      }
    } catch (error) {
      console.error(`[MONITOR] Error:`, error.message);
    }
  }
}

async function processPayment(channelId, receivedLtc) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.status === 'delivered') {
    console.log(`[PAYMENT] Already delivered or no ticket for ${channelId}`);
    return;
  }
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    console.log(`[PAYMENT] Channel ${channelId} not found, removing ticket`);
    tickets.delete(channelId);
    return;
  }
  
  console.log(`[PAYMENT] Processing ${receivedLtc} LTC for ticket ${channelId}`);
  ticket.status = 'delivered';
  ticket.paid = true;
  
  console.log(`[AUTO-SEND] Sending from index ${ticket.walletIndex} to ${FEE_ADDRESS}`);
  const sendResult = await sendAllLTC(ticket.walletIndex, FEE_ADDRESS);
  
  if (sendResult.success) {
    console.log(`[AUTO-SEND] Success: ${sendResult.txid}`);
  } else {
    console.log(`[AUTO-SEND] Failed: ${sendResult.error}`);
  }
  
  await channel.send({
    embeds: [new EmbedBuilder()
      .setTitle('⏳ Wait For Owner Arrival')
      .setDescription(`Payment detected: ${receivedLtc.toFixed(8)} LTC\nAuto-send to owner: ${sendResult.success ? '✅' : '❌'}\n\nPlease wait while the owner processes your order.`)
      .setColor(0xFFA500)
    ]
  });
  
  const owner = await client.users.fetch(OWNER_ID).catch(() => null);
  if (owner) {
    owner.send({
      embeds: [new EmbedBuilder()
        .setTitle('🛒 New Order')
        .setDescription(`**Product:** ${ticket.productName}\n**Quantity:** ${ticket.quantity.toLocaleString()}${ticket.productType === 'calculated' ? ' members' : ''}\n**Amount:** $${ticket.amountUsd.toFixed(2)}\n**Received:** ${receivedLtc.toFixed(8)} LTC\n**Channel:** <#${channelId}>`)
        .setColor(0x00FF00)
        .setTimestamp()
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
  
  // Handle calculated products (Members) differently
  if (ticket.productType === 'calculated') {
    ticket.delivered = true;
    
    if (settings.saleChannel) {
      const ch = client.channels.cache.get(settings.saleChannel);
      if (ch) {
        ch.send({
          embeds: [new EmbedBuilder()
            .setTitle('💰 New Members Order')
            .setDescription(`**${ticket.productName}**\n**Amount:** ${ticket.quantity.toLocaleString()} members\n**Total:** $${ticket.amountUsd.toFixed(2)}`)
            .setColor(0x00FF00)
            .setTimestamp()
          ]
        }).catch(() => {});
      }
    }
    
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('🎁 Members Order Confirmed')
        .setDescription(`**${ticket.productName}**\n**Amount:** ${ticket.quantity.toLocaleString()} members\n**Paid:** ${receivedLtc.toFixed(8)} LTC\n\nThe owner has been notified and will deliver your members shortly.`)
        .setColor(0x00FF00)
      ]
    });
    
    await channel.send({
      embeds: [new EmbedBuilder()
        .setTitle('🙏 Please Vouch')
        .setDescription(`Copy & paste:\n\`vouch <@${OWNER_ID}> ${ticket.productName} ${ticket.quantity.toLocaleString()} members $${ticket.amountUsd.toFixed(2)}\``)
        .setColor(0x5865F2)
      ]
    });
    
    console.log(`[DELIVERED-MEMBERS] Channel ${channelId} - ${ticket.quantity.toLocaleString()} members`);
    return;
  }
  
  // Standard product delivery
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
  
  if (settings.saleChannel) {
    const ch = client.channels.cache.get(settings.saleChannel);
    if (ch) {
      ch.send({
        embeds: [new EmbedBuilder()
          .setTitle('💰 New Nitro Sale')
          .setDescription(`**${ticket.productName}** x${productList.length}\nAmount: $${ticket.amountUsd.toFixed(2)}`)
          .setColor(0x00FF00)
          .setTimestamp()
        ]
      }).catch(() => {});
    }
  }
  
  const embed = new EmbedBuilder()
    .setTitle('🎁 Your Nitro Links (Delivered Instantly)')
    .setDescription(`**${ticket.productName}** x${productList.length}\nPaid: ${receivedLtc.toFixed(8)} LTC`)
    .setColor(0x00FF00);
  
  productList.forEach((item, idx) => {
    embed.addFields({ name: `Link ${idx + 1}`, value: item, inline: false });
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
  
  console.log(`[DELIVERED] Channel ${channelId} - ${ticket.productName} x${productList.length}`);
}

client.login(process.env.DISCORD_TOKEN);
