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
const TOLERANCE_USD = 0.10;

const LITECOIN = { messagePrefix: '\x19Litecoin Signed Message:\n', bech32: 'ltc', bip32: { public: 0x019da462, private: 0x019d9cfe }, pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };

let ltcPrice = 75;
let settings = { ticketCategory: null, staffRole: null, transcriptChannel: null, saleChannel: null };
const tickets = new Map();
const usedStock = new Set();
const usedIndices = new Set();
let currentIndex = 0;

const PRODUCTS = {
  nitro_basic_month: { name: 'Nitro Basic Monthly', price: 1.0, stock: ['link1','link2','link3','link4','link5'] },
  nitro_basic_year: { name: 'Nitro Basic Yearly', price: 7.0, stock: ['link1','link2','link3'] },
  nitro_boost_month: { name: 'Nitro Boost Monthly', price: 2.8, stock: ['link1','link2','link3','link4'] },
  nitro_boost_year: { name: 'Nitro Boost Yearly', price: 14.0, stock: ['link1','link2'] }
};

function getLitecoinAddress(index) {
  if (index < 0 || index > 9) {
    console.error(`[ERROR] Invalid index ${index}, forcing to 0`);
    index = 0;
  }
  
  const seed = bip39.mnemonicToSeedSync(BOT_MNEMONIC);
  const root = bip32.fromSeed(seed, LITECOIN);
  const child = root.derivePath(`m/44'/2'/0'/0/${index}`);
  const { address } = bitcoin.payments.p2pkh({ pubkey: Buffer.from(child.publicKey), network: LITECOIN });
  const keyPair = ECPair.fromPrivateKey(Buffer.from(child.privateKey), { network: LITECOIN });
  
  console.log(`[WALLET] Index ${index}: ${address}`);
  return { address, privateKey: keyPair.toWIF(), index };
}

function getNextIndex() {
  for (let i = 0; i < 10; i++) {
    const idx = (currentIndex + i) % 10;
    if (!usedIndices.has(idx)) {
      usedIndices.add(idx);
      currentIndex = (idx + 1) % 10;
      console.log(`[INDEX] Assigned ${idx}, used: [${Array.from(usedIndices).join(',')}]`);
      return idx;
    }
  }
  
  console.log(`[INDEX] All used, resetting`);
  usedIndices.clear();
  usedIndices.add(0);
  currentIndex = 1;
  return 0;
}

function releaseIndex(index) {
  usedIndices.delete(index);
  console.log(`[INDEX] Released ${index}, used: [${Array.from(usedIndices).join(',')}]`);
}

async function getAddressBalance(address) {
  try {
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${address}?key=${BLOCKCHAIR_KEY}`;
    console.log(`[API] Checking: ${address}`);
    const { data } = await axios.get(url, { timeout: 15000 });
    
    if (!data?.data?.[address]) {
      console.log(`[API] No data for ${address}`);
      return { balance: 0, unconfirmed: 0, total: 0 };
    }
    
    const addr = data.data[address].address;
    const balance = addr.balance / 100000000;
    const received = addr.received / 100000000;
    const spent = addr.spent / 100000000;
    const unconfirmed = Math.max(0, received - spent - balance);
    
    console.log(`[BALANCE] ${address}: ${balance} + ${unconfirmed} = ${balance + unconfirmed} LTC`);
    return { balance, unconfirmed, total: balance + unconfirmed };
  } catch (e) {
    console.error(`[API ERROR] ${e.message}`);
    return { balance: 0, unconfirmed: 0, total: 0 };
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  try {
    const wallet = getLitecoinAddress(fromIndex);
    console.log(`[SEND] Index ${fromIndex} → ${toAddress}`);
    
    const url = `https://api.blockchair.com/litecoin/dashboards/address/${wallet.address}?key=${BLOCKCHAIR_KEY}`;
    const { data } = await axios.get(url, { timeout: 15000 });
    
    if (!data?.data?.[wallet.address]) return { success: false, error: 'No data' };
    
    const utxos = data.data[wallet.address].utxo || [];
    if (utxos.length === 0) return { success: false, error: 'No UTXOs' };
    
    const psbt = new bitcoin.Psbt({ network: LITECOIN });
    let totalInput = 0;
    
    for (const utxo of utxos) {
      try {
        const txUrl = `https://api.blockchair.com/litecoin/raw/transaction/${utxo.transaction_hash}?key=${BLOCKCHAIR_KEY}`;
        const txData = await axios.get(txUrl, { timeout: 10000 });
        if (txData.data?.data?.[utxo.transaction_hash]?.raw_transaction) {
          psbt.addInput({
            hash: utxo.transaction_hash,
            index: utxo.index,
            nonWitnessUtxo: Buffer.from(txData.data.data[utxo.transaction_hash].raw_transaction, 'hex')
          });
          totalInput += parseInt(uto.value);
        }
      } catch (e) { continue; }
    }
    
    if (totalInput === 0) return { success: false, error: 'No inputs' };
    
    const fee = 100000;
    const amount = totalInput - fee;
    if (amount <= 0) return { success: false, error: 'Too small' };
    
    psbt.addOutput({ address: toAddress, value: amount });
    const keyPair = ECPair.fromWIF(wallet.privateKey, LITECOIN);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try { psbt.signInput(i, keyPair); } catch (e) {}
    }
    
    psbt.finalizeAllInputs();
    
    const broadcast = await axios.post('https://api.blockchair.com/litecoin/push/transaction', {
      data: psbt.extractTransaction().toHex()
    }, { params: { key: BLOCKCHAIR_KEY }, timeout: 15000 });
    
    if (broadcast.data?.data?.transaction_hash) {
      releaseIndex(fromIndex);
      return { success: true, txid: broadcast.data.data.transaction_hash, amount: amount / 100000000 };
    }
    
    return { success: false, error: 'Broadcast failed' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

client.once('ready', async () => {
  console.log(`(`✅ Bot logged in as ${client.user.tag}`);
  
  const commands = [
    new SlashCommandBuilder().setName('panel').setDescription('Spawn shop panel (Owner)'),
    new SlashCommandBuilder().setName('ticketcategory').setDescription('Set ticket category (Owner)').addStringOption(o => o.setName('id').setDescription('Category ID').setRequired(true)),
    new SlashCommandBuilder().setName('staffroleid').setDescription('Set staff role (Owner)').addStringOption(o => o.setName('id').setDescription('Role ID').setRequired(true)),
    new SlashCommandBuilder().setName('transcriptchannel').setDescription('Set transcript channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('salechannel').setDescription('Set sales channel (Owner)').addStringOption(o => o.setName('id').setDescription('Channel ID').setRequired(true)),
    new SlashCommandBuilder().setName('send').setDescription('Send all LTC to address (Owner)').addStringOption(o => o.setName('address').setDescription('LTC address').setRequired(true)),
    new SlashCommandBuilder().setName('close').setDescription('Close ticket (Owner/Staff)'),
    new SlashCommandBuilder().setName('balance').setDescription('Check wallet balance (Owner)').addIntegerOption(o => o.setName('index').setDescription('Wallet index 0-9').setRequired(true)),
    new SlashCommandBuilder().setName('oauth2').setDescription('Get bot invite (Owner)')
  ];
  
  await client.application.commands.set(commands);
  setInterval(checkPayments, 3000);
  console.log('[SYSTEM] Started (3s checks)');
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
    const embed = new EmbedBuilder()
      .setTitle('🏪 Hello welcome to Nitro Shop')
      .setDescription('• Lifetime warranty\n• Refund if revoke\n• Refund if broken')
      .setColor(0x5865F2);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_ticket').setLabel('🛒 Purchase Nitro').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
  }
  else if (interaction.commandName === 'ticketcategory') { 
    settings.ticketCategory = interaction.options.getString('id'); 
    await interaction.reply({ content: '✅ Category set', flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'staffroleid') { 
    settings.staffRole = interaction.options.getString('id'); 
    await interaction.reply({ content: '✅ Staff role set', flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'transcriptchannel') { 
    settings.transcriptChannel = interaction.options.getString('id'); 
    await interaction.reply({ content: '✅ Transcript channel set', flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'salechannel') { 
    settings.saleChannel = interaction.options.getString('id'); 
    await interaction.reply({ content: '✅ Sales channel set', flags: MessageFlags.Ephemeral }); 
  }
  else if (interaction.commandName === 'send') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const address = interaction.options.getString('address');
    
    try { 
      bitcoin.address.toOutputScript(address, LITECOIN); 
    } catch (e) { 
      return interaction.editReply({ content: '❌ Invalid LTC address!' }); 
    }
    
    await interaction.editReply({ content: '🔄 Scanning wallets 0-9...' });
    
    const results = [];
    for (let i = 0; i < 10; i++) {
      const wallet = getLitecoinAddress(i);
      const bal = await getAddressBalance(wallet.address);
      if (bal.total > 0.001) {
        const result = await sendAllLTC(i, address);
        results.push({ index: i, ...result, balance: bal.total });
      }
    }
    
    let text = `**Sweep Complete!**\nFound ${results.length} wallets\n\n`;
    for (const r of results) {
      if (r.success) {
        text += `✅ Index ${r.index}: ${r.balance?.toFixed(8)} LTC sent\nTx: ${r.txid?.slice(0,20)}...\n`;
      } else {
        text += `❌ Index ${r.index}: ${r.error}\n`;
      }
    }
    
    if (results.length === 0) text += 'No balance found.';
    await interaction.editReply({ content: text });
  }
  else if (interaction.commandName === 'balance') {
    const idx = interaction.options.getInteger('index');
    if (idx < 0 || idx > 9) return interaction.reply({ content: '❌ Index 0-9 only', flags: MessageFlags.Ephemeral });
    
    const wallet = getLitecoinAddress(idx);
    const bal = await getAddressBalance(wallet.address);
    
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`💰 Wallet ${idx}`)
        .setDescription(`Address: \`${wallet.address}\`\nConfirmed: ${bal.balance.toFixed(8)} LTC\nUnconfirmed: ${bal.unconfirmed.toFixed(8)} LTC\n**Total: ${bal.total.toFixed(8)} LTC**`)
        .setColor(bal.total > 0 ? 0x00FF00 : 0xFF0000)
      ],
      flags: MessageFlags.Ephemeral
    });
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
    
    if (ticket?.walletIndex !== undefined) releaseIndex(ticket.walletIndex);
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
    if (!settings.ticketCategory) return interaction.reply({ content: '❌ Not setup', flags: MessageFlags.Ephemeral });
    
    for (const [chId, t] of tickets) {
      if (t.userId === interaction.user.id && t.status !== 'delivered') {
        const ch = interaction.guild.channels.cache.get(chId);
        if (ch) return interaction.reply({ content: `❌ You have a ticket: ${ch}`, flags: MessageFlags.Ephemeral });
        else tickets.delete(chId);
      }
    }
    
    const index = getNextIndex();
    const wallet = getLitecoinAddress(index);
    
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
          { label: 'Nitro Boost Yearly - $14.00', value: 'nitro_boost_year', emoji: '🔥' }
        )
    );
    
    await channel.send({ 
      content: `${interaction.user}`, 
      embeds: [new EmbedBuilder().setTitle('🛒 Select Nitro').setColor(0x00FF00)], 
      components: [row] 
    });
    
    tickets.set(channel.id, { 
      userId: interaction.user.id, 
      status: 'selecting', 
      channelId: channel.id,
      walletIndex: index,
      address: wallet.address,
      privateKey: wallet.privateKey
    });
    
    console.log(`[TICKET] ${channel.id} using index ${index}`);
    await interaction.reply({ content: `✅ ${channel}`, flags: MessageFlags.Ephemeral });
  }
  
  if (interaction.isStringSelectMenu() && interaction.customId === 'product_select') {
    const product = PRODUCTS[interaction.values[0]];
    const ticket = tickets.get(interaction.channel.id);
    if (!ticket) return;
    
    ticket.product = interaction.values[0];
    ticket.productName = product.name;
    ticket.price = product.price;
    
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
    const toleranceLtc = TOLERANCE_USD / ltcPrice;
    
    ticket.quantity = qty;
    ticket.amountUsd = totalUsd;
    ticket.amountLtc = totalLtc;
    ticket.minLtc = parseFloat(totalLtc) - toleranceLtc;
    ticket.maxLtc = parseFloat(totalLtc) + toleranceLtc + 0.001;
    ticket.status = 'awaiting_payment';
    
    console.log(`[AWAITING] ${ticket.address} | Need: ${ticket.minLtc.toFixed(8)}-${ticket.maxLtc.toFixed(8)} LTC`);
    
    await interaction.reply({ 
      embeds: [new EmbedBuilder()
        .setTitle('💳 Payment')
        .setDescription(`**${ticket.productName}** x${qty}\n**Total:** $${totalUsd.toFixed(2)} (~${totalLtc} LTC)`)
        .addFields(
          { name: '📋 LTC Address', value: `\`${ticket.address}\`` },
          { name: '💰 Amount (±$0.10 OK)', value: `\`${totalLtc} LTC\`` },
          { name: '⚡ Index', value: `${ticket.walletIndex}` }
        )
        .setColor(0xFFD700)
        .setFooter({ text: 'Send LTC - 0-conf detection active' })
      ] 
    });
    
    // Immediate check
    setTimeout(async () => {
      const bal = await getAddressBalance(ticket.address);
      console.log(`[INIT] ${ticket.address}: ${bal.total} LTC`);
      if (bal.total >= ticket.minLtc) {
        await processPayment(interaction.channel.id, bal.total);
      }
    }, 2000);
  }
});

async function processPayment(channelId, amount) {
  const ticket = tickets.get(channelId);
  if (!ticket || ticket.status === 'delivered') return;
  
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    tickets.delete(channelId);
    return;
  }
  
  console.log(`[PAYMENT] ${amount} LTC detected in ${channelId}`);
  ticket.status = 'delivered';
  
  const result = await sendAllLTC(ticket.walletIndex, FEE_ADDRESS);
  console.log(`[SEND] ${result.success ? 'OK' : 'FAIL'}: ${result.txid || result.error}`);
  
  await channel.send({ 
    embeds: [new EmbedBuilder()
      .setTitle('⏳ Wait For Owner Arrival')
      .setDescription(`Payment: ${amount.toFixed(8)} LTC\nAuto-send: ${result.success ? '✅' : '❌'}\n\nWait for owner delivery.`)
      .setColor(0xFFA500)
    ] 
  });
  
  const owner = await client.users.fetch(OWNER_ID).catch(() => null);
  if (owner) {
    owner.send({ 
      content: `🛒 New Order\n${ticket.productName} x${ticket.quantity}\n$${ticket.amountUsd.toFixed(2)} (${amount.toFixed(8)} LTC)\n<#${channelId}>` 
    });
  }
  
  const links = PRODUCTS[ticket.product].stock.filter(s => !usedStock.has(s)).slice(0, ticket.quantity);
  links.forEach(l => usedStock.add(l));
  
  await channel.send({ 
    embeds: [new EmbedBuilder()
      .setTitle('🎁 Your Nitro Links')
      .setDescription(links.map((l, i) => `${i + 1}. ${l}`).join('\n'))
      .setColor(0x00FF00)
    ] 
  });
  
  if (settings.saleChannel) {
    const ch = client.channels.cache.get(settings.saleChannel);
    if (ch) {
      ch.send({ 
        embeds: [new EmbedBuilder()
          .setTitle('💰 Sale')
          .setDescription(`${ticket.productName} x${ticket.quantity} - $${ticket.amountUsd.toFixed(2)}`)
          .setColor(0x00FF00)
        ] 
      });
    }
  }
}

async function checkPayments() {
  const awaiting = Array.from(tickets.entries()).filter(([_, t]) => t.status === 'awaiting_payment');
  if (awaiting.length === 0) return;
  
  console.log(`[CHECK] ${awaiting.length} tickets`);
  
  for (const [channelId, ticket] of awaiting) {
    const bal = await getAddressBalance(ticket.address);
    console.log(`[CHECK] ${ticket.address}: ${bal.total.toFixed(8)} LTC`);
    
    if (bal.total >= ticket.minLtc && bal.total <= ticket.maxLtc) {
      await processPayment(channelId, bal.total);
    }
  }
}

client.login(process.env.DISCORD_TOKEN);
